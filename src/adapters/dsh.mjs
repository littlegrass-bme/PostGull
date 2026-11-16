// DSH（DeepSeek Harness）适配器：本地 HTTP API，session/prompt steer 投递。
// 端口发现结果在同一进程内缓存，避免每条消息都扫一遍监听端口。
import { readFileSync, existsSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { BridgeError, softwareOf } from '../config.mjs';
import { cached, sleep } from '../util.mjs';

function readSecret(sw) {
  const env = process.env.DSH_SECRET;
  if (env) return Buffer.from(env + '='.repeat((4 - (env.length % 4)) % 4), 'base64url');
  const p = sw.options.credentials;
  if (!p || !existsSync(p)) {
    throw new BridgeError(`找不到 DSH 凭据文件：${p || '(未配置 options.credentials)'}`, '在配置里给 dsh 软件填 options.credentials，或设环境变量 DSH_SECRET。');
  }
  const m = readFileSync(p, 'utf8').match(/secret:\s*([A-Za-z0-9_-]+)/);
  if (!m) throw new BridgeError(`凭据文件里没有 secret 字段：${p}`);
  return Buffer.from(m[1] + '='.repeat((4 - (m[1].length % 4)) % 4), 'base64url');
}

function cookieFor(authority, secret) {
  const name = 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url');
  const now = Date.now();
  const body = Buffer.from(
    JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 86400000 }),
  ).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${name}=v1.${body}.${sig}`;
}

// netstat 扫监听端口。DSH 桌面端用随机端口启动，只能先列再逐个探测。
function listenPorts() {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const ports = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const m = line.trim().split(/\s+/)[1] || '';
      const p = Number(m.split(':').pop());
      if (Number.isInteger(p) && p > 0) ports.add(p);
    }
    return [...ports];
  } catch {
    return [];
  }
}

async function probe(authority, secret, timeout = 800) {
  const cookie = cookieFor(authority, secret);
  const res = await fetch(`http://${authority}/api/session/list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: 'probe', method: 'session/list', payload: { args: { _request: {} } } }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) return null;
  const json = await res.json();
  if (json?.result?.ok === false) return null;
  return { port: authority.split(':')[1], cookie, items: json.result.value.items || [] };
}

async function discover(sw) {
  return cached(`dsh:${sw.id}`, async () => {
    const secret = readSecret(sw);
    const explicit = [];
    if (sw.options.host && sw.options.port) explicit.push(`${sw.options.host}:${sw.options.port}`);
    const envUrl = process.env.DSH_WEB_URL;
    if (envUrl) {
      try { explicit.push(new URL(envUrl).host); } catch {}
    }
    const candidates = [
      ...explicit,
      ...(sw.options.ports || []).map((p) => `127.0.0.1:${p}`),
      ...listenPorts().map((p) => `127.0.0.1:${p}`),
    ];
    const seen = new Set();
    for (const authority of candidates) {
      if (seen.has(authority)) continue;
      seen.add(authority);
      try {
        const hit = await probe(authority, secret);
        if (hit) return hit;
      } catch { /* 下一个 */ }
    }
    throw new BridgeError('连不上 DSH 桌面端：未找到可响应的本地端口', '确认 DSH 正在运行。桌面端端口随机，会在每次启动后变化。');
  });
}

async function api(ctx, method, args) {
  const res = await fetch(`http://127.0.0.1:${ctx.port}/api/${method.replace('/', '/')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: ctx.cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: String(Math.random()).slice(2), method, payload: { args } }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`DSH API ${method} HTTP ${res.status}`);
  const json = await res.json();
  if (json?.result?.ok === false) throw new Error(`DSH API ${method} 返回失败：${JSON.stringify(json.result).slice(0, 200)}`);
  return json.result?.value;
}

export const dsh = {
  id: 'dsh',
  label: 'DeepSeek Harness',

  async health(cfg, sw) {
    const ctx = await discover(sw);
    return { ok: true, detail: `端口 ${ctx.port}，在线会话 ${ctx.items.length} 个` };
  },

  // 投递并等对侧事件里出现本凭证。返回 accepted=true 才算送达。
  async send(cfg, sw, session, message, opts = {}) {
    const ctx = await discover(sw);
    const known = ctx.items.some((it) => it.sessionId === session.id);
    if (!known) {
      throw new BridgeError(`DSH 里没有会话 ${session.id}（${session.alias}）`, '会话可能已删除，用 `agent-bridge list` 核对，或重新登记。');
    }
    await api(ctx, 'session/prompt', {
      request: {
        requestId: `bridge-${Date.now()}`,
        sessionId: session.id,
        mode: 'steer',
        content: [{ type: 'text', text: message }],
        clientTimeZone: 'Asia/Shanghai',
      },
    });

    const waitMs = Number(opts.waitMs ?? sw.options.verifyTimeoutMs ?? 8000);
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const v = await api(ctx, 'session/events', {
        request: { address: { kind: 'session', sessionId: session.id }, maxMessages: 200 },
      });
      const hit = (v?.records || []).some((r) => JSON.stringify(r).includes(message.match(/【唯一凭证：([^】]+)】/)?.[1] || '___'));
      if (hit) return { channel: 'DSH API steer', accepted: true };
      await sleep(500);
    }
    return { channel: 'DSH API steer', accepted: false, reason: 'steer 已提交，但会话事件里未在时限内出现凭证' };
  },
};
