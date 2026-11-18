---
name: postgull-dsh
description: 在 DeepSeek Harness 里通过 postgull 给 Codex、Gemini(Antigravity)、Claude 或其他已接入软件发消息、查看信箱、收取积压。当用户要求跨软件转发、通知、派活、或检查跨软件消息是否送达时使用。
---

# postgull（DSH 侧）

跨软件消息桥。你负责收发和调度，不负责替对方干活。

## 先看现状

```powershell
postgull list            # 软件、类别、会话、额度
postgull queue           # 信箱积压与人类休眠状态
postgull doctor          # 通道连通性自检
```

配置默认在 `postgull.config.json`（当前目录、exe 同目录、或 `%APPDATA%\PostGull\`）。找不到就用 `--config <路径>`。

## 发消息

正文走 base64 经 stdin，避开 PowerShell 的引号与换行问题：

```powershell
$body = @'
要发送的正文
'@
$summary = '给人类看的摘要，说清要对方做什么，300 字内'
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($body))
$b64 | postgull send --to dsh-work --from "DSH桥接" --summary $summary --expect report
```

- `--to` 用别名（`postgull list` 里那列），或 `软件/类别`，同类别多个会话时用 `软件/类别#2`。
- `--expect report`：对方要先回“收到”，完成后回报结果。派活、要求复核、需要结论时用这个。
- `--expect ack`：只要“收到”，处理完不用再回。纯通知、已完成的告知、规则变更用这个。
- 长正文用 `--body-file`，短正文用 `--text`。

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

- 发之前查 `postgull list`，确认目标别名、额度、以及 Antigravity 目标是否已打开。不发没查过的目标。
- 不要为了通报而发：换会话 id、改了注册表、或者“我已更新某文件”这类单向告知，都不要发。
- Codex 的 work 会话成本高，只有明确任务或需要它定方向时才发；连通性测试用 bridge 类会话。
- `humanSleeping` 是只读字段。任何情况下不要改，发现不符只提醒人类。
- 正文不要写长期占位内容，不要留凭证占位符。

## 常见故障

| 现象 | 处理 |
|---|---|
| 目标暂不可达，已转入信箱 | 正常。目标激活后 `flush <别名>` |
| Antigravity 目标未打开 | 在界面切到该对话再 flush；DSH 侧不能后台注入 |
| 未确认接受 | 消息可能已到但没凭证。不要立刻重发，先 `queue` 看状态，必要时 `flush --force` |
| 找不到 postgull | 用 exe 绝对路径，或把它加到 PATH |
