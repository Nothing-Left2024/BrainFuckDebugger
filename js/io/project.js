/* =========================================================================
 * io/project.js —— 项目序列化 / 导入导出 / 本地保存
 * 项目文件（.bfproj.json）内含：代码、单元格命名、断点、行注释、开发文档、
 * 内存容量与速度；也可单独导出纯 .bf 源码或 Markdown 开发文档。
 * ========================================================================= */
(function (BF) {
  'use strict';

  var S = BF.state;
  var d = BF.dom;

  var STORE_KEY = 'bf-debugger-project-v1';
  var saveTimer = null;

  /* ---------------- 序列化 ---------------- */
  function serialize() {
    return {
      format: 'bf-debugger-project',
      version: 2,
      name: S.name || '未命名项目',
      code: S.code,
      tapeSize: S.tape.length,
      /* JSON 不能表示 Infinity，用 'max' 字符串保存 +∞ 档 */
      speed: S.speed === Infinity ? 'max' : S.speed,
      cellNames: S.names,
      cellNotes: S.cellNotes || {},
      breakpoints: Array.from(S.bp).sort(function (a, b) { return a - b; }),
      lineNotes: S.notes,
      docs: S.docs || '',
      bareRun: !!S.bareRun,
      follow: !!S.follow,
      showInspector: S.showInspector !== false,
      exportedAt: new Date().toISOString()
    };
  }

  /* 编译器页面（compiler.html）通过 sessionStorage 递过来的代码 */
  function takePending() {
    try {
      var raw = sessionStorage.getItem('bf-pending-code');
      if (!raw) return null;
      sessionStorage.removeItem('bf-pending-code');
      var data = JSON.parse(raw);
      return (data && typeof data.code === 'string') ? data : null;
    } catch (err) {
      return null;
    }
  }

  /* 大代码走 IndexedDB 桥接（见 tc/ui.js 的 putBridge）：sessionStorage
     只有约 5 MB，而编译产物动辄几十 MB。IndexedDB 按结构化克隆存对象，
     既不用 stringify 出一整条巨型字符串，也没有那个配额限制。 */
  var BRIDGE_DB = 'bf-compiler-bridge', BRIDGE_STORE = 'pending', BRIDGE_KEY = 'code';

  function takePendingIDB(done) {
    if (typeof indexedDB === 'undefined' || !indexedDB) { done(null); return; }
    var req, finished = false;
    function finish(data) {
      if (finished) return;
      finished = true;
      done(data);
    }
    function close(db) { try { db.close(); } catch (e) {} }
    try { req = indexedDB.open(BRIDGE_DB, 1); }
    catch (err) { finish(null); return; }
    req.onupgradeneeded = function () {
      var db0 = req.result;
      if (!db0.objectStoreNames.contains(BRIDGE_STORE)) db0.createObjectStore(BRIDGE_STORE);
    };
    req.onerror = req.onblocked = function () { finish(null); };
    req.onsuccess = function () {
      var db = req.result, tx, found = null;
      try {
        tx = db.transaction(BRIDGE_STORE, 'readwrite');
        var get = tx.objectStore(BRIDGE_STORE).get(BRIDGE_KEY);
        get.onsuccess = function () {
          found = get.result;
          /* 取走即删除，避免下次打开调试器又载入同一份旧代码 */
          try { tx.objectStore(BRIDGE_STORE).delete(BRIDGE_KEY); } catch (e) {}
        };
        tx.oncomplete = function () {
          close(db);
          finish(found && typeof found.code === 'string' ? found : null);
        };
        tx.onerror = tx.onabort = function () { close(db); finish(null); };
      } catch (err2) { close(db); finish(null); }
    };
  }

  function applyPending(p) {
    applyProject({
      format: 'bf-debugger-project',
      version: 2,
      name: p.name || '编译产物',
      code: p.code,
      tapeSize: 256,
      speed: 1000,
      cellNames: p.cellNames || {},
      cellNotes: p.cellNotes || {},
      breakpoints: [],
      lineNotes: {},
      docs: '由编译器生成：' + (p.name || '')
    }, true, true);
    BF.Status.toast(Object.keys(p.cellNames || {}).length
      ? '已载入编译产物，并标注 ' + Object.keys(p.cellNames).length + ' 个单元格的作用'
      : '已载入 ' + (p.name || '编译产物'));
  }

  function applyProject(data, silent, noSave) {
    S.name = data.name || '未命名项目';
    d.projName.value = S.name;

    /* 先装命名 / 断点 / 注释，再设代码，这样行号栏一次就画对 */
    S.names = {};
    if (data.cellNames && typeof data.cellNames === 'object') {
      Object.keys(data.cellNames).forEach(function (k) {
        var idx = parseInt(k, 10);
        if (!isNaN(idx) && data.cellNames[k]) {
          S.names[idx] = String(data.cellNames[k]).slice(0, 24);
        }
      });
    }

    S.cellNotes = {};
    if (data.cellNotes && typeof data.cellNotes === 'object') {
      Object.keys(data.cellNotes).forEach(function (k) {
        var idx = parseInt(k, 10);
        if (!isNaN(idx) && data.cellNotes[k]) S.cellNotes[idx] = String(data.cellNotes[k]).slice(0, 120);
      });
    }

    S.bareRun = !!data.bareRun;
    S.follow = !!data.follow;
    /* 老项目文件没有这个字段，默认显示变量区 */
    S.showInspector = data.showInspector !== false;
    if (d.optBareRun) d.optBareRun.checked = S.bareRun;
    if (d.optFollow) d.optFollow.checked = S.follow;
    if (d.optInspector) d.optInspector.checked = S.showInspector;
    if (d.inspector) d.inspector.classList.toggle('hidden', !S.showInspector);

    S.bp = new Set((data.breakpoints || []).map(Number).filter(function (n) { return !isNaN(n); }));

    S.notes = {};
    if (data.lineNotes && typeof data.lineNotes === 'object') {
      Object.keys(data.lineNotes).forEach(function (k) {
        var ln = parseInt(k, 10);
        if (!isNaN(ln) && data.lineNotes[k]) S.notes[ln] = String(data.lineNotes[k]);
      });
    }

    S.docs = typeof data.docs === 'string' ? data.docs : '';

    /* v1 的 speed 是 1~10 档号，v2 起是「指令/秒」；'max' 表示 +∞ 不限速 */
    if (data.speed === 'max' || data.speed === 'inf') {
      BF.Status.setSpeed(Infinity);
    } else if (data.speed) {
      var legacy = !data.version || Number(data.version) < 2;
      BF.Status.setSpeed(legacy ? BF.Speed.normalize(data.speed) : Number(data.speed));
    }

    S.dirty = false;
    S.sel = 0;
    BF.Editor.setCode(typeof data.code === 'string' ? data.code : '');
    BF.Engine.hardReset();

    var size = parseInt(data.tapeSize, 10) || 256;
    BF.Engine.setTapeSize(size, false);

    BF.Notes.refresh();
    BF.render();

    if (!silent) BF.Status.toast('项目已载入：' + S.name);
    if (!noSave) saveSoon();
  }

  /* ---------------- 下载 ---------------- */
  function sanitize(s) {
    return String(s || 'brainfuck').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 40);
  }

  function download(text, filename, mime) {
    var blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');

    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  function exportProject() {
    download(JSON.stringify(serialize(), null, 2), sanitize(S.name) + '.bfproj.json', 'application/json');
    BF.Status.toast('已导出项目文件');
  }

  function exportCode() {
    download(S.code, sanitize(S.name) + '.bf', 'text/plain');
    BF.Status.toast('已导出 BrainFuck 源码');
  }

  function buildDoc() {
    var lines = ['# ' + (S.name || '未命名项目'), ''];
    var names = Object.keys(S.names).map(Number).sort(function (a, b) { return a - b; });
    var notes = Object.keys(S.notes).map(Number).sort(function (a, b) { return a - b; });

    lines.push('- 导出于：' + new Date().toLocaleString('zh-CN'));
    lines.push('- 代码行数：' + S.offsets.length);
    lines.push('- 指令数：' + S.ops.length);
    lines.push('- 内存容量：' + S.tape.length + ' 格（0–255 环绕）');
    lines.push('- 断点行：' + (S.bp.size
      ? Array.from(S.bp).sort(function (a, b) { return a - b; }).join(', ')
      : '无'));
    lines.push('', '## 源码', '', '```bf', S.code, '```', '');

    if (names.length) {
      lines.push('## 单元格命名', '', '| 地址 | 名称 |', '| --- | --- |');
      names.forEach(function (k) { lines.push('| ' + k + ' | ' + S.names[k] + ' |'); });
      lines.push('');
    }

    if (notes.length) {
      lines.push('## 行注释', '');
      notes.forEach(function (k) { lines.push('- **L' + k + '**：' + S.notes[k]); });
      lines.push('');
    }

    if ((S.docs || '').trim()) lines.push('## 开发文档', '', S.docs.trim(), '');

    return lines.join('\n');
  }

  function exportDoc() {
    download(buildDoc(), sanitize(S.name) + '.md', 'text/markdown');
    BF.Status.toast('已导出开发文档');
  }

  function copyCode() {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(S.code).then(function () {
        BF.Status.toast('源码已复制');
      }, function () {
        BF.Status.toast('复制失败，请手动选择');
      });
    } else {
      d.code.select();
      document.execCommand('copy');
      BF.Status.toast('源码已复制');
    }
  }

  /* ---------------- 导入 ---------------- */
  function readFile(file) {
    var reader = new FileReader();

    reader.onload = function () {
      var text = String(reader.result || '');
      var name = file.name || '';

      /* 不用 text.trim()：那会给几十 MB 的源码再复制一整份字符串。
         正则只扫开头，常数开销。 */
      var head = /^\s*(\S)/.exec(text);
      if (/\.json$/i.test(name) || (head && head[1] === '{')) {
        try {
          var data = JSON.parse(text);
          if (data && (data.code !== undefined || data.format === 'bf-debugger-project')) {
            applyProject(data);
            return;
          }
        } catch (err) { /* 当作源码处理 */ }
      }

      S.name = name.replace(/\.[^.]+$/, '') || '未命名项目';
      d.projName.value = S.name;
      S.dirty = false;
      S.sel = 0;
      BF.Editor.setCode(text);
      BF.Engine.reset();
      BF.Notes.refresh();
      BF.render();
      BF.Status.toast('已载入源码：' + name);
      saveSoon();
    };

    reader.readAsText(file, 'utf-8');
  }

  function newProject() {
    if (!window.confirm('新建会清空当前代码、命名、断点与注释，确定继续？')) return;

    S.name = '未命名项目';
    S.names = {};
    S.bp = new Set();
    S.notes = {};
    S.docs = '';
    S.dirty = false;
    S.sel = 0;

    d.projName.value = S.name;
    BF.Editor.setCode('');
    BF.Engine.reset();
    BF.Notes.refresh();
    BF.render();
    BF.Status.toast('已新建空白项目');
    d.code.focus();
    saveSoon();
  }

  /* ---------------- 本地保存 ---------------- */
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 500);
  }

  /* localStorage 通常只有约 5 MB。超大代码本来就存不进去，更不该在每次
     编辑（500 ms 防抖）时都 JSON.stringify 出几十 MB 的临时字符串 —— 那是
     打开大文件后内存反复飙升、GC 抖动的主要来源之一。 */
  var LOCAL_SAVE_LIMIT = 1000000;
  var bigSaveWarned = false;

  function saveNow() {
    if (S.code.length > LOCAL_SAVE_LIMIT) {
      if (!bigSaveWarned) {
        bigSaveWarned = true;
        if (BF.Status) BF.Status.toast('代码超过 1 MB，已跳过浏览器自动保存；请用「导出 .bf / 项目文件」保存');
      }
      return;
    }
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(serialize()));
    } catch (err) { /* 隐私模式等场景忽略 */ }
  }

  function loadSaved() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return false;
      var data = JSON.parse(raw);
      if (!data || typeof data.code !== 'string') return false;
      applyProject(data, true);
      return true;
    } catch (err) {
      return false;
    }
  }

  /* ---------------- 事件 ---------------- */
  function bind() {
    d.projName.addEventListener('input', function () {
      S.name = d.projName.value.trim() || '未命名项目';
      saveSoon();
    });

    d.btnNew.addEventListener('click', newProject);
    d.btnImport.addEventListener('click', function () { d.fileInput.click(); });

    d.fileInput.addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (f) readFile(f);
      this.value = '';
    });

    d.btnExport.addEventListener('click', function (e) {
      e.stopPropagation();
      d.exportMenu.classList.toggle('open');
    });

    document.addEventListener('click', function () {
      d.exportMenu.classList.remove('open');
    });

    d.exportMenu.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      d.exportMenu.classList.remove('open');

      switch (btn.dataset.act) {
        case 'project': exportProject(); break;
        case 'code': exportCode(); break;
        case 'doc': exportDoc(); break;
        case 'copy': copyCode(); break;
      }
    });

    /* 拖文件进来即可导入 */
    ['dragover', 'drop'].forEach(function (ev) {
      document.addEventListener(ev, function (e) { e.preventDefault(); });
    });
    document.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) readFile(f);
    });

    window.addEventListener('beforeunload', saveNow);
  }

  BF.Project = {
    init: function () {
      bind();

      var pending = takePending();
      if (pending) {
        /* 来自编译器的代码：先不覆盖本地已保存的项目，用户一改动才落盘 */
        applyPending(pending);
      } else {
        var loaded = loadSaved();
        if (!loaded) applyProject(BF.DEMO, true);
      }

      d.projName.value = S.name;

      /* 大代码由编译器放进 IndexedDB（sessionStorage 装不下）。异步取一次，
         取到就覆盖成编译产物；小代码走上面的同步路径，行为完全不变。 */
      takePendingIDB(function (big) {
        if (!big) return;
        applyPending(big);
        d.projName.value = S.name;
      });
    },
    serialize: serialize,
    applyProject: applyProject,
    buildDoc: buildDoc,
    exportProject: exportProject,
    exportCode: exportCode,
    exportDoc: exportDoc,
    saveSoon: saveSoon,
    saveNow: saveNow
  };
})(window.BF);
