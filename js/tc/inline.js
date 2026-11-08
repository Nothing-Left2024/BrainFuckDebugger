/* =========================================================================
 * tc/inline.js —— 函数调用展开（BrainFuck 没有调用栈，只能内联）
 *
 * 做法：
 *   1. 每个调用点分配一个序号，形参与“函数内声明的局部变量”统一改名成
 *      __函数名<序号>_原名，于是同一个函数调多少次都有各自独立的单元格；
 *   2. 函数里用到、但没有在本函数声明过的名字（全局变量）不改名，直接共用；
 *   3. return expr 变成“给返回值单元格赋值”。为了支持
 *          if (x) { return a; }  return b;
 *      这种常见写法，函数体里会多一个“继续执行标志”：return 之后把它清零，
 *      后面所有语句都包一层 if (标志)，于是不会再被覆盖；
 *   4. 循环体里的 return 同样支持：循环条件变成「标志 && 原条件」，
 *      标志一清零本层循环连同外层循环一起退出（BF 没有跳转指令，
 *      但「条件 + 标志」等价于跳出）；
 *   5. main 里的 return 表示“程序到此结束”：用同样的标志改写整段入口代码；
 *   6. 调用链里再次出现同一个函数 —— 递归 —— 直接报错（无法在 BF 里展开）。
 * ========================================================================= */
