/* =========================================================================
 * tc/compiler.js —— 编译入口
 *   预处理(#include/#define/常量) → 解析 → 标准库 prelude 并入 → 注解
 *   → 函数内联展开 → 常量折叠 → break/continue 改写 → 代码生成
 * ========================================================================= */
(function (TC) {
  'use strict';

  var LANG_NAME = { c: 'C', cpp: 'C++', asm: 'NASM' };

  /* 给每个 IR 节点补上源码行文本，最终作为 BF 注释输出 */
  function annotate(nodes, lines) {
    (nodes || []).forEach(function (n) {
      if (!n) return;
      if (!n.text && n.line && lines[n.line - 1]) {
        n.text = lines[n.line - 1].trim().replace(/\s+/g, ' ');
      }
      if (n.type === 'while') annotate(n.body, lines);
      if (n.type === 'if') {
        annotate(n.then, lines);
        if (n.else) annotate(n.else, lines);
      }
    });
  }

  /* prelude 里的节点不能拿主源码行当注释，统一打上标记 */
  function markLib(nodes, label) {
    (nodes || []).forEach(function (n) {
      if (!n) return;
      n.text = label;
      if (n.type === 'while') markLib(n.body, label);
      if (n.type === 'if') { markLib(n.then, label); markLib(n.else, label); }
    });
  }

  /* BrainFuck 没有时钟，time()/clock() 只能固定返回 0，于是
     srand(time(nullptr)) 等价于 srand(0)：同一份程序每次运行的第一局答案必然相同。
     BF 里唯一真实的外部熵就是输入流 —— 每读到一次输入，就把读入的字节混入
     随机种子，让「玩家猜了什么」影响后续 rand() 序列：不同输入 → 不同答案。
     只在程序确实用到 rand 系列时注入，其余程序一条指令都不多。 */
  function injectEntropy(nodes, seedName) {
    function stir(n) {
      /* seed = seed * 31 + <读入的值> + 1，形式与 rand() 的 LCG 赋值一致，
         codegen 对这种「目标变量同时出现在表达式里」的写法有专门处理。 */
      return {
        type: 'set', name: seedName,
        expr: {
          k: 'bin', op: '+',
          a: { k: 'mul', a: { k: 'var', name: seedName }, b: { k: 'num', v: 31 } },
          b: { k: 'bin', op: '+', a: { k: 'var', name: n.name }, b: { k: 'num', v: 1 } }
        },
        line: n.line, text: '输入熵 → 扰动随机种子'
      };
    }
    function walk(list) {
      var out = [];
      (list || []).forEach(function (n) {
        if (!n) return;
        if (n.type === 'in' || n.type === 'innum') {
          out.push(n);
          out.push(stir(n));
          return;
        }
        if (n.type === 'while') n.body = walk(n.body);
        else if (n.type === 'if') {
          n.then = walk(n.then);
          if (n.else) n.else = walk(n.else);
        }
        out.push(n);
      });
      return out;
    }
    return walk(nodes);
  }

  /* 标准库 prelude 的解析结果缓存：prelude 只跟「用到哪些库函数」有关，
     同一份源码反复编译（输入即编译）时不必重新词法 + 语法分析。
     下游会就地修改 IR（加注释、int32 / string 降级），所以取用时深拷贝一份。 */
  var PRELUDE_CACHE = Object.create(null);

  function parsePrelude(text) {
    var cached = PRELUDE_CACHE[text];
    if (!cached) {
      var lib = TC.ParserC.parse(text);
      cached = PRELUDE_CACHE[text] = JSON.stringify({ funcs: lib.funcs, varType: lib.varType });
      return lib;
    }
    var copy = JSON.parse(cached);
    return { funcs: copy.funcs, varType: copy.varType, ir: [], warnings: [] };
  }

  /* 除了「有 string 变量」，表达式里出现 stoi / strlen / string(…) 等字符串
     节点时也必须跑 Str.lower —— 否则这些节点会一路留到 codegen 报
     「表达式里出现了这里不支持的运算」。 */
  var STR_KINDS = { strlit: 1, scat: 1, ssub: 1, to_str: 1, srep: 1,
                    slen: 1, sidx: 1, stoi: 1, sfind: 1, scmp: 1, sempty: 1 };
  var STR_KIDS = ['a', 'b', 'n', 'ch', 'pos', 'len', 'idx'];

  function hasStrExpr(nodes) {
    var found = false;
    function expr(e) {
      if (!e || found || typeof e !== 'object') return;
      if (STR_KINDS[e.k]) { found = true; return; }
      STR_KIDS.forEach(function (k) { expr(e[k]); });
    }
    function walk(list) {
      (list || []).forEach(function (n) {
        if (!n || found) return;
        expr(n.expr); expr(n.cond); expr(n.init);
        (n.args || []).forEach(expr);
        if (n.then) walk(n.then);
        if (n.else) walk(n.else);
        if (n.body) walk(n.body);
      });
    }
    walk(nodes);
    return found;
  }

  function compile(lang, src, opts) {
    opts = opts || {};
    src = String(src || '');
    var lines = src.split(/\r?\n/);
    var parsed;
    var headers = [];
    var stdfuncs = [];
    var preWarnings = [];

    try {
      /* C / C++ 才做预处理：抽走 #include / #define，展开常量宏。
         用空行占位保持行号不变，错误定位与逐句注释才不会错位。 */
      if (lang !== 'asm' && TC.Stdlib) {
        var pre = TC.Stdlib.scan(src);
        headers = pre.headers;
        preWarnings = pre.warnings;
        src = TC.Stdlib.subst(pre.code, pre.macros);
        lines = src.split(/\r?\n/);
      }
      if (lang !== 'asm' && TC.Stdlib) {
        stdfuncs = TC.Stdlib.needed(src, {});
        var sigs = TC.Stdlib.signatures(stdfuncs);
        parsed = TC.ParserC.parse(src, { knownFuncs: sigs, int32: !!opts.int32 });
        /* 位运算 & | ^ ~ << >> 会生成对 __bf_xxx 的调用，把实现补进 prelude */
        (parsed.bitFns || []).forEach(function (fn) {
          if (stdfuncs.indexOf(fn) < 0) stdfuncs.push(fn);
        });
      } else {
        parsed = TC.ParserAsm.parse(src);
      }
    } catch (err) {
      return {
        ok: false,
        errors: [{ line: err.line || 1, message: err.message || String(err) }],
        warnings: preWarnings,
        headers: headers,
        stdfuncs: stdfuncs
      };
    }

    var warnings = preWarnings.concat(parsed.warnings || []);

    /* time()/clock() 的降级必须说清楚，否则用户会以为 srand(time(nullptr))
       真的按当前时间播了种，看到「每局/每次都一样」以为是编译器坏了。 */
    if (lang !== 'asm' && TC.Stdlib) {
      var usesRand = TC.Stdlib.needsSeed(stdfuncs);
      var usesClock = stdfuncs.indexOf('time') >= 0 || stdfuncs.indexOf('clock') >= 0;
      if (usesRand || usesClock) {
        var rm = /\b(?:std\s*::\s*)?(?:time|clock|srand|rand)\s*\(/.exec(src);
        var rline = rm ? src.slice(0, rm.index).split('\n').length : 1;
        var base = '随机数是 8 位 LCG（周期 256），不是真随机；已启用「输入熵」：每读到一次输入都会扰动随机种子，' +
                   '所以每局数字不同、不同输入序列结果也不同，但相同输入序列仍会得到相同结果。';
        if (usesClock) {
          base = 'BrainFuck 没有系统时钟，time()/clock() 固定返回 0：srand(time(nullptr)) 等价于 srand(0)，' +
                 '因此同一份程序每次运行的「第一局」答案固定。' + base +
                 ' 想让第一局也可变，改成先读入一个数字再 srand(n) 即可。';
        }
        warnings.push({ message: base, line: rline });
      }
    }

    try {
      var funcs = parsed.funcs || {};

      /* 标准库函数：单独 parse 一份 prelude，再并入函数表。
         这样做行号互不干扰，库函数走的是与手写函数完全相同的内联展开管线。 */
      if (lang !== 'asm' && TC.Stdlib && stdfuncs.length) {
        var prelude = TC.Stdlib.preludeFor(stdfuncs);
        if (prelude) {
          var lib = parsePrelude(prelude);
          Object.keys(lib.funcs).forEach(function (k) {
            if (funcs[k] && !funcs[k].builtin) return;   /* 用户自定义的同名函数优先 */
            funcs[k] = lib.funcs[k];
            markLib(lib.funcs[k].body, '标准库 ' + k + '()');
          });
          if (lib.varType && parsed.varType) {
            Object.keys(lib.varType).forEach(function (k) {
              if (!parsed.varType[k]) parsed.varType[k] = lib.varType[k];
            });
          }
          lib.ir.forEach(function (n) { n.text = '标准库初始化'; });
          parsed.ir = lib.ir.concat(parsed.ir);
        }
      }

      /* 编译期优化：常量传播 / 死输入 / 死存储 / 常量输出内联。
         必须早于 str 与 int32 降级 —— 那时还能看到 if / while / 变量名，
         也能把「输出常量」直接折成一条 outstr（int32 的 %d 一次要十万条指令）。 */
      if (lang !== 'asm' && TC.Opt) {
        var vtOpt = parsed.varType || {};
        /* 函数体用到的全局名要先收一遍：主 IR 里对它们的赋值不能按
           「只写不读」删掉（读取在函数体里，那是另一次优化） */
        var keepG = TC.Opt.globalsUsed ? TC.Opt.globalsUsed(funcs) : null;
        parsed.ir = TC.Opt.run(parsed.ir, vtOpt, warnings, keepG);
        Object.keys(funcs).forEach(function (k) {
          if (!funcs[k].body) return;
          funcs[k].body = TC.Opt.run(funcs[k].body, vtOpt, warnings);
        });
      }

      /* std::string lowering：与 int32 一样必须早于内联展开（内联会按调用点
         改变量名，而字符串会摊平成 s.len / s[0] … 一组单元格）。 */
      if (lang !== 'asm' && TC.Str) {
        var vtS = parsed.varType || {};
        var hasStr = Object.keys(vtS).some(function (k) { return vtS[k] === 'str'; }) ||
                     hasStrExpr(parsed.ir) ||
                     Object.keys(funcs).some(function (k) {
                       return funcs[k].body && hasStrExpr(funcs[k].body);
                     });
        if (hasStr) {
          var s1 = TC.Str.lower(parsed.ir, vtS, warnings, 0);
          parsed.ir = s1.ir;
          var sq0 = s1.seq;
          Object.keys(funcs).forEach(function (k) {
            if (!funcs[k].body) return;
            var s2 = TC.Str.lower(funcs[k].body, vtS, warnings, sq0);
            funcs[k].body = s2.ir;
            sq0 = s2.seq;
          });
        }
      }

      /* int32 lowering：必须早于内联展开（内联会按调用点改变量名）。
         主 IR 与每个函数体分开降级，临时名用 seq 接力，避免撞名。
         float / double 是「放大 1000 倍的 int32」，走同一条降级路径。 */
      if (lang !== 'asm' && TC.I32) {
        var vt = parsed.varType || {};
        var hasI32 = Object.keys(vt).some(function (k) {
          return vt[k] === 'i32' || vt[k] === 'f32';
        });
        if (hasI32) {
          var l1 = TC.I32.lower(parsed.ir, vt, warnings, 0);
          parsed.ir = l1.ir;
          var sq = l1.seq;
          Object.keys(funcs).forEach(function (k) {
            if (!funcs[k].body) return;
            var l2 = TC.I32.lower(funcs[k].body, vt, warnings, sq);
            funcs[k].body = l2.ir;
            sq = l2.seq;
          });
        }
      }

      annotate(parsed.ir, lines);
      /* 函数体不在入口 IR 里，单独补一次注释 */
      Object.keys(funcs).forEach(function (k) { annotate(funcs[k].body, lines); });

      /* 函数调用 → 内联展开（递归按层展开，层数可在页面上调） */
      var ir = TC.Inline.expand(parsed.ir, funcs, warnings, { depth: opts.depth });

      /* 常量折叠 / 代数化简：能算的编译期算完 */
      if (TC.Fold) ir = TC.Fold.run(ir);

      /* break / continue → 标志位 + 条件守卫（IR 层改写，生成器无感） */
      if (TC.Loops) ir = TC.Loops.run(ir);

      /* 放在所有 IR 变换之后：注入的语句不再被改名 / 折叠 / 改写 */
      if (lang !== 'asm' && TC.Stdlib && TC.Stdlib.needsSeed(stdfuncs)) {
        ir = injectEntropy(ir, TC.Stdlib.SEED);
      }

      var out = TC.Codegen.generate(ir, {
        lang: LANG_NAME[lang] || 'C',
        srcLines: lines.length,
        comments: opts.comments,
        preview: !!opts.preview,
        noJoin: !!opts.noJoin
      });

      return {
        ok: true,
        code: out.code,
        chunks: out.chunks,
        stats: out.stats,
        vars: out.vars,
        cells: out.cells,
        preview: !!out.preview,
        fullChars: out.fullChars,
        errors: [],
        warnings: warnings,
        headers: headers,
        stdfuncs: stdfuncs
      };
    } catch (err2) {
      return {
        ok: false,
        errors: [{ line: err2.line || 1, message: err2.message || String(err2) }],
        warnings: warnings,
        headers: headers,
        stdfuncs: stdfuncs
      };
    }
  }

  /* ---------------- 示例 ---------------- */
  var EXAMPLES = {
    c: [
      '// 递归 + 乘法 + 除法 + break / continue 都在这段里',
      '// （右上角「递归层数」可调，默认 8 层）',
      'int sumTo(int n) {',
      '  if (n == 0) { return 0; }',
      '  return n + sumTo(n - 1);',
      '}',
      '',
      'printf("sum 1..5 = %d\\n", sumTo(5));          // 15',
      '',
      '// 除法和取余：87 / 10 = 8 余 7',
      'char a = 87;',
      'char b = 10;',
      'printf("%d / %d = %d r %d\\n", a, b, a / b, a % b);',
      '',
      '// continue：跳过偶数，打印奇数的平方 1 9 25 49 81',
      'for (char k = 1; k <= 9; k++) {',
      '  if (k % 2 == 0) { continue; }',
      '  printf("%d ", k * k);',
      '}',
      'putchar(10);',
      '',
      '// break：数到 4 就溜',
      'char n = 0;',
      'while (n < 100) {',
      '  n += 1;',
      '  if (n == 4) { break; }',
      '}',
      'printf("stopped at %d\\n", n);'
    ].join('\n'),

    cpp: [
      '#include <iostream>',
      'using namespace std;',
      '',
      '// 递归：1..n 求和',
      'int sumTo(int n) {',
      '    if (n == 0) { return 0; }',
      '    return n + sumTo(n - 1);',
      '}',
      '',
      'int main() {',
      '    for (int k = 1; k <= 5; k++) {',
      '        cout << k << ": " << sumTo(k) << endl;',
      '    }',
      '',
      '    int n;',
      '    cin >> n;                                  // 输入一个 0..120 的数字',
      '    cout << n << " / 3 = " << n / 3 << " r " << n % 3 << endl;',
      '',
      '    int cnt = 0;',
      '    for (int i = 1; i <= 20; i++) {',
      '        if (i % 2 == 0) { continue; }          // 跳过偶数',
      '        if (i > 9) { break; }                  // 到 10 就停',
      '        cnt += 1;',
      '    }',
      '    cout << "odd count " << cnt << endl;',
      '    return 0;',
      '}'
    ].join('\n'),

    asm: [
      '; 打印 HIJ 再换行',
      '; cmp + jne 会被识别成 while 循环',
      'mov cl, 3          ; 循环次数',
      'mov al, 72         ; \'H\'',
      '',
      'next_char:',
      '    putc al',
      '    inc al',
      '    dec cl',
      '    cmp cl, 0',
      '    jne next_char',
      '',
      'mov al, 10         ; 换行',
      'putc al'
    ].join('\n')
  };

  /* 标准库专题示例：点速查弹窗底部的「载入示例」使用 */
  var LIB_EXAMPLES = {
    c: [
      '#include <stdio.h>',
      '#include <stdlib.h>',
      '#include <ctype.h>',
      '#include <math.h>',
      '#include <time.h>',
      '',
      '#define ROLLS 8',
      '#define SIDES 6',
      '',
      '/* <stdlib.h>：8 位 LCG 随机数，srand 固定种子 */',
      'srand(42);',
      'printf("dice: ");',
      'for (char i = 0; i < ROLLS; i++) {',
      '    printf("%d ", rand() % SIDES + 1);',
      '}',
      'putchar(10);',
      '',
      '/* <math.h>：8 位整数版数学函数 */',
      'printf("sqrt(50)=%d pow(2,5)=%d abs(251)=%d\\n", sqrt(50), pow(2, 5), abs(251));',
      '',
      '/* <ctype.h>：字符分类与转换 */',
      "putchar(toupper('a'));",
      "putchar(' ');",
      "printf(\"isdigit=%d isalpha=%d\\n\", isdigit('7'), isalpha('Z'));",
      '',
      '/* ^ 是 8 位按位异或 */',
      'printf("12 ^ 10 = %d\\n", 12 ^ 10);',
      '',
      '/* 内置常量与固定时钟 */',
      'printf("RAND_MAX=%d time=%d\\n", RAND_MAX, time(NULL));'
    ].join('\n'),

    cpp: [
      '#include <iostream>',
      '#include <random>',
      '#include <algorithm>',
      '#include <numeric>',
      '#include <cctype>',
      'using namespace std;',
      '',
      '#define N 5',
      '',
      'int main() {',
      '    /* <random>：函数式随机数（引擎/分布对象语法不支持） */',
      '    srand(7);',
      '    cout << "randint: ";',
      '    for (int i = 0; i < N; i++) {',
      '        cout << randint(1, 9) << " ";',
      '    }',
      '    cout << endl;',
      '',
      '    /* <algorithm> / <numeric> */',
      '    cout << "min=" << min(3, 8) << " max=" << max(3, 8)',
      '         << " clamp=" << clamp(20, 3, 9) << endl;',
      '    cout << "gcd=" << gcd(48, 18) << endl;',
      '',
      '    /* <cctype>：toupper 返回字符，isdigit 返回数字 */',
      "    cout << \"upper=\" << (char)toupper('q')",
      "         << \" digit=\" << isdigit('7') << endl;",
      '',
      '    /* std:: 前缀与内置常量 */',
      '    cout << "abs=" << std::abs(250) << " RAND_MAX=" << RAND_MAX << endl;',
      '    return 0;',
      '}'
    ].join('\n')
  };

  TC.compile = compile;
  TC.EXAMPLES = EXAMPLES;
  TC.LIB_EXAMPLES = LIB_EXAMPLES;
  /* float / double 示例：定点数（放大 1000 倍的 int32），3 位小数 */
  TC.FLOAT_EXAMPLE = [
    '#include <iostream>',
    '#include <cstdio>',
    'using namespace std;',
    '',
    'int main() {',
    '    // 纯常量：编译期就算完，一条浮点运算指令都不会生成',
    '    double a = 1.5, b = 2.25;',
    '    cout << "1.5 + 2.25 = " << a + b << endl;',
    '    cout << "1.5 * 2.25 = " << a * b << endl;',
    '    cout << "10.0 / 4.0 = " << 10.0 / 4.0 << endl;',
    '',
    '    // 运行期：定点数，输出自带小数点，末尾的 0 自动去掉',
    '    double x;',
    '    cout << "输入一个数: ";',
    '    cin >> x;',
    '    cout << "x + 0.5 = " << x + 0.5 << endl;',
    '    cout << "x * 2.5 = " << x * 2.5 << endl;',
    '    printf("%.2f\\n", x);',
    '',
    '    int n = x;                        // 截断取整',
    '    cout << "取整: " << n << endl;',
    '    if (x > 2.0) { cout << "比 2 大" << endl; }',
    '    else { cout << "不超过 2" << endl; }',
    '    return 0;',
    '}'
  ].join('\n');


  /* 数组示例：一维 / 二维 / 动态下标 / 任意元素类型 */
  TC.ARRAY_EXAMPLE = [
    '#include <iostream>',
    '#include <cstdio>',
    'using namespace std;',
    '',
    '// 引用（int&）：形参就是实参的别名，函数里改它等于改外面那个变量',
    'void swap2(int& p, int& q) { int t = p; p = q; q = t; }',
    '',
    'int main() {',
    '    // 一维 + 初始化列表：下标是常量时零开销',
    '    int a[5] = {3, 1, 4, 1, 5};',
    '    cout << "a[0]=" << a[0] << " a[4]=" << a[4] << endl;',
    '',
    '    // 变量下标：按下标读写（生成一棵逐维比较的选择树）',
    '    int i = 2;',
    '    a[i] = 9;',
    '    cout << "a[2]=" << a[2] << endl;',
    '',
    '    // 冒泡排序：数组 + 双循环 + swap2(a[y], a[y+1])',
    '    for (int x = 0; x < 5; x++) {',
    '        for (int y = 0; y < 4 - x; y++) {',
    '            if (a[y] > a[y+1]) { swap2(a[y], a[y+1]); }',
    '        }',
    '    }',
    '    cout << "排序后: ";',
    '    for (int x = 0; x < 5; x++) { cout << a[x] << " "; }',
    '    cout << endl;',
    '',
    '    // 二维：2x2 矩阵平方',
    '    int m[2][2] = {{1, 2}, {3, 4}};',
    '    int r[2][2];',
    '    for (int p = 0; p < 2; p++) {',
    '        for (int q = 0; q < 2; q++) {',
    '            r[p][q] = m[p][0]*m[0][q] + m[p][1]*m[1][q];',
    '        }',
    '    }',
    '    cout << "m^2 = " << r[0][0] << " " << r[0][1]',
    '         << " / " << r[1][0] << " " << r[1][1] << endl;',
    '',
    '    // 任意元素类型：int32 大数、double 定点数',
    '    int32_t big[2] = {70000, 250000};',
    '    cout << "big sum = " << big[0] + big[1] << endl;',
    '    double d[3] = {1.5, 2.25, 0.5};',
    '    double sum = 0;',
    '    for (int k = 0; k < 3; k++) { sum += d[k]; }',
    '    cout << "double sum = " << sum << endl;',
    '',
    '    // sizeof(a)/sizeof(a[0]) 取元素个数',
    '    cout << "元素数 = " << sizeof(a)/sizeof(a[0]) << endl;',
    '    return 0;',
    '}'
  ].join('\n');

  /* return 示例：循环里 / 多层嵌套 / void / main */
  TC.RETURN_EXAMPLE = [
    '#include <iostream>',
    'using namespace std;',
    '',
    '// 提前 return：条件一满足就收工，循环里也一样',
    'int findFirst(int k) {',
    '    for (int i = 0; i < 10; i++) {',
    '        if (i * i >= k) { return i; }    // 这一句直接结束整个函数',
    '    }',
    '    return 255;                          // 一个都没命中',
    '}',
    '',
    '// 多层循环：一处 return 把内外两层一起跳出',
    'int gridHit(int target) {',
    '    for (int r = 0; r < 4; r++) {',
    '        for (int c = 0; c < 4; c++) {',
    '            if (r * 4 + c == target) { return r * 10 + c; }',
    '        }',
    '    }',
    '    return 255;',
    '}',
    '',
    '// void 函数也能提前收工（return; 不带值）',
    'void showUntil(int n) {',
    '    for (int i = 0; i < 20; i++) {',
    '        if (i == n) { return; }',
    '        cout << i << " ";',
    '    }',
    '    cout << "(全部)";',
    '}',
    '',
    'int main() {',
    '    cout << "findFirst(30)  = " << findFirst(30) << endl;   // 6',
    '    cout << "findFirst(200) = " << findFirst(200) << endl;  // 255',
    '    cout << "gridHit(6)     = " << gridHit(6) << endl;      // 12',
    '',
    '    showUntil(4);                       // 0 1 2 3',
    '    cout << endl;',
    '',
    '    cout << "开始" << endl;',
    '    if (1) { return 0; }                // main 里 return：程序到此结束',
    '    cout << "这行永远不会执行" << endl;',
    '    return 0;',
    '}'
  ].join('\n');

  /* 指针示例：编译期绑定 + 数组内游标 + 指针形参 */
  TC.PTR_EXAMPLE = [
    '#include <iostream>',
    'using namespace std;',
    '',
    '// 指针形参：*p 直接落在调用方那一格上（函数按调用点内联）',
    'void set10(int *p) { *p = 10; }',
    '',
    'int main() {',
    '    // ① 取地址 / 解引用：*p 就是 a，编译期绑定、零额外指令',
    '    int a = 5;',
    '    int *p = &a;',
    '    *p = 9;',
    '    cout << "a=" << a << " *p=" << *p << endl;',
    '',
    '    // ② 多个指针指向同一个变量',
    '    int *q = p;',
    '    *q += 1;',
    '    cout << "a=" << a << endl;',
    '',
    '    // ③ 重新指向别处',
    '    int b = 100;',
    '    p = &b;',
    '    *p = 20;',
    '    cout << "a=" << a << " b=" << b << endl;',
    '',
    '    // ④ 数组名就是首元素地址，p++ 在数组里移动',
    '    int arr[5] = {1, 2, 3, 4, 5};',
    '    int *it = arr;',
    '    int sum = 0;',
    '    for (int i = 0; i < 5; i++) { sum += *it; it++; }',
    '    cout << "sum=" << sum << " arr[2]=" << arr[2] << endl;',
    '',
    '    // ⑤ 指针下标与偏移',
    '    int *r = &arr[1];',
    '    cout << "r[0]=" << r[0] << " *(r+1)=" << *(r+1) << endl;',
    '',
    '    // ⑥ 指针形参 / ⑦ 空指针比较（编译期判定）',
    '    set10(&a);',
    '    cout << "set10=" << a << endl;',
    '    int *np = nullptr;',
    '    if (np == nullptr) { cout << "null" << endl; }',
    '    return 0;',
    '}'
  ].join('\n');

  /* 标准函数示例：函数式类型转换 + cctype + cmath 取整 + 字符串构造 */
  TC.FUNC_EXAMPLE = [
    '#include <iostream>',
    '#include <cctype>',
    '#include <cmath>',
    '#include <cstring>',
    'using namespace std;',
    '',
    'int main() {',
    '    // ① 函数式类型转换：类型名当函数用，等价于 (char)x',
    '    char   c = char(65);',
    '    int    n = int(7 * 6);',
    '    double d = double(2);',
    '    int    f = bool(9);',
    '    cout << c << " " << n << " " << d << " " << f << endl;',
    '',
    '    // ② <cctype> 字符函数（std:: 前缀可省略）',
    '    char x  = \'q\';',
    '    char up = char(toupper(x));',
    '    cout << up << isalpha(x) << isdigit(x)',
    '         << isspace(\' \') << isxdigit(\'f\') << endl;',
    '',
    '    // ③ <cmath> 取整：知道 double 是「放大 1000 倍」的定点数',
    '    cout << floor(2.75) << " " << ceil(2.1)',
    '         << " " << round(2.5) << endl;',
    '',
    '    // ④ std::string 构造 / strlen / atoi',
    '    string s   = string("hello");',
    '    string bar = string(5, \'*\');',
    '    cout << s << " " << bar << endl;',
    '    cout << strlen("abcd") << " " << atoi("123") + 1 << endl;',
    '',
    '    return 0;',
    '}'
  ].join('\n');

  /* 计算器示例（精简可跑版）：struct 数组 / switch 菜单 / 历史记录 / 聚合初始化 / 引用绑定 */
  TC.CALC_EXAMPLE = [
    "#include <iostream>",
    "using namespace std;",
    "",
    "// ===== 结构体 + 结构体数组：和原版计算器同一套写法 =====",
    "// 字段这里用 int 以便 BF 能真正跑完；换成 double 也支持（定点数），",
    "// 但每次 double 乘除会展开成数百万条指令，整份程序会变得很大。",
    "struct HistoryEntry {",
    "    char op;",
    "    int a, b, result;",
    "};",
    "",
    "const int MAX_HISTORY = 4;",
    "HistoryEntry history[MAX_HISTORY];",
    "int historyCount = 0;",
    "",
    "void addHistory(char op, int a, int b, int result) {",
    "    if (historyCount < MAX_HISTORY) {",
    "        history[historyCount++] = {op, a, b, result};   // 聚合初始化 + 后置自增下标",
    "    } else {",
    "        for (int i = 1; i < MAX_HISTORY; ++i) history[i - 1] = history[i];  // 结构体整体拷贝",
    "        history[MAX_HISTORY - 1] = {op, a, b, result};",
    "    }",
    "}",
    "",
    "void printHistory() {",
    "    if (historyCount == 0) { cout << \"(empty)\" << endl; return; }",
    "    cout << \"----- history -----\" << endl;",
    "    for (int i = 0; i < historyCount; ++i) {",
    "        const HistoryEntry& h = history[i];             // 引用绑定到结构体数组元素",
    "        cout << (i + 1) << \". \";",
    "        switch (h.op) {",
    "            case '+': cout << h.a << \" + \" << h.b << \" = \" << h.result; break;",
    "            case '-': cout << h.a << \" - \" << h.b << \" = \" << h.result; break;",
    "            case '*': cout << h.a << \" * \" << h.b << \" = \" << h.result; break;",
    "            case '/': cout << h.a << \" / \" << h.b << \" = \" << h.result; break;",
    "            case 'a': cout << \"|\" << h.a << \"| = \" << h.result; break;",
    "        }",
    "        cout << endl;",
    "    }",
    "}",
    "",
    "int main() {",
    "    int lastResult = 0;",
    "    bool hasLast = false;",
    "    cout << \"===== calculator =====\" << endl;",
    "    cout << \"0=exit 1=+ 2=- 3=* 4=/ 8=abs 12=history\" << endl;",
    "",
    "    while (true) {",
    "        cout << \"> \";",
    "        int choice;",
    "        if (!(cin >> choice)) break;",
    "        if (choice == 0) break;",
    "",
    "        int a = 0, b = 0, result = 0;",
    "        char op = '?';",
    "        bool ok = true;",
    "",
    "        switch (choice) {",
    "            case 1: case 2: case 3: case 4: {",
    "                cin >> a >> b;",
    "                switch (choice) {",
    "                    case 1: result = a + b; op = '+'; break;",
    "                    case 2: result = a - b; op = '-'; break;",
    "                    case 3: result = a * b; op = '*'; break;",
    "                    case 4:",
    "                        if (b == 0) { cout << \"div by zero\" << endl; ok = false; break; }",
    "                        result = a / b; op = '/'; break;",
    "                }",
    "                break;",
    "            }",
    "            case 8: {",
    "                cin >> a;",
    "                result = a < 0 ? -a : a;               // 三元",
    "                op = 'a';",
    "                break;",
    "            }",
    "            case 12:",
    "                printHistory();",
    "                continue;",
    "            default:",
    "                cout << \"bad choice\" << endl;",
    "                continue;",
    "        }",
    "        if (!ok) continue;",
    "        cout << \"= \" << result << endl;",
    "        addHistory(op, a, b, result);",
    "        lastResult = result;",
    "        hasLast = true;",
    "    }",
    "    cout << \"bye, last=\" << lastResult << endl;",
    "    return 0;",
    "}"
  ].join('\n');

  /* 计算器原版（用户提交的完整代码）：语法全部接受；展开后规模很大，
     编辑器只显示前 120 KB 预览，导出请用「下载 .bf」按分块写出，不必拼整串。 */
  TC.CALC_FULL_EXAMPLE = [
    "#include <iostream>",
    "",
    "// ==================== 自定义数学工具 ====================",
    "",
    "double myAbs(double x) { return x < 0 ? -x : x; }",
    "",
    "// 字符串比较",
    "bool strEq(const char* a, const char* b) {",
    "    while (*a && *b && *a == *b) { ++a; ++b; }",
    "    return *a == '\\0' && *b == '\\0';",
    "}",
    "",
    "// 字符串转 double（支持符号、小数点、科学计数法）",
    "double strToDouble(const char* s, bool& ok) {",
    "    ok = true;",
    "    while (*s == ' ' || *s == '\\t') ++s;",
    "    bool neg = false;",
    "    if (*s == '-') { neg = true; ++s; }",
    "    else if (*s == '+') ++s;",
    "",
    "    double intPart = 0;",
    "    bool hasDigit = false;",
    "    while (*s >= '0' && *s <= '9') {",
    "        intPart = intPart * 10 + (*s - '0');",
    "        ++s;",
    "        hasDigit = true;",
    "    }",
    "    double fracPart = 0, scale = 1;",
    "    if (*s == '.') {",
    "        ++s;",
    "        while (*s >= '0' && *s <= '9') {",
    "            scale *= 0.1;",
    "            fracPart += (*s - '0') * scale;",
    "            ++s;",
    "            hasDigit = true;",
    "        }",
    "    }",
    "    double expMul = 1;",
    "    if (*s == 'e' || *s == 'E') {",
    "        ++s;",
    "        bool negExp = false;",
    "        if (*s == '-') { negExp = true; ++s; }",
    "        else if (*s == '+') ++s;",
    "        int e = 0;",
    "        bool hasExp = false;",
    "        while (*s >= '0' && *s <= '9') { e = e * 10 + (*s - '0'); ++s; hasExp = true; }",
    "        if (!hasExp) { ok = false; return 0; }",
    "        double p = 1;",
    "        for (int i = 0; i < e && i < 400; ++i) p *= 10;",
    "        expMul = negExp ? 1.0 / p : p;",
    "    }",
    "    while (*s == ' ' || *s == '\\t') ++s;",
    "    if (*s != '\\0' || !hasDigit) { ok = false; return 0; }",
    "    double val = (intPart + fracPart) * expMul;",
    "    return neg ? -val : val;",
    "}",
    "",
    "// 安全读取一个 token，防止缓冲区溢出",
    "bool readToken(char* buf, int maxLen) {",
    "    int i = 0;",
    "    char ch;",
    "    while (std::cin.get(ch)) {",
    "        if (ch != ' ' && ch != '\\t' && ch != '\\n' && ch != '\\r') break;",
    "    }",
    "    if (!std::cin) return false;",
    "    buf[i++] = ch;",
    "    while (std::cin.get(ch)) {",
    "        if (ch == ' ' || ch == '\\t' || ch == '\\n' || ch == '\\r') break;",
    "        if (i < maxLen - 1) buf[i++] = ch;",
    "    }",
    "    buf[i] = '\\0';",
    "    return i > 0;",
    "}",
    "",
    "// 平方根（牛顿迭代法）",
    "double mySqrt(double x) {",
    "    if (x < 0) return -1;",
    "    if (x == 0) return 0;",
    "    double g = x;",
    "    for (int i = 0; i < 200; ++i) {",
    "        double ng = 0.5 * (g + x / g);",
    "        if (myAbs(ng - g) < 1e-13) return ng;",
    "        g = ng;",
    "    }",
    "    return g;",
    "}",
    "",
    "const double LN2 = 0.69314718055994530942;",
    "",
    "// 自然对数",
    "double myLn(double x) {",
    "    if (x <= 0) return -1e308;",
    "    int k = 0;",
    "    while (x >= 2) { x *= 0.5; ++k; }",
    "    while (x < 1)  { x *= 2;   --k; }",
    "    double z = (x - 1) / (x + 1);",
    "    double z2 = z * z;",
    "    double term = z, sum = 0;",
    "    for (int n = 0; n < 200; ++n) {",
    "        double add = term / (2 * n + 1);",
    "        sum += add;",
    "        term *= z2;",
    "        if (myAbs(add) < 1e-18) break;",
    "    }",
    "    return 2 * sum + k * LN2;",
    "}",
    "",
    "// 自然指数",
    "double myExp(double x) {",
    "    bool neg = x < 0;",
    "    if (neg) x = -x;",
    "    int k = (int)(x / LN2);",
    "    if (k > 1000) k = 1000;",
    "    double r = x - k * LN2;",
    "    double term = 1, sum = 1;",
    "    for (int n = 1; n < 200; ++n) {",
    "        term *= r / n;",
    "        sum += term;",
    "        if (myAbs(term) < 1e-18) break;",
    "    }",
    "    for (int i = 0; i < k; ++i) sum *= 2;",
    "    return neg ? 1.0 / sum : sum;",
    "}",
    "",
    "// 幂运算（整数指数用快速幂，非整数用 exp(b*ln(a))）",
    "double myPow(double a, double b) {",
    "    double rounded = b >= 0 ? (double)(long long)(b + 0.5)",
    "                            : (double)(long long)(b - 0.5);",
    "    if (myAbs(b - rounded) < 1e-9) {",
    "        long long e = (long long)rounded;",
    "        bool negExp = e < 0;",
    "        if (negExp) e = -e;",
    "        double base = a, result = 1;",
    "        while (e > 0) {",
    "            if (e & 1) result *= base;",
    "            base *= base;",
    "            e >>= 1;",
    "        }",
    "        return negExp ? 1.0 / result : result;",
    "    }",
    "    if (a <= 0) return -1e308;",
    "    return myExp(b * myLn(a));",
    "}",
    "",
    "// 阶乘",
    "double myFact(int n) {",
    "    if (n < 0 || n > 170) return -1e308;",
    "    double r = 1;",
    "    for (int i = 2; i <= n; ++i) r *= i;",
    "    return r;",
    "}",
    "",
    "// ==================== 历史记录 ====================",
    "",
    "const int MAX_HISTORY = 50;",
    "",
    "struct HistoryEntry {",
    "    char op;",
    "    double a, b, result;",
    "};",
    "",
    "HistoryEntry history[MAX_HISTORY];",
    "int historyCount = 0;",
    "",
    "void addHistory(char op, double a, double b, double result) {",
    "    if (historyCount < MAX_HISTORY) {",
    "        history[historyCount++] = {op, a, b, result};",
    "    } else {",
    "        for (int i = 1; i < MAX_HISTORY; ++i) history[i - 1] = history[i];",
    "        history[MAX_HISTORY - 1] = {op, a, b, result};",
    "    }",
    "}",
    "",
    "void printHistory() {",
    "    if (historyCount == 0) {",
    "        std::cout << \"（暂无历史记录）\\n\";",
    "        return;",
    "    }",
    "    std::cout << \"----- 历史记录 -----\\n\";",
    "    for (int i = 0; i < historyCount; ++i) {",
    "        const HistoryEntry& h = history[i];",
    "        std::cout << (i + 1) << \". \";",
    "        switch (h.op) {",
    "            case '+': std::cout << h.a << \" + \" << h.b << \" = \" << h.result; break;",
    "            case '-': std::cout << h.a << \" - \" << h.b << \" = \" << h.result; break;",
    "            case '*': std::cout << h.a << \" * \" << h.b << \" = \" << h.result; break;",
    "            case '/': std::cout << h.a << \" / \" << h.b << \" = \" << h.result; break;",
    "            case '%': std::cout << (long long)h.a << \" % \" << (long long)h.b << \" = \" << h.result; break;",
    "            case '^': std::cout << h.a << \" ^ \" << h.b << \" = \" << h.result; break;",
    "            case 's': std::cout << \"sqrt(\" << h.a << \") = \" << h.result; break;",
    "            case 'a': std::cout << \"|\" << h.a << \"| = \" << h.result; break;",
    "            case 'f': std::cout << (long long)h.a << \"! = \" << h.result; break;",
    "            case 'M': std::cout << \"max(\" << h.a << \", \" << h.b << \") = \" << h.result; break;",
    "            case 'm': std::cout << \"min(\" << h.a << \", \" << h.b << \") = \" << h.result; break;",
    "        }",
    "        std::cout << \"\\n\";",
    "    }",
    "}",
    "",
    "// ==================== 输入辅助 ====================",
    "",
    "bool readOperand(double& val, bool hasLast, double last, const char* prompt) {",
    "    std::cout << prompt;",
    "    char buf[64];",
    "    if (!readToken(buf, 64)) {",
    "        std::cin.clear();",
    "        return false;",
    "    }",
    "    if (strEq(buf, \"a\") || strEq(buf, \"ans\")) {",
    "        if (hasLast) {",
    "            val = last;",
    "            std::cout << \"（使用上次结果 \" << last << \"）\\n\";",
    "            return true;",
    "        }",
    "        std::cout << \"还没有上次结果。\\n\";",
    "        return false;",
    "    }",
    "    bool ok;",
    "    val = strToDouble(buf, ok);",
    "    if (!ok) { std::cout << \"输入无效，请输入数字或 a。\\n\"; return false; }",
    "    return true;",
    "}",
    "",
    "// ==================== 主程序 ====================",
    "",
    "int main() {",
    "    double lastResult = 0;",
    "    bool hasLast = false;",
    "",
    "    std::cout << \"===== 多功能计算器 =====\\n\";",
    "    std::cout << \"提示：输入 a 可使用上次结果。\\n\";",
    "",
    "    while (true) {",
    "        std::cout << \"\\n----- 菜单 -----\\n\";",
    "        if (hasLast) std::cout << \"上次结果: \" << lastResult << \"\\n\";",
    "        std::cout << \" 1. 加法 (+)\\n\";",
    "        std::cout << \" 2. 减法 (-)\\n\";",
    "        std::cout << \" 3. 乘法 (*)\\n\";",
    "        std::cout << \" 4. 除法 (/)\\n\";",
    "        std::cout << \" 5. 取模 (%)\\n\";",
    "        std::cout << \" 6. 幂运算 (^)\\n\";",
    "        std::cout << \" 7. 平方根 (sqrt)\\n\";",
    "        std::cout << \" 8. 绝对值 (|x|)\\n\";",
    "        std::cout << \" 9. 阶乘 (n!)\\n\";",
    "        std::cout << \"10. 最大值\\n\";",
    "        std::cout << \"11. 最小值\\n\";",
    "        std::cout << \"12. 查看历史记录\\n\";",
    "        std::cout << \"13. 清空历史记录\\n\";",
    "        std::cout << \" 0. 退出\\n\";",
    "",
    "        std::cout << \"请选择操作: \";",
    "        int choice;",
    "        if (!(std::cin >> choice)) {",
    "            std::cin.clear();",
    "            std::cin.ignore(10000, '\\n');",
    "            std::cout << \"无效输入。\\n\";",
    "            continue;",
    "        }",
    "",
    "        if (choice == 0) break;",
    "",
    "        double a, b, result;",
    "        char op = '?';",
    "",
    "        switch (choice) {",
    "            case 1: case 2: case 3: case 4: case 5: case 6: case 10: case 11: {",
    "                if (!readOperand(a, hasLast, lastResult, \"第一个数: \")) break;",
    "                if (!readOperand(b, hasLast, lastResult, \"第二个数: \")) break;",
    "                bool ok = true;",
    "                switch (choice) {",
    "                    case 1: result = a + b; op = '+'; break;",
    "                    case 2: result = a - b; op = '-'; break;",
    "                    case 3: result = a * b; op = '*'; break;",
    "                    case 4:",
    "                        if (b == 0) { std::cout << \"除数不能为 0。\\n\"; ok = false; break; }",
    "                        result = a / b; op = '/'; break;",
    "                    case 5: {",
    "                        long long ia = (long long)a;",
    "                        long long ib = (long long)b;",
    "                        if (ib == 0) { std::cout << \"取模的除数不能为 0。\\n\"; ok = false; break; }",
    "                        result = (double)(ia % ib);",
    "                        a = (double)ia; b = (double)ib;",
    "                        op = '%'; break;",
    "                    }",
    "                    case 6: {",
    "                        double rb = b >= 0 ? (double)(long long)(b + 0.5)",
    "                                           : (double)(long long)(b - 0.5);",
    "                        if (a < 0 && myAbs(b - rb) > 1e-9) {",
    "                            std::cout << \"底数为负时指数必须为整数。\\n\";",
    "                            ok = false; break;",
    "                        }",
    "                        result = myPow(a, b); op = '^'; break;",
    "                    }",
    "                    case 10: result = a > b ? a : b; op = 'M'; break;",
    "                    case 11: result = a < b ? a : b; op = 'm'; break;",
    "                }",
    "                if (!ok) break;",
    "                std::cout << \"结果: \" << result << \"\\n\";",
    "                addHistory(op, a, b, result);",
    "                lastResult = result; hasLast = true;",
    "                break;",
    "            }",
    "            case 7: case 8: case 9: {",
    "                if (choice == 9) {",
    "                    if (!readOperand(a, hasLast, lastResult, \"输入整数 n: \")) break;",
    "                    long long n = (long long)a;",
    "                    if (myAbs(a - (double)n) > 1e-9 || n < 0) {",
    "                        std::cout << \"阶乘要求非负整数。\\n\"; break;",
    "                    }",
    "                    if (n > 170) { std::cout << \"数值过大（最大 170!）。\\n\"; break; }",
    "                    result = myFact((int)n);",
    "                    op = 'f';",
    "                } else {",
    "                    if (!readOperand(a, hasLast, lastResult, \"输入数字: \")) break;",
    "                    if (choice == 7) {",
    "                        if (a < 0) { std::cout << \"负数不能开平方根。\\n\"; break; }",
    "                        result = mySqrt(a); op = 's';",
    "                    } else {",
    "                        result = myAbs(a); op = 'a';",
    "                    }",
    "                }",
    "                std::cout << \"结果: \" << result << \"\\n\";",
    "                addHistory(op, a, 0, result);",
    "                lastResult = result; hasLast = true;",
    "                break;",
    "            }",
    "            case 12:",
    "                printHistory();",
    "                break;",
    "            case 13:",
    "                historyCount = 0;",
    "                std::cout << \"历史记录已清空。\\n\";",
    "                break;",
    "            default:",
    "                std::cout << \"无效选择。\\n\";",
    "        }",
    "    }",
    "",
    "    std::cout << \"计算器已退出。\\n\";",
    "    return 0;",
    "}"
  ].join('\n');

  TC.STR_EXAMPLE = [    '#include <iostream>',
    '#include <string>',
    'using namespace std;',
    '',
    'int main() {',
    '    string name;',
    '    cout << "你叫什么名字？";',
    '    cin >> name;                       // 读一个词（遇到空白停）',
    '',
    '    string hello = "你好，" + name + "！";',
    '    cout << hello << endl;',
    '    cout << "字节长度: " << hello.length() << endl;',
    '',
    '    string line;',
    '    getline(cin, line);                // 吃掉 cin >> 留下的换行（空行）',
    '    getline(cin, line);                // 再读一整行',
    '    cout << "整行: " << line << endl;',
    '',
    '    string head = line.substr(0, 3);',
    '    cout << "前三个字节: " << head;',
    '    if (line.find(\'a\') != 255) { cout << "（含 a）"; }',
    '    cout << endl;',
    '',
    '    line += "!";',
    '    line.push_back(\'?\');',
    '    cout << "追加后: " << line << " / " << line.size();',
    '    return 0;',
    '}'
  ].join('\n');
  TC.LANG_NAME = LANG_NAME;
})(window.TC = window.TC || {});
