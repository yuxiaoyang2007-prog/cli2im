# CLI2IM

English | [中文](README.zh-CN.md)

Control CLI-based AI agents through instant messaging. Type in Feishu or Telegram, get Claude Code / Codex / Gemini CLI working on your projects — with streaming output, permission gating, session resume, and bidirectional handoff.

Built for developers who run AI coding agents on a home server or dev machine and want to keep driving them from a phone or any device with an IM client.

## Why

CLI agents like Claude Code and Codex are powerful but tethered to a terminal. You leave your desk, the work stops. CLI2IM solves this by bridging the full CLI experience — slash commands, tool use, streaming output, session persistence — to IM platforms you already have on your phone.

This is not a chatbot framework. It spawns real CLI binaries, preserves their full capabilities, and adds an IM control plane on top.

## Features

- **Multi-agent**: Claude Code (SDK), Codex (SDK), Gemini CLI — pluggable architecture, one config to manage all
- **Multi-platform**: Feishu/Lark (WebSocket + interactive cards) and Telegram (long polling + inline keyboards)
- **Streaming output**: Real-time card updates on Feishu, message edits on Telegram, with thinking block visibility toggle
- **Permission gating**: Dangerous command detection (configurable regex patterns), interactive Allow/Deny buttons, session-level auto-approve
- **Session resume**: Scan local CLI sessions (`~/.claude/`, `~/.codex/`), display interactive picker in IM, one tap to resume any conversation
- **Bidirectional handoff**: Move a session from CLI terminal to IM bot and back — `cli2im handoff` CLI tool included
- **Voice support**: Speech-to-text transcription for voice messages, text-to-speech for responses (DashScope)
- **Security**: User allowlists, working directory validation, content filtering ([content-guard](https://github.com/user/content-guard)), rate limiting, dangerous pattern blocking
- **Session persistence**: SQLite-backed session store with idle cleanup and state tracking
- **Multi-bot**: Run multiple bots in one process — each bot binds to one agent and one IM platform

## Architecture

```
Feishu / Telegram
       |
       | InboundMessage
       v
  +-----------+     +------------------+     +------------------+
  |  Adapter   |---->|  Pipeline        |---->|  Agent Manager   |
  +-----------+     |  auth gate       |     |  spawn / resume  |
       ^            |  rate limit      |     |  tool gate       |
       |            |  command parse   |     |  permission flow |
       |            +------------------+     +--------+---------+
       |                                              |
       |            +------------------+              | stdin/stdout
       +------------|  Session Store   |              v
       |            |  (SQLite)        |     +------------------+
       |            +------------------+     |  CLI Agent       |
       |                                     |  (subprocess)    |
       +------ streaming cards / edits <-----+------------------+
```

## Quick Start

### 1. Install

```bash
git clone https://github.com/yuxiaoyang2007-prog/cli2im.git
cd cli2im
npm install
```

### 2. Configure

```bash
mkdir -p ~/.cli2im
cp config.example.yaml ~/.cli2im/config.yaml
# Edit config.yaml — fill in bot tokens and user IDs
```

See [Configuration](#configuration) for all options.

### 3. Build and Run

```bash
npm run build
node dist/daemon.mjs

# Or run in development mode:
npm run dev
```

### 4. Deploy as a Daemon (macOS)

Create a LaunchAgent plist to keep CLI2IM running:

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

## Configuration

Config file: `~/.cli2im/config.yaml` (or set `CLI2IM_CONFIG` env var).

Supports `${ENV_VAR}` interpolation for secrets.

```yaml
bots:
  ccbot:
    agent: claude-code           # agent plugin name
    platform: feishu             # feishu | telegram
    feishu:
      appId: ${FEISHU_APP_ID}
      appSecret: ${FEISHU_APP_SECRET}
    workingDirectory: ~/projects
    allowFrom:                   # user IDs allowed to interact
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

dangerousPatterns:               # regex — matched commands require approval
  - 'rm\s+(-[a-zA-Z]*f|.*--force).*\/'
  - 'git\s+push\s+.*--force'
  - 'sudo\s+'

streaming:
  intervalMs: 200                # Feishu card update throttle
  minDeltaChars: 30
  highWaterMark: 1048576

server:
  port: 3900
  host: 127.0.0.1
  token: ${CLI2IM_WEB_TOKEN}     # auth for handoff API

newMessageBehavior: queue        # queue | interrupt
```

## Commands

Type these in any connected IM chat:

| Command | Description |
|---------|-------------|
| `/new` | Start a new session (terminates current agent) |
| `/sessions` | List CLI sessions with interactive Resume buttons |
| `/sessions codex` | Force list Codex CLI sessions |
| `/resume <id>` | Resume a specific agent session by ID |
| `/handoff` | Release session back to CLI terminal |
| `/status` | Show current session info |
| `/stop` | Graceful cancel (SIGTERM) |
| `/kill` | Force terminate (SIGKILL) |
| `/cwd <path>` | Change working directory |
| `/thinking` | Toggle thinking block visibility (Feishu) |
| `/fast` | Toggle fast/low-reasoning mode |
| `/model <name>` | Set model for next agent spawn |
| `/perm allow\|deny <id>` | Respond to a permission request |
| `/list` | List active bot sessions |

## CLI Tool

A companion CLI for session handoff:

```bash
# Transfer a running CLI session to the IM bot
cli2im handoff --bot ccbot --session <uuid> --workdir ~/projects/myapp

# Check daemon status
cli2im status
```

## Agent Plugins

| Agent | SDK | Stream | Permissions | Resume | Notes |
|-------|-----|--------|-------------|--------|-------|
| Claude Code | @anthropic-ai/claude-agent-sdk | JSON streaming | Interactive approval | Full | Primary agent, SDK-native |
| Codex | @openai/codex-sdk | Text | N/A | Full | Optional dependency |
| Gemini | Binary spawn | JSON streaming | N/A | N/A | Spawns `gemini` CLI binary |

## Platform Adapters

### Feishu/Lark

- WebSocket real-time events (no webhook server needed)
- Interactive message cards with streaming updates
- Card action buttons for permissions and session resume
- File/image/audio upload and download
- Group chat support with mention filtering

### Telegram

- Long polling (no public IP needed)
- MarkdownV2 formatting
- Inline keyboard buttons for permissions and session resume
- Voice message transcription
- Photo/document upload and download

## Session Resume Flow

One of CLI2IM's key features — pick up any local CLI conversation from your phone:

```
User sends /sessions in IM
       |
       v
CLI2IM scans ~/.claude/projects/ (or ~/.codex/)
  - Reads JSONL conversation files
  - Extracts titles, timestamps, git branches
  - Filters by entrypoint (CLI/task sessions only)
  - Merges active session status (idle/busy/stale)
       |
       v
Sends interactive card/keyboard with session list
       |
       v
User taps "Resume" button
       |
       v
CLI2IM spawns agent with --resume <sessionId>
  - Resolves correct working directory from scanner
  - Binds to IM chat for streaming output
       |
       v
Conversation continues in IM
```

## Lineage and Credits

CLI2IM was built from scratch as a standalone project, but its design was informed by two prior works:

### [claude-to-im](https://github.com/op7418/Claude-to-IM) (by op7418, MIT)

A host-agnostic bridge library extracted from [CodePilot](https://github.com/op7418/CodePilot). Claude-to-im established the core pattern of bridging Claude Code SDK to IM platforms with DI-based host interfaces. CLI2IM studied its architecture (adapter abstraction, permission broker, delivery layer, streaming previews) but took a fundamentally different approach:

| | claude-to-im | CLI2IM |
|---|---|---|
| **Architecture** | Library with DI interfaces — host app must implement ~30 BridgeStore methods | Standalone daemon — single YAML config, zero integration code |
| **Agent support** | Claude Code only (via LLMProvider interface) | Claude Code + Codex + Gemini CLI (plugin system) |
| **Agent binding** | SDK stream consumption | Spawns real CLI binaries, preserves full CLI capabilities |
| **Platforms** | Telegram, Discord, Feishu | Feishu, Telegram (Discord planned) |
| **Session resume** | Not supported | Scan local CLI sessions, interactive picker, one-tap resume |
| **Handoff** | Not supported | Bidirectional CLI ↔ IM handoff with CLI tool |
| **Streaming** | Message edit based | Feishu: interactive cards with throttled updates; Telegram: message edits |
| **Persistence** | Delegated to host (BridgeStore) | Built-in SQLite |

### Key additions in CLI2IM beyond claude-to-im's scope

- **Multi-agent plugin system**: Not just Claude Code — Codex and Gemini CLI work through the same interface, with agent-specific capabilities (stream JSON, permissions, resume support) declared per plugin
- **CLI session scanning**: Read `~/.claude/projects/` JSONL files and `~/.codex/session_index.jsonl`, extract titles from conversation data, display interactive session picker in IM
- **Bidirectional handoff**: `cli2im handoff` CLI tool + HTTP API + IM `/handoff` command for seamless CLI ↔ IM session transfer
- **Feishu interactive cards**: Rich card UI with streaming updates, thinking block toggle, permission buttons, session list with Resume actions
- **Telegram inline keyboards**: Session resume buttons, permission approval, all within Telegram's 64-byte callback_data constraint
- **Voice support**: STT for voice messages, TTS for responses
- **Content guard integration**: Pluggable content safety filtering
- **Dangerous command gating**: Configurable regex patterns block hazardous shell commands, require explicit user approval via IM buttons

## Project Structure

```
cli2im/
├── src/
│   ├── index.ts                 # Main daemon entry point
│   ├── types.ts                 # All TypeScript interfaces
│   ├── pipeline.ts              # Inbound message processing
│   ├── media.ts                 # File/image/audio handling
│   ├── agents/
│   │   ├── manager.ts           # Agent lifecycle management
│   │   ├── claude-code.ts       # Claude Code SDK plugin
│   │   ├── codex.ts             # Codex SDK plugin
│   │   ├── gemini.ts            # Gemini CLI plugin
│   │   └── tool-gate.ts         # Dangerous command detection
│   ├── platforms/
│   │   ├── feishu/
│   │   │   ├── adapter.ts       # Feishu WebSocket adapter
│   │   │   ├── cards.ts         # Streaming card controller
│   │   │   └── markdown.ts      # Feishu markdown + card builder
│   │   └── telegram/
│   │       ├── adapter.ts       # Telegram polling adapter
│   │       └── markdown.ts      # MarkdownV2 + session text
│   ├── session/
│   │   ├── store.ts             # SQLite session persistence
│   │   ├── queue.ts             # Per-chat message queue
│   │   ├── cli-scanner.ts       # Claude Code session scanner
│   │   └── codex-scanner.ts     # Codex session scanner
│   ├── services/
│   │   ├── handoff.ts           # Session handoff service
│   │   ├── server.ts            # HTTP API server
│   │   └── speech.ts            # STT/TTS (DashScope)
│   ├── security/
│   │   ├── validators.ts        # Path + input validation
│   │   └── content-guard.ts     # Content safety filtering
│   └── runtime/
│       └── callbacks.ts         # Button callback parsing
├── cli/
│   └── cli2im.ts                # Handoff CLI tool
├── tests/                       # 22 test files, 154 tests
├── config.example.yaml
├── esbuild.config.mjs
└── tsconfig.json
```

## Development

```bash
npm run dev          # Run with tsx (hot reload)
npm test             # Run all 154 tests
npm run typecheck    # TypeScript type check
npm run build        # Bundle to dist/
```

## Requirements

- Node.js >= 20
- At least one CLI agent installed (Claude Code, Codex, or Gemini CLI)
- A Feishu app or Telegram bot token

## License

MIT
