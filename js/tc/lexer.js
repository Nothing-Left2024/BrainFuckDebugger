/* =========================================================================
 * tc/lexer.js —— C / C++ 词法分析
 * 输出扁平 token 数组，附带行号；注释与 # 预处理行在词法阶段直接丢弃。
 * ========================================================================= */
(function (TC) {
  'use strict';

  /* 长的写在前面，保证最长匹配 */
  var OPS = ['<<=', '>>=', '...', '<<', '>>', '<=', '>=', '==', '!=',
             '++', '--', '+=', '-=', '*=', '/=', '%=', '^=', '&=', '|=',
             '&&', '||', '::', '->'];

  var SINGLE = '+-*/%=<>!&|(){}[];,.?:~^';

  function isIdStart(c) { return /[A-Za-z_$]/.test(c); }
  function isIdChar(c) { return /[A-Za-z0-9_$]/.test(c); }
  function isDigit(c) { return c >= '0' && c <= '9'; }

  function readEscape(src, i) {
    /* src[i] 是反斜杠后的字符，返回 {ch, len} */
    var c = src.charAt(i);
    switch (c) {
      case 'n': return { ch: '\n', len: 1 };
      case 't': return { ch: '\t', len: 1 };
      case 'r': return { ch: '\r', len: 1 };
      case '0': return { ch: '\0', len: 1 };
      case '\\': return { ch: '\\', len: 1 };
      case '"': return { ch: '"', len: 1 };
      case "'": return { ch: "'", len: 1 };
      case 'x': {
        var hex = src.substr(i + 1, 2).match(/^[0-9a-fA-F]+/);
        if (hex) return { ch: String.fromCharCode(parseInt(hex[0], 16)), len: 1 + hex[0].length };
        return { ch: 'x', len: 1 };
      }
      default: return { ch: c, len: 1 };
    }
  }

  function lex(src) {
    var toks = [];
    var i = 0;
    var line = 1;
    var n = src.length;
    var lineStart = true;
    var c, s, j, op, matched, str, code;

    while (i < n) {
      c = src.charAt(i);

      if (c === '\n') { line++; i++; lineStart = true; continue; }
      if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }

      /* 预处理指令：整行跳过 */
      if (c === '#' && lineStart) {
        while (i < n && src.charAt(i) !== '\n') i++;
        continue;
      }
      lineStart = false;

      /* 注释 */
      if (c === '/' && src.charAt(i + 1) === '/') {
        while (i < n && src.charAt(i) !== '\n') i++;
        continue;
      }
      if (c === '/' && src.charAt(i + 1) === '*') {
        i += 2;
        while (i < n && !(src.charAt(i) === '*' && src.charAt(i + 1) === '/')) {
          if (src.charAt(i) === '\n') line++;
          i++;
        }
        i += 2;
        continue;
      }

      /* 字符串 */
      if (c === '"') {
        i++;
        str = '';
        while (i < n && src.charAt(i) !== '"') {
          if (src.charAt(i) === '\\') {
            var esc = readEscape(src, i + 1);
            str += esc.ch;
            i += 1 + esc.len;
          } else {
            if (src.charAt(i) === '\n') line++;
            str += src.charAt(i);
            i++;
          }
        }
        i++;
        toks.push({ t: 'str', v: str, line: line });
        continue;
      }

      /* 字符常量 */
      if (c === "'") {
        i++;
        code = 0;
        if (src.charAt(i) === '\\') {
          var e2 = readEscape(src, i + 1);
          code = e2.ch.charCodeAt(0);
          i += 1 + e2.len;
        } else {
          code = src.charAt(i).charCodeAt(0);
          i++;
        }
        while (i < n && src.charAt(i) !== "'") i++;
        i++;
        /* ch: 标记这是字符字面量，输出时按字符而不是十进制数字 */
        toks.push({ t: 'num', v: code, ch: true, line: line });
        continue;
      }

      /* 浮点字面量（.5 / 1.5 / 1e3 / 2.5f）：用「放大 1000 倍的整数」表示，
         即 3 位小数定点数，交给 parser 转成 int32 常量。
         先处理 .5 这种以小数点开头的写法（否则会被当成成员访问的点号）。 */
      if (c === '.' && isDigit(src.charAt(i + 1))) {
        s = i;
        i++;
        while (i < n && isDigit(src.charAt(i))) i++;
        if (src.charAt(i) === 'e' || src.charAt(i) === 'E') {
          var q2 = i + 1;
          if (src.charAt(q2) === '+' || src.charAt(q2) === '-') q2++;
          if (isDigit(src.charAt(q2))) { i = q2; while (i < n && isDigit(src.charAt(i))) i++; }
        }
        while (i < n && /[fFlL]/.test(src.charAt(i))) i++;
        var fv0 = parseFloat(src.slice(s, i));
        var sc0 = Math.round(fv0 * 1000);
        toks.push({ t: 'num', fval: fv0, f: true, line: line, v: sc0 & 255, raw: sc0 });
        continue;
      }

      /* 数字：支持 0x 十六进制、十进制、浮点，以及 u/U/l/L/LL/ULL/z/f 等后缀。
         BrainFuck 单元格是 8 位，所以 64 位常量（如 0x9E3779B97F4A7C15ULL）
         精确取低 8 位；用 BigInt 解析避免 parseInt 在大数上丢低位，
         同时记一个 big 标记，让 parser 提醒「已按 8 位截断」。 */
      if (isDigit(c)) {
        s = i;
        var base = 10, digits, full = 0n;
        if (c === '0' && (src.charAt(i + 1) === 'x' || src.charAt(i + 1) === 'X')) {
          i += 2;
          s = i;
          while (i < n && /[0-9a-fA-F]/.test(src.charAt(i))) i++;
          digits = src.slice(s, i);
          base = 16;
          try { full = BigInt('0x' + digits); } catch (e) { full = 0n; }
          while (i < n && /[uUlLzZ]/.test(src.charAt(i))) i++;
          toks.push({ t: 'num', v: Number(full & 255n), raw: Number(full & 0xFFFFFFFFn),
                      big: full > 255n, big64: full > 4294967295n, line: line });
          continue;
        }
        while (i < n && isDigit(src.charAt(i))) i++;
        digits = src.slice(s, i);
        var isFlt = false;
        if (src.charAt(i) === '.' && isDigit(src.charAt(i + 1))) {
          isFlt = true;
          i++;
          while (i < n && isDigit(src.charAt(i))) i++;
        }
        if (src.charAt(i) === 'e' || src.charAt(i) === 'E') {
          var q3 = i + 1;
          if (src.charAt(q3) === '+' || src.charAt(q3) === '-') q3++;
          if (isDigit(src.charAt(q3))) {
            isFlt = true;
            i = q3;
            while (i < n && isDigit(src.charAt(i))) i++;
          }
        }
        while (i < n && /[uUlLzZfF]/.test(src.charAt(i))) {
          if (/[fF]/.test(src.charAt(i))) isFlt = true;
          i++;
        }
        if (isFlt) {
          var fv = parseFloat(src.slice(s, i));
          var scaled = Math.round(fv * 1000);
          toks.push({ t: 'num', fval: fv, f: true, line: line,
                      v: scaled & 255, raw: scaled });
          continue;
        }
        try { full = BigInt(digits); } catch (e) { full = 0n; }
        /* raw 保留 32 位原值：int32 常量（含负数）需要精确值，
           而普通 8 位路径继续用 v（低 8 位），互不影响。 */
        toks.push({ t: 'num', v: Number(full & 255n), raw: Number(full & 0xFFFFFFFFn),
                    big: full > 255n, big64: full > 4294967295n, line: line });
        continue;
      }

      /* 标识符 / 关键字 */
      if (isIdStart(c)) {
        s = i;
        while (i < n && isIdChar(src.charAt(i))) i++;
        toks.push({ t: 'id', v: src.slice(s, i), line: line });
        continue;
      }

      /* 运算符 */
      matched = null;
      for (j = 0; j < OPS.length; j++) {
        op = OPS[j];
        if (src.substr(i, op.length) === op) { matched = op; break; }
      }
      if (!matched && SINGLE.indexOf(c) >= 0) matched = c;

      if (matched) {
        toks.push({ t: 'op', v: matched, line: line });
        i += matched.length;
      } else {
        /* 未知字符，跳过 */
        i++;
      }
    }

    toks.push({ t: 'eof', v: '', line: line });
    return toks;
  }

  TC.Lexer = { lex: lex };
})(window.TC = window.TC || {});
