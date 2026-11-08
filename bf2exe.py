#!/usr/bin/env python3
"""
bf2exe.py — Brainfuck → Windows x64 EXE 编译器（纯 Python，零依赖）

用法:
    python bf2exe.py <input.bf> <output.exe> [--cn] [--quiet]

选项:
    --cn / --chinese / --utf8 / -u
        编译时把控制台代码页设为 UTF-8 (65001)。
    --quiet / -q
        关闭 Info 级别日志，仅输出 Warning/Error。
    -h / --help
        显示帮助。

栈对齐说明 (修复):
    旧版入口 `and rsp, -16` 会破坏栈链（丢失返回地址），
    一旦 kernel32 内部触发 SEH，栈回溯失败导致崩溃。
    现改用标准 prologue:
        push rbp; mov rbp, rsp; sub rsp, 0x30
    保留返回地址与 saved rbp，栈链完整，SEH/调试器均可用。
"""

import struct
import sys
import logging


# ============================================================
# 日志
# ============================================================
class _Fmt(logging.Formatter):
    """将 levelname 改为首字母大写: INFO→Info, ERROR→Error"""
    def format(self, record):
        orig = record.levelname
        record.levelname = orig.capitalize()
        try:
            return super().format(record)
        finally:
            record.levelname = orig


logger = logging.getLogger('bf2exe')


def setup_logging(quiet=False):
    h = logging.StreamHandler(sys.stderr)
    h.setFormatter(_Fmt(
        fmt='%(asctime)s [%(levelname)s] %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'))
    logger.addHandler(h)
    logger.setLevel(logging.WARNING if quiet else logging.INFO)


# ============================================================
# 常量
# ============================================================
SECTION_RVA = 0x1000
FILE_ALIGN  = 0x200
SECT_ALIGN  = 0x1000
IMAGE_BASE  = 0x140000000
VALID       = set('+-<>[].,')
TAPE_SIZE   = 65536
TAPE_CENTER = 32768
UTF8_CP     = 65001


def get_funcs(utf8, has_input):
    funcs = ['GetStdHandle', 'ReadFile', 'WriteFile', 'ExitProcess']
    if utf8:
        funcs.append('SetConsoleOutputCP')
        if has_input:
            funcs.append('SetConsoleCP')
    return funcs


# ============================================================
# 前端: 合并 → Mul-loop → 死代码消除
# ============================================================
def merge_ops(src):
    ops = [c for c in src if c in VALID]
    out, i, n = [], 0, len(ops)
    while i < n:
        c = ops[i]
        if c in '+-':
            v = 0
            while i < n and ops[i] in '+-':
                v += 1 if ops[i] == '+' else -1
                i += 1
            if v:
                out.append(('add', v))
        elif c in '<>':
            v = 0
            while i < n and ops[i] in '<>':
                v += 1 if ops[i] == '>' else -1
                i += 1
            if v:
                out.append(('move', v))
        else:
            out.append((c,))
            i += 1
    return out


def parse_mul_loop(ops, i):
    j, cur, adds = i + 1, 0, {}
    while j < len(ops) and ops[j] != (']',):
        op = ops[j]
        if op[0] == 'add':
            adds[cur] = adds.get(cur, 0) + op[1]
        elif op[0] == 'move':
            cur += op[1]
        else:
            return None
        j += 1
    if j >= len(ops) or cur != 0:
        return None
    if adds.get(0, 0) not in (1, -1):
        return None
    targets = [(off, k) for off, k in adds.items() if off != 0 and k != 0]
    if not targets:
        return (('clear',), j)
    return (('mul', targets), j)


