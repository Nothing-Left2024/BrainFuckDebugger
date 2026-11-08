/* =========================================================================
 * ui/status.js —— 状态栏 / 按钮态 / 轻提示 / 帮助弹窗
 * ========================================================================= */
(function (BF) {
  'use strict';

  var S = BF.state;
  var d = BF.dom;

  var toastTimer = null;

  /* ---------------- 状态栏 ---------------- */
  function statusOf() {
    if (S.error) return { kind: 'err', label: '错误' };
    if (S.waiting) return { kind: 'wait', label: '等待输入' };
    if (S.running) return { kind: 'running', label: '运行中' };
    if (S.finished) return { kind: 'done', label: '已完成' };
    if (S.paused) return { kind: 'paused', label: '已暂停' };
    if (S.started) return { kind: 'paused', label: '已暂停' };
    return { kind: '', label: '就绪' };
  }

  function paint() {
    var st = statusOf();
    var n = S.ops.length;
    var has = S.pc < n;

    d.statusPill.className = 'pill' + (st.kind ? ' ' + st.kind : '');
    d.statusPill.textContent = st.label;

    d.stPtr.textContent = String(S.ptr);
    d.stPc.textContent = String(Math.min(S.pc + (has ? 1 : 0), n));
    d.stTotal.textContent = String(n);
    d.stSteps.textContent = String(S.steps);

    /* 指令表是 TypedArray，直接按序号取行号 / 字符下标，不建临时对象 */
    var at, ln, col;
    if (has) at = S.pc;
    else if (n) at = n - 1;
    if (at !== undefined) {
      ln = S.ops.line[at];
      col = S.ops.pos[at] - S.offsets[ln - 1] + 1;
    } else {
      ln = 1; col = 1;
    }
    d.stLine.textContent = String(ln);
    d.stCol.textContent = String(col);

    d.stErrWrap.style.display = S.error ? '' : 'none';
    d.stErr.textContent = S.error || '';

    var tag = '指针 @ ' + S.ptr;
    if (S.names[S.ptr]) tag += ' · ' + S.names[S.ptr];
    d.ptrChip.textContent = tag;
    d.ptrChip.classList.toggle('on', !!S.names[S.ptr]);

    d.btnRun.disabled = S.running;
    d.btnPause.disabled = !S.running;
    d.btnUndo.disabled = S.running || BF.History.size() === 0;

    paintSpeed();
  }

  /* ---------------- 轻提示 ---------------- */
  function toast(msg) {
    /* 最多同时显示 3 条，多了就顶掉最旧的 */
    while (d.toastWrap.children.length >= 3) d.toastWrap.firstChild.remove();

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

  /* ---------------- 调速 ---------------- */
  var lastLabel = '';
  var lastActual = '';

  function speedText(ips) {
    return ips === Infinity ? '∞ 不限速' : BF.Speed.format(ips) + '/s';
  }

  function paintSpeed() {
    var target = speedText(S.speed);
    if (target !== lastLabel) {
      lastLabel = target;
      d.speedLabel.textContent = target;
    }

    var preset = BF.Speed.presetOf(S.speed);
    var actual = S.running
      ? '实测 ' + BF.Speed.format(S.mRate || 0)
      : (preset ? preset.label : '自定义');

    if (actual !== lastActual) {
      lastActual = actual;
      d.speedActual.textContent = actual;
      d.speedActual.style.color = S.running ? 'var(--accent)' : '';
    }

    /* 运行中不抢焦点，避免拖动被拉回 */
    if (document.activeElement !== d.speed) {
      d.speed.value = String(BF.Speed.ipsToSlider(S.speed));
    }

    var btns = d.speedPresets.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('on', Number(btns[i].dataset.ips) === S.speed);
    }
  }

  function setSpeed(ips) {
    /* 这里只做区间收敛；旧版 1~10 档号的换算由导入流程显式处理 */
    S.speed = BF.Speed.clamp(ips);
    paintSpeed();
  }

  /* ---------------- 弹窗 ---------------- */
  function openHelp() { d.helpOverlay.classList.add('open'); }
  function closeHelp() { d.helpOverlay.classList.remove('open'); }
  function helpOpen() { return d.helpOverlay.classList.contains('open'); }

  function bind() {
    d.speed.addEventListener('input', function () {
      setSpeed(BF.Speed.sliderToIps(d.speed.value));
      if (BF.Project) BF.Project.saveSoon();
    });

    d.speedPresets.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-ips]');
      if (!btn) return;
      setSpeed(Number(btn.dataset.ips));
      if (BF.Project) BF.Project.saveSoon();
      BF.Status.toast('执行速率：' + speedText(S.speed));
    });

    d.btnHelp.addEventListener('click', openHelp);
    d.btnCloseHelp.addEventListener('click', closeHelp);
    d.helpOverlay.addEventListener('click', function (e) {
      if (e.target === d.helpOverlay) closeHelp();
    });
  }

  BF.Status = {
    init: function () { bind(); paintSpeed(); },
    paint: paint,
    toast: toast,
    setSpeed: setSpeed,
    paintSpeed: paintSpeed,
    openHelp: openHelp,
    closeHelp: closeHelp,
    helpOpen: helpOpen
  };
})(window.BF);
