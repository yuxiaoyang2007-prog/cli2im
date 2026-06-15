# CLI2IM

CLI Agent remote bridge — control CLI-based AI agents via IM (Feishu/Telegram).

## Commands

- `npm run dev` — run with tsx (development)
- `npm run build` — esbuild bundle to dist/
- `npm test` — run vitest (154 tests)
- `npm run typecheck` — TypeScript type check

## Architecture

Main process spawns CLI agent subprocesses. Communication via stream-json protocol over stdin/stdout.

- `src/types.ts` — all shared types
- `src/index.ts` — daemon entry point, command routing, event handling
- `src/agents/` — agent plugins (Codex, codex, gemini-cli)
- `src/platforms/feishu/` — Feishu adapter + streaming cards
- `src/platforms/telegram/` — Telegram adapter + inline keyboards
- `src/session/` — SQLite session store + chat queue + CLI session scanners
- `src/services/` — handoff, HTTP server, speech (STT/TTS)
- `src/pipeline.ts` — inbound message pipeline (auth, rate limit, command parse)
- `src/runtime/callbacks.ts` — button callback parsing (permission + session resume)

## Config

`~/.cli2im/config.yaml` — see `config.example.yaml`

## Key Patterns

- Agent plugins implement `AgentPlugin` interface (types.ts) — spawn, resume, capabilities
- Platform adapters implement `PlatformAdapter` interface — connect, send, onMessage, onCallback
- Session key format: `platform:chatId:botName`
- Bridge commands start with `/` and are parsed in pipeline.ts
- Dangerous commands matched by regex patterns in config, gated via interactive IM buttons
- CLI session scanner reads JSONL files (head 4KB + tail 32KB) to extract titles and metadata
