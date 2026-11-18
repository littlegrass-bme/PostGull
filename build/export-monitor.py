# 从开发目录的 cat_monitor.py 生成一份可开源的脱敏副本。
#
# 只在维护者本机跑，产物才是入库的东西。源文件不做任何修改。
#
# 处理四类内容：
#   1. BASE_DIR 写死的开发目录改为脚本自身所在目录，天然相对
#   2. PROMPTS 里写死的绝对路径改为相对说法
#   3. 图标路径改为仓库内的 assets 位置
#   4. 投递调用从 relay.mjs 改为 postgull.exe（参数等价）
#
# 用法：
#   python build/export-monitor.py <源 cat_monitor.py> [输出路径]
# 不给输出路径就写到仓库的 monitor/cat_monitor.py。
import pathlib
import re
import sys

if len(sys.argv) < 2:
    print('用法: python build/export-monitor.py <源 cat_monitor.py> [输出路径]')
    raise SystemExit(2)

SRC = pathlib.Path(sys.argv[1])
REPO = pathlib.Path(__file__).resolve().parent.parent
DST = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else REPO / 'monitor' / 'cat_monitor.py'

text = SRC.read_text(encoding='utf-8')

# 1. BASE_DIR：改成脚本自身目录。这样把整个目录搬到哪都能跑。
#    源文件里的写法可能带盘符，用正则整体替换，不写死具体路径。
text, n = re.subn(
    r'^BASE_DIR\s*=\s*r?"[^"]*"\s*$',
    ('# 默认用脚本自身所在目录，整个文件夹搬到哪都能跑。\n'
     '# 需要指向别处时设环境变量 POSTGULL_HOME。\n'
     'BASE_DIR = os.environ.get("POSTGULL_HOME") or os.path.dirname(os.path.abspath(__file__))'),
    text,
    count=1,
    flags=re.M,
)
if n != 1:
    raise SystemExit('BASE_DIR 那行没找到，源文件可能变了，停下来人工确认')

# 2. 图标：开发期叫 cat_monitor.ico，仓库里统一到 assets 下。
text = re.sub(
    r'ICO_PATH\s*=\s*os\.path\.join\(BASE_DIR,\s*"cat_monitor\.ico"\)',
    'ICO_PATH = os.path.join(BASE_DIR, "assets", "logo.ico")',
    text,
)

# 3. PROMPTS 里的绝对路径。保留话术，去掉机器相关的盘符。
text = re.sub(r'[A-Za-z]:\\\\[^"\n]*?\\\\README\.md 与 [A-Za-z]:\\\\[^"\n]*?\\\\registry\.json',
              '本目录下的 README.md 与 registry.json', text)
text = text.replace('请阅读 本目录下的', '请阅读本目录下的')

# 4. 调用方式：开发期用 relay.mjs，开源仓库里只有 postgull.exe。两者参数等价：
#      node relay.mjs --to X --from Y --summary Z --encoding base64  (正文走 stdin)
#      postgull send --to X --from Y --summary Z --encoding base64   (正文走 stdin)
#      node relay.mjs --flush sw --category cat
#      postgull flush sw --category cat
text = re.sub(
    r'RELAY_SCRIPT\s*=\s*os\.path\.join\(BASE_DIR,\s*"relay\.mjs"\)',
    ('# 投递走同目录下的 postgull.exe。它接受与开发期 relay.mjs 等价的参数：\n'
     '#   postgull send --to X --from Y --summary Z --encoding base64  (正文走 stdin)\n'
     '#   postgull flush <软件> --category <类别>\n'
     'POSTGULL_EXE = os.path.join(BASE_DIR, "postgull.exe")'),
    text,
)

text = text.replace(
    '''            cmd = [
                "node", RELAY_SCRIPT,
                "--to", target_to,
                "--from", "PostGull 监控面板",
                "--summary", reject_summary[:280]
            ]''',
    '''            cmd = [
                POSTGULL_EXE, "send",
                "--to", target_to,
                "--from", "PostGull 监控面板",
                "--summary", reject_summary[:280],
                "--encoding", "base64",
            ]''',
)

text = re.sub(
    r'cmd\s*=\s*\["node",\s*RELAY_SCRIPT,\s*"--flush",\s*sw,\s*"--category",\s*cat\]',
    'cmd = [POSTGULL_EXE, "flush", sw, "--category", cat]',
    text,
)

# 5. 兜底检查。任何残留都报出来，不静默通过。
problems = []

DRIVE_RE = re.compile(r'(?<![A-Za-z0-9])[A-Za-z]:[\\/](?![0-9])')
for i, line in enumerate(text.splitlines(), 1):
    if DRIVE_RE.search(line) and 'http://' not in line and 'https://' not in line:
        problems.append((i, '盘符路径', line.strip()[:110]))

for i, line in enumerate(text.splitlines(), 1):
    if 'RELAY_SCRIPT' in line:
        problems.append((i, '残留 relay 引用', line.strip()[:110]))

if problems:
    print('仍有问题，请人工处理：')
    for i, kind, line in problems:
        print(f'  {i} [{kind}]: {line}')
    raise SystemExit(1)

DST.parent.mkdir(parents=True, exist_ok=True)
DST.write_text(text, encoding='utf-8')
print(f'已写出 {DST}（{len(text.splitlines())} 行）')
