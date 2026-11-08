/* =========================================================================
 * tc/stdlib.js —— 标准头文件 / 标准库函数支持
 *
 * BrainFuck 里不可能链接真实的 libc / libstdc++，所以这里的做法是：
 *   1. 收录常见 C / C++ 标准头文件，#include 不再是「静默丢弃」；
 *   2. 把常用库函数用「本编译器自己支持的 C 子集」写成源码（下称 prelude），
 *      单独 parse 一次后并入函数表 —— 于是它们走的是和手写函数完全相同的
 *      「调用点内联展开」管线，codegen 层零改动；
 *   3. 支持 #define 常量宏与 RAND_MAX / NULL / true 这类内置常量。
 *
 * 随机数是 8 位 LCG：seed = seed * 13 + 57（A≡1 mod 4、C 奇数 → 满周期 256）。
 * 低位 LCG 的低 2 位是等差的，所以返回前做一次「2 位循环旋转」
 *   seed / 4 + (seed % 4) * 64
 * 把规律位挪到高位，rand() % 10 之类的分布才不会一眼看出周期。
 * ========================================================================= */
(function (TC) {
  'use strict';

  /* ---------------- 内置常量（另有 #define 用户宏） ---------------- */
  var SEED = '__bf_seed';      /* 随机种子：跨调用点共享的全局变量 */

  var CONSTS = {
    NULL: 0, nullptr: 0, EOF: 0,
    true: 1, false: 0,
    RAND_MAX: 255, CHAR_MAX: 255, UCHAR_MAX: 255,
    SCHAR_MAX: 127, INT_MAX: 255, UINT_MAX: 255,
    CHAR_BIT: 8, EXIT_SUCCESS: 0, EXIT_FAILURE: 1,
    M_PI: 3
  };

  /* ---------------- 库函数实现 ----------------
   * src  必须是本编译器支持的 C 子集：一级指针可用；数组按定长支持，循环内的 return 可用。
   * deps 是依赖闭包，needed() 会自动把被依赖的函数一起带上。
   * ORDER 是生成顺序：被调用的函数必须排在调用者之前（parser 边解析边登记）。
   */
  var FUNCS = {
    srand: {
      sig: 'void srand(char seed)',
      desc: '设置随机种子',
      header: 'cstdlib',
      deps: [],
      src: 'void srand(char s) { __bf_seed = s; }'
    },
    rand: {
      sig: 'char rand()',
      desc: '返回 0–255 的伪随机数（8 位 LCG，周期 256）',
      header: 'cstdlib',
      deps: [],
      src: 'char rand() { __bf_seed = __bf_seed * 13 + 57; return __bf_seed / 4 + (__bf_seed % 4) * 64; }'
    },
    randint: {
      sig: 'char randint(char lo, char hi)',
      desc: '返回 [lo, hi] 区间内的随机整数（便捷函数，非标准）',
      header: 'random',
      deps: ['rand'],
      src: 'char randint(char lo, char hi) { return lo + rand() % (hi - lo + 1); }'
    },
    uniform: {
      sig: 'char uniform(char lo, char hi)',
      desc: 'randint 的别名，对应 uniform_int_distribution 的简化写法',
      header: 'random',
      deps: ['randint'],
      src: 'char uniform(char lo, char hi) { return randint(lo, hi); }'
    },
    random: {
      sig: 'char random()',
      desc: 'POSIX 风格的 rand() 别名',
      header: 'random',
      deps: ['rand'],
      src: 'char random() { return rand(); }'
    },
    srandom: {
      sig: 'void srandom(char seed)',
      desc: 'POSIX 风格的 srand() 别名',
      header: 'random',
      deps: ['srand'],
      src: 'void srandom(char s) { srand(s); }'
    },
    randbool: {
      sig: 'char randbool()',
      desc: '返回 0 或 1 的随机布尔值',
      header: 'random',
      deps: ['rand'],
      src: 'char randbool() { return rand() % 2; }'
    },
    time: {
      sig: 'char time(char x)',
      desc: 'BF 没有系统时钟，固定返回 0（可传 NULL / nullptr / 0）；随机性改由「输入熵」提供',
      header: 'ctime',
      deps: [],
      src: 'char time(char x) { return 0; }'
    },
    clock: {
      sig: 'char clock()',
      desc: 'BF 没有系统时钟，固定返回 0；随机性改由「输入熵」提供',
      header: 'ctime',
      deps: [],
      src: 'char clock() { return 0; }'
    },

    /* <cctype> / <ctype.h> */
    islower: {
      sig: 'char islower(char c)', desc: '小写字母判定', header: 'cctype', deps: [],
      src: "char islower(char c) { if (c >= 'a' && c <= 'z') { return 1; } return 0; }"
    },
    isupper: {
      sig: 'char isupper(char c)', desc: '大写字母判定', header: 'cctype', deps: [],
      src: "char isupper(char c) { if (c >= 'A' && c <= 'Z') { return 1; } return 0; }"
    },
    isdigit: {
      sig: 'char isdigit(char c)', desc: '数字字符判定', header: 'cctype', deps: [],
      src: "char isdigit(char c) { if (c >= '0' && c <= '9') { return 1; } return 0; }"
    },
    isalpha: {
      sig: 'char isalpha(char c)', desc: '字母判定', header: 'cctype', deps: ['islower', 'isupper'],
      src: 'char isalpha(char c) { if (islower(c) || isupper(c)) { return 1; } return 0; }'
    },
    isalnum: {
      sig: 'char isalnum(char c)', desc: '字母或数字判定', header: 'cctype', deps: ['isalpha', 'isdigit'],
      src: 'char isalnum(char c) { if (isalpha(c) || isdigit(c)) { return 1; } return 0; }'
    },
    toupper: {
      sig: 'char toupper(char c)', desc: '转大写', header: 'cctype', deps: ['islower'], out: 'char',
      src: "char toupper(char c) { if (islower(c)) { return c - 32; } return c; }"
    },
    tolower: {
      sig: 'char tolower(char c)', desc: '转小写', header: 'cctype', deps: ['isupper'], out: 'char',
      src: "char tolower(char c) { if (isupper(c)) { return c + 32; } return c; }"
    },

    isspace: {
      sig: 'char isspace(char c)', desc: '空白字符判定（空格 / \\t / \\n / \\r / \\v / \\f）',
      header: 'cctype', deps: [],
      src: "char isspace(char c) { if (c == ' ' || (c >= 9 && c <= 13)) { return 1; } return 0; }"
    },
    isblank: {
      sig: 'char isblank(char c)', desc: '空格或水平制表符判定',
      header: 'cctype', deps: [],
      src: "char isblank(char c) { if (c == ' ' || c == 9) { return 1; } return 0; }"
    },
    isxdigit: {
      sig: 'char isxdigit(char c)', desc: '十六进制数字字符判定',
      header: 'cctype', deps: ['isdigit'],
      src: "char isxdigit(char c) { if (isdigit(c)) { return 1; } if (c >= 'a' && c <= 'f') { return 1; } if (c >= 'A' && c <= 'F') { return 1; } return 0; }"
    },
    ispunct: {
      sig: 'char ispunct(char c)', desc: '可打印标点符号判定',
      header: 'cctype', deps: ['isalnum'],
      src: 'char ispunct(char c) { if (isalnum(c)) { return 0; } if (c >= 33 && c <= 126) { return 1; } return 0; }'
    },
    isprint: {
      sig: 'char isprint(char c)', desc: '可打印字符（32..126）判定',
      header: 'cctype', deps: [],
      src: 'char isprint(char c) { if (c >= 32 && c <= 126) { return 1; } return 0; }'
    },
    isgraph: {
      sig: 'char isgraph(char c)', desc: '除空格外的可打印字符（33..126）判定',
      header: 'cctype', deps: [],
      src: 'char isgraph(char c) { if (c >= 33 && c <= 126) { return 1; } return 0; }'
    },
    iscntrl: {
      sig: 'char iscntrl(char c)', desc: '控制字符（0..31 / 127）判定',
      header: 'cctype', deps: [],
      src: 'char iscntrl(char c) { if (c < 32) { return 1; } if (c == 127) { return 1; } return 0; }'
    },
    fabs: {
      sig: 'char fabs(char x)', desc: 'abs 的浮点别名（按 8 位绝对值处理）',
      header: 'cmath', deps: ['abs'],
      src: 'char fabs(char x) { return abs(x); }'
    },
    labs: {
      sig: 'char labs(char x)', desc: 'abs 的 long 别名（8 位）',
      header: 'cstdlib', deps: ['abs'],
      src: 'char labs(char x) { return abs(x); }'
    },
    llabs: {
      sig: 'char llabs(char x)', desc: 'abs 的 long long 别名（8 位）',
      header: 'cstdlib', deps: ['abs'],
      src: 'char llabs(char x) { return abs(x); }'
    },

    /* <cmath> / <math.h>、<algorithm>、<numeric> */
    swap: {
      sig: 'void swap(int& a, int& b)',
      desc: '交换两个变量（真引用：内联后直接作用在实参上）',
      header: 'utility',
      deps: [],
      src: 'void swap(int& a, int& b) { int t = a; a = b; b = t; }'
    },
    abs: {
      sig: 'char abs(char x)', desc: '8 位补码绝对值（>127 视为负数）', header: 'cstdlib', deps: [],
      src: 'char abs(char x) { if (x >= 128) { return 0 - x; } return x; }'
    },
    min: {
      sig: 'char min(char a, char b)', desc: '较小值', header: 'algorithm', deps: [],
      src: 'char min(char a, char b) { if (a < b) { return a; } return b; }'
    },
    max: {
      sig: 'char max(char a, char b)', desc: '较大值', header: 'algorithm', deps: [],
      src: 'char max(char a, char b) { if (a > b) { return a; } return b; }'
    },
    clamp: {
      sig: 'char clamp(char x, char lo, char hi)', desc: '夹到 [lo, hi]', header: 'algorithm', deps: [],
      src: 'char clamp(char x, char lo, char hi) { if (x < lo) { return lo; } if (x > hi) { return hi; } return x; }'
    },
    gcd: {
      sig: 'char gcd(char a, char b)', desc: '最大公约数（欧几里得）', header: 'numeric', deps: [],
      src: 'char gcd(char a, char b) { while (b) { char t = b; b = a % b; a = t; } return a; }'
    },
    sqrt: {
      sig: 'char sqrt(char x)', desc: '整数平方根（向下取整）', header: 'cmath', deps: [],
      src: 'char sqrt(char x) { char r = 0; char i = 1; while (i < 16) { if (i * i <= x) { r = i; } i++; } return r; }'
    },
    pow: {
      sig: 'char pow(char a, char b)', desc: '整数幂（8 位回绕）', header: 'cmath', deps: [],
      src: 'char pow(char a, char b) { char r = 1; char i = 0; while (i < b) { r = r * a; i++; } return r; }'
    },

    /* 位运算的内部实现：BrainFuck 只有 +/-，逐位拆开算。
       常量位移在 parser 层直接转成 mul/div IR，只有位移量是变量时才用下面两个循环版。 */
    __bf_xor: {
      sig: 'char __bf_xor(char a, char b)', desc: '^ 的内部实现（8 位按位异或）',
      header: '', internal: true, deps: [],
      src: 'char __bf_xor(char a, char b) { char r = 0; char w = 1; char k = 0; while (k < 8) { char ab = a % 2; char bb = b % 2; if (ab != bb) { r += w; } a = a / 2; b = b / 2; w = w + w; k++; } return r; }'
    },
    __bf_and: {
      sig: 'char __bf_and(char a, char b)', desc: '& 的内部实现（8 位按位与）',
      header: '', internal: true, deps: [],
      src: 'char __bf_and(char a, char b) { char r = 0; char w = 1; char k = 0; while (k < 8) { if (a % 2 + b % 2 == 2) { r += w; } a = a / 2; b = b / 2; w = w + w; k++; } return r; }'
    },
    __bf_or: {
      sig: 'char __bf_or(char a, char b)', desc: '| 的内部实现（8 位按位或）',
      header: '', internal: true, deps: [],
      src: 'char __bf_or(char a, char b) { char r = 0; char w = 1; char k = 0; while (k < 8) { if (a % 2 + b % 2 > 0) { r += w; } a = a / 2; b = b / 2; w = w + w; k++; } return r; }'
    },
    __bf_not: {
      sig: 'char __bf_not(char a)', desc: '~ 的内部实现（8 位按位取反）',
      header: '', internal: true, deps: [],
      src: 'char __bf_not(char a) { return 255 - a; }'
    },
    __bf_shl: {
      sig: 'char __bf_shl(char a, char b)', desc: '<< 的内部实现（变量位移量，8 位回绕）',
      header: '', internal: true, deps: [],
      src: 'char __bf_shl(char a, char b) { char i = 0; while (i < b) { a = a + a; i++; } return a; }'
    },
    __bf_shr: {
      sig: 'char __bf_shr(char a, char b)', desc: '>> 的内部实现（变量位移量，逻辑右移）',
      header: '', internal: true, deps: [],
      src: 'char __bf_shr(char a, char b) { char i = 0; while (i < b) { a = a / 2; i++; } return a; }'
    }
  };

  var ORDER = ['srand', 'rand', 'randint', 'uniform', 'random', 'srandom', 'randbool',
               'time', 'clock',
               'islower', 'isupper', 'isdigit', 'isalpha', 'isalnum',
               'toupper', 'tolower',
               'isspace', 'isblank', 'isxdigit', 'ispunct',
               'isprint', 'isgraph', 'iscntrl',
               'swap', 'abs', 'labs', 'llabs', 'fabs',
               'min', 'max', 'clamp', 'gcd', 'sqrt', 'pow',
               '__bf_xor', '__bf_and', '__bf_or', '__bf_not', '__bf_shl', '__bf_shr'];

  /* ---------------- 头文件表 ----------------
   * state: 'ok'      该头文件的函数可用
   *        'partial' 头文件认识，但只有部分能力（类型 / 常量 / 忽略型函数）
   *        'none'    识别但不支持（容器、流、模板等）
   * funcs: 该头文件提供的可用函数（UI 展示用，不影响实际启用）
   */
  var HEADERS = {
    /* 输入输出 */
    'stdio.h':    { title: '标准输入输出', state: 'ok',      funcs: ['printf', 'scanf', 'putchar', 'getchar', 'putc'], pair: 'cstdio' },
    'cstdio':     { title: '标准输入输出', state: 'ok',      funcs: ['printf', 'scanf', 'putchar', 'getchar', 'putc'], pair: 'stdio.h' },
    'iostream':   { title: 'C++ 流输入输出', state: 'ok',   funcs: ['cout', 'cin', 'endl'], pair: '' },
    'iomanip':    { title: '流格式控制', state: 'none',     funcs: [], pair: '' },
    'sstream':    { title: '字符串流', state: 'none',       funcs: [], pair: '' },
    'fstream':    { title: '文件流', state: 'none',         funcs: [], pair: '' },
    'ostream':    { title: '输出流', state: 'none',         funcs: [], pair: '' },
    'istream':    { title: '输入流', state: 'none',         funcs: [], pair: '' },

    /* 标准库 / 随机 */
    'stdlib.h':   { title: '标准库 · 随机数', state: 'ok',   funcs: ['rand', 'srand', 'abs', 'labs', 'llabs', 'atoi', 'RAND_MAX'], pair: 'cstdlib' },
    'cstdlib':    { title: '标准库 · 随机数', state: 'ok',   funcs: ['rand', 'srand', 'abs', 'labs', 'llabs', 'atoi', 'RAND_MAX'], pair: 'stdlib.h' },
    'random':     { title: 'C++ 随机数（函数式）', state: 'ok', funcs: ['rand', 'srand', 'random', 'srandom', 'randint', 'uniform', 'randbool', 'RAND_MAX'], pair: '' },
    'time.h':     { title: '时间 · 固定返回 0', state: 'ok', funcs: ['time', 'clock'], pair: 'ctime' },
    'ctime':      { title: '时间 · 固定返回 0', state: 'ok', funcs: ['time', 'clock'], pair: 'time.h' },
    'chrono':     { title: '时钟（无系统时钟，链式调用降级为 0）', state: 'none', funcs: [], pair: '' },

    /* 字符 */
    'ctype.h':    { title: '字符分类与转换', state: 'ok',    funcs: ['isdigit', 'isalpha', 'isalnum', 'islower', 'isupper', 'toupper', 'tolower', 'isspace', 'isblank', 'isxdigit', 'ispunct', 'isprint', 'isgraph', 'iscntrl'], pair: 'cctype' },
    'cctype':     { title: '字符分类与转换', state: 'ok',    funcs: ['isdigit', 'isalpha', 'isalnum', 'islower', 'isupper', 'toupper', 'tolower', 'isspace', 'isblank', 'isxdigit', 'ispunct', 'isprint', 'isgraph', 'iscntrl'], pair: 'ctype.h' },
    'cwctype':    { title: '宽字符分类', state: 'none',      funcs: [], pair: '' },

    /* 数学与算法 */
    'math.h':     { title: '数学函数（整数版）', state: 'ok', funcs: ['abs', 'labs', 'llabs', 'fabs', 'pow', 'sqrt', 'min', 'max', 'clamp', 'floor', 'ceil', 'round', 'trunc'], pair: 'cmath' },
    'cmath':      { title: '数学函数（整数版）', state: 'ok', funcs: ['abs', 'labs', 'llabs', 'fabs', 'pow', 'sqrt', 'min', 'max', 'clamp', 'floor', 'ceil', 'round', 'trunc'], pair: 'math.h' },
    'algorithm':  { title: '常用算法', state: 'ok',          funcs: ['min', 'max', 'clamp'], pair: '' },
    'numeric':    { title: '数值算法', state: 'ok',          funcs: ['gcd'], pair: '' },
    'utility':    { title: '工具（swap 交换两个变量）', state: 'ok', funcs: ['swap'], pair: '' },
    'functional': { title: '函数对象', state: 'none',        funcs: [], pair: '' },
    'limits':     { title: '数值极限', state: 'partial',     funcs: ['CHAR_MAX', 'INT_MAX'], pair: 'limits.h' },
    'complex':    { title: '复数', state: 'none',            funcs: [], pair: '' },

    /* 类型 / 常量 */
    'stdint.h':   { title: '定宽整数类型（int32_t / int32 为 32 位有符号，其余按 8 位）', state: 'partial', funcs: ['uint8_t', 'int8_t', 'uint16_t', 'uint32_t', 'uint64_t', 'int64_t', 'int32_t'], pair: 'cstdint' },
    'cstdint':    { title: '定宽整数类型（int32_t / int32 为 32 位有符号，其余按 8 位）', state: 'partial', funcs: ['uint8_t', 'int8_t', 'uint16_t', 'uint32_t', 'uint64_t', 'int64_t', 'int32_t'], pair: 'stdint.h' },
    'stdbool.h':  { title: '布尔常量', state: 'partial',     funcs: ['true', 'false'], pair: 'cstdbool' },
    'cstdbool':   { title: '布尔常量', state: 'partial',     funcs: ['true', 'false'], pair: 'stdbool.h' },
    'limits.h':   { title: '整数常量', state: 'partial',     funcs: ['CHAR_MAX', 'UCHAR_MAX', 'INT_MAX'], pair: 'climits' },
    'climits':    { title: '整数常量', state: 'partial',     funcs: ['CHAR_MAX', 'UCHAR_MAX', 'INT_MAX'], pair: 'limits.h' },
    'float.h':    { title: '浮点常量（float / double 本身已支持，定点数实现）', state: 'partial', funcs: [], pair: 'cfloat' },
    'cfloat':     { title: '浮点常量（float / double 本身已支持，定点数实现）', state: 'partial', funcs: [], pair: 'float.h' },
    'stddef.h':   { title: 'size_t / NULL', state: 'partial', funcs: ['size_t', 'NULL'], pair: 'cstddef' },
    'cstddef':    { title: 'size_t / NULL', state: 'partial', funcs: ['size_t', 'NULL'], pair: 'stddef.h' },
    'type_traits':{ title: '类型特征', state: 'none',        funcs: [], pair: '' },
    'initializer_list': { title: '初始化列表', state: 'none', funcs: [], pair: '' },

    /* C 字符串函数：strlen 已实现（字面量 / std::string / char 数组），
       其余靠指针的 strcpy/strcmp 仍在子集外 */
    'string.h':   { title: 'C 字符串（strlen 可用，strcpy/strcmp 等靠指针的不支持）', state: 'partial', funcs: ['strlen'], pair: 'cstring' },
    'cstring':    { title: 'C 字符串（strlen 可用，strcpy/strcmp 等靠指针的不支持）', state: 'partial', funcs: ['strlen'], pair: 'string.h' },
    'string':     { title: 'std::string（定长 32 字节）', state: 'ok', funcs: ['to_string', 'stoi', 'getline'], pair: '' },
    'cwchar':     { title: '宽字符', state: 'none',          funcs: [], pair: '' },

    /* 容器 / 其它 */
    'assert.h':   { title: '断言（忽略）', state: 'partial', funcs: [], pair: 'cassert' },
    'cassert':    { title: '断言（忽略）', state: 'partial', funcs: [], pair: 'assert.h' },
    'errno.h':    { title: '错误码', state: 'partial',       funcs: [], pair: 'cerrno' },
    'cerrno':     { title: '错误码', state: 'partial',       funcs: [], pair: 'errno.h' },
    'signal.h':   { title: '信号', state: 'none',            funcs: [], pair: 'csignal' },
    'csignal':    { title: '信号', state: 'none',            funcs: [], pair: 'signal.h' },
    'stdarg.h':   { title: '可变参数', state: 'none',        funcs: [], pair: 'cstdarg' },
    'cstdarg':    { title: '可变参数', state: 'none',        funcs: [], pair: 'stdarg.h' },
    'setjmp.h':   { title: '非局部跳转', state: 'none',      funcs: [], pair: 'csetjmp' },
    'locale.h':   { title: '本地化', state: 'none',          funcs: [], pair: 'clocale' },
    'vector':     { title: '动态数组（不支持）', state: 'none', funcs: [], pair: '' },
    'array':      { title: '定长数组（不支持）', state: 'none', funcs: [], pair: '' },
    'map':        { title: '映射（不支持）', state: 'none',   funcs: [], pair: '' },
    'set':        { title: '集合（不支持）', state: 'none',   funcs: [], pair: '' },
    'unordered_map': { title: '哈希映射（不支持）', state: 'none', funcs: [], pair: '' },
    'deque':      { title: '双端队列（不支持）', state: 'none', funcs: [], pair: '' },
    'list':       { title: '链表（不支持）', state: 'none',   funcs: [], pair: '' },
    'queue':      { title: '队列（不支持）', state: 'none',   funcs: [], pair: '' },
    'stack':      { title: '栈（不支持）', state: 'none',     funcs: [], pair: '' },
    'tuple':      { title: '元组（不支持）', state: 'none',   funcs: [], pair: '' },
    'memory':     { title: '智能指针（不支持）', state: 'none', funcs: [], pair: '' },
    'new':        { title: '动态内存（不支持）', state: 'none', funcs: [], pair: '' },
    'iterator':   { title: '迭代器（不支持）', state: 'none', funcs: [], pair: '' },
    'exception':  { title: '异常（不支持）', state: 'none',   funcs: [], pair: '' },
    'stdexcept':  { title: '标准异常（不支持）', state: 'none', funcs: [], pair: '' },
    'thread':     { title: '线程（不支持）', state: 'none',   funcs: [], pair: '' },
    'mutex':      { title: '互斥量（不支持）', state: 'none', funcs: [], pair: '' },
    'atomic':     { title: '原子操作（不支持）', state: 'none', funcs: [], pair: '' },
    'stdatomic.h':{ title: 'C 原子操作（不支持）', state: 'none', funcs: [], pair: '' },
    'bitset':     { title: '位集（不支持位运算）', state: 'none', funcs: [], pair: '' },
    'valarray':   { title: '数值数组（不支持）', state: 'none', funcs: [], pair: '' },
    'regex':      { title: '正则表达式（不支持）', state: 'none', funcs: [], pair: '' },
    'optional':   { title: 'optional（不支持）', state: 'none', funcs: [], pair: '' },
    'variant':    { title: 'variant（不支持）', state: 'none', funcs: [], pair: '' },
    'any':        { title: 'any（不支持）', state: 'none', funcs: [], pair: '' },
    'string_view':{ title: '字符串视图（不支持）', state: 'none', funcs: [], pair: '' },
    'span':       { title: 'span（不支持）', state: 'none', funcs: [], pair: '' },
    'ranges':     { title: 'ranges（不支持）', state: 'none', funcs: [], pair: '' },
    'concepts':   { title: 'concepts（不支持）', state: 'none', funcs: [], pair: '' },
    'numbers':    { title: '数学常量（不支持浮点）', state: 'none', funcs: [], pair: '' },
    'bit':        { title: '位操作（不支持）', state: 'none', funcs: [], pair: '' },
    'compare':    { title: '三路比较（不支持）', state: 'none', funcs: [], pair: '' },
    'filesystem': { title: '文件系统（不支持）', state: 'none', funcs: [], pair: '' },
    'system_error': { title: '系统错误（不支持）', state: 'none', funcs: [], pair: '' },
    'typeinfo':   { title: '运行时类型信息（不支持）', state: 'none', funcs: [], pair: '' },
    'future':     { title: '异步（不支持）', state: 'none', funcs: [], pair: '' },
    'condition_variable': { title: '条件变量（不支持）', state: 'none', funcs: [], pair: '' },
    'shared_mutex': { title: '共享互斥（不支持）', state: 'none', funcs: [], pair: '' },
    'complex.h':  { title: 'C 复数（不支持）', state: 'none', funcs: [], pair: '' },
    'tgmath.h':   { title: '泛型数学（不支持）', state: 'none', funcs: [], pair: '' },
    'stdalign.h': { title: '对齐（不支持）', state: 'none', funcs: [], pair: '' },
    'inttypes.h': { title: '整数类型（不支持）', state: 'none', funcs: [], pair: '' },
    'wchar.h':    { title: '宽字符（不支持）', state: 'none', funcs: [], pair: '' },
    'iso646.h':   { title: '运算符别名（不支持）', state: 'none', funcs: [], pair: '' },
    'bits/stdc++.h': { title: 'GCC 万能头（按已收录头文件处理）', state: 'partial', funcs: [], pair: '' }
  };

  /* ---------------- 预处理 ---------------- */
  /* 抽走 #include / #define，其余 # 行也吃掉；用空行占位保持行号不变 */
  function scan(src) {
    var lines = String(src || '').split(/\r?\n/);
    var headers = [];
    var macros = Object.create(null);
    var warnings = [];
    var out = [];

    for (var i = 0; i < lines.length; i++) {
      var L = lines[i];

      var inc = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/.exec(L);
      if (inc) {
        var h = inc[1].trim();
        var quoted = /^\s*#\s*include\s*"/.test(L);
        var info = HEADERS[h] || null;
        headers.push({ name: h, line: i + 1, quoted: quoted, state: info ? info.state : 'unknown' });
        if (quoted) {
          warnings.push({ line: i + 1, message: '本地头文件 "' + h + '" 无法在浏览器里读取，已忽略' });
        } else if (!info) {
          warnings.push({ line: i + 1, message: '未收录的头文件 <' + h + '> 已忽略（点右上角「标准库」查看支持范围）' });
        }
        out.push('');
        continue;
      }

      var def = /^\s*#\s*define\s+([A-Za-z_$][\w$]*)\s+(.+?)\s*$/.exec(L);
      if (def) {
        macros[def[1]] = def[2];
        out.push('');
        continue;
      }

      if (/^\s*#/.test(L)) { out.push(''); continue; }
      out.push(L);
    }

    return {
      code: out.join('\n'),
      headers: headers,
      macros: macros,
      warnings: warnings
    };
  }

  /* 常量宏与内置常量的标识符替换：跳过字符串 / 字符常量，避免误伤。

     旧写法是「每个宏各建一条正则、各扫全文一遍」：
     3 轮 × N 个宏 × 全文长度。宏一多（CONSTS 自带 15 个）每敲一个字都要扫
     几十遍。现在把整张表合成一条交替正则，一轮只扫一遍，正则本身按
     「键集合」缓存，输入不变时连 RegExp 都不重建。 */
  var SUBST_RE = Object.create(null);
  var lastKeys = null, lastAlt = '';

  function altFor(keys) {
    var sig = keys.join('\u0000');
    if (sig === lastKeys) return lastAlt;
    /* 长的排前面：INT_MAX 与 INT_MAX2 这类前缀冲突时先试长的，少一轮回溯 */
    var alt = keys.slice().sort(function (a, b) { return b.length - a.length; })
      .map(function (k) {
        return k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }).join('|');
    lastKeys = sig;
    lastAlt = alt;
    return alt;
  }

  function substRe(keys) {
    var sig = keys.join('\u0000');
    var re = SUBST_RE[sig];
    if (!re) {
      re = new RegExp('(^|[^\\w$])(' + altFor(keys) + ')(?![\\w$])', 'g');
      SUBST_RE[sig] = re;
    }
    return re;
  }

  function subst(code, macros) {
    var table = Object.create(null);
    Object.keys(CONSTS).forEach(function (k) { table[k] = String(CONSTS[k]); });
    Object.keys(macros || {}).forEach(function (k) { table[k] = macros[k]; });

    var keys = Object.keys(table);
    if (!keys.length) return code;

    var parts = String(code).split(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g);
    var re = substRe(keys);

    /* 多轮展开：#define M N + 1 里的 N 也要跟着被替换掉。
       固定 3 轮足够收敛，自引用宏不会无限膨胀。 */
    for (var round = 0; round < 3; round++) {
      var changed = false;
      for (var i = 0; i < parts.length; i += 2) {
        var before = parts[i];
        if (!before) continue;
        re.lastIndex = 0;
        parts[i] = before.replace(re, function (m, pre, key) {
          var v = table[key];
          return v === undefined ? m : pre + '(' + v + ')';
        });
        if (parts[i] !== before) changed = true;
      }
      if (!changed) break;
    }
    return parts.join('');
  }

  /* 从 prelude 源码推出函数签名：解析阶段需要先知道「有几个参数 / 返回类型」，
     否则 callInExpr 在查函数表时就会报未定义。
     签名是常量数据，按函数名缓存一次即可（原来每次编译都重新正则匹配）。 */
  var SIG_CACHE = Object.create(null);

  function signatures(used) {
    var out = Object.create(null);
    used.forEach(function (n) {
      var sig = SIG_CACHE[n];
      if (!sig) {
        var m = /^\s*(void|char|int)\s+\w+\s*\(([^)]*)\)/.exec(FUNCS[n].src);
        if (!m) return;
        var argText = m[2].trim();
        var parts = (!argText || argText === 'void') ? [] : argText.split(',');
        sig = SIG_CACHE[n] = {
          arity: parts.length,
          /* 哪些形参是引用（int& a）—— 调用点必须传变量本身而不是值 */
          refs: parts.map(function (t) { return t.indexOf('&') >= 0; }),
          ret: m[1] === 'void' ? 'void' : 'char',
          /* C++ 里 max/rand/isdigit 返回 int（cout 打数字），toupper 返回 char */
          out: FUNCS[n].out || 'int'
        };
      }
      out[n] = sig;
    });
    return out;
  }

  /* 扫「哪些库函数被用到」之前，先抹掉注释与字符串字面量：
     否则注释里的一句 rand() 或 max() 也会把整个函数体拉进 prelude。 */
  function stripNonCode(src) {
    return String(src)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/"(?:\\.|[^"\\])*"/g, '""')
      .replace(/'(?:\\.|[^'\\])*'/g, "''");
  }

  /* 源码里实际用到的库函数（排除用户自己定义的同名函数）+ 依赖闭包 */
  var NEED_RE = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  var FUNC_SET = null;

  function needed(code, defined) {
    var hit = Object.create(null);
    var clean = stripNonCode(code);
    if (!FUNC_SET) {
      FUNC_SET = Object.create(null);
      ORDER.forEach(function (n) { FUNC_SET[n] = 1; });
    }

    /* 一次扫描收集所有「标识符 + (」，再和库函数名单对表；
       原来是给 23 个函数名各建一条正则全文扫一遍。 */
    NEED_RE.lastIndex = 0;
    var m;
    while ((m = NEED_RE.exec(clean))) {
      var name = m[1];
      if (!FUNC_SET[name]) continue;
      if (defined && defined[name]) continue;
      hit[name] = 1;
    }

    var changed = true;
    while (changed) {
      changed = false;
      ORDER.forEach(function (name) {
        if (!hit[name]) return;
        (FUNCS[name].deps || []).forEach(function (d) {
          if (!hit[d] && !(defined && defined[d])) { hit[d] = 1; changed = true; }
        });
      });
    }
    return ORDER.filter(function (n) { return hit[n]; });
  }

  /* 这个程序是否带有随机数种子单元格（编译器据此决定是否注入输入熵） */
  function needsSeed(used) {
    return ['srand', 'rand', 'randint', 'uniform'].some(function (n) {
      return used.indexOf(n) >= 0;
    });
  }

  /* 生成 prelude 源码：全局随机种子 + 按依赖顺序排列的函数定义 */
  var PRELUDE_CACHE = Object.create(null);

  function preludeFor(used) {
    /* 登记共享全局（幂等）：页面里 stdlib.js 早于 inline.js 加载，
       装载期注册会落空，必须等到真正编译时再登记。 */
    if (needsSeed(used) && TC.Inline && TC.Inline.share) TC.Inline.share(SEED);

    var key = used.join(',');
    if (used.length && PRELUDE_CACHE[key] !== undefined) return PRELUDE_CACHE[key];

    var lines = [];
    if (needsSeed(used)) lines.push('char ' + SEED + ' = 1;');
    used.forEach(function (n) { lines.push(FUNCS[n].src); });
    var text = lines.join('\n');
    PRELUDE_CACHE[key] = text;
    return text;
  }

  /* UI 速查表数据 */
  function catalog() {
    return {
      headers: HEADERS,
      funcs: ORDER.filter(function (n) { return !FUNCS[n].internal; }).map(function (n) {
        return { name: n, sig: FUNCS[n].sig, desc: FUNCS[n].desc, header: FUNCS[n].header };
      }),
      consts: CONSTS
    };
  }

  TC.Stdlib = {
    scan: scan,
    subst: subst,
    needed: needed,
    signatures: signatures,
    preludeFor: preludeFor,
    needsSeed: needsSeed,
    catalog: catalog,
    HEADERS: HEADERS,
    FUNCS: FUNCS,
    CONSTS: CONSTS,
    SEED: SEED
  };
})(window.TC = window.TC || {});
