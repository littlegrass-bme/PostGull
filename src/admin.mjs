// 管理命令：init / list / doctor / session / quota / blocked。
// 所有写操作都走 saveConfig，保持 JSON 可读、可手改。

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  loadConfig, saveConfig, validateConfig, configPath, DEFAULT_CONFIG_NAME,
  resolveTarget, softwareOf, queueFileFor, quotaState, sleepState, BridgeError, ADAPTERS,
} from './config.mjs';
import { queueSnapshot, archiveTail } from './core.mjs';
import { adapterFor } from './adapters/index.mjs';

const TEMPLATE = {
  version: 1,
  bridgeName: 'my-bridge',
  queueDir: './queue',
  maxBodyKB: 64,
  humanSleeping: false,
  humanSleepingSince: null,
  humanSleepingNote: '人类在线',
  software: [],
  sessions: [],
  quota: {},
  blocked: [],
};

function detectDshCreds() {
  const p = join(process.env.USERPROFILE || '', '.dsh', '.credentials.yaml');
  return existsSync(p) ? p : null;
}

function cmdInit({ flags }) {
  const file = flags.has('config') ? String(flags.get('config')) : join(process.cwd(), DEFAULT_CONFIG_NAME);
  if (existsSync(file) && !flags.has('force')) {
    throw new BridgeError(`配置已存在：${file}`, '加 --force 覆盖，或换个路径。');
  }
  const cfg = structuredClone(TEMPLATE);
  const cred = detectDshCreds();

  // 示例配置只放「结构」，不放任何真实 id。用户必须自己填。
  cfg.software = [
    {
      id: 'dsh',
      label: 'DeepSeek Harness',
      adapter: 'dsh',
      options: { credentials: cred || '%USERPROFILE%\\.dsh\\.credentials.yaml', verifyTimeoutMs: 8000 },
    },
    {
      id: 'codex',
      label: 'Codex CLI',
      adapter: 'codex',
      options: { command: 'codex' },
    },
    {
      id: 'gemini',
      label: 'Antigravity / Gemini',
      adapter: 'antigravity',
      options: {
        devtoolsPortFile: '%APPDATA%\\Antigravity\\DevToolsActivePort',
        dataRoot: '%USERPROFILE%\\.gemini',
      },
    },
    {
      id: 'claude',
      label: 'Claude Code（实验性）',
      adapter: 'claude',
      enabled: false,
      options: { command: 'claude' },
    },
  ];
  cfg.sessions = [
    { alias: 'dsh-bridge', software: 'dsh', category: 'bridge', id: '填 DSH bridge 会话 id', enabled: true, note: '桥接与调度' },
    { alias: 'dsh-work', software: 'dsh', category: 'work', id: '填 DSH work 会话 id', enabled: true, note: '主任务' },
    { alias: 'codex-bridge', software: 'codex', category: 'bridge', id: '填 Codex bridge 线程 id', enabled: true, note: '测试与调度用，不要拿 work 线程做测试' },
    { alias: 'gemini-work', software: 'gemini', category: 'work', id: '填 Gemini 对话 id', enabled: true },
  ];
  cfg.quota = {
    dsh: { available: true, exhaustedUntil: null, note: '' },
    codex: { available: true, exhaustedUntil: null, note: '' },
    gemini: { available: true, exhaustedUntil: null, note: '' },
  };
  saveConfig(cfg, file);
  console.log(`已生成 ${file}`);
  console.log('下一步：把 sessions 里的 id 换成真实会话 id，然后运行 agent-bridge doctor。');
  console.log('类别名随你定，work / bridge / learn 都行；同一类别下可以放多个会话，用 软件/类别#序号 选。');
  return 0;
}

function cmdList(cfg) {
  const hs = sleepState(cfg);
  console.log(hs.on ? `人类休眠模式: 开启（自 ${hs.since || '未知'}）` : '人类休眠模式: 关闭');
  console.log(`配置: ${cfg.__file}`);
  console.log(`信箱目录: ${cfg.queueDir}`);
  console.log('\n== 软件 ==');
  for (const sw of cfg.software) {
    const q = quotaState(cfg, sw.id);
    const enabled = sw.enabled === false ? '停用' : '启用';
    console.log(`  ${sw.id.padEnd(10)} ${String(sw.adapter).padEnd(12)} ${enabled}  额度 ${q.available ? '可用' : '不可用' + (q.reason ? '：' + q.reason : '')}`);
  }
  console.log('\n== 会话 ==');
  const buckets = new Map();
  for (const s of cfg.sessions) {
    const k = `${s.software}/${s.category}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(s);
  }
  for (const [k, arr] of [...buckets.entries()].sort()) {
    console.log(`\n  ${k}  共 ${arr.length} 个${arr.length > 1 ? '（用 #序号 指定）' : ''}`);
    arr.sort((a, b) => a.alias.localeCompare(b.alias));
    arr.forEach((s, i) => {
      const idx = arr.length > 1 ? `#${i + 1}` : '';
      const state = s.enabled === false ? '停用' : '启用';
      console.log(`    ${s.alias.padEnd(16)} ${state}  id=${s.id}`);
      if (s.note) console.log(`       ${s.note}`);
    });
  }
  const blocked = cfg.blocked || [];
  if (blocked.length) {
    console.log('\n== 禁止投递 ==');
    for (const b of blocked) console.log(`  ${b.alias || b.id}  ${b.reason || ''}`);
  }
  return 0;
}

