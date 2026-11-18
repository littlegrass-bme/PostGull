# 把图标与版本信息写进 exe 的 Windows 资源段。
#
# 为什么不用 rcedit：实测它在 88 MB 的 SEA exe 上会永久挂住，
# 只设版本信息也要挂十几分钟不返回。
# 为什么不用 resedit（纯 JS）：图标能改，但版本信息的 setStringValues /
# setFileVersion 写回文件后会被还原，读回来仍是 Node.js，试过新建块、
# 原地改、调整删除顺序都不行。
# 这里直接调 Windows 自己的资源 API（BeginUpdateResourceW / UpdateResourceW /
# EndUpdateResourceW），PE 结构交给系统改写，实测 0.8 秒完成，结果正确。
#
# 用法：python patch-res.py <exe> <ico>
import ctypes
import struct
import sys
from ctypes import wintypes

kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)

RT_ICON = 3
RT_GROUP_ICON = 14
RT_VERSION = 16
LANG_EN_US = 1033


def make_int_resource(value):
    """把整数资源 id 转成 API 要的 LPCWSTR（MAKEINTRESOURCE）。"""
    return ctypes.cast(ctypes.c_void_p(value), wintypes.LPCWSTR)


kernel32.BeginUpdateResourceW.argtypes = [wintypes.LPCWSTR, wintypes.BOOL]
kernel32.BeginUpdateResourceW.restype = wintypes.HANDLE
kernel32.UpdateResourceW.argtypes = [
    wintypes.HANDLE, wintypes.LPCWSTR, wintypes.LPCWSTR,
    wintypes.WORD, ctypes.c_void_p, wintypes.DWORD,
]
kernel32.UpdateResourceW.restype = wintypes.BOOL
kernel32.EndUpdateResourceW.argtypes = [wintypes.HANDLE, wintypes.BOOL]
kernel32.EndUpdateResourceW.restype = wintypes.BOOL


def parse_ico(path):
    """解析 ICO，返回每张图的原始数据与尺寸。"""
    data = open(path, 'rb').read()
    reserved, itype, count = struct.unpack('<HHH', data[:6])
    if reserved != 0 or itype != 1:
        raise SystemExit('不是合法 ICO 文件')

    images = []
    off = 6
    for _ in range(count):
        w, h, colors, _, planes, bpp, size, img_off = struct.unpack('<BBBBHHII', data[off:off + 16])
        off += 16
        images.append({
            'w': w or 256, 'h': h or 256, 'colors': colors,
            'planes': planes, 'bpp': bpp,
            'blob': data[img_off:img_off + size],
        })
    return images


def build_group(images):
    """构造 RT_GROUP_ICON 的数据：GRPICONDIR 后接每张图的 GRPICONDIRENTRY。"""
    out = struct.pack('<HHH', 0, 1, len(images))
    for i, im in enumerate(images, start=1):
        out += struct.pack(
            '<BBBBHHIH',
            im['w'] if im['w'] < 256 else 0,
            im['h'] if im['h'] < 256 else 0,
            im['colors'], 0, im['planes'], im['bpp'],
            len(im['blob']), i,
        )
    return out


def pad4(b):
    """资源结构里每段都要 4 字节对齐。"""
    return b + b'\x00' * ((4 - len(b) % 4) % 4)


def wstr(s):
    """带结尾 NUL 的 UTF-16LE。"""
    return (s + '\x00').encode('utf-16-le')


