# CLI2IM

CLI Agent remote bridge — control CLI-based AI agents via IM (Feishu/Telegram).

## Commands

- `npm run dev` — run with tsx (development)
- `npm run build` — esbuild bundle to `dist/` (including `dist/agents/*.js` for hot-reload)
- `npm test` — run vitest (1743 tests across 118 test files)
- `npm run typecheck` — TypeScript type check
- `node dist/cli2im.js bots reload <bot>` — hot-reload a bot's agent plugin (`dist/agents/<agent>.js`) and reset idle processes without restarting other active bots
- `node dist/cli2im.js config reload` — zero-downtime reload of `~/.cli2im/config.yaml` & `.env` via `POST /api/config/reload` (also triggered by `SIGHUP` or `/bots config-reload`)
- `node dist/cli2im.js notify --message <text> [--bot <name>] [--session <id>]` — push a notification card (+ 1-click resume button) to a `/watch`-bound IM chat
- `node dist/cli2im.js doctor --online` — run offline runtime checks plus live Feishu/Telegram API connectivity probes
- `node dist/cli2im.js top [--once]` — live terminal view of daemon uptime, active tasks, and bot states

## Architecture

Main process spawns CLI agent subprocesses. Communication via stream-json protocol over stdin/stdout (persistent multi-turn or structured NDJSON).

- `src/types.ts` — all shared types
- `src/index.ts` — daemon entry point, concurrent bot startup, queue steer/control callbacks, `SIGHUP` hot reload & periodic housekeeping
- `src/commands/bridge-commands.ts` — bridge slash command handler (`/status`, `/model`, `/effort`, `/watch`, `/diff-review`, `/bots`, `/doctor`, etc.)
- `src/agents/` — agent plugins (`claude-code`, `codex`, `gemini`, `agy`, `zcode`, `kimi-work`) and `plugin-loader.ts`
- `src/config/` — YAML config loader, `~/.cli2im/.env` auto-loader (`dotenv.ts`), in-place hot reload (`reload.ts`), runtime config updates
- `src/platforms/feishu/` — Feishu adapter + streaming cards (interactive stop button, thinking preview, token stats, >22k-char continuation cards)
- `src/platforms/telegram/` — Telegram adapter (timeouts & MarkdownV2 fallback) + throttled `editMessage` streaming + >3800-char chunking + inline keyboards
- `src/session/` — SQLite session store (`coalesceMs` write coalescing, `/watch` targets, stale record pruning & VACUUM compaction) + chat queue + CLI session scanners
- `src/services/` — handoff, HTTP server (`GET /dashboard`, `/api/notify`, `/api/config/reload`), offline & online doctor, speech (STT/TTS)
- `src/isolation/` — workspace isolation policy, admission, runtime, and verification
- `src/memory/` — persistent memory store, injection, and commands
- `src/notifications/` — CLI notification monitor, socket server, router, and `/watch` + `cli2im notify` dispatcher (`cli-notify.ts`)
- `src/relay/` — group bot relay with directed `@<bot>` filtering (`deliver.ts`)
- `src/security/` — access policy, content guard (with built-in fallback + quoted message scanning), network policy, log scrubbing
- `src/util/housekeeping.ts` — `cli2im.log` copy-truncate rotation and inbound media TTL cleanup
- `src/pipeline.ts` — inbound message pipeline (auth, rate limit, command parse)
- `src/runtime/callbacks.ts` — button callback parsing (permission + session resume)

## Config

- `~/.cli2im/config.yaml` — see `config.example.yaml`
- `~/.cli2im/.env` — secret tokens/IDs (`0600`, auto-loaded at startup by daemon and `cli2im` CLI)

## Key Patterns

- Agent plugins implement `AgentPlugin` interface (types.ts) — spawn, resume, capabilities
- Platform adapters implement `PlatformAdapter` interface — connect, send, onMessage, onCallback
- Session key format: `platform:chatId:botName`
- Bridge commands start with `/` and are parsed in pipeline.ts
- Dangerous commands matched by regex patterns in config, gated via interactive IM buttons
- CLI session scanner reads JSONL files (head 4KB + tail 32KB) to extract titles and metadata