(function (TC) {
  'use strict';

  /* 递归只能静态展开：层数与总调用次数都给个上限，避免代码量爆炸 */
  var MAX_DEPTH = 12;      /* 默认每个函数最多展开几层（可在页面上调） */
  var MAX_CALLS = 900;     /* 所有调用点展开后的总次数上限 */

  /* 数一数函数体里有几处调用自己 —— 2 处就是“树状递归”，层数必须小得多 */
  function recSites(nodes, name) {
    var n = 0;
    (nodes || []).forEach(function (s) {
      if (!s) return;
      if ((s.type === 'call' || s.type === 'callset') && s.fn === name) { n++; return; }
      if (s.type === 'if') { n += recSites(s.then, name); n += recSites(s.else, name); }
      if (s.type === 'while') n += recSites(s.body, name);
    });
    return n;
  }

  function depthCapOf(fn, base, line) {
    var k = recSites(fn.body, fn.name);
    if (k >= 2) {
      /* 树状递归：静态展开是按层复制代码，k 处自调用 → 层数翻倍增长，
         几层就是几十万条指令，BrainFuck 里完全不现实 */
      throw {
        message: '函数 ' + fn.name + ' 里有 ' + k + ' 处调用自己（树状递归，如斐波那契），' +
                 '静态展开的代码量会按层数指数增长，BrainFuck 装不下。请改成循环，或改成每层只有一处自调用的线性递归',
        line: line || 1
      };
    }
    return base;
  }

  function has(obj, k) { return Object.prototype.hasOwnProperty.call(obj, k); }

  /* 「真·全局变量」白名单：所有调用点必须共用同一个单元格，绝不按调用点改名。
     最典型的是标准库的随机数种子 __bf_seed —— 一旦被改名，srand() 写进
     __srand0___bf_seed、rand() 却读 __rand0___bf_seed（初值 0），随机数就永远
     停在第一个值上，猜数字每局答案自然一模一样。
     注意与「函数内部 __ 开头的临时变量」区分：后者恰恰必须按调用点分开，
     否则递归各层会互相踩。
     compiler.html 里 stdlib.js 排在 inline.js 之前加载，库模块无法在装载期注册，
     所以这里内置已知名单兜底；TC.Inline.share() 供后续扩展在编译期追加。 */
  var SHARED = { __bf_seed: 1 };
  function share(name) { SHARED[name] = 1; }

  /* 改名：函数自己的名字按调用点加前缀；全局变量保持原名（函数才能读写全局） */
  function nm(map, name) {
    if (SHARED[name]) return name;
    if (has(map, name)) return map[name];
    /* 编译器生成的临时名（__cr0 / __n1 …）也按调用点分开，否则递归时各层会互相踩 */
    if (map.__prefix && name.lastIndexOf('__', 0) === 0) {
      map[name] = map.__prefix + name;
      return map[name];
    }
    return name;
  }

  /* ---------- 表达式改名 ---------- */
  function rn(e, map) {
    if (!e) return null;
    switch (e.k) {
      case 'num':
        return { k: 'num', v: e.v, ch: e.ch, line: e.line };
      case 'var':
        return { k: 'var', name: nm(map, e.name), line: e.line };
      case 'bin':
        return { k: 'bin', op: e.op, a: rn(e.a, map), b: rn(e.b, map), line: e.line };
      case 'mul':
      case 'div':
      case 'mod':
        return { k: e.k, a: rn(e.a, map), b: rn(e.b, map), line: e.line };
      case 'cmp':
        return { k: 'cmp', op: e.op, a: rn(e.a, map), b: rn(e.b, map), line: e.line };
      case 'and':
      case 'or':
        return { k: e.k, a: rn(e.a, map), b: rn(e.b, map), line: e.line };
      case 'not':
        return { k: 'not', a: rn(e.a, map), line: e.line };
      default:
        return e;
    }
  }

  /* ---------- 收集函数自己的局部名字（形参 + 函数体里声明的） ---------- */
  function collectLocals(body, params) {
    var set = Object.create(null);
    params.forEach(function (p) { set[p.name] = 1; });

    (function walk(nodes) {
      (nodes || []).forEach(function (n) {
        if (!n) return;
        if (n.type === 'decl') set[n.name] = 1;
        else if (n.type === 'while') walk(n.body);
        else if (n.type === 'if') { walk(n.then); if (n.else) walk(n.else); }
      });
    })(body);

    return set;
  }

  /* ---------- return 统计 ---------- */
  /* 循环体里的 return 也能支持了：把循环条件改成「继续执行标志 && 原条件」，
     return 时把标志清零，循环自己就退出了 —— 不需要跳转指令。 */
  function countRets(nodes) {
    var n = 0;
    (nodes || []).forEach(function (s) {
      if (!s) return;
      if (s.type === 'ret') n++;
      else if (s.type === 'if') {
        n += countRets(s.then);
        n += countRets(s.else);
      } else if (s.type === 'while') {
        n += countRets(s.body);
      }
    });
    return n;
  }

  /* 这一段（含任意深度的 if / while）里有没有 return */
  function containsRet(nodes) {
    var found = false;
    (nodes || []).forEach(function (s) {
      if (!s || found) return;
      if (s.type === 'ret') found = true;
      else if (s.type === 'if') found = containsRet(s.then) || containsRet(s.else);
      else if (s.type === 'while') found = containsRet(s.body);
    });
    return found;
  }

  /* ---------- 语句改名 ---------- */
  function renameStmt(n, map, ctx, needGuard, contName, retName) {
    if (!n) return null;

    switch (n.type) {
      case 'decl':
        return { type: 'decl', name: nm(map, n.name), init: rn(n.init, map), kind: n.kind, line: n.line, text: n.text };

      case 'set':
      case 'add':
      case 'sub':
        return { type: n.type, name: nm(map, n.name), expr: rn(n.expr, map), line: n.line, text: n.text };

      case 'in':
        return { type: 'in', name: nm(map, n.name), skipSpace: n.skipSpace,
                 line: n.line, text: n.text };

      case 'out':
      case 'outdec':
        return { type: n.type, expr: rn(n.expr, map), line: n.line, text: n.text };

      case 'outstr':
        return { type: 'outstr', text: n.text, line: n.line };

      case 'while':
        var wBody = buildBlock(n.body, map, ctx, needGuard, contName, retName);
        var wCond = rn(n.cond, map);
        /* 循环体里有 return：条件再加上「继续执行标志」，
           一旦 return 把标志清零，本层循环连同所有外层循环一起退出。 */
        if (needGuard && containsRet(n.body)) {
          wCond = { k: 'and', a: { k: 'var', name: contName }, b: wCond, line: n.line };
        }
        return {
          type: 'while',
          cond: wCond,
          body: wBody,
          line: n.line,
          text: n.text
        };

      case 'if':
        return {
          type: 'if',
          cond: rn(n.cond, map),
          then: buildBlock(n.then, map, ctx, needGuard, contName, retName),
          else: n.else ? buildBlock(n.else, map, ctx, needGuard, contName, retName) : null,
          line: n.line,
          text: n.text
        };

      case 'callset':
        return {
          type: 'callset', target: nm(map, n.target), fn: n.fn,
          args: (n.args || []).map(function (a) { return rn(a, map); }),
          line: n.line, text: n.text
        };

      case 'call':
        return {
          type: 'call', fn: n.fn,
          args: (n.args || []).map(function (a) { return rn(a, map); }),
          line: n.line, text: n.text
        };

      default:
        return n;
    }
  }

  /* ---------- 一个语句块（处理 return 与顺序） ---------- */
  function buildBlock(body, map, ctx, needGuard, contName, retName) {
    var out = [];
    var mayDead = false;

    (body || []).forEach(function (s) {
      if (!s) return;

      if (s.type === 'ret') {
        var seq = [];
        if (s.expr) {
          seq.push({ type: 'set', name: retName, expr: rn(s.expr, map), line: s.line, text: 'return ' });
        }
        if (needGuard) {
          seq.push({ type: 'set', name: contName, expr: { k: 'num', v: 0 }, line: s.line, text: '标记已 return' });
        }
        /* 前面的分支可能已经 return 过，这条 return 也要挡住 */
        if (seq.length && mayDead && needGuard) {
          seq = [{ type: 'if', cond: { k: 'var', name: contName }, then: seq, else: null,
                   line: s.line, text: '（前面已经 return，不再执行）' }];
        }
        out.push.apply(out, seq);
        mayDead = true;
        return;
      }

      var r = renameStmt(s, map, ctx, needGuard, contName, retName);

      /* stepmark 是 for 循环「步进区」的纯标记，必须留在平铺层级：
         包进 if 里 Loops 就看不见了，continue 之后的步进会被漏掉。 */
      if (mayDead && needGuard && s.type !== 'stepmark') {
        r = {
          type: 'if',
          cond: { k: 'var', name: contName },
          then: [r],
          else: null,
          line: s.line,
          text: '（已经 return，不再执行）'
        };
      }

      out.push(r);

      if (s.type === 'if' && (containsRet(s.then) || containsRet(s.else))) mayDead = true;
      if (s.type === 'while' && containsRet(s.body)) mayDead = true;
    });

    return out;
  }

  /* ---------- 函数体：改名 + 处理 return ---------- */
  function renameBody(fn, map, ctx) {
    var body = fn.body || [];
    var retName = map[fn.retName];
    var contName = retName + '_c';

    var total = countRets(body);
    var lastIsRet = body.length > 0 && body[body.length - 1].type === 'ret';
    var needGuard = total > 0 && !(total === 1 && lastIsRet);

    var out = buildBlock(body, map, ctx, needGuard, contName, retName);

    if (needGuard) {
      out.unshift({ type: 'set', name: contName, expr: { k: 'num', v: 1 }, line: 0, text: '继续执行标志 = 1' });
    }
    return out;
  }

  /* ---------- 展开 ---------- */
  function expandList(nodes, ctx, stack) {
    var out = [];

    (nodes || []).forEach(function (n) {
      if (!n) return;

      if (n.type === 'call' || n.type === 'callset') {
        out.push.apply(out, expandCall(n, ctx, stack));
        return;
      }

      if (n.type === 'while') {
        out.push({ type: 'while', cond: n.cond, body: expandList(n.body, ctx, stack), line: n.line, text: n.text });
        return;
      }

      if (n.type === 'if') {
        out.push({
          type: 'if',
          cond: n.cond,
          then: expandList(n.then, ctx, stack),
          else: n.else ? expandList(n.else, ctx, stack) : null,
          line: n.line,
          text: n.text
        });
        return;
      }

      if (n.type === 'ret') {
        /* 只可能是 main 里的 return（普通函数的 ret 已在 renameBody 里消化掉）。
           先留着，expand 末尾交给 guardEntry 统一改写。 */
        out.push(n);
        return;
      }

      out.push(n);
    });

    return out;
  }

  function expandCall(n, ctx, stack) {
    var fn = ctx.funcs[n.fn];
    if (!fn) throw { message: '函数 ' + n.fn + ' 未定义（需要先定义再调用）', line: n.line || 1 };
    if (!fn.body) throw { message: '函数 ' + n.fn + ' 只有声明，没有定义', line: n.line || 1 };
    if (fn.params.length !== n.args.length) {
      throw {
        message: '函数 ' + n.fn + ' 需要 ' + fn.params.length + ' 个参数，实际传入 ' + n.args.length + ' 个',
        line: n.line || 1
      };
    }

    /* 递归：BrainFuck 没有调用栈，只能按层静态展开 */
    var depth = 0;
    stack.forEach(function (x) { if (x === n.fn) depth++; });
    var cap = depthCapOf(fn, ctx.maxDepth, n.line);

    if (depth >= cap) {
      ctx.truncated = true;
      if (!n.target) return [];
      return [{
        type: 'set', name: n.target, expr: { k: 'num', v: 0 }, line: n.line,
        text: '（递归超过 ' + cap + ' 层，这里返回 0）'
      }];
    }

    ctx.calls++;
    if (ctx.calls > ctx.maxCalls) {
      throw {
        message: '函数调用的静态展开次数超过上限（' + ctx.maxCalls + ' 次）。递归没有调用栈可用，只能就地展开，' +
                 '请减小递归规模、调低「递归层数」，或改用循环',
        line: n.line || 1
      };
    }

    if (depth > 0 && !ctx.recWarned[n.fn]) {
      ctx.recWarned[n.fn] = 1;
      ctx.warnings.push({
        message: '函数 ' + n.fn + ' 是递归的，已按层静态展开（最多 ' + cap + ' 层）：运行时递归比这更深时结果会不完整，' +
                 '可在右上角调大「递归层数」',
        line: n.line || 1
      });
    }

    /* 按“层”命名而不是按调用点命名：同一层的两帧在时间上永不重叠
       （内联代码是棵树，兄弟子树顺序执行），这样递归展开不会把单元格吃光 */
    var id = ++ctx.seq;
    var pre = '__' + fn.name + 'd' + depth + '_';
    var map = Object.create(null);
    map.__prefix = pre;

    /* 形参 → 新名字 */
    fn.params.forEach(function (p) { map[p.name] = pre + p.name; });

    /* 局部变量 → 新名字（全局变量故意不改名，让函数能读写全局） */
    var locals = collectLocals(fn.body, fn.params);
    Object.keys(locals).forEach(function (k) {
      if (!has(map, k)) map[k] = pre + k;
    });

    /* 返回值直接落在调用点的目标单元格上，省一次搬运 */
    map[fn.retName] = n.target || (pre + 'ret');

    var out = [];

    /* 1. 传参
       引用形参（int& x）不复制：直接把形参名映射到实参的变量名，
       于是函数体里对形参的读写都落在实参那一格上 —— 这就是 C++ 引用的语义。
       BrainFuck 里地址是编译期的，函数按调用点内联让这件事白送。 */
    fn.params.forEach(function (p, i) {
      var arg = n.args[i];
      if (p.ref || p.ptr) {
        if (arg && (arg.k === 'refarg' || arg.k === 'ptrarg')) {
          map[p.name] = arg.name;
          return;
        }
        ctx.warnings.push({
          message: '函数 ' + fn.name + ' 的引用 / 指针参数 ' + p.name +
                   ' 收到的不是变量（是临时值 / 表达式），已退化为按值传递',
          line: n.line || 1
        });
      }
      out.push({
        type: 'set',
        name: map[p.name],
        expr: arg,
        line: n.line,
        text: '（调用 ' + fn.name + '）传参 ' + p.name
      });
    });

    /* 2. 函数体（改名 + 递归展开内层调用） */
    var body = renameBody(fn, map, ctx);
    out.push.apply(out, expandList(body, ctx, stack.concat([fn.name])));

    return out;
  }

  /**
   * @param {Array}  ir        入口 IR
   * @param {Object} funcs     函数表
   * @param {Array}  warnings  警告收集数组
   * @returns {Array} 展开后的 IR
   */
  /* ---------- 入口（main）里的 return ----------
     C++ 里 main 里执行到 return 就等于「程序结束」，后面的语句一句都不许再跑。
     BrainFuck 没有跳转指令，所以用一个「继续执行标志」：
       return       →  标志 = 0
       之后的语句   →  包一层 if (标志)
       含 return 的循环 → 条件改成 (标志 && 原条件)，标志一清零循环就退出
     只有 main 里真的出现 return 时才生成这些，其余程序零开销。 */
  function guardEntry(list, isRoot) {
    if (!containsRet(list)) return list;

    /* 唯一的 return 就是整个程序最后一句（`return 0; }` 这种绝大多数写法）：
       后面没有任何语句，直接删掉即可，一个标志位都不用加。
       注意只能对根列表这么做 —— 循环体里的末尾 return 仍然要清标志，
       否则循环退不出去（`while (1) { …; return 0; }` 会死循环）。 */
    if (isRoot && countRets(list) === 1 && list.length &&
        list[list.length - 1].type === 'ret') {
      return list.slice(0, list.length - 1);
    }

    var go = '__entry_go';
    var out = [];
    var mayDead = false;

    (list || []).forEach(function (n) {
      if (!n) return;

      if (n.type === 'ret') {
        var seq = [{
          type: 'set', name: go, expr: { k: 'num', v: 0 }, line: n.line,
          text: n.text ? n.text + ' ［return：结束程序］' : 'return：结束程序'
        }];
        if (mayDead) {
          seq = [{ type: 'if', cond: { k: 'var', name: go }, then: seq, else: null,
                   line: n.line, text: '（前面已经 return）' }];
        }
        out.push.apply(out, seq);
        mayDead = true;
        return;
      }

      var r = n;
      if (n.type === 'while') {
        var body = guardEntry(n.body);   /* 内层：不重置标志 */
        var cond = n.cond;
        if (containsRet(n.body)) {
          cond = { k: 'and', a: { k: 'var', name: go }, b: cond, line: n.line };
        }
        r = { type: 'while', cond: cond, body: body, line: n.line, text: n.text };
      } else if (n.type === 'if') {
        r = {
          type: 'if', cond: n.cond,
          then: guardEntry(n.then),
          else: n.else ? guardEntry(n.else) : null,
          line: n.line, text: n.text
        };
      }

      /* stepmark 是 for 循环步进区的标记，必须留在平铺层级给 Loops 看 */
      if (mayDead && n.type !== 'stepmark') {
        r = {
          type: 'if', cond: { k: 'var', name: go }, then: [r], else: null,
          line: n.line, text: '（已经 return，不再执行）'
        };
      }
      out.push(r);

      if (n.type === 'if' && (containsRet(n.then) || containsRet(n.else))) mayDead = true;
      if (n.type === 'while' && containsRet(n.body)) mayDead = true;
    });

    /* 标志只在最外层初始化一次：内层循环每轮都重置的话，return 就白清了 */
    if (isRoot) {
      out.unshift({
        type: 'set', name: go, expr: { k: 'num', v: 1 }, line: 0,
        text: '继续执行标志 = 1（main 里的 return 会清零）'
      });
    }
    return out;
  }

  function expand(ir, funcs, warnings, opts) {
    opts = opts || {};
    var ctx = {
      funcs: funcs || {},
      seq: 0,
      calls: 0,
      maxDepth: Math.max(1, Math.min(24, opts.depth || MAX_DEPTH)),
      maxCalls: Math.max(8, Math.min(4000, opts.calls || MAX_CALLS)),
      truncated: false,
      recWarned: Object.create(null),
      warnings: warnings || []
    };
    var out = expandList(ir, ctx, []);
    /* 入口层的 return 统一改写成「继续执行标志」 */
    out = guardEntry(out, true);
    return out;
  }

  TC.Inline = { expand: expand, share: share, MAX_DEPTH: MAX_DEPTH, MAX_CALLS: MAX_CALLS };
})(window.TC = window.TC || {});
