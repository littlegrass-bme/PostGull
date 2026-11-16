// 构建：把 src 打成单文件 CJS，再注入 Node SEA，产出 agent-bridge.exe。
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
const exe = join(outDir, 'agent-bridge.exe');

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
  '--banner:js=// agent-bridge single-file bundle',
]);

// 2. 生成 SEA blob
const seaConfig = join(here, 'sea-config.json');
writeFileSync(seaConfig, JSON.stringify({
  main: bundle,
  output: blob,
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

// 4. 冒烟：必须能打印版本
const version = execFileSync(exe, ['version'], { encoding: 'utf8' }).trim();
console.log(`\n构建完成：${exe}`);
console.log(`自检输出：${version}`);
console.log(`体积：${(readFileSync(exe).length / 1024 / 1024).toFixed(1)} MB`);
if (!/^agent-bridge /.test(version)) {
  throw new Error('exe 冒烟测试失败：version 输出不符合预期');
}
