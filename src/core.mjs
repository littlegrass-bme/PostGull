// 核心：消息组装、投递、信箱操作。
//
// 状态机（每条队列记录）：
//   pending     待投递，flush 会尝试
//   sending     已认领、正在投，进程崩溃后按超时回收为 pending
//   done        已确认送达
//   unconfirmed 已提交但拿不到对方接受凭证，避免盲目重投造成重复
//   consumed    接收方已取走并归档
//
// 一条消息只允许被认领一次，投递前先落盘 sending，是为了让「投递中崩溃」
// 这件事在下次启动时可查，而不是悄悄重发一遍。

import { existsSync, unlinkSync, statSync } from 'node:fs';
import {
  readJsonl, writeJsonlAtomic, appendJsonl, withLock, makeToken, makeMessageId, ensureDir,
} from './util.mjs';
import { queueFileFor, quotaState, softwareOf, BridgeError } from './config.mjs';
import { adapterFor } from './adapters/index.mjs';

export const SUMMARY_LIMIT = 300;
const CLAIM_STALE_MS = 5 * 60_000;
// 连续失败到这个次数就停，避免一条永远投不出去的消息把每次巡检都拖慢。
const MAX_ATTEMPTS = 8;

// ---------- 消息组装 ----------
// 摘要头在最前面：后文被截断时，只看开头也能知道要对方做什么。
// expect 决定尾部再加哪一句：report 要求完成后回报，ack 只要收到。
export function buildMessage({ from, token, summary, text, expect = 'report', sleepOn }) {
  // 来源与摘要里的换行必须压成空格：否则可以在摘要里伪造一行
  // 「【唯一凭证：…】」，让对账用错凭证。正文不压，正文需要保留格式。
  const safeFrom = String(from || '').replace(/[\r\n]+/g, ' ').slice(0, 80);
  const safeSummary = String(summary || '').replace(/[\r\n]+/g, ' ').trim();
  const lines = [
    `【来源：${safeFrom}】`,
    `【唯一凭证：${token}】`,
    `【摘要】${safeSummary}`,
  ];
  if (expect === 'ack') {
    lines.push('【回复要求】先回一句"收到"，再处理正文；本条不需要额外结果，处理完不必再回复。');
  } else {
    lines.push('【回复要求】先回一句"收到"，再处理正文；完成后请把做了什么、实测数字、剩余风险回给发送方。');
  }
  if (sleepOn) {
    lines.push('【对方状态】人类休眠中，收到后自行决策推进，不要挂起等人。');
  }
  lines.push('', '--- 正文 ---', '', text);
  return lines.join('\n');
}

// ---------- 投递 ----------
export async function deliver(cfg, session, message, opts = {}) {
  const sw = softwareOf(cfg, session);
  const q = quotaState(cfg, sw.id);
  if (!q.available) {
    const err = new BridgeError(q.reason, '等额度恢复，或把 registry 里的 quota 改回可用。');
    err.sleeping = true;
    throw err;
  }
  const adapter = adapterFor(sw);
  if (adapter.wakeState) {
    const st = await adapter.wakeState(cfg, sw, session);
    if (st.asleep) {
      const err = new BridgeError(st.reason, '等目标被激活后再 flush。');
      err.sleeping = true;
      throw err;
    }
  }
  return adapter.send(cfg, sw, session, message, opts);
}

// 直接发送（不经过信箱）。失败时按类型决定是入队还是标未确认。
export async function sendNow(cfg, session, message, { token, summary, from, text, expect }) {
  try {
    const r = await deliver(cfg, session, message);
    if (r.accepted) return { kind: 'done', ...r };
    return { kind: 'unconfirmed', ...r };
  } catch (e) {
    if (e.sleeping) {
      const rec = enqueue(cfg, session, { token, summary, from, text, message, reason: e.message });
      return { kind: 'queued', record: rec, reason: e.message };
    }
    throw e;
  }
}

