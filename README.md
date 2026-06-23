# CLI2IM

English | [中文](README.zh-CN.md)

**Run Claude Code / Codex / Gemini / GLM from any IM app you already have.** When you walk away from your desk, the project doesn't stop — pick it up on your phone in Feishu or Telegram, with full streaming output, tool use, slash commands, and one-tap session resume.

This is not a chatbot. CLI2IM spawns the real CLI binaries you already use, preserves all their capabilities, and adds an IM control plane on top.

---

## Three Killer Features

### 1. Leave your desk, the project keeps moving

You spent the morning at your work laptop driving Claude Code through a refactor. Now you're heading to the airport. With CLI2IM, you don't lose the thread:

- Type `/sessions` in Feishu/Telegram from your phone
- An interactive list pops up — every local Claude Code or Codex conversation, with title, last message preview, working directory, git branch, and time
- Tap **Resume** on the one you were working on
- The agent boots back up with `--resume <id>`, bound to the IM chat. Streaming output flows into the card. Tool calls, permission prompts, file edits — all work exactly as on the terminal

Bidirectional handoff also works the other way: hand a session running in IM **back** to your terminal with `/handoff` (or the `cli2im handoff` CLI tool) when you sit back down at your computer.

```
~/.claude/projects/*.jsonl  ◄────► IM chat (Feishu card / TG inline keyboard)
                             /handoff
```

### 2. Every coding agent in one place, each with its own persona

CLI2IM treats CLI agents as plugins. One YAML config registers as many bots as you want — each tied to a different agent on a different platform, all running as siblings in one daemon:

- **Claude Code** for reasoning-heavy work, **Codex** for coding, **Gemini** and **Antigravity** when you want speed, **GLM (ZCode)** as a China-friendly option. Pick the agent per bot.
- Each bot reads an **`AGENTS.md`** in its working directory and carries those instructions into every conversation. That's how a bot gets a persona: one bot can be your energy-research assistant with its own routing rules; another can be a locked-down client bot that only touches its own folder. No code — just a file per bot.

So a single daemon can host your personal Claude Code bot, a teammate's Codex bot, and a sandboxed client bot at the same time, each behaving differently, configured entirely through YAML plus `AGENTS.md`.

### 3. Your IM is already the control plane — no extra app to install

Your team already lives in Feishu. Or you already have Telegram on every device. CLI2IM uses what's there:

- **Feishu**: WebSocket real-time events (no public IP, no webhook, no port forwarding). Interactive cards stream output line by line. Permission prompts and session resume show up as native card buttons. Voice messages get transcribed via DashScope; text replies can be sent back as voice.
- **Telegram**: Long polling (works behind any NAT). MarkdownV2 formatting. Inline keyboards for permissions and resume. Voice STT supported.

Compared to "AI desktop apps" (Cursor / Claude Desktop / etc.) that demand a specific client on every device, CLI2IM rides on top of the IM you and your team already have. New device? Already signed in. Phone? Already configured. Sharing with a teammate? Just add them to the group.

---

## Platform Support

