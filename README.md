# agent-bridge

跨软件消息桥。让 DeepSeek Harness、Codex、Antigravity / Gemini 这类各自独立的 AI 软件互相发消息、排队、收件、补投。

单文件 exe，不需要装 Node，不需要写脚本，双击就能用。

```
agent-bridge.exe send --to dsh-work --summary "请复核这份结论" --body-file reply.md
```

## 它解决什么问题

你在两个 AI 软件里各开一个对话，让它们协作。麻烦不在「怎么切窗口」，而在这几件事：

- 消息发过去了没有？对端有没有真的收到？
- 对端在忙或没开着，消息是不是就丢了？
- 同一条消息会不会发两遍？
- 三天后想查「上周那条到底发了没」，去哪儿看？

这个工具把投递、确认、排队、归档分开处理，每一件事都有可查的记录。

## 快速开始

### 1. 生成配置

```powershell
agent-bridge.exe init
```

会在当前目录生成 `bridge.config.json`。里面是一份带占位符的样例，`id` 那几项要换成真实会话 id。

### 2. 填会话 id

编辑器打开 `bridge.config.json`。结构长这样：

```json
{
  "bridgeName": "my-bridge",
  "software": [
    { "id": "dsh", "adapter": "dsh", "options": { "credentials": "%USERPROFILE%\\.dsh\\.credentials.yaml" } },
    { "id": "codex", "adapter": "codex", "options": { "command": "codex" } },
    { "id": "gemini", "adapter": "antigravity", "options": { "devtoolsPortFile": "%APPDATA%\\Antigravity\\DevToolsActivePort" } }
  ],
  "sessions": [
    { "alias": "dsh-bridge", "software": "dsh", "category": "bridge", "id": "填真实 id" },
    { "alias": "dsh-work", "software": "dsh", "category": "work", "id": "填真实 id" },
    { "alias": "gemini-work", "software": "gemini", "category": "work", "id": "填真实 id" }
  ]
}
```

`alias` 是你自己起的短名，发消息时用 `--to dsh-work` 这种形式引用它。起成什么都行，字母数字点横线下划线，40 字符以内。

### 3. 自检

```powershell
agent-bridge.exe doctor
```

会逐个试通道、看信箱、检查配置。占位符没换掉、命令找不到、端口连不上，都会在这里报出来。

### 4. 发第一条

```powershell
agent-bridge.exe send --to dsh-work --from "我的桥" --summary "确认通道是否可用" --text "这是一条测试消息"
```

## 自定义：软件、类别、数量

这三样都由配置决定，代码里没有任何写死的软件名或类别名。

**加软件。** 在 `software` 数组里加一条，`adapter` 选内置的 `dsh` / `codex` / `antigravity` / `claude` / `webhook`。前四个是官方适配，`webhook` 是通用出口，任何能收 HTTP POST 的系统都能接。

**加类别。** `category` 是纯字符串，`work`、`bridge`、`learn`、`review` 都行，没有白名单。同一条消息队列按别名分文件，所以类别只是给人看的标签加筛选维度。

**同类别多个会话。** 这是和旧版最大的区别。旧版规定一个软件一个类别只能有一个活跃会话，这里没有这个限制：

```json
{ "alias": "dsh-work-1", "software": "dsh", "category": "work", "id": "..." },
{ "alias": "dsh-work-2", "software": "dsh", "category": "work", "id": "..." },
{ "alias": "dsh-learn",  "software": "dsh", "category": "learn", "id": "..." }
```

发的时候用 `--to dsh/work#1`、`--to dsh/work#2` 选序号（按别名排序），或者直接用别名 `--to dsh-work-2`。别名是最稳的写法。

**加会话不用改文件。** 也可以命令行加：

```powershell
agent-bridge.exe session add --alias learn-1 --software dsh --category learn --id session-xxx
agent-bridge.exe session rm --alias learn-1
agent-bridge.exe session off --alias learn-1
```

## 命令行