def optimize(src):
    merged = merge_ops(src)
    step2, i = [], 0
    while i < len(merged):
        if merged[i] == ('[',):
            r = parse_mul_loop(merged, i)
            if r is not None:
                step2.append(r[0])
                i = r[1] + 1
                continue
        step2.append(merged[i])
        i += 1

    final, i = [], 0
    while i < len(step2):
        op = step2[i]
        if op[0] == 'clear' and i + 1 < len(step2) and step2[i + 1][0] == 'add':
            v = step2[i + 1][1] & 0xFF
            if v:
                final.append(('set', v))
            i += 2
        else:
            final.append(op)
            i += 1
    return final


def analyze_tape(ops):
    ptr, lo, hi = 0, 0, 0
    for op in ops:
        if op[0] == 'move':
            ptr += op[1]
            lo, hi = min(lo, ptr), max(hi, ptr)
        elif op[0] == 'mul':
            for off, _ in op[1]:
                lo, hi = min(lo, ptr + off), max(hi, ptr + off)
    return lo, hi


# ============================================================
# 代码生成
# ============================================================
class CG:
    def __init__(self):
        self.buf, self.labels, self.relocs = bytearray(), {}, []
        self.cur_off = 0

    def emit(self, b):  self.buf.extend(b)
    def label(self, n): self.labels[n] = len(self.buf)

    def rel32(self, n):
        self.relocs.append((len(self.buf), n))
        self.buf.extend(b'\x00\x00\x00\x00')

    def resolve(self):
        for off, name in self.relocs:
            struct.pack_into('<i', self.buf, off, self.labels[name] - (off + 4))

    def flush(self):
        if self.cur_off == 0:
            return
        v = self.cur_off
        if 0 < v <= 0x7F:
            self.emit(b'\x48\x83\xC3' + bytes([v]))
        elif -0x80 <= v < 0:
            self.emit(b'\x48\x83\xEB' + bytes([-v]))
        else:
            self.emit(b'\x48\x81\xC3' + struct.pack('<i', v))
        self.cur_off = 0

    def modrm(self, reg, disp):
        reg &= 7
        if disp == 0:
            return bytes([(reg << 3) | 0x03])
        if -128 <= disp <= 127:
            return bytes([0x40 | (reg << 3) | 0x03, disp & 0xFF])
        return bytes([0x80 | (reg << 3) | 0x03]) + struct.pack('<i', disp)


def emit_putchar(cg):
    d = cg.cur_off
    cg.emit(b'\x48\x8B\x0D'); cg.rel32('handle_out')
    if d == 0:
        cg.emit(b'\x48\x8D\x13')
    elif -128 <= d <= 127:
        cg.emit(b'\x48\x8D\x53' + bytes([d & 0xFF]))
    else:
        cg.emit(b'\x48\x8D\x93' + struct.pack('<i', d))
    cg.emit(b'\x41\xB8\x01\x00\x00\x00')
    cg.emit(b'\x4C\x8D\x0D'); cg.rel32('written')
    cg.emit(b'\x48\xC7\x44\x24\x20\x00\x00\x00\x00')     # mov qword [rsp+0x20], 0
    cg.emit(b'\xFF\x15'); cg.rel32('iat_WriteFile')


def emit_getchar(cg):
    d = cg.cur_off
    cg.emit(b'\x48\x8B\x0D'); cg.rel32('handle_in')
    cg.emit(b'\x48\x8D\x15'); cg.rel32('readbuf')
    cg.emit(b'\x41\xB8\x01\x00\x00\x00')
    cg.emit(b'\x4C\x8D\x0D'); cg.rel32('readcnt')
    cg.emit(b'\x48\xC7\x44\x24\x20\x00\x00\x00\x00')
    cg.emit(b'\xFF\x15'); cg.rel32('iat_ReadFile')
    cg.emit(b'\x8A\x05'); cg.rel32('readbuf')
    cg.emit(b'\x88'); cg.emit(cg.modrm(0, d))


