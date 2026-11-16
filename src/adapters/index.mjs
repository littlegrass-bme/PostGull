import { dsh } from './dsh.mjs';
import { codex } from './codex.mjs';
import { antigravity } from './antigravity.mjs';
import { claude } from './claude.mjs';
import { webhook } from './webhook.mjs';

export const ADAPTER_IMPL = { dsh, codex, antigravity, claude, webhook };

export function adapterFor(sw) {
  const impl = ADAPTER_IMPL[sw.adapter];
  if (!impl) throw new Error(`未知适配器：${sw.adapter}`);
  return impl;
}
