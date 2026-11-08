/* =========================================================================
 * ui/font.js —— 界面字号
 * 只改一个 CSS 变量 --fs：代码区、行号槽、内存格、输出区都基于它做 calc()，
 * 因此一次调整处处同步，且行号行高与代码行高始终一致（都来自 --line-h）。
 * 设置存在 localStorage，刷新后保留。
 * ========================================================================= */
(function (BF) {
  'use strict';

  var KEY = 'bf-debugger-fs-v1';
  var MIN = 10;
  var MAX = 21;
  var DEFAULT = 13;

  var size = DEFAULT;

  function apply() {
    document.documentElement.style.setProperty('--fs', size + 'px');
    if (BF.dom && BF.dom.fontVal) BF.dom.fontVal.textContent = String(size);
  }

  function save() {
    try { localStorage.setItem(KEY, String(size)); } catch (e) { /* 忽略 */ }
  }

  /* 字号变了，代码行高也会变：重算滚动同步与高亮位置 */
  function afterChange() {
    if (BF.Editor) {
      BF.Editor.syncScroll();
      BF.Editor.refresh();
    }
  }

  function set(px) {
    px = Math.round(Number(px));
    if (!isFinite(px)) px = DEFAULT;
    px = Math.max(MIN, Math.min(MAX, px));
    if (px === size) return size;
    size = px;
    apply();
    save();
    afterChange();
    return size;
  }

  function inc(delta) {
    return set(size + (delta || 0));
  }

  function init() {
    var saved = parseInt(localStorage.getItem(KEY), 10);
    if (isFinite(saved) && saved >= MIN && saved <= MAX) size = saved;
    apply();

    var d = BF.dom;
    if (d.fontDec) d.fontDec.addEventListener('click', function () { inc(-1); });
    if (d.fontInc) d.fontInc.addEventListener('click', function () { inc(1); });

    /* Ctrl/⌘ + 滚轮：在代码区、内存区上滚动即可缩放 */
    [d.editor, d.memScroll].forEach(function (host) {
      if (!host) return;
      host.addEventListener('wheel', function (e) {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        inc(e.deltaY < 0 ? 1 : -1);
      }, { passive: false });
    });
  }

  BF.Font = {
    init: init,
    set: set,
    inc: inc,
    get: function () { return size; },
    MIN: MIN,
    MAX: MAX
  };
})(window.BF);