def emit_mul_loop(cg, targets):
    d0 = cg.cur_off
    cg.emit(b'\x0F\xB6'); cg.emit(cg.modrm(0, d0))
    cg.emit(b'\xC6');     cg.emit(cg.modrm(0, d0)); cg.emit(b'\x00')
    for off, k in targets:
        doff, km = d0 + off, k & 0xFF
        if km == 0:
            continue
        if km == 1:
            cg.emit(b'\x00'); cg.emit(cg.modrm(0, doff))
        elif km == 0xFF:
            cg.emit(b'\x28'); cg.emit(cg.modrm(0, doff))
        else:
            kk = km if km <= 127 else km - 256
            cg.emit(b'\x6B\xC8' + bytes([kk & 0xFF]))
            cg.emit(b'\x00'); cg.emit(cg.modrm(1, doff))


def compile_bf(cg, ops, utf8, has_input):
    logger.info("生成 x86-64 机器码进行中")

    # ── 标准 prologue ──
    # push rbp; mov rbp, rsp; sub rsp, 0x30
    # 保存返回地址与 saved rbp，SEH/调试器可回溯；RSP 保持 16 对齐
    cg.emit(b'\x55')                                   # push rbp
    cg.emit(b'\x48\x89\xE5')                           # mov rbp, rsp
    cg.emit(b'\x48\x83\xEC\x30')                       # sub rsp, 0x30

    # UTF-8 控制台（可选）
    if utf8:
        cg.emit(b'\xB9' + struct.pack('<I', UTF8_CP))
        cg.emit(b'\xFF\x15'); cg.rel32('iat_SetConsoleOutputCP')
        if has_input:
            cg.emit(b'\xB9' + struct.pack('<I', UTF8_CP))
            cg.emit(b'\xFF\x15'); cg.rel32('iat_SetConsoleCP')

    # GetStdHandle(STD_INPUT_HANDLE = -10)
    cg.emit(b'\xB9' + struct.pack('<I', 0xFFFFFFF6))
    cg.emit(b'\xFF\x15'); cg.rel32('iat_GetStdHandle')
    cg.emit(b'\x48\x89\x05'); cg.rel32('handle_in')

    # GetStdHandle(STD_OUTPUT_HANDLE = -11)
    cg.emit(b'\xB9' + struct.pack('<I', 0xFFFFFFF5))
    cg.emit(b'\xFF\x15'); cg.rel32('iat_GetStdHandle')
    cg.emit(b'\x48\x89\x05'); cg.rel32('handle_out')

    # rbx = tape + TAPE_CENTER（逻辑位置 0）
    cg.emit(b'\x48\x8D\x1D'); cg.rel32('tape')
    cg.emit(b'\x48\x81\xC3' + struct.pack('<i', TAPE_CENTER))

    stack, lid = [], 0
    for op in ops:
        k = op[0]
        if k == 'add':
            v = op[1] & 0xFF
            if v == 0:
                continue
            if v == 1:
                cg.emit(b'\xFE'); cg.emit(cg.modrm(0, cg.cur_off))
            elif v == 0xFF:
                cg.emit(b'\xFE'); cg.emit(cg.modrm(1, cg.cur_off))
            else:
                cg.emit(b'\x80'); cg.emit(cg.modrm(0, cg.cur_off)); cg.emit(bytes([v]))
        elif k == 'move':
            cg.cur_off += op[1]
        elif k == 'clear':
            cg.emit(b'\xC6'); cg.emit(cg.modrm(0, cg.cur_off)); cg.emit(b'\x00')
        elif k == 'set':
            cg.emit(b'\xC6'); cg.emit(cg.modrm(0, cg.cur_off)); cg.emit(bytes([op[1] & 0xFF]))
        elif k == 'mul':
            emit_mul_loop(cg, op[1])
        elif k == '.':
            emit_putchar(cg)
        elif k == ',':
            emit_getchar(cg)
        elif k == '[':
            cg.flush()
            s, e = f'L{lid}', f'E{lid}'; lid += 1
            cg.label(s)
            cg.emit(b'\x80'); cg.emit(cg.modrm(7, 0)); cg.emit(b'\x00')
            cg.emit(b'\x0F\x84'); cg.rel32(e)
            stack.append((s, e))
        elif k == ']':
            s, e = stack.pop()
            cg.flush()
            cg.emit(b'\x80'); cg.emit(cg.modrm(7, 0)); cg.emit(b'\x00')
            cg.emit(b'\x0F\x85'); cg.rel32(s)
            cg.label(e)

    # ── epilogue ──
    # ExitProcess 不返回；保留 leave;ret 作为形式完整性 / 万一失败仍能返回
    cg.emit(b'\x31\xC9')                               # xor ecx, ecx
    cg.emit(b'\xFF\x15'); cg.rel32('iat_ExitProcess')
    cg.emit(b'\xC9')                                   # leave (mov rsp,rbp; pop rbp)
    cg.emit(b'\xC3')                                   # ret

    logger.info(f"机器码生成完成: {len(cg.buf)} 字节")


