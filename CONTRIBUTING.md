# Contributing to cli2im

Thanks for your interest. This guide covers dev setup, testing, and the PR conventions this project uses.

## Quick start

```bash
git clone https://github.com/yuxiaoyang2007-prog/cli2im.git
cd cli2im
npm install
```

You'll need:
- Node.js >= 20
- For end-to-end testing against real bots: a Feishu app and/or Telegram bot token, plus at least one CLI agent (Claude Code, Codex CLI, or Gemini CLI). For unit tests alone you don't need any of these.

## Development workflow

```bash
npm run dev          # Run with tsx (hot reload). Reads ~/.cli2im/config.yaml.
npm test             # Run all 316 tests with vitest
npm run typecheck    # TypeScript --noEmit check
npm run build        # esbuild bundle to dist/index.js (used by daemon deployment)
```

Source layout:
```
src/
├── index.ts                 # Daemon entry point (wires everything together)
├── pipeline.ts              # Inbound message pipeline (auth → rate-limit → sanitize → route)
├── agents/                  # Pluggable CLI agent implementations
├── platforms/               # IM adapters (feishu, telegram)
├── runtime/                 # Event handlers, callbacks, session resume, voice reply
├── relay/                   # Bot-to-bot relay manager + delivery
├── session/                 # SQLite session store + chat queue + scanners
├── services/                # HTTP API server, handoff, STT/TTS
├── security/                # Validators, rate limiter, content guard, attachment metadata
└── abort.ts                 # AbortSignal helpers (per-process cancellation)
```

## Testing

Run the full suite before submitting any PR:

```bash
npm test && npm run typecheck
```

Test files live under `tests/`. The project follows a few conventions:

- **One test file per source module** when feasible (`src/foo/bar.ts` ↔ `tests/bar.test.ts`)
- **Race / concurrency / abort tests** are critical — this codebase has been through extensive race-class hardening. New code that touches per-process state should add tests covering replacement / abort / stale-handler scenarios. See `tests/agent-manager-concurrency.test.ts` and `tests/session-cleanup-entrypoints.test.ts` for the patterns to follow.
- **Filesystem fixtures** in tests should clean themselves up via `try/finally` and `mkdtemp`. Don't leave orphan dirs.
- Tests must NOT require network access or real bot credentials. Mock at the adapter boundary.

## Architecture notes for contributors

### Per-process state lifecycle

Every CLI agent process spawned by `AgentManager` is wrapped in a **`ProcessContext`** that bundles:
- The child process handle
- An `AbortController` (the context's abort signal)
- Parser, watchdog, pending permissions
- A cleanup binding that clears session-scoped buffers (voice mode, Telegram stream state) on abort

**Critical rule**: any code that operates on a process or its session-scoped state MUST be identity-scoped — capture the context at entry, check `ctx.signal.aborted` (or `agentManager.getCurrentContext(sessionKey) === ctx`) before each side effect after an `await`. This is enforced throughout `src/runtime/event-handler.ts`, `src/runtime/voice-reply.ts`, `src/relay/deliver.ts`, and the platform adapters.

### Why so much abort plumbing?

This project went through a 24-round security audit cycle (47 commits, see git log). The audit found a class of race conditions where stale events from a replaced/cancelled process could leak side effects into a new process's session. The architectural fix was to thread `AbortSignal` through every async boundary that touches per-session state. If you add new functionality with `await` calls that produce side effects (sending to chat, writing to store, etc.), you MUST follow the existing identity-scoping pattern.

### Adding a new CLI agent plugin

See `src/agents/claude-code.ts` and `src/agents/gemini.ts` as references. Required surface:
- Implement the `AgentPlugin` interface from `src/types.ts`
- Provide `spawn(opts)` returning an `AgentProcess` (with stdout/stderr/exit events)
- Optionally implement `resume(opts)` if your CLI supports session continuation
- Register in `src/index.ts` plugin loading

### Adding a new IM platform adapter

See `src/platforms/feishu/` and `src/platforms/telegram/` as references. Required surface:
- Implement the `PlatformAdapter` interface
- All methods that perform external IO MUST accept `{ signal?: AbortSignal }` and check `signal.aborted` between awaits
- For streaming output (cards / message edits), use the existing `StreamingCardController` pattern with identity-gated finalizers

## Commit conventions

- Use **conventional commits** prefixes: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`
- Keep one logical change per commit
- Commit messages should explain the **why**, not just the **what**
- For security fixes: include the attack scenario and the test that exercises it

## Pull requests

- Branch from `main`
- Run `npm test && npm run typecheck` and confirm both pass before opening the PR
- For non-trivial changes, describe the design decision in the PR body
- For changes touching `src/agents/manager.ts`, `src/runtime/`, `src/relay/`, or any per-process state: explain how identity-scoping is preserved

## Reporting bugs

Open an issue with:
- Platform (macOS / Linux / Windows + version)
- Node.js version (`node --version`)
- Which CLI agent (Claude Code / Codex / Gemini CLI + version)
- Which IM platform (Feishu / Telegram)
- Reproduction steps
- Relevant lines from `~/.cli2im/logs/*` (redact secrets / user IDs)

For security vulnerabilities, please open a private security advisory on GitHub instead of a public issue.

## License

By contributing you agree your contributions are licensed under the MIT License (same as the project).
