#!/usr/bin/env node
// 通用跨软件消息桥接器：命令行入口。
// 目标：任何支持“给出会话 id 就能投一条消息”的软件，都能通过配置接进来，
// 软件数量、类别名、每类会话数量全部由用户定义。

import { readFileSync } from 'node:fs';
import { VERSION } from './util.mjs';
import {
  loadConfig, resolveTarget, softwareOf, queueFileFor, BridgeError, sleepState, quotaState,
  assertTestAllowed,
} from './config.mjs';
import {
  buildMessage, sendNow, enqueue, queueSnapshot, flush, receive, staleMessages,
  archiveTail, archiveFile, watchTick, SUMMARY_LIMIT,
} from './core.mjs';
import { runAdmin } from './admin.mjs';

const HELP = `postgull ${VERSION}

用法：
  postgull <命令> [参数]

命令：
  init                     交互式生成 postgull.config.json
  list                     列出软件、类别与会话
  doctor                   自检：配置、通道连通性、信箱、锁
  send                     发一条消息
  queue                    查看信箱积压
  receive                  收取并归档消息（接收方用）
  flush <目标>             把信箱里的 pending 补投出去
  stale [--hours 2]        列出超时未投递
  watch                    定期巡检积压，可指定告警目标
  archive [--tail 10]      查看归档尾部
  session add|rm|on|off    增删会话、启停会话
  quota set|clear          设置某软件额度状态
  blocked add|rm           禁止投递名单
  version                  版本

send 参数：
  --to <目标>              别名，或 软件/类别，或 软件/类别#序号
  --from <标识>            来源标识，写进消息头
  --summary <摘要>         必填，300 字以内，给人类看，说清要对方做什么
  --expect report|ack      report=完成后回报（默认）；ack=只要收到
  --text <正文>            短正文；含引号或较长时用 --body-file
  --body-file <路径>       从文件读正文（UTF-8）
  --encoding base64|raw    不给 --text/--body-file 时从 stdin 读，默认 base64
  --dry-run                只打印，不投递
  --no-wait                投递后不提示等待回复

示例：
  postgull send --to dsh-bridge --summary "请复核这份结论" --body-file .\\reply.md
  $b64 | postgull send --to gemini-work --summary "跑完了，附实测数字" --encoding base64
`;

function parseArgs(argv) {
  const flags = new Map();
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 2) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function flag(flags, name, fallback = null) {
  const v = flags.get(name);
  return v === undefined ? fallback : v;
}

function requireValue(flags, name, hint) {
  const v = flags.get(name);
  if (v === undefined || v === true || String(v).trim() === '') {
    throw new BridgeError(`参数 --${name} 缺少值`, hint);
  }
  return String(v);
}

// base64 必须能原样还原。旧实现只 try/catch Buffer.from，而它对坏输入不抛异常，
// 会静默解出乱码照发。这里解码后重新编码比对，不一致直接拒绝。
function readBody(flags) {
  const enc = String(flag(flags, 'encoding', 'base64')).toLowerCase();
  if (flags.has('text')) return String(flag(flags, 'text'));
  if (flags.has('body-file')) {
    const p = String(flag(flags, 'body-file'));
    return readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  }
  let raw = readFileSync(0, 'utf8');
  if (enc === 'raw') return raw;
  const compact = raw.replace(/\s+/g, '');
  if (!compact) throw new BridgeError('stdin 没有内容', '用 --text、--body-file，或把 base64 通过管道传进来。');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw new BridgeError('stdin 不是合法 base64', '确认发送侧用 [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($body)) 生成，或改用 --encoding raw。');
  }
  const buf = Buffer.from(compact, 'base64');
  if (buf.toString('base64').replace(/=+$/, '') !== compact.replace(/=+$/, '')) {
    throw new BridgeError('base64 校验不通过：解码再编码与原文不一致', '可能被换行、引号或编码转换破坏，重新生成。');
  }
  return buf.toString('utf8');
}

