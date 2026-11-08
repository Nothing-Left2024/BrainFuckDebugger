/* =========================================================================
 * ui/memory.js —— 内存面板
 * 网格展示每格数值 / 地址 / 自定义名称，支持选中、改值、改名、定位指针。
 * 渲染采用增量更新（只写变化的单元格），大容量也不掉帧。
 * ========================================================================= */
(function (BF) {
  'use strict';

  var S = BF.state;
  var d = BF.dom;

  var cellEls = [];
  var lastVals = null;
  var lastNames = [];
  var prevPtr = -1;
  var prevSel = -1;

  /* ---------------- 构建 ---------------- */
  function build() {
    var n = S.tape.length;
    var html = '';
    var i;

    for (i = 0; i < n; i++) {
      html += '<div class="cell" data-i="' + i + '">' +
              '<span class="v">0</span>' +
              '<span class="i">' + i + '</span>' +
              '<span class="n"></span></div>';
    }

    d.memGrid.innerHTML = html;
    cellEls = Array.prototype.slice.call(d.memGrid.children);
    lastVals = new Int16Array(n).fill(-1);
    lastNames = new Array(n).fill(null);
    prevPtr = -1;
    prevSel = -1;

    sync();
    paintInspector();
  }

  /* 放弃增量缓存，强制全量重画 */
  function invalidate() {
    if (lastVals) lastVals.fill(-1);
    if (lastNames) lastNames.fill(null);
    prevPtr = -1;
    prevSel = -1;
    sync();
    paintInspector();
  }

  /* ---------------- 增量渲染 ---------------- */
  function sync() {
    var tape = S.tape;
    var n = tape.length;
    var i, el, v, nm;

    for (i = 0; i < n; i++) {
      el = cellEls[i];
      if (!el) continue;

      v = tape[i];
      if (lastVals[i] !== v) {
        lastVals[i] = v;
        el.firstChild.textContent = v;
        el.classList.toggle('nz', v !== 0);
      }

      nm = S.names[i] || '';
      /* 悬停展示完整作用说明（来自编译器的单元格注释） */
      var note = (S.cellNotes && S.cellNotes[i]) || '';
      var label = nm + '\u0000' + note;
      if (lastNames[i] !== label) {
        lastNames[i] = label;
        el.lastChild.textContent = nm;
        el.classList.toggle('has-note', !!note);
        el.title = '格 ' + i + (nm ? ' · ' + nm : '') + (note ? '\n作用：' + note : '');
      }
    }

    paintCursor();
  }

  function paintCursor() {
    if (prevPtr !== S.ptr && cellEls[prevPtr]) cellEls[prevPtr].classList.remove('ptr');
    if (cellEls[S.ptr]) cellEls[S.ptr].classList.add('ptr');
    prevPtr = S.ptr;

    if (prevSel !== S.sel && cellEls[prevSel]) cellEls[prevSel].classList.remove('sel');
    if (cellEls[S.sel]) cellEls[S.sel].classList.add('sel');
    prevSel = S.sel;
  }

  /* ---------------- 单元格详情 ---------------- */
  function describe(code) {
    if (code === 0) return 'NUL';
    if (code === 10) return 'LF';
    if (code === 32) return 'SPACE';
    if (code === 127) return 'DEL';
    if (code < 32) return '控制字符';
    return '“' + String.fromCharCode(code) + '”';
  }

  function paintInspector() {
    var i = S.sel;
    var v = S.tape[i] || 0;

    d.inspIdx.textContent = String(i);
    d.inspVal.textContent = String(v);
    d.inspMeta.textContent = '0x' + v.toString(16).toUpperCase().padStart(2, '0') + ' · ' + describe(v);

    if (document.activeElement !== d.inspName) d.inspName.value = S.names[i] || '';
    if (d.inspNote && document.activeElement !== d.inspNote) d.inspNote.value = (S.cellNotes && S.cellNotes[i]) || '';
    if (document.activeElement !== d.inspValue) d.inspValue.value = String(v);
  }

  /* ---------------- 操作 ---------------- */
  function select(i) {
    i = Math.max(0, Math.min(S.tape.length - 1, i | 0));
    S.sel = i;
    sync();
    paintInspector();
    d.inspName.value = S.names[i] || '';
    if (d.inspNote) d.inspNote.value = (S.cellNotes && S.cellNotes[i]) || '';
    d.inspValue.value = String(S.tape[i] || 0);
  }

  function setValue(i, v) {
    v = Math.max(0, Math.min(255, v | 0));
    S.tape[i] = v;
    sync();
    paintInspector();
  }

  function setName(i, name) {
    name = String(name || '').trim().slice(0, 16);
    if (name) S.names[i] = name;
    else delete S.names[i];
    sync();
    if (BF.Project) BF.Project.saveSoon();
  }

  /* 单元格注释：编辑器带过来的「作用」可以先看一眼再改写，随项目保存 */
  function setNote(i, text) {
    text = String(text == null ? '' : text).slice(0, 120);
    S.cellNotes = S.cellNotes || {};
    if (text.trim()) S.cellNotes[i] = text;
    else delete S.cellNotes[i];
    sync();
    if (BF.Project) BF.Project.saveSoon();
  }

  function jumpPointerToSel() {
    S.ptr = S.sel;
    sync();
    if (BF.render) BF.render();
  }

  /* ---------------- 事件 ---------------- */
  function bind() {
    d.memGrid.addEventListener('click', function (e) {
      var el = e.target.closest('.cell');
      if (!el) return;
      select(parseInt(el.dataset.i, 10));
    });

    d.inspName.addEventListener('input', function () {
      setName(S.sel, d.inspName.value);
    });

    if (d.inspNote) {
      d.inspNote.addEventListener('input', function () {
        setNote(S.sel, d.inspNote.value);
      });
    }

    d.inspValue.addEventListener('change', function () {
      var v = parseInt(d.inspValue.value, 10);
      if (isNaN(v)) v = 0;
      setValue(S.sel, v);
      d.inspValue.value = String(S.tape[S.sel]);
    });

    d.valInc.addEventListener('click', function () {
      setValue(S.sel, (S.tape[S.sel] + 1) & 255);
    });

    d.valDec.addEventListener('click', function () {
      setValue(S.sel, (S.tape[S.sel] - 1) & 255);
    });

    d.btnGoto.addEventListener('click', function () {
      jumpPointerToSel();
      BF.Status.toast('指针已移到地址 ' + S.sel);
    });

    d.btnClearMem.addEventListener('click', function () {
      S.tape.fill(0);
      sync();
      paintInspector();
      if (BF.render) BF.render();
    });

    d.tapeSize.addEventListener('change', function () {
      BF.Engine.setTapeSize(parseInt(d.tapeSize.value, 10), true);
      if (BF.Project) BF.Project.saveSoon();
    });
  }

  /* 容量变化后同步下拉框（导入项目可能带来非预设容量） */
  function syncSizeSelect(n) {
    var found = false;
    var i;
    for (i = 0; i < d.tapeSize.options.length; i++) {
      if (d.tapeSize.options[i].value === String(n)) { found = true; break; }
    }
    if (!found) {
      var opt = document.createElement('option');
      opt.value = String(n);
      opt.textContent = String(n);
      d.tapeSize.appendChild(opt);
    }
    d.tapeSize.value = String(n);
  }

  BF.Memory = {
    init: function () { bind(); },
    build: function () { build(); syncSizeSelect(S.tape.length); },
    sync: sync,
    invalidate: invalidate,
    select: select,
    setValue: setValue,
    setName: setName,
    setNote: setNote,
    paintInspector: paintInspector,
    syncSizeSelect: syncSizeSelect
  };
})(window.BF);