| 命令 | 作用 |
|---|---|
| `init` | 生成配置模板 |
| `list` | 软件、类别、会话、额度、休眠状态 |
| `doctor` | 自检：配置、通道、信箱、锁 |
| `send` | 发一条消息 |
| `queue` | 查看积压（pending / sending / unconfirmed） |
| `receive` | 收件：打印全文、移出信箱、给点名回执 |
| `flush <目标>` | 把信箱里的消息补投出去 |
| `stale --hours 2` | 列出超时未投递 |
| `watch` | 定期巡检，可选 `--alert-to` 告警 |
| `archive --tail 10` | 看归档 |
| `session add\|rm\|on\|off` | 增删会话、启停 |
| `quota set\|clear` | 标某个软件额度耗尽 |
| `blocked add\|rm` | 禁止投递名单 |

`send` 的参数：

| 参数 | 说明 |
|---|---|
| `--to` | 别名，或 `软件/类别`，或 `软件/类别#序号` |
| `--from` | 来源标识，写进消息头 |
| `--summary` | 必填，300 字内，给人类看，说清要对方做什么 |
| `--expect` | `report`（默认，完成后要回报）或 `ack`（只要收到） |
| `--text` | 短正文 |
| `--body-file` | 从文件读正文，长文本用这个 |
| `--encoding` | 从 stdin 读时的编码，`base64`（默认）或 `raw` |
| `--dry-run` | 只打印不投 |
| `--test` | 声明这条是通道自测。默认禁止发往 `work` 类会话 |
| `--i-know-its-work` | 配合 `--test`，强行允许 work 目标 |

## 回复协议

这一条是强制的，写在每条消息头里，也写进了各个 skill：

- **每条消息都要先回一句「收到」，再处理正文。** 发送方靠这个确认送达，不然只能空等。
- **纯通知不需要后续回复。** 只是告知一件事、不要求对方给结果，回完「收到」就结束。
- **表示同意也不需要回复。** 一句「同意」或「收到，按此执行」就够，不要复述对方论点再逐条夸奖。
- **有指导意见或完成了任务，事后要汇报。** 做了什么、实测数字、剩余风险、下一步谁做什么。

`--expect report` 和 `--expect ack` 就是用来区分这两种场合的。派活、要求复核、需要结论用 `report`；通报、告知完成用 `ack`。

### 两次回复规范

完整版在 `skills/_shared/two-replies.md`，四个 skill 里写的都指向它，改动只改一份。

第一次回复只回「收到」，语义是「已收到并开始读取」，不代表工作已完成。第二次回复按消息性质分四种：

| 情况 | 怎么回 |
|---|---|
| A 纯通知、无异议 | 不回，结束 |
| B 有异议或需澄清 | 只回异议点，带实测依据 |
| C 已安排的任务做完 | 回做了什么、实测数字、剩余风险、待裁决项 |
| D 已安排的任务没做成 | 回失败原因、卡点、试过的路径、建议 |

判断标准：这条回复发出去，对方能读到它原本不知道的东西吗？答案是「没有，只是知道我收到了」就不该发。

收件、解析、回 ACK 属于格式搬运，执行时不展开深度思考，也不顺手分析消息内容的学术或工程含义。能配低耗模型的通道就配：配置里 `software[].options.receiveModel` 声明低耗档位（如 codex 的 `gpt-6-luna`），工具在回执类投递时会带上它。

## 消息长什么样

```
【来源：DSH桥接】
【唯一凭证：BRG-1700000000000-a1b2c3】
【摘要】请复核 V8 端盖有效性的四条结论
【回复要求】先回一句"收到"，再处理正文；完成后请把做了什么、实测数字、剩余风险回给发送方。

--- 正文 ---

（原文）
```

凭证是全局唯一的，用来对账：对方引用凭证回信，你就能确认是同一份。

## 为什么正文要 base64

Windows 上把长正文当命令行参数传时，正文里的英文双引号会被当成参数边界，一条消息被切成多个参数，静默截断而发送方以为成功。实测过：1500 字只送达 289 字，「【来源：…】」变成了「【来源：->】」。

stdin 直传也不行，PowerShell 必定追加回车换行，内容哈希对不上。base64 是纯 ASCII，编解码一轮 SHA-256 完全一致。

```powershell
$body = @'
正文
'@
$summary = '摘要'
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($body))
$b64 | agent-bridge.exe send --to dsh-work --summary $summary
```

工具会做往返校验：解码后重新编码，与原文不一致就拒绝发送，不会静默把乱码发出去。

## 异步信箱

对端不可达时消息不丢，转存到 `queue/<别名>.jsonl`，等对端可达再补投。

什么时候会转信箱：