# ============================================================
# 节数据
# ============================================================
def align_buf(cg, n):
    while len(cg.buf) % n:
        cg.buf.append(0)


def build_section(cg, funcs):
    logger.info(f"构建导入函数列表进行中: {funcs}")

    align_buf(cg, 8)
    for name in ('handle_in', 'handle_out', 'written', 'readcnt', 'readbuf'):
        cg.label(name); cg.emit(b'\x00' * 8)

    n = len(funcs)
    align_buf(cg, 4)
    idt_off = len(cg.buf); cg.emit(b'\x00' * 40)
    int_off = len(cg.buf); cg.emit(b'\x00' * (8 * (n + 1)))
    iat_off = len(cg.buf); cg.emit(b'\x00' * (8 * (n + 1)))
    dll_off = len(cg.buf); cg.emit(b'kernel32.dll\x00')

    hn_offs = []
    for fn in funcs:
        align_buf(cg, 2)
        hn_offs.append(len(cg.buf))
        cg.emit(struct.pack('<H', 0) + fn.encode() + b'\x00')

    def rva(o): return SECTION_RVA + o
    for i, ho in enumerate(hn_offs):
        struct.pack_into('<Q', cg.buf, int_off + i * 8, rva(ho))
        struct.pack_into('<Q', cg.buf, iat_off + i * 8, rva(ho))
    struct.pack_into('<IIIII', cg.buf, idt_off,
                     rva(int_off), 0, 0, rva(dll_off), rva(iat_off))
    for i, fn in enumerate(funcs):
        cg.labels['iat_' + fn] = iat_off + i * 8

    align_buf(cg, 16)
    tape_off = len(cg.buf)
    cg.label('tape')

    logger.info(f"数据段与导入表构建完成: tape@0x{tape_off:x}, 导入 {n} 个函数")
    return idt_off, tape_off