function checkSummary(flags) {
  const raw = flags.get('summary');
  if (raw === undefined || raw === true || !String(raw).trim()) {
    throw new BridgeError('缺少 --summary', '每条消息都要有 300 字内的摘要，说清要对方做什么。');
  }
  const s = String(raw).trim();
  // 按码点数，不按 UTF-16 单元，否则含 emoji 时上限会比标称更窄。
  const len = [...s].length;
  if (len > SUMMARY_LIMIT) {
    throw new BridgeError(`摘要超长：${len} 字，上限 ${SUMMARY_LIMIT}`, '压到 300 字以内再发。');
  }
  return s;
}

function printMessage(msg) {
  const LIMIT = 6000;
  console.log('================ 即将发送 ================');
  if (msg.length <= LIMIT) {
    console.log(msg);
  } else {
    // 超长正文只打头尾：完整性由 base64 往返校验保证，这里的作用是让人肉眼看开头和结尾。
    console.log(msg.slice(0, 4000));
    console.log(`\n……（中间省略 ${msg.length - 4600} 字符）……\n`);
    console.log(msg.slice(-600));
    console.log(`（全文 ${msg.length} 字符，与控制台显示的差异只是省略，发出的是完整正文）`);
  }
  console.log('==========================================');
  console.log('');
}