- Antigravity 目标对话没在界面打开（CDP 硬限制，只能注入当前渲染的页面）
- Codex 额度耗尽
- DSH 没在运行
- 注入成功但等不到对端接受凭证

状态机：

| 状态 | 含义 |
|---|---|
| `pending` | 待投递 |
| `sending` | 已认领、正在投。进程崩溃后 5 分钟不再自动重投，而是标为 `unconfirmed` |
| `done` | 已确认送达 |
| `unconfirmed` | 已提交但拿不到接受凭证，或上次投递中途退出。不会自动重投 |
| `dead` | 连续 8 次失败，停止重试，等人处理 |
| `consumed` | 对方已取走 |

补投：

```powershell
agent-bridge.exe queue
agent-bridge.exe flush dsh-work
agent-bridge.exe flush dsh-work --force MSG-xxx   # 只重投指定那一条
agent-bridge.exe flush dsh-work --force all       # 全部 unconfirmed 都重投，慎用
```

`unconfirmed` 需要人判断。它可能已经到了，只是对端没留下可查记录；盲目重投会发两遍。所以 `--force` 要求显式给出消息编号或 `all`，不接受「顺手全重投」。

### 同一会话挂了多个别名

队列按别名分文件。如果 `alice` 和 `alice-2` 指向同一个会话 id，消息可能落进两个不同的队列文件，用其中一个别名 receive 会漏掉另一个。

默认**不**聚合：一次 receive 只读自己那一个文件。跨文件取件正是本文档前面那起误取件事故的模式，不该默认打开。

确认这些别名真的属于同一个对话后，可以在配置里打开：

```json
"aliasesOfSameSession": true
```

打开后 receive 会把这些同 id 别名的队列一起取，且仅限 id 完全相同的条目，不会跨到别的会话。

## 定期巡检积压

```powershell
agent-bridge.exe watch --hours 2 --interval 15m
agent-bridge.exe watch --hours 2 --interval 30m --alert-to dsh-bridge
agent-bridge.exe watch --once --hours 2
```

做成 Windows 定时任务，不用 bat：

