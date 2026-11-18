<div align="center">
  <img src="assets/logo.png" width="130" height="130" alt="PostGull Logo" />
  <h1>PostGull · 信鸥</h1>
  <p>
    <b>Bridge communication across your desktop AI applications.</b><br/>
    <b>让同时运行的多个桌面 AI 对话软件直接互相通信。</b>
  </p>

  <p>
    <a href="#whats-this--这是什么">Overview / 概览</a> •
    <a href="#supported-apps--modes--支持的软件与模式">Adapters & Modes / 软件与模式</a> •
    <a href="#quick-start--快速开始">Quick Start / 快速开始</a> •
    <a href="#commands--常用命令">Commands / 常用命令</a> •
    <a href="#confirming-delivery--确认送达">Verification / 确认送达</a> •
    <a href="#known-limits--注意事项与局限">Limits / 局限说明</a> •
    <a href="#technical-notes--技术说明">Architecture / 架构细节</a>
  </p>

  <p>
    <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" />
    <img src="https://img.shields.io/badge/Platform-Windows-0078D6?logo=windows&logoColor=white" alt="Platform: Windows" />
    <img src="https://img.shields.io/badge/Node%20SEA-Single%20Binary-success?logo=node.js&logoColor=white" alt="Node SEA" />
    <img src="https://img.shields.io/badge/Standalone-No%20Runtime%20Required-orange" alt="Standalone" />
    <img src="https://img.shields.io/badge/Adapters-DSH%20%7C%20Codex%20%7C%20Gemini%20%7C%20Claude-8A2BE2" alt="Adapters" />
  </p>

```powershell
postgull.exe send --to my-gemini --summary "Benchmark finished with raw metrics" --body-file result.md
```
</div>

---

### What's this? / 这是什么

When running tools like DeepSeek Harness, Codex, and Antigravity (Gemini) side-by-side, each app operates inside an isolated desktop window without direct awareness of the others. Handing findings, code snippets, or test results from one conversation to another usually means manual copy-pasting.

同时使用 DeepSeek Harness、Codex、Antigravity（Gemini）这类桌面 AI 客户端时，每个程序都在独立的窗口里运行，彼此无法直接感知。如果想把某个会话得出的结论、代码或评测数据转交给另一个会话，平时往往只能靠手动复制粘贴。

Manual pasting breaks down quickly: long blocks get truncated by terminal buffers, prompts get lost when the target app is actively reasoning, and there is no audit log showing whether a payload ever arrived intact.

手动复制粘贴容易带来各种摩擦：长文本容易被终端缓冲区截断，目标会话正在深度思考时容易漏收，事后也很难核对某条内容到底有没有完整送达。

PostGull wires these local environments together. You trigger dispatches from the CLI, and messages land directly into the target session's context. When the recipient window is closed, payloads queue in local storage until the workspace opens, then go out on the next sweep or a manual flush. Every hop carries a unique token you can search for later.

PostGull 为这些本地 AI 客户端搭起直接通信通道。在命令行发送一条消息，它会投递到目标会话的上下文里；如果对方窗口还没打开，消息会暂存在本地信箱中，等窗口开启后由监控自动补投；每一跳都附带全局唯一凭证，支持全链路对账。

```text
 ┌──────────────────────┐       PostGull Relay         ┌──────────────────────┐
 │ DeepSeek Harness (UI)│ ──────────────────────────► │     OpenAI Codex     │
 │    (DSH Session)     │ ◄────────────────────────── │    (CLI Thread)      │
 └──────────────────────┘   (Global token, retryable) └──────────────────────┘
            ▲                                                    ▲
            │                 ┌──────────────────────┐           │
            └───────────────► │ Antigravity (Gemini) │ ◄─────────┘
                              │   (CDP Injected Win) │
                              └──────────────────────┘
```

> [!IMPORTANT]
> **This is not an API quota proxy, nor does it intermediate model calls.**  
> PostGull runs locally as a standalone binary. It moves formatted text between active desktop sessions and records a token for every hop so you can check whether a message arrived.  
>  
> **它不是 API 额度中转池，也不代理任何模型调用。**  
> PostGull 是一个纯本地运行的独立二进制工具。它只做一件事：把文本可靠地从一个桌面 AI 对话送到另一个桌面 AI 对话，并提供完整的送达判定凭证。

---

### Supported Apps & Modes / 支持的软件与模式

