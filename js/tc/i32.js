/* =========================================================================
 * tc/i32.js —— 32 位有符号整数（int32_t / int32 / long / 开关后的 int）
 *
 * BrainFuck 单元格只有 8 位，这里用 4 个小端单元格表示一个 int32：
 *     x@0 低字节 … x@3 高字节（补码，最高位即符号位）
 *
 * 在 IR 层把 int32 语句降级成一组普通 8 位语句，生成的仍只有 set / decl /
 * in / out / if / while 这些既有节点，因此 codegen 一行都不用改：
 *   · 加减：逐字节加减，进位用 8 位无符号比较 (sum < a) 判定
 *   · 比较：先看符号位；同号时补码的字节字典序恰好就是数值序
 *   · 乘法：32 轮「看乘数最低位 → 累加被乘数 → 双双移位」
 *   · 除法 / 取余：取绝对值后 32 轮试商（移位 + 比较 + 相减），再补回符号
 *   · 位运算：逐位取模 2、按位判定、按权重累加（& | ^ ~）
 *   · 移位：逐位左移 / 算术右移（补符号位）
 *   · 十进制输出：base-256 长除法反复 /10（rem*25+hi+… 全落在 8 位内）
 *   · 十进制输入：x*10 用 4 次 32 位加法合成，再逐字符累加
 *
 * 范围：常量（含负数）、赋值/复制、+ - * / % += -= *= /= %= ++ --、位运算
 *       & | ^ ~ << >>、六种比较、!、if/while 条件、%d / cout 十进制输出
 *       （含负号）、cin/scanf 十进制输入。
 * 不支持（告警并按 8 位降级）：作为函数参数 / 返回值。
 * 注意：4 格软件模拟，生成代码与运行步数都远大于 8 位整数。
 * ========================================================================= */
