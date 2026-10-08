# CLI2IM

[English](README.md) | 中文

**通过飞书或 Telegram 使用 Claude Code、Codex、Gemini、Antigravity、GLM 和 Kimi Work。** 每个机器人配置自己的使用者、项目和账号；手机可以继续获准使用的本地 CLI 对话。

不是套壳聊天机器人。CLI2IM 跑的是你本来就在用的真实 CLI 二进制，保留全部能力，在上面加了一层 IM 控制面。

---

## 三大独门能力

### 1. 离开电脑也不用停项目

你用公司笔电跑了一上午 Claude Code 改重构，现在要赶高铁回家。以前只能等回家继续；CLI2IM 让你接着推：

- 在手机飞书/Telegram 里发 `/sessions`
- 弹出该机器人支持且你获准查看的历史对话，带标题、工作目录、git 分支和时间
- 点你正在做的那条的 **Resume** 按钮
- Agent 用 `--resume <id>` 拉起来，绑定到这个 IM 聊天。流式输出进卡片，工具调用、权限审批、文件编辑——和在终端里完全一样

反向的也行：在 IM 里跑的会话，回到电脑前用 `/handoff`（或 `cli2im handoff` 命令行工具）把它**交还**给终端。

```
~/.claude/projects/*.jsonl  ◄────► IM 聊天 (飞书卡片 / TG 内联键盘)
                              /handoff
```

### 2. 各路 agent 装在一起，每个 bot 有自己的人设

CLI2IM 把 CLI agent 当作插件。一个 YAML 配置就能注册任意多个 bot，每个绑不同 agent、不同平台，全在同一个守护进程里跑：

- **Claude Code** 干推理重的活，**Codex** 写代码，**Gemini** 和 **Antigravity** 要速度时上，**GLM（ZCode）** 是国内友好的选择。每个 bot 单独挑 agent。
- 每个 bot 可以使用自己工作目录里的 **`AGENTS.md`**，说明任务习惯和项目规则。规则文本不提供文件隔离；严格隔离不同人员的数据，需要独立系统账户或真正受限的运行环境。

所以一个守护进程能同时托管你自己的 Claude Code bot、同事的 Codex bot、还有一个上锁的客户 bot——各自行为不同，全靠 YAML 加 `AGENTS.md` 配出来。

### 3. IM 本来就是你的控制台——不用额外装 app

你的团队本来就在飞书。或者你每台设备都已经装好了 Telegram。CLI2IM 直接用现成的：

- **飞书**：WebSocket 实时事件（不用公网 IP、不用 webhook、不用端口转发）。交互式卡片一行一行流式更新。权限审批和会话恢复直接做成卡片按钮。语音消息走 DashScope 转文字；文字回复也能转成语音发出去。
- **Telegram**：长轮询（NAT 后面也能跑）。MarkdownV2 格式化。权限和恢复用内联键盘。语音 STT 支持。

同事要使用机器人，需要把其用户 ID 加入对应机器人的名单。群聊还要满足群名单和 @ 提及规则；拉进群本身不会获得权限。

---

## 平台支持

| 平台 | 状态 | 说明 |
|---|---|---|
| **macOS**（Apple Silicon & Intel） | ✅ 完整支持 | 主要开发目标。用 LaunchAgent 跑常驻 |
| **Linux**（Ubuntu / Debian / Arch 等） | ✅ 完整支持 | 用 systemd unit 跑常驻 |
| **Windows 10 / 11** | ✅ 支持 | 工作目录路径接受 `C:\Users\...`（也接受其他盘符的 `Users\` 目录）。用 [NSSM](https://nssm.cc/) 跑成 Windows 服务，或挂计划任务 |

**前置条件**：
- 使用本版本代理保护时，需要 Node.js 24.14+（24 LTS）或 25.4+
- 至少装一个 CLI agent：[Claude Code](https://docs.anthropic.com/en/docs/claude-code) / [Codex CLI](https://github.com/openai/codex) / [Gemini CLI](https://github.com/google-gemini/gemini-cli)
- 飞书 app 或 Telegram bot token

CLI agent 自身（Claude Code / Codex / Gemini CLI）必须在你的平台上可用——具体平台支持见各 agent 官方文档。

## 架构

```
飞书 / Telegram
       │
       │ 消息进入
       ▼
  ┌───────────┐     ┌──────────────────┐     ┌──────────────────┐
  │  适配器   ├────►│  消息管线        ├────►│  Agent 管理器    │
  └───────────┘     │  - 鉴权          │     │  - spawn/resume  │
       ▲            │  - 限流          │     │  - 工具拦截      │
       │            │  - 指令解析      │     │  - 权限流程      │
       │            └──────────────────┘     └────────┬─────────┘
       │                                              │ stdin/stdout
       │                                              ▼
       │            ┌──────────────────┐     ┌──────────────────┐
       │◄───────────┤  Session Store   │     │  CLI Agent       │
       │            │  (SQLite)        │     │  (子进程)        │
       │            └──────────────────┘     └──────────────────┘
       │
       └─── 流式卡片 / 消息编辑
