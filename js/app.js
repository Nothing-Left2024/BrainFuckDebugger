/* =========================================================================
 * app.js —— 装配层
 * 定义统一的 repaint 入口、绑定控制按钮与快捷键、启动顺序。
 * ========================================================================= */
(function (BF) {
  'use strict';

  var S = BF.state;
  var d = BF.dom;

  /* ---------------- 统一重绘入口 ----------------
   * 「仅运行」只在真正连续运行时生效：暂停 / 单步 / 结束会自动恢复完整画面，
   * 所以用户随时能看到最终状态，不需要手动取消勾选。
   * 「跟随」打开时，即便仅运行也保留代码高亮与自动滚动。 */
  BF.render = function () {
    var lite = S.bareRun && S.running;

    if (!lite || S.follow) BF.Editor.refresh();
    if (!lite) BF.Memory.sync();
    if (S.follow && S.started) BF.Editor.scrollToPc();

    BF.Console.sync();
    BF.Status.paint();
  };

  /* ---------------- 控制按钮 ---------------- */
  function bindControls() {
    d.btnRun.addEventListener('click', function () { BF.Engine.run(); });
    d.btnPause.addEventListener('click', function () { BF.Engine.pause(); });
    d.btnStep.addEventListener('click', function () { BF.Engine.step(); });
    d.btnUndo.addEventListener('click', function () { BF.Engine.undo(); });
    d.btnReset.addEventListener('click', function () {
      BF.Engine.reset();
      BF.Status.toast('已重置');
    });

    d.btnClearBp.addEventListener('click', function () {
      S.bp.clear();
      BF.Editor.renderGutter();
      BF.Editor.paintCurrent();
      BF.Project.saveSoon();
      BF.Status.toast('已清除所有断点');
    });

    if (d.optBareRun) {
      d.optBareRun.checked = S.bareRun;
      d.optBareRun.addEventListener('change', function () {
        S.bareRun = this.checked;
        BF.Project.saveSoon();
        BF.render();
        BF.Status.toast(S.bareRun
          ? '仅运行：运行中不再重绘内存，适合高速执行'
          : '已恢复完整内存可视化');
      });
    }
    if (d.optFollow) {
      d.optFollow.checked = S.follow;
      d.optFollow.addEventListener('change', function () {
        S.follow = this.checked;
        BF.Project.saveSoon();
        if (S.follow) BF.Editor.scrollToPc();
        BF.render();
        BF.Status.toast(S.follow ? '已开启执行位置跟随' : '已关闭执行位置跟随');
      });
    }

    /* 变量区：内存卡片底部那块「地址 / 名称 / 注释 / 值」详情，挡住网格时可以收起来 */
    if (d.optInspector) {
      d.optInspector.checked = S.showInspector !== false;
      if (d.inspector) d.inspector.classList.toggle('hidden', !S.showInspector);
      d.optInspector.addEventListener('change', function () {
        S.showInspector = this.checked;
        if (d.inspector) d.inspector.classList.toggle('hidden', !S.showInspector);
        BF.Project.saveSoon();
        BF.Status.toast(S.showInspector
          ? '已显示变量区'
          : '已隐藏变量区，内存网格可用高度更大');
      });
    }
  }

  /* ---------------- 快捷键 ---------------- */
  function bindShortcuts() {
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (BF.Status.helpOpen()) { BF.Status.closeHelp(); return; }
        if (S.running) { BF.Engine.pause(); e.preventDefault(); }
        return;
      }

      /* 字号：Ctrl/⌘ + + / − */
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        BF.Font.inc(1);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === '-' || e.key === '_')) {
        e.preventDefault();
        BF.Font.inc(-1);
        return;
      }

      if (e.key === 'F10') { e.preventDefault(); BF.Engine.step(); return; }
      if (e.key === 'F9') { e.preventDefault(); BF.Engine.undo(); return; }

      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        BF.Engine.run();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        BF.Project.exportProject();
        return;
      }

      /* ↓ ↑ 微调选中单元格的值（输入框内不拦截） */
      var tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        var delta = e.key === 'ArrowUp' ? 1 : -1;
        BF.Memory.setValue(S.sel, (S.tape[S.sel] + delta) & 255);
      }
    });
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    BF.Editor.init();
    BF.Memory.init();
    BF.Console.init();
    BF.Status.init();
    BF.Notes.init();
    BF.Font.init();        /* 界面字号（localStorage 记忆） */

    BF.Project.init();     /* 载入上次进度或示例工程 */
    BF.Panels.init();      /* 面板折叠 / 拖动分栏 */

    bindControls();
    bindShortcuts();

    BF.render();
    d.code.focus();
    d.code.setSelectionRange(0, 0);
    /* 聚焦会把末尾的光标滚进视野，这里拉回顶部 */
    d.code.scrollTop = 0;
    d.code.scrollLeft = 0;
    BF.Editor.syncScroll();
    BF.Editor.renderHighlight(true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window.BF);
