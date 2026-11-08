/* =========================================================================
 * ui/dom.js —— DOM 引用
 * 页面脚本以 defer 加载，执行时 DOM 已解析完成，可在此一次性缓存节点。
 * ========================================================================= */
(function (BF) {
  'use strict';

  function id(name) { return document.getElementById(name); }

  BF.$ = id;

  BF.dom = {
    /* 顶栏 */
    projName: id('projName'),
    btnNew: id('btnNew'),
    btnImport: id('btnImport'),
    btnExport: id('btnExport'),
    exportMenu: id('exportMenu'),
    btnHelp: id('btnHelp'),
    fileInput: id('fileInput'),

    /* 字号 */
    fontDec: id('fontDec'),
    fontInc: id('fontInc'),
    fontVal: id('fontVal'),

    /* 编辑器 */
    editor: id('editor'),
    code: id('code'),
    hl: id('hl'),
    gutter: id('gutter'),
    gutterInner: id('gutterInner'),
    codeStat: id('codeStat'),
    btnClearBp: id('btnClearBp'),

    /* 注释 / 文档 */
    noteInput: id('noteInput'),
    noteLabel: id('noteLabel'),
    noteList: id('noteList'),
    noteCount: id('noteCount'),
    tabNotes: id('tabNotes'),
    tabDocs: id('tabDocs'),
    docs: id('docs'),

    /* 内存 */
    memGrid: id('memGrid'),
    memScroll: id('memScroll'),
    tapeSize: id('tapeSize'),
    btnClearMem: id('btnClearMem'),
    ptrChip: id('ptrChip'),
    inspIdx: id('inspIdx'),
    inspector: id('inspector'),
    inspVal: id('inspVal'),
    inspMeta: id('inspMeta'),
    inspName: id('inspName'),
    inspNote: id('inspNote'),
    inspValue: id('inspValue'),
    valInc: id('valInc'),
    valDec: id('valDec'),
    btnGoto: id('btnGoto'),

    /* 输出 */
    out: id('out'),
    outLen: id('outLen'),
    inInput: id('inInput'),
    btnSend: id('btnSend'),
    btnClearOut: id('btnClearOut'),

    /* 状态栏 */
    statusPill: id('statusPill'),
    stPtr: id('stPtr'),
    stPc: id('stPc'),
    stTotal: id('stTotal'),
    stSteps: id('stSteps'),
    stLine: id('stLine'),
    stCol: id('stCol'),
    stErrWrap: id('stErrWrap'),
    stErr: id('stErr'),
    speed: id('speed'),
    speedLabel: id('speedLabel'),
    speedActual: id('speedActual'),
    speedPresets: id('speedPresets'),

    /* 控制 */
    btnRun: id('btnRun'),
    btnPause: id('btnPause'),
    btnStep: id('btnStep'),
    btnUndo: id('btnUndo'),
    btnReset: id('btnReset'),
    optBareRun: id('optBareRun'),
    optFollow: id('optFollow'),
    optInspector: id('optInspector'),

    /* 覆盖层 */
    toastWrap: id('toastWrap'),
    helpOverlay: id('helpOverlay'),
    btnCloseHelp: id('btnCloseHelp')
  };
})(window.BF);