```

## 快速开始

### 1. 安装

```bash
git clone https://github.com/yuxiaoyang2007-prog/cli2im.git
cd cli2im
npm install
```

### 2. 配置

```bash
mkdir -p ~/.cli2im
cp config.example.yaml ~/.cli2im/config.yaml
# 编辑 config.yaml，填入 bot token 和用户 ID
```

详见[配置说明](#配置)。

### 3. 构建运行

```bash
npm run build
node dist/index.js

# 或开发模式：
npm run dev
```

### 4. 部署为守护进程

按你的平台选对应的小节。

#### macOS — LaunchAgent

存为 `~/Library/LaunchAgents/com.cli2im.bridge.plist`，然后 `launchctl load -w ~/Library/LaunchAgents/com.cli2im.bridge.plist`。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cli2im.bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/path/to/cli2im/dist/index.js</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLI2IM_CONFIG</key>
    <string>/path/to/.cli2im/config.yaml</string>
  </dict>
</dict>
</plist>
```

#### Linux — systemd 用户单元

存为 `~/.config/systemd/user/cli2im.service`，然后 `systemctl --user enable --now cli2im`。

```ini
[Unit]
Description=cli2im bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node /path/to/cli2im/dist/index.js
Restart=on-failure
RestartSec=5
Environment=CLI2IM_CONFIG=%h/.cli2im/config.yaml

[Install]
WantedBy=default.target
```

要做系统级部署，把文件放到 `/etc/systemd/system/cli2im.service`、命令去掉 `--user`、并在 `[Service]` 块里加 `User=youruser`。

#### Windows — NSSM（推荐）

