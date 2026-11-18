// 构建：把 src 打成单文件 CJS，再注入 Node SEA，产出 postgull.exe。
// 构建期依赖装在 build/node_modules，不进发布包。
//
// 用法：node build/build.mjs

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, 'dist');
const bundle = join(here, 'bundle.cjs');
const blob = join(here, 'sea-prep.blob');
const exe = join(outDir, 'postgull.exe');

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });
}

// 1. 打包成 CJS。SEA 只接受单个 CommonJS 入口。
run(process.execPath, [
  join(here, 'node_modules', 'esbuild', 'bin', 'esbuild'),
  join(root, 'src', 'main.mjs'),
  '--bundle',
  '--platform=node',
  '--target=node20',
  '--format=cjs',
  `--outfile=${bundle}`,
  '--minify-syntax',
  '--legal-comments=none',
  '--banner:js=// postgull single-file bundle',
]);

// 2. 生成 SEA blob。
// 路径写成相对 root 的形式，不写绝对路径：sea-config.json 会留在本地磁盘上，
// 万一被误提交，也不该暴露构建机器是哪个盘、哪个用户名。run() 的 cwd 就是 root。
const seaConfig = join(here, 'sea-config.json');
const rel = (p) => p.slice(root.length + 1).replace(/\\/g, '/');
writeFileSync(seaConfig, JSON.stringify({
  main: rel(bundle),
  output: rel(blob),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
}, null, 2));
run(process.execPath, ['--experimental-sea-config', seaConfig]);

// 3. 复制 node.exe 并注入。
// 先复制再删签名：直接对 node.exe 动手会破坏系统里的 node。
mkdirSync(outDir, { recursive: true });
const nodeExe = process.execPath;
cpSync(nodeExe, exe);
// node.exe 自带 Authenticode 签名，注入 blob 后必然失效，postject 会报
// "signature seems corrupted"。提前移除可以消掉这个噪音。
try {
  execFileSync('signtool', ['remove', '/s', exe], { stdio: 'ignore', windowsHide: true });
  console.log('已移除原签名');
} catch {
  // 没装 signtool 就跳过，postject 仍能注入，只是会打印警告。
}
run(process.execPath, [
  join(here, 'node_modules', 'postject', 'dist', 'cli.js'),
  exe,
  'NODE_SEA_BLOB',
  blob,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
]);

// 4. 写图标与版本信息。
// 顺序必须在 postject 之后：postject 会重写 PE 结构，先打的图标会被覆盖掉。
//
// 为什么用 python 而不是 rcedit：实测 rcedit 在 88 MB 的 SEA exe 上会永久挂住，
// 只设版本信息也要挂 12 分钟以上。patch-res.py 直接调 Windows 资源 API
// （BeginUpdateResourceW / UpdateResourceW / EndUpdateResourceW），实测 0.8 秒。
const ico = join(here, 'postgull.ico');
const patcher = join(here, 'patch-res.py');

// 找 Python：写资源只需要标准库 ctypes，任何 Python 3 都行。
// 不写死安装路径：先看环境变量，再试命令名，最后读 conda / py 启动器自己记录的位置。
function findPython() {
  if (process.env.POSTGULL_PYTHON) return process.env.POSTGULL_PYTHON;

  const ok = (c) => {
    try {
      const out = execFileSync(c, ['-c', 'import sys;print(sys.version_info[0])'], {
        encoding: 'utf8', timeout: 10000, windowsHide: true,
      }).trim();
      return out === '3';
    } catch { return false; }
  };

  for (const c of ['python', 'python3', 'py']) {
    if (ok(c)) return c;
  }

  // conda 会把自己装过的环境写进 ~/.conda/environments.txt。
  // 这比猜盘符可靠：机器上装在哪，它自己最清楚。
  const envList = join(process.env.USERPROFILE || '', '.conda', 'environments.txt');
  if (existsSync(envList)) {
    for (const line of readFileSync(envList, 'utf8').split(/\r?\n/)) {
      const dir = line.trim();
      if (!dir) continue;
      const exe = join(dir, 'python.exe');
      if (existsSync(exe) && ok(exe)) return exe;
    }
  }

  // py 启动器会列出所有已注册的解释器。
  try {
    const out = execFileSync('py', ['-0p'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    for (const m of out.matchAll(/([A-Za-z]:\\[^\r\n]*?python\.exe)/gi)) {
      if (existsSync(m[1]) && ok(m[1])) return m[1];
    }
  } catch { /* 没装 py */ }

  return null;
}

if (existsSync(ico) && existsSync(patcher)) {
  const py = findPython();
  if (!py) {
    console.warn('找不到 Python 3，跳过图标写入。装一个 Python 或设 POSTGULL_PYTHON 指向 python.exe。');
  } else {
    try {
      execFileSync(py, [patcher, exe, ico], { stdio: 'inherit', cwd: root, windowsHide: true });
      console.log(`已写入图标与版本信息（${py}）`);
    } catch (e) {
      console.warn(`写图标失败（跳过，exe 仍可用）：${e.message}`);
    }
  }
} else {
  console.warn(`缺图标或补丁脚本，跳过：${ico} / ${patcher}`);
}

// 5. 冒烟：必须能打印版本
const version = execFileSync(exe, ['version'], { encoding: 'utf8' }).trim();
console.log(`\n构建完成：${exe}`);
console.log(`自检输出：${version}`);
console.log(`体积：${(readFileSync(exe).length / 1024 / 1024).toFixed(1)} MB`);
if (!/^postgull /.test(version)) {
  throw new Error('exe 冒烟测试失败：version 输出不符合预期');
}

// 6. 编译图形监控面板启动器 postgull-monitor.exe
const windir = process.env.WINDIR || 'C:\\Windows';
const cscCandidates = [
  join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
];
const csc = cscCandidates.find(p => existsSync(p));
const launcherSource = join(here, 'LauncherPortable.cs');
const monitorExe = join(outDir, 'postgull-monitor.exe');
const monitorIco = join(root, 'assets', 'logo.ico');

if (csc && existsSync(launcherSource) && existsSync(monitorIco)) {
  console.log(`\n> 编译图形监控面板启动器: ${monitorExe}`);
  try {
    execFileSync(csc, [
      '/target:winexe',
      '/r:System.Windows.Forms.dll',
      `/win32icon:${monitorIco}`,
      `/out:${monitorExe}`,
      launcherSource,
    ], { stdio: 'inherit', cwd: root, windowsHide: true });
    console.log(`已成功编译 postgull-monitor.exe (${(readFileSync(monitorExe).length / 1024).toFixed(0)} KB)`);
  } catch (err) {
    console.warn(`编译 postgull-monitor.exe 失败: ${err.message}`);
  }
} else {
  console.warn('缺少 csc.exe 或启动器源码，跳过 postgull-monitor.exe 编译');
}
