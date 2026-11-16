// Codex 适配器：调 codex CLI 的 queue 子命令做单向写入。
//
// 已知限制：codex queue 只能写、不能读，回执只说「已入队」。
// 所以这里 accepted=true 仅代表「CLI 接受入队」，不代表对方读过或回复过，
// 上层会把这层含义原样打印给用户，不冒充送达。

import { execFile } from 'node:child_process';
import { BridgeError } from '../config.mjs';
import { resolveCommand, spawnPlan, findNpmBinJs, requireNodeExe } from '../resolve-command.mjs';

function plan(sw) {
  const name = sw.options.command || 'codex';
  // 优先用 npm 全局包里的 js 入口：参数不经 cmd.exe，引号与换行不会被改写。
  // 注意必须配 requireNodeExe()：打包成 exe 后 process.execPath 是桥接器自身，
  // 用它启动 codex.js 会把桥接器自己再启一遍（实测 doctor 报「找不到配置文件」）。
  if (!/[\\/]/.test(name)) {
    const js = findNpmBinJs('@openai/codex');
    if (js) return { command: requireNodeExe('Codex 通道'), args: [js] };
  }
  const resolved = resolveCommand(name);
  if (!resolved) {
    throw new BridgeError(
      `找不到 codex 命令（${name}）`,
      '确认已安装 Codex CLI 并在 PATH 里；或在配置的 software[].options.command 里写绝对路径。',
    );
  }
  const p = spawnPlan(resolved, [], 'Codex 通道');
  return { command: p.command, args: p.args };
}

function run(sw, args, timeout = 120000) {
  return new Promise((resolve) => {
    let command;
    let full;
    try {
      const p = plan(sw);
      command = p.command;
      full = [...p.args, ...args];
    } catch (e) {
      resolve({ ok: false, out: e.message, hint: e.hint });
      return;
    }
    execFile(command, full, { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(err ? stderr || err.message : stdout).trim() });
    });
  });
}

export const codex = {
  id: 'codex',
  label: 'Codex CLI',

  async health(cfg, sw) {
    const r = await run(sw, ['--version'], 30000);
    if (!r.ok) throw new BridgeError(`codex 不可用：${String(r.out).slice(0, 200)}`, r.hint || '检查 codex 是否在 PATH 里。');
    return { ok: true, detail: r.out.split('\n')[0] };
  },

  async send(cfg, sw, session, message, opts = {}) {
    // codex queue 只能把正文当命令行参数传。Windows 整个命令行上限 32767 字符，
    // 超了会被 system 截断或直接失败，且不会有明确报错。留 6k 余量给参数与路径。
    if (message.length > 26000) {
      throw new BridgeError(
        `正文 ${message.length} 字符，超过 codex 通道安全上限（约 26000）`,
        'Codex 的 queue 子命令只能把正文当命令行参数，超长会被系统截断。改用 --body-file 让对方读文件，或改走 dsh / webhook 通道。',
      );
    }
    const args = (sw.options.queueArgs || ['queue', '--thread', '{id}', '--message', '{body}'])
      .map((a) => String(a).replace('{id}', session.id).replace('{body}', message));
    // 收发回执这类纯搬运的消息用低耗模型，别烧高额度模型。
    // 只在显式声明 receiveModel 且本次是回执/收件场景时才加，正常派活仍用对方默认模型。
    const model = sw.options.receiveModel;
    if (model && opts.lowCost) {
      const mIdx = args.indexOf('-m');
      if (mIdx === -1 && !args.includes('--model')) args.push('-m', String(model));
    }
    const r = await run(sw, args);
    if (!r.ok) throw new BridgeError(`codex queue 失败：${String(r.out).slice(0, 300)}`, '确认该线程存在、Codex 额度可用。');
    return {
      channel: 'codex queue（单向写）',
      accepted: true,
      note: '仅代表已入队；Codex 没有读回复的命令，对方回复要去 rollout jsonl 里查',
    };
  },
};
