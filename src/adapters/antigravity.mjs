// Antigravity（Gemini）适配器：走 CDP 注入界面输入框。
// 硬限制：只能发给界面里已经打开的对话。未打开时由上层转入信箱。
import { readFileSync, existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BridgeError } from '../config.mjs';
import { sleep } from '../util.mjs';

const UUID_RE = /\/c\/([0-9a-fA-F-]{36})/;

function portOf(sw) {
  const p = sw.options.devtoolsPortFile;
  if (!p || !existsSync(p)) {
    throw new BridgeError(`找不到 Antigravity 调试端口文件：${p || '(未配置 options.devtoolsPortFile)'}`, '确认 Antigravity 正在运行；路径通常是 %APPDATA%/Antigravity/DevToolsActivePort。');
  }
  return readFileSync(p, 'utf8').trim().split('\n')[0].trim();
}

async function pages(sw) {
  const port = portOf(sw);
  const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json());
  return list
    .filter((t) => t.type === 'page' && t.url && t.url.includes('/c/'))
    .map((t) => ({ ...t, uuid: (UUID_RE.exec(t.url) || [])[1] }));
}

function transcriptPath(sw, uuid) {
  const root = sw.options.dataRoot || join(process.env.USERPROFILE || '', '.gemini');
  return join(root, 'antigravity', 'brain', uuid, '.system_generated', 'logs', 'transcript.jsonl');
}

// 从上次读到的字节偏移继续读。旧实现每轮 500ms 重读整个 transcript，
// 长会话下是 O(n^2)，几万行时明显拖慢。
function readFrom(file, offset) {
  if (!existsSync(file)) return { text: '', offset };
  const size = statSync(file).size;
  if (size <= offset) return { text: '', offset: size };
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    return { text: buf.toString('utf8'), offset: size };
  } finally {
    closeSync(fd);
  }
}

function currentInputText(expr) {
  return `(() => {
    const el = document.querySelector('[contenteditable="true"][role="combobox"]');
    if (!el) return { found: false };
    const t = el.innerText || el.textContent || '';
    return { found: true, len: t.trim().length, compact: t.replace(/\\s+/g, '').length };
  })()`;
}

// 判定目标对话是否已打开（纯函数，便于脱离 Electron 单测）。
//
// 只回答「这个 id 现在开没开」，不因为开了多个窗口就拒绝投递。
// 多窗口是风险提示，不是拦截条件：是否同时只开一个由使用者自己控制。
export function evaluateTargetOpen(list, sessionId) {
  const uuids = list.map((p) => p.uuid).filter(Boolean);
  const want = String(sessionId || '').toLowerCase();
  const hit = list.find((p) => p.uuid && p.uuid.toLowerCase() === want);

  if (hit) {
    return {
      asleep: false,
      page: hit,
      // 多窗口时给出提示，供 doctor 打印，不改变投递行为。
      warning: uuids.length > 1
        ? `同时打开了 ${uuids.length} 个对话（${uuids.join(', ')}），无法保证注入落在前台那个；建议只保留目标窗口`
        : null,
    };
  }
  const seen = uuids.join(', ') || '无';
  return { asleep: true, reason: `目标 ${sessionId} 未打开，当前打开：${seen}` };
}

