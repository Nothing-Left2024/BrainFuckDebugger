/* =========================================================================
 * tc/opt.js —— 编译期优化：常量传播 / 死代码消除
 *
 * 在 IR 层（int32 / string 降级之前）做三件事，直接决定生成多少 BrainFuck：
 *
 *   1. 常量传播 + 折叠
 *        int32 a = 1, b;  cin >> b;  b = 1;  cout << a + b;
 *      被改写成  cout << 2;  ——「a」「b」两个变量整个消失。
 *      8 位 / int32 / float 三种宽度分开算：8 位按 256 回绕，int32 按 32 位
 *      补码（Math.imul 取低 32 位），float 就是放大 1000 倍的定点数。
 *
 *   2. 死输入消除
 *      读进来的值在「任何使用之前」就被无条件覆盖时，这次读取没有意义，
 *      连同前面那串「跳过空白 / 逐位累加」的代码一起删掉。
 *      只在一个基本块内、且中间没有任何分支 / 循环 / 输出时判定，避免误删
 *      那些会影响输入的读取。
 *
 *   3. 常量输出内联
 *      输出常量时不再生成「长除法拆位 + 逐位输出」那一大坨（int32 一次
 *      printf("%d") 约 15 万条指令），直接改成一条 outstr。
 *
 * 保守原则：控制流（if / while / 函数调用）之后一律把相关变量标成未知，
 * 宁可不优化，也不改变程序语义。
 * ========================================================================= */
