# CLI2IM

[English](README.md) | 中文

把 CLI AI agent 接入即时通讯。在飞书或 Telegram 里打字，让 Claude Code / Codex / Gemini CLI 帮你写代码——流式输出、权限审批、会话恢复、双向交接，全都有。

给那些在家里服务器或开发机上跑 AI 编程 agent、想随时随地用手机继续驱动它们的开发者。

## 为什么做这个

Claude Code、Codex 这类 CLI agent 很强，但被钉在终端上。人一离开电脑，活就停了。CLI2IM 把 CLI 的完整体验——slash 指令、tool use、流式输出、session 管理——桥接到手机上的 IM，人走了活不停。

这不是聊天机器人框架。它 spawn 真实 CLI 二进制，保留 CLI 全部能力，在上面加了一层 IM 控制面。

## 功能

- **多 Agent**：Claude Code (SDK)、Codex (SDK)、Gemini CLI——插件架构，一个配置管所有
- **多平台**：飞书（WebSocket + 交互式卡片）和 Telegram（长轮询 + 内联键盘）
- **流式输出**：飞书实时卡片更新，Telegram 消息编辑，支持 thinking 可见性切换
- **权限审批**：危险命令检测（可配正则），交互式 Allow/Deny 按钮，会话级自动批准
- **会话恢复**：扫描本地 CLI session（`~/.claude/`、`~/.codex/`），IM 里展示交互式列表，一键恢复任意对话
- **双向交接**：CLI 终端 ↔ IM bot 无缝交接——附带 `cli2im handoff` 命令行工具
- **语音支持**：语音消息转文字，文字回复转语音（DashScope）
- **安全**：用户白名单、工作目录校验、内容过滤、速率限制、危险命令拦截
- **会话持久化**：SQLite 存储，空闲清理，状态追踪
- **多 Bot**：一个进程跑多个 bot——每个 bot 绑一个 agent 和一个 IM 平台

## 架构

```
飞书 / Telegram
       |
       | 消息进入
       v
  +-----------+     +------------------+     +------------------+
  |  适配器    |---->|  消息管线        |---->|  Agent 管理器    |
  +-----------+     |  鉴权            |     |  spawn / resume  |
       ^            |  限流            |     |  工具拦截        |
       |            |  指令解析        |     |  权限流程        |
       |            +------------------+     +--------+---------+
       |                                              |
       |            +------------------+              | stdin/stdout
       +------------|  Session Store   |              v
       |            |  (SQLite)        |     +------------------+
       |            +------------------+     |  CLI Agent       |
       |                                     |  (子进程)        |
       +------- 流式卡片 / 消息编辑 <--------+------------------+
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
node dist/daemon.mjs

# 或开发模式：
npm run dev
```

### 4. 部署为守护进程（macOS）

创建 LaunchAgent plist 让 CLI2IM 持续运行：

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
    <string>/path/to/cli2im/dist/daemon.mjs</string>
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

## 平台适配器

### 飞书

- WebSocket 实时事件（不需要 webhook 服务器）
- 交互式消息卡片，流式更新
- 卡片按钮：权限审批、会话恢复
- 文件/图片/音频 上传下载
- 群聊支持，@提及过滤

### Telegram

- 长轮询（不需要公网 IP）
- MarkdownV2 格式化
- 内联键盘按钮：权限审批、会话恢复
- 语音消息转写
- 图片/文档 上传下载

## 会话恢复流程

CLI2IM 的核心功能之一——用手机接续任何本地 CLI 对话：

```
用户在 IM 中发送 /sessions
       |
       v
CLI2IM 扫描 ~/.claude/projects/（或 ~/.codex/）
  - 读取 JSONL 对话文件
  - 提取标题、时间戳、git 分支
  - 按 entrypoint 过滤（仅 CLI/task 会话）
  - 合并活跃会话状态（idle/busy/stale）
       |
       v
发送交互式卡片/键盘，展示 session 列表
       |
       v
用户点击 "Resume" 按钮
       |
       v
CLI2IM 以 --resume <sessionId> 启动 agent
  - 从 scanner 解析正确的工作目录
  - 绑定到 IM 聊天进行流式输出
       |
       v
对话在 IM 中继续
```

