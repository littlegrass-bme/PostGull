// 在 Windows 上定位一个可能只以 .cmd / .ps1 形式存在的命令。
//
// 背景：Node 的 spawn 不带 shell 时无法执行 .cmd 与 .ps1，会直接报 ENOENT。
// 而 npm 全局装的 CLI（codex、claude 之类）恰好就是这么落盘的，
// 所以必须显式解析出真实入口，不能指望 PATH 里有 .exe。

import { existsSync, readFileSync } from 'node:fs';
import { join, delimiter, basename } from 'node:path';
import { BridgeError } from './config.mjs';

const EXEC_EXTS = ['.exe', '.cmd', '.bat', '.ps1'];

export function pathDirs() {
  return String(process.env.PATH || '').split(delimiter).filter(Boolean);
}

// kind 决定启动方式：
//   exe  → spawn(file, args)
//   js   → spawn(process.execPath, [file, ...args])，绕开 .cmd 的引号改写
//   cmd  → spawn('cmd.exe', ['/c', file, ...args])
//   ps1  → spawn('powershell.exe', ['-NoProfile','-File', file, ...args])
export function resolveCommand(name) {
  if (!name) return null;
  if (existsSync(name) && /\.(exe|cmd|bat|ps1|js|mjs)$/i.test(name)) return withKind(name);
  for (const dir of pathDirs()) {
    for (const ext of EXEC_EXTS) {
      const p = join(dir, name + ext);
      if (existsSync(p)) return withKind(p);
    }
    const bare = join(dir, name);
    if (existsSync(bare)) return withKind(bare);
  }
  return null;
}

function withKind(file) {
  const lower = file.toLowerCase();
  if (lower.endsWith('.exe')) return { kind: 'exe', file, prefixArgs: [] };
  if (lower.endsWith('.ps1')) return { kind: 'ps1', file, prefixArgs: ['-NoProfile', '-NonInteractive', '-File', file] };
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) return { kind: 'cmd', file, prefixArgs: [] };
  return { kind: 'js', file, prefixArgs: [] };
}

// 找真实 node.exe。
// 关键：在 SEA 打包的 exe 里，process.execPath 是桥接器本身，不是 node。
// 拿它去跑 `node xxx.js` 会把桥接器自己启起来（实测报「找不到配置文件」），
// 所以打包后必须去 PATH / 环境变量里另找 node。
//
// 判据用「可执行文件名不是 node.exe」而非 node:sea 的 isSea()：
// 前者在打包后一定成立，后者依赖模块可用性。代价是用户把 node.exe 改名会误判，
// 所以这里同时接受 POSTGULL_NODE 环境变量显式指定，误判也有出路。
export function findNodeExe() {
  if (process.env.POSTGULL_NODE) {
    if (!existsSync(process.env.POSTGULL_NODE)) {
      throw new BridgeError(
        `POSTGULL_NODE 指向的路径不存在：${process.env.POSTGULL_NODE}`,
        '改成真实 node.exe 的完整路径，或删掉这个环境变量让它自动查找。',
      );
    }
    return process.env.POSTGULL_NODE;
  }
  const isSea = basename(process.execPath).toLowerCase() !== 'node.exe';
  if (!isSea) return process.execPath;
  for (const dir of pathDirs()) {
    const p = join(dir, 'node.exe');
    if (existsSync(p)) return p;
  }
  return null; // 交给调用方翻译成人话，不要让它变成裸 ENOENT
}

// 需要 node 才能跑的适配器（codex / claude 走 .js 入口时）在缺 node 时要给出人话报错。
// 裸 ENOENT 对不懂技术的用户等于没说。
export function requireNodeExe(purpose) {
  const exe = findNodeExe();
  if (exe) return exe;
  throw new BridgeError(
    `没有找到 Node.js，${purpose}需要它才能运行`,
    '这个 exe 本身不依赖 Node，但调用 codex / claude 这类用 JavaScript 写的 CLI 时需要。装一个 Node.js（选 LTS 版）即可；已经装了的，把 node.exe 所在目录加进 PATH，或设环境变量 POSTGULL_NODE 指向 node.exe 的完整路径。',
  );
}

// 把 resolveCommand 的结果拼成 spawn 需要的 { command, args }。
// js 分支用 requireNodeExe：缺 Node 时抛人话错误，而不是让 spawn 报裸 ENOENT。
export function spawnPlan(resolved, args, purpose = '这个命令') {
  if (!resolved) return null;
  if (resolved.kind === 'exe') return { command: resolved.file, args: [...resolved.prefixArgs, ...args] };
  if (resolved.kind === 'js') return { command: requireNodeExe(purpose), args: [...resolved.prefixArgs, resolved.file, ...args] };
  if (resolved.kind === 'cmd') return { command: process.env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', resolved.file, ...args] };
  if (resolved.kind === 'ps1') return { command: 'powershell.exe', args: [...resolved.prefixArgs, ...args] };
  return { command: resolved.file, args };
}

// 找 npm 全局安装的包入口 js。走 node 启动比走 .cmd 稳：
// 参数不经 cmd.exe，引号、换行、超长正文都不会被改写。
export function findNpmBinJs(packageName) {
  const roots = [];
  if (process.env.APPDATA) roots.push(join(process.env.APPDATA, 'npm', 'node_modules'));
  if (process.env.ProgramFiles) roots.push(join(process.env.ProgramFiles, 'nodejs', 'node_modules'));
  if (process.env.npm_config_prefix) roots.push(join(process.env.npm_config_prefix, 'node_modules'));
  for (const root of roots) {
    const dir = join(root, ...packageName.split('/'));
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && Object.values(pkg.bin)[0];
      if (bin) {
        const p = join(dir, bin);
        if (existsSync(p)) return p;
      }
    } catch { /* 忽略坏 package.json */ }
  }
  return null;
}
