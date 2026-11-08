/* =========================================================================
 * tc/codegen.js —— IR → BrainFuck
 *
 * 内存布局（固定约定，方便在调试器里对照）：
 *   0  home    保留（早期版本让指针在语句间归位，现在改为「就近停下」，
 *              省掉一半的 >>>/<<<，这个格子只留给调试器当参照点）
 *   1  acc     表达式累加器
 *   2  s1      复制用暂存
 *   3  s2      复制用暂存
 *   4  lc      比较：左操作数
 *   5  rc      比较：右操作数
 *   6  t1      零值检测的副本
 *   7  t2      零值检测 / 逻辑运算标志
 *   8  neg     取反用的 1
 *   9+         十进制输出单元（有 %d 时预留 9 格）
 *   之后       输入单元 8 格 / 乘法每层 2 格 / 除法每层 7 格
 *   再之后     条件与分支的临时格（按块复用，同一时刻最多几格）+ 用户变量
 *
 * 关键技巧：
 *   · 读变量不破坏原值：src[->dst+>tmp+<<] 再 tmp[->src+<] 还原
 *   · if：把条件算进 c 格，c[ 主体 · c 清 0 ]  —— 只执行一次
 *   · if/else：再用 e 格当标志，then 执行后把 e 清零，e[ else 主体 ]
 *   · while 用通用条件时：进循环前算一次，「] 之前」再算一次，实现“先判断后执行”
 *   · a < b：两个副本一起递减，谁先见底谁小；a == b 由收尾的零值检测兜住
 *   · a * b：把 b 逐轮加进目标格（每轮 O(b)），不做「先乘进中转再搬家」
 *   · a / b：把 a 逐个搬进余数、计步器从 b 倒数，归零即进位（O(a) 步）
 *   · 十进制输出：用 10 进制“计步器”反复减 10 求商与余数，再逐位打印
 *   · 注释以 ; 开头，且把 BF 指令字符替换成全角，避免干扰执行
 * ========================================================================= */
