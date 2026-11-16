// 只读验证：确认新增的 CDP 连接超时与调用超时不会破坏正常路径，也不会挂死。
// 只查页面标题，不注入任何文字，不改对话内容。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const portFile = join(process.env.APPDATA, 'Antigravity', 'DevToolsActivePort');
const port = readFileSync(portFile, 'utf8').trim().split('\n')[0].trim();
const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const page = pages.find((p) => p.type === 'page' && p.url && p.url.includes('/c/'));
if (!page) { console.log('没有打开的对话页面'); process.exit(0); }

const uuid = (page.url.match(/\/c\/([0-9a-f-]{36})/i) || [])[1];
console.log('目标页面:', uuid);

const CONNECT_MS = 8000;
const CALL_MS = 5000;

const ws = new WebSocket(page.webSocketDebuggerUrl);
const t0 = Date.now();
await new Promise((res, rej) => {
  const timer = setTimeout(() => {
    try { ws.close(); } catch {}
    rej(new Error(`连接超过 ${CONNECT_MS}ms 未建立`));
  }, CONNECT_MS);
  ws.onopen = () => { clearTimeout(timer); res(); };
  ws.onerror = () => { clearTimeout(timer); rej(new Error('连接失败')); };
});
console.log('连接建立，耗时', Date.now() - t0, 'ms');

let seq = 0;
const call = (method, params) => new Promise((resolve, reject) => {
  const myId = ++seq;
  let done = false;
  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    reject(new Error(`${method} 超过 ${CALL_MS}ms 无响应`));
  }, CALL_MS);
  const onMsg = (ev) => {
    let r;
    try { r = JSON.parse(ev.data); } catch { return; }
    if (r.id !== myId || done) return;
    done = true;
    clearTimeout(timer);
    ws.removeEventListener('message', onMsg);
    r.error ? reject(new Error(r.error.message)) : resolve(r.result);
  };
  ws.addEventListener('message', onMsg);
  ws.send(JSON.stringify({ id: myId, method, params }));
});

const t1 = Date.now();
const r = await call('Runtime.evaluate', {
  expression: 'document.title',
  returnByValue: true,
});
console.log('调用返回，耗时', Date.now() - t1, 'ms');
console.log('页面标题:', String(r.result?.value || '').slice(0, 60));
ws.close();
console.log('结论: 连接与调用超时包装未影响正常路径');
