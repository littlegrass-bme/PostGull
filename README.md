# Ferry 摆渡

让同时开着的几个 AI 软件互相说话。

A small tool that lets your AI apps talk to each other.

```
ferry.exe send --to gemini-work --summary "跑完了，附实测数字" --body-file result.md
```

---

## 中文

### 这是什么

你同时在用 DeepSeek Harness、Codex、Antigravity（Gemini）这类软件，每个软件一个窗口，互相看不见。想让 A 里的对话把结论交给 B 里的对话，现在只能复制粘贴。

复制粘贴有三个问题：长文本粘不全，对方忙的时候会漏，事后查不到到底发出去没有。

Ferry 给它们接一条线。命令行发一条消息，落到对方对话里；对方没开窗口，消息存进信箱，等它开了再送；每一跳都有凭证，随时能查。

它不是 API 额度中转，也不代理模型调用。只做一件事：把一段文字从 A 软件的对话送到 B 软件的对话，并且让你知道送到了没有。

### 快速开始

**一、生成配置**

```powershell
ferry.exe init
```

当前目录生成 `ferry.config.json`。

**二、填会话 id**

打开配置，把 `sessions` 里每个 `id` 换成真实的会话标识。每个软件同一类别下只需要登记一个活跃会话，换对话时改这一处就行。

**三、自检**

```powershell
ferry.exe doctor
```

它会告诉你哪个通道能通、哪个连不上、信箱里有没有积压。

**四、发第一条**

```powershell
ferry.exe send --to dsh-bridge --summary "请复核这四条结论" --body-file .\reply.md
```

### 常用命令

| 命令 | 作用 |
|---|---|
| `ferry send --to <目标>` | 发一条消息 |
| `ferry list` | 看有哪些软件、类别、会话 |
| `ferry doctor` | 体检：通道、配置、信箱、锁 |
| `ferry queue` | 看信箱积压 |
| `ferry receive --to <自己>` | 从信箱收取发给自己的消息 |
| `ferry flush <目标>` | 把信箱里待投的补发出去 |
| `ferry watch --hours 2` | 定期巡检，发现卡住的消息就告警 |
| `ferry archive --tail 10` | 查归档，确认某条到底发没发 |

### 消息为什么发不出去

三种常见情况，工具都不会静默失败：

- 对方窗口没打开。消息进信箱，等对方开了再 `flush`。
- 对方在忙。消息排队，等它空下来。
- 对方额度用尽。工具直接拒绝，不会白投。

这三种都会在命令行明确告诉你卡在哪，不会假装成功。

### 怎么确认对方真的收到了

不看命令返回什么，看三个地方：

1. `ferry queue` 里该目标零积压。
2. 对方对话里能搜到本次凭证号。
3. 对方回复里引用了这个凭证。

第三条最硬。只有前两条成立时，也只说明消息进了对方的界面，不代表它读过。

### 装给别人用

把 `dist\ferry.exe` 拷过去，双击或命令行运行。不需要装 Node，不需要 Python。

第一次运行会在当前目录找 `ferry.config.json`，找不到就提示怎么生成。

### 已知限制

**只在 Windows 上验证过。** 路径展开、调试端口、命令行解析都按 Windows 写的。

**exe 没有代码签名。** 首次运行 Windows 可能提示「未知发布者」，选「仍要运行」。自己从源码构建也一样。

**Antigravity 只能给已经打开的对话发消息。** 这是它的调试协议限制，不是本工具的取舍。没开窗口就只能进信箱。

**Antigravity 建议同时只开一个对话。** 开多个时，消息落到哪个窗口由界面决定，工具决定不了。

**Claude 通道没有真实适配过。** Claude Code 没有「往指定会话写消息」的官方命令，这里用 `claude -p --resume` 模拟，拿不到「已接受」凭证。所以这个通道一律标「未确认」，不假装成功。等它在真实环境跑通再当正式功能用。

**Codex 通道只能写不能读。** 回执只说「已入队」，代表消息写进了对方队列，不代表对方读过。