(function (TC) {
  'use strict';

  var UNKNOWN = null;

  function toByte(v) { return ((v | 0) % 256 + 256) % 256; }
  function imul(a, b) {
    if (Math.imul) return Math.imul(a, b);
    return (a * b) | 0;
  }
  function truncDiv(a, b) { return b === 0 ? 0 : (a / b) | 0; }

  function numOf(e) {
    return e.i32v != null ? e.i32v : (e.raw != null ? e.raw : e.v);
  }

  function kindOfType(k) {
    if (k === 'i32') return 'i32';
    if (k === 'f32') return 'f32';
    return 'byte';
  }

  /* ---------------- 表达式求值 ----------------
     wide 表示「这一段按 32 位算」：int32 / float 字面量与变量都是 32 位，
     8 位变量仍是 0..255。返回 { v, kind } 或 null（未知）。 */
  function evalExpr(e, env, wide) {
    if (!e) return null;
    var a, b, t, w, kind;

    switch (e.k) {
      case 'num': {
        var raw = numOf(e);
        if (e.f) return { v: raw | 0, kind: 'f32' };
        return wide ? { v: raw | 0, kind: 'i32' } : { v: toByte(raw), kind: 'byte' };
      }

      case 'var': {
        var c = env[e.name];
        if (!c) return null;
        return { v: c.v, kind: c.kind };
      }

      case 'bin':
      case 'mul':
      case 'div':
      case 'mod': {
        a = evalExpr(e.a, env, wide);
        b = evalExpr(e.b, env, wide);
        if (!a || !b) return null;
        /* 有一侧是 32 位 / 定点数时，另一侧的字面量也要按 32 位重新读一遍
           （否则 7.9 → 7900，而除数 1000 会被当成 8 位的 232） */
        if (!wide && (a.kind !== 'byte' || b.kind !== 'byte')) {
          a = evalExpr(e.a, env, true);
          b = evalExpr(e.b, env, true);
        }
        kind = (a.kind === 'f32' || b.kind === 'f32') ? 'f32'
             : (wide || a.kind === 'i32' || b.kind === 'i32') ? 'i32' : 'byte';
        w = (kind !== 'byte');

        if (e.k === 'mul') {
          t = imul(a.v, b.v);
        } else if (e.k === 'div') {
          t = b.v === 0 ? 0 : truncDiv(a.v, b.v);
        } else if (e.k === 'mod') {
          t = b.v === 0 ? 0 : (a.v % b.v) | 0;
        } else if (e.op === '+') {
          t = (a.v + b.v) | 0;
        } else {
          t = (a.v - b.v) | 0;
        }
        return { v: w ? (t | 0) : toByte(t), kind: kind };
      }

      case 'cmp': {
        a = evalExpr(e.a, env, wide);
        b = evalExpr(e.b, env, wide);
        if (!a || !b) return null;
        var r;
        switch (e.op) {
          case '<': r = a.v < b.v; break;
          case '>': r = a.v > b.v; break;
          case '<=': r = a.v <= b.v; break;
          case '>=': r = a.v >= b.v; break;
          case '==': r = a.v === b.v; break;
          default: r = a.v !== b.v; break;
        }
        return { v: r ? 1 : 0, kind: 'byte' };
      }

      case 'and': case 'or': {
        a = evalExpr(e.a, env, wide);
        b = evalExpr(e.b, env, wide);
        if (!a || !b) return null;
        return { v: (e.k === 'and' ? (a.v && b.v) : (a.v || b.v)) ? 1 : 0, kind: 'byte' };
      }

      case 'not': {
        a = evalExpr(e.a, env, wide);
        if (!a) return null;
        return { v: a.v ? 0 : 1, kind: 'byte' };
      }

      default:
        return null;
    }
  }

  function constNode(c, line) {
    var v = c.v | 0;
    if (c.kind === 'f32') return { k: 'num', v: v & 255, i32v: v, raw: v, f: 1, line: line };
    if (c.kind === 'i32') return { k: 'num', v: v & 255, i32v: v, raw: v, line: line };
    return { k: 'num', v: v & 255, raw: v & 255, line: line };
  }

  var EXPR_KINDS = { bin: 1, mul: 1, div: 1, mod: 1, cmp: 1, and: 1, or: 1, not: 1 };

  /* 递归折叠：先把子节点折叠（含变量替换成常量），再整体求值 */
  function foldExpr(e, env, wide) {
    if (!e) return e;
    /* 字面量原样保留：8 位 / int32 的读法取决于上下文，
       这里擅自截成低 8 位会把 1000 变成 232，让 b == 1000 变成 b == 232 */
    if (e.k === 'num') return e;
    if (e.k === 'var') {
      var cv = evalExpr(e, env, wide);
      return cv ? constNode(cv, e.line) : e;
    }
    if (!EXPR_KINDS[e.k]) return e;

    /* 先判断这一段要不要按 32 位算：单侧是 int32 / float 时，另一侧的字面量
       也必须按 32 位解释（7.9 / 1000 里的 1000 不能被截成 232） */
    var va = e.a ? evalExpr(e.a, env, wide) : null;
    var vb = e.b ? evalExpr(e.b, env, wide) : null;
    var useWide = wide || (va && va.kind !== 'byte') || (vb && vb.kind !== 'byte');

    var a = e.a ? foldExpr(e.a, env, useWide) : null;
    var b = e.b ? foldExpr(e.b, env, useWide) : null;
    var node = { k: e.k, op: e.op, a: a, b: b, line: e.line };
    if (e.f) node.f = e.f;

    var val = evalExpr(node, env, useWide);
    if (val) return constNode(val, e.line);
    return node;
  }

  /* ---------------- 变量读写分析 ---------------- */
  function addVars(e, set) {
    if (!e || typeof e !== 'object') return;
    if (e.k === 'var') { set[e.name] = 1; return; }
    /* std::string 的节点用 base 指向变量名（slen / sidx / scat …） */
    if (e.base) set[e.base] = 1;
    addVars(e.a, set);
    addVars(e.b, set);
    addVars(e.idx, set);
    addVars(e.pos, set);
    addVars(e.len, set);
    /* string(n, ch) 的 srep 节点：漏掉 n 会让 `int n=4` 被当成
       只写不读的死存储删掉，运行期循环次数直接变 0。 */
    addVars(e.n, set);
    addVars(e.ch, set);
  }

  function walk(list, fn) {
    (list || []).forEach(function (n) {
      if (!n) return;
      fn(n);
      if (n.then) walk(n.then, fn);
      if (n.else) walk(n.else, fn);
      if (n.body) walk(n.body, fn);
    });
  }

  /* 某个语句树里被写入的变量（控制流后要把它们标成未知） */
  function assignedIn(list, set) {
    walk(list, function (n) {
      if (n.type === 'decl' || n.type === 'set' || n.type === 'add' ||
          n.type === 'sub' || n.type === 'in' || n.type === 'innum' ||
          n.type === 'callset' || n.type === 'sin' || n.type === 'sset' ||
          n.type === 'sapp' || n.type === 'sclear' || n.type === 'spop' ||
          n.type === 'spush' || n.type === 'sidxset') {
        if (n.name) set[n.name] = 1;
      }
    });
    return set;
  }

  /* ---------------- 8 位 / 定点数的十进制文本 ---------------- */
  function fmtFloat(scaled, dec) {
    dec = dec == null ? 3 : dec;
    var neg = scaled < 0;
    var v = Math.abs(scaled | 0);
    var unit = Math.pow(10, dec);
    var ip = Math.floor(v / unit);
    var fp = v - ip * unit;
    var fs = String(fp);
    while (fs.length < dec) fs = '0' + fs;
    fs = fs.replace(/0+$/, '');
    return (neg ? '-' : '') + String(ip) + (fs ? '.' + fs : '');
  }

  /* ---------------- 单条语句的优化 ---------------- */
  /* 返回 { list }（可能展开成多条），null 表示删掉 */
  /* 分支 / 循环的子环境必须是「平铺的浅拷贝」，不能用 Object.create(env)。
     原型链下 `delete envT[x]` 删不掉父环境里的 x，foldExpr 仍会顺着原型链
     读到旧常量 —— 典型事故：int a=0; if(c){cin>>a; r=a+1;} 里 r 被折成 1。 */
  function childEnv(env) {
    var c = Object.create(null);
    for (var k in env) c[k] = env[k];
    return c;
  }

  function optNode(n, env, ctx) {
    var line = n.line || 1;
    var wide, v;

    switch (n.type) {
      case 'decl': {
        wide = (n.kind === 'i32' || n.kind === 'f32');
        var init = n.init ? foldExpr(n.init, env, wide) : null;
        var dn = { type: 'decl', name: n.name, init: init, kind: n.kind, line: line, text: n.text };
        var kk = kindOfType(n.kind);
        if (init && init.k === 'num') {
          env[n.name] = { v: numOf(init), kind: kk };
        } else {
          delete env[n.name];
        }
        return { list: [dn] };
      }

      case 'set': case 'add': case 'sub': {
        wide = (ctx.kindOf(n.name) === 'i32' || ctx.kindOf(n.name) === 'f32');
        var ex = foldExpr(n.expr, env, wide);
        var kindName = kindOfType(ctx.kindOf(n.name));

        /* x = 常量 直接记进环境 */
        if (n.type === 'set') {
          if (ex && ex.k === 'num') env[n.name] = { v: numOf(ex), kind: kindName };
          else delete env[n.name];
          return { list: [{ type: 'set', name: n.name, expr: ex, line: line, text: n.text }] };
        }

        /* x += 常量 / x -= 常量：已知 x 就折成一条赋值 */
        var cur = env[n.name];
        if (ex && ex.k === 'num' && cur) {
          var delta = numOf(ex);
          var nv = n.type === 'add' ? (cur.v + delta) | 0 : (cur.v - delta) | 0;
          if (kindName === 'byte') nv = toByte(nv);
          var cnst = constNode({ v: nv, kind: kindName === 'byte' ? 'byte' : kindName }, line);
          env[n.name] = { v: numOf(cnst), kind: kindName };
          return { list: [{ type: 'set', name: n.name, expr: cnst, line: line, text: n.text }] };
        }
        delete env[n.name];
        return { list: [{ type: n.type, name: n.name, expr: ex, line: line, text: n.text }] };
      }

      case 'in': case 'innum': {
        env[n.name] = undefined;                 /* 遮蔽原型链上的旧常量 */
        delete env[n.name];
        var rn = { type: n.type, name: n.name, line: line, text: n.text };
        if (n.skipSpace) rn.skipSpace = 1;
        if (n.dec) rn.dec = n.dec;
        return { list: [rn] };
      }

      case 'outdec': {
        var oe = foldExpr(n.expr, env, true);
        var hasSc = n.scale != null;
        var sc = hasSc ? n.scale : 0;
        if (oe.k === 'num') {
          var val = numOf(oe);
          var text = (oe.f || hasSc) ? fmtFloat(val, sc) : String(val | 0);
          return { list: [{ type: 'outstr', text: text, line: line }] };
        }
        var on = { type: 'outdec', expr: oe, line: line, text: n.text };
        if (hasSc) on.scale = sc;
        return { list: [on] };
      }

      case 'out': {
        var ce = foldExpr(n.expr, env, false);
        if (ce.k === 'num' && numOf(ce) >= 0 && numOf(ce) < 128) {
          return { list: [{ type: 'outstr', text: String.fromCharCode(numOf(ce)), line: line }] };
        }
        return { list: [{ type: 'out', expr: ce, line: line, text: n.text }] };
      }

      case 'if': {
        var cond = foldExpr(n.cond, env, false);
        if (cond.k === 'num') {
          var branch = numOf(cond) ? n.then : n.else;
          return { list: optList(branch || [], env, ctx) };
        }
        var envT = childEnv(env);
        var thenL = optList(n.then || [], envT, ctx);
        var envE = childEnv(env);
        var elseL = n.else ? optList(n.else, envE, ctx) : null;
        var touched = assignedIn(n.then || [], {});
        if (n.else) assignedIn(n.else, touched);
        Object.keys(touched).forEach(function (k) { delete env[k]; });
        return { list: [{ type: 'if', cond: cond, then: thenL, else: elseL,
                          line: line, text: n.text }] };
      }

      case 'while': {
        /* 循环条件每一轮都会重算：循环体里改过的变量不能当常量代入，
           否则 while (cnt) 会被折成 while (1) 变成死循环。 */
        var touchedB = assignedIn(n.body || {}, {});
        var envB = childEnv(env);
        Object.keys(touchedB).forEach(function (k) { delete envB[k]; delete env[k]; });
        var wc = foldExpr(n.cond, env, false);
        if (wc.k === 'num' && !numOf(wc)) return { list: [] };
        var bodyL = optList(n.body || [], envB, ctx);
        Object.keys(touchedB).forEach(function (k) { delete env[k]; });
        return { list: [{ type: 'while', cond: wc, body: bodyL, line: line, text: n.text }] };
      }

      case 'call': case 'callset': {
        var args = (n.args || []).map(function (a) { return foldExpr(a, env, true); });
        /* 函数体可能改全局变量：保守起见全部当未知 */
        Object.keys(env).forEach(function (k) { delete env[k]; });
        return { list: [{ type: n.type, target: n.target, fn: n.fn, args: args,
                          line: line, text: n.text }] };
      }

      case 'ret': {
        return { list: [{ type: 'ret', expr: foldExpr(n.expr, env, false), line: line, text: n.text }] };
      }

      default:
        return { list: [n] };
    }
  }

  /* ---------------- 列表级优化 ---------------- */
  function optList(list, env, ctx) {
    var out = [];
    var i, n;

    for (i = 0; i < list.length; i++) {
      n = list[i];
      if (!n) continue;

      /* 死输入：这次读取的值在任何使用之前就被整块覆盖了 */
      if ((n.type === 'in' || n.type === 'innum') && killedBeforeUse(list, i, n.name)) {
        delete env[n.name];
        ctx.deadInputs = (ctx.deadInputs || 0) + 1;
        continue;
      }

      var r = optNode(n, env, ctx);
      if (r && r.list && r.list.length) {
        /* 相邻的字符串输出合并成一条：printf("a"); printf("b") 或折叠出来的
           多个常量输出，合成一段只需走一次「加到位 → 打 → 回 0」 */
        for (var k = 0; k < r.list.length; k++) {
          var x = r.list[k];
          var prev = out[out.length - 1];
          if (x && x.type === 'outstr' && prev && prev.type === 'outstr') {
            prev.text = (prev.text || '') + (x.text || '');
            continue;
          }
          out.push(x);
        }
      }
    }
    return out;
  }

  /* list[i] 读的变量，是否在「连着的一串纯赋值」里被覆盖、且中间没被读。
     只要中间出现分支 / 循环 / 输出 / 另一次输入，就一律放弃 —— 删掉一次读取
     会让后面的输入错位，那不是「优化」而是改语义。 */
  function killedBeforeUse(list, i, name) {
    for (var j = i + 1; j < list.length; j++) {
      var n = list[j];
      if (!n) continue;
      if (n.type === 'set' || n.type === 'decl') {
        if (usesVar(n.expr || n.init, name)) return false;
        if (n.name === name) {
          if (n.type === 'decl' && !n.init) continue;    /* 只声明，不写入 */
          return true;
        }
        continue;
      }
      if (n.type === 'add' || n.type === 'sub') {
        if (n.name === name) return false;               /* x += k 依赖旧值 */
        continue;
      }
      return false;
    }
    return false;
  }

  function usesVar(e, name) {
    if (!e || typeof e !== 'object') return false;
    if (e.k === 'var') return e.name === name;
    return usesVar(e.a, name) || usesVar(e.b, name) ||
           usesVar(e.idx, name) || usesVar(e.pos, name) || usesVar(e.len, name);
  }

  /* 死存储消除 */
  function collectReads(list, reads) {
    walk(list, function (n) {
      if (n.expr) addVars(n.expr, reads);
      if (n.cond) addVars(n.cond, reads);
      if (n.init) addVars(n.init, reads);
      if (n.args) n.args.forEach(function (a) { addVars(a, reads); });
      /* 名称不参与表达式求值的节点（字符串 / 输入 / 方法调用）同样需要变量存在 */
      if (n.name && n.type !== 'decl' && n.type !== 'set' && n.type !== 'add' &&
          n.type !== 'sub' && n.type !== 'in' && n.type !== 'innum') {
        reads[n.name] = 1;
      }
      if (n.base) reads[n.base] = 1;      /* 字符串节点（sout / sclear / spush …） */
    });
    return reads;
  }

  /* 这一段代码里自己声明的名字（含数组元素）。只有它们才可以按「只写不读」删掉：
     函数体里给全局变量赋值是有副作用的，全局变量的 decl 不在函数体里 ——
     之前正是这里误删了「函数内写全局数组」的语句。 */
  function collectDecls(list, set) {
    walk(list, function (n) {
      if (n.type === 'decl' && n.name) set[n.name] = 1;
    });
    return set;
  }

  function prune(list, reads, locals, keep) {
    var out = [], changed = false;
    (list || []).forEach(function (n) {
      if (!n) return;
      if ((n.type === 'decl' || n.type === 'set' || n.type === 'add' || n.type === 'sub') &&
          n.name && !reads[n.name] && n.name.indexOf('__') !== 0 &&
          (!keep || !keep[n.name]) &&
          (!locals || locals[n.name])) {
        changed = true;
        return;                                   /* 只写不读：整条删掉 */
      }
      if (n.then) { var t = prune(n.then, reads, locals, keep); if (t !== n.then) { n.then = t; changed = true; } }
      if (n.else) { var e2 = prune(n.else, reads, locals, keep); if (e2 !== n.else) { n.else = e2; changed = true; } }
      if (n.body) { var b = prune(n.body, reads, locals, keep); if (b !== n.body) { n.body = b; changed = true; } }
      out.push(n);
    });
    return changed ? out : list;
  }

  /* 函数体里读写的全局名字。主 IR 与函数体是分两次优化的，如果只看主 IR，
     `int a[3] = {4,8,15};` 里的初始化赋值在「本段没有任何读取」时会被当成
     死存储删掉 —— 而真正的读取发生在函数体里（`int f(int i){ return a[i]; }`），
     于是运行时 a[0] 永远是 0。所以主 IR 的 prune 必须保护这些名字。 */
  function globalsUsed(funcs) {
    var set = Object.create(null);
    Object.keys(funcs || {}).forEach(function (k) {
      var fn = funcs[k];
      if (!fn || !fn.body) return;
      var own = collectDecls(fn.body, Object.create(null));
      walk(fn.body, function (n) {
        if (n.expr) addVars(n.expr, set);
        if (n.cond) addVars(n.cond, set);
        if (n.init) addVars(n.init, set);
        if (n.args) n.args.forEach(function (a) { addVars(a, set); });
        if (n.name) set[n.name] = 1;
        if (n.base) set[n.base] = 1;
      });
      /* 函数自己的局部名在主 IR 里不存在，排除掉以免同名全局被无辜保护 */
      Object.keys(own).forEach(function (nm2) { delete set[nm2]; });
    });
    return set;
  }

  /* ---------------- 入口 ---------------- */
  function run(ir, varType, warnings, keep) {
    var ctx = {
      kindOf: function (name) { return (varType && varType[name]) || 'int'; }
    };
    var out = optList(ir, Object.create(null), ctx);
    var locals = collectDecls(ir, Object.create(null));

    for (var round = 0; round < 6; round++) {
      var reads = collectReads(out, Object.create(null));
      var next = prune(out, reads, locals, keep);
      if (next === out) break;
      out = next;
      /* 死存储删完后可能又出现新的常量赋值可折，再折一轮 */
      out = optList(out, Object.create(null), ctx);
    }
    return out;
  }

  TC.Opt = { run: run, foldExpr: foldExpr, evalExpr: evalExpr, fmtFloat: fmtFloat,
             globalsUsed: globalsUsed };
})(window.TC = window.TC || {});