export const antigravity = {
  id: 'antigravity',
  label: 'Antigravity / Gemini',

  async health(cfg, sw) {
    const list = await pages(sw);
    if (list.length > 1) {
      return {
        ok: true,
        detail: `端口可读，但同时打开了 ${list.length} 个对话（${list.map((p) => p.uuid).join(', ')}）。仍可投递，但无法保证注入落在前台那个，建议只留一个窗口`,
      };
    }
    return {
      ok: true,
      detail: list.length ? `已打开 1 个对话：${list[0].uuid}` : '端口可读，但当前没有打开任何对话',
    };
  },

  // 返回 { asleep:true, reason } 表示目标没打开，调用方应入队而不是报错。
  async wakeState(cfg, sw, session) {
    let list;
    try {
      list = await pages(sw);
    } catch (e) {
      return { asleep: true, reason: e.message };
    }
    return evaluateTargetOpen(list, session.id);
  },

  async send(cfg, sw, session, message, opts = {}) {
    const state = await this.wakeState(cfg, sw, session);
    if (state.asleep) {
      const err = new BridgeError(state.reason, '在 Antigravity 界面切到该对话并保持打开，再执行 `postgull flush <别名>`。');
      err.sleeping = true;
      throw err;
    }
    const page = state.page;
    const transcript = transcriptPath(sw, page.uuid);
    const offset = existsSync(transcript) ? statSync(transcript).size : 0;

    // 连接必须带硬超时。没有超时的话，Electron 握手挂起或端口被别的程序占着，
    // 这个 Promise 会永久卡住，整个 flush 就死在这一条上，后面的消息全投不出去。
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const connectTimeout = Number(sw.options.cdpConnectTimeoutMs || 8000);
    await new Promise((res, rej) => {
      let settled = false;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        // 先关连接再 reject。close() 会触发 onerror，所以必须用 timedOut 标记
        // 让 onerror 让路，否则用户看到的是「连接失败」而不是「超时」，排查方向会错。
        try { ws.close(); } catch {}
        if (settled) return;
        settled = true;
        rej(new BridgeError(
          `CDP 连接超过 ${Math.round(connectTimeout / 1000)} 秒未建立（握手无响应）`,
          'Antigravity 可能卡住，或调试端口被别的程序占着。重启 Antigravity 后重试；也可以调大 options.cdpConnectTimeoutMs。',
        ));
      }, connectTimeout);
      ws.onopen = () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        res();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        if (settled || timedOut) return;
        settled = true;
        rej(new BridgeError('CDP 连接失败', 'Antigravity 可能刚重启，端口已变，重试一次。'));
      };
    });
    let seq = 0;
    // 单次 CDP 调用也要超时。某个方法不返回响应时，不能让调用方无限等。
    const callTimeout = Number(sw.options.cdpCallTimeoutMs || 5000);
    const call = (method, params) => new Promise((resolve, reject) => {
      const myId = ++seq;
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        ws.removeEventListener('message', onMsg);
        reject(new BridgeError(`CDP 调用 ${method} 超过 ${Math.round(callTimeout / 1000)} 秒无响应`, '界面可能卡住，重试或重启 Antigravity。'));
      }, callTimeout);
      const onMsg = (ev) => {
        let r;
        try { r = JSON.parse(ev.data); } catch { return; }
        if (r.id !== myId) return;
        if (done) return;
        done = true;
        clearTimeout(timer);
        ws.removeEventListener('message', onMsg);
        r.error ? reject(new Error(r.error.message)) : resolve(r.result);
      };
      ws.addEventListener('message', onMsg);
      try {
        ws.send(JSON.stringify({ id: myId, method, params }));
      } catch (e) {
        done = true;
        clearTimeout(timer);
        ws.removeEventListener('message', onMsg);
        reject(e);
      }
    });

    try {
      const pre = await call('Runtime.evaluate', { returnByValue: true, expression: currentInputText() });
      const v = pre?.result?.value || {};
      if (!v.found) throw new BridgeError('找不到 Antigravity 输入框', '界面可能还在加载，或该版本改了选择器。');
      if (v.len > 0) throw new BridgeError(`输入框里已有 ${v.len} 字草稿，拒绝覆盖`, '先手动清空输入框或把草稿发出去。');

      // 新版输入框把换行当发送键，整段插入会在第一个换行处就发出去。
      // 逐行插入 + 行间 Shift+Enter 软换行，插完比对字数，不齐就中止。
      const lines = String(message).split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]) await call('Input.insertText', { text: lines[i] });
        if (i < lines.length - 1) {
          await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter', modifiers: 8 });
          await call('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter', modifiers: 8 });
        }
      }
      await sleep(200);

      const chk = await call('Runtime.evaluate', { returnByValue: true, expression: currentInputText() });
      const got = chk?.result?.value?.compact;
      const want = String(message).replace(/\s+/g, '').length;
      if (typeof got !== 'number' || got < 0) throw new BridgeError('注入后读不到输入框内容，已中止', '');
      if (Math.abs(got - want) > Math.max(8, Math.round(want * 0.02))) {
        throw new BridgeError(`注入不完整：应有 ${want} 字，输入框只有 ${got} 字，已中止`, '窗口可能被切走。消息会进信箱，切回该对话后 flush。');
      }
      await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 13, unmodifiedText: '\r', text: '\r', key: 'Enter', code: 'Enter' });
      await call('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
    } finally {
      ws.close();
    }

    // 注入成功不等于对方收下。以 transcript 里出现含凭证的 USER_INPUT 为唯一判据。
    const token = message.match(/【唯一凭证：([^】]+)】/)?.[1] || '';
    const deadline = Date.now() + Number(opts.waitMs ?? process.env.POSTGULL_WAIT_MS ?? 45000);
    let cursor = offset;
    while (Date.now() < deadline) {
      const { text, offset: next } = readFrom(transcript, cursor);
      cursor = next;
      if (text && token && text.includes(token)) return { channel: 'CDP 注入并已确认接受', accepted: true };
      await sleep(500);
    }
    return { channel: 'CDP 注入', accepted: false, reason: 'transcript 未在时限内出现本凭证（窗口可能被切走或对方忙）' };
  },
};
