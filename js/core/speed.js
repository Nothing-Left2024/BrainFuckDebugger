/* =========================================================================
 * core/speed.js —— 运行调速模型
 * 速度以「指令/秒(ips)」为唯一单位，对数滑杆 + 预设档位都映射到它。
 * 执行器按 plan() 把目标速率换算成「每帧预算 + 帧间隔」。
 *
 * 最高档是 Infinity（+∞ / 不限速）：不再按墙钟配速，只按时间片让出主线程，
 * 以浏览器能给到的最快速度推进，状态栏仍显示实测速率。
 * ========================================================================= */
(function (BF) {
  'use strict';

  var MIN = 1;               /* 1 指令/秒：最慢一档，一秒走一条 */
  var MAX = 200000;          /* 有限速率的上限（滑杆 99 位置） */
  var UNLIMITED = Infinity;  /* 滑杆 100 位置 / ∞ 极速预设 */

  var PRESETS = [
    { key: 'slow', label: '慢放', ips: 10 },
    { key: 'norm', label: '正常', ips: 1000 },
    { key: 'fast', label: '快速', ips: 25000 },
    { key: 'max',  label: '∞ 极速', ips: UNLIMITED }
  ];

  /* 旧版 1~10 档 → ips，用于兼容之前存下的项目文件 */
  var LEGACY = [5, 7, 13, 50, 200, 1000, 1800, 18000, 120000, MAX];

  function clamp(ips) {
    /* 项目文件里用 'max' 字符串保存无限速（JSON 不能存 Infinity） */
    if (ips === UNLIMITED || ips === 'max' || ips === 'inf') return UNLIMITED;
    ips = Number(ips);
    if (!isFinite(ips) || ips <= 0) ips = 1000;
    return Math.max(MIN, Math.min(MAX, ips));
  }

  /* 兼容旧版 1~10 档号（仅供导入 v1 项目文件时调用，不要用在滑杆链路上） */
  function normalize(v) {
    v = Number(v) || 0;
    if (v <= 10) return LEGACY[Math.max(0, Math.round(v) - 1)] || 1000;
    return clamp(v);
  }

  /**
   * 目标速率 → 调度参数
   *   tickMs   一帧的目标间隔（毫秒）：慢速时一条一条来，中速 4ms，高速跟着屏幕刷新
   *   perTick  一帧按计划应该执行多少条（仅供参考，真正跑几条由执行器按欠账算）
   *
   * 注意：这里的数字只是「节拍」。真正的速率由执行器的欠账补发负责 ——
   * 定时器总会晚到，按固定预算跑会稳定偏慢（实测只有设定的 40%），
   * 所以执行器改成「按墙钟算该跑多少，跑欠的」，这里只决定节拍有多细。
   */
  function plan(ips) {
    ips = clamp(ips);
    if (ips === UNLIMITED) return { tickMs: 0, perTick: Infinity, unlimited: true };
    var tickMs = ips <= 200 ? 1000 / ips : (ips <= 4000 ? 4 : 1000 / 60);
    return { tickMs: tickMs, perTick: Math.max(1, Math.round(ips * tickMs / 1000)), unlimited: false };
  }

  /* 1000 → "1k"，25000 → "25k"，Infinity → "∞"；+∞ 实测速率可能上百万，用 M */
  function format(ips) {
    if (ips === UNLIMITED) return '∞';
    ips = Math.round(ips || 0);
    if (ips >= 1000000) return (ips / 1000000).toFixed(ips >= 10000000 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (ips >= 1000) return (ips / 1000).toFixed(ips >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k';
    return String(ips);
  }

  /* 滑杆取整到 1 / 2 / 5 × 10^n，避免出现 137 这种毛刺值 */
  function nice(v) {
    var e = Math.pow(10, Math.floor(Math.log10(v)));
    var n = v / e;
    var m = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
    return Math.round(m * e);
  }

  /* 0..99 是 1..200000 的对数刻度，100 单独留给 +∞ */
  function sliderToIps(v) {
    v = Math.max(0, Math.min(100, Number(v) || 0));
    if (v >= 100) return UNLIMITED;
    return clamp(nice(MIN * Math.pow(MAX / MIN, v / 99)));
  }

  function ipsToSlider(ips) {
    if (clamp(ips) === UNLIMITED) return 100;
    return Math.min(99, Math.round(99 * Math.log(clamp(ips) / MIN) / Math.log(MAX / MIN)));
  }

  function presetOf(ips) {
    var i;
    for (i = 0; i < PRESETS.length; i++) {
      if (PRESETS[i].ips === ips) return PRESETS[i];
    }
    return null;
  }

  BF.Speed = {
    MIN: MIN,
    MAX: MAX,
    UNLIMITED: UNLIMITED,
    DEFAULT: 1000,
    PRESETS: PRESETS,
    clamp: clamp,
    normalize: normalize,
    plan: plan,
    format: format,
    sliderToIps: sliderToIps,
    ipsToSlider: ipsToSlider,
    presetOf: presetOf
  };
})(window.BF);