PostGull comes with built-in adapters for major desktop AI coding tools, paired with flexible dispatch modes:

PostGull 原生内置主流桌面 AI 客户端的适配器，并支持多种投递工作模式：

| Target Application / 适配软件 | Transport Method / 传输方式 | Key Capabilities / 支持特性 | Runtime Requirements / 运行依赖 |
|---|---|---|---|
| **DeepSeek Harness** | Local HTTP + HMAC Steer | Steer-mode direct injection, event hooks, session list auto-discovery.<br/>Steer 模式直投、事件监听回调、端口与会话自动探测。 | None (Zero dependency)<br/>无依赖 |
| **Antigravity (Gemini)** | Chrome DevTools Protocol (CDP) | Line-by-line WebSocket text injection, soft line-breaks, length validation.<br/>CDP 原生注入前台窗口、Shift+Enter 软换行、双向长度校验防截断。 | None (Zero dependency)<br/>无依赖 |
| **OpenAI Codex** | CLI Subprocess (`codex queue`) | Direct queue insertion into active background threads, length guardrail.<br/>直接将消息写入活跃线程队列、26,000 字符硬截断防护。 | Node.js (for Codex CLI)<br/>需要 Node 运行其 CLI |
| **Claude Code** | CLI Subprocess (`claude -p`) | Session resumption dispatch (experimental support).<br/>基于命令行恢复会话投递（实验性支持）。 | Node.js (for Claude CLI)<br/>需要 Node 运行其 CLI |
| **Custom Webhook** | HTTP POST Payload | JSON dispatch to any custom agent framework, workflow, or local server.<br/>标准 JSON 投递，可对接任意自建 Agent 框架或本地服务。 | None (Zero dependency)<br/>无依赖 |

#### Dispatch Modes / 核心工作模式

- **Direct Live Dispatch / 实时直投模式**：When the destination is open and idle, messages inject into the active session without queuing.<br/>当目标会话正处于打开且空闲状态时，消息直接送入前台窗口或进程上下文，不必排队。
- **Asynchronous Mailbox / 异步暂存模式**：If a window is closed, busy, or out of quota, messages sit in `queue/<alias>.jsonl` until the target wakes up, then get delivered by the watcher or a manual `postgull flush`.<br/>若目标会话未开启、正忙或额度耗尽，消息进入本地信箱排队；目标恢复后由监控自动补投，也可手动 `postgull flush`。
- **Receipt Verification / 凭证核验模式**：Every transaction generates a global unique token (`RELAY-timestamp-random`), making delivery status auditable across both send and receive transcripts.<br/>每次消息发送均生成全局唯一凭证，发收两端日志均可依据凭证精确查证。
- **Two-Phase Reply Protocol / 两次回复契约**：Enforces an instant `ACK` receipt first, followed by an optional second response based on task completion or measured objections, eliminating empty chatter.<br/>规范收发双方先立即回“收到”，后续按任务结果或异议自适应决定是否回第二次，杜绝无意义复读。

---

### Quick Start / 快速开始

PostGull distributes as a standalone single-file binary (`postgull.exe`). Download the release and run it directly without installing Node.js or Python.

PostGull 采用单文件二进制免安装分发（`postgull.exe`）。下载 Release 产物后可直接在 Windows 命令行下运行，无需提前安装 Node.js 或 Python 运行环境。

#### 1. Generate Configuration / 生成配置

Run this command in PowerShell to create your initial configuration file `postgull.config.json`:

在终端中执行以下命令，在当前目录下生成初始配置文件 `postgull.config.json`：

```powershell
postgull.exe init
```

#### 2. Configure Session IDs / 登记会话 ID

Open `postgull.config.json` and replace the placeholder `id` fields under `sessions` with your actual session identifiers. Each application only needs one active session per category:

打开生成的配置文件，把 `sessions` 列表中各项目的 `id` 替换为实际的会话标识。每个软件在同一类别下只需要登记一个活跃会话：

