/* =========================================================================
 * tc/str.js —— C++ std::string（定长字节缓冲）
 *
 * BrainFuck 没有堆，也没有长度可变的容器，这里把每个 std::string 摊平成
 * 33 个单元格：1 格长度 + 32 格字节（UTF-8 原样存放）。
 *
 *     s.len        长度（0..32）
 *     s[0] … s[31] 第 0..31 个字节
 *
 * 与 tc/i32.js 一样在 IR 层降级成普通 8 位语句，并且早于函数内联展开，
 * 因此函数里的局部字符串会随调用点自动改名、互不干扰。生成的只有
 * set / decl / in / out / if / while / pushback 这些既有节点。
 *
 * 支持：
 *   声明 / 赋值 / 拷贝    std::string s = "hi";  s = t;  s.assign(t);
 *   拼接                  s + t、s + "…"、s + 'c'、s += …
 *   长度 / 判空           s.length() / s.size() / s.empty()
 *   下标                  s[i] 读、s[i] = c 写、s.at(i)
 *   增删                  s.push_back(c) / s.pop_back() / s.clear() / s.append(t)
 *   子串 / 查找           s.substr(pos[, n]) / s.find(c)
 *   比较                  == != < > <= >=（按字节字典序，与 C++ 一致）
 *   输出                  cout << s、printf("%s", s)
 *   输入                  cin >> s（读到空白）、getline(cin, s)（读到换行）
 *   数字互转              to_string(n)（0..255）、stoi(s)
 *
 * 边界（编译时会明确告警）：
 *   · 容量固定 32 字节，超长部分截断；
 *   · length() / size() 返回 UTF-8 字节数，一个汉字算 3 个；
 *   · 不能作为函数参数 / 返回值，也不能放进数组；
 *   · 带下标的函数扫描是「每个下标一次比较」的展开式实现，代码量随容量线性增长。
 * ========================================================================= */