```powershell
$exe = "C:\path\to\agent-bridge.exe"
schtasks /Create /TN "AgentBridge-Watch" /SC MINUTE /MO 30 /F /TR "`"$exe`" watch --once --hours 2 --alert-to dsh-bridge"
```

退出码：`0` 无超时，`1` 有积压或通道异常。任务计划的「上次运行结果」就能看到。

## 各软件的 skill

`skills/` 下每个软件一个 skill 包，告诉该软件里的 AI 怎么用这个工具：

| 目录 | 给谁 |
|---|---|
| `agent-bridge-dsh` | DeepSeek Harness |
| `agent-bridge-codex` | Codex |
| `agent-bridge-gemini` | Antigravity / Gemini |
| `agent-bridge-claude` | Claude（实验性） |
| `bridge-backlog-watch` | 任何负责巡检的会话 |

装法：把对应目录整个拷到该软件的 skill 目录。DSH 是 `%USERPROFILE%\.dsh\skills\`，其他软件按各自约定。目录里只有 `SKILL.md`，没有依赖。

## 已知限制（请先读）

**Claude 通道没有做过真实适配。** Claude Code 没有「向指定会话队列写消息」的官方子命令，这里用 `claude -p --resume <session-id>` 把正文当新输入续接会话。问题是：不同版本对 `--resume` 的支持不一致，可能直接报错；而且没有可查的「对方已接受」凭证，只能确认进程返回 0。所以这个通道一律标「未确认接受」，不假装成功。有人在真实环境跑通前，把它当实验品。

**Antigravity 只能收已打开对话的消息。** CDP 只能操作当前渲染的页面，未打开或切走的对话没有输入框 DOM。这不是配置问题：`Target.createTarget` 实测返回 `Not supported`（Electron 禁用该域方法），`PUT /json/new` 返回 500，也没有官方 HTTP/RPC 写入接口。别花时间试绕过。

**Antigravity 同时只建议开一个对话窗口。** 原因是软件限制，不是设计偏好：CDP 只能向「当前渲染的那个页面」注入，同时开两个对话时哪个在前台由界面决定，不由工具决定，所以无法保证消息落到你指定的那个。实测排除过 `Target.createTarget`（返回 Not supported）与 `PUT /json/new`（500）这类指定目标的办法，绕不过去。

工具本身只按「目标 id 是否在已打开的页面里」判断能不能投，不会因为多开了窗口就拒绝。多开时 `doctor` 会打印警告并列出所有已打开对话的 id，你自己对照确认哪个在前台。要不要同时开多个，由你控制。

**Antigravity 的确认等待可能超时，但消息其实已送达。** 注入成功后工具会等 transcript 里出现含凭证的 `USER_INPUT`，默认 45 秒。实测有对方 38 秒后才落盘的情况（本机一次是放弃后 38 秒），这时记录会被标成「注入后未确认接受」并存进信箱，而实际上已经送达。这种假阴性不能靠重投解决，重投会发两遍。判断办法：去对话里搜那条凭证，搜到就说明已到，把队列里那份删掉。

**Antigravity 新版输入框把换行当发送键。** 整段插入会在第一个换行处就地发送，后半截全丢。工具改成逐行插入、行间 Shift+Enter，插完比对字数，偏差超 2% 就中止而不是发半截。

**Codex 通道只能写不能读。** `codex queue` 没有读回复的子命令，回执只说「已入队」，不代表对方读过。回复要去 `%USERPROFILE%\.codex\sessions\YYYY\MM\DD\rollout-*-<线程id>.jsonl` 里翻。

**DSH 端口是随机的。** 桌面端用 `--port 0` 启动，每次都不一样，工具靠扫监听端口逐个探测。探测有缓存，但 DSH 重启后同一进程里的缓存会失效，需要重开一次命令。

**只支持 Windows。** 路径展开、CDP 端口文件、`.cmd` / `.ps1` 解析都是按 Windows 写的。核心逻辑不依赖平台，但没在 macOS / Linux 上测过。

**Codex / Claude 通道需要本机有 Node.js。** 这两个 CLI 的入口是 JavaScript，工具会去 PATH 里找 `node.exe` 来跑它们。exe 本身不依赖 Node，`dsh`、`antigravity`、`webhook` 三个通道也不需要。找不到 Node 时不会抛裸 `ENOENT`，会给一句人话说明缺什么、怎么补：装 Node.js（选 LTS），或把 `node.exe` 所在目录加进 PATH，或设环境变量 `BRIDGE_NODE` 指向它的完整路径。设了 `BRIDGE_NODE` 但路径不存在时，会直接指出这个变量指错了。

**CDP 连接有 8 秒硬超时。** Antigravity 握手挂起或调试端口被别的程序占着时，没有超时会让整个 flush 永久卡在这一条上，后面的消息都投不出去。现在连接超时与单次 CDP 调用超时（5 秒）都会明确报错，并说明是超时还是连接失败。两个阈值可用 `options.cdpConnectTimeoutMs` 和 `options.cdpCallTimeoutMs` 调。

**exe 未签名。** 88 MB，首次运行 SmartScreen 可能提示「未知发布者」，选「仍要运行」。自己构建也一样，除非买代码签名证书。

**消息正文上限默认 64 KB。** 超了会拒绝。长文档落文件让对方读，不要把几万字塞进一条消息。Codex 通道另有更低的上限：它的 queue 子命令只能把正文当命令行参数，Windows 整个命令行上限 32767 字符，所以工具在 26000 字符处就拒绝，避免被系统静默截断。

**控制台打印超长正文时会省略中段。** 超过 6000 字符只打头尾各一段，并注明省略了多少。发出的是完整正文，base64 往返校验保证了这点。

**中文在 PowerShell 5.1 里容易乱码。** 用 `--body-file` 比 `--text` 稳；配置和队列都是 UTF-8，用支持 UTF-8 的编辑器改。

## 从源码构建

```powershell
cd build
npm install
node build.mjs
```

产物在 `dist/agent-bridge.exe`。构建用 esbuild 打包成单文件 CJS，再用 Node SEA 注入 node.exe，不需要装打包器之外的东西。

## 已验证到什么程度

写这份文档时在 Windows 11 + Node 24 上实测过下列项目，数字是实测值不是估计：

| 项目 | 结果 |
|---|---|
| DSH 通道投递 | 成功，凭证出现在目标会话的 `user/message` 与 `agent/inbox/spliced` |
| Antigravity 通道投递 | 成功，多行正文 496 字原样落入 transcript 的 `USER_INPUT`（含 22 个换行与中英文引号） |
| Codex 通道投递 | 成功入队，回执只有「已入队」，符合单向写的已知限制 |
| 跨软件往返 | Gemini 收到后自行用 `relay.mjs` 回执，回执落到 DSH 桥接会话，双向闭环成立 |
| 单窗口判定 | 纯函数单测 11 条全过：目标在窗口列表里即可投、多窗口给警告不拒绝、大小写不敏感、空列表休眠 |
| 队列状态机 | 入队 → 目标不可达 → 补投失败回 pending → 收件归档 consumed，全流程通过 |
| 认领超时回收 | 把 `claimedAt` 回拨 10 分钟后，记录从 sending 转为 unconfirmed，未被盲目重投 |
| base64 校验 | 非法输入被拒绝，往返不一致被拒绝 |
| 摘要与正文上限 | 301 字摘要被拒，70 KB 正文被拒，codex 26k 字符被拒 |
| 停用 / blocked 语义 | 两者分别拦截并给出不同报错，`session on` 可恢复启用 |
| exe 封装 | 88.2 MB 单文件，`version`、`list`、`doctor`、`send` 均正常 |

**没有验证到的**：Claude 通道一次都没跑通（本机没装 Claude Code）；macOS / Linux 没跑过；Antigravity 的窗口未打开场景只验证了「转信箱」，没验证「切窗口后 flush 成功」。

## 测试与验收

自测时按这个顺序选目标，别拿正在干活的会话当靶子：

1. 自己的 bridge 会话（最安全，收发都看得见）。
2. 对端的 bridge 会话。
3. 实在没有 bridge 会话，才用 work，并加 `--i-know-its-work` 显式放行。

Codex 的 work 线程用高额度模型，每条消息都花钱，**测试只发 bridge**。Antigravity 目标没打开时只能走信箱，这正好可以用来验证排队与补投路径。

### 测试防呆

工具对这件事做了硬约束，不只写在文档里：

- `--test` 声明这是自测。带了这个标记，发往 `work` 类会话会被直接拒绝。
- 拦截范围由配置里 `testing.blockedCategories` 决定，默认 `["work"]`。要改成连 bridge 也拦，自己加进去。
- 真要发 work，加 `--i-know-its-work`，让「我知道这是 work」成为一个必须显式写出来的动作。

这条规则来自一次实际失误：测通道时图省事，拿唯一打开着的 work 会话当靶子，4 条自测消息直接灌进了正在干活的对话。

```powershell
# 正确：发对端 bridge
agent-bridge.exe send --to codex-bridge --test --summary "通道自测" --text ping

