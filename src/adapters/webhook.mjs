// 通用 HTTP 适配器：给「自定义软件」留的出口。
// 任何能收 HTTP POST 的系统（自建服务、机器人网关、n8n 之类）都能接进来，
// 不必等官方适配。对方收到 JSON 后自行处理，返回 2xx 即视为已接收。
import { BridgeError } from '../config.mjs';

export const webhook = {
  id: 'webhook',
  label: 'Webhook（自定义软件）',

  async health(cfg, sw) {
    if (!sw.options.url) throw new BridgeError(`webhook 软件 ${sw.id} 缺少 options.url`);
    return { ok: true, detail: `POST ${sw.options.url}` };
  },

  async send(cfg, sw, session, message) {
    if (!sw.options.url) throw new BridgeError(`webhook 软件 ${sw.id} 缺少 options.url`);
    const body = {
      from: cfg.bridgeName || 'agent-bridge',
      to: { alias: session.alias, software: session.software, category: session.category, id: session.id },
      token: message.match(/【唯一凭证：([^】]+)】/)?.[1] || null,
      text: message,
      sentAt: new Date().toISOString(),
    };
    const res = await fetch(sw.options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(sw.options.headers || {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(sw.options.timeoutMs || 20000)),
    }).catch((e) => {
      throw new BridgeError(`webhook 请求失败：${e.message}`, '确认对端服务在运行、URL 正确。');
    });
    if (!res.ok) throw new BridgeError(`webhook 返回 HTTP ${res.status}`, '对端拒绝接收，检查它的鉴权头。');
    return { channel: 'webhook 2xx', accepted: true };
  },
};
