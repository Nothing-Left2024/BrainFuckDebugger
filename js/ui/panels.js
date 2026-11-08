/* =========================================================================
 * ui/panels.js —— 面板自由调整大小 + 折叠
 * · 每个卡片（代码 / 注释 / 内存 / 输出）都可折叠，折叠后只留标题栏；
 * · 每列上下两张卡片之间有可拖动分隔条，拖拽即时改变下方卡片高度；
 * · 左右两列之间的竖向分隔条可拖动，改变两栏宽度；
 * · 尺寸与折叠状态存在 localStorage，刷新后还原。
 * ========================================================================= */
(function (BF) {
  'use strict';

  var STORE_KEY = 'bf-debugger-ui-v1';

  var MIN_TOP = 140;      /* 上方卡片最小高度 */
  var MIN_BOTTOM = 92;    /* 下方卡片最小高度 */
  var MIN_COL = 320;      /* 左右栏最小宽度 */
  var MIN_COL_RIGHT = 340;

  var ui = { leftW: 0, sideH: 0, ioH: 0, collapsed: {} };
  var cards = {};
  var splitters = [];
  var mainEl = null;
  var leftCol = null;
  var colHandle = null;

  /* ---------------- 持久化 ---------------- */
  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var data = JSON.parse(raw) || {};
      ui.leftW = Number(data.leftW) || 0;
      ui.sideH = Number(data.sideH) || 0;
      ui.ioH = Number(data.ioH) || 0;
      ui.collapsed = data.collapsed || {};
    } catch (err) { /* 忽略 */ }
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(ui)); } catch (err) { /* 忽略 */ }
  }

  /* 尺寸变化后，编辑器要重算滚动同步与当前行高亮 */
  function afterLayout() {
    if (BF.Editor) {
      BF.Editor.syncScroll();
      BF.Editor.refresh();
    }
    syncColumnHandle();
  }

  /* ---------------- 折叠 ---------------- */
  var CHEVRON = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.8 4.5 6 7.7l3.2-3.2"/></svg>';

  function toggle(key) {
    var card = cards[key];
    if (!card) return;
    var collapsed = card.el.classList.toggle('collapsed');
    ui.collapsed[key] = collapsed;
    card.btn.title = collapsed ? '展开面板' : '折叠面板';
    save();
    afterLayout();
  }

  function addToggle(key, card) {
    var btn = document.createElement('button');
    btn.className = 'panel-btn';
    btn.type = 'button';
    btn.title = '折叠面板';
    btn.innerHTML = CHEVRON;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      toggle(key);
    });
    card.head.appendChild(btn);
    card.btn = btn;
  }

  function setupCards() {
    var list = document.querySelectorAll('[data-panel]');
    var i, el, key, head;

    for (i = 0; i < list.length; i++) {
      el = list[i];
      key = el.getAttribute('data-panel');
      head = el.querySelector('.card-head') || el.querySelector('.tabs');
      if (!head) continue;
      cards[key] = { el: el, head: head, btn: null };
      addToggle(key, cards[key]);
    }
  }

  /* ---------------- 上下拖动 ---------------- */
  function startResize(e, key, handle) {
    var card = cards[key];
    if (!card) return;

    e.preventDefault();

    /* 折叠状态下拖动 → 先展开再调 */
    if (card.el.classList.contains('collapsed')) toggle(key);

    var colEl = card.el.parentElement;
    var colH = colEl.getBoundingClientRect().height;
    var startY = e.clientY;
    var startH = card.el.getBoundingClientRect().height;
    var prop = key === 'side' ? 'sideH' : 'ioH';

    handle.classList.add('dragging');
    try { handle.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }

    function onMove(ev) {
      var h = startH + (startY - ev.clientY);
      h = Math.max(MIN_BOTTOM, Math.min(colH - MIN_TOP - 12, h));
      card.el.style.height = h + 'px';
      ui[prop] = Math.round(h);
      afterLayout();
    }

    function onUp() {
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      try { handle.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      save();
      afterLayout();
    }

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  }

  function makeSplitter(key) {
    var card = cards[key];
    if (!card) return;

    var el = document.createElement('div');
    el.className = 'splitter';
    el.title = '拖动调整高度 · 双击恢复默认';
    el.innerHTML = '<span></span>';
    card.el.parentElement.insertBefore(el, card.el);
    el.addEventListener('pointerdown', function (e) { startResize(e, key, el); });

    /* 双击恢复该面板默认高度 */
    el.addEventListener('dblclick', function () {
      card.el.style.height = '';
      ui[key === 'side' ? 'sideH' : 'ioH'] = 0;
      save();
      afterLayout();
    });

    splitters.push(el);
  }

  /* ---------------- 左右拖动 ---------------- */
  function syncColumnHandle() {
    if (!colHandle || !mainEl || !leftCol) return;

    if (window.innerWidth <= 980) {
      colHandle.style.display = 'none';
      return;
    }
    colHandle.style.display = '';

    var mr = mainEl.getBoundingClientRect();
    var lr = leftCol.getBoundingClientRect();
    colHandle.style.left = Math.round(lr.right - mr.left) + 'px';
  }

  function applyLeftWidth() {
    if (!ui.leftW) return;
    var mr = mainEl.getBoundingClientRect();
    var contentW = mr.width - 24;             /* main 左右 padding */
    var maxW = contentW - MIN_COL_RIGHT - 12; /* 再留出 gap */
    var w = Math.max(MIN_COL, Math.min(maxW, ui.leftW));
    ui.leftW = w;
    mainEl.style.gridTemplateColumns = w + 'px 1fr';
    syncColumnHandle();
  }

  function startColResize(e) {
    e.preventDefault();

    var mr = mainEl.getBoundingClientRect();
    var contentW = mr.width - 24;
    var startX = e.clientX;
    var startW = leftCol.getBoundingClientRect().width;

    colHandle.classList.add('dragging');
    try { colHandle.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }

    function onMove(ev) {
      var w = startW + (ev.clientX - startX);
      var maxW = contentW - MIN_COL_RIGHT - 12;
      w = Math.max(MIN_COL, Math.min(maxW, w));
      ui.leftW = Math.round(w);
      mainEl.style.gridTemplateColumns = w + 'px 1fr';
      syncColumnHandle();
      afterLayout();
    }

    function onUp() {
      colHandle.classList.remove('dragging');
      colHandle.removeEventListener('pointermove', onMove);
      colHandle.removeEventListener('pointerup', onUp);
      try { colHandle.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      save();
      afterLayout();
    }

    colHandle.addEventListener('pointermove', onMove);
    colHandle.addEventListener('pointerup', onUp);
  }

  function setupColumnHandle() {
    mainEl = document.querySelector('main');
    var cols = document.querySelectorAll('main > .col');
    leftCol = cols[0];
    if (!mainEl || !leftCol || cols.length < 2) return;

    colHandle = document.createElement('div');
    colHandle.className = 'col-splitter';
    colHandle.title = '拖动调整两栏宽度 · 双击恢复默认';
    colHandle.innerHTML = '<span></span>';
    mainEl.appendChild(colHandle);
    colHandle.addEventListener('pointerdown', startColResize);

    colHandle.addEventListener('dblclick', function () {
      ui.leftW = 0;
      mainEl.style.gridTemplateColumns = '';
      save();
      syncColumnHandle();
      afterLayout();
    });

    window.addEventListener('resize', function () {
      if (ui.leftW) applyLeftWidth(); else syncColumnHandle();
    });
  }

  /* ---------------- 应用已保存状态 ---------------- */
  function apply() {
    if (ui.sideH && cards.side) cards.side.el.style.height = ui.sideH + 'px';
    if (ui.ioH && cards.io) cards.io.el.style.height = ui.ioH + 'px';

    Object.keys(ui.collapsed).forEach(function (key) {
      var card = cards[key];
      if (card && ui.collapsed[key]) {
        card.el.classList.add('collapsed');
        if (card.btn) card.btn.title = '展开面板';
      }
    });

    applyLeftWidth();
    syncColumnHandle();
  }

  function init() {
    load();
    setupCards();
    makeSplitter('side');
    makeSplitter('io');
    setupColumnHandle();
    apply();
    /* 首帧后再校准一次，等字体与滚动条稳定 */
    requestAnimationFrame(syncColumnHandle);
  }

  BF.Panels = {
    init: init,
    toggle: toggle,
    save: save,
    reset: function () {
      ui = { leftW: 0, sideH: 0, ioH: 0, collapsed: {} };
      Object.keys(cards).forEach(function (key) {
        cards[key].el.classList.remove('collapsed');
        cards[key].el.style.height = '';
        if (cards[key].btn) cards[key].btn.title = '折叠面板';
      });
      if (mainEl) mainEl.style.gridTemplateColumns = '';
      save();
      afterLayout();
    }
  };
})(window.BF);
