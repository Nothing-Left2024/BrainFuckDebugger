/* =========================================================================
 * tc/parser-c.js —— C / C++ 子集 → 中间表示(IR)
 *
 * 支持：
 *   变量声明      char a = 5;  uint64_t s;  auto x = 0;  （记类型：char / int）
 *   赋值运算      = += -= *= /= %= &= |= ^= <<= >>= 以及 ++/--
 *   表达式        数字(含 0x / ULL 后缀) / 字符 / 变量 / + - * / % / 位运算 / 三元 ?:
 *   位运算        & | ^ ~ << >>  —— 常量位移直接转成乘除 IR，其余转内部函数调用
 *   强制转换      (int)e / static_cast<T>(e) / reinterpret_cast / const_cast（8 位下按无操作）
 *   函数定义      char f(char x) { ... return expr; }   —— 支持多参数、返回值、void
 *   函数调用      char r = f(1, 2);  f(3);  putchar(f(4));  ← 表达式里也能用
 *   输出          putchar(e) / putc(e) / printf("%c%d…") / cout << … / printnum(e)
 *   输入          c = getchar();  scanf("%d")  cin >> / if (!(cin >> x)) 流状态降级
 *   标准库        #include <...> 由 tc/stdlib.js 预处理；rand/srand/abs/min/max/
 *                 isdigit/toupper/gcd/sqrt/pow… 走 prelude + 内联展开
 *   预处理        #define NAME 值（常量宏）、true/false/NULL/RAND_MAX 等内置常量
 *   命名空间      std::cout / std::cin / std::time() / std::abs() …
 *   分支          if (cond) {} else if {} else {}
 *   循环          while / for(三段式) / do-while / while(true) + break
 *   循环控制      break;  continue;        —— 在 tc/loops.js 里改写成标志位 + 守卫
 *   提前返回      return expr;（函数体内，顶层语句间可用）
 *   C++ 类        class/struct 降级：成员→全局变量、方法→普通函数、构造→初始化语句
 *
 * 说明：BrainFuck 没有调用栈，函数按"调用点内联展开"实现 —— 形参与局部变量
 * 会自动重命名成独立的单元格，因此同名函数调用多次互不干扰；递归按层展开。
 * 单元格是 8 位：64 位整数、系统时钟、C++ 流状态等没有等价物，统一明确降级并告警。
 * ========================================================================= */
