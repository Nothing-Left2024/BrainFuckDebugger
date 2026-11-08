/* =========================================================================
 * core/compiler.js —— 源码编译
 * 把带注释的源码压成指令表，并建立括号跳转表 / 字符下标索引 / 行首偏移表。
 * 纯函数，不碰 DOM。
 *
 * 大文件省内存（关键）：指令表用 TypedArray 而不是「每条指令一个对象」。
 * 一个 30 MB 的 .bf 大约有 3000 万条指令 —— 旧版会生成 3000 万个
 * {ch,i,line} 对象，再加一个 3000 万项的 Map（字符下标→指令序号），
 * 合起来是好几 GB 且 GC 压力极大。现在只需 ch(1B) + pos(4B) + line(4B)
 * 三条定长数组（约 270 MB），字符下标改走 pos[] 的二分查找。
 * ========================================================================= */
(function (BF) {
  'use strict';

  var OPS = '+-<>[].,';
  /* ASCII 查表比每字符 OPS.indexOf(c) 快得多（3000 万次扫描 ×2 遍） */
  var IS_OP = new Uint8Array(128);
  for (var q = 0; q < OPS.length; q++) IS_OP[OPS.charCodeAt(q)] = 1;

  var NL = 10, LB = 91, RB = 93;

  /**
   * @param {string} code
   * @returns {{length:number, ch:Uint8Array, pos:Uint32Array, line:Uint32Array,
   *            jumps:Map, offsets:Uint32Array, unbalanced:string}}
   *   ch[i]      指令字符的 ASCII 码
   *   pos[i]     在源码字符串里的字符下标
   *   line[i]    行号（1 起）
   *   jumps      指令序号 -> 配对指令序号（双向；只有括号才有项，保持稀疏）
   *   offsets    每行起始字符下标
   */
  function compile(code) {
    var len = code.length;
    var i, cc;

    /* 第一遍只计数，好一次性分配定长 TypedArray。
       不先 push 到普通数组再转换 —— 那样会临时多占几百 MB。 */
    var nOps = 0, nLines = 1;
    for (i = 0; i < len; i++) {
      cc = code.charCodeAt(i);
      if (cc === NL) { nLines++; continue; }
      if (cc < 128 && IS_OP[cc]) nOps++;
    }

    var ch = new Uint8Array(nOps);
    var pos = new Uint32Array(nOps);
    var line = new Uint32Array(nOps);
    var offsets = new Uint32Array(nLines);
    offsets[0] = 0;

    var jumps = new Map();
    var stack = [];
    var bad = '';
    var lineNo = 1, lineIdx = 1, idx = 0, open;

    for (i = 0; i < len; i++) {
      cc = code.charCodeAt(i);
      if (cc === NL) { lineNo++; offsets[lineIdx++] = i + 1; continue; }
      if (cc >= 128 || !IS_OP[cc]) continue;   /* 非指令字符 = 注释 */

      ch[idx] = cc;
      pos[idx] = i;
      line[idx] = lineNo;

      if (cc === LB) {
        stack.push(idx);
      } else if (cc === RB) {
        if (!stack.length) {
          bad = bad || ('第 ' + lineNo + ' 行的 ] 没有匹配的 [');
        } else {
          open = stack.pop();
          jumps.set(open, idx);
          jumps.set(idx, open);
        }
      }
      idx++;
    }

    if (!bad && stack.length) bad = '第 ' + line[stack[0]] + ' 行的 [ 没有匹配的 ]';

    return {
      length: nOps,
      ch: ch, pos: pos, line: line,
      jumps: jumps, offsets: offsets,
      unbalanced: bad
    };
  }

  /* 编译并写入全局状态 */
  function apply(code) {
    var program = compile(code);
    var S = BF.state;
    S.ops = program;
    S.jumps = program.jumps;
    S.offsets = program.offsets;
    S.unbalanced = program.unbalanced;
    return program;
  }

  /* 字符下标 -> 指令序号。取代原先「每条指令一个 Map 项」的 opByChar，
     pos[] 天然递增，二分即可；只在光标贴着括号做配对高亮时用。 */
  function opAtPos(ops, p) {
    var arr = ops.pos;
    var lo = 0, hi = ops.length - 1, mid, v;
    while (lo <= hi) {
      mid = (lo + hi) >> 1;
      v = arr[mid];
      if (v === p) return mid;
      if (v < p) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  }

  /* 字符下标 -> 行号（1 起）；offsets 是递增的普通数组或 TypedArray */
  function lineAtPos(offsets, pos) {
    var lo = 0, hi = offsets.length - 1, mid;
    while (lo < hi) {
      mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  }

  BF.Compiler = {
    compile: compile,
    apply: apply,
    opAtPos: opAtPos,
    lineAtPos: lineAtPos
  };
})(window.BF);
