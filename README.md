# CLI2IM

English | [中文](README.zh-CN.md)

**Use Claude Code, Codex, Gemini, Antigravity, GLM, and Kimi Work through Feishu or Telegram.** Configure people, projects, and accounts per bot, with streaming replies and authorized desktop-session handoff.

This is not a chatbot. CLI2IM spawns the real CLI binaries you already use, preserves all their capabilities, and adds an IM control plane on top.

---

## Three Killer Features

### 1. Leave your desk, the project keeps moving

You spent the morning at your work laptop driving Claude Code through a refactor. Now you're heading to the airport. With CLI2IM, you don't lose the thread:

- Type `/sessions` in Feishu/Telegram from your phone
- An interactive list shows compatible sessions you are authorized to access, with title, working directory, git branch, and time
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
- Each bot can use an **`AGENTS.md`** in its working directory for project instructions. Instructions do not enforce file isolation; strict separation requires separate OS accounts or an actual restricted runtime.

One daemon can host several bots with separate user lists and project settings. They still share the privileges of the OS account running the daemon unless separately isolated.

### 3. Your IM is already the control plane — no extra app to install

Your team already lives in Feishu. Or you already have Telegram on every device. CLI2IM uses what's there:

- **Feishu**: WebSocket real-time events (no public IP, no webhook, no port forwarding). Interactive cards stream output line by line. Permission prompts and session resume show up as native card buttons. Voice messages get transcribed via DashScope; text replies can be sent back as voice.
- **Telegram**: Long polling (works behind any NAT). MarkdownV2 formatting. Inline keyboards for permissions and resume. Voice STT supported.

To share a bot, add the person's platform user ID to that bot's allowlist. Group restrictions and mention requirements also apply; joining a group does not grant access by itself.

---

## Platform Support

