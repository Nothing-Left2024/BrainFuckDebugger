/* =========================================================================
 * tc/fold.js —— 常量折叠 / 代数化简
 *
 * 在生成 BrainFuck 之前把能确定的表达式一次算完，直接缩短生成的指令流：
 *   · 常量之间：+ - * / % 与比较、&& || ! 全部在编译期求值
 *   · 代数恒等：x + 0、x - 0、x * 0、x * 1、x / 1、x % 1、0 * x、0 / x
 * 之所以能放心折叠：表达式里没有副作用 —— 函数调用在解析阶段就被提成
 * 独立语句（__crN = f(...)），留下的只是纯算术。
 * 所有算术按 8 位无符号回绕，与运行期行为一致。
 * ========================================================================= */
(function (TC) {
  'use strict';

  function toByte(v) { return ((v | 0) % 256 + 256) % 256; }
  function num(v) { return { k: 'num', v: toByte(v) }; }
  function isNum(e) { return !!e && e.k === 'num'; }

  /* 常量之间的运算；除数 / 模数为 0 时按 0 处理（运行期同样会跳过） */
  function constArith(kind, op, a, b, line) {
    if (kind === 'bin') return num(op === '+' ? a + b : a - b);
    if (kind === 'mul') return num(a * b);
    if (kind === 'div') return b === 0 ? num(0) : num(Math.floor(a / b));
    if (kind === 'mod') return b === 0 ? num(0) : num(a % b);
    return null;
  }

  function constCmp(op, a, b) {
    switch (op) {
      case '<': return a < b;
      case '>': return a > b;
      case '<=': return a <= b;
      case '>=': return a >= b;
      case '==': return a === b;
      case '!=': return a !== b;
    }
    return false;
  }

  function foldExpr(e) {
    if (!e) return e;

    switch (e.k) {
      case 'num':
      case 'var':
        return e;

      case 'bin':
      case 'mul':
      case 'div':
      case 'mod': {
        var a = foldExpr(e.a);
        var b = foldExpr(e.b);

        if (isNum(a) && isNum(b)) return constArith(e.k, e.op, a.v, b.v, e.line);

        if (e.k === 'mul') {
          if ((isNum(a) && a.v === 0) || (isNum(b) && b.v === 0)) return num(0);
          if (isNum(b) && b.v === 1) return a;
          if (isNum(a) && a.v === 1) return b;
        }

        if (e.k === 'div') {
          if (isNum(a) && a.v === 0) return num(0);
          if (isNum(b)) {
            if (b.v === 0) return num(0);      /* 除零：按 0 处理，不生成任何指令 */
            if (b.v === 1) return a;
          }
        }

        if (e.k === 'mod') {
          if (isNum(a) && a.v === 0) return num(0);
          if (isNum(b) && (b.v === 1 || b.v === 0)) return num(0);
        }

        if (e.k === 'bin') {
          if (isNum(b) && b.v === 0) return a;               /* x + 0 / x - 0 */
          if (e.op === '-' && b.k === 'var' && a.k === 'var' && a.name === b.name) return num(0);
        }

        return { k: e.k, op: e.op, a: a, b: b, line: e.line };
      }

      case 'cmp': {
        var ca = foldExpr(e.a);
        var cb = foldExpr(e.b);
        if (isNum(ca) && isNum(cb)) return num(constCmp(e.op, ca.v, cb.v) ? 1 : 0);
        if (e.op === '==' && ca.k === 'var' && cb.k === 'var' && ca.name === cb.name) return num(1);
        if (e.op === '!=' && ca.k === 'var' && cb.k === 'var' && ca.name === cb.name) return num(0);
        return { k: 'cmp', op: e.op, a: ca, b: cb, line: e.line };
      }

      case 'and': {
        var la = foldExpr(e.a);
        var lb = foldExpr(e.b);
        if (isNum(la) && isNum(lb)) return num(la.v && lb.v ? 1 : 0);
        /* 条件上下文里“非 0 即真”，所以 x && 1 直接就是 x */
        if (isNum(la)) return la.v ? lb : num(0);
        if (isNum(lb)) return lb.v ? la : num(0);
        return { k: 'and', a: la, b: lb, line: e.line };
      }

      case 'or': {
        var oa = foldExpr(e.a);
        var ob = foldExpr(e.b);
        if (isNum(oa) && isNum(ob)) return num(oa.v || ob.v ? 1 : 0);
        if (isNum(oa)) return oa.v ? num(1) : ob;
        if (isNum(ob)) return ob.v ? num(1) : oa;
        return { k: 'or', a: oa, b: ob, line: e.line };
      }

      case 'not': {
        var na = foldExpr(e.a);
        if (isNum(na)) return num(na.v ? 0 : 1);
        return { k: 'not', a: na, line: e.line };
      }

      default:
        /* 指针地址用错地方（printf("%d", &a)）会留到 Inline 之后。
           真正的指针实参早被 inline 消化掉了，这里按 0 兜底，别让 codegen 崩。 */
        if (e.k === 'ptrarg' || e.k === 'addr') return num(0);
        return e;
    }
  }

  /* 递归处理语句树 */
  function foldList(list) {
    (list || []).forEach(function (n) {
      if (!n) return;
      if (n.expr) n.expr = foldExpr(n.expr);
      if (n.cond) n.cond = foldExpr(n.cond);
      if (n.type === 'while') foldList(n.body);
      if (n.type === 'if') {
        foldList(n.then);
        if (n.else) foldList(n.else);
      }
    });
    return list;
  }

  function run(ir) { return foldList(ir); }

  TC.Fold = { run: run, expr: foldExpr };
})(window.TC = window.TC || {});