## 渊源与致谢

CLI2IM 从零开始独立开发，但设计受到以下项目启发：

### [claude-to-im](https://github.com/op7418/Claude-to-IM)（op7418，MIT）

一个从 [CodePilot](https://github.com/op7418/CodePilot) 提取出来的宿主无关桥接库。claude-to-im 建立了通过 DI 接口将 Claude Code SDK 桥接到 IM 的核心模式。CLI2IM 研究了它的架构（适配器抽象、权限代理、投递层、流式预览），但采取了根本不同的路线：

| | claude-to-im | CLI2IM |
|---|---|---|
| **架构** | 库 + DI 接口——宿主需实现 ~30 个 BridgeStore 方法 | 独立守护进程——一个 YAML 配置，零集成代码 |
| **Agent** | 仅 Claude Code（通过 LLMProvider 接口） | Claude Code + Codex + Gemini CLI（插件系统） |
| **Agent 绑定** | SDK stream 消费 | spawn 真实 CLI 二进制，保留 CLI 全部能力 |
| **平台** | Telegram、Discord、飞书 | 飞书、Telegram（Discord 计划中） |
| **会话恢复** | 不支持 | 扫描本地 CLI session，交互式列表，一键恢复 |
| **交接** | 不支持 | 双向 CLI ↔ IM 交接，含 CLI 工具 |
| **流式** | 基于消息编辑 | 飞书：交互式卡片节流更新；Telegram：消息编辑 |
| **持久化** | 委托给宿主 (BridgeStore) | 内置 SQLite |

### CLI2IM 在 claude-to-im 范围之外的新增能力

- **多 Agent 插件系统**：不只是 Claude Code——Codex 和 Gemini CLI 走同一接口，每个插件声明自己的能力（流式 JSON、权限、恢复支持）
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
│   │   └── tool-gate.ts         # 危险命令检测
│   ├── platforms/
│   │   ├── feishu/
│   │   │   ├── adapter.ts       # 飞书 WebSocket 适配器
│   │   │   ├── cards.ts         # 流式卡片控制器
│   │   │   └── markdown.ts      # 飞书 markdown + 卡片构建
│   │   └── telegram/
│   │       ├── adapter.ts       # Telegram 轮询适配器
│   │       └── markdown.ts      # MarkdownV2 + session 文本
│   ├── session/
│   │   ├── store.ts             # SQLite 会话持久化
│   │   ├── queue.ts             # 每聊天消息队列
│   │   ├── cli-scanner.ts       # Claude Code session 扫描器
│   │   └── codex-scanner.ts     # Codex session 扫描器
│   ├── services/
│   │   ├── handoff.ts           # 会话交接服务
│   │   ├── server.ts            # HTTP API 服务器
│   │   └── speech.ts            # STT/TTS（DashScope）
│   ├── security/
│   │   ├── validators.ts        # 路径 + 输入校验
│   │   └── content-guard.ts     # 内容安全过滤
│   └── runtime/
│       └── callbacks.ts         # 按钮回调解析
├── cli/
│   └── cli2im.ts                # 交接 CLI 工具
├── tests/                       # 22 个测试文件，154 个测试
├── config.example.yaml
├── esbuild.config.mjs
└── tsconfig.json
```

## 开发

```bash
npm run dev          # tsx 运行（热重载）
npm test             # 跑全部 154 个测试
npm run typecheck    # TypeScript 类型检查
npm run build        # 打包到 dist/
```

## 环境要求

- Node.js >= 20
- 至少装一个 CLI agent（Claude Code、Codex 或 Gemini CLI）
- 飞书 App 或 Telegram Bot Token

## License

MIT
