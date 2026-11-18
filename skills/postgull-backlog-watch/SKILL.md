---
name: postgull-backlog-watch
description: 定期检查 postgull 信箱积压与超时消息，发现卡住的消息就告警或补投。适合做成定时任务，替代人工盯信箱。
---

# 积压巡检

目的：消息进了信箱却没人看，是跨软件协作最常见的事故。这个巡检负责发现并推动。

## 一次性检查

```powershell
postgull stale --hours 2      # 超过 2 小时未投递的
postgull queue                # 全部积压与状态
postgull doctor               # 顺带看通道是否还通
```

退出码：`0` 表示没有超时；`1` 表示有积压或通道异常。定时任务靠这个判断要不要告警。

## 常驻巡检

```powershell
postgull watch --hours 2 --interval 15m
postgull watch --hours 2 --interval 30m --alert-to dsh-bridge
```

- `--interval`：巡检间隔，写 `15m`、`30m`、`1h`。
- `--alert-to`：发现超时就把告警发到指定会话，走正常消息通道，带凭证。
- `--once`：只跑一轮，适合交给任务计划程序。

## 做成 Windows 定时任务（不用 bat）

```powershell
$exe = "C:\path\to\postgull.exe"
schtasks /Create /TN "PostGull-Watch" /SC MINUTE /MO 30 /F /TR "`"$exe`" watch --once --hours 2 --alert-to dsh-bridge"
schtasks /Run /TN "PostGull-Watch"
schtasks /Delete /TN "PostGull-Watch" /F      # 不再需要时删掉
```

任务计划的输出不进控制台。要看历史，把 `watch --once` 的输出重定向到文件：

```powershell
schtasks /Create /TN "PostGull-Watch" /SC MINUTE /MO 30 /F /TR "cmd /c `"$exe`" watch --once --hours 2 >> `"%LOCALAPPDATA%\PostGull\watch.log`" 2>&1"
```

注意：`--once` 每次退出码非 0 时任务计划会记为失败，这正好可以在「上次运行结果」里看到。

## 判断标准

- 超过 2 小时还能补投的：直接 `flush <别名>`。
- 目标是 Antigravity 且没打开：这是硬限制，只能等人切窗口。告警里要写清要打开哪个对话。
- 目标是 Codex 且额度耗尽：等刷新时间，不要反复 flush。
- 状态是 `unconfirmed`：不要盲目重投，先看归档里是否已有该凭证，确认没到再用 `flush --force`。

## 汇报格式
巡检报告只写三件事：有几个信箱、哪条超时、下一步谁做什么。没异常就一句话，不要写总结。

巡检本身是纯搬运，按 `skills/_shared/two-replies.md` 的低耗原则执行，不展开推理。发现异常要发消息通知对方时，同样遵守两次回复规范：先回「收到」，处理完再按情况 A 到 D 决定要不要发第二条。
