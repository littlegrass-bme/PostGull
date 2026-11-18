---
name: postgull-claude
description: 在 Claude Code 里通过 postgull 与其他软件互发消息。注意这是实验性通道，未经完整验证。
---

# postgull（Claude 侧，实验性）

**先读这段**：Claude 通道是实验性的。Claude Code 没有官方的「向指定会话队列写消息」子命令，本工具用 `claude -p --resume <session-id>` 把正文当新输入续接会话。这意味着：

- 不同版本对 `--resume` 的支持不一致，可能直接报错。
- 没有可查的「对方已接受」凭证，工具只能确认进程返回 0。
- 所以本通道一律标「未确认接受」，不会假装成功，也不会自动重投。

如果你要用，建议先在测试会话上跑一次，确认你的 CLI 版本认 `--resume`。

## 先看现状

```powershell
postgull list
postgull doctor
```

`doctor` 里 claude 那行如果是「停用」，先在配置里把 `software[].enabled` 改成 `true`。

## 发消息

```powershell
$body = @'
正文
'@
$summary = '说清要对方做什么，300 字内'
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($body))
$b64 | postgull send --to dsh-work --from "Claude" --summary $summary --expect report
```

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

- 不要把「进程返回 0」当成「对方已收到」。要确认，让对方回一条带凭证的消息。
- `--expect report` 只用于真的需要对方给结果的场合。
- `humanSleeping` 只读，不要改。
- 你的 CLI 版本信息请写进配置的 `options.command` 注释里，方便排查。

## 故障

| 现象 | 处理 |
|---|---|
| `--resume` 不被识别 | 你的 CLI 版本不支持。升级，或改用 webhook 适配器自己接 |
| 未确认接受 | 正常，本通道没有凭证机制。让对方主动回一条 |
| 进程超时 | 工具默认 180 秒。长任务请对方异步回，不要挂在一次调用上 |