async function cmdDoctor(cfg) {
  const problems = [];
  const notes = [];
  console.log('== 配置 ==');
  try {
    validateConfig(cfg, cfg.__file);
    console.log('  结构合法');
  } catch (e) {
    problems.push(e.message);
  }
  const placeholder = cfg.sessions.filter((s) => /在此填|填 |TODO|xxx/i.test(String(s.id)));
  if (placeholder.length) {
    problems.push(`有 ${placeholder.length} 个会话还是占位 id：${placeholder.map((s) => s.alias).join(', ')}`);
  }

  // 同一个 id 挂多个别名是允许的，但必须提醒：队列按别名分文件，
  // 消息可能落进 A 的队列，而收件的人只看 B，等于漏件。
  // 占位 id 不算重复（模板里多个会话都用占位符说明「还没填」）。
  const byId = new Map();
  for (const s of cfg.sessions) {
    if (/在此填|填 /i.test(String(s.id))) continue;
    if (!byId.has(s.id)) byId.set(s.id, []);
    byId.get(s.id).push(s.alias);
  }
  for (const [id, aliases] of byId) {
    if (aliases.length > 1) {
      notes.push(`同一会话 id 挂了多个别名（${aliases.join(', ')}），队列按别名分文件，收件时要逐个 receive，否则会漏。`);
    }
  }

  console.log('\n== 通道 ==');
  for (const sw of cfg.software) {
    if (sw.enabled === false) { console.log(`  ${sw.id}  停用，跳过`); continue; }
    try {
      const r = await adapterFor(sw).health(cfg, sw);
      console.log(`  ${sw.id}  OK  ${r.detail}`);
    } catch (e) {
      console.log(`  ${sw.id}  失败  ${e.message}`);
      notes.push(`${sw.id}: ${e.message}`);
    }
  }

  console.log('\n== 信箱 ==');
  const snaps = queueSnapshot(cfg);
  const withData = snaps.filter((s) => s.total);
  if (!withData.length) console.log('  全部为空');
  for (const s of withData) {
    console.log(`  ${s.session.alias}  pending ${s.pending}  sending ${s.sending}  unconfirmed ${s.unconfirmed}  坏行 ${s.badLines}`);
    if (s.badLines) problems.push(`${s.session.alias} 的队列里有 ${s.badLines} 行无法解析（已保留，不会丢，但需要人工看）`);
    if (s.sending) problems.push(`${s.session.alias} 有 ${s.sending} 条处于 sending，可能是上次投递中途退出，flush 会在 5 分钟后回收`);
  }
  const arc = archiveTail(cfg, 0);
  console.log(`  归档 ${arc.total} 条`);

  console.log('\n== 人类休眠标志 ==');
  const hs = sleepState(cfg);
  console.log(hs.on ? `  开启（自 ${hs.since || '未知'}）` : '  关闭');
  console.log('  注：此字段只读。任何 AI 不得写，只有人类的面板开关能改。');

  if (notes.length) {
    console.log('\n== 提示 ==');
    for (const n of notes) console.log(`  - ${n}`);
  }
  if (problems.length) {
    console.log('\n== 需要修 ==');
    for (const p of problems) console.log(`  - ${p}`);
    return 1;
  }
  console.log('\n自检通过');
  return 0;
}

