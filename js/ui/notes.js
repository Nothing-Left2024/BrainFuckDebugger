/* =========================================================================
 * ui/notes.js —— 行注释 + 开发文档
 * ========================================================================= */
(function (BF) {
  'use strict';

  var S = BF.state;
  var d = BF.dom;

  function escapeHTML(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
  }

  /* 跟随编辑器光标，切换注释编辑对象 */
  function syncCaret() {
    var ln = BF.Editor.caretLine();
    d.noteLabel.textContent = '第 ' + ln + ' 行';
    if (document.activeElement !== d.noteInput) d.noteInput.value = S.notes[ln] || '';
  }

  function renderList() {
    var keys = Object.keys(S.notes).map(Number).sort(function (a, b) { return a - b; });
    var html = '';
    var i, ln;

    d.noteCount.textContent = keys.length + ' 条';

    if (!keys.length) {
      d.noteList.innerHTML = '<div class="note-empty">还没有注释。在左侧选好某一行，在这里写说明即可。</div>';
      return;
    }

    for (i = 0; i < keys.length; i++) {
      ln = keys[i];
      html += '<button class="note-item" data-line="' + ln + '">' +
              '<span class="nl">L' + ln + '</span>' +
              '<span class="nt">' + escapeHTML(S.notes[ln]) + '</span></button>';
    }
    d.noteList.innerHTML = html;
  }

  /* 重新载入项目后同步整块面板 */
  function refresh() {
    syncCaret();
    renderList();
    d.docs.value = S.docs || '';
  }

  function setTab(name) {
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].dataset.tab === name);
    }
    d.tabNotes.classList.toggle('hidden', name !== 'notes');
    d.tabDocs.classList.toggle('hidden', name !== 'docs');
  }

  function bind() {
    d.noteInput.addEventListener('input', function () {
      var ln = BF.Editor.caretLine();
      var v = d.noteInput.value;
      if (v.trim()) S.notes[ln] = v;
      else delete S.notes[ln];

      BF.Editor.renderGutter();
      renderList();
      if (BF.Project) BF.Project.saveSoon();
    });

    d.noteList.addEventListener('click', function (e) {
      var el = e.target.closest('.note-item');
      if (!el) return;
      BF.Editor.goToLine(parseInt(el.dataset.line, 10));
      syncCaret();
    });

    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () { setTab(tab.dataset.tab); });
    });

    d.docs.addEventListener('input', function () {
      S.docs = d.docs.value;
      if (BF.Project) BF.Project.saveSoon();
    });
  }

  BF.Notes = {
    init: function () { bind(); },
    syncCaret: syncCaret,
    renderList: renderList,
    refresh: refresh,
    setTab: setTab,
    escapeHTML: escapeHTML
  };
})(window.BF);