// 入队。正文与 finalText 都存：前者便于改格式后重发，后者是当时实际投出去的东西。
export function enqueue(cfg, session, { token, summary, from, text, message, reason }) {
  const file = queueFileFor(cfg, session);
  return withLock(file, () => {
    const rec = {
      id: makeMessageId(),
      from,
      to: session.alias,
      software: session.software,
      category: session.category,
      token,
      summary,
      text,
      finalText: message,
      createdAt: new Date().toISOString(),
      status: 'pending',
      attempts: 0,
      sleepReason: reason || null,
    };
    appendJsonl(file, rec);
    return rec;
  });
}

// ---------- 信箱 ----------
export function queueSnapshot(cfg) {
  const out = [];
  for (const s of cfg.sessions) {
    const file = queueFileFor(cfg, s);
    if (!existsSync(file)) continue;
    const { records, badLines } = readJsonl(file);
    const count = (st) => records.filter((r) => r.status === st).length;
    out.push({
      session: s,
      file,
      total: records.length,
      pending: count('pending'),
      sending: count('sending'),
      unconfirmed: count('unconfirmed'),
      dead: count('dead'),
      done: count('done'),
      badLines: badLines.length,
      records,
    });
  }
  return out;
}

// 超时未投递。阈值默认 2 小时：低于巡检间隔的一半，一条消息不至于等两轮才报。
export function staleMessages(cfg, hours = 2) {
  if (!Number.isFinite(hours) || hours <= 0) throw new BridgeError(`--hours 必须是正数，收到 ${hours}`);
  const cutoff = Date.now() - hours * 3600_000;
  const out = [];
  for (const snap of queueSnapshot(cfg)) {
    for (const r of snap.records) {
      if (r.status !== 'pending' && r.status !== 'sending') continue;
      // sending 用 claimedAt 算等待时长，用 createdAt 会把刚认领的老记录误报成超时。
      const t = Date.parse(r.status === 'sending' ? (r.claimedAt || r.createdAt) : r.createdAt);
      if (!Number.isFinite(t) || t > cutoff) continue;
      out.push({
        ...r,
        alias: snap.session.alias,
        // 保留两位小数：短阈值下四舍五入到整数会把「等了 3 分钟」显示成 0 小时。
        waitingHours: Math.round(((Date.now() - t) / 3600_000) * 100) / 100,
      });
    }
  }
  return out.sort((a, b) => b.waitingHours - a.waitingHours);
}

