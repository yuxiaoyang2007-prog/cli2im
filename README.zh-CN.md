# CLI2IM

[English](README.md) | 中文

**用你已经在用的 IM 驱动 Claude Code / Codex / Gemini / GLM。** 离开电脑了，项目不用停——掏出手机在飞书或 Telegram 里继续推，流式输出、tool use、slash 指令、一键 resume 任意本地 CLI 对话，全都有。

不是套壳聊天机器人。CLI2IM 跑的是你本来就在用的真实 CLI 二进制，保留全部能力，在上面加了一层 IM 控制面。

---

## 三大独门能力

### 1. 离开电脑也不用停项目

你用公司笔电跑了一上午 Claude Code 改重构，现在要赶高铁回家。以前只能等回家继续；CLI2IM 让你接着推：

- 在手机飞书/Telegram 里发 `/sessions`
- 弹出一张交互式列表——本机所有 Claude Code 和 Codex 对话，带标题、最后一条消息预览、工作目录、git 分支、时间
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
- 每个 bot 会读自己工作目录里的 **`AGENTS.md`**，把里面的设定带进每一次对话。人设就是这么来的：一个 bot 可以是带专属分流规则的能源研究助手，另一个可以是只能碰自己目录的隔离客户 bot。不写代码，一个 bot 一个文件。

所以一个守护进程能同时托管你自己的 Claude Code bot、同事的 Codex bot、还有一个上锁的客户 bot——各自行为不同，全靠 YAML 加 `AGENTS.md` 配出来。

### 3. IM 本来就是你的控制台——不用额外装 app

你的团队本来就在飞书。或者你每台设备都已经装好了 Telegram。CLI2IM 直接用现成的：

- **飞书**：WebSocket 实时事件（不用公网 IP、不用 webhook、不用端口转发）。交互式卡片一行一行流式更新。权限审批和会话恢复直接做成卡片按钮。语音消息走 DashScope 转文字；文字回复也能转成语音发出去。
- **Telegram**：长轮询（NAT 后面也能跑）。MarkdownV2 格式化。权限和恢复用内联键盘。语音 STT 支持。

对比那些"AI 桌面 app"（Cursor / Claude Desktop 之类的），它们要求每台设备装专门客户端；CLI2IM 骑在你和同事本来就在用的 IM 上。换设备？已经登录了。手机？已经配好了。要分享给同事？拉进群就行。

---

## 平台支持

| 平台 | 状态 | 说明 |
|---|---|---|
| **macOS**（Apple Silicon & Intel） | ✅ 完整支持 | 主要开发目标。用 LaunchAgent 跑常驻 |
| **Linux**（Ubuntu / Debian / Arch 等） | ✅ 完整支持 | 用 systemd unit 跑常驻 |
| **Windows 10 / 11** | ✅ 支持 | 工作目录路径接受 `C:\Users\...`（也接受其他盘符的 `Users\` 目录）。用 [NSSM](https://nssm.cc/) 跑成 Windows 服务，或挂计划任务 |

**前置条件**：
- Node.js >= 20（跨平台）
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
- **会话恢复**：扫描本地 CLI session（`~/.claude/`、`~/.codex/`），IM 里展示交互式列表，一键恢复任意对话
- **双向交接**：CLI 终端 ↔ IM bot 无缝交接——附带 `cli2im handoff` 命令行工具
- **每-bot 运行时设定**：每个 bot 读自己工作目录里的 `AGENTS.md`，注入到每一次对话——人设、分流规则、护栏，按 bot 区分，不写代码
- **语音支持**：语音消息转文字，文字回复转语音（DashScope）
- **安全**：用户白名单、工作目录校验、内容过滤、速率限制、危险命令拦截
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
| `/sessions` | 列出本地 CLI session，带交互式 Resume 按钮 |
| `/sessions codex` | 强制列出 Codex CLI session |
| `/resume <id>` | 按 ID 恢复指定 session |
| `/handoff` | 释放会话回 CLI 终端 |
| `/status` | 查看当前会话信息 |
| `/stop` | 优雅取消 (SIGTERM) |
| `/kill` | 强制终止 (SIGKILL) |
| `/cwd <path>` | 切换工作目录 |
| `/thinking` | 切换 thinking 可见性（飞书） |
| `/fast` | 切换快速/低推理模式 |
| `/model <name>` | 设置下次 spawn 的模型 |
| `/perm allow\|deny <id>` | 回复权限请求 |
| `/list` | 列出活跃 bot 会话 |

## 命令行工具

用于会话交接的 CLI：

```bash
# 把正在跑的 CLI session 交接到 IM bot
cli2im handoff --bot ccbot --session <uuid> --workdir ~/projects/myapp

# 查看守护进程状态
cli2im status
```

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
