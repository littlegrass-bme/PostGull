# 把源 PNG 转成多尺寸 ICO，供 Windows exe 使用。
# 用法：python make-icon.py <源png> <输出ico>
import sys
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
img = Image.open(src).convert('RGBA')

# Windows 图标标准尺寸。16/32 用于任务栏与标题栏，48/64 用于资源管理器，
# 128/256 用于大图标视图与 Alt+Tab。
sizes = [16, 24, 32, 48, 64, 128, 256]
# ICO 内部会按需缩放的缺省尺寸，Pillow 用 sizes 参数指定。
img.save(dst, format='ICO', sizes=[(s, s) for s in sizes])
print(f'已生成 {dst}')
print(f'源图 {img.width}x{img.height}')
print('包含尺寸:', ', '.join(f'{s}x{s}' for s in sizes))