// 补投。逐条认领，成功才改 done；拿不到接受凭证标 unconfirmed，不盲目重投。
export async function flush(cfg, session, opts = {}) {
  const file = queueFileFor(cfg, session);
  if (!existsSync(file)) return { sent: 0, failed: 0, unconfirmed: 0, pending: 0, empty: true };

  // 先在锁内把要投的记录认领为 sending，避免两个进程同时投同一条。
  const claimed = withLock(file, () => {
    const { records, badLines } = readJsonl(file);
    const now = Date.now();
    const picked = [];
    const requeue = [];
    for (const r of records) {
      if (r.status === 'pending') {
        r.status = 'sending';
        r.claimedAt = new Date().toISOString();
        r.attempts = (r.attempts || 0) + 1;
        picked.push(r);
      } else if (r.status === 'sending') {
        // 上次投递中途崩溃。超过认领时限不能直接重投：它可能已经送达，
        // 只是没来得及写回状态。改为 unconfirmed，等人判断或用 --force 指定 id 重投。
        const at = Date.parse(r.claimedAt || r.createdAt);
        if (Number.isFinite(at) && now - at > CLAIM_STALE_MS) {
          r.status = 'unconfirmed';
          r.reclaimedAt = new Date().toISOString();
          r.lastError = '上次投递中途退出，状态未知；未自动重投以避免重复送达';
          requeue.push(r);
        }
      } else if (r.status === 'unconfirmed' && opts.force) {
        // force 是 'all' 或具体消息编号，不接受布尔 true。
        if (opts.force === 'all' || opts.force === r.id) {
          r.status = 'sending';
          r.claimedAt = new Date().toISOString();
          r.attempts = (r.attempts || 0) + 1;
          picked.push(r);
        }
      }
    }
    writeJsonlAtomic(file, records, badLines);
    return { picked, requeue };
  });

  if (claimed.requeue?.length) archiveRecords(cfg, claimed.requeue);

  const picked = claimed.picked;
  if (!picked.length) {
    const { records } = readJsonl(file);
    return {
      sent: 0, failed: 0, unconfirmed: 0, sending: 0,
      pending: records.filter((r) => r.status === 'pending').length,
      empty: false,
    };
  }

  const results = { sent: 0, failed: 0, unconfirmed: 0 };
  for (const rec of picked) {
    if (!rec.finalText || !rec.token) {
      // 缺正文的记录不能留在 sending，否则每 5 分钟被回收一次、永久空转。
      rec.status = 'dead';
      rec.lastError = '记录缺少 finalText 或 token，拒绝投递';
      rec.claimedAt = null;
      results.failed++;
      writeBackOne(file, rec);
      continue;
    }
    try {
      const r = await deliver(cfg, session, rec.finalText, opts);
      if (r.accepted) {
        rec.status = 'done';
        rec.sentAt = new Date().toISOString();
        rec.channel = r.channel;
        rec.acceptedVia = r.channel;
        rec.acceptedNote = r.note || null;
        results.sent++;
      } else {
        rec.status = 'unconfirmed';
        rec.lastError = r.reason || '未拿到接受凭证';
        rec.channel = r.channel;
        results.unconfirmed++;
      }
    } catch (e) {
      rec.status = 'pending';
      rec.lastError = e.message;
      rec.sleepReason = e.sleeping ? e.message : null;
      rec.claimedAt = null;
      rec.attempts = rec.attempts || 1;
      if (rec.attempts >= MAX_ATTEMPTS) {
        rec.status = 'dead';
        rec.lastError = `连续 ${rec.attempts} 次投递失败，停止重试：${e.message}`;
      }
      results.failed++;
    }
    // 每投完一条就立刻写回。整批最后才写的话，中途崩溃会让一批已送达的记录
    // 回到 sending 并被再次投递，造成重复。
    writeBackOne(file, rec);
    if (rec.status === 'done' || rec.status === 'unconfirmed' || rec.status === 'dead') {
      archiveRecords(cfg, [rec]);
    }
  }

  const remaining = queueSnapshot(cfg).find((s) => s.session.alias === session.alias);
  return { ...results, pending: remaining?.pending || 0, sending: remaining?.sending || 0 };
}

// 单条回写：在锁内读、只改这一条、原子写。解析失败的原始行原样保留。
function writeBackOne(file, rec) {
  withLock(file, () => {
    const { records, badLines } = readJsonl(file);
    const i = records.findIndex((r) => r.id === rec.id);
    if (i >= 0) records[i] = { ...records[i], ...rec };
    else records.push(rec);
    writeJsonlAtomic(file, records, badLines);
  });
}

// ---------- 收件 ----------
// 三步：完整打印 → 从暂存移除并归档 → 给出点名回执。
// 只取 pending / done / unconfirmed。sending 表示正在投递，
// 取走会让投递方回写时找不到记录，等于把消息吞掉。
//
// 另一个必须挡的：记录的 to 与本队列不一致时一律不取。
// 队列里混进别人的消息，通常是手工投错位置或发送方写错软件/类别，
// 这时替人签收，消息真正的主人就永远收不到了。
export function receive(cfg, session, onlyId) {
  const file = queueFileFor(cfg, session);
  const own = receiveOne(cfg, session, file, onlyId);
  // 同一会话 id 挂了多个别名时，默认只取自己的文件。
  // 打开 aliasesOfSameSession 才会把这些别名的队列一起取，
  // 且仅限 id 完全相同的条目，避免又变成跨会话取件。
  if (cfg.aliasesOfSameSession === true && cfg.sessions) {
    const others = cfg.sessions.filter(
      (s) => s !== session && s.id === session.id && s.enabled !== false,
    );
    for (const sib of others) {
      const r = receiveOne(cfg, sib, queueFileFor(cfg, sib), onlyId);
      own.picked.push(...r.picked);
      own.foreign.push(...r.foreign);
      if (r.picked.length) own.empty = false;
      if (r.badLines) own.badLines = (own.badLines || 0) + r.badLines;
    }
  }
  return own;
}