(function (TC) {
  'use strict';

  var CAP = 32;

  /* JS 字符串 → UTF-8 字节（与 BF 单元格里的存储保持一致） */
  function utf8Bytes(s) {
    var out = [], i, c, cp;
    s = String(s);
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c < 0x80) { out.push(c); continue; }
      if (c < 0x800) { out.push(0xC0 | (c >> 6), 0x80 | (c & 63)); continue; }
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
        cp = 0x10000 + ((c - 0xD800) << 10) + (s.charCodeAt(i + 1) - 0xDC00);
        i++;
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63),
                 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        continue;
      }
      out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  function lower(nodes, types, warnings, seed) {
    var seq = seed || 0;
    var pre = [];                       /* 当前收集的前置语句 */
    var warned = Object.create(null);

    function tmp() { return '__st' + (seq++); }
    function N(v) { return { k: 'num', v: v & 255 }; }
    function V(n) { return { k: 'var', name: n }; }
    function BIN(op, a, b) { return { k: 'bin', op: op, a: a, b: b }; }
    function MUL(a, b) { return { k: 'mul', a: a, b: b }; }
    function DIV(a, b) { return { k: 'div', a: a, b: b }; }
    function MOD(a, b) { return { k: 'mod', a: a, b: b }; }
    function CMP(op, a, b) { return { k: 'cmp', op: op, a: a, b: b }; }
    function AND(a, b) { return { k: 'and', a: a, b: b }; }
    function OR(a, b) { return { k: 'or', a: a, b: b }; }
    function NOT(a) { return { k: 'not', a: a }; }
    function lineOf(e) { return (e && e.line) || 1; }

    function isStrName(n) { return types[n] === 'str'; }
    function lenOf(n) { return n + '.len'; }
    function chOf(n, i) { return n + '[' + i + ']'; }

    function warn(msg, line) {
      if (warned[msg]) return;
      warned[msg] = 1;
      for (var i = 0; i < warnings.length; i++) if (warnings[i].message === msg) return;
      warnings.push({ message: msg, line: line || 1 });
    }
    function capWarn(line) {
      warn('std::string 用固定 32 字节缓冲区模拟：超过 32 字节的部分会被截断；' +
           'length() / size() 返回的是 UTF-8 字节数（一个汉字算 3 个）', line);
    }

    /* ---------------- 语句收集 ---------------- */
    function push(n) { pre.push(n); }
    function setCell(name, expr, line, text) {
      push({ type: 'set', name: name, expr: expr, line: line, text: text || '字符串' });
    }
    function addCell(name, expr, line, text) {
      push({ type: 'add', name: name, expr: expr, line: line, text: text || '字符串长度 +1' });
    }
    function iff(cond, then, els, line, text) {
      push({ type: 'if', cond: cond, then: then, else: els || null,
             line: line, text: text || '字符串' });
    }
    function whiles(cond, body, line, text) {
      push({ type: 'while', cond: cond, body: body, line: line, text: text || '字符串' });
    }
    function capture(fn) {
      var save = pre;
      pre = [];
      var value = fn();
      var stmts = pre;
      pre = save;
      return { value: value, stmts: stmts };
    }
    function stmtsOf(fn) { return capture(fn).stmts; }

    /* ---------------- 字符串表达式判定 ---------------- */
    function isStrExprOf(e) {
      if (!e) return false;
      if (e.k === 'strlit' || e.k === 'scat' || e.k === 'ssub' ||
          e.k === 'to_str' || e.k === 'srep') return true;
      if (e.k === 'var') return isStrName(e.name);
      return false;
    }

    /* ---------------- 基本读写 ---------------- */
    function assignLiteral(dst, text, line) {
      var bytes = utf8Bytes(text);
      if (bytes.length > CAP) { capWarn(line); bytes = bytes.slice(0, CAP); }
      for (var i = 0; i < CAP; i++) {
        setCell(chOf(dst, i), N(i < bytes.length ? bytes[i] : 0), line,
                '字符串字面量第 ' + i + ' 字节');
      }
      setCell(lenOf(dst), N(bytes.length), line, '字符串长度 = ' + bytes.length);
    }

    function copyString(dst, src, line) {
      if (dst === src) return;
      for (var i = 0; i < CAP; i++) {
        setCell(chOf(dst, i), V(chOf(src, i)), line, '字符串拷贝第 ' + i + ' 字节');
      }
      setCell(lenOf(dst), V(lenOf(src)), line, '字符串长度拷贝');
    }

    /* 下标分发：把下标存进一个临时格，然后「每格一次 == 0 判断 + 自减」。
       比「每个分支都和常量 i 比一次」便宜得多 —— 分支体只需要一次零值检测，
       而且下标表达式（如 pv + j）只求值一次，不再复制 32 份。

       正确性：k 命中 0 时该分支执行，随后 k -= 1 变成 255，再往后 31 个分支
       只会递减到 224…，不会再次命中；下标 ≥ 32 时 32 步内根本走不到 0。 */
    /* 下标分发：32 个下标各一个守卫，命中哪个取哪个。
       （试过「先把下标存进临时格再逐格自减」，多出 32 条自减语句，
       静态长度反而更大；直接和常量比较更省。） */
    function eachIndex(idxExpr, line, cb) {
      for (var i = 0; i < CAP; i++) cb(i, idxExpr);
    }

    /* r = s[idx] */
    function readIndexed(name, idxExpr, line) {
      var r = tmp();
      setCell(r, N(0), line, '下标读取初值 0');
      eachIndex(idxExpr, line, function (i, k) {
        iff(CMP('==', k, N(i)),
            [{ type: 'set', name: r, expr: V(chOf(name, i)), line: line,
               text: '取 ' + name + '[' + i + ']' }],
            null, line, '下标命中 ' + i);
      });
      return r;
    }

    /* s[idx] = v */
    function writeIndexed(name, idxExpr, valExpr, line) {
      eachIndex(idxExpr, line, function (i, k) {
        iff(CMP('==', k, N(i)),
            [{ type: 'set', name: chOf(name, i), expr: valExpr, line: line,
               text: '写 ' + name + '[' + i + ']' }],
            null, line, '下标命中 ' + i);
      });
    }

    /* 逐字节输出：用一个「还剩几个字节」的倒计数器，每输出一格减一。
       以前是 if (len > i) × 32 —— 每次都要把 len 搬进比较单元、
       和常量 0…31 各比一遍；倒计数只需要一次「非零」判断。 */
    function outChars(name, line) {
      var k = tmp();
      setCell(k, V(lenOf(name)), line, '待输出字节数');
      for (var i = 0; i < CAP; i++) {
        iff(V(k),
            [{ type: 'out', expr: V(chOf(name, i)), line: line,
               text: '输出字符串第 ' + i + ' 字节' },
             { type: 'sub', name: k, expr: N(1), line: line, text: '剩余字节数 -1' }],
            null, line, '还有字节才输出');
      }
    }

    /* ---------------- 字符串表达式物化 ---------------- */
    function matStr(e, line) {
      if (!e) return null;
      if (e.k === 'var' && isStrName(e.name)) return e.name;
      var t = tmp();
      if (e.k === 'strlit') { assignLiteral(t, e.text, line); return t; }
      if (e.k === 'scat') { buildConcat(t, e, line); return t; }
      if (e.k === 'ssub') { buildSubstr(t, e, line); return t; }
      if (e.k === 'to_str') { buildToStr(t, e, line); return t; }
      if (e.k === 'srep') { buildRep(t, e, line); return t; }
      throw { message: '这里需要一个 std::string（字符串变量 / 字面量 / 拼接结果）',
              line: line || 1 };
    }

    function refsStr(e, name) {
      if (!e) return false;
      if (e.k === 'var') return e.name === name;
      if (e.base) return e.base === name;
      if (e.k === 'scat' || e.k === 'ssub') {
        return refsStr(e.a, name) || refsStr(e.b, name) ||
               refsStr(e.pos, name) || refsStr(e.len, name);
      }
      if (e.k === 'sidx') return refsStr(e.idx, name);
      if (e.k === 'to_str') return refsStr(e.a, name);
      if (e.k === 'srep') return refsStr(e.n, name) || refsStr(e.ch, name);
      return false;
    }

    /* 目标 = 源字符串（含拼接结果） */
    function assignString(dst, e, line) {
      if (!e) { setCell(lenOf(dst), N(0), line, '清空字符串'); return; }
      if (e.k === 'strlit') { assignLiteral(dst, e.text, line); return; }
      if (e.k === 'var' && isStrName(e.name)) { copyString(dst, e.name, line); return; }
      /* s = s + x：就地追加，省一个临时缓冲区 */
      if (e.k === 'scat' && e.a && e.a.k === 'var' && e.a.name === dst &&
          !refsStr(e.b, dst)) {
        appendOperand(dst, e.b, line);
        return;
      }
      var t = matStr(e, line);
      copyString(dst, t, line);
    }

    /* 追加一个操作数：字符串走逐字节追加，其它按单个字符追加 */
    function appendOperand(dst, e, line) {
      if (isStrExprOf(e)) {
        var s = matStr(e, line);
        appendStr(dst, s, line);
      } else {
        pushChar(dst, numExprOf(e, line), line);
      }
    }

    /* dst += src：先记源长度，再逐字节搬运（自追加也安全） */
    function appendStr(dst, src, line) {
      var sn = tmp(), j = tmp();
      setCell(sn, V(lenOf(src)), line, '记录待追加长度');
      setCell(j, N(0), line, '追加下标 = 0');
      var body = stmtsOf(function () {
        var r = readIndexed(src, V(j), line);
        var put = stmtsOf(function () {
          writeIndexed(dst, V(lenOf(dst)), V(r), line);
          addCell(lenOf(dst), N(1), line);
          return null;
        });
        iff(CMP('<', V(lenOf(dst)), N(CAP)), put, null, line, '容量未满才追加');
        addCell(j, N(1), line, '追加下标 +1');
        return null;
      });
      whiles(CMP('<', V(j), V(sn)), body, line, '逐字节追加到目标字符串');
    }

    /* s.push_back(c) */
    function pushChar(dst, expr, line) {
      var body = stmtsOf(function () {
        writeIndexed(dst, V(lenOf(dst)), expr, line);
        addCell(lenOf(dst), N(1), line);
        return null;
      });
      iff(CMP('<', V(lenOf(dst)), N(CAP)), body, null, line, '追加一个字符');
    }

    /* t = a + b */
    function buildConcat(dst, e, line) {
      /* 先把左右操作数物化，再清空目标 —— 否则 s = s + "x" 会把源清掉 */
      var L = null, R = null, t;
      if (isStrExprOf(e.a)) L = matStr(e.a, line);
      if (isStrExprOf(e.b)) R = matStr(e.b, line);
      if (L === dst) { t = tmp(); copyString(t, dst, line); L = t; }
      if (R === dst) { t = tmp(); copyString(t, dst, line); R = t; }
      setCell(lenOf(dst), N(0), line, '拼接：清空目标');
      if (L) appendStr(dst, L, line); else pushChar(dst, numExprOf(e.a, line), line);
      if (R) appendStr(dst, R, line); else pushChar(dst, numExprOf(e.b, line), line);
    }

    /* string(n, ch)：把 ch 重复 n 次。n 不是编译期常量时走这条运行期循环。 */
    function buildRep(dst, e, line) {
      var i = tmp(), cnt = tmp();
      setCell(cnt, numExprOf(e.n, line), line, 'string(n, ch)：重复次数');
      setCell(lenOf(dst), N(0), line, 'string(n, ch)：先清空');
      setCell(i, N(0), line, 'string(n, ch)：计数 = 0');
      var body = stmtsOf(function () {
        pushChar(dst, numExprOf(e.ch, line), line);
      });
      body.push({ type: 'add', name: i, expr: N(1), line: line,
                  text: 'string(n, ch)：计数 +1' });
      whiles(CMP('<', V(i), V(cnt)), body, line, 'string(n, ch) 循环');
    }

    /* t = s.substr(pos[, n]) */
    function buildSubstr(dst, e, line) {
      var src = e.base;
      var pv = tmp();
      setCell(pv, numExprOf(e.pos, line), line, '子串起点');
      setCell(lenOf(dst), N(0), line, '子串先清空');
      var body = stmtsOf(function () {
        var j = tmp(), cnt = tmp(), lim = tmp();
        setCell(j, N(0), line);
        setCell(lim, BIN('-', V(lenOf(src)), V(pv)), line, '最多还能取多少字节');
        if (e.len) {
          setCell(cnt, numExprOf(e.len, line), line, '请求的子串长度');
          iff(CMP('>', V(cnt), V(lim)),
              [{ type: 'set', name: cnt, expr: V(lim), line: line, text: '截到剩余长度' }],
              null, line, '请求长度超过剩余部分');
        } else {
          setCell(cnt, V(lim), line, '取到末尾');
        }
        var loop = stmtsOf(function () {
          var r = readIndexed(src, BIN('+', V(pv), V(j)), line);
          writeIndexed(dst, V(lenOf(dst)), V(r), line);
          addCell(lenOf(dst), N(1), line);
          addCell(j, N(1), line);
          return null;
        });
        whiles(AND(CMP('<', V(j), V(cnt)), CMP('<', V(lenOf(dst)), N(CAP))),
               loop, line, '逐字节复制子串');
        return null;
      });
      iff(CMP('<', V(pv), V(lenOf(src))), body, null, line, '起点越界则空串');
    }

    /* t = to_string(v)，v 是 0..255 的 8 位整数 */
    function buildToStr(dst, e, line) {
      var v = tmp(), hi = tmp(), rest = tmp(), tens = tmp(), ones = tmp();
      setCell(v, numExprOf(e.a, line), line, '待转数字');
      setCell(hi, DIV(V(v), N(100)), line, '百位');
      setCell(rest, MOD(V(v), N(100)), line);
      setCell(tens, DIV(V(rest), N(10)), line, '十位');
      setCell(ones, MOD(V(v), N(10)), line, '个位');
      iff(CMP('>=', V(v), N(100)), stmtsOf(function () {
        setCell(chOf(dst, 0), BIN('+', V(hi), N(48)), line);
        setCell(chOf(dst, 1), BIN('+', V(tens), N(48)), line);
        setCell(chOf(dst, 2), BIN('+', V(ones), N(48)), line);
        setCell(lenOf(dst), N(3), line);
      }), stmtsOf(function () {
        iff(CMP('>=', V(v), N(10)), stmtsOf(function () {
          setCell(chOf(dst, 0), BIN('+', V(tens), N(48)), line);
          setCell(chOf(dst, 1), BIN('+', V(ones), N(48)), line);
          setCell(lenOf(dst), N(2), line);
        }), stmtsOf(function () {
          setCell(chOf(dst, 0), BIN('+', V(v), N(48)), line);
          setCell(lenOf(dst), N(1), line);
        }), line, '一位数');
      }), line, '转十进制字符串');
    }

    /* stoi(s)：8 位累加，溢出按 256 回绕 */
    function buildStoi(e, line) {
      var src = matStr(e.a, line);
      var n = tmp(), i = tmp(), done = tmp(), neg = tmp();
      setCell(n, N(0), line);
      setCell(i, N(0), line);
      setCell(done, N(0), line);
      setCell(neg, N(0), line);
      iff(AND(CMP('>', V(lenOf(src)), N(0)), CMP('==', V(chOf(src, 0)), N(45))),
          [{ type: 'set', name: neg, expr: N(1), line: line },
           { type: 'set', name: i, expr: N(1), line: line }],
          null, line, '跳过负号');
      var body = stmtsOf(function () {
        var ch = readIndexed(src, V(i), line);
        iff(AND(CMP('>=', V(ch), N(48)), CMP('<=', V(ch), N(57))),
            stmtsOf(function () {
              setCell(n, BIN('+', MUL(V(n), N(10)), BIN('-', V(ch), N(48))), line, 'n = n*10 + d');
              addCell(i, N(1), line);
              return null;
            }),
            [{ type: 'set', name: done, expr: N(1), line: line }],
            line, '非数字则停止');
        return null;
      });
      whiles(AND(CMP('<', V(i), V(lenOf(src))), NOT(V(done))), body, line, '逐字符转数字');
      iff(V(neg), stmtsOf(function () {
        var t = tmp();
        setCell(t, BIN('-', N(0), V(n)), line, '取负');
        setCell(n, V(t), line);
        return null;
      }), null, line, '负数取补');
      return n;
    }

    /* find(c) → 下标；找不到返回 255（npos 的 8 位近似） */
    function findChar(name, chExpr, line) {
      var ch = tmp(), i = tmp(), r = tmp();
      setCell(ch, chExpr, line);
      setCell(i, N(0), line);
      setCell(r, N(255), line, '默认 255 = 未找到');
      var body = stmtsOf(function () {
        var c = readIndexed(name, V(i), line);
        iff(AND(CMP('==', V(r), N(255)), CMP('==', V(c), V(ch))),
            [{ type: 'set', name: r, expr: V(i), line: line, text: '记下命中下标' }],
            null, line, '第一次命中才记录');
        addCell(i, N(1), line);
        return null;
      });
      whiles(CMP('<', V(i), V(lenOf(name))), body, line, '逐字节查找');
      return r;
    }

    /* ---------------- 比较 ---------------- */
    function cmpString(a, b, op, line) {
      var A = matStr(a, line), B = matStr(b, line);
      var eq = tmp(), lt = tmp(), i, cond, branch;
      setCell(eq, N(1), line, '相等标志');
      setCell(lt, N(0), line, '小于标志');

      if (op === '==' || op === '!=') {
        for (i = 0; i < CAP; i++) {
          cond = AND(AND(V(eq), CMP('>', V(lenOf(A)), N(i))), CMP('>', V(lenOf(B)), N(i)));
          iff(cond, [{
            type: 'if', cond: CMP('!=', V(chOf(A, i)), V(chOf(B, i))),
            then: [{ type: 'set', name: eq, expr: N(0), line: line }],
            else: null, line: line, text: '第 ' + i + ' 字节不同'
          }], null, line, '比较第 ' + i + ' 字节');
        }
        var same = tmp();
        setCell(same, AND(V(eq), CMP('==', V(lenOf(A)), V(lenOf(B)))),
                line, '长度相同且每字节相同');
        return op === '==' ? V(same) : boolCell(NOT(V(same)), line);
      }

      for (i = 0; i < CAP; i++) {
        cond = AND(AND(V(eq), CMP('>', V(lenOf(A)), N(i))), CMP('>', V(lenOf(B)), N(i)));
        branch = [{
          type: 'if', cond: CMP('<', V(chOf(A, i)), V(chOf(B, i))),
          then: [{ type: 'set', name: lt, expr: N(1), line: line },
                 { type: 'set', name: eq, expr: N(0), line: line }],
          else: [{
            type: 'if', cond: CMP('>', V(chOf(A, i)), V(chOf(B, i))),
            then: [{ type: 'set', name: eq, expr: N(0), line: line }],
            else: null, line: line, text: 'A 的这一字节更大'
          }],
          line: line, text: 'A 的这一字节更小'
        }];
        iff(cond, branch, null, line, '比较第 ' + i + ' 字节');
      }
      iff(V(eq), [{ type: 'set', name: lt,
                    expr: CMP('<', V(lenOf(A)), V(lenOf(B))), line: line,
                    text: '前缀相同则短的更小' }], null, line, '前缀相同');
      var equal = tmp();
      setCell(equal, AND(V(eq), CMP('==', V(lenOf(A)), V(lenOf(B)))), line, '完全相等');
      switch (op) {
        case '<': return V(lt);
        case '>': return boolCell(NOT(OR(V(lt), V(equal))), line);
        case '<=': return boolCell(OR(V(lt), V(equal)), line);
        case '>=': return boolCell(NOT(V(lt)), line);
        default: return V(equal);
      }
    }

    /* 布尔表达式先落进一个临时格：codegen 的算术通路不认 and / or / not，
       只有「赋给变量」和「if / while 的条件」这两条路支持它们。 */
    function boolCell(expr, line) {
      var r = tmp();
      setCell(r, expr, line, '比较结果');
      return V(r);
    }

    /* ---------------- 输入 ---------------- */
    function readString(name, mode, line) {
      var c = tmp();
      setCell(lenOf(name), N(0), line, '读入前先清空');

      if (mode === 'line') {
        push({ type: 'in', name: c, line: line, text: '整行读取：读首字符' });
        var lineBody = stmtsOf(function () {
          var put = stmtsOf(function () {
            writeIndexed(name, V(lenOf(name)), V(c), line);
            addCell(lenOf(name), N(1), line);
            return null;
          });
          iff(CMP('<', V(lenOf(name)), N(CAP)), put, null, line, '容量未满才存入');
          push({ type: 'in', name: c, line: line, text: '读下一个字符' });
          return null;
        });
        whiles(AND(NOT(CMP('==', V(c), N(0))), NOT(CMP('==', V(c), N(10)))),
               lineBody, line, '读到换行为止（换行本身被吃掉，与 getline 一致）');
        return;
      }

      push({ type: 'in', name: c, line: line, text: '按词读取：读首字符' });
      whiles(AND(NOT(CMP('==', V(c), N(0))), CMP('<=', V(c), N(32))),
             [{ type: 'in', name: c, line: line, text: '跳过前导空白' }],
             line, '跳过前导空白');
      var body = stmtsOf(function () {
        var put = stmtsOf(function () {
          writeIndexed(name, V(lenOf(name)), V(c), line);
          addCell(lenOf(name), N(1), line);
          return null;
        });
        iff(CMP('<', V(lenOf(name)), N(CAP)), put, null, line, '容量未满才存入');
        push({ type: 'in', name: c, line: line, text: '读下一个字符' });
        return null;
      });
      whiles(CMP('>', V(c), N(32)), body, line, '读到空白为止');
      /* 空白没有被消费掉的话，后面的 scanf("%c") / getchar() 会少读一个字符 */
      push({ type: 'pushback', expr: V(c), line: line, text: '把分隔符回推输入流' });
    }

    /* ---------------- 表达式降级 ---------------- */
    function exprOf(e, line) {
      if (!e) return e;
      line = line || lineOf(e);
      var t;
      switch (e.k) {
        case 'slen':
          return V(lenOf(e.base || matStr(e.a, line)));
        case 'sempty':
          return boolCell(CMP('==', V(lenOf(e.base || matStr(e.a, line))), N(0)), line);
        case 'sidx':
          return V(readIndexed(e.base, numExprOf(e.idx, line), line));
        case 'sfind':
          return V(findChar(e.base, numExprOf(e.ch, line), line));
        case 'stoi':
          return V(buildStoi(e, line));
        case 'scmp':
          return cmpString(e.a, e.b, e.op, line);
        case 'strlit': case 'scat': case 'ssub': case 'to_str': case 'srep':
          t = matStr(e, line);
          warn('std::string 被用在需要数字的地方，已按 0 处理（请用 length() / [i] / to_string）', line);
          return N(0);
        case 'bin':
          return { k: 'bin', op: e.op, a: numExprOf(e.a, line),
                   b: numExprOf(e.b, line), line: line };
        case 'mul': case 'div': case 'mod':
          return { k: e.k, a: numExprOf(e.a, line), b: numExprOf(e.b, line), line: line };
        case 'cmp':
          return { k: 'cmp', op: e.op, a: numExprOf(e.a, line),
                   b: numExprOf(e.b, line), line: line };
        case 'and': case 'or':
          return { k: e.k, a: condOf(e.a, line), b: condOf(e.b, line), line: line };
        case 'not':
          return NOT(condOf(e.a, line));
        default:
          return e;
      }
    }

    function numExprOf(e, line) {
      if (isStrExprOf(e)) {
        warn('std::string 只能整体使用（赋值 / 输出 / 拼接 / 比较），这里按 0 处理', line);
        return N(0);
      }
      return exprOf(e, line);
    }

    function condOf(e, line) {
      if (!e) return N(0);
      line = line || lineOf(e);
      if (e.k === 'scmp') return cmpString(e.a, e.b, e.op, line);
      if (e.k === 'sempty') return CMP('==', V(lenOf(e.base || matStr(e.a, line))), N(0));
      if (e.k === 'slen') return V(lenOf(e.base || matStr(e.a, line)));
      if (e.k === 'sidx' || e.k === 'stoi' || e.k === 'sfind') return exprOf(e, line);
      if (e.k === 'and') return AND(condOf(e.a, line), condOf(e.b, line));
      if (e.k === 'or') return OR(condOf(e.a, line), condOf(e.b, line));
      if (e.k === 'not') return NOT(condOf(e.a, line));
      if (isStrExprOf(e)) {
        warn('std::string 不能直接当条件用（请用 s.empty() 或 s.length()）', line);
        return N(0);
      }
      return exprOf(e, line);
    }

    /* 条件里有没有需要先算成语句的字符串子表达式 */
    function needsStmts(e) {
      if (!e) return false;
      if (e.k === 'scmp' || e.k === 'sidx' || e.k === 'sempty' ||
          e.k === 'stoi' || e.k === 'sfind') return true;
      if (e.k === 'slen' || e.k === 'sempty') return !!e.a;
      if (e.k === 'and' || e.k === 'or' || e.k === 'cmp' ||
          e.k === 'bin' || e.k === 'mul' || e.k === 'div' || e.k === 'mod') {
        return needsStmts(e.a) || needsStmts(e.b);
      }
      if (e.k === 'not') return needsStmts(e.a);
      return false;
    }

    function condStmts(cond, target, line) {
      return stmtsOf(function () {
        setCell(target, condOf(cond, line), line, '重新计算循环条件');
        return null;
      });
    }

    /* ---------------- 语句降级 ---------------- */
    function lowerList(list, loopCtx) {
      var out = [];
      (list || []).forEach(function (n) {
        if (!n) return;
        var line = n.line || 1, i, r;

        switch (n.type) {
          case 'decl':
            if (n.kind !== 'str') {
              r = capture(function () { return numExprOf(n.init, line); });
              out.push.apply(out, r.stmts);
              out.push({ type: 'decl', name: n.name, init: r.value, kind: n.kind,
                         line: line, text: n.text });
              return;
            }
            /* 每个字节都落成 decl：函数内联时才会把它们当局部变量按调用点改名 */
            for (i = 0; i < CAP; i++) {
              out.push({ type: 'decl', name: chOf(n.name, i), init: N(0), kind: 'int',
                         line: line, text: 'std::string ' + n.name + ' 第 ' + i + ' 字节' });
            }
            out.push({ type: 'decl', name: lenOf(n.name), init: N(0), kind: 'int',
                       line: line, text: 'std::string ' + n.name + ' 的长度' });
            if (n.init) {
              out.push.apply(out, stmtsOf(function () {
                assignString(n.name, n.init, line);
                return null;
              }));
            }
            return;

          case 'set': case 'add': case 'sub':
            if (isStrName(n.name)) {
              if (n.type === 'set') {
                out.push.apply(out, stmtsOf(function () {
                  assignString(n.name, n.expr, line); return null;
                }));
              } else {
                out.push.apply(out, stmtsOf(function () {
                  appendOperand(n.name, n.expr, line); return null;
                }));
              }
              return;
            }
            r = capture(function () { return numExprOf(n.expr, line); });
            out.push.apply(out, r.stmts);
            out.push({ type: n.type, name: n.name, expr: r.value, line: line, text: n.text });
            return;

          case 'sset':
            out.push.apply(out, stmtsOf(function () {
              assignString(n.name, n.expr, line); return null;
            }));
            return;

          case 'sapp':
            out.push.apply(out, stmtsOf(function () {
              appendOperand(n.name, n.expr, line); return null;
            }));
            return;

          case 'out':
          case 'outdec':
            if (isStrExprOf(n.expr)) {
              out.push.apply(out, stmtsOf(function () {
                if (n.expr.k === 'strlit') push({ type: 'outstr', text: n.expr.text, line: line });
                else outChars(matStr(n.expr, line), line);
                return null;
              }));
              return;
            }
            r = capture(function () { return exprOf(n.expr, line); });
            out.push.apply(out, r.stmts);
            out.push({ type: n.type, expr: r.value, line: line, text: n.text });
            return;

          case 'sout':
            out.push.apply(out, stmtsOf(function () {
              if (n.expr && n.expr.k === 'strlit') {
                push({ type: 'outstr', text: n.expr.text, line: line });
              } else {
                outChars(matStr(n.expr, line), line);
              }
              return null;
            }));
            return;

          case 'sin':
            out.push.apply(out, stmtsOf(function () {
              readString(n.name, n.mode, line); return null;
            }));
            return;

          case 'sclear':
            out.push({ type: 'set', name: lenOf(n.name), expr: N(0), line: line,
                       text: 'clear()：长度清零' });
            return;

          case 'spop':
            out.push.apply(out, stmtsOf(function () {
              iff(CMP('>', V(lenOf(n.name)), N(0)),
                  [{ type: 'sub', name: lenOf(n.name), expr: N(1), line: line,
                     text: 'pop_back()：长度 -1' }],
                  null, line, '非空才弹出');
              return null;
            }));
            return;

          case 'spush':
            r = capture(function () { return numExprOf(n.expr, line); });
            out.push.apply(out, r.stmts);
            out.push.apply(out, stmtsOf(function () {
              pushChar(n.name, r.value, line); return null;
            }));
            return;

          case 'sidxset':
            r = capture(function () {
              return { idx: numExprOf(n.idx, line), val: numExprOf(n.expr, line) };
            });
            out.push.apply(out, r.stmts);
            out.push.apply(out, stmtsOf(function () {
              writeIndexed(n.name, r.value.idx, r.value.val, line); return null;
            }));
            return;

          case 'if':
            r = capture(function () { return condOf(n.cond, line); });
            out.push.apply(out, r.stmts);
            out.push({ type: 'if', cond: r.value,
                       then: lowerList(n.then, loopCtx),
                       else: n.else ? lowerList(n.else, loopCtx) : null,
                       line: line, text: n.text });
            return;

          case 'while':
            if (!needsStmts(n.cond)) {
              r = capture(function () { return condOf(n.cond, line); });
              out.push.apply(out, r.stmts);
              out.push({ type: 'while', cond: r.value,
                         body: lowerList(n.body, loopCtx), line: line, text: n.text });
              return;
            }
            /* 条件里有字符串比较 / 下标：先算进单元格，循环体末尾再重算，
               continue 之前也要重算，否则会用上一轮的结果。 */
            var ct = tmp();
            out.push.apply(out, condStmts(n.cond, ct, line));
            var ctx = { cond: n.cond, target: ct, line: line };
            var body2 = lowerList(n.body, ctx).concat(condStmts(n.cond, ct, line));
            out.push({ type: 'while', cond: V(ct), body: body2, line: line, text: n.text });
            return;

          case 'cont':
            if (loopCtx) out.push.apply(out, condStmts(loopCtx.cond, loopCtx.target, loopCtx.line));
            out.push(n);
            return;

          default:
            out.push(n);          /* outstr / brk / ret / stepmark / call … */
            return;
        }
      });
      return out;
    }

    return { ir: lowerList(nodes, null), seq: seq };
  }

  TC.Str = { lower: lower, CAP: CAP, utf8Bytes: utf8Bytes };
})(window.TC = window.TC || {});
