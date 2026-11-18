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


def main():
    exe, ico = sys.argv[1], sys.argv[2]
    images = parse_ico(ico)
    print(f'ICO 含 {len(images)} 张: ' + ', '.join(f"{i['w']}x{i['h']}" for i in images))

    handle = kernel32.BeginUpdateResourceW(exe, False)
    if not handle:
        raise SystemExit(f'BeginUpdateResource 失败，错误码 {ctypes.get_last_error()}')

    try:
        # 图标：每个尺寸一个 RT_ICON，id 从 1 开始，与 group 里的 nID 对应。
        for idx, im in enumerate(images, start=1):
            ok = kernel32.UpdateResourceW(
                handle, make_int_resource(RT_ICON), make_int_resource(idx),
                LANG_EN_US, im['blob'], len(im['blob']),
            )
            if not ok:
                raise SystemExit(f'写 RT_ICON {idx} 失败，错误码 {ctypes.get_last_error()}')

        group = build_group(images)
        ok = kernel32.UpdateResourceW(
            handle, make_int_resource(RT_GROUP_ICON), make_int_resource(1),
            LANG_EN_US, group, len(group),
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
