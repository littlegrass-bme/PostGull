// 收件归属判定的单元测试：只取 to 与自己对得上的记录。
//   node test/receive-guard.test.mjs
// 退出码 0 全过，1 有失败。

let pass = 0;
let fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       得到 ${JSON.stringify(got)}\n       期望 ${JSON.stringify(want)}`); }
}

// 复刻 core.mjs receive() 里的归属判定，保证测试与实现同源逻辑。
function classify(records, session, onlyId) {
  const want = session.alias;
  const target = `${session.software}/${session.category}`;
  const eligible = [];
  const foreign = [];
  for (const r of records) {
    const to = String(r.to || '');
    const ok = !to || to === want || to === target;
    if (!ok) { foreign.push(r); continue; }
    if (r.status === 'sending' || r.status === 'consumed') continue;
    if (onlyId && r.id !== onlyId) continue;
    eligible.push(r);
  }
  return { eligible: eligible.map((r) => r.id), foreign: foreign.map((r) => r.id) };
}

const sess = { alias: 'gemini-bridge', software: 'gemini', category: 'bridge' };
const rec = (id, to, status = 'pending') => ({ id, to, status, token: `T-${id}` });

console.log('== 收件归属判定 ==');

eq('to 写成 软件/类别 → 可收',
  classify([rec('a', 'gemini/bridge')], sess).eligible, ['a']);

eq('to 写成别名 → 可收',
  classify([rec('a', 'gemini-bridge')], sess).eligible, ['a']);

eq('to 是别的类别 → 进 foreign，不可收',
  classify([rec('b', 'gemini/work')], sess).foreign, ['b']);

eq('混在一起时只取自己的',
  classify([rec('a', 'gemini/bridge'), rec('b', 'gemini/work'), rec('c', 'gemini/bridge')], sess),
  { eligible: ['a', 'c'], foreign: ['b'] });

eq('to 缺失视为无归属，允许收（兼容旧记录）',
  classify([{ id: 'a', token: 'T' }], sess).eligible, ['a']);

eq('sending 状态不可收（正在投递）',
  classify([rec('a', 'gemini/bridge', 'sending')], sess).eligible, []);

eq('consumed 状态不可收（已消费）',
  classify([rec('a', 'gemini/bridge', 'consumed')], sess).eligible, []);

eq('指定 id 时只取那一条',
  classify([rec('a', 'gemini/bridge'), rec('b', 'gemini/bridge')], sess, 'b').eligible, ['b']);

eq('指定 id 但那条是别人的 → 什么都不取',
  classify([rec('b', 'gemini/work')], sess, 'b').eligible, []);

eq('别名的软件不同但类别同名，不算自己',
  classify([rec('x', 'dsh/bridge')], sess).foreign, ['x']);

console.log('');
console.log(`通过 ${pass}，失败 ${fail}`);
process.exitCode = fail ? 1 : 0;