async function cmdSend(cfg, flags, positional) {
  const target = resolveTarget(cfg, requireValue(flags, 'to', '用 --to <别名> 或 --to <软件>/<类别>'), flag(flags, 'category'));
  const summary = checkSummary(flags);
  const text = readBody(flags).trim();
  if (!text) throw new BridgeError('正文为空');
  const maxKB = Number(cfg.maxBodyKB || 64);
  if (Buffer.byteLength(text, 'utf8') > maxKB * 1024) {
    throw new BridgeError(`正文超过 ${maxKB} KB 上限`, '拆成多条发，长文档先落文件再让对方读。');
  }
  const expect = String(flag(flags, 'expect', 'report'));
  if (!['report', 'ack'].includes(expect)) throw new BridgeError(`--expect 只能是 report 或 ack，收到 ${expect}`);

  // --test 表示「这条是通道自测，不是业务消息」。
  // 默认会拦掉 work 类目标：拿正在干活的会话当靶子是真实事故。
  const isTest = flags.has('test');
  assertTestAllowed(cfg, target, isTest);
  if (isTest) {
    console.log('测试模式：本条会在正文里打【测试】标记，且只允许发往非 work 类会话。');
  }

  const from = String(flag(flags, 'from', cfg.bridgeName || 'postgull'));
  const token = `BRG-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const hs = sleepState(cfg);
  const msg = buildMessage({ from, token, summary, text, expect, sleepOn: hs.on });

  const sw = softwareOf(cfg, target);
  const q = quotaState(cfg, sw.id);
  console.log(`目标: ${target.alias}（${target.software}/${target.category}，适配器 ${sw.adapter}）`);
  console.log(`凭证: ${token}`);
  console.log(`摘要 ${[...summary].length}/${SUMMARY_LIMIT} 字，正文 ${text.length} 字符`);
  if (hs.on) console.log(`人类休眠模式开启（自 ${hs.since || '未知'}）：对方会自行决策，不会等人`);
  if (!q.available) console.log(`注意：${q.reason}`);
  printMessage(msg);

  if (flags.has('dry-run')) {
    console.log('--dry-run：未投递');
    return 0;
  }

  const r = await sendNow(cfg, target, msg, { token, summary, from, text, expect });
  // 目标是 bridge 类会话时，主动提醒这是测试的正确落点，避免下次又拿 work 当靶子。
  if (target.category === 'bridge' && !isTest) {
    console.log('提示：bridge 会话适合承接测试；如果是自测，加 --test 更明确。');
  }
  console.log('---------------- 投递结果 ----------------');
  if (r.kind === 'done') {
    console.log(`通道: ${r.channel}`);
    console.log(`已确认接受，凭证 ${token}`);
    console.log('对方会先回一句收到；按 expect=' + expect + (expect === 'report' ? ' 处理完会回报。' : ' 只回收到，不会再有后续。'));
  } else if (r.kind === 'unconfirmed') {
    console.log(`通道: ${r.channel || '提交完成'}`);
    console.log(`未拿到接受凭证：${r.reason || '对端没有可查的收件记录'}`);
    if (r.reply) console.log(`对端返回片段：\n${r.reply}`);
    console.log('按「未确认」处理，没有自动重投，避免重复送达。需要重投用 flush --force。');
  } else if (r.kind === 'queued') {
    console.log('目标暂不可达，已转入信箱');
    console.log(`信箱: ${queueFileFor(cfg, target)}`);
    console.log(`编号: ${r.record.id}`);
    console.log(`原因: ${r.reason}`);
    console.log(`激活后执行：postgull flush ${target.alias}`);
  }
  return 0;
}

function cmdQueue(cfg) {
  const hs = sleepState(cfg);
  console.log(hs.on ? `人类休眠模式: 开启（自 ${hs.since || '未知'}）` : '人类休眠模式: 关闭');
  if (hs.on && hs.note) console.log(`  ${hs.note}`);
  const snaps = queueSnapshot(cfg);
  const active = snaps.filter((s) => s.total);
  if (!active.length) {
    console.log('\n信箱为空');
  } else {
    for (const s of active) {
      console.log(`\n${s.session.alias}（${s.session.software}/${s.session.category}）  共 ${s.total} 条`);
      console.log(`  pending ${s.pending}  sending ${s.sending}  unconfirmed ${s.unconfirmed}  dead ${s.dead || 0}  done ${s.done}` + (s.badLines ? `  解析失败 ${s.badLines} 行（已保留）` : ''));
      for (const r of s.records.filter((x) => ['pending', 'sending', 'unconfirmed', 'dead'].includes(x.status))) {
        console.log(`  [${r.status}] ${r.id}  ${r.createdAt}  来自 ${r.from}`);
        console.log(`    摘要: ${r.summary || '(无)'}${r.sleepReason ? `\n    原因: ${r.sleepReason}` : ''}${r.lastError ? `\n    上次错误: ${r.lastError}` : ''}`);
      }
    }
  }
  const arc = archiveTail(cfg, 0);
  console.log(`\n归档 ${arc.total} 条（不是待办）`);
  return 0;
}

function cmdReceive(cfg, flags) {
  const target = resolveTarget(cfg, requireValue(flags, 'to', '用 --to <别名> 取件'), flag(flags, 'category'));
  const onlyId = flags.has('id') ? String(flag(flags, 'id')) : null;
  const res = receive(cfg, target, onlyId);
  if (res.foreign?.length) {
    console.log(`注意：${target.alias} 队列里有 ${res.foreign.length} 条不属于本会话的消息，已跳过不取：`);
    for (const r of res.foreign) {
      console.log(`  ${r.id}  to=${r.to}  凭证 ${r.token}  来自 ${r.from}`);
    }
    console.log('  这些消息留给它真正的收件方，或由发送方改投正确位置。\n');
  }
  if (res.empty) {
    console.log(`信箱为空：${target.alias}`);
    return 0;
  }
  console.log(`===== 收到 ${res.picked.length} 条：${target.alias} =====`);
  for (const r of res.picked) {
    console.log('');
    console.log('--------------------------------------------');
    console.log(`凭证: ${r.token}`);
    console.log(`编号: ${r.id}`);
    console.log(`来自: ${r.from}`);
    console.log(`时间: ${r.createdAt}`);
    console.log(`摘要: ${r.summary || '(无)'}`);
    console.log('--------------------------------------------');
    console.log(r.finalText || r.text || '(无正文)');
  }
  console.log('');
  console.log('===== 已从信箱移除并归档，回执如下 =====');
  for (const r of res.picked) {
    console.log(`收到 ${r.token}（${r.id}，来自 ${r.from}，${r.createdAt}）`);
    console.log(`  摘要：${r.summary || '(无)'}`);
  }
  console.log('\n按要求：先回一句"收到"再处理。处理后按对方 expect 决定是否回报。');
  return 0;
}

async function cmdFlush(cfg, flags, positional) {
  const spec = positional[0] || flag(flags, 'to');
  if (!spec) throw new BridgeError('缺少目标', '用 --flush <别名|软件/类别>，或 --flush --to <别名>。');
  const target = resolveTarget(cfg, String(spec), flag(flags, 'category'));
  const r = await flush(cfg, target, { force: parseForce(flags.get('force')) });
  if (r.empty) { console.log(`信箱为空：${target.alias}`); return 0; }
  console.log(`投递成功 ${r.sent}，未确认 ${r.unconfirmed}，失败 ${r.failed}，仍待投递 ${r.pending}` + (r.sending ? `，投递中 ${r.sending}` : ''));
  if (r.failed || r.pending || r.unconfirmed || r.sending) return 1;
  return 0;
}

// --force 必须显式给 id 或 all。旧版一律重投所有 unconfirmed，
// 而那些记录可能已经送达，只是没有凭证。
function parseForce(v) {
  if (v === undefined) return false;
  if (v === true) {
    throw new BridgeError(
      '--force 需要指定范围',
      '写 `--force MSG-xxx` 只重投那一条，或 `--force all` 重投全部 unconfirmed。',
    );
  }
  return String(v);
}

function cmdStale(cfg, flags) {
  const hours = Number(flag(flags, 'hours', 2));
  const stale = staleMessages(cfg, hours);
  if (!stale.length) {
    console.log(`没有超时未投递的消息（阈值 ${hours} 小时）`);
    return 0;
  }
  console.log(`【需要处理】${stale.length} 条消息等待超过 ${hours} 小时：`);
  for (const s of stale) {
    console.log(`  ${s.alias}  ${s.id}  等待 ${s.waitingHours} 小时  来自 ${s.from}`);
    console.log(`    摘要: ${s.summary || '(无)'}`);
    console.log(`    补投: postgull flush ${s.alias}`);
  }
  return 1;
}

async function cmdWatch(cfg, flags) {
  const hours = Number(flag(flags, 'hours', 2));
  const interval = String(flag(flags, 'interval', '15m'));
  const once = flags.has('once');
  const ms = parseInterval(interval) * 60_000;
  const alertTo = flags.has('alert-to') ? String(flag(flags, 'alert-to')) : null;

  const tick = async () => {
    const { stale, snaps } = watchTick(cfg, hours);
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
    if (!stale.length) {
      console.log(`[${stamp}] 正常：${snaps.length} 个信箱有待处理，无超时消息`);
      return;
    }
    console.log(`[${stamp}] 告警：${stale.length} 条超时`);
    for (const s of stale) console.log(`  ${s.alias}  ${s.id}  等待 ${s.waitingHours} 小时`);
    if (alertTo) {
      const target = resolveTarget(cfg, alertTo);
      const lines = stale.map((s) => `- ${s.alias} ${s.id} 等待 ${s.waitingHours} 小时：${s.summary || '(无摘要)'}`).join('\n');
      const token = `BRG-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const msg = buildMessage({
        from: 'postgull-watch',
        token,
        summary: `信箱告警：${stale.length} 条消息超过 ${hours} 小时未投递，请检查目标是否休眠并执行 flush。`,
        text: lines,
        expect: 'report',
        sleepOn: sleepState(cfg).on,
      });
      try {
        await sendNow(cfg, target, msg, { token, summary: '信箱告警', from: 'postgull-watch', text: lines, expect: 'report' });
        console.log(`  已向 ${target.alias} 发出告警`);
      } catch (e) {
        console.log(`  告警发送失败：${e.message}`);
      }
    }
  };

  await tick();
  if (once) return 0;
  console.log(`进入巡检，每 ${interval} 检查一次。Ctrl+C 退出。`);
  // 用递归 setTimeout 而不是 setInterval，避免上一轮还没投完就叠下一轮。
  return new Promise(() => {
    const loop = async () => {
      try { await tick(); } catch (e) { console.error(`巡检出错：${e.message}`); }
      setTimeout(loop, ms);
    };
    setTimeout(loop, ms);
  });
}