(function (TC) {
  'use strict';

  var MODS = { const: 1, static: 1, inline: 1, extern: 1, volatile: 1, register: 1,
               constexpr: 1, consteval: 1, constinit: 1, mutable: 1,
               friend: 1, virtual: 1, explicit: 1, thread_local: 1 };
  var TYPE_KW = ['char', 'int', 'short', 'long', 'unsigned', 'signed',
                 'uint8_t', 'int8_t', 'uint16_t', 'int16_t',
                 'int32', 'uint32_t', 'int32_t', 'uint64_t', 'int64_t',
                 'size_t', 'ssize_t', 'ptrdiff_t', 'intptr_t', 'uintptr_t',
                 'streamsize', 'wchar_t', 'char16_t', 'char32_t',
                 'byte', 'bool', 'float', 'double', 'void', 'auto',
                 'string'];

  /* 一字节的字符型；其余整型按"十进制数字"输出 */
  var CHARISH = { char: 1, int8_t: 1, uint8_t: 1, byte: 1, bool: 1 };
  /* 32 位有符号整数：用 4 个小端单元格表示，由 tc/i32.js 在 IR 层展开 */
  var I32ISH = { int32: 1, int32_t: 1, uint32_t: 1, long: 1,
                 intptr_t: 1, uintptr_t: 1, ssize_t: 1 };
  /* 64 位整型：BrainFuck 里连 32 位都是软件模拟，64 位再展开会让
     一份 xorshift 之类的小程序膨胀上百倍（实测 11.5 万 → 1228 万条指令）。
     这里明确按 8 位降级并告警，和「无 64 位整数」的文档一致。 */
  var I64ISH = { int64_t: 1, uint64_t: 1, longlong: 1 };
  var i64Seen = false;
  var intAsI32 = false;      /* 页面开关：让普通的 int 也按 int32 处理 */

  /* C++ 命名转换：8 位单元格里没有宽度概念，统一当作无操作 */
  var CAST_KW = { static_cast: 1, reinterpret_cast: 1, const_cast: 1, dynamic_cast: 1 };

  /* 位运算常量折叠表（全部按 8 位无符号） */
  var BITVAL = {
    __bf_not: function (a) { return (~a) & 255; },
    __bf_and: function (a, b) { return a & b; },
    __bf_xor: function (a, b) { return a ^ b; },
    __bf_or:  function (a, b) { return a | b; },
    __bf_shl: function (a, b) { return (a << b) & 255; },
    __bf_shr: function (a, b) { return a >>> b; }
  };

  /* C++ 流方法：BF 的输入是纯字节队列，没有这些状态 / 缓冲操作 */
  var FLOW_METHODS = { clear: 1, ignore: 1, sync: 1, putback: 1, unget: 1,
                       eof: 1, fail: 1, bad: 1, good: 1, rdstate: 1,
                       setstate: 1, exceptions: 1 };

  /* 认识但无法在 BF 里实现的库函数：跳过并给出提示。
     有真实实现的函数（rand/srand/abs/min/…）不在表里，见 tc/stdlib.js。 */
  var IGNORABLE = {
    scanf: 1, cin: 1, cout: 1, endl: 1,
    memset: 1, memcpy: 1, strlen: 1, strcpy: 1, strncpy: 1, strcmp: 1, strcat: 1,
    malloc: 1, calloc: 1, realloc: 1, free: 1, exit: 1, abort: 1, qsort: 1,
    assert: 1, fflush: 1, system: 1, sprintf: 1, fprintf: 1, fputs: 1,
    fopen: 1, fclose: 1, fread: 1, fwrite: 1, fgetc: 1, fputc: 1,
    srand48: 1, drand48: 1, clock: 1, sleep: 1, usleep: 1
  };

  function isTypeKw(v) { return TYPE_KW.indexOf(v) >= 0; }
  function isMod(v) { return !!MODS[v]; }

  /* 把一串类型词归类成 char / int / void */
  function kindOf(toks) {
    var t = [], i;
    for (i = 0; i < toks.length; i++) if (!MODS[toks[i]]) t.push(toks[i]);
    for (i = 0; i < t.length; i++) if (t[i] === 'void') return 'void';
    /* std::string：定长字节缓冲，由 tc/str.js 在 IR 层展开 */
    for (i = 0; i < t.length; i++) if (t[i] === 'string') return 'str';
    /* float / double：定点数（放大 1000 倍的 int32），由下面的 toFloat 展开 */
    for (i = 0; i < t.length; i++) if (t[i] === 'float' || t[i] === 'double') return 'f32';
    for (i = 0; i < t.length; i++) if (CHARISH[t[i]]) return 'char';
    for (i = 0; i < t.length; i++) if (I64ISH[t[i]]) { i64Seen = true; return 'int'; }
    for (i = 0; i < t.length; i++) if (I32ISH[t[i]]) return 'i32';
    if (intAsI32) return 'i32';
    return 'int';
  }

  function ParseError(msg, line) {
    this.message = msg;
    this.line = line;
  }

  function parse(src, opts) {
    intAsI32 = !!(opts && opts.int32);
    var toks = TC.Lexer.lex(src);
    var p = 0;
    var warnings = [];

    var funcs = {};        /* 函数表：name -> {name, params, kind, body, retName, line} */
    var varType = {};      /* 变量名 -> 'char' | 'int' */
    var pending = [];      /* 表达式里遇到的函数调用，先落成语句，再由外层语句收编 */
    var tmpSeq = 0;
    var curFn = null;      /* 当前正在解析的函数（main 记为 entry） */
    var loopDepth = 0;     /* 当前处在几层循环里，用来校验 break / continue 是否合法 */
    var bitFns = {};       /* 用到的位运算内部函数，编译入口据此补 prelude */
    var classes = {};      /* 类名 -> { fields, ctor }，C++ 类降级用 */
    /* 纯字段 struct：每个字段摊成一条「虚拟数组」，复用数组的选择树机制。
       HistoryEntry history[50] → history.op[0..49] / history.a[0..49] / …
       于是 history[i].op 与 a[i] 走的是同一套代码。 */
    var switchLoop = [];   /* 进入每层 switch 时的 loopDepth：区分 break 跳 switch 还是跳循环 */
    var switchGo = [];     /* 每层 switch 的「继续执行标志」变量名 */
    var structs = {};      /* 类型名 -> { fields: [{name, kind}] } */
    var structVars = {};   /* 变量名 -> { type, dims, total, fields, arrays } */
    var arrays = {};       /* 数组名 -> { name, dims, kind, total, isConst } */
    var constVals = {};    /* const 标量 -> 编译期常量值（数组长度会用到） */
    /* C++ 引用（int&）：BrainFuck 没有指针，但「引用 = 别名」正好可以直接做——
       编译期把别名替换成目标变量名，一条指令都不用生成。
         aliases[r] = { target: 'x' }           纯别名（变量 / 常量下标的数组元素）
         aliases[r] = { arr: 'a', idxs: [...] }  绑定到动态下标的数组元素：
                                                下标在绑定时求值一次并记下来 */
    var aliases = {};
    var pointers = {};      /* 指针名 -> { name, arr, idxs, cur, kind, param, null } */
    var addrIds = {};       /* 目标名 -> 编译期地址编号（让 if(p) / p==q 可静态判定） */
    var nextAddrId = 1;
    var noShift = 0;       /* >0 时禁用 << >> 位移层（cout / cin 上下文） */
    var warnedBig = false; /* 64 位常量截断只提醒一次，别刷屏 */
    i64Seen = false;       /* 每次解析重置，避免上一次的告警串到下一次 */

    /* 标准库函数先登记签名占位：解析阶段查函数表才不会报「未定义」。
       builtin 标记让编译入口随后能用 prelude 的真实函数体覆盖它。 */
    if (opts && opts.knownFuncs) {
      Object.keys(opts.knownFuncs).forEach(function (name) {
        var sig = opts.knownFuncs[name];
        var ps = [];
        for (var i = 0; i < sig.arity; i++) {
          ps.push({ name: '__p' + i, kind: 'char',
                    ref: !!(sig.refs && sig.refs[i]) });
        }
        funcs[name] = {
          name: name, params: ps, kind: sig.ret, body: null,
          retName: '__ret_' + name, line: 0, builtin: true, outKind: sig.out
        };
      });
    }

    function peek(k) { return toks[Math.min(p + (k || 0), toks.length - 1)]; }
    function next() { return toks[p++]; }
    function eof() { return peek().t === 'eof'; }
    function is(v) { return peek().v === v && peek().t !== 'str'; }
    function accept(v) { if (is(v)) { next(); return true; } return false; }

    function expect(v) {
      if (!is(v)) throw new ParseError('这里期望 “' + v + '”，实际是 “' + (peek().v || '结束') + '”', peek().line);
      return next();
    }
    function expectId() {
      if (peek().t !== 'id') throw new ParseError('这里期望一个变量名', peek().line);
      return next().v;
    }
    function warn(msg, line) { warnings.push({ message: msg, line: line || peek().line }); }
    function lineNow() { return peek().line; }

    function skipTo(semi) {
      var guard = 0;
      while (!eof() && !is(semi) && guard++ < 5000) next();
      if (is(semi)) next();
    }

    function toArray(x) {
      if (!x) return [];
      return Array.isArray(x) ? x : [x];
    }

    /* ---------------- 引用别名 ----------------
     * 本编译器把函数按调用点内联，所以「引用」不需要真地址：
     *   · 局部引用 int& r = x  → 之后所有 r 直接写成 x
     *   · 引用形参 void f(int& v) → 内联时把形参映射到实参的名字（见 tc/inline.js）
     * 指向动态下标数组元素（int& r = a[i]）时，把下标值在绑定时快照下来，
     * 之后每次访问都用这组快照值重新走数组选择树。 */
    function resolveAlias(name) {
      var guard = 0;
      while (aliases[name] && aliases[name].target && guard++ < 32) {
        name = aliases[name].target;
      }
      return name;
    }
    function V(name, line) { return { k: 'var', name: resolveAlias(name), line: line }; }
    function aliasArr(name) {
      var a = aliases[name];
      return a && a.arr ? a : null;
    }

    /* ================= 数组支持 =================
     * BrainFuck 的内存只有「一排单元格」，没有指针算术。数组因此按最朴素、
     * 也最可靠的方式实现：**编译期把每个元素摊成一个独立变量**。
     *   int a[4]        →  a[0] a[1] a[2] a[3]      （各 1 格）
     *   int32_t v[2]    →  v[0].0..3  v[1].0..3     （各 4 格，交给 I32 降级）
     *   double d[3]     →  同 int32（定点数）
     *   int m[2][3]     →  m[0][0] … m[1][2]        （二维展平）
     *
     * 下标是常量时 → 直接命中那个变量，一条搬运都不多。
     * 下标是变量时 → 生成一棵「逐维比较」的选择树：
     *      if (i == 0) { … } if (i == 1) { … } …
     * 代价 O(元素数)，但语义精确；常量下标（for 里 a[0]、a[k] 之类）零开销。
     * 不支持的东西会明确告警：变长数组、数组当函数参数、对数组名赋值。
     * ============================================ */

    function product(arr, from) {
      var p = 1;
      for (var i = from || 0; i < arr.length; i++) p *= arr[i];
      return p;
    }

    /* 常量求值：字面量 / const 变量 / 常量四则运算，求不出来返回 null */
    function constOf(e) {
      if (!e) return null;
      /* 必须优先用 raw / i32v：num 节点的 v 只有低 8 位，用 v 会让 300 变成 44，
         数组长度、const 常量都会跟着错 */
      if (e.k === 'num') return e.i32v != null ? e.i32v : (e.raw != null ? e.raw : e.v);
      if (e.k === 'var') {
        return constVals[e.name] != null ? constVals[e.name] : null;
      }
      if (e.k === 'bin' || e.k === 'mul' || e.k === 'div' || e.k === 'mod') {
        var a = constOf(e.a), b = constOf(e.b);
        if (a == null || b == null) return null;
        if (e.k === 'mul') return a * b;
        if (e.k === 'div') return b === 0 ? null : (a / b) | 0;
        if (e.k === 'mod') return b === 0 ? null : a % b;
        return e.op === '+' ? a + b : a - b;
      }
      if (e.k === 'not') {
        var nv = constOf(e.a);
        return nv == null ? null : (nv ? 0 : 1);
      }
      return null;
    }

    /* 一维线性下标 → 多维下标：12 在 [3][4] 里是 [3][0] */
    function unlinear(k, dims) {
      var out = new Array(dims.length);
      for (var i = dims.length - 1; i >= 0; i--) {
        out[i] = k % dims[i];
        k = (k / dims[i]) | 0;
      }
      return out;
    }

    /* 数组元素的变量名：a[0] / m[1][2]，直接用源码写法，调试器里一眼能认 */
    function elemName(name, idxs) {
      var s = name;
      for (var i = 0; i < idxs.length; i++) s += '[' + idxs[i] + ']';
      return s;
    }

    /* 类型的字节数（sizeof 用）。std::string 是 32 字节缓冲 + 长度格 */
    function cellSize(kind) {
      if (kind === 'i32' || kind === 'f32') return 4;
      if (kind === 'str') return 34;
      return 1;
    }

    function numNode(v) {
      return { k: 'num', v: v & 255, i32v: v, raw: v };
    }

    /* 解析 a[i][j] 的下标链 */
    function parseIdxs() {
      var idxs = [];
      while (is('[')) {
        next();
        idxs.push(parseExpr());
        expect(']');
      }
      return idxs;
    }

    /* 检查维度个数与越界；越界按 0 处理并告警 */
    function checkIdx(name, ar, idxs, line) {
      if (idxs.length !== ar.dims.length) {
        throw new ParseError('数组 ' + name + ' 是 ' + ar.dims.length + ' 维的，这里却给了 ' +
                             idxs.length + ' 个下标' + (idxs.length < ar.dims.length
                             ? '（不支持把一行/一段当作指针传递）' : ''), line);
      }
    }

    /* 把下标拆成「常量 / 运行期」两部分。
       运行期的下标先复制到临时变量里，避免选择树里把同一个表达式重算 N 遍。 */
    function splitIdx(ar, idxs, line, out) {
      var info = { ar: ar, c: [], v: [] };
      for (var i = 0; i < idxs.length; i++) {
        var cv = constOf(idxs[i]);
        if (cv == null) {
          var t = '__ai' + (tmpSeq++);
          varType[t] = 'int';
          out.push({ type: 'decl', name: t, line: line });
          out.push({ type: 'set', name: t, expr: toByte(idxs[i], line), line: line });
          info.c.push(null);
          info.v.push({ k: 'var', name: t, line: line });
        } else {
          if (cv < 0 || cv >= ar.dims[i]) {
            warn('数组 ' + ar.name + ' 的下标 ' + cv + ' 越界（第 ' + (i + 1) + ' 维长度 ' +
                 ar.dims[i] + '），已按 0 处理', line);
            cv = 0;
          }
          info.c.push(cv);
          info.v.push(numNode(cv));
        }
      }
      return info;
    }

    /* 生成「逐维比较」的选择树：叶子处调用 makeStmt(path) 得到一条语句 */
    function emitPath(info, level, path, out, makeStmt, line) {
      var ar = info.ar;
      if (level === ar.dims.length) {
        out.push(makeStmt(path.slice()));
        return;
      }
      var cv = info.c[level];
      if (cv != null) {
        path.push(cv);
        emitPath(info, level + 1, path, out, makeStmt, line);
        path.pop();
        return;
      }
      for (var k = 0; k < ar.dims[level]; k++) {
        var inner = [];
        path.push(k);
        emitPath(info, level + 1, path, inner, makeStmt, line);
        path.pop();
        out.push({
          type: 'if',
          cond: { k: 'cmp', op: '==', a: info.v[level], b: numNode(k), line: line },
          then: inner, else: null, line: line,
          text: '数组 ' + ar.name + ' 第 ' + (level + 1) + ' 维 == ' + k
        });
      }
    }

    /* 运行期读：结果落进临时变量，前导语句追加到 out */
    function arrayReadIR(ar, info, line, out) {
      var res = '__av' + (tmpSeq++);
      varType[res] = ar.kind;
      out.push({ type: 'decl', name: res, kind: ar.kind, line: line,
                 text: '数组 ' + ar.name + ' 的取值' });
      emitPath(info, 0, [], out, function (path) {
        return { type: 'set', name: res,
                 expr: { k: 'var', name: elemName(ar.name, path), line: line },
                 line: line, text: '读 ' + elemName(ar.name, path) };
      }, line);
      return { k: 'var', name: res, line: line };
    }

    /* 表达式位置的 a[i] / m[i][j] */
    function arrayRead(name, line) {
      return arrayReadIdx(name, parseIdxs(), line);
    }

    /* 同上，但下标已经解析好（引用别名 re->a[i] 复用这条路） */
    function arrayReadIdx(name, idxs, line) {
      var ar = arrays[name];
      checkIdx(name, ar, idxs, line);
      var out = [];
      var info = splitIdx(ar, idxs, line, out);
      var allConst = info.c.every(function (x) { return x != null; });
      if (allConst) {
        if (out.length) pending.push.apply(pending, out);
        return { k: 'var', name: elemName(name, info.c), line: line };
      }
      var r = arrayReadIR(ar, info, line, out);
      /* 打上标记：循环条件里的数组读取必须每轮重算，不能只在进循环前算一次 */
      out.forEach(function (n) { if (n) n.__arr = 1; });
      pending.push.apply(pending, out);
      /* 记住「这个临时值来自 a[i]」：如果它被当作引用实参，
         调用结束后要把形参的新值写回那个元素（copy-in / copy-out） */
      r.arrRef = { arr: name, idxs: info.v };
      return r;
    }

    /* 语句位置的 a[i] = v / a[i] += v / a[i]++ …
       mode: 'set' | 'add' | 'sub' | 'inc' | 'dec'，或一个「旧值 → 新值」的函数 */
    function arrayWrite(name, idxs, line, mode, expr) {
      var ar = arrays[name];
      if (!ar) throw new ParseError(name + ' 不是数组，不能用下标赋值', line);
      checkIdx(name, ar, idxs, line);

      var out = [];
      var info = splitIdx(ar, idxs, line, out);
      var allConst = info.c.every(function (x) { return x != null; });

      if (allConst) {
        var en = elemName(name, info.c);
        if (mode === 'inc') return out.concat([{ type: 'add', name: en, expr: { k: 'num', v: 1 }, line: line }]);
        if (mode === 'dec') return out.concat([{ type: 'sub', name: en, expr: { k: 'num', v: 1 }, line: line }]);
        if (mode === 'add') return out.concat([{ type: 'add', name: en, expr: coerceTo(ar.kind, expr, line), line: line }]);
        if (mode === 'sub') return out.concat([{ type: 'sub', name: en, expr: coerceTo(ar.kind, expr, line), line: line }]);
        if (typeof mode === 'function') {
          return out.concat([{ type: 'set', name: en,
                               expr: mode({ k: 'var', name: en, line: line }), line: line }]);
        }
        return out.concat([{ type: 'set', name: en, expr: coerceTo(ar.kind, expr, line), line: line }]);
      }

      /* 运行期下标：先把要写的值算进临时变量，再走选择树 ——
         保证右侧表达式只求值一次（否则每个分支都会重算一遍副作用）。 */
      var tv = '__aw' + (tmpSeq++);
      varType[tv] = ar.kind;
      out.push({ type: 'decl', name: tv, kind: ar.kind, line: line, text: '数组 ' + name + ' 的待写值' });

      var rhs;
      if (mode === 'set') {
        rhs = coerceTo(ar.kind, expr, line);
      } else if (mode === 'add' || mode === 'sub') {
        var oldA = arrayReadIR(ar, info, line, out);
        rhs = { k: 'bin', op: mode === 'add' ? '+' : '-', a: oldA,
                b: coerceTo(ar.kind, expr, line), line: line };
      } else if (mode === 'inc' || mode === 'dec') {
        var oldB = arrayReadIR(ar, info, line, out);
        rhs = { k: 'bin', op: mode === 'inc' ? '+' : '-', a: oldB,
                b: { k: 'num', v: 1 }, line: line };
      } else if (mode && mode.bit) {
        /* 位运算复合赋值：先读旧值，再调用辅助函数（前置语句插进 out） */
        var oldD = arrayReadIR(ar, info, line, out);
        rhs = (mode.op === '<<' || mode.op === '>>')
          ? shiftExpr(mode.op, oldD, mode.rhs, line, out)
          : bitCall(mode.fn, oldD, mode.rhs, line, out);
      } else {
        var oldC = arrayReadIR(ar, info, line, out);
        rhs = mode(oldC);
      }
      out.push({ type: 'set', name: tv, expr: rhs, line: line });

      emitPath(info, 0, [], out, function (path) {
        var en2 = elemName(name, path);
        return { type: 'set', name: en2, expr: { k: 'var', name: tv, line: line },
                 line: line, text: '写 ' + en2 };
      }, line);
      return out;
    }

    /* 引用声明：int& r = x;  int& r = a[i];  const int& r = x;
       BrainFuck 没有地址，引用在编译期就吃掉 —— r 之后直接写成目标的名字，
       一条指令都不生成。指向动态下标数组元素时，下标在绑定时快照一次。 */
    function parseRefDecl(name, kind, line, isConst) {
      if (!accept('=')) {
        throw new ParseError('引用 ' + name + ' 必须在声明时绑定：写成 ' + kind +
                             '& ' + name + ' = 某个变量（或数组元素）；' +
                             'BrainFuck 没有指针，不能不绑定就先声明', line);
      }
      var out = [];

      /* 目标是数组元素：a[0] / m[1][2] / a[i] */
      if (peek().t === 'id' && arrays[peek().v] && peek(1).v === '[') {
        var an = next().v;
        var ar = arrays[an];
        var idxs = parseIdxs();
        checkIdx(an, ar, idxs, line);
        var snap = [];
        var allConst = true;
        for (var ai = 0; ai < idxs.length; ai++) {
          var cv = constOf(idxs[ai]);
          if (cv == null) {
            allConst = false;
            var t = '__rr' + (tmpSeq++);
            varType[t] = 'int';
            out.push({ type: 'decl', name: t, line: line });
            out.push({ type: 'set', name: t, expr: toByte(idxs[ai], line), line: line,
                       text: '引用 ' + name + ' 绑定：快照下标' });
            snap.push({ k: 'var', name: t, line: line });
          } else {
            if (cv < 0 || cv >= ar.dims[ai]) {
              warn('引用 ' + name + ' 的下标 ' + cv + ' 越界，已按 0 处理', line);
              cv = 0;
            }
            snap.push(numNode(cv));
          }
        }
        if (allConst) {
          aliases[name] = {
            target: elemName(an, snap.map(function (x) {
              return x.i32v != null ? x.i32v : x.v;
            }))
          };
        } else {
          aliases[name] = { arr: an, idxs: snap };
        }
        varType[name] = ar.kind;
        if (isConst) aliases[name].readonly = 1;
        return out;
      }

      /* 目标是结构体元素：const H& h = history[i]; */
      if (peek().t === 'id' &&
          (structVars[peek().v] || (aliases[peek().v] && aliases[peek().v].structRef))) {
        var rsr = readStructRef(line);
        var rsnap = snapStructIdxs(rsr.idxs, line, out);
        aliases[name] = { structRef: { sv: rsr.sv, idxs: rsnap },
                          readonly: !!isConst };
        varType[name] = 'int';
        return out.concat(takePending());
      }

      /* 目标是普通变量（也可能是另一个引用） */
      var tgt = parseExpr();
      if (!tgt || tgt.k !== 'var' || String(tgt.name).indexOf('__') === 0) {
        /* const 引用可以绑定临时值（C++ 会延长生命周期）：这里退化成复制一份 */
        if (isConst) {
          warn('const 引用 ' + name + ' 绑定的是临时值，已按普通变量复制一份', line);
          varType[name] = kind;
          return out.concat([{ type: 'decl', name: name, init: coerceTo(kind, tgt, line),
                               kind: kind, line: line }]);
        }
        throw new ParseError('引用 ' + name + ' 只能绑定到变量或数组元素；' +
                             'a + b 这类临时值没有存储位置，没法引用（要复制一份请用 const 引用）', line);
      }
      var tname = resolveAlias(tgt.name);
      aliases[name] = { target: tname };
      varType[name] = varType[tname] || kind;
      if (isConst) aliases[name].readonly = 1;
      return out;
    }

    /* 数组初始化列表：{1, 2, 3} / {{1,2},{3,4}}（内层花括号可省略） */
    function readInit(dims, level, base, flat, line) {
      var n = dims[level];
      var last = (level === dims.length - 1);
      var stride = last ? 1 : product(dims, level + 1);
      for (var k = 0; k < n; k++) {
        if (is('}')) break;
        if (!last && is('{')) {
          next();
          readInit(dims, level + 1, base + k * stride, flat, line);
          expect('}');
        } else if (!last) {
          /* 省略内层花括号：按顺序把这一行读满 */
          readInit(dims, level + 1, base + k * stride, flat, line);
        } else {
          flat[base + k] = parseExpr();
        }
        /* 本层读满了就把逗号留给外层：否则省略花括号的 {1,2,3,4} 会被
           内层一路吃掉，第二行永远填不上 */
        if (k === n - 1) break;
        if (!accept(',')) break;
        if (is('}')) break;
      }
    }

    /* 数组声明：名字后面已经看到 '['，把整条声明展开成每个元素一条 decl */
    function parseArrayDecl(name, kind, line, isConst) {
      if (kind === 'void') throw new ParseError('数组 ' + name + ' 不能是 void 类型', line);
      if (kind === 'str') warn('std::string 数组：每个元素都是独立的 32 字节缓冲，元素多时代码会很长', line);

      var dims = [];
      while (is('[')) {
        next();
        if (accept(']')) { dims.push(null); continue; }     /* 长度待推断 */
        var dv = constOf(parseExpr());
        if (dv == null) {
          throw new ParseError('数组 ' + name + ' 的长度必须是编译期常量（数字、#define 宏或 const 常量）；' +
                               'BrainFuck 没有堆，变长数组无法实现', line);
        }
        if (dv <= 0) throw new ParseError('数组 ' + name + ' 的长度必须大于 0', line);
        if (dv > 256) {
          warn('数组 ' + name + ' 的第 ' + dims.length + ' 维长度是 ' + dv +
               '，每个元素都会摊成独立单元格，生成的 BrainFuck 会非常长', line);
        }
        dims.push(dv);
        expect(']');
      }

      var flat = null;
      if (accept('=')) {
        if (peek().t === 'str') {
          /* char buf[N] = "…"：逐字节填充，末尾补 '\0'（与 C 一致） */
          var s = next().v;
          flat = [];
          for (var qi = 0; qi < s.length; qi++) {
            flat.push({ k: 'num', v: s.charCodeAt(qi) & 255, ch: 1, line: line });
          }
          flat.push({ k: 'num', v: 0, ch: 1, line: line });
          var unk = -1;
          for (var di = 0; di < dims.length; di++) if (dims[di] == null) { unk = di; break; }
          if (unk >= 0) {
            if (dims.length !== 1) {
              throw new ParseError('数组 ' + name + ' 用字符串初始化时只能省略第一维长度', line);
            }
            dims[unk] = Math.max(1, flat.length);
          }
        } else if (is('{')) {
          next();
          /* int a[] = {1,2,3}：一维的长度可以直接数字面量个数 */
          if (dims.length === 1 && dims[0] == null) {
            flat = [];
            for (;;) {
              if (is('}')) break;
              flat.push(parseExpr());
              if (!accept(',')) break;
              if (is('}')) break;
            }
            dims[0] = Math.max(1, flat.length);
          } else {
            for (var dj = 0; dj < dims.length; dj++) {
              if (dims[dj] == null) {
                throw new ParseError('数组 ' + name + ' 用 { … } 初始化时必须写明每一维的长度', line);
              }
            }
            flat = new Array(product(dims));
            readInit(dims, 0, 0, flat, line);
            if (is(',')) {
              warn('数组 ' + name + ' 的初始化项比元素多，多余的已忽略', line);
              while (!eof() && !is('}')) next();
            }
          }
          expect('}');
        } else {
          throw new ParseError('数组 ' + name + ' 的初始化要用 { … } 或字符串字面量', line);
        }
      }

      if (dims.indexOf(null) >= 0) {
        throw new ParseError('数组 ' + name + ' 缺少长度：请写成 ' + name + '[N] 或给出初始化列表', line);
      }

      var total = product(dims);
      if (flat && flat.length > total) {
        warn('数组 ' + name + ' 的初始化项比元素多，多余的已忽略', line);
      }

      arrays[name] = { name: name, dims: dims, kind: kind, total: total, isConst: !!isConst };

      var out = [];
      for (var ei = 0; ei < total; ei++) {
        var en = elemName(name, unlinear(ei, dims));
        varType[en] = kind;
        out.push({ type: 'decl', name: en,
                   init: flat && flat[ei] ? coerceTo(kind, flat[ei], line) : null,
                   kind: kind, line: line, text: '数组元素 ' + en });
      }
      return out;
    }

    /* 语句解析过程中产生的函数调用要先执行，收编到语句前面 */
    function takePending() {
      var q = pending;
      pending = [];
      return q;
    }

    function stmtWithPending() {
      var st = parseStmt();
      var pre = takePending();
      var arr = toArray(st);
      if (!pre.length) return arr;
      return pre.concat(arr);
    }

    /* 吃掉一串类型词（含 const 等修饰、以及 std:: 前缀） */
    function eatType() {
      var t = [];
      for (;;) {
        if (is('std') && peek(1).v === '::' && isTypeKw(peek(2).v)) {
          next(); next();
          t.push(next().v);
          continue;
        }
        if (!eof() && (isTypeKw(peek().v) || isMod(peek().v))) {
          t.push(next().v);
          continue;
        }
        break;
      }
      return t;
    }

    /* ---------------- 表达式 ----------------
     * 优先级（低→高）：?:  |  ^  &  << >>  + -  * / %  一元 + - ! ~ & *
     * 条件表达式另有 parseCondExpr 那条链（|| && 比较），它的操作数回到这里。
     * BrainFuck 没有位指令：& | ^ ~ 转成对内部函数 __bf_xxx 的调用
     * （实现见 tc/stdlib.js），借用 pending 排到语句之前，走同一条内联展开管线；
     * 位移量是常量时直接生成 mul / div IR，代码量小得多且能被 Fold 继续优化。
     */
    function bitCall(fn, a, b, line, sink) {
      /* int32 操作数：位运算要走 32 位实现，生成一个专用 IR 节点，
         由 tc/i32.js 降级成逐字节的 8 位语句（8 位路径完全不受影响）。 */
      if (hasI32Expr(a) || hasI32Expr(b)) {
        return { k: 'i32bit', fn: fn, a: a, b: b || null, line: line };
      }
      /* 两个常量：编译期算完，一条 BF 都不用生成 */
      if (a && a.k === 'num' && (!b || b.k === 'num')) {
        return { k: 'num', v: BITVAL[fn](a.v, b ? b.v : 0), line: line };
      }
      /* 代数化简：x ^ 0、x | 0、x & 0、x & 255、x << 0、x >> 0 */
      if (b && b.k === 'num') {
        if (b.v === 0 && (fn === '__bf_xor' || fn === '__bf_or' ||
                          fn === '__bf_shl' || fn === '__bf_shr')) return a;
        if (fn === '__bf_and') {
          if (b.v === 0) return { k: 'num', v: 0, line: line };
          if (b.v === 255) return a;
        }
      }
      var t = '__bt' + (tmpSeq++);
      varType[t] = 'int';
      /* sink：调用点可以要求把前置语句插进指定数组（数组元素的复合赋值
         必须在「读出旧值」之后才调用辅助函数，不能扔进全局 pending） */
      (sink || pending).push({ type: 'callset', target: t, fn: fn,
                               args: b ? [a, b] : [a], line: line });
      bitFns[fn] = 1;
      return { k: 'var', name: t, line: line };
    }

    /* 表达式里是否涉及 int32 变量（决定位运算 / 移位走 8 位还是 32 位实现） */
    function hasI32Expr(e) {
      if (!e) return false;
      if (e.k === 'var') return varType[e.name] === 'i32' || varType[e.name] === 'f32';
      if (e.k === 'i32bit' || e.k === 'i32shift') return true;
      return hasI32Expr(e.a) || hasI32Expr(e.b);
    }

    /* ---------------- float / double ----------------
     * BrainFuck 里没有浮点数，这里用「放大 1000 倍的 int32」当定点数
     * （即固定 3 位小数，范围 ±214 万，精度 0.001），完全复用 tc/i32.js
     * 的 4 字节实现，所以 codegen 一行都不用改。所有转换都在编译期定型：
     *     float + float → 直接相加          float * float → (a*b)/1000
     *     int   + float → 先放大 1000 再加   float / float → (a*1000)/b
     * 纯常量的表达式会被 tc/opt.js 直接算成结果，不会留下任何 BF 指令。
     */
    var FSCALE = 1000;

    /* 放大后的常量：i32v 存精确值，v 供 8 位路径取低字节 */
    function fnum(v) {
      v = Math.round(v) | 0;
      return { k: 'num', v: v & 255, i32v: v, raw: v, f: 1 };
    }
    function rawInt(v) { return { k: 'num', v: v & 255, raw: v }; }

    /* 表达式的「宽度」：byte(8 位) / i32 / f32 / str */
    function exprKind(e) {
      if (!e) return 'int';
      /* toInt32 生成的 div 结果已经是普通整数，不能再按操作数（里面还有
         f32 变量）推断回 f32 —— 否则 printf("%d", int(d)) 会连除两次 1000。 */
      if (e.intCast) return 'int';
      switch (e.k) {
        case 'num': return e.f ? 'f32' : 'int';
        case 'var': return varType[e.name] || 'int';
        case 'bin': case 'mul': case 'div': case 'mod': {
          var ka = exprKind(e.a), kb = exprKind(e.b);
          if (ka === 'f32' || kb === 'f32') return 'f32';
          if (ka === 'i32' || kb === 'i32') return 'i32';
          return 'int';
        }
        case 'i32bit': case 'i32shift': return 'i32';
        case 'strlit': case 'scat': case 'ssub': return 'str';
        default: return 'int';
      }
    }
    function isFloatExpr(e) { return exprKind(e) === 'f32'; }

    /* 任意数值表达式 → 定点浮点（放大 1000 倍，复用 int32 存储） */
    function toFloat(e, line) {
      if (!e || exprKind(e) === 'f32') return e;
      if (e.k === 'num') {
        var v = e.i32v != null ? e.i32v : (e.raw != null ? e.raw : e.v);
        return fnum(v * FSCALE);
      }
      return { k: 'mul', a: e, b: rawInt(FSCALE), f: 1, line: line };
    }

    /* 定点浮点 → int32（截断小数，与 C++ 的 (int) 一致） */
    function toInt32(e, line) {
      if (!e || exprKind(e) !== 'f32') return e;
      return { k: 'div', a: e, b: rawInt(FSCALE), intCast: 1, line: line };
    }

    /* 8 位整型转换：常量必须真的截断到一字节。
       num 节点上带 raw / i32v（供 int32 用），printf %d 会优先拿它，
       于是 char(300) 会打出 300 而不是 44。 */
    function trunc8(e, line) {
      if (e && e.k === 'num' && !e.f && !e.intCast) {
        return { k: 'num', v: e.v & 255, ch: e.ch, line: line };
      }
      return e;
    }

    /* 定点浮点 → 8 位整数 */
    function toByte(e, line) {
      return exprKind(e) === 'f32' ? toInt32(e, line) : e;
    }

    /* 按目标类型收敛 */
    function coerceTo(kind, e, line) {
      if (!e) return e;
      if (kind === 'f32') return toFloat(e, line);
      if (kind === 'i32') return toInt32(e, line);
      if (kind === 'str') return e;
      return toByte(e, line);
    }

    /* 二元算术：自动处理 float 的提升与「乘除后重新定标」 */
    function arithNode(op, a, b, line) {
      var fa = isFloatExpr(a), fb = isFloatExpr(b);
      if (fa || fb) {
        a = toFloat(a, line);
        b = toFloat(b, line);
        if (op === '*') {
          return { k: 'div', a: { k: 'mul', a: a, b: b, line: line },
                   b: rawInt(FSCALE), f: 1, line: line };
        }
        if (op === '/') {
          return { k: 'div', a: { k: 'mul', a: a, b: rawInt(FSCALE), line: line },
                   b: b, f: 1, line: line };
        }
        if (op === '%') {
          warn('float 不支持 % 取余，已先截断成 int32 再取余', line);
          return { k: 'mod', a: toInt32(a, line), b: toInt32(b, line), line: line };
        }
        return { k: 'bin', op: op, a: a, b: b, f: 1, line: line };
      }
      if (op === '*') return { k: 'mul', op: '*', a: a, b: b, line: line };
      if (op === '/') return { k: 'div', op: '/', a: a, b: b, line: line };
      if (op === '%') return { k: 'mod', op: '%', a: a, b: b, line: line };
      return { k: 'bin', op: op, a: a, b: b, line: line };
    }

    /* a << N / a >> N：常量 N → 乘 / 除 2^N；N>=8 时 8 位单元格结果必为 0 */
    function shiftExpr(op, a, b, line, sink) {
      /* int32：常量位移也要走 32 位实现 —— 右移是算术移位，不能换成除法 */
      if (hasI32Expr(a) || hasI32Expr(b)) {
        return { k: 'i32shift', op: op, a: a, b: b, line: line };
      }
      if (!b || b.k !== 'num') {
        return bitCall(op === '<<' ? '__bf_shl' : '__bf_shr', a, b, line, sink);
      }
      var n = b.v;
      if (n === 0) return a;
      if (n >= 8) return { k: 'num', v: 0, line: line };
      var w = 1 << n;
      return op === '<<'
        ? { k: 'mul', a: a, b: { k: 'num', v: w }, line: line }
        : { k: 'div', a: a, b: { k: 'num', v: w }, line: line };
    }

    function parseExpr() { return parseTernary(); }

    /* 三元 cond ? a : b —— 借一个临时格 + if/else 语句实现 */
    function parseTernary() {
      var line = lineNow();
      /* 三元的条件是完整的「逻辑或表达式」，要能写 a > 3 ? … : …
         parseCondExpr 的操作数回落到 parseBitOr，不会在这里形成递归。 */
      var c = parseCondExpr();
      if (!is('?')) return c;
      next();
      var a = parseTernary();
      expect(':');
      var b = parseTernary();
      var t = '__tr' + (tmpSeq++);
      varType[t] = 'int';
      pending.push({ type: 'set', name: t, expr: { k: 'num', v: 0 }, line: line });
      pending.push({
        type: 'if', cond: c,
        then: [{ type: 'set', name: t, expr: a, line: line }],
        else: [{ type: 'set', name: t, expr: b, line: line }],
        line: line, text: '三元 ?: '
      });
      return { k: 'var', name: t, line: line };
    }

    function parseBitOr() {
      var l = parseBitXor();
      while (is('|') && peek().t === 'op') {
        var line = lineNow(); next();
        l = bitCall('__bf_or', l, parseBitXor(), line);
      }
      return l;
    }
    function parseBitXor() {
      var l = parseBitAnd();
      while (is('^') && peek().t === 'op') {
        var line = lineNow(); next();
        l = bitCall('__bf_xor', l, parseBitAnd(), line);
      }
      return l;
    }
    function parseBitAnd() {
      var l = parseShift();
      while (is('&') && peek().t === 'op') {
        var line = lineNow(); next();
        l = bitCall('__bf_and', l, parseShift(), line);
      }
      return l;
    }
    function parseShift() {
      var l = parseAdd();
      while (!noShift && (is('<<') || is('>>')) && peek().t === 'op') {
        var line = lineNow();
        var op = next().v;
        l = shiftExpr(op, l, parseAdd(), line);
      }
      return l;
    }

    /* + - 层 */
    /* + - 层 */
    function parseAdd() {
      var left = parseMul();
      while (is('+') || is('-')) {
        var aline = lineNow();
        var op = next().v;
        var right = parseMul();
        /* std::string 的 + 是拼接：任一操作数是字符串就走 scat。
           s + "x"、s + t、s + 'c'（单字符按 1 字节追加）都支持。 */
        if (op === '+' && (isStrExpr(left) || isStrExpr(right))) {
          if (left.k === 'strlit' && right.k === 'strlit') {
            left = { k: 'strlit', text: left.text + right.text, line: aline };
          } else {
            left = { k: 'scat', a: left, b: right, line: aline };
          }
          continue;
        }
        left = arithNode(op, left, right, aline);
      }
      return left;
    }

    /* 字符串表达式判定（用于 + 与比较的语义分派） */
    function isStrExpr(e) {
      if (!e) return false;
      if (e.k === 'strlit' || e.k === 'scat' || e.k === 'ssub' || e.k === 'to_str') return true;
      if (e.k === 'var') return varType[e.name] === 'str';
      return false;
    }

    /* 复合位赋值：x <op>= e  →  x = <bit>(x, e)，位移量是常量时走乘除快路径 */
    function bitAssign(op, name, rhs, line) {
      name = resolveAlias(name);
      if (varType[name] === 'f32') {
        warn('float 不支持位运算 ' + op + '，已先截断成 int32', line);
      }
      var lv = { k: 'var', name: name, line: line };
      var fn = { '^=': '__bf_xor', '&=': '__bf_and', '|=': '__bf_or',
                 '<<=': '__bf_shl', '>>=': '__bf_shr' }[op];
      var e = (op === '<<=' || op === '>>=')
        ? shiftExpr(op === '<<=' ? '<<' : '>>', lv, rhs, line)
        : bitCall(fn, lv, rhs, line);
      /* x = x 是空操作；交给 codegen 反而会「先清目标再读源」把自己清成 0 */
      if (e.k === 'var' && e.name === name) return null;
      return { type: 'set', name: name, expr: e, line: line };
    }

    /* 复合赋值：8 位整数保持 add / sub 快路径，float / int32 走完整表达式 */
    function compound(op, name, rhs, line) {
      name = resolveAlias(name);
      var self = { k: 'var', name: name, line: line };
      var tk = varType[name] || 'int';
      if (tk === 'f32' || isFloatExpr(rhs)) {
        return { type: 'set', name: name,
                 expr: coerceTo(tk, arithNode(op, self, rhs, line), line), line: line };
      }
      if (op === '+') return { type: 'add', name: name, expr: rhs, line: line };
      if (op === '-') return { type: 'sub', name: name, expr: rhs, line: line };
      return { type: 'set', name: name, expr: arithNode(op, self, rhs, line), line: line };
    }

    function parseMul() {
      var left = parseTerm();
      for (;;) {
        var line = lineNow();
        var tk = peek();
        /* 注意：不能把 '*' 和 '*=' 混起来（词法阶段已经区分成两个 token） */
        if (tk.v === '*' && tk.t === 'op') {
          next();
          left = arithNode('*', left, parseTerm(), line);
          continue;
        }
        if (tk.v === '/' && tk.t === 'op') {
          next();
          left = arithNode('/', left, parseTerm(), line);
          continue;
        }
        if (tk.v === '%' && tk.t === 'op') {
          next();
          left = arithNode('%', left, parseTerm(), line);
          continue;
        }
        break;
      }
      return left;
    }

    /* 吃掉 <...> 里的模板 / 转换参数，支持嵌套和 >> 被词法合成一个 token 的情况 */
    function eatAngle() {
      if (!is('<')) return;
      var depth = 0;
      while (!eof()) {
        if (is('<')) { depth++; next(); continue; }
        if (is('>>')) { depth -= 2; next(); if (depth <= 0) return; continue; }
        if (is('>')) { depth--; next(); if (depth <= 0) return; continue; }
        next();
      }
    }

    /* 吃掉一整对括号（忽略不关心的流方法参数） */
    function skipParens() {
      if (!is('(')) return;
      var d = 0;
      while (!eof()) {
        if (is('(')) d++;
        else if (is(')')) { d--; if (!d) { next(); return; } }
        next();
      }
    }

    /* std::chrono::...、numeric_limits<...>::max() 之类没有 BF 等价物的链：
       整条吃掉并降级成 0 + 明确告警，而不是甩一个看不懂的语法错。 */
    function chainFallback(first, line) {
      var desc = first;
      var guard = 0;
      while (!eof() && guard++ < 60) {
        if (is('::') || is('.')) {
          desc += next().v + (next().v || '');
          continue;
        }
        if (is('<')) { eatAngle(); desc += '<…>'; continue; }
        if (is('(')) { skipParens(); desc += '()'; continue; }
        break;
      }
      warn('「' + desc + '」在 BrainFuck 里没有对应能力，已按 0 降级', line);
      return { k: 'num', v: 0, line: line };
    }

    function parseTerm() {
      var line = lineNow();

      /* 前缀 ++i / --i 用在表达式里（for 的步进、printf("%d", ++i)）。
         先自增，再返回这个变量本身；f32 变量按定点标度加 1000。 */
      if ((is('++') || is('--')) && peek().t === 'op') {
        var pInc = next().v;
        var pNm = resolveAlias(expectId());
        var pOne = (varType[pNm] === 'f32') ? fnum(FSCALE) : numNode(1);
        pending.push({
          type: pInc === '++' ? 'add' : 'sub', name: pNm, expr: pOne, line: line
        });
        return V(pNm, line);
      }

      /* C++ 命名转换：static_cast<T>(e) / reinterpret_cast<T>(e) …
         8 位单元格没有「宽度」，转换本身没有意义，直接返回内部表达式。 */
      if (peek().t === 'id' && CAST_KW[peek().v] && peek(1).v === '<') {
        var castName = next().v;
        var ctv = peek().v;                 /* < 之后第一个词就是目标类型 */
        eatAngle();
        expect('(');
        var ce = parseExpr();
        expect(')');
        if (ctv === 'float' || ctv === 'double') return toFloat(ce, line);
        if (ctv === 'int' || ctv === 'long' || ctv === 'int32' ||
            ctv === 'int32_t' || ctv === 'int64_t' || ctv === 'uint32_t') {
          return toInt32(ce, line);
        }
        warn(castName + ' 在 8 位 BrainFuck 里按无操作处理', line);
        return ce;
      }

      if (is('(')) {
        /* C 风格 (int)e / (char)e / (float)e / (double)e：括号里全是类型词才当转换 */
        var q = p;
        next();
        var tw = [];
        while (!eof() && (isTypeKw(peek().v) || isMod(peek().v) || is('*') || is('&'))) tw.push(next().v);
        if (tw.length && is(')')) {
          next();
          var ck = kindOf(tw);
          var inner = parseTerm();
          if (tw.indexOf('bool') >= 0) return boolExpr(inner, line);
          if (tw.indexOf('void') >= 0) return numNode(0);
          if (ck === 'f32') return toFloat(inner, line);
          if (ck === 'i32') return toInt32(inner, line);
          if (ck === 'char' || ck === 'int') return trunc8(toByte(inner, line), line);
          return inner;
        }
        p = q;
        accept('(');
        /* 括号内恢复位移语义，这样 cout << (a << 2) 里的 << 仍是左移 */
        var savedNo = noShift;
        noShift = 0;
        var e = parseExpr();
        expect(')');
        noShift = savedNo;
        return e;
      }

      if (accept('-')) {
        var neg = parseTerm();
        if (neg.k === 'num') {
          /* v 仍是 8 位兼容值；i32v 留给 int32 lowering 用精确负数 */
          var raw = neg.raw != null ? neg.raw : neg.v;
          var nn = { k: 'num', v: (-neg.v) & 255, ch: neg.ch, i32v: -raw, line: line };
          if (neg.f) nn.f = 1;
          return nn;
        }
        /* 一元负号作用于变量：保留成 0 - x，交给 i32 lowering 或 8 位减法 */
        var zero = { k: 'num', v: 0 };
        var sub = { k: 'bin', op: '-', a: zero, b: neg, line: line };
        if (isFloatExpr(neg)) { zero = fnum(0); sub.a = zero; sub.f = 1; }
        return sub;
      }
      if (accept('+')) return parseTerm();
      /* 一元 * ：指针解引用。二元乘法在 parseMul 层消费，不会走到这里。 */
      if (is('*') && peek().t === 'op') {
        next();
        /* *p —— 最常见，直接命中 */
        if (peek().t === 'id' && pointers[peek().v]) {
          return derefRead(next().v, line);
        }
        /* *(p + n) / *(p - n)：指针名在表达式里是「地址编号」常量，
           不能靠递归 parseTerm 认出来，这里手工拆。 */
        if (is('(')) {
          var dsave = p;
          next();
          if (peek().t === 'id' && pointers[peek().v]) {
            var dpn = next().v;
            if (is('+') || is('-')) {
              var dsign = next().v === '+' ? 1 : -1;
              var damt = parseExpr();
              expect(')');
              var doff = ptrOffsetRead(pointers[dpn], dsign, damt, line);
              if (doff) return doff;
            }
          }
          p = dsave;
        }
        var de = parseTerm();
        if (de && de.k === 'var' && pointers[de.name]) return derefRead(de.name, line);
        throw new ParseError('* 后面需要指针变量或「*(指针 ± 整数)」', line);
      }
      /* 一元 & ：取地址。返回 ptrarg 节点，由 bindArgs / inline 认领；
         用错地方（printf("%d", &a)）会由 Fold 折成 0 并给出告警。 */
      if (is('&') && peek().t === 'op') {
        var al = lineNow();
        next();
        var ad = readAddr(al);
        if (ad.null) return numNode(0);
        var an = ad.name;
        if (!an && ad.arr) {
          var ar2 = arrayReadIdx(ad.arr, ad.idxs, al);
          an = ar2 && ar2.name;
          warn('取「变量下标数组元素」的地址不支持，已按值传递', al);
        }
        return { k: 'ptrarg', name: an, base: an, line: al };
      }
      if (accept('~')) return bitCall('__bf_not', parseTerm(), null, line);

      if (peek().t === 'num') {
        var tk = next();
        /* 浮点字面量：raw 里已经是「放大 1000 倍」的整数 */
        if (tk.f) {
          var scl = tk.raw != null ? tk.raw : tk.v;
          return { k: 'num', v: scl & 255, i32v: scl, raw: scl, f: 1, line: line };
        }
        /* 只有真正超出 32 位的常量（uint64_t 魔数）才值得提示：
           70000 这种在 int32 里是正常值，动不动告警只会刷屏 */
        if (tk.big64 && !warnedBig) {
          warnedBig = true;
          warn('源码里有超过 32 位的整数常量（如 uint64_t 魔数），已截断成 32 / 8 位处理', line);
        }
        return { k: 'num', v: tk.v & 255, ch: !!tk.ch,
                 raw: tk.raw != null ? tk.raw : (tk.v & 255), line: line };
      }

      if (peek().t === 'str') {
        return { k: 'strlit', text: next().v, line: line };
      }

      if (peek().t === 'id') {
        var name = next().v;
        if (name === 'std' && is('::')) { next(); name = next().v; }

        /* 后缀 i++ / i--：先复制旧值到临时格、再自增，表达式返回旧值。
           典型用途 a[i++] = v / history[count++] = … */
        if ((is('++') || is('--')) && peek().t === 'op') {
          var qInc = next().v;
          var qNm = resolveAlias(name);
          var qTmp = '__po' + (tmpSeq++);
          varType[qTmp] = varType[qNm] || 'int';
          var qOne = (varType[qNm] === 'f32') ? fnum(FSCALE) : numNode(1);
          pending.push({ type: 'decl', name: qTmp, kind: varType[qTmp], line: line });
          pending.push({ type: 'set', name: qTmp, expr: V(qNm, line), line: line,
                         text: '后缀 ' + qInc + '：保存旧值' });
          pending.push({ type: qInc === '++' ? 'add' : 'sub', name: qNm,
                         expr: qOne, line: line, text: '后缀 ' + qInc });
          return { k: 'var', name: qTmp, line: line };
        }

        /* std::cin.get(ch)：读一个字符到 ch，并把它当作「是否读到」的条件。
           BrainFuck 的 , 在 EOF 时给 0，所以「ch != 0」就是 C++ 的流状态。 */
        if (name === 'cin' && is('.') && peek(1).v === 'get') {
          next(); next();
          expect('(');
          var cgName = resolveAlias(expectId());
          expect(')');
          var cgIn = { type: 'in', name: cgName, line: line, __arr: 1,
                       text: 'cin.get(' + cgName + ')' };
          pending.push(cgIn);
          return { k: 'cmp', op: '!=', a: V(cgName, line), b: numNode(0), line: line };
        }
        /* 裸的 cin / cout 作为布尔值：输入流状态恒为「正常」 */
        if (name === 'cin' || name === 'cout' || name === 'cerr' || name === 'clog') {
          if (!is('.') && !is('(')) return numNode(1);
        }

        /* C++ 函数式类型转换：char(65) / int(x) / double(2) / string("hi")。
           类型词可能不止一个（unsigned char / long long / long double）。 */
        if (isTypeKw(name)) {
          var fsave = p, ftw = [name];
          while (peek().t === 'id' && isTypeKw(peek().v)) ftw.push(next().v);
          if (is('(')) return functionalCast(ftw, line);
          p = fsave;
        }

        /* strlen 的真实现：以前落在 IGNORABLE 里按 0 降级。
           参数是裸数组名时要拦在「数组退化为首元素」之前，否则
           strlen(buf) 会变成测 buf[0] 这一个字符。 */
        if (name === 'strlen' && is('(')) {
          var slq = p;
          next();
          if (peek().t === 'id' && arrays[peek().v] && peek(1).v === ')') {
            var sarr = next().v;
            expect(')');
            return strLengthExpr([{ k: 'var', name: sarr, line: line }], line);
          }
          p = slq;
          return strLengthExpr(parseArgs(), line);
        }

        /* sizeof：数组总字节数 / 单个元素字节数 / 类型字节数。
           sizeof(a) / sizeof(a[0]) 是取元素个数的标准写法，必须支持。 */
        if (name === 'sizeof' && is('(')) {
          next();
          var sz = 1;
          if (peek().t === 'id' && isTypeKw(peek().v)) {
            var st = eatType();
            while (is('*')) next();
            sz = cellSize(kindOf(st));
          } else if (peek().t === 'id' && !is('(')) {
            var sn = next().v;
            if (arrays[sn]) {
              if (is('[')) {
                parseIdxs();                       /* sizeof 不求值，下标只吃掉 */
                sz = cellSize(arrays[sn].kind);
              } else {
                sz = cellSize(arrays[sn].kind) * arrays[sn].total;
              }
            } else {
              sz = cellSize(varType[sn] || 'int');
            }
          } else {
            sz = cellSize(exprKind(parseExpr()));
          }
          expect(')');
          return { k: 'num', v: sz & 255, i32v: sz, raw: sz, line: line };
        }

        /* 指针下标 p[i] == *(p+i) / 箭头 p->x（类降级后成员是全局变量） */
        if (pointers[name] && is('[')) {
          next();
          var pidx = parseExpr();
          expect(']');
          var pt0 = pointers[name];
          if (pt0.arr) {
            var base = pt0.cur ? { k: 'var', name: pt0.cur, line: line }
                               : (pt0.linear != null ? numNode(pt0.linear) : pt0.idxs[0]);
            return arrayReadIdx(pt0.arr,
              [{ k: 'bin', op: '+', a: base, b: pidx, line: line }], line);
          }
          warn('指针 ' + name + ' 不指向数组，' + name + '[i] 已按 *' + name + ' 处理', line);
          return derefRead(name, line);
        }
        if (pointers[name] && is('->')) {
          next();
          var mem = next().v || '';
          warn('指针 ' + name + '->' + mem + '：类已降级为单对象，直接访问成员 ' + mem, line);
          return V(mem, line);
        }
        if (pointers[name] && !is('(') && !is('.')) {
          /* 指针的地址值本身没有对应物，但身份可以静态编号：
             if (p) / p == nullptr / p == q 就能编译期判定。 */
          return numNode(addrIdOf(pointers[name]));
        }

        /* struct 成员：h.op / history[i].a（标量结构体补 0 下标） */
        if ((structVars[name] || (aliases[name] && aliases[name].structRef)) &&
            (is('.') || is('->') || is('['))) {
          var smr = structMemberRead(name, line);
          if (smr) return smr;
        }

        /* 数组下标：a[i] / m[i][j] */
        if (arrays[name] && is('[')) return arrayRead(name, line);
        if (arrays[name]) {
          /* 只写数组名：C 里它退化成一个指针（也就是首元素地址）。
             BF 没有指针，这里按「首元素」处理并提示，至少让 printf("%d", a) 能跑。 */
          warn('数组 ' + name + ' 没带下标：BrainFuck 里没有指针，已按首元素 ' +
               name + '[0] 处理', line);
          return { k: 'var', name: elemName(name, [0]), line: line };
        }

        /* std::string 的下标与方法：s[i] / s.length() / s.substr(1, 2) … */
        if (varType[name] === 'str') {
          if (is('[')) {
            next();
            var sidx = parseExpr();
            expect(']');
            return strChain({ k: 'sidx', base: name, idx: sidx, line: line }, line);
          }
          if (is('.')) {
            next();
            return strChain(strMethod(name, next().v || '', line), line);
          }
        }

        /* 多级命名空间链 std::A::B::… */
        if (is('::')) return chainFallback(name, line);
        /* 模板类链 numeric_limits<std::streamsize>::max() 等 */
        if (is('<') && (peek(1).v === 'std' || peek(1).v === '::' || isTypeKw(peek(1).v))) {
          return chainFallback(name, line);
        }
        /* 对象.方法：rng.nextInt(...) → 同名的普通函数；流状态查询 → 恒假 */
        if (is('.')) {
          next();
          var meth = next().v || '';
          if (meth === 'eof' || meth === 'fail' || meth === 'bad' || meth === 'good') {
            skipParens();
            warn('流状态查询 ' + name + '.' + meth + '() 在 BrainFuck 里恒为假', line);
            return { k: 'num', v: 0, line: line };
          }
          if (is('(')) return callInExpr(meth, line);
          return chainFallback(name + '.' + meth, line);
        }
        if (is('(')) {
          var pargs = parseArgs();
          /* to_string / stoi 与字符串强相关，直接落到字符串 lowering，
             不走函数表（它们不是 8 位整数函数） */
          if (name === 'to_string' && pargs.length === 1) {
            return { k: 'to_str', a: pargs[0], line: line };
          }
          /* <cmath> 取整函数：定点数感知，不能走 8 位库函数 */
          if ((name === 'floor' || name === 'ceil' || name === 'round' ||
               name === 'trunc') && pargs.length >= 1) {
            if (pargs.length > 1) warn(name + ' 的多余参数已忽略', line);
            return mathFunc(name, pargs[0], line);
          }
          if ((name === 'stoi' || name === 'atoi' || name === 'stol' ||
               name === 'atol' || name === 'strtol') && pargs.length >= 1) {
            if (pargs.length > 1) warn(name + ' 的进制 / 指针参数已忽略（按十进制解析）', line);
            var sa = pargs[0];
            /* 字面量直接编译期算完：atoi("42") 不该拖进整套字符串运行时 */
            if (sa && sa.k === 'strlit') {
              var sm = /^\s*([+-]?\d+)/.exec(sa.text);
              return numNode(sm ? parseInt(sm[1], 10) : 0);
            }
            return { k: 'stoi', a: sa, line: line };
          }
          return callInExpr(name, line, pargs);
        }
        /* 绑定到数组元素的引用（int& r = a[i]）：读 r 就是读那个元素，
           下标用绑定当时快照下来的值（C++ 的引用语义：绑的是对象，不是位置表达式） */
        var alr = aliasArr(name);
        if (alr) return arrayReadIdx(alr.arr, alr.idxs, line);

        return V(name, line);
      }
      throw new ParseError('无法解析的表达式：' + (peek().v || '结束'), line);
    }

    /* ================= 指针支持 =================
     * BrainFuck 只有一排单元格、没有地址，所以指针在编译期绑定到「某个变量名」：
     *   int *p = &a;  → pointers[p] = { name: 'a' }，*p 直接写成 a（零指令）
     *   int *p = a;   → 绑定到 a[0]；p++ / p[i] 用运行期游标走数组选择树
     *   函数形参指针 → 复用引用内联机制，*p 在调用点落到实参那一格
     * 指针本身不占单元格。指向数组时支持在数组内前后移动，但不支持真正的
     * 任意地址运算（** 二级指针、函数指针、void* 都会明确告警降级）。
     */
    function linearOf(cs, dims) {
      var k = 0;
      for (var i = 0; i < cs.length; i++) k = k * dims[i] + cs[i];
      return k;
    }

    function ptrAddrCopy(a) {
      return { name: a.name, arr: a.arr, idxs: a.idxs, linear: a.linear,
               cur: a.cur, kind: a.kind, param: a.param, null: a.null };
    }

    /* 解析一个「地址」：&a / &a[i] / a（数组名）/ p（另一个指针）/ 0|NULL */
    function readAddr(line) {
      var amp = accept('&');
      if (accept('*')) {                       /* &*p：取回 p 指向的位置 */
        var q = expectId();
        if (!pointers[q]) throw new ParseError('*' + q + '：' + q + ' 不是指针', line);
        return ptrAddrCopy(pointers[q]);
      }
      if (peek().t !== 'id') {
        var ze = parseExpr();
        if (constOf(ze) === 0) return { null: true };
        warn('指针只能指向变量或数组元素，这里按空指针处理', line);
        return { null: true };
      }
      var nm = next().v;
      if (nm === 'std' && is('::')) { next(); nm = next().v; }

      /* 另一个指针：复制绑定（p = q） */
      if (pointers[nm] && !is('[')) {
        if (amp) warn('&' + nm + ' 是二级指针，BrainFuck 不支持，已按 ' + nm + ' 本身处理', line);
        return ptrAddrCopy(pointers[nm]);
      }

      /* 数组：裸名退化为首元素（C 语义），带下标则定位到那个元素 */
      if (arrays[nm]) {
        var ar = arrays[nm];
        var idxs = is('[') ? parseIdxs() : [];
        if (!idxs.length) {
          for (var d = 0; d < ar.dims.length; d++) idxs.push(numNode(0));
        }
        checkIdx(nm, ar, idxs, line);
        var cs = idxs.map(function (x) { return constOf(x); });
        var allC = cs.every(function (x) { return x != null; });
        if (allC) {
          return { name: elemName(nm, cs), arr: nm, idxs: idxs,
                   linear: linearOf(cs, ar.dims), cur: null, null: false };
        }
        if (ar.dims.length > 1) {
          warn('多维数组的指针只支持常量下标，已按 ' + nm + '[0]…[0] 处理', line);
          var zeros = ar.dims.map(function () { return 0; });
          return { name: elemName(nm, zeros), arr: nm, idxs: zeros.map(numNode),
                   linear: 0, cur: null, null: false };
        }
        /* 一维 + 变量下标：解引用时走数组选择树 */
        return { name: null, arr: nm, idxs: idxs, linear: null,
                 cur: null, null: false };
      }

      if (is('[')) {
        throw new ParseError(nm + ' 不是数组，不能取元素地址', line);
      }
      return { name: resolveAlias(nm), arr: null, idxs: null,
               linear: null, cur: null, null: false };
    }

    /* 指针的「真假 / 相等」在编译期就能定：给每个绑定目标一个固定编号，
       空指针是 0。于是 if (p)、p == nullptr、p == q 都不用生成运行期代码。
       编号只是身份标识，不是真的地址（BrainFuck 里根本没有地址）。 */
    function addrIdOf(pt) {
      if (!pt || pt.null) return 0;
      var key = pt.name || (pt.arr + '#' + (pt.cur ? 'cur' : pt.linear));
      if (!key) return 0;
      if (!addrIds[key]) addrIds[key] = nextAddrId++;
      return addrIds[key];
    }

    /* *(p+n) / *(p-n)：在数组指针的基准下标上偏移 */
    function ptrOffsetRead(pt, sign, amount, line) {
      if (!pt.arr) {
        warn('指针不指向数组，*(p ± n) 已按 *p 处理', line);
        return null;
      }
      var base = pt.cur ? { k: 'var', name: pt.cur, line: line }
               : (pt.linear != null ? numNode(pt.linear) : pt.idxs[0]);
      var expr = { k: 'bin', op: sign > 0 ? '+' : '-',
                   a: base, b: amount, line: line };
      return arrayReadIdx(pt.arr, [expr], line);
    }

    /* 源码后面会不会对这个指针做 ++/--/+=/-= ？
       必须在绑定当下就决定：解析到 printf("%d", *p) 时若还是静态绑定，
       那一句就固化成 a[0] 了，等后面解析到 p++ 再升级已经来不及。 */
    function willMovePtr(name) {
      for (var i = p; i < toks.length; i++) {
        if (toks[i].t === 'id' && toks[i].v === name) {
          var a = toks[i + 1] && toks[i + 1].v;
          var b = toks[i - 1] && toks[i - 1].v;
          if (a === '++' || a === '--' || a === '+=' || a === '-=' ||
              b === '++' || b === '--') return true;
        }
      }
      return false;
    }

    function bindPtr(name, addr, kind, line, isParam) {
      var pt = {
        name: isParam ? name : addr.name,
        arr: isParam ? null : addr.arr,
        idxs: addr.idxs || null,
        linear: addr.linear != null ? addr.linear : null,
        cur: addr.cur || null,
        kind: kind,
        param: !!isParam,
        null: !!addr.null
      };
      pointers[name] = pt;
      varType[name] = 'int';
      /* 会做指针算术 → 立刻建游标格，返回的 decl 由调用方插进 IR */
      if (pt.arr && !isParam && willMovePtr(name)) return ptrEnsureCur(name, line);
      return null;
    }

    /* *p 的右值 */
    function derefRead(name, line) {
      var pt = pointers[name];
      if (!pt) throw new ParseError('*' + name + '：' + name +
        ' 不是指针（声明时要写 int *' + name + '）', line);
      if (pt.null) { warn('*' + name + ' 是空指针解引用，已按 0 处理', line); return numNode(0); }
      if (pt.name) return { k: 'var', name: pt.name, line: line };
      if (pt.arr) {
        var idx = pt.cur ? { k: 'var', name: pt.cur, line: line } : pt.idxs[0];
        return arrayReadIdx(pt.arr, [idx], line);
      }
      warn('*' + name + ' 没有绑定目标，已按 0 处理', line);
      return numNode(0);
    }

    /* 消费「* 指针名」，返回左值描述；allowParen 处理 (*p)++ 的右括号 */
    function derefLValue(line) {
      var stars = 0;
      while (is('*') && peek().t === 'op') { next(); stars++; }
      if (!stars) throw new ParseError('这里需要一个 * 解引用', line);
      var nm = expectId();
      if (stars > 1) warn('多级指针（**）不支持，已按一级指针处理', line);
      accept(')');
      var pt = pointers[nm];
      if (!pt) throw new ParseError('*' + nm + '：' + nm + ' 不是指针', line);
      if (pt.null) { warn('*' + nm + ' 是空指针，赋值已忽略', line); return { none: true }; }
      if (pt.name) return { name: pt.name };
      if (pt.arr) return { arr: pt.arr, idx: pt.cur ? { k: 'var', name: pt.cur, line: line } : pt.idxs[0] };
      return { none: true };
    }

    /* 把一条赋值落到左值上（静态 = 普通变量，动态 = 数组选择树） */
    function putLValue(lv, type, expr, line) {
      if (lv.none) return null;
      if (lv.name) return { type: type, name: lv.name, expr: expr, line: line };
      var modeMap = { set: 'set', add: 'add', sub: 'sub' };
      return arrayWrite(lv.arr, [lv.idx], line, modeMap[type] || 'set', expr);
    }

    /* 指针加减：只支持指向一维数组的指针，运行期用游标格 */
    function ptrStep(name, delta, line) {
      var pt = pointers[name];
      if (!pt.arr) {
        warn('指针 ' + name + ' 不指向数组，' + (delta > 0 ? '++' : '--') +
             ' 在 BrainFuck 里没有意义，已忽略', line);
        return [];
      }
      var out = [];
      if (!pt.cur) {
        var cur = '__pi' + (tmpSeq++);
        varType[cur] = 'int';
        var start = pt.linear != null ? numNode(pt.linear)
                  : (pt.idxs && pt.idxs[0] ? pt.idxs[0] : numNode(0));
        out.push({ type: 'decl', name: cur, init: start, line: line,
                   text: '指针 ' + name + ' 的运行期游标' });
        pt.cur = cur;
        pt.name = null;
      }
      out.push({ type: delta > 0 ? 'add' : 'sub', name: pt.cur,
                 expr: numNode(Math.abs(delta)), line: line,
                 text: '指针 ' + name + (delta > 0 ? ' ++' : ' --') });
      return out;
    }

    /* ================= 函数式类型转换 / 常用标准函数 =================
     * C++ 允许把类型名当函数用：char(65) / int(x) / double(2) / string("hi")。
     * 语义与 C 风格 (char)65 完全一致；以前这些写法会落到 callInExpr，
     * 直接报「函数 char 未定义」。这里复用 coerceTo，保证两种写法不打架。
     */
    function utf8Len(s) {
      var n = 0;
      for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c < 0x80) n++;
        else if (c < 0x800) n += 2;
        else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; }
        else n += 3;
      }
      return n;
    }

    /* bool(x) 必须真的得到 0 / 1，不能像 (bool)x 那样只做 8 位截断。
       用比较节点求布尔值再落进临时格 —— 于是它也能参与后面的算术。 */
    function boolExpr(e, line) {
      if (e && e.k === 'num') return numNode(e.v ? 1 : 0);
      var t = '__bl' + (tmpSeq++);
      varType[t] = 'int';
      pending.push({
        type: 'set', name: t, line: line, text: 'bool(…) → 0 / 1',
        expr: { k: 'cmp', op: '!=', a: e, b: numNode(0), line: line }
      });
      return { k: 'var', name: t, line: line };
    }

    /* string(x)：把任意值转成 std::string 表达式 */
    function toStrExpr(e, line) {
      if (!e) return { k: 'strlit', text: '', line: line };
      if (isStrExpr(e)) return e;
      if (e.k === 'num' && e.ch) {
        return { k: 'strlit', text: String.fromCharCode(e.v), line: line };
      }
      return { k: 'to_str', a: e, line: line };
    }

    /* string(n, ch)：重复 n 次字符。两个都常量就编译期展开，
       否则交给 str.js 的 srep 节点在运行期循环构造。 */
    function stringFill(args, line) {
      var n = args[0], ch = args[1];
      var cn = n && n.k === 'num' ? (n.i32v != null ? n.i32v : n.v) : null;
      var cc = ch && ch.k === 'num' ? ch.v : null;
      if (cn != null && cc != null) {
        if (cn < 0) cn = 0;
        if (cn > 32) { warn('string(n, ch) 的 n 超过 32 字节缓冲区，已截断', line); cn = 32; }
        return { k: 'strlit', text: new Array(cn + 1).join(String.fromCharCode(cc)), line: line };
      }
      return { k: 'srep', n: n, ch: ch, line: line };
    }

    /* strlen(s)：字面量编译期算完；std::string 走 slen 节点；
       char 数组逐格数到第一个 0（BrainFuck 没有指针，只能展开）。 */
    function strLengthExpr(args, line) {
      var e = args[0];
      if (!e) return numNode(0);
      if (e.k === 'strlit') return numNode(utf8Len(e.text));
      if (isStrExpr(e)) return { k: 'slen', a: e, line: line };
      if (e.k === 'var' && arrays[e.name]) {
        var ar = arrays[e.name];
        var t = '__sl' + (tmpSeq++), alive = '__sla' + (tmpSeq++);
        varType[t] = 'int'; varType[alive] = 'int';
        pending.push({ type: 'set', name: t, expr: numNode(0), line: line,
                       text: 'strlen：长度' });
        pending.push({ type: 'set', name: alive, expr: numNode(1), line: line,
                       text: 'strlen：还没遇到结束符' });
        for (var i = 0; i < ar.total; i++) {
          var cell = elemName(e.name, unlinear(i, ar.dims));
          pending.push({
            type: 'if', line: line, text: 'strlen：第 ' + i + ' 字节',
            cond: { k: 'and', a: { k: 'var', name: alive, line: line },
                    b: { k: 'cmp', op: '!=', a: { k: 'var', name: cell, line: line },
                         b: numNode(0), line: line }, line: line },
            then: [{ type: 'add', name: t, expr: numNode(1), line: line }],
            else: [{ type: 'set', name: alive, expr: numNode(0), line: line }]
          });
        }
        return { k: 'var', name: t, line: line };
      }
      warn('strlen 只支持字符串字面量 / std::string / char 数组，这里按 0 处理', line);
      return numNode(0);
    }

    /* <cmath> 取整函数：float / double 是「放大 1000 倍的 int32」，
       所以 floor/ceil/round 必须在放大后的值上做，最后再乘回 1000。
       走标准库 prelude 会被 char 形参截成 8 位，结果全错，只能在表达式层做。 */
    function mathFunc(name, e, line) {
      if (!e) return numNode(0);
      if (!isFloatExpr(e)) return e;          /* 整数输入：四个函数都是恒等 */

      /* 常量直接编译期算完，一条指令都不生成 */
      if (e.k === 'num') {
        var v = e.i32v != null ? e.i32v : (e.raw != null ? e.raw : e.v);
        var q;
        if (name === 'ceil') q = Math.ceil(v / FSCALE);
        else if (name === 'round') q = Math.floor((v + FSCALE / 2) / FSCALE);
        else q = Math.floor(v / FSCALE);      /* floor / trunc */
        return fnum(q * FSCALE);
      }

      var inner;
      if (name === 'ceil') {
        inner = { k: 'bin', op: '+', a: e, b: rawInt(FSCALE - 1), line: line };
      } else if (name === 'round') {
        inner = { k: 'bin', op: '+', a: e, b: rawInt(FSCALE / 2), line: line };
      } else {
        inner = e;                            /* floor / trunc */
      }
      return {
        k: 'mul', line: line,
        a: { k: 'div', a: inner, b: rawInt(FSCALE), line: line },
        b: rawInt(FSCALE)
      };
    }

    /* 函数式类型转换入口：tw 是一串类型词（unsigned char / long long …） */
    function functionalCast(tw, line) {
      var args = parseArgs();
      var kind = kindOf(tw);
      /* 值初始化：char() / int() → 0，string() → 空串，double() → 0.0 */
      if (!args.length) {
        if (kind === 'str') return { k: 'strlit', text: '', line: line };
        return numNode(0);
      }
      if (args.length > 1) {
        if (kind === 'str') return stringFill(args, line);
        warn('函数式转换 ' + tw.join(' ') + '(…) 只接受一个参数，多余的已忽略', line);
      }
      var e = args[0];
      if (kind === 'str') return toStrExpr(e, line);
      if (kind === 'void') return numNode(0);
      if (tw.indexOf('bool') >= 0) return boolExpr(e, line);
      var out = coerceTo(kind, e, line);
      if (kind === 'char' || kind === 'int') out = trunc8(out, line);
      return out;
    }

    /* 实参收敛：普通形参按类型截断；引用形参必须保持「左值」。
       用一个 Opt / Fold 都不认识的 refarg 节点包住变量名，
       免得编译期优化把 swap(x, y) 的 x / y 常量传播成 3 / 8 ——
       那样引用就绑不上去了。base 字段让「只写不读」分析仍能看到这次读取。 */
    function bindArgs(fn, args, line) {
      for (var ai = 0; ai < args.length; ai++) {
        /* 指针形参：&x / 数组名都要变成「目标变量名」，交给 inline 直接绑定 */
        if (fn.params[ai].ptr) {
          var pa = args[ai], pn2 = null;
          if (pa && (pa.k === 'ptrarg' || pa.k === 'refarg')) pn2 = pa.name;
          else if (pa && pa.k === 'var' && String(pa.name).indexOf('__') !== 0) pn2 = pa.name;
          if (pn2) args[ai] = { k: 'ptrarg', base: pn2, name: pn2, line: line };
          else if (pa && pa.k === 'strlit') {
            /* f("hi")：字符串字面量没有可绑定的存储位置。BF 里 char* 迭代
               走的是数组游标，字面量给不了；降级成 0 并明确告警，
               至少不能让 strlit 一路流到 codegen 变成非法表达式。 */
            warn('函数 ' + fn.name + ' 的指针参数 ' + fn.params[ai].name +
                 ' 收到字符串字面量（"…"）：BrainFuck 没有常量字符串区，已按空指针处理', line);
            args[ai] = numNode(0);
          } else {
            warn('函数 ' + fn.name + ' 的指针参数 ' + fn.params[ai].name +
                 ' 收到的不是地址，已按值传递', line);
            args[ai] = coerceTo(fn.params[ai].kind, args[ai], line);
          }
          continue;
        }
        if (fn.params[ai].ref) {
          var ra = args[ai];
          if (ra && ra.k === 'var') {
            var rf = { k: 'refarg', base: ra.name, name: ra.name, line: line };
            if (ra.arrRef) rf.arrRef = ra.arrRef;
            args[ai] = rf;
          } else {
            warn('函数 ' + fn.name + ' 的引用参数收到临时值，已退化为按值传递', line);
            args[ai] = coerceTo(fn.params[ai].kind, ra, line);
          }
          continue;
        }
        if (args[ai] && args[ai].k === 'strlit') {
          warn('函数 ' + fn.name + ' 的参数 ' + fn.params[ai].name +
               ' 收到字符串字面量，已按 0 降级（该形参不是 std::string）', line);
          args[ai] = numNode(0);
        } else {
          args[ai] = coerceTo(fn.params[ai].kind, args[ai], line);
        }
      }
      return args;
    }

    /* 表达式里的函数调用：先排成一条 callset 语句，再返回临时变量 */
    function callInExpr(name, line, args) {
      if (!args) args = parseArgs();
      var fn = funcs[name];
      if (!fn) throw new ParseError('函数 ' + name + ' 未定义（可用标准库函数见右上角「标准库」）', line);
      if (fn.params.length !== args.length) {
        throw new ParseError('函数 ' + name + ' 需要 ' + fn.params.length + ' 个参数，实际传入 ' + args.length + ' 个', line);
      }
      if (fn.kind === 'void') throw new ParseError('void 函数 ' + name + ' 不能出现在表达式里', line);

      bindArgs(fn, args, line);
      for (var ci = 0; ci < args.length; ci++) {
        if (args[ci] && args[ci].k === 'refarg' && args[ci].arrRef) {
          warn('函数 ' + name + ' 的引用实参是动态下标的数组元素，但这次调用写在表达式里，' +
               '改完的值不会写回数组；请把它拆成独立语句', line);
        }
      }

      var t = '__cr' + (tmpSeq++);
      /* 记住返回类型，cout << f(x) 才知道按数字还是字符输出；
         标准库函数用 outKind 区分（max→数字，toupper→字符）。 */
      varType[t] = fn.outKind || fn.kind;
      pending.push({ type: 'callset', target: t, fn: name, args: args, line: line });
      return { k: 'var', name: t, line: line };
    }

    /* std::string 的方法链：s.substr(1).length()、s[0] 之类 */
    function strChain(node, line) {
      while (is('.')) {
        var save = p;
        next();
        var meth = next().v || '';
        if (meth === 'length' || meth === 'size') {
          skipParens();
          node = { k: 'slen', a: node, line: line };
          continue;
        }
        if (meth === 'empty') {
          skipParens();
          node = { k: 'sempty', a: node, line: line };
          continue;
        }
        p = save;
        break;
      }
      return node;
    }

    /* std::string 的成员函数（表达式位置） */
    function strMethod(name, meth, line) {
      var base = { k: 'var', name: name, line: line };
      if (meth === 'length' || meth === 'size') {
        skipParens();
        return { k: 'slen', base: name, line: line };
      }
      if (meth === 'empty') {
        skipParens();
        return { k: 'sempty', base: name, line: line };
      }
      if (meth === 'at' || meth === 'operator[]') {
        expect('(');
        var ai = parseExpr();
        expect(')');
        return { k: 'sidx', base: name, idx: ai, line: line };
      }
      if (meth === 'substr') {
        expect('(');
        var pos = parseExpr();
        var len = null;
        if (accept(',')) len = parseExpr();
        expect(')');
        return { k: 'ssub', base: name, pos: pos, len: len, line: line };
      }
      if (meth === 'find') {
        expect('(');
        if (peek().t === 'str') {
          next();
          expect(')');
          warn('std::string::find 目前只支持单个字符，按未找到（255）处理', line);
          return { k: 'num', v: 255, line: line };
        }
        var ch = parseExpr();
        expect(')');
        return { k: 'sfind', base: name, ch: ch, line: line };
      }
      if (meth === 'c_str' || meth === 'data') {
        skipParens();
        return base;
      }
      if (meth === 'front') { skipParens(); return { k: 'sidx', base: name, idx: { k: 'num', v: 0 }, line: line }; }
      if (meth === 'back') {
        skipParens();
        return { k: 'sidx', base: name, idx: { k: 'bin', op: '-',
                 a: { k: 'slen', base: name, line: line }, b: { k: 'num', v: 1 } }, line: line };
      }
      if (meth === 'clear' || meth === 'pop_back' || meth === 'push_back' ||
          meth === 'append' || meth === 'assign' || meth === 'resize') {
        throw new ParseError('std::string::' + meth + '() 只能作为独立语句使用（不能写在表达式里）', line);
      }
      skipParens();
      warn('std::string 的 ' + meth + '() 暂不支持，已按 0 处理', line);
      return { k: 'num', v: 0, line: line };
    }

    function parseArgs() {
      expect('(');
      var args = [];
      if (!is(')')) {
        for (;;) {
          args.push(parseExpr());
          if (accept(',')) continue;
          break;
        }
      }
      expect(')');
      return args;
    }

    /* ---------------- 条件表达式 ---------------- */
    function parseCondExpr() {
      var l = parseOr();
      return l;
    }

    function parseOr() {
      var l = parseAnd();
      while (is('||')) {
        var line = lineNow();
        next();
        l = { k: 'or', a: l, b: parseAnd(), line: line };
      }
      return l;
    }

    function parseAnd() {
      var l = parseUnary();
      while (is('&&')) {
        var line = lineNow();
        next();
        l = { k: 'and', a: l, b: parseUnary(), line: line };
      }
      return l;
    }

    /* if (!(cin >> x))：BF 输入是字节流，没有「读取失败 / EOF」的概念。
       生成一次读入，并把「是否失败」恒定为假，让程序走正常输入路径。 */
    function tryCinRead() {
      if (!(is('!') && peek().t === 'op')) return null;
      var q = p;
      var line = lineNow();
      next();                                        /* ! */
      if (!accept('(')) { p = q; return null; }
      if (is('std') && peek(1).v === '::') p += 2;
      if (!is('cin')) { p = q; return null; }
      next();
      if (!is('>>')) { p = q; return null; }
      next();
      if (peek().t !== 'id') { p = q; return null; }
      var vn = next().v;
      if (!accept(')')) { p = q; return null; }
      pending.push({ type: 'innum', name: vn, line: line,
                     dec: varType[vn] === 'f32' ? 3 : 0 });
      warn('cin >> 的失败 / EOF 判断在 BrainFuck 里没有对应能力，已按「读取成功」处理', line);
      return { k: 'num', v: 0, line: line };
    }

    function parseUnary() {
      var cr = tryCinRead();
      if (cr) return cr;
      if (is('!') && peek().t === 'op') {
        var line = lineNow();
        next();
        return { k: 'not', a: parseUnary(), line: line };
      }
      return parseCmp();
    }

    function parseCmp() {
      var l = parseCmpOperand();
      var tk = peek();
      if (tk.t === 'op' && ['<', '>', '<=', '>=', '==', '!='].indexOf(tk.v) >= 0) {
        next();
        var r = parseCmpOperand();
        /* 两侧只要有一边是 std::string，就按字符串字典序比较（与 C++ 一致） */
        if (isStrExpr(l) || isStrExpr(r)) {
          return { k: 'scmp', op: tk.v, a: l, b: r, line: tk.line };
        }
        /* 有一边是 float：两边都放大成定点数，比较的就是真实数值 */
        if (isFloatExpr(l) || isFloatExpr(r)) {
          l = toFloat(l, tk.line);
          r = toFloat(r, tk.line);
        }
        return { k: 'cmp', op: tk.v, a: l, b: r, line: tk.line };
      }
      return l;
    }

    /* 比较的操作数；括号里如果是整段条件（如 !(a > 5)），要整体当一个条件 */
    function parseCmpOperand() {
      /* 这里只吃「位运算 / 算术」，条件本身由 parseCondExpr 组装；
         不能回到 parseExpr（含三元），否则会无限递归。 */
      if (!is('(')) return parseBitOr();
      var save = p;
      try {
        next();
        var inner = parseCondExpr();
        expect(')');
        if (inner.k === 'cmp' || inner.k === 'and' || inner.k === 'or' || inner.k === 'not') return inner;
      } catch (e) { /* 不是条件，退回普通表达式 */ }
      p = save;
      return parseBitOr();
    }

    /* 循环条件额外支持 n-- / n++ 这种"用完再减"的写法 */
    function parseLoopCond() {
      var e = parseTernary();
      if ((is('--') || is('++')) && e.k === 'var') {
        var op = next().v;
        return { expr: { k: 'var', name: e.name, line: e.line }, post: op === '--' ? '-' : '+' };
      }
      return { expr: e, post: null };
    }

    /* ---------------- 语句 ---------------- */
    function parseBlock() {
      expect('{');
      var list = [];
      var guard = 0;
      while (!eof() && !is('}') && guard++ < 20000) {
        var arr = stmtWithPending();
        if (arr.length) list.push.apply(list, arr);
      }
      expect('}');
      return list;
    }

    function parseDeclList() {
      var line = lineNow();
      var toks = eatType();
      var kind = kindOf(toks);
      var isConst = toks.indexOf('const') >= 0 || toks.indexOf('constexpr') >= 0;
      var out = [];

      for (;;) {
        /* int& / int* / int&&：& 是真引用，* 是编译期指针 */
        var isRef = false, isPtr = false, ptrStars = 0;
        while (is('*') || is('&') || is('&&')) {
          if (is('&')) { next(); isRef = true; continue; }
          if (is('&&')) { next(); warn('右值引用（&&）按普通变量处理：会复制一份', line); continue; }
          next(); isPtr = true; ptrStars++;
        }
        var name = expectId();

        /* int& r = x; —— 引用就是别名，不占单元格 */
        if (isRef) {
          out.push.apply(out, parseRefDecl(name, kind, line, isConst));
          if (accept(',')) continue;
          break;
        }

        /* int *p = &a;  指针绑定到「目标变量名」，本身不占单元格 */
        if (isPtr) {
          /* char *s = "hi"; —— 字符串字面量在 BF 里就是定长字节缓冲，
             按 std::string 处理，printf("%s", s) / s[i] 都能用。 */
          if (is('=') && peek(1).t === 'str') {
            next();
            var slit = next().v;
            varType[name] = 'str';
            out.push({ type: 'sset', name: name, line: line,
                       expr: { k: 'strlit', text: slit, line: line } });
            warn('char *' + name + ' 指向字符串字面量：已按 std::string 处理' +
                 '（*' + name + ' / ' + name + '++ 不适用）', line);
            if (accept(',')) continue;
            break;
          }
          if (ptrStars > 1) warn('二级指针 ** 不支持，' + name + ' 已按一级指针处理', line);
          var pinit = null;
          if (accept('=')) pinit = readAddr(line);
          var ppre = bindPtr(name, pinit || { null: true }, kind, line);
          if (ppre) out.push(ppre);
          if (!pinit) warn('指针 ' + name + ' 声明时没有初始化，已按空指针处理', line);
          if (accept(',')) continue;
          break;
        }

        /* int a[10];  int m[3][4] = {{…}};  char buf[] = "hi"; */
        if (is('[')) {
          out.push.apply(out, parseArrayDecl(name, kind, line, isConst));
          if (accept(',')) continue;
          break;
        }

        varType[name] = kind;
        var init = null;
        if (accept('=')) {
          init = coerceTo(kind, parseExpr(), line);
          if (isConst) {
            var cv = constOf(init);
            if (cv != null) constVals[name] = cv;
          }
        }
        out.push({ type: 'decl', name: name, init: init, kind: kind, line: line });
        if (accept(',')) continue;
        break;
      }
      expect(';');
      return out;
    }

    /* 函数定义：类型 名字 ( 参数 ) { ... } */
    function parseFuncDef(typeToks) {
      var line = lineNow();
      var name = next().v;
      var kind = kindOf(typeToks);
      if (kind === 'i32') {
        kind = 'int';
        warn('函数 ' + name + ' 的返回值暂不支持 int32，已按 8 位处理', line);
      }
      if (kind === 'f32') {
        kind = 'int';
        warn('函数 ' + name + ' 的返回值暂不支持 float / double，已按 8 位处理', line);
      }
      if (kind === 'str') {
        kind = 'int';
        warn('函数 ' + name + ' 的返回值暂不支持 std::string，已按 8 位处理（请改用全局字符串变量）', line);
      }

      expect('(');
      var params = [];
      if (!is(')')) {
        if (peek().v === 'void' && peek(1).v === ')') {
          next();
        } else {
          for (;;) {
            var pt = eatType();
            /* int& v / const int& v —— 引用形参，调用点内联时直接绑到实参上 */
            var pRef = false, pPtr = false;
            while (is('&') || is('&&') || is('*')) {
              if (is('&')) { next(); pRef = true; continue; }
              if (is('&&')) { next(); warn('右值引用参数按值传递（会复制一份）', line); continue; }
              next(); pPtr = true;
            }
            var pn = expectId();
            var pk = kindOf(pt);
            /* int a[] / int a[10] 作形参：C 里它其实是指针，BrainFuck 没指针 */
            if (is('[')) {
              while (is('[')) { next(); if (!is(']')) parseExpr(); expect(']'); }
              warn('函数 ' + name + ' 的参数 ' + pn + ' 写成了数组：BrainFuck 没有指针，' +
                   '已按单个 8 位值处理（数组请用全局数组）', line);
            }
            if (pk === 'i32') {
              pk = 'int';
              warn('函数 ' + name + ' 的参数 ' + pn + ' 暂不支持 int32，已按 8 位处理', line);
            }
            if (pk === 'f32') {
              pk = 'int';
              warn('函数 ' + name + ' 的参数 ' + pn + ' 暂不支持 float / double，已按 8 位处理', line);
            }
            if (pk === 'str') {
              pk = 'int';
              warn('函数 ' + name + ' 的参数 ' + pn + ' 暂不支持 std::string，已按 8 位处理（请改用全局字符串变量）', line);
            }
            varType[pn] = pk;
            if (accept('=')) { parseExpr(); warn('参数默认值已忽略', line); }
            if (pPtr) bindPtr(pn, {}, pk, line, true);
            params.push({ name: pn, kind: pk, ref: pRef, ptr: pPtr });
            if (accept(',')) continue;
            break;
          }
        }
      }
      expect(')');
      if (accept(';')) {
        /* 只有声明：登记下来，等后面的定义补全（互递归要用到） */
        if (!funcs[name]) {
          funcs[name] = { name: name, params: params, kind: kind, body: null,
                          retName: '__ret_' + name, line: line };
        }
        return [];
      }

      if (!is('{')) throw new ParseError('函数 ' + name + ' 的定义缺少 {', line);

      /* 先登记再解析函数体，这样函数体里就能调用自己（递归） */
      var entry = {
        name: name,
        params: params,
        kind: kind,
        body: [],
        retName: '__ret_' + name,
        line: line
      };
      funcs[name] = entry;

      var prev = curFn;
      /* 函数里的引用别名不能泄漏到函数外：用原型链做一层作用域 */
      var prevAlias = aliases;
      aliases = Object.create(prevAlias);
      /* 函数里的指针绑定也不能泄漏到函数外 */
      var prevPtr = pointers;
      pointers = Object.create(prevPtr);
      var isEntry = (name === 'main');
      curFn = { name: name, entry: isEntry, kind: kind };
      var body = parseBlock();
      curFn = prev;
      aliases = prevAlias;
      pointers = prevPtr;

      if (isEntry) {
        delete funcs[name];
        return body;                             /* main 直接内联成入口代码 */
      }

      entry.body = body;
      return [];
    }

    /* 顶层：可能是函数定义，也可能是普通声明 / 语句 */
    function parseTopLevel() {
      /* struct 类型名不是内置类型词，得单独接住 */
      if (peek().t === 'id' && structs[peek().v]) {
        return parseStructDecl(next().v, lineNow(), false);
      }
      if ((peek().v === 'const' || peek().v === 'constexpr') &&
          peek(1).t === 'id' && structs[peek(1).v]) {
        next();
        return parseStructDecl(next().v, lineNow(), true);
      }
      if (isTypeKw(peek().v) || isMod(peek().v)) {
        var start = p;
        var toks = eatType();
        /* int& f(...)：返回引用 —— BF 没有指针，按值返回并告警 */
        var retRef = false;
        while (is('&') || is('&&') || is('*')) {
          if (is('&')) retRef = true;
          next();
        }
        if (peek().t === 'id' && peek(1).v === '(') {
          if (retRef) {
            warn('函数 ' + peek().v + ' 返回的是引用：BrainFuck 没有指针，已按值返回', lineNow());
          }
          return parseFuncDef(toks);
        }
        p = start;
        var d = parseDeclList();
        var pre = takePending();
        return pre.concat(d);
      }
      return stmtWithPending();
    }

    function parseStmt() {
      if (eof()) return null;
      var tk = peek();
      var line = tk.line;

      /* C++ std:: 前缀：cout / cin / endl 各有专门解析，其余统一剥成普通标识符 */
      if (tk.t === 'id' && tk.v === 'std' && peek(1).v === '::' &&
          ['cout', 'cin', 'endl'].indexOf(peek(2).v) < 0) {
        next(); next();
        tk = peek();
        line = tk.line;
      }

      /* std::cin.clear() / .ignore(...) 等流方法：BF 输入队列没有这些状态，整条忽略。
         只对 cin / cout 这类真正的流对象生效 —— std::string 也有 clear()，
         不能一起吞掉。 */
      if (tk.t === 'id') {
        var off = (tk.v === 'std' && peek(1).v === '::') ? 2 : 0;
        var fobj = peek(off).v;
        var isStream = (fobj === 'cin' || fobj === 'cout' || fobj === 'cerr' ||
                        fobj === 'clog' || fobj === 'stdin' || fobj === 'stdout');
        if (isStream && peek(off + 1).v === '.' && FLOW_METHODS[peek(off + 2).v]) {
          var fmth = peek(off + 2).v;
          skipTo(';');
          warn('流方法 ' + fobj + '.' + fmth + '(...) 在 BrainFuck 里已忽略', line);
          return null;
        }
      }

      if (tk.v === ';' && tk.t === 'op') { next(); return null; }

      /* struct 类型声明（函数内 / 顶层经由 stmtWithPending 都会到这里） */
      if (tk.t === 'id' && structs[tk.v]) {
        return parseStructDecl(next().v, line, false);
      }
      if ((tk.v === 'const' || tk.v === 'constexpr') &&
          peek(1).t === 'id' && structs[peek(1).v]) {
        next();
        return parseStructDecl(next().v, line, true);
      }

      /* 语句位置的解引用：*p = 5; / (*p)++; / *p += 2; */
      if (tk.v === '*' && tk.t === 'op') return stmtWithPendingDeref(line, false);
      if (tk.v === '(' && tk.t === 'op' && peek(1).v === '*') {
        return stmtWithPendingDeref(line, true);
      }

      /* 前缀自增 / 自减：++i;  --i;  ++a[i]; */
      if ((tk.v === '++' || tk.v === '--') && tk.t === 'op') {
        var preOp = next().v;
        var preName = expectId();
        if (pointers[preName]) {
          expect(';');
          return ptrStep(preName, preOp === '++' ? 1 : -1, line);
        }
        if (arrays[preName] && is('[')) {
          var preIdx = parseIdxs();
          expect(';');
          return arrayWrite(preName, preIdx, line, preOp === '++' ? 'inc' : 'dec');
        }
        expect(';');
        if (varType[preName] === 'f32') {
          return { type: preOp === '++' ? 'add' : 'sub', name: preName,
                   expr: fnum(FSCALE), line: line };
        }
        return { type: preOp === '++' ? 'add' : 'sub', name: preName,
                 expr: { k: 'num', v: 1 }, line: line };
      }
      if (tk.v === '{') return parseBlock();
      if (tk.v === 'while') return parseWhile();
      if (tk.v === 'if') return parseIf();
      if (tk.v === 'switch') return parseSwitch();
      if (tk.v === 'for') return parseFor();
      if (tk.v === 'do') return parseDo();

      if (tk.v === 'return') {
        next();
        var re = is(';') ? null : parseExpr();
        expect(';');
        if (!curFn) { warn('return 出现在函数外，已忽略', line); return null; }
        /* main 里的 return 表示「程序到此结束」，也要生成节点 —— 由内联层
           用「继续执行标志」实现（BrainFuck 没有跳转指令）。 */
        var retEntry = !!curFn.entry;
        if (!re && !retEntry && curFn.kind !== 'void') {
          throw new ParseError('函数 ' + curFn.name + ' 需要 return 一个值', line);
        }
        if (re && curFn.kind === 'void') {
          warn('void 函数 ' + curFn.name + ' 的 return 值会被丢弃', line);
        }
        return { type: 'ret', expr: re, line: line, entry: retEntry };
      }

      if (tk.v === 'break' || tk.v === 'continue') {
        next();
        expect(';');
        /* break 落在 switch 里时跳的是 switch，if-else 链天然跳出，不用生成 brk。
           只有当 loopDepth 比进入 switch 时更深（switch 内嵌了循环），
           这个 break 才属于那个内层循环。 */
        if (tk.v === 'break' && switchLoop.length &&
            loopDepth === switchLoop[switchLoop.length - 1]) {
          var sgo = switchGo[switchGo.length - 1];
          return { type: 'set', name: sgo, expr: numNode(0), line: line,
                   __swBreak: true, text: 'break（跳出 switch）' };
        }
        if (!loopDepth) {
          warn(tk.v + ' 不在循环里，已忽略', line);
          return null;
        }
        return { type: tk.v === 'break' ? 'brk' : 'cont', line: line };
      }

      /* class / struct：降级成「全局变量 + 普通函数」（单对象等价） */
      if (tk.v === 'class' || tk.v === 'struct') return parseClass();

      /* C++ 里与本编译器无关的写法 */
      if (tk.v === 'using' || tk.v === 'namespace' || tk.v === 'typedef' || tk.v === 'template') {
        skipTo(';');
        return null;
      }

      if (isTypeKw(tk.v) || isMod(tk.v)) {
        var save = p;
        var toks = eatType();
        var retRef2 = false;
        while (is('&') || is('&&') || is('*')) {
          if (is('&')) retRef2 = true;
          next();
        }
        if (peek().t === 'id' && peek(1).v === '(') {
          if (retRef2) {
            warn('函数 ' + peek().v + ' 返回的是引用：BrainFuck 没有指针，已按值返回', line);
          }
          return parseFuncDef(toks);                    /* 语句位置出现的嵌套函数定义 */
        }
        p = save;
        return parseDeclList();
      }

      /* std::cin.get(ch); 独立语句：只读一个字符，不用它的返回值 */
      if ((tk.v === 'cin' || (tk.v === 'std' && peek(2).v === 'cin')) &&
          (function () {
            var o = (tk.v === 'std') ? 2 : 0;
            return peek(o + 1).v === '.' && peek(o + 2).v === 'get';
          })()) {
        if (tk.v === 'std') { next(); next(); }
        next(); next();                    /* cin . get */
        expect('(');
        var cg2 = resolveAlias(expectId());
        expect(')');
        expect(';');
        return { type: 'in', name: cg2, line: line };
      }

      if (tk.v === 'putchar' || tk.v === 'putc') {
        next();
        expect('(');
        var e = parseExpr();
        expect(')');
        expect(';');
        return { type: 'out', expr: e, line: line };
      }

      /* puts("…")：等价 printf("…\n")，走字符串直出路径 */
      if (tk.v === 'puts') {
        next();
        expect('(');
        if (peek().t !== 'str') throw new ParseError('puts() 这里需要一个字符串字面量', line);
        var ps = next().v;
        expect(')');
        expect(';');
        return { type: 'outstr', text: ps + '\n', line: line };
      }

      if (tk.v === 'printnum' || tk.v === 'putnum') {
        next();
        expect('(');
        var en = parseExpr();
        expect(')');
        expect(';');
        return { type: 'outdec', expr: en, line: line };
      }

      if (tk.v === 'printf') return parsePrintf();
      if (tk.v === 'scanf') return parseScanf();

      /* getline(cin, s)：读到换行为止（换行本身被吃掉，与 C++ 一致） */
      if (tk.v === 'getline') {
        next();
        expect('(');
        if (is('std')) { next(); expect('::'); }
        var gsrc = expectId();
        expect(',');
        var gname = expectId();
        if (accept(',')) {
          parseExpr();
          warn('getline 的自定义分隔符已忽略（固定读到换行）', line);
        }
        expect(')');
        expect(';');
        if (varType[gname] !== 'str') {
          throw new ParseError('getline 的第二个参数必须是 std::string 变量', line);
        }
        if (gsrc !== 'cin') warn('getline 只支持 cin，已按标准输入读取', line);
        return { type: 'sin', name: gname, mode: 'line', line: line };
      }
      if (tk.v === 'cout') return parseCout();
      if (tk.v === 'cin') return parseCin();
      if (tk.v === 'std' && peek(1).v === '::' && peek(2).v === 'cout') return parseCout();
      if (tk.v === 'std' && peek(1).v === '::' && peek(2).v === 'cin') return parseCin();

      /* ClassName obj(args); —— 执行构造参数并生成成员初始化语句 */
      if (tk.t === 'id' && classes[tk.v] && peek(1).t === 'id' && peek(2).v === '(') {
        return parseObjectDecl(tk.v, line);
      }

      /* struct 变量在语句位置：h.a = … / history[i] = {…} / history[i] = history[j] */
      if (tk.t === 'id' &&
          (structVars[tk.v] || (aliases[tk.v] && aliases[tk.v].structRef))) {
        return structStmt(line);
      }

      if (tk.t === 'id') return parseIdStmt();

      warn('无法识别的语句，已跳过：' + tk.v, line);
      skipTo(';');
      return null;
    }

    /* ---------------- C++ 类降级 ----------------
     * BrainFuck 没有对象模型。单对象场景下把类摊平是等价的：
     *   成员变量 → 全局变量；成员方法 → 同名普通函数；构造 → 一段初始化语句。
     * 方法体里引用成员变量时，inline 不会给全局名改前缀，正好读写同一格。
     */
    function parseClass() {
      var line = lineNow();
      var kw = next().v;                          /* class / struct */
      if (peek().t !== 'id') { skipTo(';'); warn('无法识别的类定义，已跳过', line); return null; }
      var cls = next().v;
      if (accept(':')) { while (!eof() && !is('{') && !is(';')) next(); }
      if (!is('{')) { skipTo(';'); return null; }

      /* 纯字段 struct（花括号里没有 '('，即没有方法 / 构造函数）：
         走「结构体数组」实现，而不是老的单对象降级。 */
      if (kw === 'struct') {
        var q = p, depth = 0, plain = true;
        while (q < toks.length && toks[q].v !== undefined) {
          var tv = toks[q].v;
          if (tv === '{') depth++;
          else if (tv === '}') { depth--; if (depth === 0) break; }
          else if (tv === '(' || tv === '=') { plain = false; break; }
          q++;
        }
        if (plain) return parsePlainStruct(cls, line);
      }
      next();                                     /* { */

      var entry = { fields: [], ctor: null };
      classes[cls] = entry;
      warn('类 ' + cls + ' 已降级：成员变量→全局变量，成员方法→普通函数（单对象等价）', line);

      var body = [];
      var guard = 0;
      while (!eof() && !is('}') && guard++ < 3000) {
        if ((is('public') || is('private') || is('protected')) && peek(1).v === ':') {
          next(); next(); continue;
        }
        /* 构造函数：[explicit / constexpr] ClassName(params) : field(expr), … {} */
        var probe = 0;
        while (['explicit', 'constexpr', 'inline', 'virtual'].indexOf(peek(probe).v) >= 0) probe++;
        if (peek(probe).v === cls && peek(probe + 1).v === '(') {
          for (var z = 0; z < probe; z++) next();
          parseCtor(cls, entry);
          continue;
        }
        var arr = toArray(parseTopLevel());
        if (arr.length) body.push.apply(body, arr);
      }
      expect('}');
      expect(';');
      return body;
    }

    /* struct H { char op; double a, b; }; —— 只登记字段，不生成任何语句 */
    function parsePlainStruct(cls, line) {
      next();                                     /* { */
      var fields = [], guard = 0;
      while (!eof() && !is('}') && guard++ < 500) {
        if ((is('public') || is('private') || is('protected')) && peek(1).v === ':') {
          next(); next(); continue;
        }
        if (is(';')) { next(); continue; }
        var ft = eatType();
        if (!ft.length) { next(); continue; }
        var fk = kindOf(ft);
        for (;;) {
          var fn = expectId();
          /* 字段里的定长数组暂不摊开，按标量处理 */
          if (is('[')) { while (!eof() && !is(']')) next(); expect(']');
                         warn('struct ' + cls + ' 的字段 ' + fn + '[] 暂按标量处理', line); }
          fields.push({ name: fn, kind: fk });
          if (accept(',')) continue;
          break;
        }
        expect(';');
      }
      expect('}');
      expect(';');
      if (!fields.length) { warn('struct ' + cls + ' 没有可用字段', line); return []; }
      structs[cls] = { fields: fields };
      warn('struct ' + cls + ' 已摊平：' + fields.length + ' 个字段各自成为独立单元格' +
           '（' + fields.map(function (f) { return f.name; }).join(' / ') + '）', line);
      return [];
    }

    /* 结构体变量声明：H h; / H arr[50]; / const H& r = arr[i]; */
    function parseStructDecl(cls, line, isConst) {
      var def = structs[cls];
      var out = [];
      for (;;) {
        var isRef = false;
        while (is('*') || is('&') || is('&&')) {
          if (is('&')) isRef = true;
          else if (is('&&')) warn('右值引用按普通变量处理', line);
          next();
        }
        var name = expectId();
        var dims = [];
        while (is('[')) {
          next();
          if (is(']')) {
            warn('struct ' + cls + ' ' + name + '[] 缺少长度，已按 1 处理', line);
            dims.push(1);
          } else {
            var de = parseExpr();
            var cv = constOf(de);
            if (cv == null || cv < 1) {
              throw new ParseError('struct 数组的每一维长度必须是编译期常量', line);
            }
            dims.push(cv);
          }
          expect(']');
        }
        if (!dims.length) dims = [1];
        var total = product(dims);

        /* const H& r = arr[i]：r 只是别名，绝不能注册成结构体变量，
           否则 r.a 会被解析到 r.a[0] 这个不存在的格子里。 */
        if (isRef) {
          if (!accept('=')) {
            throw new ParseError('结构体引用 ' + name + ' 必须在声明时绑定', line);
          }
          var rr = readStructRef(line);
          var snap = snapStructIdxs(rr.idxs, line, out);
          aliases[name] = { structRef: { sv: rr.sv, idxs: snap },
                            readonly: !!isConst };
          varType[name] = 'int';
        } else {
          var fmap = {};
          def.fields.forEach(function (f) {
            var vname = name + '.' + f.name;
            arrays[vname] = {
              name: vname, dims: dims.slice(), kind: f.kind, total: total,
              isConst: false, virtual: 1
            };
            fmap[f.name] = vname;
            for (var k = 0; k < total; k++) {
              varType[elemName(vname, unlinear(k, dims))] = f.kind;
            }
          });
          structVars[name] = { type: cls, dims: dims, total: total,
                               fields: def.fields, arrays: fmap, name: name };
        }
        if (accept(',')) continue;
        break;
      }
      expect(';');
      return out.concat(takePending());
    }

    /* 读一个「结构体元素」引用：history[i] / h / arr[1][2] */
    function readStructRef(line) {
      var nm = next().v;
      if (aliases[nm] && aliases[nm].structRef) {
        var sr = aliases[nm].structRef;
        return { sv: sr.sv, idxs: sr.idxs.slice() };
      }
      var sv = structVars[nm];
      if (!sv) throw new ParseError(nm + ' 不是结构体变量', line);
      var idxs = is('[') ? parseIdxs() : [numNode(0)];
      return { sv: sv, idxs: idxs };
    }

    /* 把下标快照进临时格：聚合赋值 / 结构体拷贝里，右侧和每个字段
       都得用同一个下标，不能让 historyCount++ 被求值 N 次。 */
    function snapStructIdxs(idxs, line, out) {
      return idxs.map(function (e) {
        if (constOf(e) != null) return e;
        var t = '__ss' + (tmpSeq++);
        varType[t] = 'int';
        out.push({ type: 'decl', name: t, line: line });
        out.push({ type: 'set', name: t, expr: toByte(e, line), line: line,
                   text: '结构体下标快照' });
        return { k: 'var', name: t, line: line };
      });
    }

    /* 表达式位置的 h.op / history[i].a / ptr->field */
    function structMemberRead(name, line) {
      var sv, idxs;
      if (aliases[name] && aliases[name].structRef) {
        sv = aliases[name].structRef.sv;
        idxs = aliases[name].structRef.idxs.slice();
      } else if (structVars[name]) {
        sv = structVars[name];
        idxs = is('[') ? parseIdxs() : [numNode(0)];
      } else return null;
      if (!is('.') && !is('->')) return null;
      next();
      var fld = next().v || '';
      var va = sv.arrays[fld];
      if (!va) {
        warn('struct ' + sv.type + ' 没有字段 ' + fld + '，已按 0 处理', line);
        return numNode(0);
      }
      return arrayReadIdx(va, idxs, line);
    }

    /* 语句位置的结构体：h.a = 3 / history[i].op = '+' /
       history[n++] = {op,a,b,result} / history[i-1] = history[i] */
    function structStmt(line) {
      var name = next().v;
      var sv, idxs;
      if (aliases[name] && aliases[name].structRef) {
        var sr = aliases[name].structRef;
        sv = sr.sv; idxs = sr.idxs.slice();
      } else {
        sv = structVars[name];
        idxs = is('[') ? parseIdxs() : [numNode(0)];
      }
      var pre = takePending();
      if (aliases[name] && aliases[name].readonly) {
        throw new ParseError('const 引用 ' + name + ' 是只读的，不能赋值', line);
      }
      var snap = snapStructIdxs(idxs, line, pre);

      /* 单个字段赋值 */
      if (is('.') || is('->')) {
        next();
        var fld = next().v || '';
        var va = sv.arrays[fld];
        if (!va) {
          warn('struct ' + sv.type + ' 没有字段 ' + fld + '，这条赋值已跳过', line);
          skipTo(';');
          return pre;
        }
        if (accept('++')) { expect(';'); return pre.concat(arrayWrite(va, snap, line, 'inc')); }
        if (accept('--')) { expect(';'); return pre.concat(arrayWrite(va, snap, line, 'dec')); }
        if (accept('+=')) {
          var se = parseExpr(); expect(';');
          return pre.concat(takePending(), arrayWrite(va, snap, line, 'add', se));
        }
        if (accept('-=')) {
          var se2 = parseExpr(); expect(';');
          return pre.concat(takePending(), arrayWrite(va, snap, line, 'sub', se2));
        }
        if (accept('=')) {
          var se3 = parseExpr(); expect(';');
          return pre.concat(takePending(), arrayWrite(va, snap, line, 'set', se3));
        }
        warn('结构体字段 ' + fld + ' 的这个操作不支持，已跳过', line);
        skipTo(';');
        return pre;
      }

      if (!accept('=')) {
        warn('结构体 ' + name + ' 的这条语句无法理解，已跳过', line);
        skipTo(';');
        return pre;
      }

      /* 聚合初始化：history[n++] = {op, a, b, result}; */
      if (is('{')) {
        next();
        var vals = [], guard = 0;
        while (!eof() && !is('}') && guard++ < 200) {
          vals.push(parseExpr());
          if (!accept(',')) break;
        }
        expect('}');
        expect(';');
        var ao = pre.concat(takePending());
        if (vals.length > sv.fields.length) {
          warn('聚合初始化的值比字段多，多余部分已忽略', line);
        }
        sv.fields.forEach(function (f, i) {
          ao = ao.concat(arrayWrite(sv.arrays[f.name], snap, line,
                                    'set', vals[i] || numNode(0)));
        });
        return ao;
      }

      /* 结构体整体拷贝：history[i-1] = history[i]; */
      if (peek().t === 'id' &&
          (structVars[peek().v] || (aliases[peek().v] && aliases[peek().v].structRef))) {
        var rr = readStructRef(line);
        var rsnap = snapStructIdxs(rr.idxs, line, pre);
        expect(';');
        var co = pre.concat(takePending());
        sv.fields.forEach(function (f) {
          var rva = rr.sv.arrays[f.name];
          if (!rva) return;
          var v = arrayReadIdx(rva, rsnap, line);
          co = co.concat(takePending());
          co = co.concat(arrayWrite(sv.arrays[f.name], snap, line, 'set', v));
        });
        return co;
      }

      warn('结构体 ' + name + ' 的赋值只支持 { … } 或另一个同类型结构体，已跳过', line);
      skipTo(';');
      return pre;
    }

    /* switch / case / default → if-else 链。
       BrainFuck 没有跳转表，但「把选择子存进一格，再逐条比较」是等价的。
       连续 case 标签（case 1: case 2: …）合成一个 or 条件；
       switch 里的 break 不生成 brk —— if-else 链天然就跳出去了。 */
    function parseSwitch() {
      var line = lineNow();
      next();                                    /* switch */
      expect('(');
      var sel = parseExpr();
      expect(')');
      var pre = takePending();
      var sn = '__sw' + (tmpSeq++);
      var go = '__swgo' + (tmpSeq++);
      varType[sn] = 'int'; varType[go] = 'int';
      pre.push({ type: 'decl', name: sn, line: line });
      pre.push({ type: 'set', name: sn, expr: toByte(sel, line), line: line,
                 text: 'switch 选择子' });
      pre.push({ type: 'decl', name: go, line: line });
      pre.push({ type: 'set', name: go, expr: numNode(1), line: line,
                 text: 'switch 继续执行标志 = 1' });
      expect('{');
      switchGo.push(go);

      var cases = [], dflt = null, cur = null, guard = 0;
      switchLoop.push(loopDepth);
      while (!eof() && !is('}') && guard++ < 3000) {
        if (accept('case')) {
          var lab = parseExpr();
          expect(':');
          /* 连续 case 标签（中间没有语句）共用一个分支；
             上一分支已经有语句了就必须另起一个。 */
          if (!cur || cur.body.length) {
            cur = { labels: [], body: [], hasBreak: false };
            cases.push(cur);
          }
          cur.labels.push(lab);
          continue;
        }
        if (accept('default')) {
          expect(':');
          dflt = { body: [], hasBreak: false };
          cur = { labels: null, body: dflt.body,
                  hasBreak: false, isDefault: true };
          continue;
        }
        if (is(';')) { next(); continue; }
        if (!cur) {                             /* case 之前的散语句：忽略 */
          skipTo(';'); continue;
        }
        var one = stmtWithPending();
        /* 必须用 push 保持 cur.body 与 dflt.body 是同一个数组对象，
           否则 default 分支的内容会写进另一份数组里丢失。 */
        cur.body.push.apply(cur.body, toArray(one));
        if (cur.isDefault) dflt.hasBreak = hasBrk(one) || dflt.hasBreak;
        else cur.hasBreak = hasBrk(one) || cur.hasBreak;
      }
      switchLoop.pop();
      switchGo.pop();
      expect('}');

      /* break 之后的语句不许再执行：用 go 标志包一层 if。
         if 块里的 break 也要能挡住它后面的语句，正是这里处理的。 */
      cases.forEach(function (c) { c.body = guardSwitchBody(c.body, go, line); });
      if (dflt) dflt.body = guardSwitchBody(dflt.body, go, line);

      /* 没有 break 的分支按 C++ 语义贯穿：把后面分支的语句也接进来 */
      for (var ci = 0; ci < cases.length; ci++) {
        if (cases[ci].hasBreak) continue;
        var extra = [];
        for (var cj = ci + 1; cj < cases.length; cj++) {
          extra = extra.concat(cases[cj].body);
          if (cases[cj].hasBreak) break;
        }
        if (!cases[ci].hasBreak && (extra.length || dflt)) {
          warn('switch 里有无 break 的 case，已按 C++ 贯穿语义展开', line);
          cases[ci].body = cases[ci].body.concat(extra, dflt ? dflt.body : []);
          cases[ci].hasBreak = true;
        }
      }

      function cmpOf(labels) {
        var c = null;
        labels.forEach(function (l) {
          var one2 = { k: 'cmp', op: '==', a: { k: 'var', name: sn, line: line },
                       b: l, line: line };
          c = c ? { k: 'or', a: c, b: one2, line: line } : one2;
        });
        return c || { k: 'num', v: 0, line: line };
      }
      function build(i) {
        if (i >= cases.length) return dflt ? dflt.body : [];
        return [{
          type: 'if', cond: cmpOf(cases[i].labels),
          then: cases[i].body, else: build(i + 1),
          line: line, text: 'switch case ' + (i + 1)
        }];
      }
      return pre.concat(build(0));
    }

    /* break 之后的语句包进 if (go)：C++ 里 break 一执行，
       同一分支后面的语句就不再跑了。 */
    function guardSwitchBody(body, go, line) {
      var out = [], dead = false;
      (body || []).forEach(function (n) {
        if (!n) return;
        if (dead) {
          out.push({ type: 'if', cond: V(go, line), then: [n], else: null,
                     line: line, text: '（switch 已 break，跳过）' });
          return;
        }
        out.push(n);
        if (n.type === 'set' && n.__swBreak) dead = true;
        else if (n.type === 'if' && hasBrk([n])) dead = true;
      });
      return out;
    }

    /* 一段语句里有没有 break（仅看本层，不钻进内层 switch） */
    function hasBrk(nodes) {
      var found = false;
      (function walk(list) {
        (list || []).forEach(function (n) {
          if (!n || found) return;
          /* switch 里的 break 被改写成「go = 0」，也算「这个分支已终止」 */
          if (n.type === 'brk' || n.type === 'cont' || n.type === 'ret' ||
              n.type === 'nop' || (n.type === 'set' && n.__swBreak)) {
            found = true; return;
          }
          if (n.type === 'if') { walk(n.then); walk(n.else); }
          if (n.type === 'while') walk(n.body);
        });
      })(toArray(nodes));
      return found;
    }

    function parseCtor(cls, entry) {
      var line = lineNow();
      next();                                     /* 类名 */
      expect('(');
      var params = [];
      if (!is(')')) {
        for (;;) {
          eatType();
          params.push(expectId());
          if (accept(',')) continue;
          break;
        }
      }
      expect(')');

      /* 成员初始化列表：: state(seed ? seed : 0x…), … */
      var init = [];
      if (accept(':')) {
        for (;;) {
          var fn = expectId();
          expect('(');
          var ie = parseExpr();
          expect(')');
          var pre = takePending();               /* 三元等产生的前置语句也带进来 */
          init = init.concat(pre, [{ type: 'set', name: fn, expr: ie, line: line }]);
          if (accept(',')) continue;
          break;
        }
      }
      if (is('{')) parseBlock();                 /* 构造体一般为空，忽略其语句 */
      else expect(';');
      entry.ctor = { params: params, init: init };
    }

    function cloneNode(n) { return JSON.parse(JSON.stringify(n)); }

    /* ClassName obj(args); —— 执行实参，再把构造参数与初始化列表摊成语句 */
    function parseObjectDecl(cls, line) {
      next();                                     /* 类名 */
      var obj = expectId();
      expect('(');
      var args = [];
      if (!is(')')) {
        for (;;) {
          args.push(parseExpr());
          if (accept(',')) continue;
          break;
        }
      }
      expect(')');
      expect(';');
      var out = takePending();
      var ctor = classes[cls].ctor;
      if (ctor) {
        ctor.params.forEach(function (pn, i) {
          if (args[i]) out.push({ type: 'set', name: pn, expr: args[i], line: line });
        });
        ctor.init.forEach(function (n) { out.push(cloneNode(n)); });
      }
      warn('对象 ' + obj + ' 的构造已展开为成员初始化语句', line);
      return out;
    }

    /* do { body } while (cond)  ⇔  first = 1; while (first || cond) { first = 0; body } */
    function parseDo() {
      var line = lineNow();
      next();                                     /* do */
      loopDepth++;
      var body = stmtWithPending();
      loopDepth--;
      expect('while');
      expect('(');
      var c = parseLoopCond();
      expect(')');
      expect(';');
      var condPre = takePending();
      var first = '__dw' + (tmpSeq++);
      var cond = { k: 'or', a: { k: 'var', name: first }, b: c.expr, line: line };
      var inner = [{ type: 'set', name: first, expr: { k: 'num', v: 0 }, line: line }].concat(body);
      if (c.post) {
        inner.push({ type: c.post === '-' ? 'sub' : 'add', name: c.expr.name,
                     expr: { k: 'num', v: 1 }, line: line });
      }
      return condPre.concat([
        { type: 'set', name: first, expr: { k: 'num', v: 1 }, line: line },
        { type: 'while', cond: cond, body: inner, line: line }
      ]);
    }

    /* 数组元素的赋值语句（a[i] = … 以及绑定到数组元素的引用 r = …） */
    function arrayAssignStmt(name, idxs, line) {
      if (accept('++')) { expect(';'); return arrayWrite(name, idxs, line, 'inc'); }
      if (accept('--')) { expect(';'); return arrayWrite(name, idxs, line, 'dec'); }

      if (accept('+=')) {
        var ea = parseExpr(); expect(';');
        if (arrays[name].kind === 'str') {
          throw new ParseError('std::string 数组的元素不支持 += 拼接，请写成 ' +
                               name + '[i] = … 整体赋值', line);
        }
        return arrayWrite(name, idxs, line, 'add', ea);
      }
      if (accept('-=')) {
        var es = parseExpr(); expect(';');
        return arrayWrite(name, idxs, line, 'sub', es);
      }
      if (is('^=') || is('&=') || is('|=') || is('<<=') || is('>>=')) {
        var bopA = next().v;
        var brhsA = parseExpr(); expect(';');
        if (bopA === '<<=' || bopA === '>>=') {
          return arrayWrite(name, idxs, line,
                            { bit: 1, op: bopA === '<<=' ? '<<' : '>>', rhs: brhsA });
        }
        return arrayWrite(name, idxs, line,
                          { bit: 1, fn: { '^=': '__bf_xor', '&=': '__bf_and', '|=': '__bf_or' }[bopA],
                            rhs: brhsA });
      }
      if (is('*=') || is('/=') || is('%=')) {
        var copA = { '*=': '*', '/=': '/', '%=': '%' }[next().v];
        var ecA = parseExpr(); expect(';');
        return arrayWrite(name, idxs, line, function (old) {
          return coerceTo(arrays[name].kind, arithNode(copA, old, ecA, line), line);
        });
      }
      if (accept('=')) {
        if (is('getchar')) {
          next(); expect('('); expect(')'); expect(';');
          var gt = '__ai' + (tmpSeq++);
          varType[gt] = 'int';
          return [{ type: 'in', name: gt, line: line }]
            .concat(arrayWrite(name, idxs, line, 'set', { k: 'var', name: gt, line: line }));
        }
        skipCast();
        var va = parseExpr(); expect(';');
        return arrayWrite(name, idxs, line, 'set', va);
      }
      throw new ParseError('数组元素只支持 a[i] = … / += / -= / *= / /= / %= / ^= / ++ / --', line);
    }

    /* p = &b; / p++; / p += n; / p -= n; —— 指针本身是编译期信息 */
    function ptrEnsureCur(name, line) {
      var pt = pointers[name];
      if (!pt.arr) return null;
      if (!pt.cur) {
        var cur = '__pi' + (tmpSeq++);
        varType[cur] = 'int';
        var start = pt.linear != null ? numNode(pt.linear)
                  : (pt.idxs && pt.idxs[0] ? pt.idxs[0] : numNode(0));
        pt.cur = cur;
        pt.name = null;
        return { type: 'decl', name: cur, init: start, line: line,
                 text: '指针 ' + name + ' 的运行期游标' };
      }
      return null;
    }

    function parsePtrStmt(name, line) {
      var pt = pointers[name];
      /* p[i] = … ：等价于 *(p+i)，下标叠加到指针基准上 */
      if (is('[')) {
        var pidx = parseIdxs();
        if (pt.arr) {
          var pbase = pt.cur ? { k: 'var', name: pt.cur, line: line }
                    : (pt.linear != null ? numNode(pt.linear) : pt.idxs[0]);
          var pfull = { k: 'bin', op: '+', a: pbase, b: pidx[0], line: line };
          return arrayAssignStmt(pt.arr, [pfull], line);
        }
        warn('指针 ' + name + ' 不指向数组，' + name + '[i] 赋值已忽略', line);
        skipTo(';');
        return null;
      }
      if (accept('++')) { expect(';'); return ptrStep(name, 1, line); }
      if (accept('--')) { expect(';'); return ptrStep(name, -1, line); }
      if (is('+=') || is('-=')) {
        var d = next().v === '+=' ? 1 : -1;
        var se = parseExpr();
        expect(';');
        var cv = constOf(se);
        if (cv != null) return ptrStep(name, d * cv, line);
        var pre = ptrEnsureCur(name, line);
        var node = { type: d > 0 ? 'add' : 'sub', name: pt.cur,
                     expr: se, line: line, text: '指针 ' + name + ' 移动' };
        return pre ? [pre, node] : node;
      }
      if (accept('=')) {
        var na = readAddr(line);
        expect(';');
        var ni = bindPtr(name, na, pt.kind, line);
        return ni ? [ni] : null;
      }
      warn('指针 ' + name + ' 只支持 = &变量 / ++ / -- / += / -=，语句已忽略', line);
      skipTo(';');
      return null;
    }

    /* 语句位置的 *p = … / (*p)++ / *p += … */
    function parseDerefStmt(line, paren) {
      if (paren) expect('(');
      var lv = derefLValue(line);
      if (paren) accept(')');

      if (accept('++')) { expect(';'); return putLValue(lv, 'add', numNode(1), line); }
      if (accept('--')) { expect(';'); return putLValue(lv, 'sub', numNode(1), line); }
      if (accept('+=')) {
        var ae = parseExpr(); expect(';');
        return putLValue(lv, 'add', ae, line);
      }
      if (accept('-=')) {
        var se2 = parseExpr(); expect(';');
        return putLValue(lv, 'sub', se2, line);
      }
      if (is('*=') || is('/=') || is('%=')) {
        var cop = { '*=': '*', '/=': '/', '%=': '%' }[next().v];
        var rhs = parseExpr(); expect(';');
        if (lv.name) return compound(cop, lv.name, rhs, line);
        if (lv.arr) {
          return arrayWrite(lv.arr, [lv.idx], line, function (old) {
            return coerceTo(arrays[lv.arr].kind, arithNode(cop, old, rhs, line), line);
          });
        }
        return null;
      }
      if (is('^=') || is('&=') || is('|=') || is('<<=') || is('>>=')) {
        var bop = next().v, brhs = parseExpr(); expect(';');
        if (lv.name) return bitAssign(bop, lv.name, brhs, line);
        warn('动态数组指针的解引用不支持 ' + bop + '，已忽略', line);
        return null;
      }
      if (accept('=')) {
        if (is('getchar')) {
          next(); expect('('); expect(')'); expect(';');
          var gt = '__ai' + (tmpSeq++);
          varType[gt] = 'int';
          var w = putLValue(lv, 'set', { k: 'var', name: gt, line: line }, line);
          var res = [{ type: 'in', name: gt, line: line }];
          if (Array.isArray(w)) res = res.concat(w);
          else if (w) res.push(w);
          return res;
        }
        skipCast();
        var ve = parseExpr();
        expect(';');
        return putLValue(lv, 'set', ve, line);
      }
      warn('解引用只支持 *p = … / += / -= / *= /= %= / ++ / --，语句已忽略', line);
      skipTo(';');
      return null;
    }

    function stmtWithPendingDeref(line, paren) {
      var r = parseDerefStmt(line, paren);
      var pre = takePending();
      if (!r) return pre.length ? pre : null;
      if (Array.isArray(r)) return pre.concat(r);
      return pre.concat([r]);
    }

    function parseIdStmt() {
      var line = lineNow();
      var name = next().v;

      /* 指针变量：= &变量 / ++ / -- / += / -= */
      if (pointers[name]) return parsePtrStmt(name, line);

      /* std::string 的语句形态：s[0] = c;  s.clear();  s.push_back(c); … */
      if (varType[name] === 'str') {
        if (is('[')) {
          next();
          var wi = parseExpr();
          expect(']');
          if (accept('=')) {
            var wv = parseExpr();
            expect(';');
            return { type: 'sidxset', name: name, idx: wi, expr: wv, line: line };
          }
          throw new ParseError('std::string 只支持下标的直接赋值：s[i] = c;', line);
        }
        if (is('.')) {
          next();
          var m = next().v || '';
          var margs = is('(') ? parseArgs() : [];
          expect(';');
          if (m === 'clear') return { type: 'sclear', name: name, line: line };
          if (m === 'pop_back') return { type: 'spop', name: name, line: line };
          if (m === 'push_back') return { type: 'spush', name: name, expr: margs[0], line: line };
          if (m === 'append') return { type: 'sapp', name: name, expr: margs[0], line: line };
          if (m === 'assign') return { type: 'sset', name: name, expr: margs[0], line: line };
          if (m === 'resize' || m === 'reserve') {
            warn('std::string::' + m + '() 在定长缓冲区里没有意义，已忽略', line);
            return null;
          }
          warn('std::string 的 ' + m + '() 暂不支持，已忽略', line);
          return null;
        }
      }

      /* 数组名当普通变量用（a = 5; a++; 之类）：C 里它是指针，BF 里没指针 */
      if (arrays[name] && !is('[')) {
        throw new ParseError('数组 ' + name + ' 不能当普通变量赋值 / 自增，请写明下标（' +
                             name + '[i]）。如果需要「清空整个数组」，用 memset(' + name + ', 0, …)', line);
      }

      /* 函数调用语句 */
      if (is('(')) {
        /* memset(数组, 值, 字节数)：把整块元素刷成同一个值。
           BF 里新单元格本来是 0，但「先写后清」的场景需要真的重置。 */
        if (name === 'memset') {
          var mq = p;
          next();
          if (peek().t === 'id' && arrays[peek().v] && peek(1).v !== '[') {
            var man = next().v;
            if (accept(',')) {
              var mval = parseExpr();
              if (accept(',')) { if (!is(')')) parseExpr(); }
              expect(')');
              expect(';');
              var mout = [];
              var mar = arrays[man];
              for (var mk = 0; mk < mar.total; mk++) {
                mout.push({ type: 'set', name: elemName(man, unlinear(mk, mar.dims)),
                            expr: coerceTo(mar.kind, mval, line), line: line,
                            text: 'memset(' + man + ') 批量赋值' });
              }
              return mout;
            }
          }
          p = mq;
        }

        var args = parseArgs();
        expect(';');
        var fn = funcs[name];
        if (!fn) {
          if (IGNORABLE[name]) { warn('库函数 ' + name + '(...) 在 BrainFuck 里无法实现，已忽略', line); return null; }
          throw new ParseError('函数 ' + name + ' 未定义（可用标准库函数见右上角「标准库」）', line);
        }
        if (fn.params.length !== args.length) {
          throw new ParseError('函数 ' + name + ' 需要 ' + fn.params.length + ' 个参数，实际传入 ' + args.length + ' 个', line);
        }
        bindArgs(fn, args, line);
        /* 引用实参是动态下标的数组元素时：调用结束后把新值写回元素
           （内部先把 a[i] 读进临时格，函数改的是那个临时格） */
        var post = [];
        for (var qi = 0; qi < args.length; qi++) {
          var qa = args[qi];
          if (qa && qa.k === 'refarg' && qa.arrRef) {
            post.push.apply(post, arrayWrite(qa.arrRef.arr, qa.arrRef.idxs, line, 'set',
                                             { k: 'var', name: qa.name, line: line }));
          }
        }
        var tgt = fn.kind === 'void' ? null : '__cr' + (tmpSeq++);
        pending.push({ type: tgt ? 'callset' : 'call', target: tgt, fn: name, args: args, line: line });
        return post.length ? post : null;
      }

      /* ---------- 数组元素赋值：a[i] = v / a[i] += v / a[i]++ / m[i][j] = v ---------- */
      if (is('[')) {
        if (!arrays[name]) {
          warn('不支持数组下标，语句已跳过', line);
          skipTo(';');
          return null;
        }
        return arrayAssignStmt(name, parseIdxs(), line);
      }

      /* 绑定到数组元素的引用（int& r = a[i]）：r 的赋值作用在那个元素上 */
      var alrW = aliasArr(name);
      if (alrW) {
        if (alrW.readonly) {
          throw new ParseError('const 引用 ' + name + ' 是只读的，不能赋值 / 自增', line);
        }
        return arrayAssignStmt(alrW.arr, alrW.idxs, line);
      }

      /* const 引用是只读的 */
      if (aliases[name] && aliases[name].readonly) {
        throw new ParseError('const 引用 ' + name + ' 是只读的，不能赋值 / 自增', line);
      }

      /* 引用（int& r = x）在编译期就展开成别名：这里把 r 换成真正的目标名 */
      var rname = resolveAlias(name);

      if (accept('++')) {
        expect(';');
        if (varType[rname] === 'f32') return { type: 'add', name: rname, expr: fnum(FSCALE), line: line };
        return { type: 'add', name: rname, expr: { k: 'num', v: 1 }, line: line };
      }
      if (accept('--')) {
        expect(';');
        if (varType[rname] === 'f32') return { type: 'sub', name: rname, expr: fnum(FSCALE), line: line };
        return { type: 'sub', name: rname, expr: { k: 'num', v: 1 }, line: line };
      }
      if (accept('+=')) {
        var ea = parseExpr(); expect(';');
        if (varType[rname] === 'str') return { type: 'sapp', name: rname, expr: ea, line: line };
        return compound('+', rname, ea, line);
      }
      if (accept('-=')) {
        var es = parseExpr(); expect(';');
        return compound('-', rname, es, line);
      }
      if (is('^=') || is('&=') || is('|=') || is('<<=') || is('>>=')) {
        var bop = next().v;
        var brhs = parseExpr(); expect(';');
        return bitAssign(bop, rname, brhs, line);
      }
      /* 复合赋值：x *= e / x /= e / x %= e —— 展开成 x = x <op> e */
      if (is('*=') || is('/=') || is('%=')) {
        var cop = { '*=': '*', '/=': '/', '%=': '%' }[next().v];
        var ec = parseExpr(); expect(';');
        return compound(cop, rname, ec, line);
      }
      if (accept('=')) {
        if (is('getchar')) {
          next(); expect('('); expect(')'); expect(';');
          return { type: 'in', name: rname, line: line };
        }
        skipCast();
        var e2 = parseExpr();
        expect(';');
        if (varType[rname] === 'str') return { type: 'sset', name: rname, expr: e2, line: line };
        return { type: 'set', name: rname, expr: coerceTo(varType[rname] || 'int', e2, line), line: line };
      }

      throw new ParseError('无法理解的语句：' + name, line);
    }

    /* 跳过 (char) / (int *) 这类强制转换，返回转换后的类型（不是转换就返回 null） */
    function skipCast() {
      if (!is('(')) return null;
      var q = p;
      next();
      var toks = [];
      var ok = true;
      while (!eof() && !is(')')) {
        if (peek().t === 'id' && (isTypeKw(peek().v) || isMod(peek().v))) { toks.push(next().v); }
        else if (is('*')) next();
        else { ok = false; break; }
      }
      if (ok && toks.length && is(')')) {
        next();
        return kindOf(toks);
      }
      p = q;
      return null;
    }

    /* 循环条件里如果做了数组读取（或函数调用、三元等「先算进临时格」的操作），
       这些语句必须每轮重算 —— else 会拿「进循环前那一次」的结果一直判断下去，
       while (a[i] != 0) 就变成死循环。做法：改写成 do-while 形态：
         first = 1; while (first || cond) { first = 0; 循环体; 重算前置语句 }
       cond 在通用 while 里每轮都会重新求值，前置语句在循环体尾部刷新临时格。 */
    function condUsesPre(cond, condPre) {
      if (!condPre.length) return false;
      var written = Object.create(null);
      condPre.forEach(function (n) {
        if (!n) return;
        if (n.name) written[n.name] = 1;
        if (n.target) written[n.target] = 1;
      });
      var hit = false;
      (function walkE(e) {
        if (!e || hit || typeof e !== 'object') return;
        if (e.k === 'var' && written[e.name]) { hit = true; return; }
        walkE(e.a); walkE(e.b); walkE(e.idx); walkE(e.pos); walkE(e.len);
      })(cond);
      return hit;
    }

    function reflowCondLoop(cond, condPre, body, line) {
      if (!condUsesPre(cond, condPre)) return null;
      var first = '__wc' + (tmpSeq++);
      var c2 = { k: 'or', a: { k: 'var', name: first, line: line }, b: cond, line: line };
      /* 关键：condPre 必须在进入循环之前先跑一次。
         旧实现只把它放在循环体尾部「重算」，第一轮条件里读到的是
         未初始化的临时格（cin.get(ch) 会得到 0、a[i] 会得到 a[0]）。
         尾部那份要深拷贝，别和首次那份共享同一个节点对象。 */
      var redo = condPre.map(function (n) { return cloneNode(n); });
      return {
        pre: condPre.concat([{
          type: 'set', name: first, expr: { k: 'num', v: 1 }, line: line,
          text: '循环条件含数组读取 / 函数调用：先强制进入第一轮'
        }]),
        node: {
          type: 'while', cond: c2, line: line,
          body: [{ type: 'set', name: first, expr: { k: 'num', v: 0 }, line: line }]
                .concat(body, redo)
        }
      };
    }

    function parseWhile() {
      var line = lineNow();
      next();
      expect('(');
      var c = parseLoopCond();
      expect(')');
      /* 条件里的函数调用必须在进入循环之前执行 */
      var condPre = takePending();
      loopDepth++;
      var body = stmtWithPending();
      loopDepth--;
      if (c.post) {
        body.unshift({
          type: c.post === '-' ? 'sub' : 'add',
          name: c.expr.name, expr: { k: 'num', v: 1 }, line: line
        });
      }
      var rf = reflowCondLoop(c.expr, condPre, body, line);
      if (rf) return rf.pre.concat([rf.node]);
      return condPre.concat([{ type: 'while', cond: c.expr, body: body, line: line }]);
    }

    function parseIf() {
      var line = lineNow();
      next();
      expect('(');
      var cond = parseTernary();
      expect(')');
      var condPre = takePending();          /* 条件里的调用先算，再判断 */
      var thenBody = stmtWithPending();
      var elseBody = null;
      if (accept('else')) {
        elseBody = is('if') ? toArray(parseIf()) : stmtWithPending();
      }
      return condPre.concat([{
        type: 'if', cond: cond, then: thenBody, else: elseBody, line: line
      }]);
    }

    function parseFor() {
      var line = lineNow();
      next();
      expect('(');

      var init = [];
      if (is(';')) {
        next();
      } else if (isTypeKw(peek().v) || isMod(peek().v)) {
        init = parseDeclList();                     /* for (int i = 0; …) */
      } else {
        for (;;) {
          init = init.concat(toArray(parseSimpleAssign()));
          if (accept(',')) continue;
          break;
        }
        expect(';');
      }
      init = takePending().concat(init);            /* 初始化里的调用先执行 */

      var cond = null;
      if (!is(';')) cond = parseLoopCond();
      expect(';');
      if (!cond) throw new ParseError('for 需要一个循环条件，例如 for (i = 0; i < 10; i++)', line);
      var condPre = takePending();

      var step = [];
      if (!is(')')) {
        for (;;) {
          step = step.concat(toArray(parseSimpleAssign()));
          if (accept(',')) continue;
          break;
        }
      }
      step = takePending().concat(step);       /* 步进里的 ^= 调用留在 step 内部 */
      expect(')');

      loopDepth++;
      var body = stmtWithPending();
      loopDepth--;
      if (cond.post) {
        body.unshift({
          type: cond.post === '-' ? 'sub' : 'add',
          name: cond.expr.name, expr: { k: 'num', v: 1 }, line: line
        });
      }

      /* stepmark：标记「循环体结束 / 步进开始」的位置，
         continue 只跳过循环体剩下的部分，步进仍然要执行 */
      var mark = { type: 'stepmark', line: line };

      /* 常见写法 for (i = 0; i < n; i++) 转成“剩余次数”倒计数，避免每次都做比较 */
      var fast = tryCountdown(cond.expr, step, body, line, mark);
      if (fast) return init.concat(condPre, fast);

      var loopBody = body.concat([mark], step);
      var rfF = reflowCondLoop(cond.expr, condPre, loopBody, line);
      if (rfF) return init.concat(rfF.pre, [rfF.node]);

      return init.concat(condPre, [{
        type: 'while',
        cond: cond.expr,
        body: loopBody,
        line: line
      }]);
    }

    /* 扫描一段语句，看看有没有改动这些变量 */
    function touches(nodes, names) {
      var hit = false;
      (function walk(list) {
        (list || []).forEach(function (n) {
          if (!n || hit) return;
          if ((n.type === 'set' || n.type === 'add' || n.type === 'sub' ||
               n.type === 'in' || n.type === 'innum' || n.type === 'decl') && names[n.name]) {
            hit = true;
            return;
          }
          if (n.type === 'while') walk(n.body);
          if (n.type === 'if') { walk(n.then); walk(n.else); }
        });
      })(nodes);
      return hit;
    }

    /**
     * 把 for (i = a; i < n; i++) 改写成：
     *   cnt = (i < n) ? n - i : 0
     *   while (cnt) { cnt--; 循环体; i++ }
     * 两者迭代次数完全一致，但后者每轮只减一个数，不用重复做比较。
     */
    function tryCountdown(cond, step, body, line, mark) {
      if (!cond || cond.k !== 'cmp') return null;
      var op = cond.op;
      if (op !== '<' && op !== '<=' && op !== '>' && op !== '>=') return null;

      var lv = cond.a;
      var rv = cond.b;
      if (!lv || lv.k !== 'var') return null;
      if (!rv || (rv.k !== 'var' && rv.k !== 'num')) return null;

      if (step.length !== 1) return null;
      var st = step[0];
      if (!st || (st.type !== 'add' && st.type !== 'sub')) return null;
      if (st.name !== lv.name) return null;
      if (!st.expr || st.expr.k !== 'num' || st.expr.v !== 1) return null;

      var up = (op === '<' || op === '<=');
      if (up && st.type !== 'add') return null;
      if (!up && st.type !== 'sub') return null;

      /* 循环体里动了 i 或上界，次数就对不上了，老老实实用条件循环 */
      var watch = {};
      watch[lv.name] = 1;
      if (rv.k === 'var') watch[rv.name] = 1;
      if (touches(body, watch)) return null;

      var cnt = '__n' + (tmpSeq++);
      var right = rv.k === 'var' ? { k: 'var', name: rv.name } : { k: 'num', v: rv.v };
      var left = { k: 'var', name: lv.name };

      var count;
      if (op === '<') {
        count = { k: 'bin', op: '-', a: right, b: left };
      } else if (op === '<=') {
        count = { k: 'bin', op: '+', a: { k: 'bin', op: '-', a: right, b: left }, b: { k: 'num', v: 1 } };
      } else if (op === '>') {
        count = { k: 'bin', op: '-', a: left, b: right };
      } else {
        count = { k: 'bin', op: '+', a: { k: 'bin', op: '-', a: left, b: right }, b: { k: 'num', v: 1 } };
      }

      return [
        { type: 'set', name: cnt, expr: { k: 'num', v: 0 }, line: line },
        {
          type: 'if', cond: cond, else: null, line: line,
          then: [{ type: 'set', name: cnt, expr: count, line: line }]
        },
        {
          type: 'while',
          cond: { k: 'var', name: cnt },
          body: [{ type: 'sub', name: cnt, expr: { k: 'num', v: 1 }, line: line }]
            .concat(body, mark ? [mark] : [], step),
          line: line
        }
      ];
    }

    /* for 的第三段：i++ / i-- / i += k / i -= k / i = k（不带分号） */
    function parseSimpleAssign() {
      var line = lineNow();
      /* for (…; …; ++i) 的前缀写法 */
      if ((is('++') || is('--')) && peek().t === 'op') {
        var fInc = next().v;
        var fNm = resolveAlias(expectId());
        return { type: fInc === '++' ? 'add' : 'sub', name: fNm,
                 expr: (varType[fNm] === 'f32') ? fnum(FSCALE) : numNode(1), line: line };
      }
      var name = resolveAlias(expectId());
      if (accept('++')) return { type: 'add', name: name, expr: { k: 'num', v: 1 }, line: line };
      if (accept('--')) return { type: 'sub', name: name, expr: { k: 'num', v: 1 }, line: line };
      if (accept('+=')) return { type: 'add', name: name, expr: parseExpr(), line: line };
      if (accept('-=')) return { type: 'sub', name: name, expr: parseExpr(), line: line };
      if (is('^=') || is('&=') || is('|=') || is('<<=') || is('>>=')) {
        var bop2 = next().v;
        return bitAssign(bop2, name, parseExpr(), line);
      }
      if (is('*=') || is('/=') || is('%=')) {
        var opk = { '*=': 'mul', '/=': 'div', '%=': 'mod' }[next().v];
        return {
          type: 'set', name: name,
          expr: { k: opk, a: { k: 'var', name: name }, b: parseExpr(), line: line },
          line: line
        };
      }
      if (accept('=')) return { type: 'set', name: name, expr: parseExpr(), line: line };
      throw new ParseError('for 的这一段只支持 i++ / i-- / i += k / i -= k / i = k', line);
    }

    /* ---------------- 输出函数 ---------------- */
    function parsePrintf() {
      var line = lineNow();
      next();
      expect('(');
      if (peek().t !== 'str') throw new ParseError('printf 的格式串必须是字符串字面量', line);
      var fmt = next().v;

      var args = [];
      while (accept(',')) args.push(parseExpr());
      expect(')');
      expect(';');

      var out = [], buf = '', ai = 0, i = 0;

      function flushText() {
        if (buf) { out.push({ type: 'outstr', text: buf, line: line }); buf = ''; }
      }

      while (i < fmt.length) {
        var ch = fmt.charAt(i);
        if (ch !== '%') { buf += ch; i++; continue; }

        var j = i + 1;
        var padded = false;
        while (j < fmt.length && /[-+ 0-9.#]/.test(fmt.charAt(j))) { j++; padded = true; }
        var spec = fmt.charAt(j);
        /* 长度修饰：%lf / %hd 里的 l / h 直接跳过 */
        if (spec === 'l' || spec === 'h') { j++; spec = fmt.charAt(j); }
        /* 小数位数：%.2f */
        var precM = /\.(\d+)/.exec(fmt.slice(i + 1, j));
        var prec = precM ? parseInt(precM[1], 10) : -1;

        if (spec === '%') { buf += '%'; i = j + 1; continue; }

        if (spec === 's') {
          flushText();
          var as = args[ai++];
          if (!as) warn('printf 的 %s 缺少对应参数', line);
          else out.push({ type: 'sout', expr: as, line: line });
          i = j + 1;
          continue;
        }

        /* 浮点：定点数，默认 3 位小数，可指定 %.Nf 的位数（0..3） */
        if (spec === 'f' || spec === 'F' || spec === 'g' || spec === 'G' ||
            spec === 'e' || spec === 'E') {
          flushText();
          var fa = args[ai++];
          if (!fa) { warn('printf 的 %' + spec + ' 缺少对应参数', line); i = j + 1; continue; }
          if (spec === 'g' || spec === 'G' || spec === 'e' || spec === 'E') {
            warn('printf 的 %' + spec + ' 按定点数（%f）输出', line);
          }
          var scal = 3, fe = toFloat(fa, line);
          if (prec >= 0) {
            if (prec > 3) { warn('printf 的 %.Nf 最多支持 3 位小数，已按 3 位输出', line); prec = 3; }
            if (prec < 3) {
              var pw = 1, k2;
              for (k2 = prec; k2 < 3; k2++) pw *= 10;
              fe = { k: 'div', a: { k: 'bin', op: '+', a: fe, b: fnum(pw / 2), line: line },
                     b: rawInt(pw), line: line };
            }
            scal = prec;
          }
          out.push({ type: 'outdec', expr: fe, scale: scal, line: line });
          i = j + 1;
          continue;
        }

        if (spec === 'c' || spec === 'd' || spec === 'i' || spec === 'u' || spec === 'x' || spec === 'X') {
          flushText();
          var a = args[ai++];
          if (!a) {
            warn('printf 的 %' + spec + ' 缺少对应参数', line);
          } else {
            if (padded && prec < 0) warn('printf 的宽度 / 精度修饰已忽略', line);
            out.push({ type: spec === 'c' ? 'out' : 'outdec', expr: toByte(a, line), line: line });
          }
          i = j + 1;
          continue;
        }

        buf += '%';
        i++;
      }
      flushText();

      if (ai < args.length) warn('printf 有 ' + (args.length - ai) + ' 个多余参数', line);
      return out.length ? out : null;
    }

    function exprHasIntVar(e) {
      if (!e) return false;
      if (e.k === 'var') return varType[e.name] === 'int' || varType[e.name] === 'i32';
      if (e.k === 'num') return !e.ch;        /* 数字字面量本身就是 int：cout << (3 << 2) */
      if (e.k === 'bin' || e.k === 'mul' || e.k === 'div' || e.k === 'mod' ||
          e.k === 'cmp' || e.k === 'and' || e.k === 'or') {
        return exprHasIntVar(e.a) || exprHasIntVar(e.b);
      }
      if (e.k === 'not') return true;
      if (e.k === 'i32bit' || e.k === 'i32shift') return true;   /* 位运算 / 移位结果是数字 */
      /* 字符串的长度 / 下标 / 判空 / 数字转换都是数字 */
      if (e.k === 'slen' || e.k === 'sidx' || e.k === 'sempty' ||
          e.k === 'stoi' || e.k === 'sfind' || e.k === 'scmp') return true;
      return false;
    }

    function parseCout() {
      var line = lineNow();
      if (is('std')) { next(); expect('::'); }
      next(); /* cout */

      var out = [];
      while (is('<<')) {
        next();

        if (peek().t === 'str' && peek(1).v !== '+') {
          out.push({ type: 'outstr', text: next().v, line: line });
          continue;
        }
        if (is('endl')) {
          next();
          out.push({ type: 'outstr', text: '\n', line: line });
          continue;
        }
        if (is('std') && peek(1).v === '::' && peek(2).v === 'endl') {
          p += 3;
          out.push({ type: 'outstr', text: '\n', line: line });
          continue;
        }

        var cast = skipCast();
        if (is('endl')) {
          next();
          out.push({ type: 'outstr', text: '\n', line: line });
          continue;
        }

        /* cout 的 << 是流插入符，不是左移。括号里仍恢复位移（见 parseTerm） */
        noShift++;
        var e = parseExpr();
        noShift--;

        /* std::string：整串输出（不按字符码） */
        if (isStrExpr(e)) {
          out.push({ type: 'sout', expr: e, line: line });
          continue;
        }

        /* float / double：按定点数打印，带小数点并去掉末尾多余的 0 */
        if (cast === 'i32' || cast === 'int' || cast === 'char') e = toByte(e, line);
        if (cast === 'f32' || isFloatExpr(e)) {
          out.push({ type: 'outdec', expr: toFloat(e, line), scale: 3, line: line });
          continue;
        }
        var numeric;
        if (cast) numeric = (cast !== 'char');
        else if (e.k === 'var') numeric = (varType[e.name] === 'int' || varType[e.name] === 'i32');
        else if (e.k === 'num') numeric = !e.ch;          /* 字符字面量仍按字符输出 */
        else if (e.k === 'sidx') numeric = false;         /* s[i] 是 char，按字符输出 */
        else numeric = exprHasIntVar(e);

        out.push({ type: numeric ? 'outdec' : 'out', expr: e, line: line });
      }
      expect(';');
      return out;
    }

    /* scanf("...", &a, &b)：%d 读十进制数字，%c 读单个字符 */
    function parseScanf() {
      var line = lineNow();
      next();
      expect('(');
      if (peek().t !== 'str') throw new ParseError('scanf 的格式串必须是字符串字面量', line);
      var fmt = next().v;

      var args = [];
      while (accept(',')) args.push(parseScanArg());
      expect(')');
      expect(';');

      var out = [], ai = 0, i = 0;

      while (i < fmt.length) {
        var ch = fmt.charAt(i);
        if (ch !== '%') { i++; continue; }

        var j = i + 1;
        while (j < fmt.length && /[-+ 0-9.#*]/.test(fmt.charAt(j))) j++;
        var spec = fmt.charAt(j);
        if (spec === 'l' || spec === 'h') { j++; spec = fmt.charAt(j); }

        if (spec === '%') { i = j + 1; continue; }

        var arg = args[ai++];
        if (!arg) {
          warn('scanf 的 %' + spec + ' 缺少对应变量', line);
          i = j + 1;
          continue;
        }
        var targetKind = arg.idxs ? arrays[arg.name].kind : (varType[arg.name] || 'int');

        if (spec === 'c') {
          pushScanArg(out, arg, { type: 'in', line: line }, line);
        } else if (spec === 'f' || spec === 'F' || spec === 'e' || spec === 'g') {
          if (targetKind === 'f32') {
            pushScanArg(out, arg, { type: 'innum', dec: 3, line: line }, line);
          } else {
            warn('scanf 的 %' + spec + ' 需要一个 float / double 变量，已按 %d 读取', line);
            pushScanArg(out, arg, { type: 'innum', line: line }, line);
          }
        } else if (spec === 'd' || spec === 'i' || spec === 'u' || spec === 'x') {
          pushScanArg(out, arg, { type: 'innum', line: line }, line);
        } else if (spec === 's') {
          if (!arg.idxs && targetKind === 'str') {
            out.push({ type: 'sin', name: arg.name, mode: 'word', line: line });
          } else {
            warn('scanf 的 %s 需要一个 std::string 变量，已跳过', line);
          }
        } else {
          warn('scanf 暂不支持 %' + spec + '，已跳过', line);
        }
        i = j + 1;
      }

      if (!out.length) warn('scanf 没有可执行的读取项', line);
      return out.length ? out : null;
    }

    /* scanf 的参数：&x 或 x；数组元素写成 &a[i] */
    function parseScanArg() {
      while (is('&') || is('*')) next();
      if (peek().t !== 'id') throw new ParseError('scanf 的这里需要一个变量名', peek().line);
      var nm3 = next().v;
      if (arrays[nm3] && is('[')) return { name: nm3, idxs: parseIdxs() };
      if (pointers[nm3]) {
        var sp = pointers[nm3];
        if (sp.name) return { name: sp.name, idxs: null };
        warn('scanf 读入「动态数组指针」暂不支持，请用 scanf 写 ' + nm3 + '[i]', peek().line);
      }
      return { name: resolveAlias(nm3), idxs: null };
    }

    /* 生成一条 scanf 读取：目标是数组元素时先读进临时变量再写回 */
    function pushScanArg(out, arg, node, line) {
      if (!arg.idxs) {
        node.name = arg.name;
        out.push(node);
        return;
      }
      var t = '__ai' + (tmpSeq++);
      varType[t] = arrays[arg.name].kind;
      node.name = t;
      out.push(node);
      out.push.apply(out, arrayWrite(arg.name, arg.idxs, line, 'set',
                                     { k: 'var', name: t, line: line }));
    }

    /* cin >> a >> b：字符型读一个字符，其它按十进制数字读 */
    function parseCin() {
      var line = lineNow();
      if (is('std')) { next(); expect('::'); }
      next(); /* cin */

      var out = [];
      while (is('>>')) {
        next();
        var cast = skipCast();
        /* cin >> *p：读到指针指向的那一格 */
        if (!cast && is('*') && peek(1).t === 'id') {
          next();
          var cpn = next().v;
          var cpt = pointers[cpn];
          if (!cpt) throw new ParseError('*' + cpn + '：' + cpn + ' 不是指针', line);
          var ckind = cpt.kind || 'int';
          var cinNode = { type: ckind === 'char' ? 'in' : 'innum',
                          skipSpace: ckind === 'char', dec: ckind === 'f32' ? 3 : 0,
                          line: line };
          if (cpt.name) {
            cinNode.name = cpt.name;
            out.push(cinNode);
          } else if (cpt.arr) {
            var ct = '__pv' + (tmpSeq++);
            varType[ct] = ckind;
            cinNode.name = ct;
            out.push({ type: 'decl', name: ct, init: numNode(0), line: line,
                       text: 'cin >> *' + cpn + ' 的暂存格' });
            out.push(cinNode);
            out.push.apply(out, arrayWrite(cpt.arr,
              [cpt.cur ? { k: 'var', name: cpt.cur, line: line } : cpt.idxs[0]],
              line, 'set', { k: 'var', name: ct, line: line }));
          }
          if (is('>>')) continue;
          break;
        }
        if (peek().t !== 'id') throw new ParseError('cin >> 后面需要一个变量名', line);
        var name = next().v;

        /* cin >> a[i]：先读进临时变量，再按下标写回 */
        if (!cast && arrays[name] && is('[')) {
          var arC = arrays[name];
          var idxC = parseIdxs();
          var tc = '__ai' + (tmpSeq++);
          varType[tc] = arC.kind;
          out.push({ type: arC.kind === 'char' ? 'in' : 'innum', name: tc,
                     skipSpace: arC.kind === 'char', dec: arC.kind === 'f32' ? 3 : 0, line: line });
          out.push.apply(out, arrayWrite(name, idxC, line, 'set',
                                         { k: 'var', name: tc, line: line }));
          if (is('>>')) continue;
          break;
        }

        /* std::string：读一个「词」，遇到空白为止（与 C++ 的 operator>> 一致） */
        if (!cast && varType[name] === 'str') {
          out.push({ type: 'sin', name: name, mode: 'word', line: line });
          if (is('>>')) continue;
          break;
        }

        name = resolveAlias(name);
        var kind = cast || varType[name] || 'int';
        /* C++ 的 cin >> char 会跳过前导空白（空格/制表/换行），与
           getchar() / scanf("%c") 的「照单全收」不同，用 skipSpace 区分。
           否则 cin >> int 回推的那个换行会被 cin >> char 直接读到，
           猜数字这类「读数字 → 读 y/n」的循环会提前结束。 */
        out.push({ type: kind === 'char' ? 'in' : 'innum', name: name,
                   skipSpace: kind === 'char', dec: kind === 'f32' ? 3 : 0, line: line });
        if (is('>>')) continue;
        break;
      }
      expect(';');
      return out.length ? out : null;
    }

    /* ---------------- 顶层 ---------------- */
    var ir = [];
    var guard = 0;
    while (!eof() && guard++ < 20000) {
      var st = parseTopLevel();
      var arr = toArray(st);
      if (arr.length) ir.push.apply(ir, arr);
    }

    if (i64Seen) {
      warn('int64_t / uint64_t 没有 64 位整数支持：按 8 位（低 8 位）处理，' +
           '大数运算会回绕。需要 32 位请改用 int32_t', 1);
    }

    return { ir: ir, warnings: warnings, funcs: funcs, varType: varType,
             bitFns: Object.keys(bitFns), usesXor: !!bitFns.__bf_xor };
  }

  TC.ParserC = { parse: parse, ParseError: ParseError, isTypeKw: isTypeKw, kindOf: kindOf };
})(window.TC = window.TC || {});
