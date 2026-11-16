// 通用跨软件消息桥接器：基础工具层。
// 设计约束：
//   1. 不存在任何写死的绝对路径与个人会话 id，一律来自配置或环境变量。
//   2. jsonl 读写必须能保住解析失败的行，不能因为一行坏了就把整队消息静默丢掉。
//   3. 写入用临时文件 + rename，避免半截文件让下一次读取整队失败。

import {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync,
  renameSync, unlinkSync, readdirSync, statSync, openSync, readSync, closeSync,
} from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { randomBytes } from 'node:crypto';

export const VERSION = '1.0.0';

// ---------- 路径 ----------
// 配置里允许 %APPDATA%、~ 这类写法，一律在这里展开，避免使用者手写绝对路径。
export function expandPath(p) {
  if (!p) return p;
  let s = String(p);
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (s === '~') return home;
  if (s.startsWith('~/') || s.startsWith('~\\')) s = join(home, s.slice(2));
  s = s.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? '');
  return resolvePath(s);
}

export function ensureDir(p) {
  mkdirSync(p, { recursive: true });
  return p;
}

// ---------- jsonl ----------
// 返回 { records, badLines }：badLines 是解析失败的原始行，写回时必须原样保留。
// 旧实现把坏行过滤掉再整文件重写，等于把没解析出来的消息删了。
export function readJsonl(file) {
  if (!existsSync(file)) return { records: [], badLines: [] };
  let raw = readFileSync(file, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const records = [];
  const badLines = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line.replace(/^\uFEFF/, '')));
    } catch {
      badLines.push(line);
    }
  }
  return { records, badLines };
}

// 原子写：先写 .tmp 再 rename。进程中途被杀不会留下半截队列文件。
export function writeJsonlAtomic(file, records, badLines = []) {
  ensureDir(dirname(file));
  const body = [
    ...records.map((r) => JSON.stringify(r)),
    ...badLines,
  ].join('\n');
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body ? body + '\n' : '', 'utf8');
  renameSync(tmp, file);
}

export function appendJsonl(file, record) {
  ensureDir(dirname(file));
  appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
}

// ---------- 简单文件锁 ----------
// 同一队列的 flush / receive 可能被两个进程同时触发，靠锁把「读-改-写」串起来。
// 锁超过 STALE_MS 视为持有者已死，直接抢占，避免崩溃后永久卡死。
const STALE_LOCK_MS = 300_000;

// 锁里写 nonce，释放前校验。旧实现只按文件是否存在释放，
// 一旦自己的锁被别人当过期抢占，finally 里会把别人的新锁删掉，锁链就断了。
export function withLock(file, fn) {
  const lock = `${file}.lock`;
  ensureDir(dirname(file));
  const nonce = `${process.pid}-${randomBytes(4).toString('hex')}`;
  const deadline = Date.now() + 20_000;
  while (true) {
    try {
      const fd = openSync(lock, 'wx');
      writeFileSync(fd, nonce);
      closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const age = Date.now() - statSync(lock).mtimeMs;
        if (age > STALE_LOCK_MS) {
          unlinkSync(lock);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error(`队列被占用：${lock}（等锁超时）`);
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (readFileSync(lock, 'utf8') === nonce) unlinkSync(lock);
    } catch {}
  }
}

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 杂项 ----------
export function makeToken() {
  return `BRG-${Date.now()}-${randomBytes(3).toString('hex')}`;
}

export function makeMessageId() {
  return `MSG-${Date.now()}-${randomBytes(3).toString('hex')}`;
}

// 端点发现要扫端口，一次进程里只做一次，别每条消息都重扫。
const portCache = new Map();
export function cached(key, fn) {
  if (!portCache.has(key)) portCache.set(key, fn());
  return portCache.get(key);
}

export function listJsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
}