(function (TC) {
  'use strict';

  var HOME = 0, ACC = 1, S1 = 2, S2 = 3;
  var LC = 4, RC = 5, T1 = 6, T2 = 7, NEG = 8;
  var DYN_BASE = 9;

  var LOOKALIKE = { '+': '＋', '-': '－', '<': '＜', '>': '＞', '[': '［', ']': '］', '.': '·', ',': '，' };

  /* 注释里不能出现 BF 指令字符（含英文逗号，那是输入指令），一律替换成全角 */
  function safe(s) {
    return String(s == null ? '' : s).replace(/[+\-<>[\],.]/g, function (c) { return LOOKALIKE[c]; });
  }

  /* 定长指令串缓存：moveTo / addConst / clear 每次都要拼一串同样的字符，
     几十万条指令时 new Array(n).join() 会反复分配。这里按长度缓存，
     常用长度（1..256）只建一次。 */
  var RUNS = Object.create(null);
  function repeat(ch, n) {
    if (!(n > 0)) return '';
    var arr = RUNS[ch];
    if (!arr) arr = RUNS[ch] = [];
    var s = arr[n];
    if (s !== undefined) return s;
    /* 直接生成扁平字符串：递归版 repeat(n-1)+ch 会留下一条长度 n 的
       cons-string 链，缓存里几百条这样的链既占内存又拖慢 flatten。 */
    if (n > 1024) return new Array(n + 1).join(ch);
    s = new Array(n + 1).join(ch);
    arr[n] = s;
    return s;
  }

  /* 源码字符串按 UTF-8 字节输出：一个中文字符是 3 个字节，
     直接 charCodeAt & 255 会把高位砍掉，调试器里就是一串乱码。 */
  function utf8Bytes(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) { out.push(c); continue; }
      if (c < 0x800) {
        out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
        continue;
      }
      /* 代理对 → 4 字节（emoji / 部分符号） */
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
        var c2 = s.charCodeAt(i + 1);
        if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
          var cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
          out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63),
                   0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
          i++;
          continue;
        }
      }
      out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  /* 把条件表达式转成可读文本，用于生成注释 */
  function condText(e) {
    if (!e) return '?';
    switch (e.k) {
      case 'num': return String(e.v);
      case 'var': return e.name;
      case 'bin': return condText(e.a) + ' ' + e.op + ' ' + condText(e.b);
      case 'mul': return condText(e.a) + ' * ' + condText(e.b);
      case 'div': return condText(e.a) + ' / ' + condText(e.b);
      case 'mod': return condText(e.a) + ' % ' + condText(e.b);
      case 'cmp': return condText(e.a) + ' ' + e.op + ' ' + condText(e.b);
      case 'and': return condText(e.a) + ' && ' + condText(e.b);
      case 'or': return condText(e.a) + ' || ' + condText(e.b);
      case 'not': return '!' + condText(e.a);
      default: return '?';
    }
  }

  /* 兼容 NASM 解析器：它的 cond 直接给的是寄存器名字符串 */
  function normCond(c) {
    if (!c) return { k: 'num', v: 0 };
    if (typeof c === 'string') return { k: 'var', name: c };
    return c;
  }

  function normalize(nodes) {
    nodes.forEach(function (n) {
      if (!n) return;
      if (n.type === 'while') {
        n.cond = normCond(n.cond);
        normalize(n.body);
      } else if (n.type === 'if') {
        n.cond = normCond(n.cond);
        normalize(n.then);
        if (n.else) normalize(n.else);
      }
    });
  }

  function Gen() {
    /* 输出缓冲：片段先攒成 CHUNK 大小的大块再进 parts，每个元素自带换行。
       于是 code = parts.join('') 只分配一次；导出大程序时更可以直接
       new Blob(parts) 分块下载，连「一整条几 GB 的字符串」都不必拼出来。
       不再有指令数硬上限：展开成多少条就生成多少条，绝不中途截断。 */
    this.parts = [];
    this.buf = '';           /* 尚未凑满 CHUNK 的片段 */
    this.stat = 0;           /* 完整指令数，不受预览截断影响 */
    this.lineCount = 0;
    this.outChars = 0;       /* 已收集的字符数 */
    this.limit = Infinity;   /* 预览模式下为 PREVIEW_LIMIT */
    this.truncated = false;
    this.deadline = 0;       /* 预览专用时间预算，0 = 不限 */
    this.ticks = 0;
    this.partial = false;    /* 预览因时间预算提前停止：指令数是下界 */
    this.withComments = true;
    this.cur = '';
    this.cmt = '';
    this.hasCode = false;
    this.pos = 0;
    this.next = DYN_BASE;
    this.vars = {};
    this.varOrder = [];
    this.ifCells = new Map();
    this.aux = new Map();      /* 条件子表达式 -> 结果单元格 */
    this.ctrl = new Map();     /* 通用条件的 while -> 控制单元格 */
    this.printBlk = null;
    this.inBlk = null;
    this.mulBlk = null;
    this.mulDepth = 0;
    this.divBlk = null;        /* 除法 / 取模的工作单元，按嵌套深度分配 */
    this.divDepth = 0;
    this.pool = new Pool(this);
  }

  /* ---------------- 基础发射 ----------------
     所有代码都经 push()：预览一旦截断，后面的语句只累加指令长度，
     不再拼那上千万字符的字符串（内存流量的大头就在这里）。
     单条语句可能长达几百万字符（定点数乘除 / 长除法），cur 攒到 CHUNK
     就先切成段吐出去，避免深层 cons string 在 slice 时爆栈。 */
  Gen.prototype.push = function (s) {
    if (!s) return;
    this.stat += s.length;
    this.hasCode = true;
    if (this.truncated) {
      /* 预览已凑够显示用的开头，后面的语句只统计长度。给预览一个宽松的
         时间预算：为了「精确的指令总数」把几十亿条指令逐条发射一遍，
         会让每次按键都卡住。完整生成（导出 / 送调试器）不设这个预算。 */
      if (this.deadline && (++this.ticks & 0x3ffff) === 0 &&
          Date.now() > this.deadline) {
        this.partial = true;
        throw PREVIEW_STOP;
      }
      return;
    }
    this.cur += s;
    if (this.cur.length >= CHUNK + WRAP) this.spill();
  };

  /* 把 cur 前面整段按 WRAP 切出去，末尾留不到 2*WRAP 个字符 ——
     语句注释由 end() 挂在最后一段上，所以尾部必须留着。 */
  Gen.prototype.spill = function () {
    var n = this.cur.length;
    var cut = Math.floor((n - WRAP) / WRAP) * WRAP;
    if (cut <= 0) return;
    var head = this.cur.slice(0, cut);
    this.cur = this.cur.slice(cut);
    for (var i = 0; i < head.length; i += WRAP) {
      this.pushPart(head.slice(i, i + WRAP));
      if (this.truncated) return;
    }
  };

  /* 所有输出片段的唯一入口：攒够 CHUNK 就合成一个大块。
     parts 的元素自带 '\n'，所以 parts.join('') 与 new Blob(parts) 内容一致，
     导出时可以直接把 parts 交给 Blob，不必再拼一整条巨型字符串。 */
  Gen.prototype.pushPart = function (part) {
    if (this.truncated) return;
    this.outChars += part.length + 1;
    this.buf += part + '\n';
    if (this.buf.length >= CHUNK) this.flush();
    if (this.outChars >= this.limit) {
      this.flush();
      this.parts.push('; …… 预览已截断：完整 BrainFuck 请用「复制 / 下载 .bf / 在调试器中打开」\n');
      this.truncated = true;
    }
  };

  Gen.prototype.flush = function () {
    if (!this.buf) return;
    this.parts.push(this.buf);
    this.buf = '';
  };

  Gen.prototype.emitCode = function (s) { this.push(s); };

  Gen.prototype.moveTo = function (cell) {
    var d = cell - this.pos;
    if (d > 0) this.push(repeat('>', d));
    else if (d < 0) this.push(repeat('<', -d));
    this.pos = cell;
  };

  Gen.prototype.clear = function (cell) {
    this.moveTo(cell);
    this.push('[-]');
  };

  Gen.prototype.addConst = function (cell, v) {
    v = v | 0;
    if (!v || v % 256 === 0) return;
    /* 走短的那一侧：+200 换成 -56，生成代码直接少 144 个字符 */
    var b = ((v % 256) + 256) % 256;
    if (b > 128) v = b - 256;
    this.moveTo(cell);
    this.push(v > 0 ? repeat('+', v) : repeat('-', -v));
  };

  Gen.prototype.begin = function (comment) {
    this.cur = ''; this.cmt = comment || ''; this.hasCode = false;
  };

  Gen.prototype.end = function () {
    var code = this.cur;
    this.cur = '';
    if (!this.hasCode) return;

    /* stat 已在 push() 里逐段累加、lineCount 按「发射过代码」计数，
       所以预览截断不影响这两个统计值。 */
    this.lineCount++;
    if (!code || this.truncated) return;

    var cmt = (this.withComments && this.cmt) ? '  ;' + safe(this.cmt) : '';
    var n = code.length, i = 0;

    if (n <= WRAP) {
      this.pushPart(code + cmt);
    } else {
      for (; i + WRAP < n; i += WRAP) {
        this.pushPart(code.slice(i, i + WRAP));
        if (this.truncated) return;               /* 单条语句也可能有几百万字符 */
      }
      if (i < n && !this.truncated) this.pushPart(code.slice(i, n) + cmt);
    }
  };

  Gen.prototype.varCell = function (name) {
    if (this.vars[name] == null) {
      this.vars[name] = this.next++;
      this.varOrder.push(name);
    }
    return this.vars[name];
  };

  /* 高地址侧的两个搬运格：按需分配（第一次用到才占格）。
     变量多起来以后（std::string 一个就能占 33 格），固定的 S1/S2/T2/T1 都在
     0 附近，拷贝一次要走 6 趟、每趟几百格。就近取一个搬运格能把
     「2×|tmp-src| + |tmp-dst|」从上千压到个位数。 */
  Gen.prototype.hiTmps = function () {
    if (this.__hiA == null) {
      this.__hiA = this.varCell('__hiA');
      this.__hiB = this.varCell('__hiB');
    }
  };

  /* 选一个既不是 src 也不是 dst 的搬运工；优先离 src 近的 */
  Gen.prototype.tmpFor = function (src, dst) {
    this.hiTmps();
    var cand = [S1, S2, T2, T1, this.__hiA, this.__hiB], i;
    var best = -1, bestCost = Infinity;
    for (i = 0; i < cand.length; i++) {
      var c = cand[i];
      if (c === src || c === dst) continue;
      /* copyAddT 的指针行程：2×|tmp-src| + |tmp-dst|（见上） */
      var cost = 2 * Math.abs(c - src) + Math.abs(c - dst);
      if (cost < bestCost) { bestCost = cost; best = c; }
    }
    return best < 0 ? NEG : best;
  };

  /* dst += src，src 保持原值 */
  Gen.prototype.copyAddT = function (src, dst, tmp) {
    this.clear(tmp);
    this.moveTo(src); this.push('[-');
    this.moveTo(dst); this.push('+');
    this.moveTo(tmp); this.push('+');
    this.moveTo(src); this.push(']');
    this.moveTo(tmp); this.push('[-');
    this.moveTo(src); this.push('+');
    this.moveTo(tmp); this.push(']');
  };

  Gen.prototype.copyAdd = function (src, dst) {
    this.copyAddT(src, dst, this.tmpFor(src, dst));
  };

  /* dst = src */
  Gen.prototype.movCell = function (dst, src) {
    this.clear(dst);
    this.copyAdd(src, dst);
  };

  /* ---------------- 表达式 ---------------- */
  Gen.prototype.exprToCell = function (e, dst) {
    this.clear(dst);
    this.exprAddTo(e, dst);
  };

  Gen.prototype.exprAddTo = function (e, dst) {
    if (!e) return;

    if (e.k === 'num') { this.addConst(dst, e.v & 255); return; }
    if (e.k === 'var') { this.copyAdd(this.varCell(e.name), dst); return; }

    if (e.k === 'bin') {
      if (e.op === '+') {
        this.exprAddTo(e.a, dst);
        this.exprAddTo(e.b, dst);
        return;
      }
      this.exprAddTo(e.a, dst);
      this.subIntoTo(e.b, dst);
      return;
    }

    if (e.k === 'mul') { this.mulAddTo(e, dst); return; }
    if (e.k === 'div') { this.divModTo(e, dst, false); return; }
    if (e.k === 'mod') { this.divModTo(e, dst, true); return; }

    throw { message: '表达式里出现了这里不支持的运算：' + condText(e), line: e.line || 0 };
  };

  /* dst += a * b（每轮把 b 直接加进 dst，省掉一次中转清空） */
  Gen.prototype.mulAddTo = function (e, dst) {
    var blocks = this.allocMul(1);
    var m = blocks[Math.min(this.mulDepth, blocks.length - 1)];
    this.mulDepth++;

    this.exprToCell(e.a, m.A);
    this.exprToCell(e.b, m.B);

    var t = this.tmpFor(m.B, dst);

    this.moveTo(m.A); this.push('[');
    this.moveTo(m.A); this.push('-');
    this.copyAddT(m.B, dst, t);
    this.moveTo(m.A); this.push(']');

    this.mulDepth--;
  };

  Gen.prototype.subIntoTo = function (e, dst) {
    if (e.k === 'num') { this.addConst(dst, -(e.v & 255)); return; }

    if (e.k === 'var') {
      var vc = this.varCell(e.name);
      var t = this.tmpFor(vc, dst);
      this.clear(t);
      this.copyAddT(vc, t, this.tmpFor(vc, t));
      this.moveTo(t); this.push('[-');
      this.moveTo(dst); this.push('-');
      this.moveTo(t); this.push(']');
      return;
    }

    throw { message: '减号右侧只支持数字或变量', line: e.line || 0 };
  };

  /* ---------------- 布尔 / 比较 ---------------- */
  /* T2 = 1 若 cell == 0，否则 0（cell 保持原值，T1 被清空） */
  Gen.prototype.testZero = function (cell) {
    this.movCell(T1, cell);
    this.clear(T2);
    this.addConst(T2, 1);
    this.moveTo(T1); this.push('[');
    this.moveTo(T2); this.push('[-]');
    this.moveTo(T1); this.push('[-]');
    this.moveTo(T1); this.push(']');
  };

  /* cell（0/1）取反 */
  Gen.prototype.flip = function (cell) {
    this.clear(NEG);
    this.addConst(NEG, 1);
    this.moveTo(cell); this.push('[-');
    this.moveTo(NEG); this.push('-');
    this.moveTo(cell); this.push(']');
    this.clear(cell);
    this.copyAdd(NEG, cell);
  };

  /* 任意值压成 0/1 */
  Gen.prototype.boolify = function (cell) {
    var t = this.tmpFor(cell, NEG);
    this.clear(t);
    this.moveTo(cell); this.push('[');
    this.moveTo(t); this.push('+');
    this.moveTo(cell); this.push('[-]');
    this.moveTo(cell); this.push(']');
    this.clear(cell);
    this.copyAdd(t, cell);
  };

  /* dst = 1 若 a < b，否则 0 */
  Gen.prototype.cmpLt = function (a, b, dst) {
    /* 0 < x 就是「x 非零」：不用把两个操作数都搬进 LC / RC 再逐格递减 */
    if (a && a.k === 'num' && (a.v & 255) === 0) {
      this.testZero(this.exprCellFor(b));
      this.clear(dst);
      this.addConst(dst, 1);
      this.moveTo(T2); this.push('[');
      this.moveTo(dst); this.push('[-]');
      this.moveTo(T2); this.push('[-]');
      this.moveTo(T2); this.push(']');
      return;
    }
    this.exprToCell(a, LC);
    this.exprToCell(b, RC);
    this.cmpLtCore(dst);
  };

  /* 零值检测用：变量直接用原格（testZero 自己会拷一份），表达式才求值 */
  Gen.prototype.exprCellFor = function (e) {
    if (e && e.k === 'var') return this.varCell(e.name);
    this.exprToCell(e, LC);
    return LC;
  };

  /* 操作数已经在 LC / RC 里时的核心比较 */
  Gen.prototype.cmpLtCore = function (dst) {
    this.clear(dst);
    this.addConst(dst, 1);

    this.moveTo(LC); this.push('[');
    this.moveTo(LC); this.push('-');
    this.testZero(RC);                 /* T2 = 1 表示 b 侧已经见底 → a > b */
    this.moveTo(T2); this.push('[');
    this.moveTo(dst); this.push('[-]');
    this.moveTo(LC); this.push('[-]');
    this.moveTo(T2); this.push('[-]');
    this.moveTo(T2); this.push(']');
    this.moveTo(RC); this.push('-');
    this.moveTo(LC); this.push(']');

    this.testZero(RC);                 /* 收尾：b 也见底说明 a == b，不算小于 */
    this.moveTo(T2); this.push('[');
    this.moveTo(dst); this.push('[-]');
    this.moveTo(T2); this.push('[-]');
    this.moveTo(T2); this.push(']');

  };

  /* dst = 1 若 a == b（negate 为真时取 “!=”） */
  Gen.prototype.cmpEq = function (a, b, dst, negate) {
    /* 与常量比较（最常见的 `x == 0`、`s.len == 7`）：
       把 a 搬进 LC，就地减去常量，再测零 —— 省掉 RC 的整套往返。 */
    if (b && b.k === 'num') {
      var n = b.v & 255;
      if (a && a.k === 'var' && n === 0) {
        this.testZero(this.varCell(a.name));
      } else {
        this.exprToCell(a, LC);
        this.addConst(LC, -n);
        this.testZero(LC);
      }
      this.clear(dst);
      if (negate) {
        this.addConst(dst, 1);
        this.moveTo(T2); this.push('[');
        this.moveTo(dst); this.push('[-]');
        this.moveTo(T2); this.push('[-]');
        this.moveTo(T2); this.push(']');
      } else {
        this.copyAdd(T2, dst);
      }
      return;
    }
    if (a && a.k === 'num') { this.cmpEq(b, a, dst, negate); return; }

    this.exprToCell(a, LC);
    this.exprToCell(b, RC);

    /* LC -= RC */
    this.moveTo(RC); this.push('[-');
    this.moveTo(LC); this.push('-');
    this.moveTo(RC); this.push(']');

    this.clear(dst);

    if (negate) {
      this.moveTo(LC); this.push('[');
      this.moveTo(dst); this.push('+');
      this.moveTo(LC); this.push('[-]');
      this.moveTo(LC); this.push(']');
    } else {
      this.addConst(dst, 1);
      this.moveTo(LC); this.push('[');
      this.moveTo(dst); this.push('[-]');
      this.moveTo(LC); this.push('[-]');
      this.moveTo(LC); this.push(']');
    }
  };

  Gen.prototype.emitCmp = function (e, dst) {
    switch (e.op) {
      case '<': this.cmpLt(e.a, e.b, dst); return;
      case '>': this.cmpLt(e.b, e.a, dst); return;
      case '<=': this.cmpLt(e.b, e.a, dst); this.flip(dst); return;
      case '>=': this.cmpLt(e.a, e.b, dst); this.flip(dst); return;
      case '==': this.cmpEq(e.a, e.b, dst, false); return;
      case '!=': this.cmpEq(e.a, e.b, dst, true); return;
    }
    throw { message: '不支持的条件运算符 ' + e.op, line: e.line || 0 };
  };

  /* 把条件子表达式算成 0/1，写进它自己的 aux 单元 */
  Gen.prototype.emitBool = function (e) {
    var dst = this.aux.get(e);
    if (dst == null) throw { message: '内部错误：条件没有分配单元格', line: e.line || 0 };

    var A, B, t;

    switch (e.k) {
      case 'cmp':
        this.emitCmp(e, dst);
        return;

      case 'not':
        this.emitBool(e.a);
        A = this.aux.get(e.a);
        this.clear(dst);
        this.addConst(dst, 1);
        this.moveTo(A); this.push('[-');
        this.moveTo(dst); this.push('-');
        this.moveTo(A); this.push(']');
        return;

      case 'and':
        this.emitBool(e.a);
        this.emitBool(e.b);
        A = this.aux.get(e.a);
        B = this.aux.get(e.b);
        this.clear(dst);
        this.copyAdd(A, dst);
        this.testZero(B);                /* T2 = 1 表示 b 为假 → 整体为假 */
        this.moveTo(T2); this.push('[');
        this.clear(dst);
        this.moveTo(T2); this.push('[-]');
        this.moveTo(T2); this.push(']');
        return;

      case 'or':
        this.emitBool(e.a);
        this.emitBool(e.b);
        A = this.aux.get(e.a);
        B = this.aux.get(e.b);
        this.clear(dst);
        this.copyAdd(A, dst);
        this.moveTo(B); this.push('[');
        this.clear(dst);
        this.addConst(dst, 1);
        this.moveTo(B); this.push('[-]');
        this.moveTo(B); this.push(']');
        return;

      default:
        t = dst;
        this.exprToCell(e, t);
        this.boolify(t);
        return;
    }
  };

  /* 顶层条件：写进 dst，非 0 即为真 */
  Gen.prototype.emitCondTo = function (e, dst) {
    if (!e) { this.clear(dst); return; }

    if (e.k === 'var' || e.k === 'bin' || e.k === 'mul' || e.k === 'div' || e.k === 'mod') {
      this.exprToCell(e, dst);
      return;
    }
    if (e.k === 'num') { this.clear(dst); this.addConst(dst, e.v & 255); return; }

    /* 比较 / 逻辑条件直接算进目标格，省掉「先写 aux 再拷一份」的两趟搬运 */
    if (e.k === 'cmp' || e.k === 'and' || e.k === 'or' || e.k === 'not') {
      var had = this.aux.has(e), old = this.aux.get(e);
      this.aux.set(e, dst);
      this.emitBool(e);
      if (had) this.aux.set(e, old); else this.aux.delete(e);
      return;
    }

    this.emitBool(e);
    var a = this.aux.get(e);
    this.clear(dst);
    this.copyAdd(a, dst);
  };

  /* ---------------- 十进制输出 ---------------- */
  Gen.prototype.allocPrint = function () {
    if (this.printBlk) return this.printBlk;
    var b = {};
    var keys = ['N', 'Q', 'R', 'QS', 'Q2', 'R2', 'A', 'F', 'C'];
    for (var i = 0; i < keys.length; i++) b[keys[i]] = this.next++;
    this.printBlk = b;
    return b;
  };

  /* 商与余数：in / 10 → q、r（in 被清空） */
  Gen.prototype.div10 = function (inx, qOut, rOut) {
    var b = this.printBlk;
    var C = b.C, A = b.A, F = b.F;

    this.clear(qOut);
    this.clear(C);
    this.addConst(C, 10);          /* 计步器：10 → 9 → … → 0 → 回 10 并进位 */

    this.moveTo(inx); this.push('[');
    this.moveTo(inx); this.push('-');
    this.moveTo(C); this.push('-');

    this.movCell(A, C);            /* A = C，用来判断计步器是否归零 */
    this.clear(F);
    this.addConst(F, 1);
    this.moveTo(A); this.push('[');
    this.moveTo(F); this.push('[-]');
    this.moveTo(A); this.push('[-]');
    this.moveTo(A); this.push(']');

    this.moveTo(F); this.push('[');
    this.addConst(C, 10);
    this.moveTo(qOut); this.push('+');
    this.moveTo(F); this.push('[-]');
    this.moveTo(F); this.push(']');

    this.moveTo(inx); this.push(']');

    /* r = (10 - C) mod 10 */
    this.clear(rOut);
    this.addConst(rOut, 10);
    this.movCell(A, C);
    this.moveTo(A); this.push('[-');       /* 每轮：C 的副本减一，r 也减一 */
    this.moveTo(rOut); this.push('-');
    this.moveTo(A); this.push(']');
  };

  /* 打印一个 0..9 的字符 */
  Gen.prototype.printDigit = function (cell) {
    this.addConst(cell, 48);
    this.moveTo(cell); this.push('.');
    this.addConst(cell, -48);
  };

  /* 把表达式的值按十进制打印（0..255，省掉前导零） */
  Gen.prototype.emitPrintDec = function (e) {
    var b = this.allocPrint();

    this.exprToCell(e, b.N);
    this.div10(b.N, b.Q, b.R);        /* Q = n/10, R = n%10 */
    this.movCell(b.QS, b.Q);
    this.div10(b.Q, b.Q2, b.R2);      /* Q2 = n/100, R2 = 十位 */

    this.moveTo(b.Q2); this.push('[');     /* 百位不为 0 才打印 */
    this.printDigit(b.Q2);
    this.moveTo(b.Q2); this.push('[-]');
    this.moveTo(b.Q2); this.push(']');

    this.moveTo(b.QS); this.push('[');     /* 整体不为 0 才打印十位 */
    this.printDigit(b.R2);
    this.moveTo(b.QS); this.push('[-]');
    this.moveTo(b.QS); this.push(']');

    this.printDigit(b.R);                   /* 个位总是打印 */
  };

  /* ---------------- 十进制输入 ---------------- */
  Gen.prototype.allocInput = function () {
    if (this.inBlk) return this.inBlk;
    var b = {};
    var keys = ['RD', 'G', 'T', 'L1', 'L2', 'PB', 'PH', 'E'];
    for (var i = 0; i < keys.length; i++) b[keys[i]] = this.next++;
    this.inBlk = b;
    return b;
  };

  Gen.prototype.allocMul = function (n) {
    if (this.mulBlk) return this.mulBlk;
    var blocks = [];
    var count = Math.max(1, n || 1);
    for (var k = 0; k < count; k++) {
      blocks.push({ A: this.next++, B: this.next++ });
    }
    this.mulBlk = blocks;
    return blocks;
  };

  /* ---------------- 除法 / 取模 ----------------
   * 思路：把 a 一个一个搬进余数，同时让一个「计步器」从 b 倒数；
   * 计步器归零就说明又凑够了一个 b —— 余数清零、商加一、计步器复位。
   * 复杂度 O(a) 步，静态代码只有一小段循环（对比“先做 a 次比较”的 O(a²) 方案）。
   * b 为 0 时直接跳过整段，商与余数都是 0（不会死循环）。
   */
  Gen.prototype.allocDiv = function (n) {
    if (this.divBlk) return this.divBlk;
    var blocks = [];
    var count = Math.max(1, n || 1);
    for (var k = 0; k < count; k++) {
      blocks.push({
        N: this.next++,   /* 被除数 */
        D: this.next++,   /* 除数 */
        C: this.next++,   /* 计步器（从 D 倒数） */
        Q: this.next++,   /* 商 */
        R: this.next++,   /* 余数 */
        G: this.next++,   /* D != 0 的守卫 */
        T: this.next++    /* 内部搬运用的临时格（不能碰 T1/T2） */
      });
    }
    this.divBlk = blocks;
    return blocks;
  };

  /* dst = src，临时格自己指定（避免踩到外层循环的控制格） */
  Gen.prototype.movCellT = function (dst, src, tmp) {
    this.clear(dst);
    this.copyAddT(src, dst, tmp);
  };

  /* 把 qOut / rOut 算出来（a、b 可以是任意表达式） */
  Gen.prototype.divInto = function (a, b, qOut, rOut) {
    var blocks = this.allocDiv(1);
    var m = blocks[Math.min(this.divDepth, blocks.length - 1)];
    this.divDepth++;

    this.clear(qOut);
    this.clear(rOut);

    this.exprToCell(a, m.N);
    this.exprToCell(b, m.D);

    /* G = (D != 0) */
    this.testZero(m.D);            /* T2 = 1 表示 D == 0 */
    this.flip(T2);                 /* 反过来：1 表示 D != 0 */
    this.clear(m.G);
    this.copyAdd(T2, m.G);
    this.clear(T2);

    this.moveTo(m.G); this.push('[');

    this.movCellT(m.C, m.D, m.T);              /* 计步器 = D */
    this.moveTo(m.N); this.push('[');         /* while (N) */
    this.moveTo(m.N); this.push('-');
    this.moveTo(m.R); this.push('+');
    this.moveTo(m.C); this.push('-');

    this.testZero(m.C);                        /* T2 = 1 表示计步器归零 */
    this.moveTo(T2); this.push('[');
    this.movCellT(m.C, m.D, m.T);              /* 计步器复位 */
    this.clear(m.R);                           /* 余数清零 */
    this.moveTo(qOut); this.push('+');        /* 商加一 */
    this.moveTo(T2); this.push('[-]');
    this.moveTo(T2); this.push(']');

    this.moveTo(m.N); this.push(']');

    this.moveTo(m.G); this.push('[-]');
    this.moveTo(m.G); this.push(']');

    this.divDepth--;
  };

  /* dst += (a / b) 或 dst += (a % b) */
  Gen.prototype.divModTo = function (e, dst, wantRem) {
    if (e.b && e.b.k === 'num' && (e.b.v & 255) === 0) return;   /* 除零 → 加 0 */

    var blocks = this.allocDiv(1);
    var m = blocks[Math.min(this.divDepth, blocks.length - 1)];

    this.divInto(e.a, e.b, m.Q, m.R);

    var src = wantRem ? m.R : m.Q;
    this.moveTo(src); this.push('[-');
    this.moveTo(dst); this.push('+');
    this.moveTo(src); this.push(']');
  };

  /* dst = 1 表示 cell 是 '0'..'9' 的 ASCII */
  Gen.prototype.digitFlag = function (cell, dst) {
    var b = this.inBlk;

    this.movCell(LC, cell);
    this.clear(RC);
    this.addConst(RC, 48);
    this.cmpLtCore(b.L1);              /* L1 = cell < '0' */

    this.clear(LC);
    this.addConst(LC, 57);
    this.movCell(RC, cell);
    this.cmpLtCore(b.L2);              /* L2 = '9' < cell */

    this.clear(dst);
    this.addConst(dst, 1);
    this.moveTo(b.L1); this.push('[');     /* 小于 '0' → 不是数字 */
    this.clear(dst);
    this.moveTo(b.L1); this.push('[-]');
    this.moveTo(b.L1); this.push(']');
    this.moveTo(b.L2); this.push('[');     /* 大于 '9' → 不是数字 */
    this.clear(dst);
    this.moveTo(b.L2); this.push('[-]');
    this.moveTo(b.L2); this.push(']');
  };

  /* 读一个字符到 dst：优先用“回推”的那个字符，否则执行 , 指令 */
  Gen.prototype.readChar = function (dst) {
    var b = this.allocInput();
    var E = b.E;

    this.clear(E);
    this.addConst(E, 1);

    this.moveTo(b.PH); this.push('[');
    this.clear(dst);
    this.copyAdd(b.PB, dst);
    this.clear(b.PB);
    this.moveTo(b.PH); this.push('[-]');
    this.clear(E);
    this.moveTo(b.PH); this.push(']');

    this.moveTo(E); this.push('[');
    this.clear(dst);
    this.moveTo(dst); this.push(',');
    this.moveTo(E); this.push('[-]');
    this.moveTo(E); this.push(']');

  };

  /* cin >> char：跳过前导空白后读第一个非空白字符。
     getchar() / scanf("%c") 不能走这里——它们的语义是「连空白一起读」。
     典型场景：cin >> int 会把数字后的换行回推，接着 cin >> again 必须
     跳过它才能读到真正的 'y' / 'n'。 */
  Gen.prototype.readCharSkipSpace = function (dst) {
    var b = this.allocInput();
    this.readChar(b.RD);
    this.spaceFlag(b.RD, b.G);
    this.moveTo(b.G); this.push('[');
    this.readChar(b.RD);
    this.spaceFlag(b.RD, b.G);
    this.moveTo(b.G); this.push(']');
    this.movCell(dst, b.RD);
  };

  /* dst = 1 表示 cell 是空白（0 < c <= 32） */
  Gen.prototype.spaceFlag = function (cell, dst) {
    var b = this.inBlk;

    this.clear(LC);
    this.movCell(RC, cell);
    this.cmpLtCore(b.L1);              /* L1 = 0 < cell */
    this.movCell(LC, cell);
    this.clear(RC);
    this.addConst(RC, 33);
    this.cmpLtCore(b.L2);              /* L2 = cell < 33 */

    this.clear(dst);
    this.copyAdd(b.L1, dst);
    this.testZero(b.L2);               /* L2 为 0 → 不是空白 */
    this.moveTo(T2); this.push('[');
    this.clear(dst);
    this.moveTo(T2); this.push('[-]');
    this.moveTo(T2); this.push(']');
  };

  /* 读入十进制数字：一直读到非数字字符为止（scanf %d / cin >> int） */
  Gen.prototype.emitReadNum = function (vc) {
    var b = this.allocInput();

    this.clear(vc);

    /* 先跳过空白（空格 / 制表 / 换行） */
    this.readChar(b.RD);
    this.spaceFlag(b.RD, b.G);
    this.moveTo(b.G); this.push('[');
    this.readChar(b.RD);
    this.spaceFlag(b.RD, b.G);
    this.moveTo(b.G); this.push(']');

    this.digitFlag(b.RD, b.G);

    this.moveTo(b.G); this.push('[');
    /* v = v * 10 */
    this.movCell(b.T, vc);
    this.clear(vc);
    this.moveTo(b.T); this.push('[');
    this.moveTo(b.T); this.push('-');
    this.addConst(vc, 10);
    this.moveTo(b.T); this.push(']');
    /* v += 数字字符，再减掉 '0' 的 48 */
    this.movCell(b.T, b.RD);
    this.moveTo(b.T); this.push('[');
    this.moveTo(b.T); this.push('-');
    this.moveTo(vc); this.push('+');
    this.moveTo(b.T); this.push(']');
    this.addConst(vc, -48);
    /* 读下一个字符 */
    this.readChar(b.RD);
    this.digitFlag(b.RD, b.G);
    this.moveTo(b.G); this.push(']');

    /* 把读到的第一个非数字字符“回推”，这样后面的 %c 还能读到它 */
    this.clear(b.PB);
    this.copyAdd(b.RD, b.PB);
    this.clear(b.PH);
    this.addConst(b.PH, 1);

  };

  /* 表达式里有没有引用某个变量（用来判断能否直接算进目标格） */
  function refsVar(e, name) {
    if (!e) return false;
    if (e.k === 'var') return e.name === name;
    if (e.k === 'not') return refsVar(e.a, name);
    if (e.a && refsVar(e.a, name)) return true;
    if (e.b && refsVar(e.b, name)) return true;
    return false;
  }

  /* ---------------- 语句 ---------------- */
  Gen.prototype.assign = function (name, expr, mode) {
    var vc = this.varCell(name);

    /* 比较 / 逻辑表达式的结果（0 或 1）也能直接赋给变量：走条件求值通路。
       int32 lowering 用它存进位、符号位、十进制位等；此前只有 if/while 的
       cond 能这么算，赋给变量会落到「不支持的运算」。 */
    if (expr && (expr.k === 'cmp' || expr.k === 'and' || expr.k === 'or' || expr.k === 'not')) {
      if (mode !== 'set') {
        throw { message: '比较结果只能直接赋值，不能用于 += / -=' };
      }
      this.emitCondTo(expr, vc);
      return;
    }

    /* 快路径：常数直接加、变量直接搬，省掉「先算进 acc 再搬一次」的往返。
       参考：i++ 变成单个 +，x = 5 变成 5 个 +，x += y 变成一次复制循环。 */
    if (expr) {
      if (expr.k === 'num') {
        if (mode === 'set') this.clear(vc);
        this.addConst(vc, mode === 'sub' ? -(expr.v & 255) : (expr.v & 255));
        return;
      }
      if (expr.k === 'var' && expr.name !== name) {
        var sc = this.varCell(expr.name);
        if (mode === 'set') {
          this.movCell(vc, sc);
        } else if (mode === 'add') {
          this.copyAdd(sc, vc);
        } else {
          this.subIntoTo(expr, vc);
        }
        return;
      }
      /* x = 复杂表达式：只要表达式不引用 x，就直接算进 x，
         省掉「先算进 acc、再把 acc 倒进 x」的整轮搬运。 */
      if (mode === 'set' && !refsVar(expr, name)) {
        this.clear(vc);
        this.exprAddTo(expr, vc);
        return;
      }
    }

    this.exprToCell(expr, ACC);

    if (mode === 'set') {
      this.clear(vc);
      this.moveTo(ACC); this.push('[-');
      this.moveTo(vc); this.push('+');
      this.moveTo(ACC); this.push(']');
    } else {
      this.moveTo(ACC); this.push('[-');
      this.moveTo(vc); this.push((mode === 'add' ? '+' : '-'));
      this.moveTo(ACC); this.push(']');
    }

  };

  Gen.prototype.emit = function (node) {
    if (!node) return;

    var self = this;
    var label = node.text ? ' ' + node.text : '';

    switch (node.type) {
      case 'decl':
        if (node.init) {
          this.begin('声明' + label);
          this.assign(node.name, node.init, 'set');
          this.end();
        } else {
          this.varCell(node.name);   /* 置 0 即可，无需指令 */
        }
        break;

      case 'set':
        this.begin('赋值' + label);
        this.assign(node.name, node.expr, 'set');
        this.end();
        break;

      case 'add':
        this.begin('累加' + label);
        this.assign(node.name, node.expr, 'add');
        this.end();
        break;

      case 'sub':
        this.begin('累减' + label);
        this.assign(node.name, node.expr, 'sub');
        this.end();
        break;

      case 'in':
        this.begin((node.skipSpace ? '读入一个非空白字符（cin >> char）' : '读入一个字符') + label);
        if (node.skipSpace) this.readCharSkipSpace(this.varCell(node.name));
        else this.readChar(this.varCell(node.name));
        this.end();
        break;

      case 'innum':
        this.begin('读入十进制数字（scanf %d / cin）' + label);
        this.emitReadNum(this.varCell(node.name));
        this.end();
        break;

      case 'pushback':
        /* 把一个字符塞回输入流：下次 readChar 先取它，不碰真实的 , 。
           std::string 的 cin >> s 用它把「读到的分隔符」留给后面的输入。 */
        this.begin('把字符回推输入流' + label);
        this.exprToCell(node.expr, ACC);
        var ib = this.allocInput();
        this.movCell(ib.PB, ACC);
        this.clear(ib.PH);
        this.addConst(ib.PH, 1);
        this.end();
        break;

      case 'out':
        this.begin('输出字符（putchar / cout）' + label);
        this.exprToCell(node.expr, ACC);
        this.moveTo(ACC);
        this.push('.');
        this.end();
        break;

      case 'outdec':
        this.begin('十进制输出（printf %d / cout 整型）' + label);
        this.emitPrintDec(node.expr);
        this.end();
        break;

      case 'outstr':
        this.begin('输出字符串 ' + JSON.stringify(node.text) + label);
        this.clear(ACC);                 /* 借 ACC 当临时格，先保证它是 0 */
        /* 逐字符推进：从上一次的值直接走到下一个字符码，只付「差值」的代价。
           以前是「加满 → 打 → 减回 0」，一个字符要码两遍；现在只走一次。 */
        var prevCh = 0;
        var bytes = utf8Bytes(node.text);
        for (var si = 0; si < bytes.length; si++) {
          var code = bytes[si];
          this.addConst(ACC, code - prevCh);
          prevCh = code;
          this.moveTo(ACC);
          this.push('.');
        }
        this.clear(ACC);                 /* 收尾复位，别把残值留给后面的语句 */
        this.end();
        break;

      case 'while':
        this.emitWhile(node);
        break;

      case 'if':
        this.emitIf(node);
        break;

      case 'ret':
        throw { message: 'return 应该被函数内联展开掉，这里不该出现', line: node.line || 0 };

      case 'brk':
      case 'cont':
      case 'stepmark':
        throw { message: 'break / continue 没有被循环改写处理（内部错误）', line: node.line || 0 };

      case 'call':
      case 'callset':
        throw { message: '函数调用没有被展开（内部错误）', line: node.line || 0 };

      default:
        this.begin('（未处理的语句 ' + node.type + '）');
        this.end();
    }
  };

  Gen.prototype.emitWhile = function (node) {
    var self = this;
    var c = node.cond;

    if (c.k === 'var') {
      var cc = this.varCell(c.name);
      this.begin('while (' + c.name + ') {');
      this.moveTo(cc);
      this.push('[');
      this.end();                 /* 指针停在条件格，正好进入循环体 */

      node.body.forEach(function (st) { self.emit(st); });

      this.begin('} 条件仍在 ' + c.name + ' 上，非 0 就跳回');
      this.moveTo(cc);
      this.push(']');
      this.end();
      return;
    }

    var cell = this.ctrl.get(node);
    this.begin('while (' + condText(c) + ') {  先把条件算进单元 ' + cell);
    this.emitCondTo(c, cell);
    this.moveTo(cell);
    this.push('[');
    this.end();

    node.body.forEach(function (st) { self.emit(st); });

    this.begin('} 重新计算：' + condText(c) + '，非 0 就跳回');
    this.emitCondTo(c, cell);
    this.moveTo(cell);
    this.push(']');
    this.end();
  };

  Gen.prototype.emitIf = function (node) {
    var self = this;
    var cells = this.ifCells.get(node);
    var hasElse = !!(node.else && node.else.length);

    if (hasElse) {
      this.begin('if 准备：else 标志置 1');
      this.addConst(cells.e, 1);
      this.end();
    }

    this.begin('if (' + condText(node.cond) + ') {');
    this.emitCondTo(node.cond, cells.c);
    this.moveTo(cells.c);
    this.push('[');
    this.end();                 /* 指针停在条件格 */

    node.then.forEach(function (st) { self.emit(st); });

    if (hasElse) {
      this.begin('   走过 then，清掉 else 标志');
      this.moveTo(cells.e);
      this.push('[-]');
      this.end();
    }

    this.begin('   清条件格，保证只执行一次');
    this.moveTo(cells.c);
    this.push('[-]]');
    this.end();

    if (hasElse) {
      this.begin('} else {');
      this.moveTo(cells.e);
      this.push('[');
      this.end();

      node.else.forEach(function (st) { self.emit(st); });

      this.begin('}');
      this.moveTo(cells.e);
      this.push('[-]]');
      this.end();
    }
  };

  /* ---------------- 分配 ---------------- */
  /* 条件 / 分支用的临时格只在对应语句内部有效，顺序语句之间可以复用。
     用一个后进先出的池子管理：进入语句时记水位，离开时把多出来的格子还回去，
     这样 100 个 if 不会再吃掉 200 个单元（也让全局的 >>>/<<< 显著变短）。 */
  function Pool(g) {
    this.g = g;
    this.used = [];
    this.free = [];
  }
  Pool.prototype.take = function () {
    var c = this.free.length ? this.free.pop() : this.g.next++;
    this.used.push(c);
    return c;
  };
  /* 预留 n 个低地址格给条件临时用（take() 会优先从 free 里取） */
  Pool.prototype.reserve = function (n) {
    for (var i = 0; i < n; i++) this.free.push(this.g.next++);
  };
  Pool.prototype.mark = function () { return this.used.length; };
  Pool.prototype.release = function (mark) {
    while (this.used.length > mark) this.free.push(this.used.pop());
  };

  function exprVars(e, g) {
    if (!e) return;
    if (e.k === 'var') g.varCell(e.name);
    else if (e.k === 'bin' || e.k === 'cmp' || e.k === 'and' || e.k === 'or' ||
             e.k === 'mul' || e.k === 'div' || e.k === 'mod') {
      exprVars(e.a, g);
      exprVars(e.b, g);
    } else if (e.k === 'not') {
      exprVars(e.a, g);
    }
  }

  function allocCond(g, e, isRoot) {
    if (!e) return;

    var direct = (e.k === 'var' || e.k === 'num' || e.k === 'bin' ||
                  e.k === 'mul' || e.k === 'div' || e.k === 'mod');
    if (!(isRoot && direct)) g.aux.set(e, g.pool.take());

    switch (e.k) {
      case 'var':
        g.varCell(e.name);
        break;
      case 'bin':
      case 'mul':
      case 'div':
      case 'mod':
        allocCond(g, e.a, false);
        allocCond(g, e.b, false);
        break;
      case 'cmp':
        allocCond(g, e.a, false);
        allocCond(g, e.b, false);
        break;
      case 'not':
        allocCond(g, e.a, false);
        break;
      case 'and':
      case 'or':
        allocCond(g, e.a, false);
        allocCond(g, e.b, false);
        break;
    }
  }

  function allocPass(nodes, g) {
    nodes.forEach(function (n) {
      if (!n) return;

      switch (n.type) {
        case 'decl':
        case 'set':
        case 'add':
        case 'sub':
        case 'in':
        case 'innum':
          g.varCell(n.name);
          exprVars(n.expr, g);
          /* 比较 / 逻辑结果直接赋给变量时（int32 lowering 大量使用），
             也要像 if/while 的条件一样给子表达式分配临时格，否则
             emitBool 会报「条件没有分配单元格」。这些格只在本句内有效。 */
          if (n.expr && (n.expr.k === 'cmp' || n.expr.k === 'and' ||
                         n.expr.k === 'or' || n.expr.k === 'not')) {
            var sMark = g.pool.mark();
            allocCond(g, n.expr, true);
            g.pool.release(sMark);
          }
          break;

        case 'out':
        case 'outdec':
          exprVars(n.expr, g);
          break;

        case 'while': {
          /* 条件单元与循环控制格只在这个 while 内部需要：
             记下水位，处理完循环体就把它们还给池子，让后面的语句复用。 */
          var wMark = g.pool.mark();
          allocCond(g, n.cond, true);
          if (n.cond.k !== 'var') g.ctrl.set(n, g.pool.take());
          allocPass(n.body, g);
          g.pool.release(wMark);
          break;
        }

        case 'if': {
          var iMark = g.pool.mark();
          allocCond(g, n.cond, true);
          g.ifCells.set(n, { c: g.pool.take(), e: g.pool.take() });
          allocPass(n.then, g);
          if (n.else) allocPass(n.else, g);
          g.pool.release(iMark);
          break;
        }
      }

      if (n.expr) exprVars(n.expr, g);
    });
  }

  /* 有没有十进制输出 / 输入 / 乘法 / 除法 —— 决定要不要预留这些公共单元 */
  var KIND_KEYS = ['bin', 'cmp', 'and', 'or', 'mul', 'div', 'mod'];

  function mulDepthOf(e) { return depthOf(e, 'mul'); }

  function divDepthOf(e) { return depthOf(e, 'div') + depthOf(e, 'mod'); }

  /* 同类运算的嵌套深度（a*b*c 记 2 层，用来给每层留独立的临时单元） */
  function depthOf(e, kind) {
    if (!e) return 0;
    var self = (e.k === kind) ? 1 : 0;
    var child = 0;
    if (KIND_KEYS.indexOf(e.k) >= 0) {
      child = Math.max(depthOf(e.a, kind), depthOf(e.b, kind));
    } else if (e.k === 'not') {
      child = depthOf(e.a, kind);
    }
    return self + child;
  }

  function scanNeeds(nodes, acc) {
    (nodes || []).forEach(function (n) {
      if (!n) return;
      if (n.type === 'outdec') acc.print = true;
      if (n.type === 'in' || n.type === 'innum') acc.input = true;
      var m = Math.max(mulDepthOf(n.expr), mulDepthOf(n.cond));
      if (m > (acc.mul || 0)) acc.mul = m;
      var d = Math.max(divDepthOf(n.expr), divDepthOf(n.cond));
      if (d > (acc.div || 0)) acc.div = d;
      if (n.type === 'while') scanNeeds(n.body, acc);
      if (n.type === 'if') {
        scanNeeds(n.then, acc);
        if (n.else) scanNeeds(n.else, acc);
      }
    });
    return acc;
  }

  /* 一行太长就折成多行（BF 忽略换行，注释放在最后一段上） */
  var WRAP = 84;

  /* 片段攒到这么大才合成一个 parts 元素：既能让 new Blob(parts) 直接
     分块下载（不用再 join 出一整条几十 MB~几 GB 的字符串），也不会像
     「每 84 字符一个元素」那样在超大程序里产生几千万个数组元素。 */
  var CHUNK = 65536;

  /* 编辑器预览上限：超过就只保留前面这段，避免把上千万字符塞进
     textarea / DOM 文本节点 / 高亮器。这只是「显示」层的截断，与代码
     生成无关 —— 完整代码随时可以按需重新生成、导出、送调试器。 */
  var PREVIEW_LIMIT = 120000;

  /* 预览的时间预算（毫秒）：仅用于「输入即编译」的实时统计，不是指令数
     上限。超时后 preview 的指令数标成下界（≥ N），完整生成不受影响。
     哨兵用来从当前语句内部跳出，否则长除法一条语句就要发射几万次。 */
  var PREVIEW_MS = 400;
  var PREVIEW_STOP = { previewStop: true };

  /* 给每个单元格生成「作用」注释：固定寄存器 → 各工作区 → 源码变量 → 其余临时格。
     编译产物送进调试器时作为单元格名称（格子上显示）与悬停说明。 */
  function cellRoles(g) {
    var names = Object.create(null);
    var notes = Object.create(null);
    var i;

    function set(c, name, note) {
      if (c < 0 || c >= g.next) return;
      names[c] = String(name).slice(0, 24);
      notes[c] = String(note).slice(0, 120);
    }

    var fixed = [
      ['home', '指针基准位（保留，语句间不归位）'],
      ['acc', '表达式累加器'],
      ['s1', '复制用暂存 1'],
      ['s2', '复制用暂存 2'],
      ['lc', '比较：左操作数'],
      ['rc', '比较：右操作数'],
      ['t1', '零值检测的副本'],
      ['t2', '零值检测 / 逻辑运算标志'],
      ['neg', '取反用的常量 1']
    ];
    fixed.forEach(function (f, k) { set(k, f[0], f[1]); });

    /* 工作区对象里全是格号，递归取 min..max 即可，不必依赖具体字段命名 */
    function span(obj, note) {
      if (!obj) return;
      var lo = Infinity, hi = -Infinity;
      (function walk(o) {
        if (typeof o === 'number' && isFinite(o)) {
          if (o < lo) lo = o;
          if (o > hi) hi = o;
          return;
        }
        if (Array.isArray(o)) { o.forEach(walk); return; }
        if (o && typeof o === 'object') {
          Object.keys(o).forEach(function (k) { walk(o[k]); });
        }
      })(obj);
      if (hi < lo) return;
      for (var c = lo; c <= hi; c++) {
        if (!(c in names)) set(c, 'work', note + '，格 ' + c);
      }
    }
    span(g.printBlk, '十进制输出工作区');
    span(g.inBlk, '输入缓冲工作区');
    span(g.mulBlk, '乘法暂存区');
    span(g.divBlk, '除法暂存区');

    /* std::string 会摊成 x.len + x[0..31]，数组元素也叫 x[0] / m[1][2]，
       两者命名形式相同。用「有没有 x.len」来区分：有长度格的是字符串。 */
    var strBase = Object.create(null);
    g.varOrder.forEach(function (n) {
      var ml0 = /^(.*)\.len$/.exec(n);
      if (ml0) strBase[ml0[1]] = 1;
    });

    g.varOrder.forEach(function (n) {
      var mb = /^(.*)@([0-3])$/.exec(n);
      var ml = /^(.*)\.len$/.exec(n);
      var msub = /^(.*?)((?:\[\d+\])+)$/.exec(n);
      var note;
      if (mb) note = 'int32 变量 ' + mb[1] + ' 的第 ' + mb[2] + ' 字节（小端，4 格合成）';
      else if (ml) note = 'std::string ' + ml[1] + ' 的长度（0..32）';
      else if (n.indexOf('__st') === 0) note = 'std::string 运算的临时缓冲区';
      else if (msub && strBase[msub[1]]) note = 'std::string ' + msub[1] + ' 的字符格 ' + msub[2];
      else if (msub && msub[1].indexOf('.') >= 0) note = 'struct 字段 ' + msub[1] + ' 的元素 ' + msub[2];
      else if (msub) note = '数组 ' + msub[1] + ' 的元素 ' + msub[2] + '（每维摊平后各占独立格）';
      else if (n.indexOf('__hi') === 0) note = '远距离搬运用的就近暂存格';
      else if (n.indexOf('__i32_') === 0) note = 'int32 运算的临时工作格';
      else if (n.indexOf('__av') === 0 || n.indexOf('__aw') === 0 ||
               n.indexOf('__ai') === 0) note = '数组下标访问的临时格';
      else if (n === '__entry_go') note = 'main 里的 return 标志：1 继续执行，0 表示程序已结束';
      else if (n.indexOf('__') === 0 && /_c$/.test(n)) note = '函数的「继续执行」标志：return 之后清零，挡住后续语句';
      else if (n.indexOf('__') === 0) note = '编译器内部变量 ' + n + '（函数内联 / 临时结果）';
      else note = '源码变量 ' + n;
      set(g.vars[n], n, note);
    });

    for (i = 0; i < g.next; i++) {
      if (!(i in names)) set(i, 'tmp', '条件判断 / 分支的临时工作格');
    }
    return { names: names, notes: notes };
  }

  /* 统计每个名字被引用的次数：分配时把「热」单元格放低地址。
     远距离指针移动是生成代码里最贵的部分（每跨 k 格就是 k 个字符），
     把常用的变量放在 0 附近能让绝大多数语句的搬运距离从几百降到几十。 */
  function rankVars(nodes) {
    var cnt = Object.create(null);
    function bump(name) {
      if (name == null) return;
      cnt[name] = (cnt[name] || 0) + 1;
    }
    function expr(e, weight) {
      if (!e) return;
      if (e.k === 'var') { cnt[e.name] = (cnt[e.name] || 0) + weight; return; }
      if (e.k === 'bin' || e.k === 'cmp' || e.k === 'and' || e.k === 'or' ||
          e.k === 'mul' || e.k === 'div' || e.k === 'mod') {
        expr(e.a, weight); expr(e.b, weight);
        return;
      }
      if (e.k === 'not') { expr(e.a, weight); return; }
    }
    (function walk(list) {
      (list || []).forEach(function (n) {
        if (!n) return;
        /* 语句自身的读写通常伴随一次复制，权重给 2；条件每轮都要重算，也给 2 */
        bump(n.name); bump(n.name);
        if (n.init) expr(n.init, 2);
        if (n.expr) expr(n.expr, 2);
        if (n.cond) expr(n.cond, 3);
        if (n.idx) expr(n.idx, 2);
        if (n.type === 'while') walk(n.body);
        if (n.type === 'if') { walk(n.then); if (n.else) walk(n.else); }
      });
    })(nodes);
    return Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a]; });
  }

  /**
   * @param {Array} ir       中间表示
   * @param {Object} opts    { lang, srcLines, comments, preview, noJoin }
   *   preview 只截断「显示用」的字符串；noJoin 只返回 chunks 不拼整串。
   * @returns {{code:string|null, chunks:string[], stats:Object, vars:Array}}
   */
  function generate(ir, opts) {
    opts = opts || {};
    /* comments:false → 只输出纯 BrainFuck 指令（去掉头部说明与逐句注释），
       便于导出最小的 .bf；语义完全一致，注释本来就会被解释器忽略。 */
    var withComments = opts.comments !== false;
    var g = new Gen();
    g.withComments = withComments;
    /* 预览模式只保留前 PREVIEW_LIMIT 个字符；下载 / 复制 / 送调试器时
       由 UI 用 preview:false 重新编一次拿完整代码，避免每次打字都分配
       十几 MB 的字符串。注意统计值仍是完整的。 */
    if (opts.preview) {
      g.limit = PREVIEW_LIMIT;
      g.deadline = Date.now() + PREVIEW_MS;
    }

    normalize(ir);
    var need = scanNeeds(ir, {});

    /* 大块单元（十进制 / 输入 / 乘除）先占位：它们内部的循环靠得很近，
       整体编号靠前一点，和变量的距离也稳定。 */
    if (need.print) g.allocPrint();
    if (need.input) g.allocInput();
    if (need.mul) g.allocMul(need.mul);
    if (need.div) g.allocDiv(need.div);

    /* 变量一多（std::string / int32 会摊出上百格），条件临时格如果从末尾
       分配，每条 if / while 都要横跨几百格去读写条件。这时改用：最热的
       32 个变量占低地址 → 预留一小块给条件池 → 其余冷变量排后面。
       小程序的格子本来就挤在 0 附近，保持原来的「首次出现顺序」最快。 */
    var ranked = rankVars(ir);
    if (ranked.length > 64) {
      /* 条件池贴着 lc / rc（4、5）最划算：每条 if / while 都要用它们 */
      g.pool.reserve(14);
      ranked.forEach(function (n) { g.varCell(n); });
    }

    allocPass(ir, g);
    /* 不再有指令数上限：所有语句都完整发射，stat 就是真实总指令数。
       输出按 CHUNK 分块收集，不会因单条语句几百万字符而形成超深字符串。
       只有编辑器预览会在时间预算到点时提前收工（partial），完整生成不会。 */
    try {
      for (var ei = 0; ei < ir.length; ei++) g.emit(ir[ei]);
    } catch (stop) {
      if (stop !== PREVIEW_STOP) throw stop;
    }
    g.flush();                         /* 收进最后不足 CHUNK 的片段 */

    var stat = g.stat;

    var shown = g.varOrder.filter(function (n) { return n.indexOf('__') !== 0; });
    var varText = shown.map(function (n) { return n + '=' + g.vars[n]; }).join(' ');

    var layout = '0=home 1=acc 2=s1 3=s2 4=lc 5=rc 6=t1 7=t2 8=neg';
    if (g.printBlk) layout += ' · 十进制 ' + g.printBlk.N + '…' + g.printBlk.C;
    if (g.inBlk) layout += ' · 输入 ' + g.inBlk.RD + '…' + g.inBlk.E;
    if (g.mulBlk) layout += ' · 乘法 ' + g.mulBlk[0].A + '…' + g.mulBlk[g.mulBlk.length - 1].B;
    if (g.divBlk) layout += ' · 除法 ' + g.divBlk[0].N + '…' + g.divBlk[g.divBlk.length - 1].T;

    var head = [
      '; ┌─────────────────────────────────────────────────────────',
      '; │ BrainFuck 编译器 · 源语言 ' + safe(opts.lang || 'C'),
      '; │ 内存 ' + layout,
      '; │ 变量 ' + safe(varText || '（无）'),
      '; │ 指令 ' + stat + (g.partial ? '+（预览下界）' : '') +
        ' · 单元格 ' + g.next + (opts.srcLines ? ' · 源码 ' + opts.srcLines + ' 行' : ''),
      '; └─────────────────────────────────────────────────────────',
      '', ''
    ].join('\n');

    /* parts 的每段自带 '\n'，head 末尾两个换行正好还原原来的空行。
       noJoin：导出超大规模程序时只交出分片，调用方 new Blob(chunks)
       即可拿到完全一致的字节，不必再在内存里拼一整条巨型字符串。 */
    if (withComments) g.parts.unshift(head);
    var chunks = g.parts;
    var code = opts.noJoin ? null : chunks.join('');

    return {
      code: code,
      chunks: chunks,
      preview: g.truncated,
      fullChars: g.stat,
      stats: {
        commands: stat,
        partial: g.partial,
        cells: g.next,
        lines: g.lineCount,
        statements: ir.length
      },
      vars: g.varOrder
        .filter(function (n) { return n.indexOf('__') !== 0; })
        .map(function (n) { return { name: n, cell: g.vars[n] }; }),
      cells: cellRoles(g)
    };
  }

  TC.Codegen = { generate: generate, HOME: HOME, ACC: ACC, _Gen: Gen };
})(window.TC = window.TC || {});
