# PostGull 信鸥

让同时开着的几个 AI 软件互相说话。

A small tool that lets your AI apps talk to each other.

```
postgull.exe send --to my-gemini --summary "跑完了，附实测数字" --body-file result.md
```

---

## 中文

### 这是什么

你同时在用 DeepSeek Harness、Codex、Antigravity（Gemini）这类软件，每个软件一个窗口，互相看不见。想让 A 里的对话把结论交给 B 里的对话，现在只能复制粘贴。

复制粘贴有三个问题：长文本粘不全，对方忙的时候会漏，事后查不到到底发出去没有。

PostGull 给它们接一条线。命令行发一条消息，落到对方对话里；对方没开窗口，消息存进信箱，等它开了再送；每一跳都有凭证，随时能查。

它不是 API 额度中转，也不代理模型调用。只做一件事：把一段文字从 A 软件的对话送到 B 软件的对话，并且让你知道送到了没有。

### 快速开始

**一、生成配置**

```powershell
postgull.exe init
```

当前目录生成 `postgull.config.json`。

**二、填会话 id**

打开配置，把 `sessions` 里每个 `id` 换成真实的会话标识。每个软件同一类别下只需要登记一个活跃会话，换对话时改这一处就行。

「会话 id」是什么、去哪儿找：

| 软件 | 怎么找 |
|---|---|
| Antigravity / Gemini | 打开那个对话，地址栏或窗口 URL 里 `/c/` 后面那串 36 位 UUID |
| Codex | `codex resume` 列表里显示的 thread id，或 `%USERPROFILE%\.codex\sessions\` 下 rollout 文件名末尾那一串 |
| DeepSeek Harness | 会话顶栏或会话列表里的 `session-` 开头的标识 |
| Claude | `claude --resume` 列表里的 session id |

配置放哪儿都行，按这个顺序找：当前目录 → exe 所在目录 → `%APPDATA%\PostGull\postgull.config.json`。想让 exe 放进 PATH 后在任意目录都能用，把配置放到第三处即可。也可以设 `POSTGULL_CONFIG` 指向任意路径。

**三、自检**

```powershell
postgull.exe doctor
```

它会告诉你哪个通道能通、哪个连不上、信箱里有没有积压。

**四、发第一条**

```powershell
postgull.exe send --to <postgull list 里看到的别名> --summary "请复核这四条结论" --body-file .\reply.md
```

别名就是你在配置里给会话起的名字，跑 `postgull list` 能看到全部。

### 常用命令

| 命令 | 作用 |
|---|---|
| `postgull send --to <目标>` | 发一条消息 |
| `postgull list` | 看有哪些软件、类别、会话 |
| `postgull doctor` | 体检：通道、配置、信箱、锁 |
| `postgull queue` | 看信箱积压 |
| `postgull receive --to <自己>` | 从信箱收取发给自己的消息 |
| `postgull flush <目标>` | 把信箱里待投的补发出去 |
| `postgull watch --hours 2` | 定期巡检，发现卡住的消息就告警 |
| `postgull archive --tail 10` | 查归档，确认某条到底发没发 |

### 消息为什么发不出去

三种常见情况，工具都不会静默失败：

- 对方窗口没打开。消息进信箱，等对方开了再 `flush`。
- 对方在忙。消息排队，等它空下来。
- 对方额度用尽。工具直接拒绝，不会白投。

这三种都会在命令行明确告诉你卡在哪，不会假装成功。

### 怎么确认对方真的收到了

不看命令返回什么，看三个地方：

1. `postgull queue` 里该目标零积压。
2. 对方对话里能搜到本次凭证号。
3. 对方回复里引用了这个凭证。

第三条最硬。只有前两条成立时，也只说明消息进了对方的界面，不代表它读过。

### 装给别人用

把 `dist\postgull.exe` 拷过去，双击或命令行运行。不需要装 Node，不需要 Python。

第一次运行会在当前目录找 `postgull.config.json`，找不到就提示怎么生成。

### 已知限制

**只在 Windows 上验证过。** 路径展开、调试端口、命令行解析都按 Windows 写的。

**exe 没有代码签名。** 首次运行 Windows 可能提示「未知发布者」，选「仍要运行」。自己从源码构建也一样。

**Antigravity 依赖前台可见的窗口。** 它只能给已经打开的对话发消息，没开的只能进信箱。而且建议同时只开一个，开多个时消息落到哪个窗口由界面决定，工具决定不了。两条都来自它的调试协议，不是本工具的取舍。

**CLI 适配器各有特性。** Codex 只能写不能读，回执说「已入队」不代表对方读过。Claude 通道没真实适配过，用 `claude -p --resume` 模拟，拿不到「已接受」凭证，一律标「未确认」。这两个通道还需要本机装 Node.js（它们是 JavaScript 写的），找不到会给明确提示；`dsh`、`antigravity`、`webhook` 三个通道不需要 Node。

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

PostGull wires them together. Send a message from the command line and it lands in the target conversation. If that window is closed, the message waits in a mailbox until it opens. Every hop gets a receipt, so you can always check.

This is not an API quota relay and does not proxy model calls. It moves text from one AI conversation to another, and tells you whether it arrived.

### Quick start

**1. Create a config**

```powershell
postgull.exe init
```

**2. Fill in session ids**

Open `postgull.config.json` and replace each placeholder `id` under `sessions` with a real session identifier. One active session per app per category is enough; when you switch conversations, edit that one field.

Where to find each id:

| App | Where |
|---|---|
| Antigravity / Gemini | The 36-character UUID after `/c/` in the conversation's URL |
| Codex | The thread id shown by `codex resume`, or the trailing id in a rollout filename under `%USERPROFILE%\.codex\sessions\` |
| DeepSeek Harness | The `session-` prefixed identifier in the session list or title bar |
| Claude | The session id shown by `claude --resume` |

The config is looked up in this order: current directory, then the exe's directory, then `%APPDATA%\PostGull\postgull.config.json`. Put it in the third location if you want the exe on PATH to work from any directory. `POSTGULL_CONFIG` overrides all of it.

**3. Check the setup**

```powershell
postgull.exe doctor
```

It reports which channels reach their app, which do not, and whether anything is stuck in a mailbox.

**4. Send something**

```powershell
postgull.exe send --to <alias from postgull list> --summary "Please review these four conclusions" --body-file .\reply.md
```

The alias is whatever you named a session in your config. Run `postgull list` to see them.

### Commands

| Command | What it does |
|---|---|
| `postgull send --to <target>` | Send one message |
| `postgull list` | Show apps, categories, sessions |
| `postgull doctor` | Health check: channels, config, mailboxes, locks |
| `postgull queue` | Show mailbox backlog |
| `postgull receive --to <self>` | Take messages addressed to you |
| `postgull flush <target>` | Deliver everything waiting for that target |
| `postgull watch --hours 2` | Periodic check, alert on stuck messages |
| `postgull archive --tail 10` | Search the archive to confirm a send |

### When a message does not go through

Three cases, none silent:

- Target window is closed. The message goes to the mailbox and waits for `flush`.
- Target is busy. The message queues.
- Target is out of quota. The tool refuses up front instead of sending into a void.

Each case names the blocker. None of them pretend to succeed.

### Confirming delivery

Do not trust the exit code. Check three things:

1. `postgull queue` shows zero backlog for that target.
2. The receipt id is searchable in the target conversation.
3. The reply quotes that receipt.

The third is the only real proof. The first two together still only show the message reached the other app's UI, not that anyone read it.

### Sharing it

Copy `dist\postgull.exe` and run it. No Node, no Python, no installer.

On first run it looks for `postgull.config.json` in the working directory and tells you how to create one if it is missing.

### Known limits

**Windows only so far.** Path expansion, debug port lookup and command-line parsing all assume Windows.

**The exe is not code-signed.** Windows SmartScreen may warn about an unknown publisher on first run. Building it yourself makes no difference.

**Antigravity needs a visible foreground window.** It can only deliver into a conversation that is already open; closed means mailbox. Keep one open at a time, since with several open the UI decides which window receives. Both limits come from its debug protocol, not from this tool.

**The CLI adapters have their own quirks.** Codex is write-only: a receipt saying queued means the message reached the queue, not that anyone read it. The Claude channel has never been properly adapted, uses `claude -p --resume`, and cannot obtain an acceptance receipt, so every message there is marked unconfirmed. Both channels need Node.js installed since those CLIs are JavaScript; the tool says so plainly when Node is missing. The `dsh`, `antigravity` and `webhook` channels do not need Node.

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

配置驱动。`postgull.config.json` 定义软件、类别、会话，每个软件对应一个适配器。内置 `dsh`、`codex`、`antigravity`、`claude`、`webhook` 五个。

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
$b64 | postgull.exe send --to dsh-work --summary "..." --encoding base64
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

esbuild 打成单文件 CJS，Node SEA 注入 `node.exe` 副本，postject 写 blob，最后用 `patch-res.py` 写入图标与版本信息。产物 `dist/postgull.exe`，约 88 MB。

图标与版本信息这一步需要 Python 3（只用标准库 `ctypes`，不需要 Pillow）。脚本按这个顺序找解释器：环境变量 `POSTGULL_PYTHON` → `python` / `python3` / `py` 命令 → conda 自己记录的 `~/.conda/environments.txt` → `py -0p` 列出的路径。都找不到就跳过，exe 仍能正常运行，只是图标是 Node 默认的、属性页显示 Node.js。

两个踩过的坑，写下来省得重走：

`rcedit` 在 88 MB 的 SEA exe 上会永久挂住，只设版本信息也要挂十几分钟不返回，不能用。

纯 JS 的 `resedit` 能改图标，但版本信息的 `setStringValues` 与 `setFileVersion` 写回文件后会被还原，读回来仍是 Node.js。新建块、原地改、调换删除顺序都试过，均无效。

最终用 Python 直接调 Windows 的 `BeginUpdateResourceW` / `UpdateResourceW` / `EndUpdateResourceW`，PE 结构交给系统改写，实测 0.8 秒完成且结果正确。

图标源文件是 `build/postgull.ico`，由 `build/make-icon.py` 从 PNG 生成，内含 16 到 256 共七种尺寸。

### 环境变量

| 变量 | 作用 |
|---|---|
| `POSTGULL_CONFIG` | 指定配置文件路径 |
| `POSTGULL_NODE` | 指定 `node.exe` 路径 |
| `POSTGULL_DEBUG` | 打印异常堆栈 |
| `POSTGULL_WAIT_MS` | 覆盖确认等待时长（默认 45000） |
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
