/* =========================================================================
 * core/history.js —— 执行历史（支撑「上一步」单步回退）
 * 每条指令只记「影响到的旧值」，用定长环形缓冲区存放，
 * 高速运行时也不会产生大量临时对象。容量之外的老记录自动被覆盖。
 * ========================================================================= */
(function (BF) {
  'use strict';

  var CAP = 50000;

  var buf = {
    pc: new Int32Array(CAP),
    ptr: new Int32Array(CAP),
    cell: new Int32Array(CAP),   /* 被改写的单元格下标，-1 表示没改 */
    val: new Int32Array(CAP),    /* 该单元格改动前的值 */
    out: new Int32Array(CAP),    /* 输出前的长度，-1 表示没输出 */
    inp: new Int32Array(CAP)     /* 被 , 吃掉的字符，-1 表示没吃 */
  };

  var head = 0;
  var count = 0;

  /**
   * 记录一条已执行指令的逆操作。
   * @param {number} pc      执行前的指令下标
   * @param {number} ptr     执行前的指针
   * @param {number} cell    被改写单元格下标（无则 -1）
   * @param {number} val     改写前的值
   * @param {number} outLen  输出前长度（无输出则 -1）
   * @param {number} inChar  被读入的字符（无则 -1）
   */
  function push(pc, ptr, cell, val, outLen, inChar) {
    var i = head;
    buf.pc[i] = pc;
    buf.ptr[i] = ptr;
    buf.cell[i] = cell;
    buf.val[i] = val;
    buf.out[i] = outLen;
    buf.inp[i] = inChar;

    head = (i + 1) % CAP;
    if (count < CAP) count++;
  }

  /* 取出最近一条并弹出；没有则返回 null */
  function pop() {
    if (!count) return null;
    head = (head - 1 + CAP) % CAP;
    count--;
    var i = head;
    return {
      pc: buf.pc[i],
      ptr: buf.ptr[i],
      cell: buf.cell[i],
      val: buf.val[i],
      out: buf.out[i],
      inp: buf.inp[i]
    };
  }

  function clear() {
    head = 0;
    count = 0;
  }

  BF.History = {
    CAP: CAP,
    push: push,
    pop: pop,
    clear: clear,
    size: function () { return count; }
  };
})(window.BF);