# 被拒：work 是干活的会话
agent-bridge.exe send --to dsh-work --test --summary "通道自测" --text ping
# 错误：拒绝把测试消息发进 dsh-work（类别 work）
```

## 隐私

这个仓库不含任何真实会话 id、账号、凭证或本机路径。`bridge.config.json`、`queue/`、`dist/` 都在 `.gitignore` 里。

`dist/agent-bridge.exe` 有 88 MB。GitHub 单文件上限 100 MB，能提交但不建议：仓库会被撑大，且每次重建都产生一个不可 delta 的二进制。推荐做法是仓库只放源码，exe 传到 Releases 里给下载链接；要直接提交也行，删掉 `.gitignore` 里 `dist/` 那一行。

发到 GitHub 前自己再扫一遍：`git status` 看有没有把配置提交上去。

`.dsh` 凭据文件只读 `secret` 一行，用来算本地 API 的 cookie，不写入任何队列或日志。

## 文件结构

```
agent-bridge/
  dist/agent-bridge.exe     打包产物
  src/                       源码
    main.mjs                 命令入口
    config.mjs               配置与目标解析
    core.mjs                 消息组装、投递、信箱状态机
    admin.mjs                init/list/doctor/session/quota
    adapters/
      dsh.mjs                DSH HTTP steer
      codex.mjs              Codex CLI queue
      antigravity.mjs        CDP 注入
      claude.mjs             Claude（实验性）
      webhook.mjs            通用 HTTP 出口
  skills/                    各软件 skill 包
  build/                     构建脚本与构建期依赖
  bridge.config.json        本地配置（不进仓库）
  queue/                     本地信箱（不进仓库）
```

## 许可

MIT