| Application / 软件 | Lookup Method / 如何获取会话 ID |
|---|---|
| **Antigravity / Gemini** | The 36-character UUID following `/c/` in the browser or window address bar.<br/>打开对应对话窗口，取地址栏或标题 URL 中 `/c/` 后面的 36 位 UUID。 |
| **OpenAI Codex** | The thread ID shown by `codex resume`, or the identifier ending the rollout file name under `%USERPROFILE%\.codex\sessions\`.<br/>执行 `codex resume` 列表显示的 thread id，或查看 `%USERPROFILE%\.codex\sessions\` 下 rollout 文件名末尾的标识。 |
| **DeepSeek Harness** | The identifier starting with `session-` shown in the session header or list.<br/>对话顶栏或会话列表中以 `session-` 开头的标识。 |
| **Claude Code** | The session ID returned in the `claude --resume` listing.<br/>执行 `claude --resume` 列表中展示的会话 id。 |

Configuration discovery follows this lookup chain: current working directory → executable directory → `%APPDATA%\PostGull\postgull.config.json`. Placing the file in AppData makes PostGull accessible system-wide from your PATH. Setting the `POSTGULL_CONFIG` environment variable overrides this path.

配置查找顺序为：当前工作目录 → exe 所在目录 → `%APPDATA%\PostGull\postgull.config.json`。若将配置放在 AppData 目录下，即可配合 PATH 环境变量在系统任意目录直接调用。也可以通过设置环境变量 `POSTGULL_CONFIG` 指定自定义路径。

#### 3. Self-Check / 连通性自检

Run the doctor command to verify adapter reachability, configuration validity, and mailbox queue status:

运行自检命令，检查各通道连接状态、配置文件格式与信箱积压情况：

```powershell
postgull.exe doctor
```

#### 4. Send Your First Message / 发送第一条测试消息

Send a message by referencing the target alias registered in your configuration:

根据配置文件中登记的目标别名发送第一条测试消息：

```powershell
postgull.exe send --to <target-alias> --summary "Please review these findings" --body-file .\reply.md
```

Aliases represent the names defined in your session table. Run `postgull list` to view all configured targets.

别名对应配置文件中设置的 alias 字段，运行 `postgull list` 可以查看当前全部可用目标。

---

### Commands / 常用命令

| Command / 命令 | Description / 作用说明 |
|---|---|
| `postgull send --to <alias>` | Send a message to a registered session.<br/>向已配置的目标会话发送一条消息。 |
| `postgull list` | Display configured apps, categories, sessions, and quota status.<br/>查看当前配置的软件、类别、会话及额度状态。 |
| `postgull doctor` | Run diagnostics across adapters, config health, mailboxes, and locks.<br/>体检通道连通性、配置有效性、暂存信箱与锁状态。 |
| `postgull queue` | Check backlog across all local mailboxes.<br/>检查本地信箱是否有待投递的消息积压。 |
| `postgull receive --to <self>` | Pull and archive pending messages addressed to your session.<br/>从信箱收取指派给自己的暂存消息并归档。 |
| `postgull flush <target>` | Manually deliver pending backlog to a target that is now awake.<br/>将积压在信箱中待处理的消息补投到已就绪的目标。 |
| `postgull watch --hours 2` | Periodically inspect mailboxes and alert on stale messages.<br/>后台周期性巡检，对积压超时的滞留消息发出警报。 |
| `postgull archive --tail 10` | Query delivery history to verify completed transactions.<br/>查阅归档流水，核对历史消息是否已送达与接收。 |

---

### Delivery Diagnostics / 为什么消息发不出去

When a message is delayed, PostGull avoids silent failures and outputs the exact blocking state:

当消息未能立即投递时，工具不会静默失败，而是会明确指出当前的阻塞原因：

- **Target window closed / 目标窗口未开启**：Messages sit in local queue storage until the target opens and `flush` runs.<br/>消息会自动转入本地信箱暂存，等待目标窗口打开后再补投。
- **Target busy / 目标忙碌**：Messages remain queued to prevent overriding active foreground prompts.<br/>消息会保持排队，避免打断对方正在进行的推演或覆盖未发草稿。
- **Target quota exhausted / 目标额度耗尽**：The tool stops immediately instead of blindly dispatching into a failing runtime.<br/>工具会直接拒绝投递并告知刷新时间，避免无效调用。

---

### Confirming Delivery / 确认送达

> [!TIP]
> **Three Verification Criteria / 确认送达的三硬判据**
>
> 1. **Zero backlog / 队列清空**：`postgull queue` reports zero pending entries for that destination.<br/>`postgull queue` 确认该目标暂存消息数为 0。
> 2. **Token presence / 凭证留痕**：The unique receipt ID is searchable in the recipient app's conversation log.<br/>在接收方对话界面或本地日志中可直接搜到本次消息凭证。
> 3. **Receipt reference / 对方回复引用**：The recipient explicitly quotes the receipt ID in their response.<br/>对方在下次回信中明确引用了该凭证。
>
> *The third check provides definitive proof of processing; the first two only confirm arrival at the interface.*<br/>
> *第三条是最硬的判据；前两条仅说明消息已送达界面，第三条才能证明对方已经真正读取。*

---

### Reply Protocol / 两次回复规范

When a message arrives, acknowledge with a concise receipt first before handling work. Then decide whether a second response is warranted:

收到消息后，先立即回传简短的“收到”确认，然后开始处理。完成后按消息性质决定是否回复第二次：

| Scenario / 业务场景 | Reply Guidance / 回复规则 |
|---|---|
| **Pure notice / 纯通知无异议** | No further response needed. Finish the turn.<br/>无需二次回复，直接结束回合，避免无意义客套。 |
| **Disagreement / 有异议或需澄清** | State specific objections backed by measured evidence.<br/>仅围绕异议点回复事实与实测数据。 |
| **Task finished / 安排的任务已完成** | Report modified files, actual measured numbers, and remaining risks.<br/>汇报具体修改的文件、真实测量数值与剩余风险。 |
| **Task blocked / 安排的任务未完成** | Detail the blocker, paths explored, and suggested next steps.<br/>如实说明失败原因、卡在何处、试过的路径及建议方案。 |

When assigning actionable work, append `--expect report`. For broadcast announcements, use `--expect ack`.

指派具体任务时附带 `--expect report`，发送纯通知或单向同步时使用 `--expect ack`。

---

### Known Limits / 注意事项与局限

**Windows exclusive / 仅验证过 Windows 平台**  
Path expansion, named pipe conventions, and debug port resolution are tailored for Windows environments.  
路径解析、命名管道与调试端口探测均按 Windows 系统编写，暂未适配其他平台。

**Unsigned binary / 二进制文件未签名**  
Without a commercial code-signing certificate, Windows SmartScreen may present an unknown publisher prompt on first launch. Select "Run anyway".  
由于未购买商业代码签名证书，首次运行 Windows SmartScreen 可能会提示未知发布者，点击“仍要运行”即可。

**Antigravity foreground requirement / Antigravity 依赖前台可见窗口**  
Antigravity can only receive messages in conversations currently open in the interface; closed sessions redirect messages to the mailbox queue. Keep only one conversation open at a time to prevent Chrome DevTools Protocol from targeting unintended tabs.  
Antigravity 只能向当前已经在界面打开的前台对话投递消息，未打开的会进入信箱暂存；同时建议界面仅保留一个对话窗口，避免调试协议无法确定目标标签页。

**CLI adapter considerations / CLI 适配器特性限制**  
Codex operates write-only (`queued` indicates message acceptance by the CLI queue, not human reading). The Claude adapter is experimental using `claude -p --resume` without formal delivery acknowledgments. Both CLI channels require a local Node.js installation because their tools are JavaScript-based; `dsh`, `antigravity`, and `webhook` run independently of Node.  
Codex 通道为单向写入（回执显示 queued 仅代表写入其命令行队列，不代表已读）；Claude 通道采用 `claude -p --resume` 方式，属于实验性适配；这两个通道依赖本机安装有 Node.js 运行环境；而 `dsh`、`antigravity`、`webhook` 通道则完全不依赖 Node.js。

---

### Technical Notes / 技术说明

*This section is intended for maintainers and developers extending PostGull.*  
*本节供需要修改源码、扩展通道或排查底层故障的维护者参考。*

<details>
<summary><b>Click to expand architecture & implementation details / 点击展开底层架构与实现细节</b></summary>

#### Architecture / 架构设计

PostGull is configuration-driven. `postgull.config.json` defines applications, categories, and active sessions. Five built-in adapters handle transport:

PostGull 采用配置驱动架构。`postgull.config.json` 声明软件、类别与活跃会话，内置五个底层适配器负责传输：

- `dsh`: Local HTTP via `session/prompt` in steer mode with HMAC cookie authentication. Ports are discovered dynamically by scanning localhost listeners.<br/>通过本地 HTTP 调用 `session/prompt`（steer 模式），使用 HMAC cookie 鉴权。端口随机，靠本地监听端口扫描自适应发现。
- `codex`: Dispatches through `codex queue --thread <id> --message <text>`. Text travels via CLI argument, capped at 26,000 characters to stay within Windows command-line limits.<br/>通过 `codex queue` 执行，消息走命令行参数，工具在 26,000 字符处提前做截断防护。
- `antigravity`: CDP WebSocket injection. Injects text line-by-line using Shift+Enter to avoid early submits, verifying character length within a 2% margin.<br/>通过 CDP WebSocket 连接。逐行注入文本配合 Shift+Enter 软换行，注入后做双向字符长度对齐核验。
- `claude`: Experimental session resumption via `claude -p --resume <id>`.<br/>通过命令行恢复会话，属于实验性通道。
- `webhook`: Generic HTTP POST endpoint.<br/>通用 HTTP POST 适配器。

#### Mailbox Mechanism / 异步信箱机制

Stored in `queue/<alias>.jsonl`, recording one JSON entry per line across six lifecycle states:

队列位于 `queue/<alias>.jsonl`，每行一条独立 JSON，支持六种生命周期状态：

`pending` (queued) → `sending` (in-flight lease) → `done` (confirmed) / `unconfirmed` / `dead` → `consumed` (cleared).

Leasing uses a two-phase protocol: `sending` is flushed to disk before delivery attempts. If a process terminates unexpectedly, unacknowledged leases expire after 5 minutes and revert to `unconfirmed` without data loss. File operations employ atomic renames and lockfiles with nonces and 300-second stale lease recovery.

认领采用两阶段设计：投递前先将状态落盘为 `sending`。若进程意外崩溃，超时的条目在 5 分钟后自动回收为 `unconfirmed`，防止消息丢失。写入采用临时文件原子替换，文件锁带 nonce 并设置 300 秒超时清理。

#### Payload Encoding / 正文编码规范

Never pass multi-line text directly through Windows command arguments, as unescaped quotes split strings and cause silent truncation. Base64 via standard input ensures byte-level consistency:

在 Windows 命令行下切勿直接传多行或含引号文本，双引号易导致参数截断。建议使用 base64 经 stdin 管道传递：

```powershell
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($body))
$b64 | postgull.exe send --to <alias> --summary "..." --encoding base64
```

#### Build Pipeline / 二进制构建流水线

Build requires Node.js 20+. Dependencies live inside `build/`:

构建需要 Node.js 20 或更高版本：

```powershell
cd build
npm install
node build.mjs
```

esbuild packages code into a single CommonJS bundle, Node SEA injects it into a `node.exe` template, and `patch-res.py` updates the PE resource segment with icons and version strings.

esbuild 打包为单个 CommonJS 文件，Node SEA 注入模板，最后由 `patch-res.py` 调用 Windows 原生资源 API 写入多尺寸图标与版本信息，产物约为 88MB。

Icon patching relies on Python 3 using standard library `ctypes`. The build auto-detects interpreters via `POSTGULL_PYTHON` → PATH commands → Conda registry (`~/.conda/environments.txt`) → `py -0p`. If Python is unavailable, icon patching is skipped without failing the build.

写入图标依赖 Python 3 标准库 `ctypes`。构建脚本自带探测链，若系统未安装 Python，会自动跳过图标注入并正常产出可用 exe。

#### Environment Variables / 环境变量

| Variable / 变量 | Purpose / 作用 |
|---|---|
| `POSTGULL_CONFIG` | Override configuration file path.<br/>覆盖配置文件加载路径。 |
| `POSTGULL_NODE` | Specify custom `node.exe` executable.<br/>指定 Node.js 解释器路径。 |
| `POSTGULL_PYTHON` | Specify Python 3 binary for PE resource patching.<br/>指定资源写入所需的 Python 解释器。 |
| `POSTGULL_DEBUG` | Enable verbose diagnostic logging and stack traces.<br/>开启详细异常堆栈与诊断日志。 |
| `POSTGULL_WAIT_MS` | Override receipt confirmation timeout (defaults to 45,000 ms).<br/>覆盖投递确认等待超时阈值（默认 45 秒）。 |
| `DSH_SECRET` | Pass DSH authentication secret directly.<br/>直接指定 DSH 通信鉴权密钥。 |

</details>

---

## License / 许可协议

MIT License. See [LICENSE](LICENSE) for details.