function parseInterval(s) {
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|分钟|h|小时)?$/i.exec(String(s).trim());
  if (!m) throw new BridgeError(`--interval 格式不对：${s}`, '写成 15m、30m、1h 这样的形式。');
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) throw new BridgeError(`--interval 必须为正数：${s}`);
  const unit = (m[2] || 'm').toLowerCase();
  return /^h|小时/.test(unit) ? n * 60 : n;
}

export async function main(argv) {
  // --config 允许写在命令前后任意位置：先全局扫一遍去掉，否则
  // `postgull --config x list` 会把 --config 当成命令名。
  let configArg = null;
  const stripped = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) {
        throw new BridgeError('--config 缺少路径');
      }
      configArg = argv[++i];
      continue;
    }
    if (a.startsWith('--config=')) {
      configArg = a.slice('--config='.length);
      continue;
    }
    stripped.push(a);
  }

  const [cmd, ...rest] = stripped;
  const { flags, positional } = parseArgs(rest);
  if (configArg) flags.set('config', configArg);
  // positional 只含命令之后的参数，命令本身单独放在 cmd 里。
  // 之前把 cmd 也算进 positional，导致 flush 取错下标。

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return 0;
  }
  if (cmd === 'version' || cmd === '--version') {
    console.log(`postgull ${VERSION}`);
    return 0;
  }

  // admin 的 init 不需要已有配置
  if (cmd === 'init') return runAdmin(cmd, { flags, positional, cfg: null });

  const cfg = loadConfig(flag(flags, 'config'));

  if (['list', 'doctor', 'session', 'quota', 'blocked'].includes(cmd)) {
    return runAdmin(cmd, { flags, positional, cfg });
  }
  if (cmd === 'send') return cmdSend(cfg, flags, positional);
  if (cmd === 'queue') return cmdQueue(cfg);
  if (cmd === 'receive') return cmdReceive(cfg, flags);
  if (cmd === 'flush') return cmdFlush(cfg, flags, positional);
  if (cmd === 'stale') return cmdStale(cfg, flags);
  if (cmd === 'watch') return cmdWatch(cfg, flags);
  if (cmd === 'archive') {
    const n = Number(flag(flags, 'tail', 10));
    const a = archiveTail(cfg, n);
    console.log(`归档 ${a.total} 条：${archiveFile(cfg)}`);
    for (const r of a.tail) {
      console.log(`  ${r.createdAt}  ${r.to}  ${r.token}  ${r.status}`);
    }
    return 0;
  }
  throw new BridgeError(`未知命令：${cmd}`, '运行 postgull help 看可用命令。');
}

// 入口即执行。SEA 打包后没有可用的 require.main 判断，统一走这里。
// 退出用 process.exitCode 而不是 process.exit，保证 stdout 在管道里也能写完，
// 否则正文可能被截断而调用方以为拿全了。
main(process.argv.slice(2))
  .then((code) => { process.exitCode = code || 0; })
  .catch((e) => {
    if (e instanceof BridgeError) {
      console.error(`错误：${e.message}`);
      if (e.hint) console.error(`提示：${e.hint}`);
    } else {
      console.error(`未预期错误：${e.message}`);
      if (process.env.POSTGULL_DEBUG) console.error(e.stack);
    }
    process.exitCode = 1;
  });