def build_version_info(product, description, version, company, copyright_, original):
    """手工构造 VS_VERSIONINFO。

    结构：VS_VERSIONINFO -> VS_FIXEDFILEINFO + StringFileInfo + VarFileInfo。
    每个节点的 wLength 必须包含自身全部子节点与对齐填充，算错会写坏资源。
    """
    def node(key, value, value_length, vtype, children=b''):
        head = struct.pack('<HHH', 0, value_length, vtype) + wstr(key)
        head = pad4(head)
        body = head + value
        body = pad4(body) + children
        return struct.pack('<H', len(body)) + body[2:]

    ver_parts = [int(x) for x in version.split('.')]
    while len(ver_parts) < 4:
        ver_parts.append(0)
    ms = (ver_parts[0] << 16) | ver_parts[1]
    ls = (ver_parts[2] << 16) | ver_parts[3]

    fixed = struct.pack(
        '<13I',
        0xFEEF04BD,          # dwSignature
        0x00010000,          # dwStrucVersion
        ms, ls,              # FileVersion
        ms, ls,              # ProductVersion
        0x3F, 0,             # FlagsMask, Flags
        0x40004,             # VOS_NT_WINDOWS32
        0x1,                 # VFT_APP
        0, 0, 0,
    )

    strings = [
        ('CompanyName', company),
        ('FileDescription', description),
        ('FileVersion', version),
        ('InternalName', original.rsplit('.', 1)[0]),
        ('LegalCopyright', copyright_),
        ('OriginalFilename', original),
        ('ProductName', product),
        ('ProductVersion', version),
    ]

    string_nodes = b''
    for key, val in strings:
        raw = wstr(val)
        string_nodes += node(key, raw, len(raw) // 2, 1)

    string_table = node('040904B0', b'', 0, 1, string_nodes)
    string_file_info = node('StringFileInfo', b'', 0, 1, string_table)

    translation = struct.pack('<HH', 0x0409, 0x04B0)
    var_node = node('Translation', translation, len(translation), 0)
    var_file_info = node('VarFileInfo', b'', 0, 1, var_node)

    return node('VS_VERSION_INFO', fixed, len(fixed), 0, string_file_info + var_file_info)


def read_icon_slots(exe):
    """读出现有图标资源的 (组 id, 语言, [图标 id...])。

    不能写死 id=1 / lang=1033：不同编译器放的位置不一样。
    实测 node.exe 是 组 id=1、lang=1033、图标 id 从 1 起；
    而一个 .NET 启动器是 组 id=32512、lang=0、图标 id 从 2 起。
    照着原位置写，属性页和资源管理器才认。

    这里只解析 PE 资源目录，不引入第三方库。
    """
    import struct as _s

    data = open(exe, 'rb').read()
    pe_off = _s.unpack_from('<I', data, 0x3C)[0]
    if data[pe_off:pe_off + 4] != b'PE\0\0':
        return None, []

    coff = pe_off + 4
    num_sections = _s.unpack_from('<H', data, coff + 2)[0]
    opt_size = _s.unpack_from('<H', data, coff + 16)[0]
    opt_off = coff + 20
    magic = _s.unpack_from('<H', data, opt_off)[0]
    # PE32 的数据目录从 +96 起，PE32+ 从 +112 起；资源表是第 3 项。
    dir_off = opt_off + (96 if magic == 0x10B else 112)
    rsrc_rva, rsrc_size = _s.unpack_from('<II', data, dir_off + 2 * 8)
    if not rsrc_rva:
        return None, []

    sec_off = opt_off + opt_size
    for i in range(num_sections):
        base = sec_off + i * 40
        vsize, vaddr = _s.unpack_from('<II', data, base + 8)
        raw_size, raw_ptr = _s.unpack_from('<II', data, base + 16)
        if vaddr <= rsrc_rva < vaddr + max(vsize, raw_size):
            rsrc = raw_ptr + (rsrc_rva - vaddr)
            break
    else:
        return None, []

    def entries(dir_rel):
        off = rsrc + dir_rel
        named, ids = _s.unpack_from('<HH', data, off + 12)
        out = []
        for k in range(named + ids):
            e = off + 16 + k * 8
            name_id, target = _s.unpack_from('<II', data, e)
            is_dir = bool(target & 0x80000000)
            entry_id = name_id if not (name_id & 0x80000000) else None
            out.append((entry_id, target & 0x7FFFFFFF, is_dir))
        return out

    group = None
    icon_ids = []
    for type_id, type_rel, type_is_dir in entries(0):
        if not type_is_dir:
            continue
        if type_id == RT_GROUP_ICON:
            for gid, grel, gdir in entries(type_rel):
                if not gdir:
                    continue
                for lid, _lrel, ldir in entries(grel):
                    if not ldir:
                        group = (gid, lid if lid is not None else 0)
                        break
                if group:
                    break
        elif type_id == RT_ICON:
            icon_ids = [i for i, _r, _d in entries(type_rel) if i is not None]
    return group, sorted(icon_ids)


def main():
    exe, ico = sys.argv[1], sys.argv[2]
    images = parse_ico(ico)
    print(f'ICO 含 {len(images)} 张: ' + ', '.join(f"{i['w']}x{i['h']}" for i in images))

    group, old_icon_ids = read_icon_slots(exe)
    if group:
        group_id, lang = group
    else:
        group_id, lang = 1, LANG_EN_US
    print(f'现有图标组 id={group_id} lang={lang}，图标 id={old_icon_ids or "无"}')

    handle = kernel32.BeginUpdateResourceW(exe, False)
    if not handle:
        raise SystemExit(f'BeginUpdateResource 失败，错误码 {ctypes.get_last_error()}')

    try:
        # 图标 id 沿用原有编号，避免和资源表里其他条目撞号。
        # 原 exe 没有图标或原有条目不够时，从 1 开始补。
        if len(old_icon_ids) >= len(images):
            icon_ids = old_icon_ids[:len(images)]
        else:
            icon_ids = list(range(1, len(images) + 1))

        for idx, im in zip(icon_ids, images):
            ok = kernel32.UpdateResourceW(
                handle, make_int_resource(RT_ICON), make_int_resource(idx),
                lang, im['blob'], len(im['blob']),
            )
            if not ok:
                raise SystemExit(f'写 RT_ICON {idx} 失败，错误码 {ctypes.get_last_error()}')

        group_blob = build_group(images)
        ok = kernel32.UpdateResourceW(
            handle, make_int_resource(RT_GROUP_ICON), make_int_resource(group_id),
            lang, group_blob, len(group_blob),
        )
        if not ok:
            raise SystemExit(f'写 RT_GROUP_ICON 失败，错误码 {ctypes.get_last_error()}')

        ver = build_version_info(
            product='PostGull',
            description='PostGull 信鸥',
            version='1.0.0',
            company='PostGull',
            copyright_='MIT License',
            original='postgull.exe',
        )
        ok = kernel32.UpdateResourceW(
            handle, make_int_resource(RT_VERSION), make_int_resource(1),
            LANG_EN_US, ver, len(ver),
        )
        if not ok:
            raise SystemExit(f'写 RT_VERSION 失败，错误码 {ctypes.get_last_error()}')
    except SystemExit:
        kernel32.EndUpdateResourceW(handle, True)  # True 表示丢弃本轮修改
        raise

    if not kernel32.EndUpdateResourceW(handle, False):
        raise SystemExit(f'EndUpdateResource 失败，错误码 {ctypes.get_last_error()}')

    print(f'已写入 {exe}')


if __name__ == '__main__':
    main()