function cmdSession(cfg, { flags, positional }) {
  const sub = positional[0];
  const file = cfg.__file;
  if (sub === 'add') {
    const alias = String(flags.get('alias') || '');
    const software = String(flags.get('software') || '');
    const category = String(flags.get('category') || '');
    const id = String(flags.get('id') || '');
    if (!alias || !software || !category || !id) {
      throw new BridgeError('session add 需要 --alias --software --category --id', '例：session add --alias learn-1 --software dsh --category learn --id session-xxx');
    }
    if (cfg.sessions.some((s) => s.alias === alias)) throw new BridgeError(`别名已存在：${alias}`);
    cfg.sessions.push({ alias, software, category, id, enabled: true, note: flags.get('note') ? String(flags.get('note')) : undefined });
    saveConfig(cfg, file);
    console.log(`已添加 ${alias} → ${software}/${category}`);
    return 0;
  }
  if (sub === 'rm') {
    const alias = String(flags.get('alias') || positional[1] || '');
    const i = cfg.sessions.findIndex((s) => s.alias === alias);
    if (i < 0) throw new BridgeError(`找不到别名：${alias}`);
    cfg.sessions.splice(i, 1);
    saveConfig(cfg, file);
    console.log(`已删除 ${alias}（队列文件如仍存在，需手动清理）`);
    return 0;
  }
  if (sub === 'on' || sub === 'off') {
    // 这里不能用 resolveTarget：它会把停用/blocked 的会话当成不可投递直接抛错，
    // 而启停命令恰恰就是用来改这个状态的。按别名原始查表。
    const alias = String(flags.get('alias') || positional[1] || '');
    const target = cfg.sessions.find((s) => s.alias === alias);
    if (!target) throw new BridgeError(`找不到别名：${alias}`, `可用：${cfg.sessions.map((s) => s.alias).join(', ')}`);
    target.enabled = sub === 'on';
    saveConfig(cfg, file);
    console.log(`${target.alias} 已${sub === 'on' ? '启用' : '停用'}`);
    return 0;
  }
  throw new BridgeError('session 子命令只能是 add|rm|on|off');
}

function cmdQuota(cfg, { flags, positional }) {
  const sub = positional[0];
  const sw = String(flags.get('software') || positional[1] || '');
  if (!sw) throw new BridgeError('需要 --software <id>');
  if (!cfg.software.some((s) => s.id === sw)) throw new BridgeError(`没有这个软件：${sw}`);
  cfg.quota ||= {};
  if (sub === 'set') {
    const until = flags.get('until') ? String(flags.get('until')) : null;
    if (until && !/T.*(Z|[+-]\d{2}:\d{2})$/.test(until)) {
      throw new BridgeError(`--until 必须带时区或 Z：${until}`, '例：2026-11-20T04:10:00+08:00。不带时区会差 8 小时。');
    }
    cfg.quota[sw] = { available: false, exhaustedUntil: until, note: flags.get('note') ? String(flags.get('note')) : '' };
    saveConfig(cfg, cfg.__file);
    console.log(`${sw} 标为额度耗尽${until ? `，${until} 自动恢复` : '，未设恢复时刻'}`);
    return 0;
  }
  if (sub === 'clear') {
    cfg.quota[sw] = { available: true, exhaustedUntil: null, note: '' };
    saveConfig(cfg, cfg.__file);
    console.log(`${sw} 额度恢复为可用`);
    return 0;
  }
  throw new BridgeError('quota 子命令只能是 set|clear');
}

function cmdBlocked(cfg, { flags, positional }) {
  const sub = positional[0];
  if (sub === 'add') {
    const alias = flags.get('alias') ? String(flags.get('alias')) : null;
    const id = flags.get('id') ? String(flags.get('id')) : null;
    if (!alias && !id) throw new BridgeError('blocked add 需要 --alias 或 --id');
    cfg.blocked ||= [];
    cfg.blocked.push({ alias, id, reason: flags.get('reason') ? String(flags.get('reason')) : '' });
    saveConfig(cfg, cfg.__file);
    console.log(`已加入禁止投递：${alias || id}`);
    return 0;
  }
  if (sub === 'rm') {
    const key = String(flags.get('alias') || flags.get('id') || positional[1] || '');
    cfg.blocked = (cfg.blocked || []).filter((b) => b.alias !== key && b.id !== key);
    saveConfig(cfg, cfg.__file);
    console.log(`已移出禁止投递：${key}`);
    return 0;
  }
  throw new BridgeError('blocked 子命令只能是 add|rm');
}

export async function runAdmin(cmd, ctx) {
  if (cmd === 'init') return cmdInit(ctx);
  const cfg = ctx.cfg;
  if (!cfg) throw new BridgeError('此命令需要先有配置文件', '运行 agent-bridge init。');
  if (cmd === 'list') return cmdList(cfg);
  if (cmd === 'doctor') return cmdDoctor(cfg);
  if (cmd === 'session') return cmdSession(cfg, ctx);
  if (cmd === 'quota') return cmdQuota(cfg, ctx);
  if (cmd === 'blocked') return cmdBlocked(cfg, ctx);
  throw new BridgeError(`未知管理命令：${cmd}`);
}
