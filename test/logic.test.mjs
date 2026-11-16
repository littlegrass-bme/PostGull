// Antigravity 目标判定与测试防呆的单元测试。
// 这两块逻辑不依赖 Electron 或网络，可以直接跑：
//   node test/logic.test.mjs
// 退出码 0 全过，1 有失败。

import { evaluateTargetOpen } from '../src/adapters/antigravity.mjs';

let pass = 0;
let fail = 0;

function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       得到 ${JSON.stringify(got)}\n       期望 ${JSON.stringify(want)}`); }
}

function truthy(name, got) {
  if (got) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}（实际 ${JSON.stringify(got)}）`); }
}

const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const page = (uuid) => ({ uuid, webSocketDebuggerUrl: 'ws://x' });

console.log('== evaluateTargetOpen：目标是否打开 ==');

eq('一个窗口且是目标 → 可投递',
  evaluateTargetOpen([page(A)], A).asleep, false);

eq('一个窗口但不是目标 → 休眠',
  evaluateTargetOpen([page(A)], B),
  { asleep: true, reason: `目标 ${B} 未打开，当前打开：${A}` });

// 关键：多窗口不再拦截。目标在里面就投，只给警告。
eq('两个窗口且包含目标 → 仍然可投递',
  evaluateTargetOpen([page(A), page(B)], A).asleep, false);

truthy('两个窗口要给出警告而不是拒绝',
  typeof evaluateTargetOpen([page(A), page(B)], A).warning === 'string');

truthy('警告里要列出两个 id',
  (() => {
    const w = evaluateTargetOpen([page(A), page(B)], A).warning;
    return w.includes(A) && w.includes(B);
  })());

eq('两个窗口但目标不在里面 → 休眠',
  evaluateTargetOpen([page(A), page(B)], 'cccccccc-cccc-cccc-cccc-cccccccccccc').asleep, true);

eq('没有窗口 → 休眠',
  evaluateTargetOpen([], A),
  { asleep: true, reason: `目标 ${A} 未打开，当前打开：无` });

eq('uuid 大小写不敏感',
  evaluateTargetOpen([page(A.toUpperCase())], A).asleep, false);

eq('目标 id 为 null 时不误判成可投递',
  evaluateTargetOpen([page(A)], null).asleep, true);

eq('单窗口时不给多窗口警告',
  evaluateTargetOpen([page(A)], A).warning, null);

eq('列表里混入没有 uuid 的页面 → 只按有 uuid 的算',
  evaluateTargetOpen([page(A), { uuid: undefined }], A).asleep, false);

console.log('');
console.log(`通过 ${pass}，失败 ${fail}`);
process.exitCode = fail ? 1 : 0;
