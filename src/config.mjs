// 配置层。所有软件、类别、会话都由用户在 postgull.config.json 里定义，
// 代码里不再出现任何写死的软件名、类别名或会话 id。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { expandPath, ensureDir } from './util.mjs';

export const DEFAULT_CONFIG_NAME = 'postgull.config.json';

// 内置适配器。software[].adapter 必须是其中之一；未知值直接报错，不静默降级。
export const ADAPTERS = ['dsh', 'codex', 'antigravity', 'claude', 'webhook'];

export class BridgeError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

export function configPath(argvPath) {
  if (argvPath) return expandPath(argvPath);
  if (process.env.POSTGULL_CONFIG) return expandPath(process.env.POSTGULL_CONFIG);
  // 默认：当前目录 → 可执行文件所在目录 → %APPDATA%/PostGull
  const cwd = join(process.cwd(), DEFAULT_CONFIG_NAME);
  if (existsSync(cwd)) return cwd;
  const exeDir = dirname(process.execPath);
  const near = join(exeDir, DEFAULT_CONFIG_NAME);
  if (existsSync(near)) return near;
  const appdata = process.env.APPDATA ? join(process.env.APPDATA, 'PostGull', DEFAULT_CONFIG_NAME) : null;
  if (appdata) return appdata;
  return cwd;
}

export function loadConfig(argvPath) {
  const file = configPath(argvPath);
  if (!existsSync(file)) {
    throw new BridgeError(
      `找不到配置文件：${file}`,
      '先运行 `postgull init` 生成配置，或加 --config <路径>。',
    );
  }
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new BridgeError(`配置文件不是合法 JSON：${file}`, e.message);
  }
  cfg.__file = file;
  cfg.__dir = dirname(file);
  validateConfig(cfg, file);
  // queueDir 与端口文件等相对路径，统一按配置文件所在目录解析，
  // 这样整个目录可以整体拷贝给另一台机器。
  cfg.queueDir = expandPath(cfg.queueDir ? join(cfg.__dir, cfg.queueDir) : join(cfg.__dir, 'queue'));
  for (const sw of cfg.software) {
    sw.options ||= {};
    if (sw.options.credentials) sw.options.credentials = expandPath(sw.options.credentials);
    if (sw.options.devtoolsPortFile) sw.options.devtoolsPortFile = expandPath(sw.options.devtoolsPortFile);
    if (sw.options.dataRoot) sw.options.dataRoot = expandPath(sw.options.dataRoot);
  }
  return cfg;
}

export function validateConfig(cfg, file = '(config)') {
  const problems = [];
  if (!Array.isArray(cfg.software) || !cfg.software.length) problems.push('缺少 software 数组');
  if (!Array.isArray(cfg.sessions)) problems.push('缺少 sessions 数组（可以为空数组）');
  const swIds = new Set();
  for (const [i, sw] of (cfg.software || []).entries()) {
    if (!sw.id) problems.push(`software[${i}] 缺少 id`);
    if (swIds.has(sw.id)) problems.push(`software id 重复：${sw.id}`);
    swIds.add(sw.id);
    if (!sw.adapter) problems.push(`software[${i}] (${sw.id}) 缺少 adapter`);
    else if (!ADAPTERS.includes(sw.adapter)) {
      problems.push(`software[${i}] (${sw.id}) 的 adapter "${sw.adapter}" 不受支持，可选：${ADAPTERS.join(', ')}`);
    }
  }
  const aliases = new Set();
  for (const [i, s] of (cfg.sessions || []).entries()) {
    if (!s.alias) problems.push(`sessions[${i}] 缺少 alias`);
    if (aliases.has(s.alias)) problems.push(`会话 alias 重复：${s.alias}`);
    aliases.add(s.alias);
    if (!s.software) problems.push(`sessions[${i}] (${s.alias || '?'}) 缺少 software`);
    else if (!swIds.has(s.software)) problems.push(`sessions[${i}] (${s.alias}) 的 software "${s.software}" 不在 software 列表里`);
    if (!s.id) problems.push(`sessions[${i}] (${s.alias || '?'}) 缺少 id`);
    if (!s.category) problems.push(`sessions[${i}] (${s.alias || '?'}) 缺少 category，类别名可自定义，例如 work / bridge / learn`);
    if (s.alias && !/^[A-Za-z0-9._-]{1,40}$/.test(s.alias)) {
      problems.push(`sessions[${i}] alias "${s.alias}" 只能含字母数字点横线下划线，因为要拿来做队列文件名`);
    }
  }
  if (problems.length) {
    throw new BridgeError(`配置有问题：${file}\n  - ${problems.join('\n  - ')}`);
  }
  cfg.quota ||= {};
  cfg.blocked ||= [];
  return cfg;
}

export function saveConfig(cfg, file) {
  const clone = { ...cfg };
  delete clone.__file;
  delete clone.__dir;
  delete clone.queueDir;
  ensureDir(dirname(file));
  writeFileSync(file, JSON.stringify(clone, null, 2), 'utf8');
}

