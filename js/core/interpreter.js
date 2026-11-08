/* =========================================================================
 * core/interpreter.js —— 执行引擎
 * 负责：单步执行、连续运行调度、断点暂停、输入等待、越界/括号错误处理。
 * 只管状态推进，画面刷新统一交给 BF.render()（app.js 提供）。
 * ========================================================================= */
(function (BF) {
  'use strict';

  var S = BF.state;

  /* 指令表存的是 ASCII 码（Uint8Array），热路径直接用数字比较，
     避免每执行一条指令就创建一个字符串 / 对象。 */
  var C_PLUS = 43, C_MINUS = 45, C_LT = 60, C_GT = 62,
      C_LB = 91, C_RB = 93, C_DOT = 46, C_COMMA = 44;

  function repaint() { if (BF.render) BF.render(); }
  function toast(msg) { if (BF.Status) BF.Status.toast(msg); }

  /* ---------------- 调度 ---------------- */
  function cancelTick() {
    if (S.tickKind === 't') clearTimeout(S.tickHandle);
    else if (S.tickKind === 'r') cancelAnimationFrame(S.tickHandle);
    S.tickKind = null;
    S.tickHandle = null;
  }

  function schedule(fn, delay) {
    if (delay > 0) {
      S.tickKind = 't';
      S.tickHandle = setTimeout(fn, delay);
    } else {
      S.tickKind = 'r';
      S.tickHandle = requestAnimationFrame(fn);
    }
  }

  /* ---------------- 单条指令 ---------------- */
  function fail(msg) {
    S.error = msg;
    S.running = false;
    S.paused = true;
    S.finished = false;
    cancelTick();
    repaint();
    return 'error';
  }

  /**
   * 执行一条指令。
   * @param {'run'|'step'} mode run 模式会检查断点
   * @returns {'ok'|'end'|'input'|'error'|'bp'}
   */
  function execOne(mode) {
    if (S.pc >= S.ops.length) return 'end';

    var ch = S.ops.ch[S.pc];
    var line = S.ops.line[S.pc];

    /* 断点：运行到该行第一条指令前停下。
       从该行继续时先离开这一行，避免同一行的下一条指令立刻再次命中。 */
    if (mode === 'run') {
      if (S.bpSkipLine !== -1 && line !== S.bpSkipLine) S.bpSkipLine = -1;
      if (S.bp.has(line) && line !== S.bpSkipLine) return 'bp';
    }

    var t = S.tape;
    var p = S.ptr;
    var pc0 = S.pc;
    var ptr0 = p;
    var cellIdx = -1;    /* 被改写的单元格（供「上一步」回滚） */
    var oldVal = 0;
    var outLen = -1;
    var inChar = -1;
    var jumpTo = -1;
    var j;

    switch (ch) {
      case C_PLUS:
        cellIdx = p; oldVal = t[p];
        t[p] = (t[p] + 1) & 255;
        break;
      case C_MINUS:
        cellIdx = p; oldVal = t[p];
        t[p] = (t[p] - 1) & 255;
        break;
      case C_GT:
        if (p + 1 >= t.length) return fail('指针越界：地址 ' + (p + 1) + ' 超出内存容量');
        S.ptr = p + 1;
        break;
      case C_LT:
        if (p - 1 < 0) return fail('指针越界：低于地址 0');
        S.ptr = p - 1;
        break;
      case C_DOT:
        outLen = S.out.length;
        S.out += String.fromCharCode(t[p]);
        break;
      case C_COMMA:
        if (!S.input.length) { S.waiting = true; return 'input'; }
        inChar = S.input.shift() & 255;
        cellIdx = p; oldVal = t[p];
        t[p] = inChar;
        break;
      case C_LB:
        if (t[p] === 0) {
          j = S.jumps.get(S.pc);
          if (j === undefined) return fail('第 ' + line + ' 行的 [ 没有匹配的 ]');
          jumpTo = j + 1;
        }
        break;
      case C_RB:
        if (t[p] !== 0) {
          j = S.jumps.get(S.pc);
          if (j === undefined) return fail('第 ' + line + ' 行的 ] 没有匹配的 [');
          jumpTo = j + 1;
        }
        break;
    }

    S.pc = (jumpTo >= 0) ? jumpTo : (pc0 + 1);
    S.steps++;
    BF.History.push(pc0, ptr0, cellIdx, oldVal, outLen, inChar);
    return 'ok';
  }

  /* ---------------- 实测速率 ---------------- */
  function measureRate() {
    var now = performance.now();
    if (!S.rateT0) { S.rateT0 = now; S.rateSteps = S.steps; return; }
    var dt = now - S.rateT0;
    if (dt < 300) return;
    S.mRate = Math.round((S.steps - S.rateSteps) * 1000 / dt);
    S.rateT0 = now;
    S.rateSteps = S.steps;
  }

  /* ---------------- 重绘节流 ----------------
   * 以前每一拍都整页重绘，一拍 4~5 条指令时重绘本身就占了大半时间，
   * 于是定时器越跑越晚、速率掉到设定的 40%。现在按 30fps 上限重绘。
   */
  var PAINT_MS = 30;
  var lastPaint = 0;

  function paint(force) {
    var now = performance.now();
    if (!force && now - lastPaint < PAINT_MS) return;
    lastPaint = now;
    repaint();
  }

  /* ---------------- 配速（欠账补发） ----------------
   * 不去猜「一帧跑几条」，而是记录两个锚点：从什么时候、从第几步开始算。
   * 每一拍都算「按墙钟到现在应该跑多少条」，把差的那部分补上：
   *   超时就多跑、提前就少跑，平均速率恒等于目标速率，
   *   定时器抖动、重绘开销、GC 卡顿都不会累积成偏差。
   */
  function resetPace(now) {
    S.paceT0 = now || performance.now();
    S.paceSteps = S.steps;
    S.paceIps = S.speed;
  }

  /* ---------------- 连续运行 ---------------- */
  function runLoop() {
    if (!S.running) return;

    var now = performance.now();
    var ips = BF.Speed.clamp(S.speed);
    var cfg = BF.Speed.plan(ips);
    var unlimited = !!cfg.unlimited;

    /* 换挡：以当前位置作为新锚点，避免按旧速率的账目结算 */
    if (!S.paceT0 || S.paceIps !== ips) resetPace(now);

    var owed, rebase = false;

    if (unlimited) {
      /* +∞ 不限速：不按墙钟配速，每拍尽量跑；靠下面的 12ms 时间片让出
         主线程，保证暂停 / 断点 / 输入等待仍然及时响应。 */
      owed = Infinity;
    } else {
      owed = (now - S.paceT0) * ips / 1000 - (S.steps - S.paceSteps);

      /* 落后太多才认定是「被限流 / 页面挂起」，丢掉多余的欠账；
         普通抖动（定时器晚几毫秒、重绘卡一拍）照全额补，不丢精度。
         阈值至少取 4 个指令周期 —— 否则 1 指令/秒这种慢速会被自己的阈值卡死。 */
      var maxLagMs = Math.max(250, 4000 / ips);
      var lagMs = owed / ips * 1000;
      if (lagMs > maxLagMs) {
        owed = maxLagMs * ips / 1000;
        rebase = true;
      }
      if (owed > 1000000) { owed = 1000000; rebase = true; }
    }

    var n = Math.floor(owed);
    if (n < 0) n = 0;

    var t0 = now;
    var done = 0;
    var st, ln;

    while (done < n) {
      st = execOne('run');

      if (st === 'end') { finish(); return; }

      if (st === 'input') {
        S.running = false;
        S.waiting = true;
        S.resumeAfterInput = true;   /* 补上输入后继续跑 */
        S.mRate = 0;
        cancelTick();
        paint(true);
        if (BF.Console) BF.Console.focusInput();
        toast('程序正在等待输入（, 指令）');
        return;
      }

      if (st === 'error') return;

      if (st === 'bp') {
        ln = S.ops.line[S.pc];
        S.running = false;
        S.paused = true;
        S.mRate = 0;
        cancelTick();
        paint(true);
        if (BF.Editor) BF.Editor.scrollToPc();
        toast('命中断点 · 第 ' + ln + ' 行');
        return;
      }

      done++;
      if (performance.now() - t0 > 12) break;   /* 让出主线程，保证界面不卡 */
    }

    if (rebase) resetPace(performance.now());

    measureRate();
    paint(false);

    if (unlimited) {
      /* setTimeout(0) 比 requestAnimationFrame 更密（不受 60fps 限制）；
         每 12ms 已让出一次，界面不会卡死。 */
      S.tickKind = 't';
      S.tickHandle = setTimeout(runLoop, 0);
    } else {
      /* 下一条指令的到期时刻：欠账就 0 延迟立刻补，否则最多睡一个节拍 */
      var due = S.paceT0 + (S.steps - S.paceSteps + 1) * 1000 / ips;
      var wait = due - performance.now();
      schedule(runLoop, wait >= 1 ? Math.min(wait, Math.max(1, cfg.tickMs)) : 0);
    }
  }

  function finish() {
    S.running = false;
    S.paused = false;
    S.finished = true;
    S.mRate = 0;
    cancelTick();
    repaint();
    toast('程序执行结束，共 ' + S.steps + ' 步');
  }

  /* 代码改动后首次执行前，重置运行态 */
  function ensureReady() {
    if (S.dirty) {
      BF.Compiler.apply(S.code);
      hardReset();
      S.out = '';
      S.dirty = false;
      toast('代码已修改，执行状态已重置');
    }
    if (S.unbalanced) {
      S.error = S.unbalanced;
      repaint();
      toast(S.unbalanced);
      return false;
    }
    if (!S.ops.length) {
      toast('没有可执行指令');
      return false;
    }
    return true;
  }

  function run() {
    if (S.running) return;
    if (!ensureReady()) return;
    if (S.finished) { toast('程序已结束，请先重置'); return; }
    if (S.waiting) {
      toast('请先在下方送入输入字符');
      if (BF.Console) BF.Console.focusInput();
      return;
    }

    S.error = '';
    S.started = true;
    S.running = true;
    S.paused = false;
    S.mRate = 0;
    S.rateT0 = 0;
    S.rateSteps = S.steps;
    S.bpSkipLine = (S.pc < S.ops.length) ? S.ops.line[S.pc] : -1;  /* 从当前行进入，本行不重复命中 */
    resetPace();                                          /* 从现在开始计速 */
    paint(true);
    runLoop();
  }

  function pause() {
    if (!S.running) return;
    S.running = false;
    S.paused = true;
    S.mRate = 0;
    cancelTick();
    repaint();
    if (BF.Editor) BF.Editor.scrollToPc();
  }

  /* 上一步：回滚最近一条已执行指令 */
  function undo() {
    if (S.running) return;

    var rec = BF.History.pop();
    if (!rec) {
      toast('已经是第一步，无法回退');
      return;
    }

    S.pc = rec.pc;
    S.ptr = rec.ptr;
    if (rec.cell >= 0 && rec.cell < S.tape.length) S.tape[rec.cell] = rec.val;
    if (rec.out >= 0) S.out = S.out.slice(0, rec.out);
    if (rec.inp >= 0) S.input.unshift(rec.inp);
    if (S.steps > 0) S.steps--;

    S.started = true;
    S.paused = true;
    S.running = false;
    S.finished = false;
    S.waiting = false;
    S.resumeAfterInput = false;
    S.error = '';
    S.mRate = 0;
    S.bpSkipLine = -1;
    cancelTick();
    repaint();
    if (BF.Editor) BF.Editor.scrollToPc();
  }

  function step() {
    cancelTick();

    if (!ensureReady()) return;
    if (S.waiting) {
      toast('请先在下方送入输入字符');
      if (BF.Console) BF.Console.focusInput();
      return;
    }
    if (S.pc >= S.ops.length) { toast('程序已结束，请先重置'); return; }

    S.error = '';
    S.started = true;
    S.running = false;
    S.paused = true;
    S.bpSkipLine = -1;   /* 单步不受断点影响 */

    var st = execOne('step');

    if (st === 'end') { finish(); return; }
    if (st === 'input') {
      S.waiting = true;
      S.resumeAfterInput = false;   /* 单步遇到输入：补上后仍停在原处 */
      repaint();
      if (BF.Console) BF.Console.focusInput();
      return;
    }
    if (st === 'error') return;

    repaint();
    if (BF.Editor) BF.Editor.scrollToPc();
  }

  /* ---------------- 重置 ---------------- */
  function hardReset() {
    S.tape = new Uint8Array(S.tape.length);
    S.ptr = 0;
    S.pc = 0;
    S.steps = 0;
    S.running = false;
    S.paused = false;
    S.finished = false;
    S.waiting = false;
    S.started = false;
    S.error = '';
    S.bpSkipLine = -1;
    S.input = [];
    S.mRate = 0;
    S.rateT0 = 0;
    S.paceT0 = 0;
    S.paceSteps = 0;
    S.paceIps = 0;
    BF.History.clear();
    cancelTick();
    if (BF.Console) BF.Console.clearWaiting();
  }

  function reset() {
    hardReset();
    S.out = '';
    S.sel = 0;
    if (BF.Memory) BF.Memory.invalidate();
    repaint();
  }

  /* ---------------- 内存容量 ---------------- */
  function setTapeSize(n, keep) {
    n = Math.max(8, Math.min(4096, n | 0));
    var old = S.tape;
    var tape = new Uint8Array(n);
    if (keep && old) tape.set(old.subarray(0, Math.min(old.length, n)));
    S.tape = tape;
    if (S.ptr >= n) S.ptr = n - 1;
    if (S.sel >= n) S.sel = n - 1;
    BF.History.clear();   /* 容量变了，旧的单元格回滚记录失效 */
    if (BF.Memory) BF.Memory.build();
    repaint();
  }

  BF.Engine = {
    run: run,
    pause: pause,
    step: step,
    undo: undo,
    reset: reset,
    hardReset: hardReset,
    setTapeSize: setTapeSize,
    ensureReady: ensureReady,
    cancelTick: cancelTick,
    execOne: execOne
  };
})(window.BF);