function receiveOne(cfg, session, file, onlyId) {
  if (!existsSync(file)) return { empty: true, picked: [], foreign: [], badLines: 0 };
  return withLock(file, () => {
    const { records, badLines } = readJsonl(file);
    const want = session.alias;
    const foreign = [];
    const eligible = [];
    for (const r of records) {
      const to = String(r.to || '');
      // to 可能写成别名，也可能写成 软件/类别，两种都认。
      const ok = !to || to === want || to === `${session.software}/${session.category}`;
      if (!ok) { foreign.push(r); continue; }
      if (r.status === 'sending' || r.status === 'consumed') continue;
      if (onlyId && r.id !== onlyId) continue;
      eligible.push(r);
    }
    if (!eligible.length) return { empty: true, picked: [], foreign, badLines: badLines.length };
    const ids = new Set(eligible.map((r) => r.id));
    const keep = records.filter((r) => !ids.has(r.id));
    archiveRecords(cfg, eligible.map((r) => ({ ...r, status: 'consumed', consumedAt: new Date().toISOString() })));
    // 坏行必须留着，不能因为「其余都消费完了」就连文件一起删。
    if (keep.length || badLines.length) writeJsonlAtomic(file, keep, badLines);
    else {
      try { unlinkSync(file); } catch {}
    }
    return { empty: false, picked: eligible, foreign, badLines: badLines.length };
  });
}

// ---------- 归档 ----------
export function archiveFile(cfg) {
  return `${cfg.queueDir}/archive.jsonl`;
}

// 归档按 token|id 合并，不重复追加。
// 状态优先级：consumed > done > unconfirmed > 其他。旧实现只追加不合并，
// 同一条记录先以 pending 落档后，后面 consumed 就再也写不进去了。
const STATUS_RANK = { consumed: 5, done: 4, unconfirmed: 3, dead: 2, pending: 1, sending: 0 };

// 归档文件是跨会话共享的，必须单独加锁。两个不同队列的 flush 同时归档时，
// 各自的锁互不相干，会互相覆盖导致整批归档丢失。
export function archiveRecords(cfg, records) {
  const file = archiveFile(cfg);
  ensureDir(cfg.queueDir);
  withLock(file, () => {
    const { records: existing, badLines } = readJsonl(file);
    const map = new Map();
    // 键不能只用 token|id：两者都缺时会塌成 "|"，多条记录被合并成一条。
    const keyOf = (r) => {
      if (r.token || r.id) return `${r.token || ''}|${r.id || ''}`;
      return `anon|${r.createdAt || ''}|${(r.summary || '').slice(0, 40)}`;
    };
    // 既存记录之间也要走 rank 比较，否则文件里先 consumed 后 pending 时会被降级。
    for (const r of existing) {
      const k = keyOf(r);
      const prev = map.get(k);
      if (!prev || (STATUS_RANK[r.status] ?? 0) >= (STATUS_RANK[prev.status] ?? 0)) map.set(k, r);
    }
    for (const r of records) {
      const k = keyOf(r);
      const prev = map.get(k);
      if (!prev || (STATUS_RANK[r.status] ?? 0) >= (STATUS_RANK[prev.status] ?? 0)) {
        map.set(k, { ...prev, ...r });
      }
    }
    writeJsonlAtomic(file, [...map.values()], badLines);
  });
}

export function archiveTail(cfg, n = 10) {
  const file = archiveFile(cfg);
  const { records, badLines } = readJsonl(file);
  return { total: records.length, badLines: badLines.length, tail: records.slice(-n) };
}

// ---------- 巡检 ----------
export function watchTick(cfg, hours) {
  const stale = staleMessages(cfg, hours);
  const snaps = queueSnapshot(cfg).filter((s) => s.pending || s.sending || s.unconfirmed);
  return { stale, snaps, at: new Date().toISOString() };
}
