/* =========================================================================
 * core/state.js —— 全局状态与常量
 * 所有模块共享同一个 state 对象，视图从这里读、通过各自 API 写。
 * ========================================================================= */
window.BF = window.BF || {};

(function (BF) {
  'use strict';

  /* 首次打开时的示例工程：Hello World，带断点、命名与文档 */
  BF.DEMO = {
    name: 'Hello World 示例',
    code: [
      '++++++++[>++++[>++>+++>+++>+<<<<-]   ; 先给 2~6 号单元格打底值',
      '>+>+>->>+[<]<-]                      ; 逐个修正为 H e l l o',
      '>>.                                  ; 输出 H',
      '>---.                                ; e',
      '+++++++..+++.                        ; llo',
      '>>.                                  ; 空格',
      '<-.                                  ; W',
      '<.                                   ; o',
      '+++.                                 ; r',
      '------.                              ; l',
      '--------.                            ; d',
      '>>+.                                 ; !',
      '>++.                                 ; 换行'
    ].join('\n'),
    tapeSize: 256,
    speed: 1000,
    cellNames: { 0: '循环计数', 2: 'H', 3: '字母暂存', 4: 'W', 5: '空格', 6: '换行' },
    breakpoints: [3],
    lineNotes: { 1: '第一段：给 2~6 号单元格打底值', 3: '从这里开始逐个字符输出' },
    docs: [
      '示例程序：Hello World!',
      '',
      '内存布局（256 格，0~255 环绕）',
      '  0 号：外层循环计数器，程序跑完归零',
      '  1 号：内层循环辅助',
      '  2 号：字母 H',
      '  3 号：字母暂存（e / l / o / r / d 复用）',
      '  4 号：字母 W',
      '  5 号：空格，随后复用为 !',
      '  6 号：换行符 10',
      '',
      '调试建议',
      '  在第 3 行下断点，单步观察 >>. 前后指针位置与单元格值的对应关系；',
      '  也可以点击内存单元格改名，让上面的布局直接在面板里可见。'
    ].join('\n')
  };

  BF.state = {
    /* 项目 */
    name: '未命名项目',
    code: '',
    docs: '',
    names: {},      /* 地址 -> 名称 */
    bp: new Set(),  /* 断点行号 */
    notes: {},      /* 行号 -> 注释 */

    /* 编译产物：紧凑 TypedArray 指令表，见 core/compiler.js。
       大文件下绝不能用「每条指令一个对象」，几千万条就是几个 GB。 */
    ops: { length: 0, ch: new Uint8Array(0), pos: new Uint32Array(0), line: new Uint32Array(0) },
    jumps: new Map(),
    offsets: new Uint32Array([0]),
    unbalanced: '',

    /* 运行态 */
    tape: new Uint8Array(256),
    ptr: 0,
    pc: 0,
    steps: 0,
    sel: 0,
    input: [],
    out: '',
    speed: 1000,        /* 目标执行速率：指令/秒 */
    mRate: 0,           /* 实测速率：指令/秒 */
    rateT0: 0,
    rateSteps: 0,
    paceT0: 0,          /* 配速锚点：从这个时刻、这一步开始算欠账 */
    paceSteps: 0,
    paceIps: 0,

    running: false,
    paused: false,
    finished: false,
    waiting: false,
    started: false,
    dirty: false,
    error: '',
    bpSkipLine: -1,          /* 从断点继续时，本行不再重复命中 */
    resumeAfterInput: false,

    /* 视图选项（由工具栏勾选，随项目文件保存） */
    bareRun: false,          /* 仅运行：运行中跳过内存 / 代码高亮重绘 */
    follow: false,           /* 跟随：运行时滚动到当前执行位置（默认关闭） */
    showInspector: true,     /* 变量区：内存卡片底部单元格详情（地址/名称/注释/值） */
    cellNotes: {},           /* 单元格完整作用说明：{ index: 文本 } */

    /* 调度句柄 */
    tickKind: null,
    tickHandle: null
  };
})(window.BF);