装 [NSSM](https://nssm.cc/)，然后在管理员 PowerShell 里：

```powershell
nssm install cli2im "C:\Program Files\nodejs\node.exe" "C:\path\to\cli2im\dist\index.js"
nssm set cli2im AppEnvironmentExtra CLI2IM_CONFIG=C:\Users\YourName\.cli2im\config.yaml
nssm set cli2im AppDirectory C:\path\to\cli2im
nssm start cli2im
```

也可以用 PowerShell 计划任务或 `pm2`（跨平台进程管理器）跑。

## 完整功能列表

- **多 Agent**：Claude Code (SDK)、Codex (SDK)、Gemini CLI、Antigravity、GLM/ZCode——插件架构，一个配置管所有
- **多平台**：飞书（WebSocket + 交互式卡片）和 Telegram（长轮询 + 内联键盘）
- **流式输出**：飞书实时卡片更新，Telegram 消息编辑，支持 thinking 可见性切换
- **权限审批**：危险命令检测（可配正则），交互式 Allow/Deny 按钮，会话级自动批准
- **会话恢复**：扫描对应 AI 的本地历史，按当前聊天、明确共享的目录和管理员身份过滤；点击按钮时再次检查权限
- **双向交接**：CLI 终端 ↔ IM bot 无缝交接——附带 `cli2im handoff` 命令行工具
- **每-bot 运行时设定**：每个 bot 读自己工作目录里的 `AGENTS.md`，注入到每一次对话——人设、分流规则、护栏，按 bot 区分，不写代码
- **语音支持**：语音消息转文字，文字回复转语音（DashScope）
- **安全**：固定用户和群名单、历史访问检查、工作目录校验、可选内容检测、速率限制及危险命令审批；这些不等于操作系统隔离
- **会话持久化**：SQLite 存储，空闲清理，状态追踪
- **多 Bot**：一个进程跑多个 bot——每个 bot 绑一个 agent 和一个 IM 平台

## 配置

配置文件：`~/.cli2im/config.yaml`（或设 `CLI2IM_CONFIG` 环境变量）。

支持 `${ENV_VAR}` 引用环境变量。

```yaml
bots:
  ccbot:
    agent: claude-code           # agent 插件名
    platform: feishu             # feishu | telegram
    feishu:
      appId: ${FEISHU_APP_ID}
      appSecret: ${FEISHU_APP_SECRET}
    workingDirectory: ~/projects
    allowFrom:                   # 允许交互的用户 ID
      - ou_xxxx
    permissionMode: blacklist    # bypass | blacklist
    agentsFile: AGENTS.md        # 每-bot 运行时设定，每次对话都读
                                 #   (claude-code: 追加到系统提示；设 false 关掉)

  codexbot:
    agent: codex
    platform: telegram
    telegram:
      token: ${CODEX_TG_TOKEN}
    workingDirectory: ~/projects
    allowFrom:
      - "123456789"

agents:
  claude-code:
    binary: ~/.claude/local/claude
    defaultModel: claude-sonnet-4-20250514
    env:
      DISABLE_AUTOUPDATER: "1"
  codex:
    binary: ~/.codex/bin/codex
  gemini:
    binary: /opt/homebrew/bin/gemini
  zcode:                                 # GLM-5.2，经 ZCode app 包启动
    binary: /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs

session:
  maxActive: 64
  idleResetMinutes: 120
  dbPath: ~/.cli2im/cli2im.db

dangerousPatterns:               # 正则——匹配的命令需要手动批准
  - 'rm\s+(-[a-zA-Z]*f|.*--force).*\/'
  - 'git\s+push\s+.*--force'
  - 'sudo\s+'

streaming:
  intervalMs: 200                # 飞书卡片更新节流
  minDeltaChars: 30
  highWaterMark: 1048576

server:
  port: 3900
  host: 127.0.0.1
  token: ${CLI2IM_WEB_TOKEN}     # handoff API 认证

newMessageBehavior: queue        # queue | interrupt
```

## 指令

在 IM 聊天中输入：

| 指令 | 说明 |
|------|------|
| `/new` | 新建会话（终止当前 agent） |
| `/sessions` | 列出当前机器人支持且你获准查看的历史，点击恢复 |
| `/sessions codex` | 在 Codex 机器人中查看获准使用的 Codex 历史 |
| `/resume <id>` | 按 ID 恢复指定 session |
| `/handoff` | 释放会话回 CLI 终端 |
| `/status` | 控制卡片：模型、项目、任务状态和常用按钮 |
| `/stop` | 优先取消当前任务及尚未开始的排队消息 |
| `/kill` | 优先终止当前进程及尚未开始的排队消息 |
| `/cwd <path>` 或 `/cd <path>` | 切换到获准目录，下一条消息使用新对话 |
| `/projects` 或 `/projects <别名>` | 选择已配置项目或最近目录 |
| `/task` 或 `/task <名称>` | 列出／执行已配置的提示词快捷任务 |
| `/result [页码]` | 主动取回当前聊天／话题最近一次保存的结束结果，不重跑任务 |
| `/bots` 或 `/bots stop\|restart` | 管理员查看／停止／重启当前机器人 |
| `/doctor [页码]` | 管理员查看本地检查结果和外部服务清单；未验证项会明确标出 |
| `/thinking` | 切换 thinking 可见性（飞书） |
| `/fast` | 切换快速/低推理模式 |
| `/model <name>` | 设置下次 spawn 的模型 |
| `/perm allow\|deny <id>` | 回复权限请求 |
| `/list` | 列出活跃 bot 会话 |

`/model <名称>` 保存后在下次启动 AI 进程时生效；`/model default` 恢复默认。模型名能保存，不代表服务商已经验证该模型可用。正在执行任务时先等待完成，或使用 `/stop`。

`/task` 将配置好的文字交给当前 AI，不直接运行命令行脚本。AI 仍按自己的工具权限执行任务。停止一个机器人会中断它自己的任务；其他机器人继续运行。已停止的机器人无法接收 `/bots start`，需要从本机启动。

## 固定用户与数据边界

- `allowFrom` 是每个机器人的普通用户名单，空名单默认拒绝普通用户。`adminUsers` 单独指定管理员；管理员可管理当前机器人并查看同类 AI 的本机历史，应只填机器人的负责人。
- 群内仍检查用户身份。配置 `groupPolicy: allowlist` 与 `groupAllowFrom` 后，只在指定群工作；空群名单允许私聊、拒绝群聊。`requireMention: true` 要求群里 @ 机器人。
- 普通用户默认只能接续当前聊天／话题绑定的历史。`sessionRoots` 是**明确共享历史**的目录列表，会把这些目录下的同类 AI 历史开放给该机器人的获准用户；不应随手填整个个人目录。
- `workingDirectory`、项目别名、`AGENTS.md` 和环境变量过滤都不是文件系统沙箱。不同机器人共用系统账户时，保留完整工具权限的 AI 仍可能访问该账户能读到的文件。

详见 [完整配置示例](config.example.yaml)。机器人使用飞书工具时，为不同账号配置各自的 `larkCliConfigDir`，不要把多个用户的个人授权混在同一目录。

## 长期记忆

每个 Bot 可显式开启 `memory: true`，必须同时设置 `isolation.enabled: true`。CLI2IM 只保存通过命令提供的条目，不自动收录聊天或启用 agent 自动记忆；每个进程的首条消息和记忆变化后的下一条消息会带上结构化快照。记忆与隔离配置缺省时，保持原有行为。

```yaml
memory:
  dir: ~/.cli2im/memory
  people:
    alice: ["feishu:ccbot:ou_alice", "telegram:codexbot:123456789"]
```

`memory.people` 按 `<平台>:<Bot 名>:<用户 ID>` 填写，须引用已配置且平台匹配的 Bot。私聊默认按平台应用与用户分别保存，只有显式映射到同一个人时才跨 Bot／平台共享；同一身份不能映射给两个人。群记忆按群保存，群内话题共用，不使用发言人的私聊记忆。

| 命令 | 行为 |
|---|---|
| `/remember <文本>` | 新增条目，最多 2,000 字符；每个身份／群最多 200 条 |
| `/memory [页]` | 查看当前身份／群的条目 |
| `/memory edit <id> <文本>` | 修改并保留最多 20 个旧版本；下一条消息注入新快照 |
| `/memory history <id>` | 查看旧版本 |
| `/forget <id>` | 删除条目及全部版本，结束该身份／群跨 Bot、跨话题的运行中会话，并取消相关排队任务 |

`/memory edit` 后旧文本仍可能留在当前对话上下文中，需彻底清除可用 `/new`。`/forget` 后下一条消息开启新会话：旧会话记录保留，但不再使用，也不允许该身份续接。群记忆仅创建者（含映射到同一人的身份）或该 Bot 的 `adminUsers` 可修改／删除。备份目录中的历史副本不受程序管理，也不会随 `/forget` 删除。

## 共享 Bot 隔离

隔离目前要求 macOS，仅支持 `claude-code` 与 `codex`，agy 等其他 agent 不支持。设置 `isolation.enabled: true`，用绝对路径填写 `isolation.readable`（只读）和 `isolation.writable`（读写），并为 `allowFrom ∪ adminUsers` 中每人配置 `userOverrides` 工作区。不同执行范围的工作区不得重叠。禁止 `allowPublic: true`、`allowFrom: ['*']` 和 `mcpServers`。注释示例见 [config.example.yaml](config.example.yaml)。

私聊使用个人 override 工作区；同一 Bot 的所有群聊共用 Bot 级 `workingDirectory`：**这些群的对话可互相看到工作区文件**，群记忆则各自独立。工作区和可写授予需避开记忆、CLI2IM 数据／安装目录及插件目录。`larkCliConfigDir` 不会自动获得访问授权，须显式列入 `isolation.writable`，这等于授予该 lark-cli 账户能力。隔离子进程的 `PATH` 会在拒绝空项、相对路径及 `.`／`..` 段后，按原生路径解析重写为真实目录并丢弃不存在或非目录项；结果为空或与可写目录、收件目录相等或互为包含（macOS 上忽略大小写）时判为不支持隔离，重写后的 PATH 统一用于启动、续接、后续轮次、检查与策略指纹。

`plugins` 与可选的 `skills` 白名单仅用于 Claude。插件目录须由本人维护、位于可写区域之外，且只含 skills，不得含 hooks、MCP、agents、commands 或 LSP 定义。桥接层不为隔离 Bot 读取工作区默认 `AGENTS.md`；显式 `agentsFile` 必须是所有 Bot 可写区域之外的绝对路径。子进程环境中存在模型供应商凭据变量时会拒绝启动，应使用 CLI 自身登录存储。

守护进程启动及 agent 可执行文件变化时自动检查，使用本地脚本化模型，不调用付费模型。可在本机运行 `cli2im doctor isolation [--config <path>]`（无需守护进程），或由管理员在 IM 中运行 `/doctor`，重新检查并查看结果。结果默认保存在 `~/.cli2im/isolation/verification.json`。执行范围没有当前有效的 `VERIFIED` 记录时，禁止启动／续接，回复“隔离检查未通过，已暂停执行，请管理员查看 /doctor”。检查失败还会结束该 Bot 正在运行的隔离 agent；控制、诊断和记忆命令仍可使用。

每个隔离 Codex Bot 使用独立的 `CODEX_HOME`：`<dataDir>/codex-home/<Bot 名 sha256 十六进制前 16 位>`。`dataDir` 默认为 `~/.cli2im`，可由 `CLI2IM_DATA_DIR` 指定。部署时需本人为每个 Bot 用个人 Codex 账户登录一次：

```bash
bot_name='codexbot' # 与配置中的 Bot 名完全一致，哈希输入不带换行
bot_hash=$(printf %s "$bot_name" | shasum -a 256 | cut -c1-16)
data_dir="${CLI2IM_DATA_DIR:-$HOME/.cli2im}"
CODEX_HOME="$data_dir/codex-home/$bot_hash" codex login
```

已知限制：共享 Claude Bot 无内置文件工具，文件操作只经沙箱内 Bash；Claude 沙箱内置保护 `.git/config`、`.git/hooks`，因此不能 `git init`／`git clone`。不支持 MCP。隔离 Codex Bot 关闭子代理与目标管理，不自动回传共享生成图片目录中的图片。隔离 Bot 的 `/sessions` 仅列出当前隔离域内符合续接条件的会话，不扫描个人桌面历史，也不支持 handoff。

回滚时可停用受影响 Bot 或恢复已验证版本。**关闭 isolation 会恢复无限制执行，只应在去除非本人用户后进行。**

## 代理、语音与恢复

macOS 可使用 `network.mode: system` 跟随系统 HTTP/HTTPS 代理；Linux/Windows 使用 `environment` 模式读取代理环境变量。`required: true` 下，代理失效时停止联网任务，不自动改成直连；直连例外只允许本机地址。应用设置不会替代系统 TUN、防火墙或 DNS 防漏规则，忽略代理的工具和系统 DNS 仍需单独验证。

每个机器人分别设置 `speech.stt`（语音转文字）和 `speech.tts`（文字转语音）。DashScope 会收到对应的完整语音或回复文字；不使用的功能可以关闭。DeepSeek、MiniMax 等域名仅出现在代理例外名单中，不表示 cli2im 正在调用这些服务。

恢复缓存保存最近一次任务结束时的回复文字，可能包含私人信息；它不是脱敏副本。目录／文件使用 `700`／`600` 权限，相同系统账户仍能读取。`/result` 只在用户主动请求时取回；程序重启不会自动重做任务或重复补发。详见 [外部服务与本地数据说明](docs/service-inventory.md)。

## 命令行工具

用于会话交接的 CLI：

```bash
# 把正在跑的 CLI session 交接到 IM bot
cli2im handoff --bot ccbot --session <uuid> --workdir ~/projects/myapp

# 查看守护进程状态
cli2im status

# 需要已有的 CLI2IM_WEB_TOKEN；值不要写进命令行或聊天
cli2im bots
cli2im bots stop ccbot
cli2im bots start ccbot
cli2im bots restart ccbot
cli2im doctor
```

这些命令作用于本机已经运行的服务。修改源码或通过测试并不代表已经完成部署；更新前备份配置、数据库和上一版构建，再按自己的运行方式重启并验证。

在运行服务的同一目录中验证更新时，使用 `CLI2IM_BUILD_DIR=dist-candidate npm run build`。这会把主程序、CLI、通知钩子和插件钩子写入候选目录，避免覆盖正在运行的 `dist` 和插件构建；它不会部署或重启服务。

## Agent 插件

| Agent | SDK | 流式 | 权限 | 恢复 | 备注 |
|-------|-----|------|------|------|------|
| Claude Code | @anthropic-ai/claude-agent-sdk | JSON 流 | 交互式审批 | 支持 | 主力 agent，SDK 原生 |
| Codex | @openai/codex-sdk | 文本 | 无 | 支持 | 可选依赖 |
| Gemini | 二进制 spawn | JSON 流 | 无 | 不支持 | spawn gemini CLI |
| Antigravity (agy) | 二进制 spawn | JSON 流 | 无 | 支持 | spawn `agy`（Google Antigravity）CLI |
| GLM / ZCode | JSON-RPC app-server | 流式 | 交互式审批 | 支持 | GLM-5.2，经 ZCode app 包 |

## 平台适配器

### 飞书

- WebSocket 实时事件（不需要 webhook 服务器）
- 交互式消息卡片，流式更新
- 卡片按钮：权限审批、会话恢复
- 文件/图片/音频上传下载
- 群聊支持，@提及过滤

### Telegram

- 长轮询（不需要公网 IP）
- MarkdownV2 格式化
- 内联键盘按钮：权限审批、会话恢复
- 语音消息转写
- 图片/文档上传下载

## 会话恢复流程

```
用户在 IM 中发送 /sessions
       │
       ▼
CLI2IM 扫描 ~/.claude/projects/（或 ~/.codex/）
  - 读取 JSONL 对话文件
  - 提取标题、时间戳、git 分支
  - 按 entrypoint 过滤（仅 CLI/task 会话）
  - 合并活跃会话状态（idle/busy/stale）
       │
       ▼
发送交互式卡片/键盘，展示 session 列表
       │
       ▼
用户点击 "Resume" 按钮
       │
       ▼
CLI2IM 以 --resume <sessionId> 启动 agent
  - 从 scanner 解析正确的工作目录
  - 绑定到 IM 聊天进行流式输出
       │
       ▼
对话在 IM 中继续
```

## 渊源与致谢

CLI2IM 从零开始独立开发，但设计受到以下项目启发：

### [claude-to-im](https://github.com/op7418/Claude-to-IM)（op7418，MIT）

一个从 [CodePilot](https://github.com/op7418/CodePilot) 提取出来的宿主无关桥接库。claude-to-im 建立了通过 DI 接口将 Claude Code SDK 桥接到 IM 的核心模式。CLI2IM 研究了它的架构（适配器抽象、权限代理、投递层、流式预览），但采取了根本不同的路线：

| | claude-to-im | CLI2IM |
|---|---|---|
| **架构** | 库 + DI 接口——宿主需实现 ~30 个 BridgeStore 方法 | 独立守护进程——一个 YAML 配置，零集成代码 |
| **Agent** | 仅 Claude Code（通过 LLMProvider 接口） | Claude Code + Codex + Gemini + Antigravity + GLM（插件系统） |
| **Agent 绑定** | SDK stream 消费 | spawn 真实 CLI 二进制，保留 CLI 全部能力 |
| **平台** | Telegram、Discord、飞书 | 飞书、Telegram（Discord 计划中） |
| **会话恢复** | 不支持 | 扫描本地 CLI session，交互式列表，一键恢复 |
| **交接** | 不支持 | 双向 CLI ↔ IM 交接，含 CLI 工具 |
| **每-bot 人设** | 不支持 | 每个 bot 带自己的 `AGENTS.md` 运行时设定 |
| **流式** | 基于消息编辑 | 飞书：交互式卡片节流更新；Telegram：消息编辑 |
| **持久化** | 委托给宿主 (BridgeStore) | 内置 SQLite |

### CLI2IM 在 claude-to-im 范围之外的新增能力

- **多 Agent 插件系统**：Codex、Gemini CLI、Antigravity、GLM/ZCode 走和 Claude Code 同一接口，每个插件声明自己的能力
- **每-bot 运行时设定**：每个 bot 读自己工作目录里的 `AGENTS.md`，注入到每一次对话——人设、分流规则、护栏，按 bot 区分，不写代码
- **CLI Session 扫描**：读取 `~/.claude/projects/` JSONL 文件和 `~/.codex/session_index.jsonl`，从对话数据提取标题，IM 中展示交互式 session 列表
- **双向交接**：`cli2im handoff` CLI 工具 + HTTP API + IM `/handoff` 指令，实现 CLI ↔ IM 无缝 session 转移
- **飞书交互式卡片**：丰富的卡片 UI，流式更新，thinking 开关，权限按钮，带 Resume 动作的 session 列表
- **Telegram 内联键盘**：session 恢复按钮、权限审批，全部在 Telegram 64 字节 callback_data 限制内实现
- **语音支持**：语音消息 STT，文字回复 TTS
- **内容安全过滤**：可插拔的 content-guard 集成
- **危险命令拦截**：可配正则拦截危险 shell 命令，通过 IM 按钮要求用户明确批准

## 项目结构

```
cli2im/
├── src/
│   ├── index.ts                 # 守护进程入口
│   ├── types.ts                 # 全部 TypeScript 接口
│   ├── pipeline.ts              # 入站消息处理管线
│   ├── media.ts                 # 文件/图片/音频处理
│   ├── agents/
│   │   ├── manager.ts           # Agent 生命周期管理
│   │   ├── claude-code.ts       # Claude Code SDK 插件
│   │   ├── codex.ts             # Codex SDK 插件
│   │   ├── gemini.ts            # Gemini CLI 插件
│   │   ├── agy.ts               # Antigravity (agy) 插件
│   │   ├── zcode.ts             # GLM-5.2 (ZCode) 插件
│   │   └── tool-gate.ts         # 危险命令检测
│   ├── platforms/
│   │   ├── feishu/              # 飞书适配器、卡片、markdown
│   │   └── telegram/            # Telegram 适配器、MarkdownV2
│   ├── session/
│   │   ├── store.ts             # SQLite 会话持久化
│   │   ├── queue.ts             # 每聊天消息队列
│   │   ├── cli-scanner.ts       # Claude Code session 扫描器
│   │   └── codex-scanner.ts     # Codex session 扫描器
│   ├── services/
│   │   ├── handoff.ts           # 会话交接服务
│   │   ├── server.ts            # HTTP API 服务器
│   │   └── speech.ts            # STT/TTS（DashScope）
│   ├── security/                # 校验器、内容安全
│   └── runtime/                 # 按钮回调解析
├── cli/
│   └── cli2im.ts                # 交接 CLI 工具
├── tests/                       # 46 个测试文件，458 个测试
├── config.example.yaml
├── esbuild.config.mjs
└── tsconfig.json
```

## 开发

```bash
npm run dev          # tsx 运行（热重载）
npm test             # 跑全部 458 个测试
npm run typecheck    # TypeScript 类型检查
npm run build        # 打包到 dist/
```

## 贡献

开发环境 setup、测试、PR 规范见 [CONTRIBUTING.md](CONTRIBUTING.md)（英文）。

## License

MIT