**Codex 和 Claude 通道需要本机有 Node.js。** 这两个 CLI 是 JavaScript 写的，工具要找 `node.exe` 来跑它们。找不到会给明确提示，不会抛一堆英文报错。`dsh`、`antigravity`、`webhook` 三个通道不需要 Node。

### 三种回复

收到消息先回一句「收到」，然后按情况决定还要不要回：

| 情况 | 怎么回 |
|---|---|
| 纯通知，没意见 | 不用再回 |
| 有异议 | 只说异议点和依据 |
| 任务做完了 | 说做了什么、实测数字、还剩什么风险 |
| 任务没做成 | 说卡在哪、试过什么、建议怎么办 |

派活时用 `--expect report`，通报用 `--expect ack`。

---

## English

### What it is

You run several AI apps at once: DeepSeek Harness, Codex, Antigravity (Gemini). Each lives in its own window and cannot see the others. Handing a result from one conversation to another means copy and paste.

Copy and paste fails in three ways. Long text gets truncated. Messages vanish while the other side is busy. Later you cannot tell whether anything was sent at all.

Ferry wires them together. Send a message from the command line and it lands in the target conversation. If that window is closed, the message waits in a mailbox until it opens. Every hop gets a receipt, so you can always check.

This is not an API quota relay and does not proxy model calls. It moves text from one AI conversation to another, and tells you whether it arrived.

### Quick start

**1. Create a config**

```powershell
ferry.exe init
```

**2. Fill in session ids**

Open `ferry.config.json` and replace each placeholder `id` under `sessions` with a real session identifier. One active session per app per category is enough; when you switch conversations, edit that one field.

**3. Check the setup**

```powershell
ferry.exe doctor
```

It reports which channels reach their app, which do not, and whether anything is stuck in a mailbox.

**4. Send something**

```powershell
ferry.exe send --to dsh-bridge --summary "Please review these four conclusions" --body-file .\reply.md
```

### Commands

| Command | What it does |
|---|---|
| `ferry send --to <target>` | Send one message |
| `ferry list` | Show apps, categories, sessions |
| `ferry doctor` | Health check: channels, config, mailboxes, locks |
| `ferry queue` | Show mailbox backlog |
| `ferry receive --to <self>` | Take messages addressed to you |
| `ferry flush <target>` | Deliver everything waiting for that target |
| `ferry watch --hours 2` | Periodic check, alert on stuck messages |
| `ferry archive --tail 10` | Search the archive to confirm a send |

### When a message does not go through

Three cases, none silent:

- Target window is closed. The message goes to the mailbox and waits for `flush`.
- Target is busy. The message queues.
- Target is out of quota. The tool refuses up front instead of sending into a void.

Each case names the blocker. None of them pretend to succeed.

### Confirming delivery

Do not trust the exit code. Check three things:

1. `ferry queue` shows zero backlog for that target.
2. The receipt id is searchable in the target conversation.
3. The reply quotes that receipt.

The third is the only real proof. The first two together still only show the message reached the other app's UI, not that anyone read it.

### Sharing it

Copy `dist\ferry.exe` and run it. No Node, no Python, no installer.

On first run it looks for `ferry.config.json` in the working directory and tells you how to create one if it is missing.

### Known limits

**Windows only so far.** Path expansion, debug port lookup and command-line parsing all assume Windows.

**The exe is not code-signed.** Windows SmartScreen may warn about an unknown publisher on first run. Building it yourself makes no difference.

**Antigravity can only receive in a conversation that is already open.** Its debug protocol offers no way to target a closed conversation. Closed means mailbox.

**Keep one Antigravity conversation open at a time.** With several open, which window receives is decided by the UI, not by the tool.

**The Claude channel has never been properly adapted.** Claude Code has no official command for writing into a specific session, so this uses `claude -p --resume` and cannot obtain an acceptance receipt. Every message on that channel is marked unconfirmed rather than claimed as delivered.

**The Codex channel is write-only.** The receipt says queued, which means the message reached the queue, not that anyone read it.

**Codex and Claude channels need Node.js installed.** Both CLIs are JavaScript; the tool locates `node.exe` to run them. It reports clearly when Node is missing. The `dsh`, `antigravity` and `webhook` channels do not need Node.

