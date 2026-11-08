/* =========================================================================
 * tc/parser-asm.js —— NASM 子集 → 中间表示(IR)
 *
 * 支持的写法：
 *   mov al, 65       mov bl, al        inc al      dec al
 *   add al, 3        sub al, bl        putc al     getc al
 *   label:  …  cmp al, 0   jne label        ← 识别成 while (al) { … }
 * 其它指令（section / int 0x80 / syscall 等）会被忽略并给出提示。
 * ========================================================================= */
(function (TC) {
  'use strict';

  var REGS = ['al', 'bl', 'cl', 'dl', 'ah', 'bh', 'ch', 'dh'];
  var IGNORE = ['section', 'global', 'extern', 'bits', 'org', 'default',
                'ret', 'nop', 'push', 'pop', 'leave', 'times'];

  function ParseError(msg, line) { this.message = msg; this.line = line; }

  function isReg(s) { return REGS.indexOf(String(s).toLowerCase()) >= 0; }

  function parseOperand(txt, line) {
    var s = String(txt).trim();
    if (!s) throw new ParseError('缺少操作数', line);

    if (/^'.'$/.test(s) || /^"\\?."$/.test(s)) return { k: 'num', v: s.charAt(1).charCodeAt(0) };
    if (/^-?\d+$/.test(s)) return { k: 'num', v: (parseInt(s, 10) & 255) };
    if (/^0x[0-9a-fA-F]+$/.test(s)) return { k: 'num', v: parseInt(s, 16) & 255 };
    if (isReg(s)) return { k: 'var', name: s.toLowerCase() };

    throw new ParseError('不支持的操作数：' + s, line);
  }

  function parse(src) {
    var raw = src.split(/\r?\n/);
    var items = [];
    var warnings = [];
    var i, line, text, clean, m;

    /* ---------- 逐行切分 ---------- */
    for (i = 0; i < raw.length; i++) {
      line = i + 1;
      text = raw[i];

      /* 去掉 ; 注释（简单处理，够用） */
      clean = text.replace(/;.*$/, '').trim();
      if (!clean) continue;

      /* label: */
      m = clean.match(/^([A-Za-z_.$][\w.$]*)\s*:/);
      if (m) {
        items.push({ kind: 'label', name: m[1], line: line, text: text.trim() });
        clean = clean.slice(m[0].length).trim();
        if (!clean) continue;
      }

      m = clean.match(/^([A-Za-z_.$][\w.$]*)\s*(.*)$/);
      if (!m) continue;

      var op = m[1].toLowerCase();
      var rest = m[2].replace(/;.*$/, '').trim();

      /* 数据定义 / 伪指令：忽略 */
      if (/^(db|dw|dd|dq|equ)$/i.test(rest.split(/\s+/)[0]) || /^[A-Za-z_.$][\w.$]*\s+(db|dw|dd|equ)\b/i.test(clean)) {
        continue;
      }
      if (IGNORE.indexOf(op) >= 0) continue;

      if (op === 'int' || op === 'syscall' || op === 'call') {
        warnings.push({ line: line, message: '系统调用 / 函数调用 ' + op + ' 已忽略（本编译器只处理纯计算指令）' });
        continue;
      }

      var args = rest ? rest.split(',').map(function (s) { return s.trim(); }) : [];
      items.push({ kind: 'ins', op: op, args: args, line: line, text: text.trim() });
    }

    /* ---------- 识别 while 结构：cmp R,0 + jne 自己前面的标签 ---------- */
    var guard = 0;
    while (guard++ < 1000) {
      var done = true;

      for (i = 0; i < items.length; i++) {
        var it = items[i];
        if (it.kind !== 'ins' || (it.op !== 'jne' && it.op !== 'jnz')) continue;

        var target = (it.args[0] || '').trim();
        var j = -1;
        for (var k = i - 1; k >= 0; k--) {
          if (items[k].kind === 'label' && items[k].name === target) { j = k; break; }
        }
        if (j < 0) continue;                       /* 前向跳转，暂不支持 */

        var cmp = items[i - 1];
        if (!cmp || cmp.kind !== 'ins' || cmp.op !== 'cmp') continue;
        if (String(cmp.args[1] || '').trim() !== '0') continue;
        if (!isReg(cmp.args[0])) continue;

        items.splice(j, i - j + 1, {
          kind: 'while',
          reg: String(cmp.args[0]).trim().toLowerCase(),
          body: items.slice(j + 1, i - 1),
          line: items[j].line
        });
        done = false;
        break;
      }

      if (done) break;
    }

    /* ---------- 转 IR ---------- */
    function convert(list) {
      var ir = [];
      list.forEach(function (it) {
        if (it.kind === 'label') return;
        if (it.kind === 'while') {
          ir.push({ type: 'while', cond: it.reg, body: convert(it.body), line: it.line });
          return;
        }

        var a0 = it.args[0];
        var a1 = it.args[1];

        switch (it.op) {
          case 'mov':
            if (!isReg(a0)) { warnings.push({ line: it.line, message: 'mov 的目标必须是寄存器：' + a0 }); return; }
            ir.push({ type: 'set', name: String(a0).toLowerCase(), expr: parseOperand(a1, it.line), line: it.line });
            break;

          case 'inc':
            if (!isReg(a0)) { warnings.push({ line: it.line, message: 'inc 需要寄存器' }); return; }
            ir.push({ type: 'add', name: String(a0).toLowerCase(), expr: { k: 'num', v: 1 }, line: it.line });
            break;

          case 'dec':
            if (!isReg(a0)) { warnings.push({ line: it.line, message: 'dec 需要寄存器' }); return; }
            ir.push({ type: 'sub', name: String(a0).toLowerCase(), expr: { k: 'num', v: 1 }, line: it.line });
            break;

          case 'add':
          case 'sub':
            if (!isReg(a0)) { warnings.push({ line: it.line, message: it.op + ' 需要寄存器' }); return; }
            ir.push({
              type: it.op === 'add' ? 'add' : 'sub',
              name: String(a0).toLowerCase(),
              expr: parseOperand(a1, it.line),
              line: it.line
            });
            break;

          case 'putc':
          case 'putchar':
            if (isReg(a0)) ir.push({ type: 'out', expr: { k: 'var', name: String(a0).toLowerCase() }, line: it.line });
            else ir.push({ type: 'out', expr: parseOperand(a0, it.line), line: it.line });
            break;

          case 'getc':
            if (isReg(a0)) ir.push({ type: 'in', name: String(a0).toLowerCase(), line: it.line });
            break;

          case 'cmp':
            warnings.push({ line: it.line, message: 'cmp 只支持配合 jne 形成循环，已忽略' });
            break;

          case 'jmp':
          case 'je':
          case 'jz':
            warnings.push({ line: it.line, message: it.op + ' 暂不支持（只识别 cmp/jne 循环）' });
            break;

          default:
            warnings.push({ line: it.line, message: '指令 ' + it.op + ' 已忽略' });
        }
      });
      return ir;
    }

    return { ir: convert(items), warnings: warnings };
  }

  TC.ParserAsm = { parse: parse, ParseError: ParseError };
})(window.TC = window.TC || {});