| Platform | Status | Notes |
|---|---|---|
| **macOS** (Apple Silicon & Intel) | ✅ Fully supported | Primary development target. Use LaunchAgent to run as daemon. |
| **Linux** (Ubuntu / Debian / Arch / etc.) | ✅ Fully supported | Use systemd unit to run as daemon. |
| **Windows 10 / 11** | ✅ Supported | Working directory paths accept `C:\Users\...` (and other drives' `Users\` dirs). Run as a Windows Service via [NSSM](https://nssm.cc/) or as a scheduled task. |

**Requirements**:
- Node.js >= 20 (cross-platform)
- At least one CLI agent installed: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://github.com/openai/codex), or [Gemini CLI](https://github.com/google-gemini/gemini-cli)
- A Feishu app or Telegram bot token

The CLI agents themselves (Claude Code / Codex / Gemini CLI) must be available on your platform — refer to each agent's official docs for platform support.

## Architecture

```
Feishu / Telegram
       │
       │ InboundMessage
       ▼
  ┌───────────┐     ┌──────────────────┐     ┌──────────────────┐
  │  Adapter  ├────►│  Pipeline        ├────►│  Agent Manager   │
  └───────────┘     │  - auth gate     │     │  - spawn/resume  │
       ▲            │  - rate limit    │     │  - tool gate     │
       │            │  - cmd parse     │     │  - permission    │
       │            └──────────────────┘     └────────┬─────────┘
       │                                              │ stdin/stdout
       │                                              ▼
       │            ┌──────────────────┐     ┌──────────────────┐
       │◄───────────┤  Session Store   │     │  CLI Agent       │
       │            │  (SQLite)        │     │  (subprocess)    │
       │            └──────────────────┘     └──────────────────┘
       │
       └─── streaming cards / message edits
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
node dist/index.js

# Or run in development mode:
npm run dev
```

### 4. Deploy as a Daemon

Pick the section for your platform.

#### macOS — LaunchAgent

Save as `~/Library/LaunchAgents/com.cli2im.bridge.plist`, then `launchctl load -w ~/Library/LaunchAgents/com.cli2im.bridge.plist`.

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

#### Linux — systemd user unit

Save as `~/.config/systemd/user/cli2im.service`, then `systemctl --user enable --now cli2im`.

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

For system-wide deployment, place under `/etc/systemd/system/cli2im.service`, drop `--user` from the commands, and add `User=youruser` in the `[Service]` block.

#### Windows — NSSM (recommended)

Install [NSSM](https://nssm.cc/), then in an Administrator PowerShell:

```powershell
nssm install cli2im "C:\Program Files\nodejs\node.exe" "C:\path\to\cli2im\dist\index.js"
nssm set cli2im AppEnvironmentExtra CLI2IM_CONFIG=C:\Users\YourName\.cli2im\config.yaml
nssm set cli2im AppDirectory C:\path\to\cli2im
nssm start cli2im
```

Alternatively, run with PowerShell scheduled task or `pm2` (cross-platform process manager).

## Full Feature List

- **Multi-agent**: Claude Code (SDK), Codex (SDK), Gemini CLI, Antigravity, and GLM/ZCode — pluggable architecture, one config to manage all
- **Multi-platform**: Feishu/Lark (WebSocket + interactive cards) and Telegram (long polling + inline keyboards)
- **Streaming output**: Real-time card updates on Feishu, message edits on Telegram, with thinking block visibility toggle
- **Permission gating**: Dangerous command detection (configurable regex patterns), interactive Allow/Deny buttons, session-level auto-approve
- **Session resume**: Scan local CLI sessions (`~/.claude/`, `~/.codex/`), display interactive picker in IM, one tap to resume any conversation
- **Bidirectional handoff**: Move a session from CLI terminal to IM bot and back — `cli2im handoff` CLI tool included
- **Per-bot runtime instructions**: Each bot reads an `AGENTS.md` from its working directory and injects it into every conversation — per-bot personas, routing rules, and guardrails without writing code
- **Voice support**: Speech-to-text transcription for voice messages, text-to-speech for responses (DashScope)
- **Security**: User allowlists, working directory validation, content filtering, rate limiting, dangerous pattern blocking
- **Session persistence**: SQLite-backed session store with idle cleanup and state tracking
- **Multi-bot**: Run multiple bots in one process — each bot binds to one agent and one IM platform

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
    agentsFile: AGENTS.md        # per-bot runtime instructions, read every conversation
                                 #   (claude-code: appended to system prompt; set false to disable)

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
  zcode:                                 # GLM-5.2, launched via the ZCode app bundle
    binary: /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs

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
| Antigravity (agy) | Binary spawn | JSON streaming | N/A | Full | Spawns the `agy` (Google Antigravity) CLI |
| GLM / ZCode | JSON-RPC app-server | Streaming | Interactive approval | Full | GLM-5.2 via the ZCode app bundle |

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

```
User sends /sessions in IM
       │
       ▼
CLI2IM scans ~/.claude/projects/ (or ~/.codex/)
  - Reads JSONL conversation files
  - Extracts titles, timestamps, git branches
  - Filters by entrypoint (CLI/task sessions only)
  - Merges active session status (idle/busy/stale)
       │
       ▼
Sends interactive card/keyboard with session list
       │
       ▼
User taps "Resume" button
       │
       ▼
CLI2IM spawns agent with --resume <sessionId>
  - Resolves correct working directory from scanner
  - Binds to IM chat for streaming output
       │
       ▼
Conversation continues in IM
```

## Lineage and Credits

CLI2IM was built from scratch as a standalone project, but its design was informed by two prior works:

### [claude-to-im](https://github.com/op7418/Claude-to-IM) (by op7418, MIT)

A host-agnostic bridge library extracted from [CodePilot](https://github.com/op7418/CodePilot). Claude-to-im established the core pattern of bridging Claude Code SDK to IM platforms with DI-based host interfaces. CLI2IM studied its architecture (adapter abstraction, permission broker, delivery layer, streaming previews) but took a fundamentally different approach:

| | claude-to-im | CLI2IM |
|---|---|---|
| **Architecture** | Library with DI interfaces — host app must implement ~30 BridgeStore methods | Standalone daemon — single YAML config, zero integration code |
| **Agent support** | Claude Code only (via LLMProvider interface) | Claude Code + Codex + Gemini + Antigravity + GLM (plugin system) |
| **Agent binding** | SDK stream consumption | Spawns real CLI binaries, preserves full CLI capabilities |
| **Platforms** | Telegram, Discord, Feishu | Feishu, Telegram (Discord planned) |
| **Session resume** | Not supported | Scan local CLI sessions, interactive picker, one-tap resume |
| **Handoff** | Not supported | Bidirectional CLI ↔ IM handoff with CLI tool |
| **Per-bot personas** | Not supported | Each bot carries its own `AGENTS.md` runtime instructions |
| **Streaming** | Message edit based | Feishu: interactive cards with throttled updates; Telegram: message edits |
| **Persistence** | Delegated to host (BridgeStore) | Built-in SQLite |

### Key additions in CLI2IM beyond claude-to-im's scope

- **Multi-agent plugin system**: Codex, Gemini CLI, Antigravity, and GLM/ZCode work through the same interface as Claude Code, with agent-specific capabilities declared per plugin
- **Per-bot runtime instructions**: Each bot reads an `AGENTS.md` from its working directory and injects it into every conversation — personas, routing rules, and guardrails per bot, no code
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
│   │   ├── agy.ts               # Antigravity (agy) plugin
│   │   ├── zcode.ts             # GLM-5.2 (ZCode) plugin
│   │   └── tool-gate.ts         # Dangerous command detection
│   ├── platforms/
│   │   ├── feishu/              # Feishu adapter, cards, markdown
│   │   └── telegram/            # Telegram adapter, MarkdownV2
│   ├── session/
│   │   ├── store.ts             # SQLite session persistence
│   │   ├── queue.ts             # Per-chat message queue
│   │   ├── cli-scanner.ts       # Claude Code session scanner
│   │   └── codex-scanner.ts     # Codex session scanner
│   ├── services/
│   │   ├── handoff.ts           # Session handoff service
│   │   ├── server.ts            # HTTP API server
│   │   └── speech.ts            # STT/TTS (DashScope)
│   ├── security/                # Validators, content guard
│   └── runtime/                 # Button callback parsing
├── cli/
│   └── cli2im.ts                # Handoff CLI tool
├── tests/                       # 46 test files, 458 tests
├── config.example.yaml
├── esbuild.config.mjs
└── tsconfig.json
```

## Development

```bash
npm run dev          # Run with tsx (hot reload)
npm test             # Run all 458 tests
npm run typecheck    # TypeScript type check
npm run build        # Bundle to dist/
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, testing, and PR conventions.

## License

MIT
