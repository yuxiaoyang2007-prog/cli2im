# CLI2IM

CLI Agent remote bridge — control CLI-based AI agents via IM (Feishu/Telegram).

## Commands

- `npm run dev` — run with tsx (development)
- `npm run build` — esbuild bundle to dist/
- `npm test` — run vitest
- `npm run typecheck` — TypeScript type check

## Architecture

Main process spawns CLI agent subprocesses. Communication via stream-json protocol over stdin/stdout.

- `src/types.ts` — all shared types
- `src/agents/` — agent plugins (claude-code, codex, gemini-cli)
- `src/platforms/feishu/` — Feishu adapter + streaming cards
- `src/session/` — SQLite session store + chat queue
- `src/services/` — handoff, HTTP server
- `src/pipeline.ts` — inbound message pipeline

## Config

`~/.cli2im/config.yaml` — see `config.example.yaml`

## Testing

```bash
npm test                                  # all tests
npx vitest run tests/tool-gate.test.ts    # single file
```

## Implementation Plan

Full plan with code: `~/Claude Code/docs/superpowers/plans/2026-05-07-cli2im-v1.md`
Design spec: `~/Claude Code/docs/superpowers/specs/2026-05-07-cli2im-design.md`
