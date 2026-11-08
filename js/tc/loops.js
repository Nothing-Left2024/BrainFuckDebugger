/* =========================================================================
 * tc/loops.js —— break / continue 的 IR 改写
 *
 * BrainFuck 只有 [ ] 两种跳转，没法直接“跳出循环”，所以把 break/continue
 * 改写成「标志位 + 条件守卫」，全部在 IR 层完成，代码生成器完全不用知道
 * 它们存在：
 *
 *   while (cond) {          →      跳过 = 0;  跳出 = 0;
 *     A;                            while (cond && !跳出) {
 *     if (x) break;                   A;
 *     B;                              if (!跳过) { B; }
 *     continue;                       if (!跳过) { 跳过 = 1; }        ← continue
 *     C;                              if (!跳过) { 跳出 = 1; }        ← break（同时置跳过）
 *   }                                 if (!跳过) { C; }
 *                                     跳过 = 0;
 *                                   }
 *
 * 要点：
 *   · 守卫用的是同一个「跳过」标志：break 和 continue 都是“本层剩下的别做了”，
 *     区别只在 break 额外把「跳出」置 1，让循环条件变假。
 *   · for 循环的第三段（步进）用 stepmark 标出位置：continue 之后步进照常执行，
 *     所以进入步进区后守卫换成 !跳出。
 *   · 不带 break/continue 的循环一行代码都不变（零开销）。
 * ========================================================================= */
(function (TC) {
  'use strict';

  var seq = 0;

  function setNode(name, v, line, text) {
    return { type: 'set', name: name, expr: { k: 'num', v: v }, line: line, text: text };
  }

  function notVar(name, line) {
    return { k: 'not', a: { k: 'var', name: name }, line: line };
  }

  /* 本层有没有 break/continue（不进入嵌套循环 —— 那是它们自己的层级） */
  function scanEsc(list, acc) {
    (list || []).forEach(function (n) {
      if (!n) return;
      if (n.type === 'brk') acc.brk = true;
      else if (n.type === 'cont') acc.cont = true;
      else if (n.type === 'if') {
        scanEsc(n.then, acc);
        scanEsc(n.else, acc);
      }
    });
    return acc;
  }

  /* 先把嵌套循环（和 if 里的嵌套循环）处理好，本层的 brk/cont 原样留着 */
  function lowerDeep(list) {
    var out = [];
    (list || []).forEach(function (n) {
      if (!n) return;
      if (n.type === 'while') {
        out.push.apply(out, lowerLoop(n));
        return;
      }
      if (n.type === 'if') {
        out.push({
          type: 'if', cond: n.cond, then: lowerDeep(n.then),
          else: n.else ? lowerDeep(n.else) : null, line: n.line, text: n.text
        });
        return;
      }
      out.push(n);
    });
    return out;
  }

  /* 单条语句 → { list, escaped }；escaped 表示「执行到这里可能已经跳过/跳出」 */
  function subst(n, ctx) {
    if (n.type === 'brk') {
      return {
        list: [
          setNode(ctx.skip, 1, n.line, n.text),
          setNode(ctx.brk, 1, n.line)
        ],
        escaped: true
      };
    }

    if (n.type === 'cont') {
      return { list: [setNode(ctx.skip, 1, n.line, n.text)], escaped: true };
    }

    if (n.type === 'if') {
      var t = walk(n.then, ctx);
      var e = n.else ? walk(n.else, ctx) : null;
      return {
        list: [{
          type: 'if', cond: n.cond, then: t.list,
          else: e ? e.list : null, line: n.line, text: n.text
        }],
        escaped: t.escaped || (e ? e.escaped : false)
      };
    }

    return { list: [n], escaped: false };
  }

  /* 语句块 → { list, escaped }；escaped 的语句之后全部包进 if (!守卫) */
  function walk(list, ctx) {
    var out = [];
    var escaped = false;
    var inStep = false;
    var bodyEscaped = false;

    (list || []).forEach(function (n) {
      if (!n) return;

      if (n.type === 'stepmark') {
        inStep = true;
        bodyEscaped = escaped;   /* 步进区：continue 不跳过，但 break 要跳过 */
        escaped = false;
        return;
      }

      var r = subst(n, ctx);
      if (!r.list.length) { if (r.escaped) escaped = true; return; }

      var guard = inStep ? (escaped || bodyEscaped) : escaped;
      var guardCell = inStep ? ctx.brk : ctx.skip;

      if (guard) {
        out.push({
          type: 'if', cond: notVar(guardCell, n.line), then: r.list, else: null,
          line: n.line, text: '（前面已经 break / continue，这段被跳过）'
        });
      } else {
        out.push.apply(out, r.list);
      }

      if (r.escaped) escaped = true;
    });

    return { list: out, escaped: escaped };
  }

  /* 没有 break/continue 的循环：只把 stepmark 这类纯标记去掉 */
  function stripMarks(list) {
    return (list || []).filter(function (n) { return n && n.type !== 'stepmark'; });
  }

  /**
   * 一个 while 节点 → 替换用的节点数组
   */
  function lowerLoop(node) {
    var body = lowerDeep(node.body);                 /* 嵌套循环先各自处理好 */
    var esc = scanEsc(body, { brk: false, cont: false });

    if (!esc.brk && !esc.cont) {
      return [{ type: 'while', cond: node.cond, body: stripMarks(body), line: node.line, text: node.text }];
    }

    var id = ++seq;
    var ctx = { skip: '__skip' + id, brk: '__brk' + id };

    var wb = walk(body, ctx);

    /* 一轮结束把「跳过」复位；break 不需要复位（循环已经结束） */
    var inner = wb.list.concat([setNode(ctx.skip, 0, node.line)]);

    var cond = node.cond;
    if (esc.brk) {
      cond = {
        k: 'and', a: cond, b: notVar(ctx.brk, node.line), line: node.line
      };
    }

    return [
      setNode(ctx.brk, 0, node.line, 'break 标志清零'),
      setNode(ctx.skip, 0, node.line, '跳过标志清零'),
      {
        type: 'while', cond: cond, body: inner, line: node.line,
        text: (node.text || '') + (esc.brk ? ' ［含 break］' : ' ［含 continue］')
      }
    ];
  }

  function run(ir) { return lowerDeep(ir); }

  TC.Loops = { run: run, lowerLoop: lowerLoop };
})(window.TC = window.TC || {});
