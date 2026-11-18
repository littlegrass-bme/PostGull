---
name: postgull-codex
description: 在 Codex 里通过 postgull 向 DeepSeek Harness、Gemini(Antigravity) 或其他已接入软件发消息、查看回信、处理积压。当需要跨软件派活、同步结论、或确认消息是否送达时使用。
---

# postgull（Codex 侧）

跨软件消息桥。Codex 这条通道是单向写：`codex queue` 能把消息写进目标线程，但没有读回复的子命令。

## 先看现状

```powershell
postgull list
postgull queue
postgull doctor
```

## 发消息

```powershell
$body = @'
正文
'@
$summary = '说清要对方做什么，300 字内'
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($body))
$b64 | postgull send --to dsh-work --from "Codex" --summary $summary --expect report
```

- `--expect report`：需要对方给结论或结果。
- `--expect ack`：纯通知，收到即可。
- 同类别多个会话用 `软件/类别#2`。

## 收回复

Codex 没有读回复命令，对方的回信会出现在：

```
%USERPROFILE%\.codex\sessions\YYYY\MM\DD\rollout-*-<线程id>.jsonl
```

按行追加，直接读文件尾部。别指望 `send` 的返回告诉你对方回了什么，它只说明「已入队」。

## 收到消息：两次回复

完整规约见 `skills/_shared/two-replies.md`，四条要点：

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


## 硬规则

- 发给 DeepSeek Harness 的 work 会话前，先确认那是任务目标，不要把运维通报发进去。
- Antigravity 目标必须先在界面打开，否则只能进信箱。
- 不要用 `--expect report` 发纯通知，会让对方白写一段。
- `humanSleeping` 只读，不要改。

## 故障

| 现象 | 处理 |
|---|---|
| 已入队但对方没反应 | Codex 通道无回声，去 rollout jsonl 确认对方是否收到 |
| 目标暂不可达 | 已入信箱，`flush <别名>` 补投 |
| 找不到 codex CLI | `postgull doctor` 会报；装 Codex CLI 或在配置里写 `options.command` 绝对路径 |