### Reply protocol

Acknowledge first, then decide whether a second reply is warranted:

| Case | Reply |
|---|---|
| Pure notice | Nothing further |
| Disagreement | Just the objection and its evidence |
| Task finished | What changed, measured numbers, remaining risk |
| Task failed | Where it blocked, what was tried, what to do next |

Use `--expect report` when assigning work and `--expect ack` for announcements.

---

## Technical notes 技术说明

以下只给要改代码或排查故障的人看。Skip this section unless you are debugging or extending the tool.

### 架构

配置驱动。`ferry.config.json` 定义软件、类别、会话，每个软件对应一个适配器。内置 `dsh`、`codex`、`antigravity`、`claude`、`webhook` 五个。

五个适配器的投递方式各不相同：

- `dsh`：本地 HTTP，`session/prompt` steer，HMAC cookie 鉴权。端口随启动变化，靠扫监听端口逐个探测。
- `codex`：`codex queue --thread <id> --message <text>`，单向写。正文走命令行参数，受 Windows 32767 字符上限约束，工具在 26000 处提前拒绝。
- `antigravity`：CDP WebSocket 注入。逐行 `insertText` 加 Shift+Enter 换行，插完比对字数，偏差超 2% 中止。连接 8 秒超时，单次调用 5 秒超时。
- `claude`：`claude -p --resume <session-id>`，实验性。
- `webhook`：任意 HTTP 端点。

### 信箱

`queue/<别名>.jsonl`，一行一条记录。六种状态：

`pending` 待投 → `sending` 认领中 → `done` 已确认 / `unconfirmed` 未确认 / `dead` 死信 → `consumed` 已收取。

认领是两阶段的：先把 `sending` 落盘再投递，每条投完立刻回写。进程中途崩了，下次按 `claimedAt` 超时（5 分钟）回收成 `unconfirmed`，不会被静默吞掉。

写入用临时文件加原子改名。信箱文件有独立锁，锁带 nonce 与 300 秒过期接管。坏行原样保留，不因为「其余都消费完」就连文件一起删。

### 收件归属

`receive` 逐条比对记录的 `to` 与当前会话。写成别名或 `软件/类别` 都认，对不上的跳过、保留、并打印提示，不替人签收。

同一会话 id 挂了多个别名时，队列会分散在多个文件。默认**不**跨文件取件；确认这些别名真属于同一个对话后，可以打开 `aliasesOfSameSession`。

### 正文编码

正文不要用命令行参数直接传。Windows 下正文里的英文双引号会被当成参数边界，把一条消息切成多段，消息被静默截断而发送方以为成功。

正确做法是 base64 经 stdin：

```powershell
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($body))
$b64 | ferry.exe send --to dsh-work --summary "..." --encoding base64
```

base64 是纯 ASCII，编解码一轮哈希一致。工具会做往返校验，不一致就拒绝发送。

### 上限

正文默认 64 KB。摘要 300 字。Codex 通道 26000 字符。

### 构建

需要 Node.js 20 或更高。依赖装在 `build/` 里：

```powershell
cd build
npm install
node build.mjs
```

esbuild 打成单文件 CJS，Node SEA 注入 `node.exe` 副本，postject 写 blob。产物 `dist/ferry.exe`，约 88 MB。

### 环境变量

| 变量 | 作用 |
|---|---|
| `FERRY_CONFIG` | 指定配置文件路径 |
| `FERRY_NODE` | 指定 `node.exe` 路径 |
| `FERRY_DEBUG` | 打印异常堆栈 |
| `FERRY_WAIT_MS` | 覆盖确认等待时长（默认 45000） |
| `DSH_SECRET` | DSH 鉴权密钥，替代凭据文件 |

### 目录

```
src/adapters/   五个通道
src/core.mjs    投递、信箱、归档
src/config.mjs  配置校验与路径展开
src/main.mjs    命令行入口
skills/         给各软件用的技能说明
test/           纯函数单测，无外部依赖
```

## License

MIT
