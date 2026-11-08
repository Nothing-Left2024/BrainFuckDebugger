/* =========================================================================
 * ui/editor.js —— 代码编辑器视图
 * 结构：行号栏 + 高亮层(<pre>) + 输入层(<textarea>)，两层字体/行高完全一致。
 * 文本真源是 state.code，textarea 只是视图。
 *
 * 大文件省内存（关键）：旧版把整份源码逐字符生成 <span>、每行生成一个
 * 行号 <div>。一个 30 MB 的 .bf 有几十万行、几千万字符，会瞬间产生几百万
 * 个 DOM 节点和几百 MB 的 HTML 字符串，而且每次输入 / 滚动都要重建。
 * 现在高亮层与行号栏都只渲染「可视区 ± 缓冲行」，前后用 padding / 占位
 * 元素撑出文档高度来对齐 textarea 的滚动，DOM 节点数恒定在几十到几百个。
 * ========================================================================= */
(function (BF) {
  'use strict';

  var S = BF.state;
  var d = BF.dom;

  /* 超过这个长度就按可视窗口渲染；小文件仍走原来的全量着色 */
  var VIRTUAL_MIN = 100000;
  var BUFFER_LINES = 30;

  var lineEls = Object.create(null);   /* 行号 -> 行号栏 DOM */
  var prevCurLine = -2;
  var lastHL = 0;
  var winFrom = 0, winTo = 0;          /* 当前渲染窗口 [首行, 末行] */
  var recompTimer = null;

  function isBig() { return S.code.length >= VIRTUAL_MIN; }

  /* ---------------- 着色 ---------------- */
  function escChar(c) {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    return c;
  }

  function charClass(c) {
    if (c === '+' || c === '-') return 'c-op';
    if (c === '<' || c === '>') return 'c-ptr';
    if (c === '[' || c === ']') return 'c-loop';
    if (c === '.' || c === ',') return 'c-io';
    if (c === '\n' || c === ' ' || c === '\t' || c === '\r') return null;
    return 'c-cmt';
  }

  function currentCharIndex() {
    if (!S.started || S.pc >= S.ops.length) return -1;
    return S.ops.pos[S.pc];
  }

  /* 光标贴在括号旁时，标出配对括号（绝对字符下标集合） */
  function bracketMates() {
    var set = new Set();
    var pos = d.code.selectionStart;
    var code = S.code;
    var at = -1;

    if (code.charAt(pos) === '[' || code.charAt(pos) === ']') at = pos;
    else if (code.charAt(pos - 1) === '[' || code.charAt(pos - 1) === ']') at = pos - 1;
    if (at < 0) return set;

    /* 不再维护「每条指令一个 Map 项」，用 pos[] 二分查找 */
    var opIdx = BF.Compiler.opAtPos(S.ops, at);
    if (opIdx < 0) return set;
    var mate = S.jumps.get(opIdx);
    if (mate === undefined) return set;

    set.add(at);
    set.add(S.ops.pos[mate]);
    return set;
  }

  /* ---------------- 可视窗口 ---------------- */
  function lineHeight() {
    var v = parseFloat(window.getComputedStyle(d.code).lineHeight);
    return (isFinite(v) && v > 0) ? v : 22;
  }

  function windowRange() {
    var lh = lineHeight();
    var view = d.code.clientHeight || 400;
    var top = d.code.scrollTop || 0;
    return {
      lh: lh,
      first: Math.max(1, Math.floor(top / lh) - BUFFER_LINES + 1),
      last: Math.min(S.offsets.length, Math.ceil((top + view) / lh) + BUFFER_LINES)
    };
  }

  /**
   * 重绘高亮层。连续运行时限制在 ~11fps，避免长代码拖慢执行。
   * 大文件只着色可视窗口，用 padding-top / bottom 把这段文本放回它在
   * 文档里的原始 y 坐标，和 textarea 的滚动严丝合缝。
   * @param {boolean} [force] 忽略节流
   */
  function renderHighlight(force) {
    var now = performance.now();
    if (!force && S.running && now - lastHL < 90) return;
    lastHL = now;

    var code = S.code;
    var big = isBig();
    var w = big ? windowRange() : { lh: lineHeight(), first: 1, last: S.offsets.length };
    winFrom = w.first;
    winTo = w.last;

    var start = big ? (S.offsets[w.first - 1] || 0) : 0;
    var end = big ? (w.last < S.offsets.length ? S.offsets[w.last] : code.length) : code.length;
    var seg = big ? code.slice(start, end) : code;

    var curRel = currentCharIndex() - start;
    var mates = bracketMates();
    var out = '', run = '', cls = null;
    var j, c, k;

    for (j = 0; j < seg.length; j++) {
      c = seg.charAt(j);
      k = charClass(c);

      if (j === curRel) k = (k || '') + ' cur';
      else if (mates.has(start + j)) k = (k || '') + ' mate';

      if (k !== cls) {
        if (run) out += cls ? '<span class="' + cls + '">' + run + '</span>' : run;
        run = '';
        cls = k;
      }
      run += escChar(c);
    }
    if (run) out += cls ? '<span class="' + cls + '">' + run + '</span>' : run;

    if (big) {
      d.hl.style.paddingTop = (10 + (w.first - 1) * w.lh) + 'px';
      d.hl.style.paddingBottom = (10 + Math.max(0, (S.offsets.length - w.last) * w.lh)) + 'px';
    } else {
      d.hl.style.paddingTop = '';
      d.hl.style.paddingBottom = '';
    }

    d.hl.innerHTML = out;
    syncScroll();
  }

  /* ---------------- 行号栏 ---------------- */
  function lineCount() { return S.offsets.length; }

  function renderGutter() {
    var total = lineCount();
    var big = isBig();
    var w = big ? windowRange() : { lh: lineHeight(), first: 1, last: total };
    winFrom = w.first;
    winTo = w.last;

    var curLine = (S.started && S.pc < S.ops.length) ? S.ops.line[S.pc] : -1;
    var html = '';
    var i, cls;

    /* 前面的行用一个空块撑高度，让可视行落在正确的文档坐标上 */
    if (big && w.first > 1) {
      html += '<div style="height:' + ((w.first - 1) * w.lh) + 'px"></div>';
    }

    for (i = w.first; i <= w.last; i++) {
      cls = 'ln';
      if (S.bp.has(i)) cls += ' has-bp';
      if (S.notes[i]) cls += ' has-note';
      if (i === curLine) cls += ' cur';
      html += '<div class="' + cls + '" data-line="' + i + '"><span class="dot"></span>' + i + '</div>';
    }

    d.gutterInner.innerHTML = html;
    lineEls = Object.create(null);
    var els = d.gutterInner.querySelectorAll('.ln');
    for (i = 0; i < els.length; i++) lineEls[els[i].dataset.line] = els[i];
    prevCurLine = curLine;
  }

  function paintCurrent() {
    var curLine = (S.started && S.pc < S.ops.length) ? S.ops.line[S.pc] : -1;
    if (curLine === prevCurLine) return;
    if (lineEls[prevCurLine]) lineEls[prevCurLine].classList.remove('cur');
    if (lineEls[curLine]) lineEls[curLine].classList.add('cur');
    prevCurLine = curLine;
  }

  /* ---------------- 滚动同步 ---------------- */
  function syncScroll() {
    d.hl.scrollTop = d.code.scrollTop;
    d.hl.scrollLeft = d.code.scrollLeft;
    d.gutterInner.style.transform = 'translateY(' + (-d.code.scrollTop) + 'px)';
  }

  function onScroll() {
    syncScroll();
    if (!isBig()) return;
    var w = windowRange();
    if (w.first !== winFrom || w.last !== winTo) {
      renderGutter();
      renderHighlight(true);
    }
  }

  function scrollToPc() {
    if (S.pc >= S.ops.length) return;
    var lh = lineHeight();
    var top = (S.ops.line[S.pc] - 1) * lh;
    var view = d.code.clientHeight;
    if (top < d.code.scrollTop + 20 || top > d.code.scrollTop + view - 40) {
      d.code.scrollTop = Math.max(0, top - view / 2);
      onScroll();
    }
  }

  function goToLine(ln) {
    var off = S.offsets[ln - 1] || 0;
    d.code.focus();
    d.code.setSelectionRange(off, off);
    d.code.scrollTop = Math.max(0, (ln - 1) * lineHeight() - d.code.clientHeight / 2);
    onScroll();
    renderHighlight(true);
    if (BF.Notes) BF.Notes.syncCaret();
  }

  function caretLine() {
    return BF.Compiler.lineAtPos(S.offsets, d.code.selectionStart || 0);
  }

  /* ---------------- 编辑动作 ---------------- */
  function recompile(immediate) {
    /* 大文件：编辑时防抖重编译。几千万条指令每次都要重建三条 TypedArray，
       每敲一个键都做一遍会把主线程卡住；载入等一次性操作走 immediate。 */
    if (!immediate && isBig()) {
      clearTimeout(recompTimer);
      recompTimer = setTimeout(function () {
        recompile(true);
        renderHighlight(true);
      }, 220);
      return;
    }
    clearTimeout(recompTimer);
    recompTimer = null;

    BF.Compiler.apply(S.code);
    updateStat();
    renderGutter();       /* 窗口化后只画几十个节点，重建很便宜 */
    paintCurrent();
  }

  function updateStat() {
    var txt = S.offsets.length + ' 行 · ' + S.ops.length + ' 指令';
    if (S.unbalanced) txt += ' · 括号不匹配';
    d.codeStat.textContent = txt;
    d.codeStat.style.color = S.unbalanced ? 'var(--red)' : '';
    d.codeStat.style.borderColor = S.unbalanced ? '#4d2321' : '';
  }

  function setCode(code) {
    S.code = code || '';
    d.code.value = S.code;
    d.code.scrollTop = 0;
    d.code.scrollLeft = 0;
    recompile(true);
    syncScroll();
    renderHighlight(true);
  }

  function toggleBreakpoint(ln) {
    if (S.bp.has(ln)) S.bp.delete(ln);
    else S.bp.add(ln);
    renderGutter();
    paintCurrent();
    if (BF.Project) BF.Project.saveSoon();
    return S.bp.has(ln);
  }

  /* ---------------- 事件 ---------------- */
  function bind() {
    d.code.addEventListener('input', function () {
      S.code = d.code.value;
      S.dirty = true;
      S.started = false;

      recompile(false);
      renderHighlight(true);
      if (BF.Notes) BF.Notes.syncCaret();
      if (BF.Project) BF.Project.saveSoon();
    });

    d.code.addEventListener('scroll', onScroll);

    ['click', 'keyup', 'select'].forEach(function (ev) {
      d.code.addEventListener(ev, function () {
        renderHighlight(true);
        if (BF.Notes) BF.Notes.syncCaret();
      });
    });

    /* Tab 插入两个空格，避免焦点跳走 */
    d.code.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      var s = d.code.selectionStart;
      var en = d.code.selectionEnd;
      d.code.value = d.code.value.slice(0, s) + '  ' + d.code.value.slice(en);
      d.code.selectionStart = d.code.selectionEnd = s + 2;
      d.code.dispatchEvent(new Event('input'));
    });

    /* 点击行号 = 切换断点 */
    d.gutterInner.addEventListener('click', function (e) {
      var el = e.target.closest('.ln');
      if (!el) return;
      var ln = parseInt(el.dataset.line, 10);
      var added = toggleBreakpoint(ln);
      if (added) BF.Status.toast('已设置断点 · 第 ' + ln + ' 行');
    });
  }

  /* 每次重绘时调用（BF.render 内） */
  function refresh() {
    paintCurrent();
    renderHighlight(false);
  }

  BF.Editor = {
    init: function () { bind(); },
    setCode: setCode,
    recompile: recompile,
    updateStat: updateStat,
    renderHighlight: renderHighlight,
    renderGutter: renderGutter,
    paintCurrent: paintCurrent,
    refresh: refresh,
    scrollToPc: scrollToPc,
    goToLine: goToLine,
    caretLine: caretLine,
    syncScroll: syncScroll
  };
})(window.BF);