// ---------- 目标解析 ----------
// 支持三种写法：
//   --to dsh-work-1            别名，最稳
//   --to dsh/work              软件/类别，该桶里必须唯一
//   --to dsh/work#2            软件/类别#序号，按别名排序，从 1 开始
// 也允许 --software dsh --category work 的组合写法。
export function resolveTarget(cfg, spec, category) {
  if (!spec) throw new BridgeError('缺少目标。用 --to <别名> 或 --to <软件>/<类别>', '先运行 `postgull list` 看有哪些会话。');

  // 被 blocked 的 id 与别名一律拒绝；停用（enabled:false）的会话同样不可投递。
  // 两者要分别报错：把「已停用」说成「在 blocked 里」会让人找不到原因。
  const blockedReason = (s) => {
    if (cfg.blocked.some((b) => (b.id && b.id === s.id) || (b.alias && b.alias === s.alias))) {
      return `会话 ${s.alias} 在 blocked 名单里，拒绝投递`;
    }
    if (s.enabled === false) return `会话 ${s.alias} 已停用，拒绝投递`;
    return null;
  };
  const isBlocked = (s) => blockedReason(s) !== null;
  const assertSendable = (s) => {
    const why = blockedReason(s);
    if (why) {
      throw new BridgeError(why, '把 blocked 条目删掉，或执行 `postgull session on --alias <别名>` 重新启用。');
    }
    return s;
  };

  if (spec.includes('/')) {
    const [sw, rest] = spec.split('/');
    const [cat, idxRaw] = rest.split('#');
    return assertSendable(pickFromBucket(cfg, sw, cat, idxRaw ? Number(idxRaw) : null, isBlocked));
  }

  const byAlias = cfg.sessions.find((s) => s.alias === spec);
  if (byAlias) return assertSendable(byAlias);

  // --to <软件> --category <类别>
  if (category) return assertSendable(pickFromBucket(cfg, spec, category, null, isBlocked));

  // --to <软件>：该软件下只有一个会话时允许省略别名
  const sameSw = cfg.sessions.filter((s) => s.software === spec);
  if (sameSw.length === 1) return assertSendable(sameSw[0]);
  if (sameSw.length > 1) {
    throw new BridgeError(
      `软件 ${spec} 下有 ${sameSw.length} 个会话，必须指明：${sameSw.map((s) => s.alias).join(', ')}`,
      '用 --to <别名>，或 --to <软件>/<类别>。',
    );
  }
  throw new BridgeError(
    `找不到目标：${spec}`,
    `可用别名：${cfg.sessions.map((s) => s.alias).join(', ') || '(未配置任何会话)'}`,
  );
}

function pickFromBucket(cfg, sw, cat, idx, isBlocked) {
  const bucket = cfg.sessions
    .filter((s) => s.software === sw && s.category === cat && !isBlocked(s))
    .sort((a, b) => a.alias.localeCompare(b.alias));
  if (!bucket.length) {
    const known = cfg.sessions.map((s) => `${s.software}/${s.category}`).join(', ');
    throw new BridgeError(`没有匹配 ${sw}/${cat} 的会话`, `已配置：${known || '无'}`);
  }
  if (idx === null) {
    if (bucket.length > 1) {
      throw new BridgeError(
        `${sw}/${cat} 下有 ${bucket.length} 个会话，需要指明序号`,
        `用 ${bucket.map((s, i) => `${sw}/${cat}#${i + 1}(${s.alias})`).join(' 或 ')}`,
      );
    }
    return bucket[0];
  }
  if (!Number.isInteger(idx) || idx < 1 || idx > bucket.length) {
    throw new BridgeError(`${sw}/${cat}#${idx} 不存在，共 ${bucket.length} 个`, `序号范围 1..${bucket.length}`);
  }
  return bucket[idx - 1];
}

export function softwareOf(cfg, session) {
  const sw = cfg.software.find((s) => s.id === session.software);
  if (!sw) throw new BridgeError(`会话 ${session.alias} 引用了不存在的软件 ${session.software}`);
  return sw;
}

export function quotaState(cfg, softwareId) {
  const q = (cfg.quota || {})[softwareId];
  if (!q) return { available: true, reason: null };
  if (q.available !== false) return { available: true, reason: null };
  if (q.exhaustedUntil) {
    const until = Date.parse(q.exhaustedUntil);
    if (Number.isFinite(until) && Date.now() >= until) return { available: true, reason: null };
    const left = Number.isFinite(until) ? Math.max(0, Math.round((until - Date.now()) / 60000)) : null;
    return {
      available: false,
      reason: `${softwareId} 额度耗尽，${q.exhaustedUntil} 刷新` + (left !== null ? `（约 ${left} 分钟后）` : ''),
    };
  }
  return { available: false, reason: `${softwareId} 额度耗尽${q.note ? '：' + q.note : ''}` };
}

export function queueFileFor(cfg, session) {
  return join(cfg.queueDir, `${session.alias}.jsonl`);
}

// 测试免进名单。这是真实事故换来的：测通道时图省事，拿唯一打开着的 work 会话当靶子，
// 把 4 条自测消息直接灌进了正在干活的对话。
// 规则：category 命中 testing.blockedCategories（默认 work）的会话，
// 只接受 --test 显式放行，否则一律拒绝。默认拦 work 不拦 bridge。
export function assertTestAllowed(cfg, session, isTest) {
  if (!isTest) return;
  const t = cfg.testing || {};
  const blockedCats = t.blockedCategories || ['work'];
  if (blockedCats.includes(session.category)) {
    throw new BridgeError(
      `拒绝把测试消息发进 ${session.alias}（类别 ${session.category}）`,
      `测试请发 bridge 类会话；确实要发这个会话，加 --i-know-its-work 显式放行，或改配置里的 testing.blockedCategories。`,
    );
  }
}

// 人类休眠标志只读。这是硬边界：任何 AI 都不得写，真相只有面板开关知道。
export function sleepState(cfg) {
  return {
    on: cfg.humanSleeping === true,
    since: cfg.humanSleepingSince || null,
    note: cfg.humanSleepingNote || '',
  };
}
