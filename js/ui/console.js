/* =========================================================================
 * ui/console.js —— 输出 / 输入面板
 * '.' 指令的结果写进 state.out；',' 指令从这里取字符队列。
 * ========================================================================= */
(function (BF) {
  'use strict';

  var S = BF.state;
  var d = BF.dom;

  var drawnLen = -1;

  function sync() {
    if (drawnLen === S.out.length) return;
    drawnLen = S.out.length;

    if (!S.out) {
      d.out.innerHTML = '<span class="ph">程序执行结果会显示在这里…</span>';
    } else {
      /* '.' 输出的是字节：中文等 UTF-8 多字节字符要解码后才是可读文本 */
      var bytes = new Uint8Array(S.out.length);
      for (var bi = 0; bi < S.out.length; bi++) bytes[bi] = S.out.charCodeAt(bi) & 255;
      var text;
      try { text = new TextDecoder('utf-8').decode(bytes); }
      catch (e2) { text = S.out; }
      d.out.textContent = text.replace(/\u0000/g, '␀');
    }
    d.outLen.textContent = S.out.length + ' 字节';
    d.out.scrollTop = d.out.scrollHeight;
  }

  function clear() {
    S.out = '';
    drawnLen = -1;
    sync();
  }

  function clearWaiting() {
    d.btnSend.classList.remove('waiting');
    S.resumeAfterInput = false;
  }

  function focusInput() {
    d.inInput.focus();
    d.inInput.select();
  }

  function send() {
    var text = d.inInput.value;
    if (text === '') text = '\n';

    /* 按 UTF-8 送入输入队列，中文 / 全角字符才不会丢高位 */
    if (typeof TextEncoder !== 'undefined') {
      var enc = new TextEncoder().encode(text);
      for (var ei = 0; ei < enc.length; ei++) S.input.push(enc[ei]);
    } else {
      for (var ci = 0; ci < text.length; ci++) S.input.push(text.charCodeAt(ci) & 255);
    }
    d.inInput.value = '';

    if (S.waiting) {
      var autoResume = !!S.resumeAfterInput;
      S.waiting = false;
      clearWaiting();
      if (BF.render) BF.render();
      if (autoResume) BF.Engine.run();
      else BF.Status.toast('已送入 ' + text.length + ' 个字符，可继续单步');
    } else {
      if (BF.render) BF.render();
      BF.Status.toast('已送入 ' + text.length + ' 个字符');
    }
  }

  function bind() {
    d.btnSend.addEventListener('click', send);

    d.inInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); send(); }
    });

    d.btnClearOut.addEventListener('click', function () {
      clear();
      if (BF.Project) BF.Project.saveSoon();
    });
  }

  BF.Console = {
    init: function () { bind(); },
    sync: sync,
    clear: clear,
    send: send,
    focusInput: focusInput,
    clearWaiting: clearWaiting
  };
})(window.BF);