| Platform | Status | Notes |
|---|---|---|
| **macOS** (Apple Silicon & Intel) | ✅ Fully supported | Primary development target. Use LaunchAgent to run as daemon. |
| **Linux** (Ubuntu / Debian / Arch / etc.) | ✅ Fully supported | Use systemd unit to run as daemon. |
| **Windows 10 / 11** | ✅ Supported | Working directory paths accept `C:\Users\...` (and other drives' `Users\` dirs). Run as a Windows Service via [NSSM](https://nssm.cc/) or as a scheduled task. |

**Requirements**:
- Node.js 24.14+ (24 LTS) or 25.4+ for this version's proxy policy
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
- **Session resume**: Scan compatible local CLI history and filter by current chat, explicitly shared roots, and administrator access; recheck access when a button is clicked
- **Bidirectional handoff**: Move a session from CLI terminal to IM bot and back — `cli2im handoff` CLI tool included
- **Per-bot runtime instructions**: Each bot reads an `AGENTS.md` from its working directory and injects it into every conversation — per-bot personas, routing rules, and guardrails without writing code
- **Voice support**: Speech-to-text transcription for voice messages, text-to-speech for responses (DashScope)
- **Security**: Per-bot user/group lists, history access checks, directory validation, optional content checks, rate limits, and tool approval; these are not an OS sandbox
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
| `/sessions` | List compatible, authorized history with Resume buttons |
| `/sessions codex` | Show authorized Codex history from a Codex bot |
| `/resume <id>` | Resume a specific agent session by ID |
| `/handoff` | Release session back to CLI terminal |
| `/status` | Control card with selected model, project, task state, and supported buttons |
| `/stop` | Priority cancellation of the current task and pending messages |
| `/kill` | Priority process termination and pending-message cancellation |
| `/cwd <path>` or `/cd <path>` | Switch to an authorized directory; the next message starts a fresh conversation |
| `/projects [alias]` | List configured/recent projects or select one |
| `/task [name]` | List or submit a configured prompt shortcut |
| `/result [page]` | Retrieve the last saved terminal result for this chat/topic without rerunning it |
| `/bots [stop\|restart]` | Administrator: inspect, stop, or restart the current bot |
| `/doctor [page]` | Administrator: inspect local runtime checks and service inventory, with unverified states marked |
| `/thinking` | Toggle thinking block visibility (Feishu) |
| `/fast` | Toggle fast/low-reasoning mode |
| `/model <name>` | Set model for next agent spawn |
| `/perm allow\|deny <id>` | Respond to a permission request |
| `/list` | List active bot sessions |

`/model <name>` saves the selection for the next agent process; `/model default` restores the default. Saving a name does not verify the provider supports it. Finish or stop an active task before switching. `/task` submits configured text to the AI rather than directly executing a shell script; the AI retains its configured tool permissions.

## People, accounts, and data boundaries

Use `allowFrom` for each bot's ordinary users and `adminUsers` for its owner/operators. An empty ordinary-user list denies access. Administrators can manage their bot and view compatible desktop history, so grant that role deliberately. `groupPolicy: allowlist` plus `groupAllowFrom` restricts groups as well as users; an empty group list permits private chats only. `requireMention: true` requires mentioning the bot in groups.

Ordinary users can resume history already bound to the current chat/topic. `sessionRoots` explicitly shares compatible desktop history under those directories with authorized users of that bot. A project directory or `AGENTS.md` is not an OS sandbox. Full-tool agents running under the same OS account may read other files accessible to that account. Use separate `larkCliConfigDir` directories for distinct Feishu authorizations.

See [config.example.yaml](config.example.yaml). Stopping one bot interrupts its work without restarting other bots; use the local CLI to start a stopped bot because it cannot receive IM commands.

## Long-term memory

Memory is opt-in per bot: `memory: true` requires `isolation.enabled: true`. CLI2IM saves only explicitly supplied entries, not chat history or agent-generated memories. It passes a structured snapshot to the agent on the first message of each process and after changes. Omitting memory and isolation settings preserves existing behavior.

```yaml
memory:
  dir: ~/.cli2im/memory
  people:
    alice: ["feishu:ccbot:ou_alice", "telegram:codexbot:123456789"]
```

`memory.people` entries use `<platform>:<botName>:<userId>` and must reference configured bots on those platforms. Private-chat memory is separate by platform application and user unless explicitly mapped to the same person; an identity cannot map to two people. Group memory belongs to the group, including its topics, rather than the speaker's private memory.

| Command | Behavior |
|---|---|
| `/remember <text>` | Save an entry, up to 2,000 characters; up to 200 entries per identity/group |
| `/memory [page]` | List entries for the current identity/group |
| `/memory edit <id> <text>` | Replace text and retain up to 20 prior versions; the next message receives an updated snapshot |
| `/memory history <id>` | Show prior versions |
| `/forget <id>` | Delete the entry and all its versions, end running sessions for this identity/group across bots/topics, and cancel their queued tasks |

After `/memory edit`, old text may remain in the current conversation context; use `/new` to clear that context. After `/forget`, the next message starts a new session: old session records remain stored but are no longer used or resumable for that identity. Group entries may be edited/deleted only by their creator (including identities mapped to the same person) or that bot's `adminUsers`. Historical copies in backup directories are not managed or erased by CLI2IM.

## Shared bot isolation

Isolation currently requires macOS and supports only `claude-code` and `codex`; agy and other agents are unsupported. Enable `isolation.enabled`, use absolute paths in `isolation.readable` (read-only) and `isolation.writable` (read/write), and give every user in `allowFrom ∪ adminUsers` a `userOverrides` workspace. Workspaces for different scopes must not overlap. `allowPublic: true`, `allowFrom: ['*']`, and `mcpServers` are forbidden. See the commented setup in [config.example.yaml](config.example.yaml).

Private chats use the user's override workspace. All groups of the same bot use its bot-level `workingDirectory`: **these groups' conversations can see each other's workspace files**, even though their memories are separate. Keep workspaces and writable grants separate from memory, CLI2IM data/install directories, and plugins. `larkCliConfigDir` is not automatically granted: it must be explicitly listed in `isolation.writable`, which grants the capabilities of that lark-cli account. The isolated subprocess `PATH` is rewritten to native real directories after rejecting empty, relative, or `.`/`..` entries and dropping missing or non-directory entries; an empty result or any overlap with writable or inbox directories (compared case-insensitively on macOS) makes isolation unsupported, and the rewritten PATH is used for starts, resumes, later turns, checks, and the policy fingerprint.

`plugins` and the optional `skills` allowlist are Claude-only. Plugin directories must be outside writable areas, maintained by the operator, and contain only skills (no hooks, MCP, agents, commands, or LSP definitions). The bridge does not load a default workspace `AGENTS.md` for isolated bots; an explicit `agentsFile` must be an absolute path outside all bots' writable areas. Provider credentials in the subprocess environment cause isolation startup to be refused; use CLI login storage.

Checks run automatically at daemon startup and when the agent executable changes, using a local scripted model without calling paid models. Run `cli2im doctor isolation [--config <path>]` locally without a daemon, or administrator `/doctor` in IM to rerun checks and inspect results. Records are stored at `~/.cli2im/isolation/verification.json` by default. A scope without a current `VERIFIED` record cannot start or resume an agent and replies “隔离检查未通过，已暂停执行，请管理员查看 /doctor”. Failed checks also stop running isolated agents for that bot; control, diagnostic, and memory commands remain available.

Each isolated Codex bot uses its own `CODEX_HOME`: `<dataDir>/codex-home/<first 16 hex characters of sha256(bot name)>`. `dataDir` defaults to `~/.cli2im` and can be set with `CLI2IM_DATA_DIR`. During deployment, the owner must log in once per bot with their personal Codex account:

```bash
bot_name='codexbot' # Exact configured bot name; hash without a trailing newline
bot_hash=$(printf %s "$bot_name" | shasum -a 256 | cut -c1-16)
data_dir="${CLI2IM_DATA_DIR:-$HOME/.cli2im}"
CODEX_HOME="$data_dir/codex-home/$bot_hash" codex login
```

Known limits: shared Claude bots have no built-in file tools; file operations go through sandboxed Bash. `git init` and `git clone` are unavailable because Claude's sandbox protects `.git/config` and `.git/hooks`. MCP is unsupported. Isolated Codex bots disable subagents and goal management and do not automatically return images from the shared generated-images directory. Isolated `/sessions` lists only eligible sessions in the current isolation domain; desktop history scanning and handoff are disabled.

For rollback, stop the affected bot or restore a verified version. **Disabling isolation restores unrestricted execution; do so only after removing all users other than yourself.**

## Proxy, speech, and recovery

On macOS, `network.mode: system` follows the system HTTP/HTTPS proxy. Linux/Windows use `environment` mode and proxy environment variables. With `required: true`, unavailable proxies pause network work without selecting direct fallback; only localhost exceptions are allowed. Application proxy settings do not enforce OS isolation or prove DNS privacy. System DNS and tools that ignore proxies still need separate verification.

Per-bot `speech.stt` and `speech.tts` independently control DashScope transcription and synthesis. Those services receive the complete incoming audio or the reply text being spoken. A provider hostname in `NO_PROXY` alone is not evidence that the bridge calls that provider.

Recovery stores the latest terminal reply per authorized scope, capped at 1 MiB. Replies can contain sensitive material; this is not a redacted copy. Directory/file modes are `700`/`600`, but programs under the same OS account can still read them. `/result` requires an explicit request. Restarts do not automatically rerun tasks or resend ambiguously delivered results. See [service and local-data inventory](docs/service-inventory.md).

## CLI Tool

A companion CLI for session handoff:

```bash
# Transfer a running CLI session to the IM bot
cli2im handoff --bot ccbot --session <uuid> --workdir ~/projects/myapp

# Check daemon status
cli2im status

# Uses an existing CLI2IM_WEB_TOKEN; do not paste its value into commands or chat.
cli2im bots
cli2im bots stop ccbot
cli2im bots start ccbot
cli2im bots restart ccbot
cli2im doctor
```

These commands target a running local daemon. Source changes or passing tests do not deploy an update. Back up configuration, database, and the previous build before restarting and verifying your deployment.

When validating in a checkout used by a live daemon, run `CLI2IM_BUILD_DIR=dist-candidate npm run build`. Explicit candidate builds put the daemon, CLI, notification hooks, and plugin hooks under that directory without overwriting live `dist` or plugin artifacts. This does not deploy or restart the daemon.

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

### Accurate Codex task notifications

`codex-task-notifier` uses Codex lifecycle Hooks and two explicit MCP status tools. It sends an orange Feishu card for approval, confirmation, or a blocking question, and a green card only after the main task explicitly reports verified completion. JSONL `task_complete` is ignored in structured mode, so a turn that merely asks the user to choose a plan cannot be mistaken for finished work.

Build and install the personal plugin:

```bash
npm run build
./scripts/install-codex-task-notifier.sh
codex plugin add codex-task-notifier@personal
```

Set `notifications.codex.completionSource: structured` in `~/.cli2im/config.yaml`, then restart the bridge. The installer does not change `~/.codex/config.toml`; native Codex notifications remain enabled.

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
