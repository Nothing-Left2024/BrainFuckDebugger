/* =========================================================================
 * tc/ui.js —— 编译器页面交互
 * 输入即编译（防抖 220ms），输出着色、错误定位、一键送到调试器。
 * ========================================================================= */
(function (TC) {
  'use strict';

  var STORE_KEY = 'bf-tc-v1';

  var state = {
    lang: 'c', src: { c: '', cpp: '', asm: '' }, depth: 8,
    intWidth: 8,              /* 8 = 单格兼容；32 = 普通 int 也按 int32 处理 */
    timer: null, result: null,
    comments: true,          /* 生成的 BrainFuck 是否带逐句注释 */
    showIssues: true,        /* 问题 / 警告面板是否展开 */
    showHint: true,          /* 支持范围说明是否展开 */
    showVars: true,          /* 底部变量列表是否展开 */
    fs: { src: 12.5, bf: 12.5 },   /* 两侧代码字号，互相独立 */
    errLines: {}, warnLines: {}, curLine: 1,
    lineKey: '', cacheKey: '', bfKey: null, bfMode: '', compileMs: 0
  };
  var FS_MIN = 9, FS_MAX = 24, FS_STEP = 0.5;
  var d = {};

  var CLS = {
    '+': 'bf-op', '-': 'bf-op',
    '>': 'bf-ptr', '<': 'bf-ptr',
    '[': 'bf-loop', ']': 'bf-loop',
    '.': 'bf-io', ',': 'bf-io'
  };

  function $(id) { return document.getElementById(id); }

  function escapeHTML(s) {
    s = String(s);
    /* 着色时大部分片段是 BF 指令 / 注释文字，没有需转义的字符；
       先做一次 indexOf 快速跳过整段正则，大代码下能省掉几万次 replace 调用。 */
    if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0) return s;
    return s.replace(/[&<>]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;';
    });
  }

  function toast(msg) {
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    d.toastWrap.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .25s';
      el.style.opacity = '0';
      setTimeout(function () { el.remove(); }, 260);
    }, 1700);
  }

  /* ---------------- 字号：左右两侧独立 ---------------- */
  function fsText(v) { return v.toFixed(1).replace(/\.0$/, ''); }

  function applyFont() {
    var root = document.documentElement && document.documentElement.style;
    if (root && root.setProperty) {
      root.setProperty('--src-fs', state.fs.src + 'px');
      root.setProperty('--bf-fs', state.fs.bf + 'px');
    }
    var a = $('srcFsVal'), b = $('bfFsVal');
    if (a) a.textContent = fsText(state.fs.src);
    if (b) b.textContent = fsText(state.fs.bf);
  }

  function changeFont(which, delta) {
    var v = Math.round(Math.max(FS_MIN, Math.min(FS_MAX, state.fs[which] + delta)) * 2) / 2;
    if (v === state.fs[which]) return;
    state.fs[which] = v;
    applyFont();
    /* 行高随字号变，重新对齐行号槽滚动；CSS 变量会自动更新 .ln 高度 */
    if (d.srcLines && d.src) d.srcLines.scrollTop = d.src.scrollTop;
    save();
  }

  /* Ctrl/⌘ + 滚轮：在源码区或输出区上直接缩放对应一侧 */
  function bindFontWheel(which, el) {
    if (!el || !el.addEventListener) return;
    el.addEventListener('wheel', function (e) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      changeFont(which, e.deltaY < 0 ? FS_STEP : -FS_STEP);
    }, { passive: false });
  }

  /* ---------------- 源码行号 / 光标 / 面板 ---------------- */
  function lineStartOf(text, pos) { return text.lastIndexOf('\n', pos - 1) + 1; }
  function lineEndOf(text, pos) {
    var i = text.indexOf('\n', pos);
    return i < 0 ? text.length : i;
  }
  function lineOfPos(text, pos) {
    var n = 1, i = text.indexOf('\n');
    while (i >= 0 && i < pos) { n++; i = text.indexOf('\n', i + 1); }
    return n;
  }
  function posText(text) {
    var cur = lineOfPos(text, d.src.selectionStart);
    return text.split('\n').length + ' 行 · L' + cur + ':C' +
           (d.src.selectionStart - lineStartOf(text, d.src.selectionStart) + 1);
  }

  /* 行号槽与 #src 字体、行高、上下内边距严格一致（wrap="off" 保证一行对一号） */
  function syncLines() {
    if (!d.srcLines) return;
    var text = d.src.value;
    var n = text.split('\n').length;
    var cur = lineOfPos(text, d.src.selectionStart);
    /* 行数与错误/警告标记都没变时不重建整列行号 DOM —— 大文件里逐字输入时差别很大 */
    var key = n + '|' + Object.keys(state.errLines).join(',') + '|' +
              Object.keys(state.warnLines).join(',');
    if (key !== state.lineKey) {
      var html = '';
      for (var i = 1; i <= n; i++) {
        var cls = 'ln';
        if (state.errLines[i]) cls += ' err';
        else if (state.warnLines[i]) cls += ' warn';
        if (i === cur) cls += ' cur';
        html += '<span class="' + cls + '" data-line="' + i + '">' + i + '</span>';
      }
      d.srcLines.innerHTML = html;
      state.lineKey = key;
      state.curLine = cur;
    } else {
      updateCurLine();
    }
    d.srcLines.scrollTop = d.src.scrollTop;
    d.srcStat.textContent = posText(text);
  }

  function updateCurLine() {
    if (!d.srcLines) return;
    var text = d.src.value;
    var cur = lineOfPos(text, d.src.selectionStart);
    d.srcStat.textContent = posText(text);
    if (cur === state.curLine) return;
    var old = d.srcLines.querySelector('.ln.cur');
    if (old) old.classList.remove('cur');
    var el = d.srcLines.querySelector('.ln[data-line="' + cur + '"]');
    if (el) el.classList.add('cur');
    state.curLine = cur;
  }

  function applyPaneState() {
    var res = state.result;
    var count = res ? (res.errors || []).length + (res.warnings || []).length : 0;
    $('issuesPane').hidden = !state.showIssues || count === 0;
    $('hintPane').hidden = !state.showHint;
    $('btnIssuesShow').hidden = state.showIssues || count === 0;
    $('btnHintShow').hidden = state.showHint;
    $('issueCount').textContent = String(count);
    if (d.vars) d.vars.hidden = !state.showVars;
  }

  /* ---------------- 渲染 ---------------- */
  /* 用原生正则一次切出「同色连续段 / 非指令段」，再用字符串 += 拼（V8 的
     cons-string 比数组 join 更快）。实测 35 万字符的生成结果：逐字符扫描
     59ms → 40ms，约 1.5×，且输出与旧实现逐字节一致。
     正则必须每次重置 lastIndex：它是带 g 的全局对象。 */
  var COLOR_RE = /([+\-]+|[<>]+|[\[\]]+|[.,]+)|([^+\-<>[\].,]+)/g;

  function colorize(code) {
    var out = '', m;
    COLOR_RE.lastIndex = 0;
    while ((m = COLOR_RE.exec(code))) {
      out += m[1]
        ? '<span class="' + CLS[m[1].charAt(0)] + '">' + escapeHTML(m[1]) + '</span>'
        : escapeHTML(m[2]);
    }
    return out;
  }

  var BF_COLOR_LIMIT = 200000;   /* 超过这个长度退化为纯文本，避免 DOM 节点爆炸 */

  function renderBF(text, isPreview) {
    /* 预览态（大程序）直接走纯文本：DOM 只有一个文本节点，
       不会为了着色生成上万个 <span>。 */
    var mode = (isPreview || text.length > BF_COLOR_LIMIT) ? 'plain' : 'html';
    /* 内容没变就不重新生成 HTML：切面板、改字号、点行号时省掉整次着色 */
    if (state.bfKey === text && state.bfMode === mode) return;
    state.bfKey = text;
    state.bfMode = mode;

    if (mode === 'plain') { d.bfOut.textContent = text; return; }

    var lines = text.split('\n');
    var parts = [];
    var line, cut;

    for (var i = 0; i < lines.length; i++) {
      line = lines[i];
      if (!line) { parts.push('\n'); continue; }

      cut = line.indexOf(';');
      if (cut === 0) {
        parts.push('<span class="bf-cmt">', escapeHTML(line), '</span>\n');
      } else if (cut > 0) {
        parts.push(colorize(line.slice(0, cut)),
                   '<span class="bf-cmt">', escapeHTML(line.slice(cut)), '</span>\n');
      } else {
        parts.push(colorize(line), '\n');
      }
    }
    d.bfOut.innerHTML = parts.join('');
  }

  function renderIssues(errors, warnings) {
    var html = '';
    var i, ln;
    state.errLines = {};
    state.warnLines = {};

    for (i = 0; i < errors.length; i++) {
      ln = errors[i].line || 1;
      state.errLines[ln] = 1;
      html += '<div class="issue err clickable" data-line="' + ln + '" title="跳到第 ' + ln + ' 行">' +
              '<span class="no">第 ' + ln + ' 行</span>' +
              '<span class="msg">' + escapeHTML(errors[i].message) + '</span></div>';
    }
    for (i = 0; i < warnings.length; i++) {
      ln = warnings[i].line || 1;
      if (!state.errLines[ln]) state.warnLines[ln] = 1;
      html += '<div class="issue clickable" data-line="' + ln + '" title="跳到第 ' + ln + ' 行">' +
              '<span class="no">第 ' + ln + ' 行</span>' +
              '<span class="msg">' + escapeHTML(warnings[i].message) + '</span></div>';
    }
    d.issues.innerHTML = html;
  }

  function renderVars(vars) {
    if (!vars || !vars.length) { d.vars.innerHTML = ''; return; }
    d.vars.innerHTML = vars.map(function (v) {
      return '<span class="var-chip">' + escapeHTML(v.name) + ' <b>@' + v.cell + '</b></span>';
    }).join('');
  }

  /* 源码里识别到的 #include */
  function renderHeaders(headers, used) {
    if (!d.hdrLine) return;
    if (!headers || !headers.length) { d.hdrLine.innerHTML = ''; return; }

    var tip = {
      ok: '函数可用', partial: '仅类型 / 常量',
      none: '仅识别，不提供能力', unknown: '未收录，已忽略'
    };
    var html = '<span class="hdr-label">#include</span>';
    html += headers.map(function (h) {
      return '<span class="hdr-chip ' + h.state + '" title="' + (tip[h.state] || '') +
             '">&lt;' + escapeHTML(h.name) + '&gt;</span>';
    }).join('');
    if (used && used.length) {
      html += '<span class="hdr-label" style="margin-left:6px">已启用 ' + used.length + ' 个库函数</span>';
    }
    d.hdrLine.innerHTML = html;
  }

  /* ---------------- 标准库速查 ---------------- */
  function buildLibPanel() {
    var cat = TC.Stdlib.catalog();
    var names = Object.keys(cat.headers);

    d.libFuncs.innerHTML = cat.funcs.map(function (f) {
      return '<div class="lib-fn"><span class="lib-tag">' + escapeHTML(f.header) + '</span>' +
             '<code>' + escapeHTML(f.sig) + '</code><p>' + escapeHTML(f.desc) + '</p></div>';
    }).join('');

    var shown = names.filter(function (n) { return cat.headers[n].state !== 'none'; });
    var none = names.filter(function (n) { return cat.headers[n].state === 'none'; });
    d.libHeaders.innerHTML = shown.map(function (n) {
      var h = cat.headers[n];
      return '<div class="lib-hd ' + h.state + '"><code>&lt;' + escapeHTML(n) + '&gt;</code>' +
             '<span>' + escapeHTML(h.title) + (h.pair ? ' ↔ ' + escapeHTML(h.pair) : '') + '</span></div>';
    }).join('');
    d.libNoneNote.innerHTML = '另有 ' + none.length + ' 个头文件仅识别、不提供能力（容器 / 流 / 模板 / 并发等）：' +
      '<code>' + escapeHTML(none.slice(0, 14).join(' ')) + '</code> …';

    d.libHdrTotal.textContent = String(names.length);
    d.libHdrOk.textContent = String(names.filter(function (n) {
      return cat.headers[n].state === 'ok';
    }).length);
  }

  function updateLibUsed() {
    if (!d.libUsed) return;
    var r = state.result;
    var u = (r && r.stdfuncs) ? r.stdfuncs.filter(function (n) {
      return n.indexOf('__') !== 0;
    }) : [];
    d.libUsed.textContent = u.length ? '本次用到：' + u.join(', ') : '本次未使用标准库函数';
  }

  function openLib(e) {
    if (e) e.preventDefault();
    d.libOverlay.hidden = false;
    updateLibUsed();
  }

  function closeLib() { d.libOverlay.hidden = true; }

  function loadLibExample(lang) {
    if (!TC.LIB_EXAMPLES || !TC.LIB_EXAMPLES[lang]) return;
    state.src[state.lang] = d.src.value;                 /* 先保住当前编辑内容 */
    state.src[lang] = TC.LIB_EXAMPLES[lang];
    setLang(lang, true);
    closeLib();
    toast('已载入 ' + TC.LANG_NAME[lang] + ' 标准库示例');
    d.src.focus();
  }

  function render() {
    var res = state.result;
    if (!res) { syncLines(); applyPaneState(); return; }

    if (!res.ok) {
      renderIssues(res.errors, res.warnings || []);
      d.bfOut.innerHTML = '<span class="bf-cmt">; 编译失败，请先修正左侧问题</span>';
      d.bfStat.textContent = '—';
      d.vars.innerHTML = '';
      renderHeaders(res.headers, res.stdfuncs);
      updateLibUsed();
      applyPaneState();
      syncLines();
      return;
    }

    renderBF(res.code, res.preview);
    d.bfStat.textContent = (res.stats.partial ? '≥ ' : '') +
                           res.stats.commands + ' 指令 · ' + res.stats.cells + ' 格' +
                           (res.preview ? ' · 仅预览前 120 KB' : '');
    d.bfStat.title = '编译 ' + state.compileMs + ' ms · 完整输出 ' +
                     (res.fullChars || res.code.length) + ' 字符' +
                     (res.stats.partial ? '（预览按时间预算提前统计，指令数是下界；导出会完整生成）' : '') +
                     (res.preview ? '（编辑器只预览开头，复制 / 下载 / 送调试器时会生成完整代码）' : '') +
                     '（源码与选项不变时直接复用结果）';
    renderVars(res.vars);
    renderIssues([], res.warnings || []);
    renderHeaders(res.headers, res.stdfuncs);
    updateLibUsed();
    d.bfOut.scrollTop = 0;
    applyPaneState();
    syncLines();
  }

  /* ---------------- 编译 ---------------- */
  function compile(force) {
    var src = d.src.value;
    var key = state.lang + '\u0000' + state.depth + '\u0000' + state.intWidth + '\u0000' +
              (state.comments ? 1 : 0) + '\u0000' + src;
    /* 语言 / 源码 / 递归层数 / 位宽 / 注释开关都没变就不重编译：
       面板开关、字号、光标移动等触发的 render 只重画，不跑一遍完整编译。 */
    if (force || key !== state.cacheKey) {
      state.cacheKey = key;
      var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
      state.result = TC.compile(state.lang, src, {
        depth: state.depth,
        comments: state.comments,
        int32: state.intWidth === 32,
        /* 编辑器每次输入都会编译，这里只要前 120 KB 预览（外加一个宽松的
           时间预算，避免极端大程序拖慢打字）；完整代码在点导出按钮时才生成，
           且不受任何指令数上限。 */
        preview: true
      });
      state.compileMs = t0 ? Math.round((performance.now() - t0) * 10) / 10 : 0;
    }
    render();
  }

  function scheduleCompile() {
    clearTimeout(state.timer);
    /* 自适应防抖：上次编译越慢，越要等用户真正停笔再跑全量编译；
       小源码则更快响应。避免大工程里每个打字间隙都卡一下。 */
    var wait = Math.max(140, Math.min(500, Math.round(state.compileMs * 2) || 220));
    /* 大工程的 IR / 指令流本身就占内存，别在每个打字间隙都全量编译一遍 */
    if (state.result && state.result.ok && state.result.stats &&
        state.result.stats.commands > 500000) {
      wait = Math.max(wait, 700);
    }
    state.timer = setTimeout(compile, wait);
  }

  /* ---------------- 语言切换 ---------------- */
  function setLang(lang, silent) {
    if (!silent) state.src[state.lang] = d.src.value;

    state.lang = lang;
    d.src.value = state.src[lang] || '';
    /* 给 textarea 赋 value 会把光标放到末尾，这里拉回第 1 行第 1 列 */
    d.src.setSelectionRange(0, 0);
    d.src.scrollTop = 0;
    if (d.srcLines) d.srcLines.scrollTop = 0;
    d.srcChip.textContent = TC.LANG_NAME[lang];

    var btns = d.langWrap.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('on', btns[i].dataset.lang === lang);
    }

    compile();
    save();
    if (!silent) d.src.focus();
  }

  /* ---------------- 存档 ---------------- */
  function save() {
    state.src[state.lang] = d.src.value;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        lang: state.lang, src: state.src, depth: state.depth, intWidth: state.intWidth,
        comments: state.comments, showIssues: state.showIssues, showHint: state.showHint,
        showVars: state.showVars,
        fs: state.fs
      }));
    } catch (err) { /* 忽略 */ }
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return false;
      var data = JSON.parse(raw);
      if (!data || !data.src) return false;
      state.src.c = data.src.c || '';
      state.src.cpp = data.src.cpp || '';
      state.src.asm = data.src.asm || '';
      if (data.depth) state.depth = data.depth;
      if (Number(data.intWidth) === 32) state.intWidth = 32;
      if (typeof data.comments === 'boolean') state.comments = data.comments;
      if (typeof data.showIssues === 'boolean') state.showIssues = data.showIssues;
      if (typeof data.showHint === 'boolean') state.showHint = data.showHint;
      if (typeof data.showVars === 'boolean') state.showVars = data.showVars;
      if (data.fs) {
        ['src', 'bf'].forEach(function (k) {
          var v = Number(data.fs[k]);
          if (isFinite(v) && v > 0) state.fs[k] = Math.max(FS_MIN, Math.min(FS_MAX, v));
        });
      }
      if (data.lang && TC.LANG_NAME[data.lang]) state.lang = data.lang;
      return true;
    } catch (err) {
      return false;
    }
  }

  /* ---------------- 操作 ---------------- */
  function jumpToLine(line) {
    var text = d.src.value;
    var idx = 0;
    var cur = 1;
    while (cur < line) {
      var nl = text.indexOf('\n', idx);
      if (nl < 0) break;
      idx = nl + 1;
      cur++;
    }
    var end = text.indexOf('\n', idx);
    if (end < 0) end = text.length;

    d.src.focus();
    d.src.setSelectionRange(idx, end);

    var lh = state.fs.src * 1.65;      /* 与 CSS 的 --src-fs × --src-lh 一致 */
    d.src.scrollTop = Math.max(0, (line - 1) * lh - d.src.clientHeight / 2);
    if (d.srcLines) d.srcLines.scrollTop = d.src.scrollTop;
    updateCurLine();
  }

  /* 编辑器里存的是 120 KB 预览。需要完整代码时才重新编译一次，
     结果不写回 state.result —— 用完即可回收，避免十几 MB 常驻。
     noJoin=true 时只拿 64 KB 分片，供「下载 .bf」直接交给 Blob。 */
  function fullResult(noJoin) {
    if (state.result && state.result.ok && !state.result.preview) return state.result;
    return TC.compile(state.lang, d.src.value, {
      depth: state.depth,
      comments: state.comments,
      int32: state.intWidth === 32,
      noJoin: !!noJoin
    });
  }

  function needFull(noJoin) {
    if (!state.result || !state.result.ok) { toast('还没有可导出的结果'); return null; }
    var r = fullResult(noJoin);
    if (!r.ok) { toast('完整代码编译失败：' + (r.errors[0] && r.errors[0].message || '未知错误')); return null; }
    var n = r.fullChars || 0;
    if (n > 20000000) toast('正在生成 ' + (n / 1000000).toFixed(1) + ' 百万条指令，大文件请稍候…');
    return r;
  }

  function download() {
    var r = needFull(true);
    if (!r) return;
    /* 直接把 64 KB 分片交给 Blob：不 join 出一整条巨型字符串，
       超大规模程序也能写出完整 .bf，内存峰值只有一份数据。 */
    var parts = (r.chunks && r.chunks.length) ? r.chunks : [r.code || ''];
    var blob = new Blob(parts, { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'program-' + state.lang + '.bf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1200);
    toast('已下载 .bf 文件');
  }

  function copy() {
    var r = needFull(false);
    if (!r) return;
    var text = r.code;
    if (!text) { toast('代码为空'); return; }
    /* 剪贴板不是可靠的大容量通道，但这里不再拦截：能复制就复制，
       放不下由浏览器自己拒绝，同时提示更稳妥的下载路径。 */
    if (text.length > 20000000) {
      toast('代码 ' + Math.round(text.length / 1048576) + ' MB，剪贴板可能放不下，建议用「下载 .bf」');
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast('已复制 ' + text.length + ' 个字符');
      }, function () { toast('复制失败，请手动选择或用「下载 .bf」'); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('已复制');
    }
  }

  /* ---------------- 送调试器 ----------------
     sessionStorage 只有约 5 MB，编译产物稍大就 setItem 失败。小代码仍走
     同步 sessionStorage（最快、也兼容旧调试器），大代码直接把对象结构化
     克隆进 IndexedDB —— 不必 JSON.stringify 成一整条巨型字符串，也没有
     5 MB 配额限制。两边约定同一个库名 / 仓库名 / 键名。 */
  var BRIDGE_DB = 'bf-compiler-bridge';
  var BRIDGE_STORE = 'pending';
  var BRIDGE_KEY = 'code';
  var SMALL_HANDOFF = 1500000;

  function putBridge(payload, size, done) {
    if (size <= SMALL_HANDOFF) {
      try {
        sessionStorage.setItem('bf-pending-code', JSON.stringify(payload));
        done(true);
        return;
      } catch (err) {
        try { sessionStorage.removeItem('bf-pending-code'); } catch (e) {}
      }
    }
    if (typeof indexedDB === 'undefined' || !indexedDB) { done(false); return; }
    var req;
    try { req = indexedDB.open(BRIDGE_DB, 1); }
    catch (err2) { done(false); return; }
    req.onupgradeneeded = function () {
      var db0 = req.result;
      if (!db0.objectStoreNames.contains(BRIDGE_STORE)) db0.createObjectStore(BRIDGE_STORE);
    };
    req.onerror = function () { done(false); };
    req.onsuccess = function () {
      var db = req.result, tx, finished = false;
      function finish(ok) {
        if (finished) return;
        finished = true;
        try { db.close(); } catch (e) {}
        done(ok);
      }
      try {
        tx = db.transaction(BRIDGE_STORE, 'readwrite');
        tx.objectStore(BRIDGE_STORE).put(payload, BRIDGE_KEY);
      } catch (err3) { finish(false); return; }
      tx.oncomplete = function () { finish(true); };
      tx.onerror = tx.onabort = function () { finish(false); };
    };
  }

  function openInDebugger() {
    var r = needFull(false);
    if (!r) return;
    var cells = r.cells || (state.result && state.result.cells) || { names: {}, notes: {} };
    var payload = {
      name: TC.LANG_NAME[state.lang] + ' 编译产物',
      code: r.code,
      cellNames: cells.names,
      cellNotes: cells.notes
    };
    var size = r.fullChars || (r.code && r.code.length) || 0;
    if (size > 8000000) toast('代码 ' + Math.round(size / 1048576) + ' MB，正在写入本地桥接，请稍候…');
    putBridge(payload, size, function (ok) {
      if (!ok) { toast('无法传给调试器（本地存储配额不足）；请点「下载 .bf」再在调试器里导入'); return; }
      location.href = 'index.html';
    });
  }

  /* ---------------- 智能缩进 ---------------- */
  var INDENT = '    ';

  function smartKey(e) {
    var ta = d.src;
    var text = ta.value;
    var s = ta.selectionStart, en = ta.selectionEnd;
    var ls = lineStartOf(text, s);
    var before = text.slice(ls, s);
    var im = /^[ \t]*/.exec(before);
    var indent = im ? im[0] : '';
    var key = e.key;

    /* 替换选区并派发 input，让自动编译 / 存档 / 行号同步照常发生 */
    function put(start, end, ins, caret) {
      ta.value = text.slice(0, start) + ins + text.slice(end);
      ta.setSelectionRange(caret, caret);
      ta.dispatchEvent(new Event('input'));
    }

    /* Enter：继承当前行缩进；以 { [ ( 结尾再加一级；紧邻闭合括号时补一行放它 */
    if (key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      var trimmed = before.replace(/\s+$/, '');
      var opens = /[{\[(]\s*$/.test(trimmed);
      var after = text.slice(s, lineEndOf(text, s));
      if (opens && /^\s*[}\])]/.test(after) && s === en) {
        var mid = '\n' + indent + INDENT + '\n' + indent;
        put(s, en, mid, s + 1 + indent.length + INDENT.length);
      } else {
        var ins = '\n' + indent + (opens ? INDENT : '');
        put(s, en, ins, s + ins.length);
      }
      return;
    }

    /* 输入 } ) ] 且本行光标前全是空白：整行回退一级缩进 */
    if ((key === '}' || key === ')' || key === ']') && s === en && /^[ \t]+$/.test(before)) {
      e.preventDefault();
      var cut = before.length >= 4 ? 4 : before.length;
      var ni = before.slice(0, before.length - cut);
      put(ls, s, ni + key, ls + ni.length + 1);
      return;
    }

    /* Backspace：光标处在纯缩进里 → 退到上一个 4 列边界 */
    if (key === 'Backspace' && s === en && /^[ ]+$/.test(before)) {
      e.preventDefault();
      var back = (before.length % 4) || 4;
      put(s - back, s, '', s - back);
      return;
    }

    /* Tab / Shift+Tab：选中多行整块缩进，单行插入或删除一个缩进单位 */
    if (key === 'Tab') {
      e.preventDefault();
      if (s !== en && text.slice(s, en).indexOf('\n') >= 0) {
        var bs = lineStartOf(text, s);
        var be = lineEndOf(text, en);
        var parts = text.slice(bs, be).split('\n');
        var delta = 0, firstDelta = 0;
        var out = parts.map(function (ln, i) {
          if (e.shiftKey) {
            var m = /^( {1,4}|\t)/.exec(ln);
            var c = m ? m[0].length : 0;
            if (i === 0) firstDelta = -c;
            delta -= c;
            return ln.slice(c);
          }
          if (i === 0) firstDelta = INDENT.length;
          delta += INDENT.length;
          return INDENT + ln;
        }).join('\n');
        ta.value = text.slice(0, bs) + out + text.slice(be);
        ta.setSelectionRange(Math.max(bs, s + firstDelta), Math.max(bs, en + delta));
        ta.dispatchEvent(new Event('input'));
      } else if (e.shiftKey) {
        var m3 = /^ {1,4}|^\t/.exec(text.slice(ls, ls + 4));
        var c3 = m3 ? m3[0].length : 0;
        ta.value = text.slice(0, ls) + text.slice(ls + c3);
        ta.setSelectionRange(Math.max(ls, s - c3), Math.max(ls, s - c3));
        ta.dispatchEvent(new Event('input'));
      } else {
        put(s, en, INDENT, s + INDENT.length);
      }
    }
  }

  /* ---------------- 事件 ---------------- */
  function bind() {
    /* 字号步进器 + Ctrl/⌘ 滚轮，左右各自独立 */
    [['srcFsMinus', 'src', -1], ['srcFsPlus', 'src', 1],
     ['bfFsMinus', 'bf', -1], ['bfFsPlus', 'bf', 1]].forEach(function (x) {
      var el = $(x[0]);
      if (el) el.addEventListener('click', function () { changeFont(x[1], x[2] * FS_STEP); });
    });
    bindFontWheel('src', d.src);
    bindFontWheel('bf', d.bfOut);

    d.langWrap.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-lang]');
      if (!btn) return;
      if (btn.dataset.lang === state.lang) return;
      setLang(btn.dataset.lang);
    });

    d.src.addEventListener('input', function () {
      syncLines();
      scheduleCompile();
      save();
    });

    if (d.recDepth) {
      d.recDepth.addEventListener('change', function () {
        var v = parseInt(d.recDepth.value, 10);
        if (!isFinite(v)) v = 8;
        v = Math.max(1, Math.min(24, v));
        d.recDepth.value = String(v);
        state.depth = v;
        compile();
        save();
      });
    }

    if (d.intWidth) {
      d.intWidth.value = String(state.intWidth);
      d.intWidth.addEventListener('change', function () {
        state.intWidth = Number(d.intWidth.value) === 32 ? 32 : 8;
        compile();
        save();
        toast(state.intWidth === 32
          ? 'int 已切换为 32 位有符号（含负数），生成代码会明显变长'
          : 'int 已切回 8 位无符号（兼容模式）');
      });
    }

    d.src.addEventListener('keydown', smartKey);
    d.src.addEventListener('scroll', function () {
      if (d.srcLines) d.srcLines.scrollTop = d.src.scrollTop;
    });
    ['click', 'keyup', 'select'].forEach(function (ev) {
      d.src.addEventListener(ev, updateCurLine);
    });
    d.srcLines.addEventListener('click', function (e) {
      var el = e.target.closest('.ln');
      if (el) jumpToLine(parseInt(el.dataset.line, 10) || 1);
    });

    /* 可关闭面板：关闭后由卡片头上的小按钮恢复，状态记进 localStorage */
    $('btnIssuesClose').addEventListener('click', function () {
      state.showIssues = false; applyPaneState(); save();
    });
    $('btnIssuesShow').addEventListener('click', function () {
      state.showIssues = true; applyPaneState(); save();
      toast('已展开问题 / 警告面板');
    });
    $('btnHintClose').addEventListener('click', function () {
      state.showHint = false; applyPaneState(); save();
    });
    $('btnHintShow').addEventListener('click', function () {
      state.showHint = true; applyPaneState(); save();
      toast('已展开支持范围说明');
    });

    /* 生成注释开关 */
    if (d.optComments) {
      d.optComments.checked = state.comments;
      d.optComments.addEventListener('change', function () {
        state.comments = this.checked;
        compile();
        save();
        toast(state.comments ? '已开启逐句注释' : '已关闭注释，输出纯 BrainFuck');
      });
    }

    /* 变量区开关 */
    if (d.optVars) {
      d.optVars.checked = state.showVars;
      d.optVars.addEventListener('change', function () {
        state.showVars = this.checked;
        applyPaneState();
        save();
        toast(state.showVars ? '已展开变量区' : '已收起变量区');
      });
    }

    d.issues.addEventListener('click', function (e) {
      var el = e.target.closest('.issue');
      if (!el) return;
      jumpToLine(parseInt(el.dataset.line, 10) || 1);
    });

    $('btnCopy').addEventListener('click', copy);
    $('btnDownload').addEventListener('click', download);
    $('btnRunInDebugger').addEventListener('click', openInDebugger);

    /* 标准库速查 */
    d.btnStdlib.addEventListener('click', openLib);
    if (d.hintStdlib) d.hintStdlib.addEventListener('click', openLib);
    d.btnLibClose.addEventListener('click', closeLib);
    d.libOverlay.addEventListener('click', function (e) {
      if (e.target === d.libOverlay) closeLib();
    });
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !d.libOverlay.hidden) closeLib();
    });
    d.btnLibExC.addEventListener('click', function () { loadLibExample('c'); });
    d.btnLibExCpp.addEventListener('click', function () { loadLibExample('cpp'); });

    $('btnExample').addEventListener('click', function () {
      d.src.value = TC.EXAMPLES[state.lang];
      compile();
      save();
      toast('已载入 ' + TC.LANG_NAME[state.lang] + ' 示例');
    });

    /* 猜数字示例：一次载入原始完整源码，再点一次载入 8 位可玩版 */
    var guessRaw = false;
    $('btnGuess').addEventListener('click', function () {
      if (!TC.GUESS_RAW || !TC.GUESS_8) { toast('示例模块未加载'); return; }
      guessRaw = !guessRaw;
      state.src[state.lang] = d.src.value;
      state.src.cpp = guessRaw ? TC.GUESS_RAW : TC.GUESS_8;
      setLang('cpp', true);
      $('btnGuess').textContent = guessRaw ? '载入8位猜数字' : '载入原版猜数字';
      toast(guessRaw ? '已载入原始 guess_number.cpp（降级项见下方告警）'
                     : '已载入 8 位可玩版猜数字');
      d.src.focus();
    });

    $('btnStr').addEventListener('click', function () {
      if (!TC.STR_EXAMPLE) { toast('示例模块未加载'); return; }
      state.src[state.lang] = d.src.value;
      state.src.cpp = TC.STR_EXAMPLE;
      setLang('cpp', true);
      toast('已载入 std::string 示例（32 字节定长缓冲，中文按 UTF-8 字节计长）');
      d.src.focus();
    });

    $('btnFloat').addEventListener('click', function () {
      if (!TC.FLOAT_EXAMPLE) { toast('示例模块未加载'); return; }
      state.src[state.lang] = d.src.value;
      state.src.cpp = TC.FLOAT_EXAMPLE;
      setLang('cpp', true);
      toast('已载入 float / double 示例（定点数，3 位小数）');
      d.src.focus();
    });

    $('btnCalc').addEventListener('click', function () {
      if (!TC.CALC_EXAMPLE) { toast('示例模块未加载'); return; }
      state.src[state.lang] = d.src.value;
      state.src.cpp = TC.CALC_EXAMPLE;
      setLang('cpp', true);
      toast('已载入计算器示例（struct / switch / 历史记录，可直接运行）');
      d.src.focus();
    });

    $('btnCalcFull').addEventListener('click', function () {
      if (!TC.CALC_FULL_EXAMPLE) { toast('示例模块未加载'); return; }
      state.src[state.lang] = d.src.value;
      state.src.cpp = TC.CALC_FULL_EXAMPLE;
      setLang('cpp', true);
      toast('已载入完整计算器源码；展开规模很大，导出请用「下载 .bf」');
      d.src.focus();
    });

    $('btnPtr').addEventListener('click', function () {
      if (!TC.PTR_EXAMPLE) { toast('示例模块未加载'); return; }
      state.src[state.lang] = d.src.value;
      state.src.cpp = TC.PTR_EXAMPLE;
      setLang('cpp', true);
      toast('已载入指针示例（&a / *p / p++ / 指针形参 / nullptr）');
      d.src.focus();
    });

    $('btnFunc').addEventListener('click', function () {
      if (!TC.FUNC_EXAMPLE) { toast('示例模块未加载'); return; }
      state.src[state.lang] = d.src.value;
      state.src.cpp = TC.FUNC_EXAMPLE;
      setLang('cpp', true);
      toast('已载入标准函数示例（char() / cctype / 取整 / strlen）');
      d.src.focus();
    });

    $('btnReturn').addEventListener('click', function () {
      if (!TC.RETURN_EXAMPLE) { toast('示例模块未加载'); return; }
      state.src[state.lang] = d.src.value;
      state.src.cpp = TC.RETURN_EXAMPLE;
      setLang('cpp', true);
      toast('已载入 return 示例（循环内 / 多层跳出 / void / main）');
      d.src.focus();
    });

    $('btnArray').addEventListener('click', function () {
      if (!TC.ARRAY_EXAMPLE) { toast('示例模块未加载'); return; }
      state.src[state.lang] = d.src.value;
      state.src.cpp = TC.ARRAY_EXAMPLE;
      setLang('cpp', true);
      toast('已载入数组示例（一维 / 二维 / 动态下标 / int32 与 double 元素）');
      d.src.focus();
    });

    $('btnClear').addEventListener('click', function () {
      d.src.value = '';
      compile();
      save();
      d.src.focus();
    });

    window.addEventListener('beforeunload', save);
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    d.src = $('src');
    d.langWrap = $('langs');
    d.bfOut = $('bfOut');
    d.bfStat = $('bfStat');
    d.srcChip = $('srcChip');
    d.srcStat = $('srcStat');
    d.issues = $('issues');
    d.vars = $('vars');
    d.toastWrap = $('toastWrap');
    d.recDepth = $('recDepth');
    d.intWidth = $('intWidth');
    d.srcLines = $('srcLines');
    d.optComments = $('optComments');
    d.optVars = $('optVars');

    d.hdrLine = $('hdrLine');
    d.libOverlay = $('libOverlay');
    d.libFuncs = $('libFuncs');
    d.libHeaders = $('libHeaders');
    d.libNoneNote = $('libNoneNote');
    d.libHdrTotal = $('libHdrTotal');
    d.libHdrOk = $('libHdrOk');
    d.libUsed = $('libUsed');
    d.btnStdlib = $('btnStdlib');
    d.hintStdlib = $('hintStdlib');
    d.btnLibClose = $('btnLibClose');
    d.btnLibExC = $('btnLibExC');
    d.btnLibExCpp = $('btnLibExCpp');
    if (TC.Stdlib) buildLibPanel();

    var loaded = load();
    applyFont();               /* load() 里可能恢复了自定义字号 */
    if (!loaded) {
      state.src.c = TC.EXAMPLES.c;
      state.src.cpp = TC.EXAMPLES.cpp;
      state.src.asm = TC.EXAMPLES.asm;
    }
    if (d.recDepth) d.recDepth.value = String(state.depth);

    bind();
    setLang(state.lang || 'c', true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window.TC = window.TC || {});
