#!/usr/bin/env node
// 把统一的「两次回复」段落写进各 skill，避免四份文件里文案漂移。
// 用法：node skills/_shared/apply-two-replies.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const skillsDir = join(here, '..');

const SECTION = `## 收到消息：两次回复

完整规约见 \`skills/_shared/two-replies.md\`，四条要点：

**第一次回复（必做，立即）** 只回「收到」，然后开始处理。这句话只表示已收到并开始读取，不代表工作已完成。不夹带正文，不等处理完再一起回。

**第二次回复（按消息性质分四类）**

| 情况 | 怎么回 |
|---|---|
| A 纯通知、无异议 | 不回，结束回合 |
| B 有异议或需澄清 | 只回异议点，带实测依据 |
| C 已安排的任务做完 | 回做了什么、实测数字、剩余风险、待裁决项 |
| D 已安排的任务没做成 | 回失败原因、卡点、试过的路径、建议 |

判断标准：这条回复发出去，对方能读到它原本不知道的东西吗？答案是「没有，只是知道我收到了」就不该发。

**低耗执行**：收件、解析、回 ACK 属于格式搬运，不展开深度思考，也不顺手分析消息的学术或工程含义。
`;

const targets = [
  'agent-bridge-dsh/SKILL.md',
  'agent-bridge-codex/SKILL.md',
  'agent-bridge-gemini/SKILL.md',
  'agent-bridge-claude/SKILL.md',
];

let changed = 0;
for (const rel of targets) {
  const file = join(skillsDir, rel);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    console.log(`跳过（不存在）：${rel}`);
    continue;
  }
  // 已插入过就不重复加，允许重复执行。
  if (text.includes('skills/_shared/two-replies.md')) {
    console.log(`已有该段，跳过：${rel}`);
    continue;
  }
  // 替换旧的「## 收到消息」段落，直到下一个二级标题。
  const re = /## 收到消息[^\n]*\n[\s\S]*?(?=\n## )/;
  if (re.test(text)) {
    text = text.replace(re, SECTION + '\n');
    console.log(`替换旧段：${rel}`);
  } else {
    // 没有旧段就插在硬规则之前
    const anchor = '\n## 硬规则';
    if (text.includes(anchor)) {
      text = text.replace(anchor, '\n' + SECTION + anchor);
      console.log(`插入新段：${rel}`);
    } else {
      text += '\n' + SECTION;
      console.log(`追加到末尾：${rel}`);
    }
  }
  writeFileSync(file, text, 'utf8');
  changed++;
}
console.log(`\n完成，修改 ${changed} 个文件`);