(function (TC) {
  'use strict';

  var W = 4;

  function lower(nodes, types, warnings, seed) {
    var seq = seed || 0;
    var pre = [];                 /* 当前收集的前置语句 */
    var warned = {};

    function tmp() { return '__i32_' + (seq++); }
    function N(v) { return { k: 'num', v: v & 255 }; }
    function V(n) { return { k: 'var', name: n }; }
    function BIN(op, a, b) { return { k: 'bin', op: op, a: a, b: b }; }
    function CMP(op, a, b) { return { k: 'cmp', op: op, a: a, b: b }; }
    function MUL(a, b) { return { k: 'mul', a: a, b: b }; }
    function DIV(a, b) { return { k: 'div', a: a, b: b }; }
    function MOD(a, b) { return { k: 'mod', a: a, b: b }; }
    function AND(a, b) { return { k: 'and', a: a, b: b }; }
    function OR(a, b) { return { k: 'or', a: a, b: b }; }
    function NOT(a) { return { k: 'not', a: a }; }
    function lineOf(e) { return (e && e.line) || 1; }

    /* float / double 也是「放大 1000 倍的 32 位定点数」，存储与运算完全相同 */
    function isI32(name) { return types[name] === 'i32' || types[name] === 'f32'; }
    function byteName(name, i) { return name + '@' + i; }

    /* 统一约定：xxxN = 变量名字符串数组，xxx = 表达式数组 */
    function bytesOfVarN(name) {
      var r = [], i;
      for (i = 0; i < W; i++) r.push(byteName(name, i));
      return r;
    }
    function asExpr(ns) { return ns.map(V); }

    function emit(type, name, expr, line, text, kind) {
      var n = { type: type, name: name, expr: expr, line: line, text: text || 'int32 展开' };
      if (kind) n.kind = kind;
      pre.push(n);
    }
    function set(name, expr, line) { emit('set', name, expr, line); }                 /* name 是字符串 */
    function decl(name, expr, line) { emit('decl', name, expr, line, 'int32 字节', 'int'); }
    function warn(msg, line) {
      if (warned[msg]) return;
      warned[msg] = 1;
      for (var i = 0; i < warnings.length; i++) if (warnings[i].message === msg) return;
      warnings.push({ message: msg, line: line || 1 });
    }
    function hasI32(e) {
      if (!e) return false;
      /* f 标记 = 这个子树是定点浮点（放大 1000 倍的 32 位），必须走 32 位实现 */
      if (e.f) return true;
      if (e.k === 'var') return isI32(e.name);
      if (e.k === 'i32bit' || e.k === 'i32shift') return true;
      return hasI32(e.a) || hasI32(e.b);
    }

    /* 把 4 个字节表达式落进新临时格，避免别名 / 重复求值 */
    function matN(bytes, line) {
      var t = [], i;
      for (i = 0; i < W; i++) t.push(tmp());
      for (i = 0; i < W; i++) set(t[i], bytes[i], line);
      return t;
    }
    function mat(bytes, line) { return asExpr(matN(bytes, line)); }

    function constBytes(v) {
      var x = v | 0;             /* 低 32 位，负数自动成补码 */
      return [N(x & 255), N((x >>> 8) & 255), N((x >>> 16) & 255), N((x >>> 24) & 255)];
    }

    /* 32 位加 / 减：返回 4 个新临时格的表达式引用 */
    function arith(a, b, op, line) {
      var outN = [], i;
      for (i = 0; i < W; i++) outN.push(tmp());
      var carry = tmp();
      set(carry, N(0), line);

      for (i = 0; i < W; i++) {
        var s = tmp(), c1 = tmp(), xi = tmp(), w = tmp(), cn = tmp();
        if (op === '+') {
          set(s, BIN('+', a[i], b[i]), line);
          set(c1, CMP('<', V(s), a[i]), line);        /* a+b 回绕 → 进位 */
          set(xi, BIN('+', V(s), V(carry)), line);
          set(w, CMP('<', V(xi), V(s)), line);        /* 加进位又回绕 */
        } else {
          set(s, BIN('-', a[i], b[i]), line);
          set(c1, CMP('<', a[i], b[i]), line);        /* 借位 */
          set(xi, BIN('-', V(s), V(carry)), line);
          set(w, CMP('<', V(s), V(carry)), line);     /* 减借位又回绕 */
        }
        set(cn, OR(V(c1), V(w)), line);
        set(outN[i], V(xi), line);
        set(carry, V(cn), line);
      }
      return asExpr(outN);
    }

    /* ---------- 8 位层面上的 32 位小工具 ---------- */
    /* 目标字节数组 += 源字节数组（丢弃最高位进位） */
    function addInto(T, S, line) {
      var carry = tmp(), i;
      set(carry, N(0), line);
      for (i = 0; i < W; i++) {
        var s = tmp(), c1 = tmp(), x = tmp(), c2 = tmp(), cn = tmp();
        set(s, BIN('+', V(T[i]), V(S[i])), line);
        set(c1, CMP('<', V(s), V(T[i])), line);       /* 回绕 → 进位 */
        set(x, BIN('+', V(s), V(carry)), line);
        set(c2, CMP('<', V(x), V(s)), line);
        set(cn, OR(V(c1), V(c2)), line);
        set(T[i], V(x), line);
        set(carry, V(cn), line);
      }
    }

    /* 目标字节数组 -= 源字节数组 */
    function subInto(T, S, line) {
      var borrow = tmp(), i;
      set(borrow, N(0), line);
      for (i = 0; i < W; i++) {
        var s = tmp(), b1 = tmp(), x = tmp(), b2 = tmp(), bn = tmp();
        set(s, BIN('-', V(T[i]), V(S[i])), line);
        set(b1, CMP('<', V(T[i]), V(S[i])), line);    /* 借位 */
        set(x, BIN('-', V(s), V(borrow)), line);
        set(b2, CMP('<', V(s), V(borrow)), line);
        set(bn, OR(V(b1), V(b2)), line);
        set(T[i], V(x), line);
        set(borrow, V(bn), line);
      }
    }

    /* 就地 32 位左移 1 位（最高位丢弃） */
    function shl1(X, line) {
      var carry = tmp(), i;
      set(carry, N(0), line);
      for (i = 0; i < W; i++) {
        var hi = tmp(), t = tmp();
        set(hi, CMP('>=', V(X[i]), N(128)), line);    /* 先记符号位，再改本字节 */
        /* x*2 直接写成 x+x：比走乘法循环省一大截 */
        set(t, BIN('+', BIN('+', V(X[i]), V(X[i])), V(carry)), line);
        set(X[i], V(t), line);
        set(carry, V(hi), line);
      }
    }

    /* 就地 32 位右移 1 位；arith 为真时补符号位（算术右移） */
    function shr1(X, line, arith) {
      var carry = tmp(), i;
      set(carry, N(0), line);
      if (arith) {
        var sgn = tmp();
        set(sgn, CMP('>=', V(X[W - 1]), N(128)), line);
        pre.push({ type: 'if', cond: V(sgn),
                   then: [{ type: 'set', name: carry, expr: N(1), line: line, text: '算术右移补符号位' }],
                   else: null, line: line, text: '符号位' });
      }
      for (i = W - 1; i >= 0; i--) {
        var lo = tmp(), t = tmp(), nt = tmp(), hiBit = tmp();
        set(lo, MOD(V(X[i]), N(2)), line);
        set(t, DIV(V(X[i]), N(2)), line);
        /* carry 只可能是 0/1：用条件加 128 代替乘 128（乘法循环要跑 128 轮） */
        set(hiBit, N(0), line);
        pre.push({ type: 'if', cond: V(carry),
                   then: [{ type: 'set', name: hiBit, expr: N(128), line: line, text: '补入高位' }],
                   else: null, line: line, text: '进位' });
        set(nt, BIN('+', V(t), V(hiBit)), line);
        set(X[i], V(nt), line);
        set(carry, V(lo), line);
      }
    }

    function nonZeroExpr(bs, target, line) {
      set(target, OR(OR(bs[0], bs[1]), OR(bs[2], bs[3])), line);
    }

    /* ---------- 32 位乘法：32 轮移位相加 ---------- */
    function mul32(aE, bE, line) {
      var A = matN(aE, line), B = matN(bE, line), i;
      var acc = [], sh = [], m = [];
      for (i = 0; i < W; i++) {
        acc.push(tmp()); set(acc[i], N(0), line);
        sh.push(tmp());  set(sh[i], V(A[i]), line);
        m.push(tmp());   set(m[i], V(B[i]), line);
      }
      var cnt = tmp();
      set(cnt, N(32), line);
      var body = capture(function () {
        var bit = tmp(), add;
        set(bit, MOD(V(m[0]), N(2)), line);
        add = capture(function () { addInto(acc, sh, line); return null; }).stmts;
        pre.push({ type: 'if', cond: V(bit), then: add, else: null,
                   line: line, text: '乘数当前位为 1 → 累加' });
        shl1(sh, line);
        shr1(m, line, false);
        pre.push({ type: 'sub', name: cnt, expr: N(1), line: line, text: '剩余位 -1' });
        return null;
      }).stmts;
      pre.push({ type: 'while', cond: V(cnt), body: body,
                 line: line, text: 'int32 乘法：32 轮移位相加' });
      return asExpr(acc);
    }

    /* ---------- 32 位无符号除法：32 轮试商 ---------- */
    function ucmpGE(A, B, line) {
      var ge = tmp(), allEq = tmp(), i;
      set(ge, N(0), line);
      set(allEq, N(1), line);
      /* 高位 → 低位扫描：只有「更高位全部相等」时，本位的比较才作数。
         之前用 ge 去与 eqi 相与，低位的大于会把高位的结论盖掉，
         导致 500 >= 1000 被误判成真（运行期除法全错）。 */
      for (i = W - 1; i >= 0; i--) {
        var gt = tmp(), eqi = tmp(), both = tmp(), n = tmp(), eq2 = tmp();
        set(gt, CMP('>', V(A[i]), V(B[i])), line);
        set(eqi, CMP('==', V(A[i]), V(B[i])), line);
        set(both, AND(V(allEq), V(gt)), line);      /* 前面都相等，本位更大 */
        set(n, OR(V(ge), V(both)), line);
        set(ge, V(n), line);
        set(eq2, AND(V(allEq), V(eqi)), line);
        set(allEq, V(eq2), line);
      }
      /* 再并上「完全相等」，得到 >= */
      var res = tmp();
      set(res, OR(V(ge), V(allEq)), line);
      return V(res);
    }

    function udivmod32(aE, bE, line) {
      var A = matN(aE, line), B = matN(bE, line), i;
      var R = [], Q = [], S = [];
      for (i = 0; i < W; i++) {
        R.push(tmp()); set(R[i], N(0), line);
        Q.push(tmp()); set(Q[i], N(0), line);
        S.push(tmp()); set(S[i], V(A[i]), line);
      }
      var cnt = tmp();
      set(cnt, N(32), line);
      var body = capture(function () {
        var bit = tmp(), geq, then;
        set(bit, CMP('>=', V(S[3]), N(128)), line);   /* 被除数当前最高位 */
        shl1(R, line);
        pre.push({ type: 'if', cond: V(bit),
                   then: [{ type: 'set', name: R[0], expr: BIN('+', V(R[0]), N(1)),
                            line: line, text: '余数补入当前位' }],
                   else: null, line: line, text: '余数左移并补位' });
        shl1(S, line);
        shl1(Q, line);
        geq = ucmpGE(R, B, line);
        then = capture(function () { subInto(R, B, line); return null; }).stmts;
        then.push({ type: 'add', name: Q[0], expr: N(1), line: line, text: '商当前位置 1' });
        pre.push({ type: 'if', cond: geq, then: then, else: null,
                   line: line, text: '够减则减并置商位' });
        pre.push({ type: 'sub', name: cnt, expr: N(1), line: line, text: '剩余位 -1' });
        return null;
      }).stmts;
      pre.push({ type: 'while', cond: V(cnt), body: body,
                 line: line, text: 'int32 除法：32 轮试商' });
      return { q: asExpr(Q), r: asExpr(R) };
    }

    /* ---------- 32 位有符号除法 / 取余（截断除法，余数跟被除数符号） ---------- */
    function divmod32(aE, bE, line, wantMod) {
      var A = matN(aE, line), B = matN(bE, line), i;
      var aNeg = tmp(), bNeg = tmp();
      set(aNeg, CMP('>=', V(A[3]), N(128)), line);
      set(bNeg, CMP('>=', V(B[3]), N(128)), line);

      var absA = [], absB = [], qN = [], rN = [], nzB = tmp();
      for (i = 0; i < W; i++) {
        absA.push(tmp()); set(absA[i], V(A[i]), line);
        absB.push(tmp()); set(absB[i], V(B[i]), line);
        qN.push(tmp());   set(qN[i], N(0), line);
        rN.push(tmp());   set(rN[i], N(0), line);
      }
      pre.push({ type: 'if', cond: V(aNeg),
                 then: capture(function () { negate32(absA, line); return null; }).stmts,
                 else: null, line: line, text: 'int32 除法：被除数取绝对值' });
      pre.push({ type: 'if', cond: V(bNeg),
                 then: capture(function () { negate32(absB, line); return null; }).stmts,
                 else: null, line: line, text: 'int32 除法：除数取绝对值' });

      nonZeroExpr(asExpr(B), nzB, line);
      pre.push({
        type: 'if', cond: V(nzB),
        then: capture(function () {
          var res = udivmod32(asExpr(absA), asExpr(absB), line);
          for (var k = 0; k < W; k++) { set(qN[k], res.q[k], line); set(rN[k], res.r[k], line); }
          return null;
        }).stmts,
        else: null, line: line, text: 'int32 除法主体（除数为 0 时结果为 0）'
      });

      pre.push({ type: 'if', cond: CMP('!=', V(aNeg), V(bNeg)),
                 then: capture(function () { negate32(qN, line); return null; }).stmts,
                 else: null, line: line, text: 'int32 除法：商的符号' });
      pre.push({ type: 'if', cond: V(aNeg),
                 then: capture(function () { negate32(rN, line); return null; }).stmts,
                 else: null, line: line, text: 'int32 除法：余数跟随被除数符号' });

      return wantMod ? asExpr(rN) : asExpr(qN);
    }

    /* ---------- 32 位位运算（逐位循环，思路同标准库 __bf_xor） ---------- */
    function bitByte(op, aE, bE, line) {
      var a = tmp(), b = tmp(), r = tmp(), w = tmp(), k = tmp();
      set(a, aE, line);
      set(b, bE, line);
      set(r, N(0), line);
      set(w, N(1), line);
      set(k, N(0), line);
      var body = capture(function () {
        var ba = tmp(), bb = tmp(), hit = tmp();
        set(ba, MOD(V(a), N(2)), line);
        set(bb, MOD(V(b), N(2)), line);
        if (op === '&') set(hit, AND(V(ba), V(bb)), line);
        else if (op === '|') set(hit, OR(V(ba), V(bb)), line);
        else set(hit, CMP('!=', V(ba), V(bb)), line);
        pre.push({ type: 'if', cond: V(hit),
                   then: [{ type: 'add', name: r, expr: V(w), line: line, text: '该位为 1' }],
                   else: null, line: line, text: '逐位判定' });
        set(a, DIV(V(a), N(2)), line);
        set(b, DIV(V(b), N(2)), line);
        set(w, BIN('+', V(w), V(w)), line);
        set(k, BIN('+', V(k), N(1)), line);
        return null;
      }).stmts;
      pre.push({ type: 'while', cond: CMP('<', V(k), N(8)), body: body,
                 line: line, text: 'int32 位运算：逐位 8 轮' });
      return r;
    }

    function bit32(op, aE, bE, line) {
      var A = matN(aE, line), B = matN(bE, line), R = [], i;
      for (i = 0; i < W; i++) R.push(bitByte(op, V(A[i]), V(B[i]), line));
      return asExpr(R);
    }

    function not32(aE, line) {
      var A = matN(aE, line), R = [], i;
      for (i = 0; i < W; i++) {
        var t = tmp();
        set(t, BIN('-', N(255), V(A[i])), line);
        R.push(t);
      }
      return asExpr(R);
    }

    function shift32(op, aE, bE, line) {
      var A = matN(aE, line), n = tmp();
      set(n, bE, line);
      var body = capture(function () {
        if (op === '<<') shl1(A, line); else shr1(A, line, true);
        pre.push({ type: 'sub', name: n, expr: N(1), line: line, text: '移位次数 -1' });
        return null;
      }).stmts;
      pre.push({ type: 'while', cond: V(n), body: body,
                 line: line, text: 'int32 移位：逐位' });
      return asExpr(A);
    }

    /* 纯常量表达式求值（编译期直接算出结果，省掉整段运算代码） */
    function constOf(e) {
      if (!e) return null;
      if (e.k === 'num') {
        return e.i32v != null ? e.i32v : (e.raw != null ? e.raw : e.v);
      }
      if (e.k === 'bin' && (e.op === '+' || e.op === '-')) {
        var x = constOf(e.a), y = constOf(e.b);
        if (x != null && y != null) return e.op === '+' ? (x + y) : (x - y);
        return null;
      }
      if (e.k === 'mul' || e.k === 'div' || e.k === 'mod') {
        var p = constOf(e.a), q = constOf(e.b);
        if (p == null || q == null) return null;
        if (e.k === 'mul') return Math.imul(p, q);
        if (q === 0) return 0;
        return e.k === 'div' ? Math.trunc(p / q) : (p % q);
      }
      return null;
    }

    /* 表达式 → 4 个字节表达式 */
    function bytesOf(e, line) {
      if (!e) return constBytes(0);
      line = line || lineOf(e);
      var t, a, b, c1, c2;

      switch (e.k) {
        case 'num':
          return constBytes(e.i32v != null ? e.i32v : (e.raw != null ? e.raw : e.v));

        case 'var':
          if (isI32(e.name)) return asExpr(bytesOfVarN(e.name));
          t = tmp();
          set(t, e, line);                            /* 8 位值零扩展 */
          return [V(t), N(0), N(0), N(0)];

        case 'bin':
          c1 = constOf(e.a); c2 = constOf(e.b);
          if (c1 != null && c2 != null) {
            return constBytes(e.op === '+' ? (c1 + c2) : (c1 - c2));
          }
          a = bytesOf(e.a, line);
          b = bytesOf(e.b, line);
          return arith(a, b, e.op, line);

        case 'mul':
          c1 = constOf(e.a); c2 = constOf(e.b);
          if (c1 != null && c2 != null) return constBytes(Math.imul(c1, c2));
          a = bytesOf(e.a, line);
          b = bytesOf(e.b, line);
          return mul32(a, b, line);

        case 'div': case 'mod':
          c1 = constOf(e.a); c2 = constOf(e.b);
          if (c1 != null && c2 != null) {
            if (c2 === 0) return constBytes(0);
            return constBytes(e.k === 'div' ? Math.trunc(c1 / c2) : (c1 % c2));
          }
          a = bytesOf(e.a, line);
          b = bytesOf(e.b, line);
          return divmod32(a, b, line, e.k === 'mod');

        case 'i32bit':
          a = bytesOf(e.a, line);
          if (e.fn === '__bf_not' || !e.b) return not32(a, line);
          b = bytesOf(e.b, line);
          return bit32(e.fn === '__bf_and' ? '&' : e.fn === '__bf_or' ? '|' : '^', a, b, line);

        case 'i32shift':
          a = bytesOf(e.a, line);
          /* 位移量按 8 位用（超过 255 本来也没有意义），先落进一个格子 */
          var shN = bytesOf(e.b, line), shT = tmp();
          set(shT, shN[0], line);
          return shift32(e.op, a, V(shT), line);

        case 'cmp': case 'and': case 'or': case 'not':
          t = tmp(); set(t, condOf(e, line), line);   /* 布尔 0/1 零扩展 */
          return [V(t), N(0), N(0), N(0)];

        default:
          t = tmp(); set(t, e, line);
          return [V(t), N(0), N(0), N(0)];
      }
    }

    /* 32 位有符号比较 → 8 位布尔表达式 */
    function cmp32(aBytes, bBytes, op, line) {
      var A = mat(aBytes, line), B = mat(bBytes, line);
      var aNeg = tmp(), bNeg = tmp();
      set(aNeg, CMP('>=', A[3], N(128)), line);
      set(bNeg, CMP('>=', B[3], N(128)), line);

      var lt = tmp(), eq = tmp(), i;
      set(lt, N(0), line);
      set(eq, N(1), line);
      for (i = W - 1; i >= 0; i--) {
        var less = tmp(), same = tmp(), nlt = tmp(), neq = tmp();
        set(less, CMP('<', A[i], B[i]), line);
        set(same, CMP('==', A[i], B[i]), line);
        set(nlt, OR(V(lt), AND(V(eq), V(less))), line);
        set(neq, AND(V(eq), V(same)), line);
        set(lt, V(nlt), line);
        set(eq, V(neq), line);
      }

      var sgnDiff = tmp(), sameSign = tmp(), slt = tmp();
      set(sgnDiff, AND(V(aNeg), NOT(V(bNeg))), line);
      set(sameSign, CMP('==', V(aNeg), V(bNeg)), line);
      set(slt, OR(V(sgnDiff), AND(V(sameSign), V(lt))), line);

      switch (op) {
        case '<':  return V(slt);
        case '>':  return AND(NOT(V(slt)), NOT(V(eq)));
        case '<=': return OR(V(slt), V(eq));
        case '>=': return NOT(V(slt));
        case '==': return V(eq);
        case '!=': return NOT(V(eq));
        default:   return V(slt);
      }
    }

    /* 条件 → 8 位表达式（含 i32 时生成前置语句） */
    function condOf(e, line) {
      if (!e) return N(0);
      line = line || lineOf(e);
      if (e.k === 'cmp' && (hasI32(e.a) || hasI32(e.b))) {
        return cmp32(bytesOf(e.a, line), bytesOf(e.b, line), e.op, line);
      }
      if (e.k === 'and' || e.k === 'or') {
        return { k: e.k, a: condOf(e.a, line), b: condOf(e.b, line), line: line };
      }
      if (e.k === 'not') return NOT(condOf(e.a, line));
      if (e.k === 'var' && isI32(e.name)) {
        var bs = asExpr(bytesOfVarN(e.name)), r = tmp();
        set(r, OR(OR(bs[0], bs[1]), OR(bs[2], bs[3])), line);
        return V(r);
      }
      /* 位运算 / 移位 / 乘除的结果当条件：先算成 4 个字节，再取「非零」 */
      if (e.k === 'i32bit' || e.k === 'i32shift' ||
          ((e.k === 'mul' || e.k === 'div' || e.k === 'mod') && hasI32(e))) {
        var rb = bytesOf(e, line), rz = tmp();
        set(rz, OR(OR(rb[0], rb[1]), OR(rb[2], rb[3])), line);
        return V(rz);
      }
      return e;
    }

    /* 把条件算进指定格子，返回这段语句（不污染当前 pre） */
    function condStmts(cond, target, line) {
      return capture(function () {
        set(target, condOf(cond, line), line);
        return null;
      }).stmts;
    }

    /* ---------- 十进制输出 ---------- */
    /* workN: 4 个变量名；就地 work /= 10，返回余数变量名 */
    function div10(workN, line) {
      var rem = tmp();
      set(rem, N(0), line);
      for (var i = W - 1; i >= 0; i--) {
        var hi = tmp(), lo = tmp(), t = tmp(), qe = tmp(), r2 = tmp();
        set(hi, DIV(V(workN[i]), N(10)), line);
        set(lo, MOD(V(workN[i]), N(10)), line);
        /* cur = rem*256 + byte = (rem*25+hi+u/10)*10 + u%10, u = rem*6+lo */
        set(t, BIN('+', MUL(V(rem), N(6)), V(lo)), line);
        set(qe, DIV(V(t), N(10)), line);
        set(r2, MOD(V(t), N(10)), line);
        set(workN[i], BIN('+', BIN('+', MUL(V(rem), N(25)), V(hi)), V(qe)), line);
        set(rem, V(r2), line);
      }
      return rem;
    }

    /* workN = -workN（取反加一） */
    function negate32(workN, line) {
      var cp = [], i;
      for (i = 0; i < W; i++) { cp.push(tmp()); set(cp[i], V(workN[i]), line); }
      for (i = 0; i < W; i++) set(workN[i], BIN('-', N(255), V(cp[i])), line);
      var r = arith(asExpr(workN), [N(1), N(0), N(0), N(0)], '+', line);
      for (i = 0; i < W; i++) set(workN[i], r[i], line);
    }

    function print32(bytes, line, dec) {
      dec = dec || 0;
      var workN = matN(bytes, line), i;
      var isNeg = tmp();
      set(isNeg, CMP('>=', V(workN[3]), N(128)), line);

      var negBody = capture(function () {
        pre.push({ type: 'out', expr: N(45), line: line, text: '输出负号' });
        negate32(workN, line);
        return null;
      }).stmts;
      pre.push({ type: 'if', cond: V(isNeg), then: negBody, else: null,
                 line: line, text: 'int32 负数处理' });

      /* 32 位最多 10 位十进制。只生成「一份」长除法放进 while 反复跑：
         每轮把已收集的数字整体后移一格，新的（更高位的）余数放 d[0]，
         因此 d[0..count-1] 就是高位到低位。展开 10 份除法会让单次 printf
         生成上百万条指令，这里压到约十分之一。 */
      function workNonZero(target) {
        set(target, OR(OR(V(workN[0]), V(workN[1])), OR(V(workN[2]), V(workN[3]))), line);
      }

      var digits = [], k;
      for (k = 0; k < 10; k++) { digits.push(tmp()); set(digits[k], N(0), line); }
      var cnt = tmp(), nzw = tmp(), tz = tmp(), nz = tmp();
      set(cnt, N(0), line);
      set(nzw, N(1), line);          /* 强制至少一轮：数值为 0 时也要输出 "0" */
      set(tz, N(0), line);           /* 末尾连续 0 的个数（定点小数去掉尾零用） */
      set(nz, N(0), line);           /* 是否出现过非零位 */

      var divLoop = capture(function () {
        for (var j = 9; j >= 1; j--) set(digits[j], V(digits[j - 1]), line);
        var rem = div10(workN, line);
        set(digits[0], V(rem), line);
        pre.push({ type: 'add', name: cnt, expr: N(1), line: line, text: '位数 +1' });
        if (dec) {
          /* 低位先被取出：还没遇到非零位时的 0 就是「尾零」 */
          var zeroTail = tmp();
          set(zeroTail, AND(CMP('==', V(rem), N(0)), CMP('==', V(nz), N(0))), line);
          pre.push({ type: 'if', cond: V(zeroTail),
                     then: [{ type: 'add', name: tz, expr: N(1), line: line, text: '尾零 +1' }],
                     else: [{ type: 'set', name: nz, expr: N(1), line: line, text: '出现非零位' }],
                     line: line, text: '统计尾零' });
        }
        workNonZero(nzw);
        return null;
      }).stmts;
      pre.push({ type: 'while', cond: V(nzw), body: divLoop,
                 line: line, text: 'int32 反复 /10 取各位' });

      /* ---------- 整数输出 ---------- */
      function outIntPart() {
        /* 必须用 capture：set() 会立刻写进当前 pre，如果直接循环调用，
           10 个「剩余位数」判断都会排在 if 之前一次算完，变成打印 10 位。 */
        return capture(function () {
          var left = tmp();
          set(left, V(cnt), line);
          for (var j = 0; j < 10; j++) {
            var more = tmp();
            set(more, CMP('>', V(left), N(0)), line);
            pre.push({
              type: 'if', cond: V(more),
              then: [
                { type: 'out', expr: BIN('+', V(digits[j]), N(48)), line: line, text: '输出十进制位' },
                { type: 'sub', name: left, expr: N(1), line: line, text: '剩余位数 -1' }
              ], else: null, line: line, text: '按实际位数输出'
            });
          }
          return null;
        }).stmts;
      }

      if (!dec) {
        pre.push.apply(pre, outIntPart());
        return;
      }

      /* ---------- 定点小数输出 ----------
         数字串是「右对齐」的：整数部分有 ic = cnt - dec 位。
         小数部分从 ic 开始，末尾连续的 0 不打印；ic = 0 时先输出 "0."。 */
      var ic = tmp(), hasInt = tmp();
      set(hasInt, CMP('>', V(cnt), N(dec)), line);
      set(ic, N(0), line);
      pre.push({
        type: 'if', cond: V(hasInt),
        then: [{ type: 'set', name: ic, expr: BIN('-', V(cnt), N(dec)), line: line, text: '整数位数' }],
        else: null, line: line, text: '有整数部分吗'
      });

      /* 从 from 位置输出到 to 位置（from 为 null 表示从第 0 位开始） */
      function outRange(fromE, toE) {
        var list = [], j;
        for (j = 0; j < 10; j++) {
          var cond = CMP('<=', N(j), toE);
          if (fromE) cond = AND(CMP('>=', N(j), fromE), cond);
          list.push({
            type: 'if', cond: cond,
            then: [{ type: 'out', expr: BIN('+', V(digits[j]), N(48)),
                     line: line, text: '输出小数位' }],
            else: null, line: line, text: '小数第 ' + j + ' 位'
          });
        }
        return list;
      }

      var last = tmp();
      set(last, BIN('-', BIN('-', V(cnt), N(1)), V(tz)), line);   /* 最后一个非零位 */
      var pad = tmp();
      set(pad, BIN('-', N(dec), V(cnt)), line);

      /* 整数部分 + 小数点 + 小数部分整体放进 if(nz) 里。
         这里必须用 capture：直接调用 set() 会把语句提前排到 if 外面，
         「剩余位数」就会在分支执行前一次算完，变成打印全部 10 位。 */
      var body = capture(function () {
        /* 整数部分：ic 位；ic == 0 时输出一个 0 */
        var left = tmp();
        set(left, V(ic), line);
        pre.push({ type: 'if', cond: CMP('==', V(ic), N(0)),
                   then: [{ type: 'out', expr: N(48), line: line, text: '整数部分 0' }],
                   else: null, line: line, text: '没有整数位' });
        for (var j = 0; j < 10; j++) {
          var more2 = tmp();
          set(more2, CMP('>', V(left), N(0)), line);
          pre.push({
            type: 'if', cond: V(more2),
            then: [
              { type: 'out', expr: BIN('+', V(digits[j]), N(48)), line: line, text: '输出整数位' },
              { type: 'sub', name: left, expr: N(1), line: line, text: '剩余位数 -1' }
            ], else: null, line: line, text: '整数位 ' + j
          });
        }

        /* 有小数位时：'.' + 前导 0 + 有效小数位 */
        var frac = [{ type: 'out', expr: N(46), line: line, text: '小数点' }];
        frac.push({
          type: 'if', cond: NOT(V(hasInt)),
          then: [{ type: 'while', cond: CMP('>', V(pad), N(0)),
                   body: [
                     { type: 'out', expr: N(48), line: line, text: '小数前导 0' },
                     { type: 'sub', name: pad, expr: N(1), line: line }
                   ], line: line, text: '补前导零' }].concat(outRange(null, V(last))),
          else: outRange(V(ic), V(last)), line: line, text: '小数部分'
        });
        pre.push({ type: 'if', cond: CMP('>=', V(last), V(ic)), then: frac,
                   else: null, line: line, text: '末位非零才输出小数点' });
        return null;
      }).stmts;

      pre.push({ type: 'if', cond: V(nz), then: body,
                 else: [{ type: 'out', expr: N(48), line: line, text: '值为 0' }],
                 line: line, text: '定点数输出' });
    }

    /* ---------- 十进制输入（含负号，可选小数点） ---------- */
    /* xN = xN * 10（4 次 32 位加法合成） */
    function mul10InPlace(xN, line) {
      var xE = asExpr(xN);
      var t2 = arith(xE, xE, '+', line);
      var t4 = arith(t2, t2, '+', line);
      var t8 = arith(t4, t4, '+', line);
      var x10 = arith(t2, t8, '+', line);
      for (var k = 0; k < W; k++) set(xN[k], x10[k], line);
    }

    function read32(name, line, dec) {
      dec = dec || 0;
      var c = tmp(), neg = tmp(), i;
      var xN = bytesOfVarN(name);

      pre.push({ type: 'in', name: c, line: line, text: 'int32 输入：读首字符' });
      pre.push({ type: 'while', cond: CMP('<=', V(c), N(32)),
                 body: [{ type: 'in', name: c, line: line, text: '跳过空白' }],
                 line: line, text: 'int32 输入：跳过空白' });
      set(neg, N(0), line);
      pre.push({
        type: 'if', cond: CMP('==', V(c), N(45)),
        then: [
          { type: 'set', name: neg, expr: N(1), line: line, text: '记录负号' },
          { type: 'in', name: c, line: line, text: '读下一个字符' }
        ], else: null, line: line, text: 'int32 输入：负号'
      });
      for (i = 0; i < W; i++) set(xN[i], N(0), line);

      var body = capture(function () {
        var d = tmp();
        set(d, BIN('-', V(c), N(48)), line);
        mul10InPlace(xN, line);
        var xd = arith(asExpr(xN), [V(d), N(0), N(0), N(0)], '+', line);
        for (var k = 0; k < W; k++) set(xN[k], xd[k], line);
        pre.push({ type: 'in', name: c, line: line, text: '读下一个字符' });
        return null;
      }).stmts;

      pre.push({
        type: 'while',
        cond: AND(CMP('>=', V(c), N(48)), CMP('<=', V(c), N(57))),
        body: body, line: line, text: 'int32 输入：逐位累加'
      });

      /* 浮点：小数点后最多读 dec 位，不足的补 0（1.5 → 1500） */
      if (dec) {
        var kk = tmp();
        set(kk, N(0), line);
        pre.push({
          type: 'if', cond: CMP('==', V(c), N(46)),
          then: [{ type: 'in', name: c, line: line, text: 'float 输入：读第一位小数' }],
          else: null, line: line, text: 'float 输入：小数点'
        });
        var fracBody = capture(function () {
          var d2 = tmp();
          set(d2, BIN('-', V(c), N(48)), line);
          mul10InPlace(xN, line);
          var xd2 = arith(asExpr(xN), [V(d2), N(0), N(0), N(0)], '+', line);
          for (var k2 = 0; k2 < W; k2++) set(xN[k2], xd2[k2], line);
          pre.push({ type: 'add', name: kk, expr: N(1), line: line, text: '小数位数 +1' });
          pre.push({ type: 'in', name: c, line: line, text: '读下一位小数' });
          return null;
        }).stmts;
        pre.push({
          type: 'while',
          cond: AND(AND(CMP('>=', V(c), N(48)), CMP('<=', V(c), N(57))),
                    CMP('<', V(kk), N(dec))),
          body: fracBody, line: line, text: 'float 输入：逐位累加小数'
        });
        var padBody = capture(function () {
          mul10InPlace(xN, line);
          pre.push({ type: 'add', name: kk, expr: N(1), line: line, text: '小数位数 +1' });
          return null;
        }).stmts;
        pre.push({
          type: 'while', cond: CMP('<', V(kk), N(dec)), body: padBody,
          line: line, text: 'float 输入：补足小数位'
        });
      }

      var negBody2 = capture(function () {
        var w = matN(asExpr(xN), line);
        negate32(w, line);
        for (var k = 0; k < W; k++) set(xN[k], V(w[k]), line);
        return null;
      }).stmts;
      pre.push({ type: 'if', cond: V(neg), then: negBody2, else: null,
                 line: line, text: 'int32 输入：取负' });
    }

    /* ---------- 语句降级 ---------- */
    function lowerList(list, loopCtx) {
      var out = [];
      (list || []).forEach(function (n) {
        if (!n) return;
        var line = n.line || 1, i, r, m, bytes;

        switch (n.type) {
          case 'decl':
            if (n.kind !== 'i32' && n.kind !== 'f32') {
              /* 8 位变量用 int32 表达式初始化：先降级表达式，再取低字节 */
              if (!hasI32(n.init)) { out.push(n); return; }
              r = capture(function () { return bytesOf(n.init, line); });
              out.push.apply(out, r.stmts);
              out.push({ type: 'decl', name: n.name, init: r.value[0], kind: n.kind,
                         line: line, text: n.text });
              return;
            }
            r = capture(function () { return bytesOf(n.init, line); });
            out.push.apply(out, r.stmts);
            m = capture(function () { return matN(r.value, line); });
            out.push.apply(out, m.stmts);
            for (i = 0; i < W; i++) {
              out.push({ type: 'decl', name: byteName(n.name, i), init: V(m.value[i]),
                         kind: 'int', line: line,
                         text: (n.kind === 'f32' ? 'float ' : 'int32 ') + n.name + ' 字节 ' + i });
            }
            return;

          case 'set': case 'add': case 'sub':
            if (!isI32(n.name)) {
              /* 目标不是 int32，但表达式里有：降级后按低 8 位截断赋值。
                 for 的倒计数、int32 → char 赋值都走这条分支。 */
              if (n.type !== 'set' || !hasI32(n.expr)) { out.push(n); return; }
              r = capture(function () { return bytesOf(n.expr, line); });
              out.push.apply(out, r.stmts);
              out.push({ type: 'set', name: n.name, expr: r.value[0], line: line, text: n.text });
              return;
            }
            r = capture(function () {
              if (n.type === 'set') return bytesOf(n.expr, line);
              return arith(asExpr(bytesOfVarN(n.name)), bytesOf(n.expr, line),
                           n.type === 'add' ? '+' : '-', line);
            });
            out.push.apply(out, r.stmts);
            m = capture(function () { return matN(r.value, line); });
            out.push.apply(out, m.stmts);
            for (i = 0; i < W; i++) {
              out.push({ type: 'set', name: byteName(n.name, i), expr: V(m.value[i]),
                         line: line, text: 'int32 ' + n.name + ' 字节 ' + i });
            }
            return;

          case 'innum':
            if (!isI32(n.name)) { out.push(n); return; }
            out.push.apply(out, capture(function () { read32(n.name, line, n.dec); return null; }).stmts);
            return;

          case 'in':
            if (!isI32(n.name)) { out.push(n); return; }
            out.push({ type: 'in', name: byteName(n.name, 0), line: line, text: 'int32 低字节' });
            for (i = 1; i < W; i++) {
              out.push({ type: 'set', name: byteName(n.name, i), expr: N(0),
                         line: line, text: 'int32 高位清零' });
            }
            return;

          case 'outdec':
            if (!hasI32(n.expr)) { out.push(n); return; }
            r = capture(function () { return bytesOf(n.expr, line); });
            out.push.apply(out, r.stmts);
            bytes = r.value;
            out.push.apply(out, capture(function () { print32(bytes, line, n.scale); return null; }).stmts);
            return;

          case 'out':
            if (!hasI32(n.expr)) { out.push(n); return; }
            r = capture(function () { return bytesOf(n.expr, line); });
            out.push.apply(out, r.stmts);
            out.push({ type: 'out', expr: r.value[0], line: line, text: 'int32 按字符输出低字节' });
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
            if (!hasI32(n.cond)) {
              out.push({ type: 'while', cond: n.cond, body: lowerList(n.body, loopCtx),
                         line: line, text: n.text });
              return;
            }
            var ct = tmp();
            out.push.apply(out, condStmts(n.cond, ct, line));
            var ctx = { cond: n.cond, target: ct, line: line };
            var body2 = lowerList(n.body, ctx).concat(condStmts(n.cond, ct, line));
            out.push({ type: 'while', cond: V(ct), body: body2, line: line, text: n.text });
            return;

          case 'cont':
            /* continue 会跳过后续语句，所以在它之前补一次条件重算 */
            if (loopCtx) out.push.apply(out, condStmts(loopCtx.cond, loopCtx.target, loopCtx.line));
            out.push(n);
            return;

          case 'callset':
          case 'call':
            /* 函数参数 / 返回值只支持 8 位（已告警）：int32 实参取低字节 */
            if (!n.args || !n.args.some(hasI32)) { out.push(n); return; }
            var nargs = [];
            for (i = 0; i < n.args.length; i++) {
              if (hasI32(n.args[i])) {
                r = capture(function () { return bytesOf(n.args[i], line); });
                out.push.apply(out, r.stmts);
                nargs.push(r.value[0]);
              } else nargs.push(n.args[i]);
            }
            out.push({ type: n.type, target: n.target, fn: n.fn, name: n.name,
                       args: nargs, line: line, text: n.text });
            return;

          case 'ret':
            if (!hasI32(n.expr)) { out.push(n); return; }
            r = capture(function () { return bytesOf(n.expr, line); });
            out.push.apply(out, r.stmts);
            out.push({ type: 'ret', expr: r.value[0], line: line, text: n.text });
            return;

          default:
            out.push(n);           /* outstr / call / brk / ret / stepmark … */
            return;
        }
      });
      return out;
    }

    /* 收集执行 fn 期间产生的前置语句 */
    function capture(fn) {
      var save = pre;
      pre = [];
      var value = fn();
      var stmts = pre;
      pre = save;
      return { value: value, stmts: stmts };
    }

    var onlyFloat = false;
    (function () {
      var hasI = false, hasF = false;
      Object.keys(types || {}).forEach(function (k) {
        if (types[k] === 'i32') hasI = true;
        if (types[k] === 'f32') hasF = true;
      });
      onlyFloat = hasF && !hasI;
    })();

    if (onlyFloat) {
      warn('float / double 用「放大 1000 倍的 32 位定点数」实现：固定 3 位小数、范围约 ±214 万、' +
           '精度 0.001。纯常量的四则运算会在编译期算完（不生成任何运算代码），' +
           '运行期的乘除代价较高（单次约 32 轮移位 / 试商），不宜放进高频内层循环；' +
           'float 暂不支持作为函数参数 / 返回值（按 8 位降级）', 1);
    } else {
      warn('已启用 int32（4 格软件模拟，含负数）：生成代码与运行步数明显大于 8 位整数；' +
           '乘 / 除 / 取余 / 位运算按 32 位实现但代价较高（单次乘法约 32 轮移位相加、' +
           '除法约 32 轮试商），不适合放进高频内层循环；int32 暂不支持作为函数参数 / 返回值（按 8 位降级）', 1);
    }

    return { ir: lowerList(nodes, null), seq: seq };
  }

  TC.I32 = { lower: lower, WIDTH: W };
})(window.TC = window.TC || {});