# ============================================================
# PE 组装
# ============================================================
def assemble_pe(raw_data, total_virt, entry_rva, import_dir_rva):
    raw_size = (len(raw_data) + FILE_ALIGN - 1) // FILE_ALIGN * FILE_ALIGN
    virt_al  = (total_virt + SECT_ALIGN - 1) // SECT_ALIGN * SECT_ALIGN
    size_img = SECTION_RVA + virt_al
    size_hdr = 0x200

    dos = b'MZ' + b'\x00' * 58 + struct.pack('<I', 0x80)
    stub = (bytes([0x0E, 0x1F, 0xBA, 0x0E, 0x00, 0xB4, 0x09, 0xCD, 0x21,
                   0xB8, 0x01, 0x4C, 0xCD, 0x21])
            + b"This program cannot be run in DOS mode.\r\r\n$")
    stub += b'\x00' * (0x40 - len(stub))

    pe_sig = b'PE\x00\x00'
    file_hdr = struct.pack('<HHIIIHH',
        0x8664, 1, 0, 0, 0, 240,
        0x0001 | 0x0002 | 0x0020)

    opt  = struct.pack('<HBBIIIII',
        0x20B, 0, 0, raw_size, 0, 0, entry_rva, SECTION_RVA)
    opt += struct.pack('<Q', IMAGE_BASE)
    opt += struct.pack('<IIHHHHHHIIIIHHQQQQII',
        SECT_ALIGN, FILE_ALIGN,
        6, 0, 0, 0, 6, 0,
        0, size_img, size_hdr, 0,
        3, 0,
        0x100000, 0x1000, 0x100000, 0x1000,
        0, 16)
    dirs = [(0, 0)] * 16
    dirs[1] = (import_dir_rva, 40)
    opt += b''.join(struct.pack('<II', r, s) for r, s in dirs)

    sec_hdr = (b'.text\x00\x00\x00'
               + struct.pack('<IIIIIIHHI',
                   total_virt, SECTION_RVA,
                   raw_size, FILE_ALIGN if raw_size else 0,
                   0, 0, 0, 0, 0xE0000020))

    hdr = dos + stub + pe_sig + file_hdr + opt + sec_hdr
    assert len(hdr) <= size_hdr, f"头部超限: {len(hdr)}"
    hdr += b'\x00' * (size_hdr - len(hdr))
    body = bytes(raw_data) + b'\x00' * (raw_size - len(raw_data))
    return hdr + body


# ============================================================
# 主流程
# ============================================================
def build_exe(src, utf8=False):
    logger.info("解析并优化 Brainfuck 代码进行中")
    ops = optimize(src)
    has_input = any(op[0] == ',' for op in ops)
    logger.info(f"代码优化完成: 操作数={len(ops)}, 含输入={'是' if has_input else '否'}")

    logger.info("Tape 使用范围分析进行中")
    lo, hi = analyze_tape(ops)
    logger.info(f"Tape 范围: [{lo}, {hi}]")
    if lo < -TAPE_CENTER or hi >= TAPE_CENTER:
        raise ValueError(f"程序静态 tape 范围过大: [{lo}, {hi}]")

    funcs = get_funcs(utf8, has_input)

    cg = CG()
    compile_bf(cg, ops, utf8, has_input)
    idt_off, tape_off = build_section(cg, funcs)
    cg.resolve()

    raw_data   = bytes(cg.buf)
    total_virt = tape_off + TAPE_SIZE
    logger.info("组装 PE 文件进行中")
    exe = assemble_pe(raw_data, total_virt, SECTION_RVA, SECTION_RVA + idt_off)
    logger.info(f"PE 组装完成: {len(exe)} 字节")
    return exe


def print_usage():
    print("用法: python bf2exe.py <input.bf> <output.exe> [--cn] [--quiet]")
    print()
    print("选项:")
    print("  --cn, --chinese, --utf8, -u    控制台切换 UTF-8 (65001)")
    print("  --quiet, -q                    关闭 Info 日志")
    print("  -h, --help                     显示帮助")


def main():
    utf8, quiet = False, False
    files = []
    for a in sys.argv[1:]:
        if a in ('--cn', '--chinese', '--utf8', '-u'):
            utf8 = True
        elif a in ('--quiet', '-q'):
            quiet = True
        elif a in ('-h', '--help'):
            print_usage(); sys.exit(0)
        else:
            files.append(a)

    setup_logging(quiet)

    if len(files) != 2:
        print_usage(); sys.exit(1)

    in_path, out_path = files
    logger.info(f"读取 Brainfuck 源文件进行中: {in_path}")
    with open(in_path, 'r', encoding='utf-8', errors='ignore') as f:
        src = f.read()

    try:
        exe = build_exe(src, utf8=utf8)
    except ValueError as e:
        logger.error(f"编译失败: {e}")
        sys.exit(2)

    logger.info(f"写入可执行文件进行中: {out_path}")
    with open(out_path, 'wb') as f:
        f.write(exe)

    logger.info(f"编译成功: {out_path} ({len(exe)} 字节, utf8={utf8})")


if __name__ == '__main__':
    main()