// Claude Code 适配器（实验性，未做双端验证）。
//
// 为什么叫实验性：
//   1. Claude Code 没有「向指定会话队列写一条消息」的官方子命令，
//      这里用 `claude -p --resume <session-id>` 把正文当一次新输入续接会话；
//   2. 不同版本对 --resume 的支持与行为不一致，旧版本可能直接报错；
//   3. 它没有可查的「对方已接受」凭证，只能确认进程返回 0。
//
// 因此本通道一律返回 accepted=false / verified=false，上层会明确标「未确认接受」，
// 不会假装成功，也不会自动重投。有人在真实环境跑通后再改这个标记。

import { spawn } from 'node:child_process';
import { BridgeError } from '../config.mjs';
import { resolveCommand, spawnPlan } from '../resolve-command.mjs';

function runWithStdin(sw, args, input, timeout = 180000) {
  return new Promise((resolve) => {
    const name = sw.options.command || 'claude';
    const resolved = resolveCommand(name);
    if (!resolved) {
      resolve({
        ok: false,
        out: `找不到 claude 命令（${name}）`,
        hint: '安装 Claude Code 并确认 claude 在 PATH 里，或在 options.command 写绝对路径。此通道未经完整验证。',
      });
      return;
    }
    const p = spawnPlan(resolved, args, 'Claude 通道');
    let child;
    try {
      child = spawn(p.command, p.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, out: e.message });
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve({ ok: false, out: `超过 ${Math.round(timeout / 1000)} 秒未返回`, timeout: true });
    }, timeout);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, out: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, out: (code === 0 ? out : err || out).trim() });
    });
    // 正文走 stdin，避开 Windows 引号、换行与长度限制。
    try {
      child.stdin.end(input, 'utf8');
    } catch (e) {
      clearTimeout(timer);
      resolve({ ok: false, out: e.message });
    }
  });
}

export const claude = {
  id: 'claude',
  label: 'Claude Code（实验性）',

  async health(cfg, sw) {
    const r = await runWithStdin(sw, ['--version'], '', 30000);
    if (!r.ok) throw new BridgeError(`claude 不可用：${String(r.out).slice(0, 200)}`, r.hint || '确认 claude 在 PATH 里。');
    return { ok: true, detail: `${r.out.split('\n')[0]}（实验性通道，未验证接受凭证）` };
  },

  async send(cfg, sw, session, message) {
    const args = (sw.options.sendArgs || ['-p', '--resume', '{id}'])
      .map((a) => String(a).replace('{id}', session.id));
    const r = await runWithStdin(sw, args, message);
    if (!r.ok) {
      throw new BridgeError(
        `claude 调用失败：${String(r.out).slice(0, 300)}`,
        r.hint || '检查该版本是否支持 --resume；此通道未经完整验证，失败属已知风险。',
      );
    }
    return {
      channel: 'claude -p --resume（实验性）',
      accepted: false,
      verified: false,
      reason: 'Claude 通道没有可查的接受凭证，只能确认进程返回 0',
      reply: r.out.slice(0, 2000),
    };
  },
};
