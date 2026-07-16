# Codex Structured Feishu Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace heuristic JSONL completion alerts with explicit Codex MCP status tools and lifecycle Hooks, while keeping Feishu delivery, native notifications, deduplication, retry, and project/task identification.

**Architecture:** A personal `codex-task-notifier` plugin exposes `mark_waiting` and `mark_completed`. Codex Hooks normalize `UserPromptSubmit`, `PermissionRequest`, `PostToolUse`, `SubagentStart`, `SubagentStop`, and `Stop` into a local task-state file plus a write-ahead outbox. `cli2im` drains the outbox through the existing Unix socket, persists task transitions in SQL.js, and routes only explicit status events to Feishu.

**Tech Stack:** Node.js 22+, TypeScript, Vitest, esbuild, SQL.js, Codex plugin manifest, MCP stdio JSON-RPC, Codex lifecycle Hooks, Unix domain sockets, Feishu Node SDK.

## Global Constraints

- No successful `mark_completed` means no green completion card.
- `Stop`, JSONL `task_complete`, assistant text, and subagent completion never create a green card.
- `Stop` may force exactly one protocol continuation; a second unreported stop becomes `ENDED_UNREPORTED`.
- Feishu cards must include a safe project name and task name.
- Hook payloads and outbox files must not persist raw prompts, full paths, commands, code, logs, or credentials.
- The existing `notify` hook and `[tui]` native notification settings remain byte-for-byte enabled.
- Normal structured events should reach Feishu within 3 seconds.
- Implement with TDD, keep unrelated code unchanged, and preserve the existing Feishu binding.

---

## File Map

- `src/notifications/lifecycle-protocol.ts`: allowlisted lifecycle event types, Hook input normalization, stable IDs, task-title/project sanitization.
- `src/notifications/task-state-files.ts`: private per-session Hook state, per-turn status markers, protocol-continuation marker, and write-ahead outbox.
- `src/notifications/lifecycle-hook-client.ts`: command Hook entrypoint and Stop/UserPromptSubmit stdout decisions.
- `src/notifications/mcp-server.ts`: minimal stdio MCP server exposing only `mark_waiting` and `mark_completed`.
- `src/notifications/structured-lifecycle.ts`: daemon-side state transitions from normalized events to notification events.
- `src/notifications/outbox.ts`: startup and 500ms outbox drain with idempotent deletion after durable handling.
- `src/notifications/socket-server.ts`: accept versioned structured lifecycle events in addition to approvals.
- `src/notifications/service.ts`: wire structured lifecycle handling and disable heuristic completion in structured mode.
- `src/session/store.ts`: `notification_tasks` persistence and atomic state transitions.
- `src/types.ts`, `src/config/loader.ts`, `config.example.yaml`: `completionSource: structured | legacy` configuration.
- `esbuild.config.mjs`: build plugin Hook and MCP binaries and copy them into the plugin package.
- `plugins/codex-task-notifier/`: personal plugin manifest, MCP configuration, Hooks, and status protocol skill.
- `scripts/install-codex-task-notifier.sh`: reversible personal marketplace/plugin installation and production cutover helper.
- `tests/*`: protocol, state file, Hook, MCP, outbox, store, service, negative-path, and config tests.

---

### Task 1: Define and validate the structured lifecycle protocol

**Files:**
- Create: `src/notifications/lifecycle-protocol.ts`
- Create: `tests/codex-lifecycle-protocol.test.ts`

**Interfaces:**
- Produces: `StructuredLifecycleEvent`, `normalizeLifecycleHookInput(input, now)`, `structuredEventKey(parts)`, `safeTaskTitle(prompt)`, and `safeProjectName(cwd)`.
- Consumes: no task-state or transport code.

- [ ] **Step 1: Write failing protocol tests**

Cover these exact inputs:

```ts
expect(normalizeLifecycleHookInput({
  hook_event_name: 'UserPromptSubmit',
  session_id: 'session_1', turn_id: 'turn_1', cwd: '/work/power-trader-edu',
  prompt: '生成宣传讲解 HTML PPT', model: 'gpt-5', permission_mode: 'default',
}, 1_000)).toMatchObject({
  version: 1, type: 'user_prompt', sessionId: 'session_1', turnId: 'turn_1',
  projectName: 'power-trader-edu', taskName: '生成宣传讲解 HTML PPT', occurredAt: 1_000,
});

expect(normalizeLifecycleHookInput({
  hook_event_name: 'PostToolUse',
  session_id: 'session_1', turn_id: 'turn_1', cwd: '/work/project',
  tool_name: 'mcp__codex_task_notifier__mark_completed', tool_use_id: 'tool_1',
  tool_input: {}, tool_response: { content: [{ type: 'text', text: 'recorded' }] },
}, 2_000)).toMatchObject({
  type: 'status_tool', status: 'completed', toolUseId: 'tool_1',
});
```

Also assert rejection of unknown events, missing IDs, payloads over 8KB, credential-bearing title fragments, and arbitrary MCP tool names.

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- --run tests/codex-lifecycle-protocol.test.ts`  
Expected: FAIL because `lifecycle-protocol.ts` does not exist.

- [ ] **Step 3: Implement the allowlisted protocol**

Define the exact union:

```ts
export type StructuredLifecycleEvent =
  | { version: 1; type: 'user_prompt'; eventKey: string; sessionId: string; turnId: string; projectName: string; taskName: string; occurredAt: number }
  | { version: 1; type: 'approval_requested'; eventKey: string; sessionId: string; turnId: string; requestId: string; occurredAt: number }
  | { version: 1; type: 'status_tool'; eventKey: string; sessionId: string; turnId: string; toolUseId: string; status: 'waiting' | 'completed'; reason?: 'question' | 'confirmation'; occurredAt: number }
  | { version: 1; type: 'stop'; eventKey: string; sessionId: string; turnId: string; stopHookActive: boolean; occurredAt: number }
  | { version: 1; type: 'subagent_start' | 'subagent_stop'; eventKey: string; sessionId: string; turnId: string; agentId: string; occurredAt: number };
```

Return newly allocated allowlisted objects only. Never retain `prompt`, `cwd`, `tool_input`, `tool_response`, or `last_assistant_message` after normalization.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm test -- --run tests/codex-lifecycle-protocol.test.ts`  
Expected: all protocol tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/notifications/lifecycle-protocol.ts tests/codex-lifecycle-protocol.test.ts
git commit -m "feat(notifications): define structured lifecycle protocol"
```

### Task 2: Add private Hook task state and write-ahead outbox

**Files:**
- Create: `src/notifications/task-state-files.ts`
- Create: `tests/codex-task-state-files.test.ts`

**Interfaces:**
- Consumes: `StructuredLifecycleEvent` from Task 1.
- Produces: `loadHookTaskState`, `registerUserPrompt`, `recordTurnStatus`, `markProtocolContinuation`, `consumeProtocolContinuation`, `writeOutboxEvent`, `removeOutboxEvent`, and `listOutboxEvents`.

- [ ] **Step 1: Write failing filesystem tests**

Use a temporary data directory and assert:

```ts
const first = await registerUserPrompt(root, userPromptEvent, false);
expect(first).toMatchObject({ state: 'RUNNING', taskName: '生成宣传讲解 HTML PPT' });
await recordTurnStatus(root, first, { status: 'waiting', turnId: 'turn_1', eventKey: 'evt_wait' });
const resumed = await registerUserPrompt(root, { ...nextPrompt, turnId: 'turn_2' }, false);
expect(resumed.taskId).toBe(first.taskId);
expect(resumed.taskName).toBe(first.taskName);
```

Assert directory mode `0700`, file mode `0600`, atomic temp-file rename, one-time protocol continuation consumption, no raw prompt/path in any file, deterministic outbox ordering, and seven-day orphan-marker cleanup.

- [ ] **Step 2: Run test and verify RED**

Run: `npm test -- --run tests/codex-task-state-files.test.ts`  
Expected: FAIL because state-file functions do not exist.

- [ ] **Step 3: Implement minimal private state files**

Use `~/.cli2im/codex-task-state/` and `~/.cli2im/codex-notification-outbox/`. Key filenames by SHA-256 digest, never by session/task title. Write JSON to a sibling temporary file with `flag: 'wx', mode: 0o600`, `fsync`, then `rename`.

The persisted Hook state must be limited to:

```ts
interface HookTaskState {
  version: 1;
  taskId: string;
  sessionId: string;
  firstTurnId: string;
  currentTurnId: string;
  projectName: string;
  taskName: string;
  state: 'RUNNING' | 'WAITING_APPROVAL' | 'WAITING_QUESTION' | 'COMPLETED' | 'ENDED_UNREPORTED' | 'CANCELLED';
  reportedTurnId?: string;
  protocolContinuationPending?: { token: string; taskId: string };
  updatedAt: number;
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm test -- --run tests/codex-task-state-files.test.ts`  
Expected: all private-state and outbox tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/notifications/task-state-files.ts tests/codex-task-state-files.test.ts
git commit -m "feat(notifications): persist private Hook task state"
```

### Task 3: Implement the lifecycle Hook runtime and Stop enforcement

**Files:**
- Create: `src/notifications/lifecycle-hook-client.ts`
- Create: `tests/codex-lifecycle-hook-client.test.ts`

**Interfaces:**
- Consumes: protocol normalizers from Task 1 and state/outbox functions from Task 2.
- Produces: `runLifecycleHook(input, output, options)` and a CLI entrypoint.

- [ ] **Step 1: Write failing Hook tests**

Test exact behavior:

```ts
await runLifecycleHook(streamOf(userPromptHook), stdout, options);
expect(parseStdout(stdout)).toMatchObject({
  hookSpecificOutput: { hookEventName: 'UserPromptSubmit' },
});

await runLifecycleHook(streamOf(stopWithoutStatus), stdout, options);
expect(parseStdout(stdout)).toEqual({
  decision: 'block',
  reason: expect.stringContaining('mark_waiting or mark_completed'),
});

await runLifecycleHook(streamOf({ ...stopWithoutStatus, stop_hook_active: true }), stdout, options);
expect(parseStdout(stdout)).toEqual({ continue: true });
```

Also test `SessionStart` protocol context, `SubagentStart` prohibition context, PostToolUse status marker before outbox write, PermissionRequest without tool input persistence, protocol continuation not becoming a new task, silent socket failure, and malformed input exiting successfully.

- [ ] **Step 2: Run test and verify RED**

Run: `npm test -- --run tests/codex-lifecycle-hook-client.test.ts`  
Expected: FAIL because Hook runtime does not exist.

- [ ] **Step 3: Implement Hook runtime**

For every normalized event, write the outbox record before attempting the Unix socket. For `Stop`, check only the current turn's `reportedTurnId`; a PermissionRequest does not satisfy completion reporting. Before returning `decision: block`, persist a one-time protocol continuation token. On the second Stop, mark `ENDED_UNREPORTED`, enqueue a non-notifying stop event, and return `{ "continue": true }`.

UserPromptSubmit output must inject concise developer context requiring the main agent to use exactly one status tool before stopping. Protocol-generated continuation prompts must retain the existing task identity and title.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm test -- --run tests/codex-lifecycle-hook-client.test.ts`  
Expected: all Hook behavior passes with no stderr or sensitive logs.

- [ ] **Step 5: Commit**

```bash
git add src/notifications/lifecycle-hook-client.ts tests/codex-lifecycle-hook-client.test.ts
git commit -m "feat(notifications): enforce explicit Codex task status"
```

### Task 4: Build the MCP status server and personal plugin package

**Files:**
- Create: `src/notifications/mcp-server.ts`
- Create: `tests/codex-notifier-mcp.test.ts`
- Create: `plugins/codex-task-notifier/.codex-plugin/plugin.json`
- Create: `plugins/codex-task-notifier/.mcp.json`
- Create: `plugins/codex-task-notifier/hooks/hooks.json`
- Create: `plugins/codex-task-notifier/skills/task-status/SKILL.md`
- Modify: `esbuild.config.mjs`
- Test: `tests/esbuild-config.test.ts`

**Interfaces:**
- Produces MCP tools `mark_waiting` and `mark_completed` through server name `codex_task_notifier`.
- Hooks call `node "$PLUGIN_ROOT/dist/lifecycle-hook.js"`.

- [ ] **Step 1: Write failing MCP and packaging tests**

Drive the stdio server with JSON-RPC messages and assert `initialize`, `tools/list`, and both `tools/call` responses. Reject extra arguments for `mark_completed` and invalid waiting reasons. Assert the manifest points to `./.mcp.json` and `./hooks/hooks.json`, and Hook matchers use the exact canonical MCP names.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --run tests/codex-notifier-mcp.test.ts tests/esbuild-config.test.ts`  
Expected: FAIL because MCP server and plugin package are absent.

- [ ] **Step 3: Implement minimal newline-delimited MCP JSON-RPC**

Support only:

```ts
initialize
notifications/initialized
tools/list
tools/call // mark_waiting or mark_completed
ping
```

Return a successful text result such as `Task status recorded by Codex lifecycle hooks.`; do not write state from the MCP server itself. The authoritative event comes from PostToolUse.

Use this MCP config shape:

```json
{
  "mcpServers": {
    "codex_task_notifier": {
      "command": "node",
      "args": ["./dist/mcp-server.js"],
      "cwd": "."
    }
  }
}
```

- [ ] **Step 4: Add plugin Hooks and build outputs**

Configure `SessionStart`, `UserPromptSubmit`, `PermissionRequest`, exact notifier `PostToolUse`, `SubagentStart`, `SubagentStop`, and `Stop` command Hooks. Build:

```text
plugins/codex-task-notifier/dist/mcp-server.js
plugins/codex-task-notifier/dist/lifecycle-hook.js
```

Set both executable entrypoints to mode `0755` where needed.

- [ ] **Step 5: Run tests and build**

Run: `npm test -- --run tests/codex-notifier-mcp.test.ts tests/esbuild-config.test.ts && npm run build`  
Expected: tests pass and both plugin dist files exist.

- [ ] **Step 6: Commit**

```bash
git add src/notifications/mcp-server.ts tests/codex-notifier-mcp.test.ts plugins/codex-task-notifier esbuild.config.mjs tests/esbuild-config.test.ts
git commit -m "feat(notifications): package Codex task notifier plugin"
```

### Task 5: Persist daemon-side task transitions

**Files:**
- Modify: `src/session/store.ts`
- Modify: `src/notifications/types.ts`
- Create: `src/notifications/structured-lifecycle.ts`
- Create: `tests/codex-structured-lifecycle.test.ts`
- Modify: `tests/notification-store.test.ts`

**Interfaces:**
- Consumes: `StructuredLifecycleEvent`.
- Produces: `StoredCodexTask`, `upsertCodexTask`, `getCodexTask`, `transitionCodexTask`, and `StructuredLifecycleService.handle(event)`.

- [ ] **Step 1: Write failing store and transition tests**

Assert schema migration creates `notification_tasks`, task-start idempotency, waiting continuation reuses the task, completed is terminal, unknown/mismatched tasks do not emit notifications, and successful completion produces exactly one `CodexNotificationEvent` with existing card metadata.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --run tests/notification-store.test.ts tests/codex-structured-lifecycle.test.ts`  
Expected: FAIL because task persistence and service do not exist.

- [ ] **Step 3: Add the task table**

Use this schema:

```sql
CREATE TABLE IF NOT EXISTS notification_tasks (
  task_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  first_turn_id TEXT NOT NULL,
  current_turn_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  task_name TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notification_tasks_session_updated
  ON notification_tasks(session_id, updated_at);
```

Validate state values in TypeScript before every write. Use SQL transactions so a state transition and notification enqueue cannot be split by a failed save.

- [ ] **Step 4: Implement structured transition service**

Map only:

```text
approval_requested -> needs_attention / approval
status_tool waiting -> needs_attention / question
status_tool completed -> completed
```

`user_prompt`, `stop`, and subagent events update state/diagnostics without cards. Reject cards missing project/task names.

- [ ] **Step 5: Run tests and verify GREEN**

Run: `npm test -- --run tests/notification-store.test.ts tests/codex-structured-lifecycle.test.ts`  
Expected: all migrations, transitions, and privacy cleanup tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/session/store.ts src/notifications/types.ts src/notifications/structured-lifecycle.ts tests/notification-store.test.ts tests/codex-structured-lifecycle.test.ts
git commit -m "feat(notifications): persist structured Codex task state"
```

### Task 6: Generalize the socket and drain the outbox

**Files:**
- Modify: `src/notifications/socket-server.ts`
- Create: `src/notifications/outbox.ts`
- Modify: `src/notifications/service.ts`
- Modify: `tests/codex-notification-socket.test.ts`
- Create: `tests/codex-notification-outbox.test.ts`
- Modify: `tests/codex-notification-service.test.ts`

**Interfaces:**
- Socket produces `StructuredLifecycleEvent` callbacks.
- `CodexNotificationOutbox` drains event files through the same lifecycle handler and deletes only after durable success/duplicate acknowledgement.

- [ ] **Step 1: Write failing socket/outbox tests**

Cover all version-1 event types, malformed/oversized rejection, private path behavior, callback failure retention, startup drain, 500ms live drain, Socket/outbox duplicate processing, clean shutdown, and no raw payload logging.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --run tests/codex-notification-socket.test.ts tests/codex-notification-outbox.test.ts tests/codex-notification-service.test.ts`  
Expected: FAIL because the socket accepts approvals only and outbox daemon is absent.

- [ ] **Step 3: Generalize socket parsing**

Replace `onApproval` with `onEvent`. Parse both the existing approval Hook shape during migration and version-1 structured events, normalize them, and pass only allowlisted objects to the service.

- [ ] **Step 4: Implement outbox lifecycle**

Start outbox after the router and before reporting notification health. Process files in occurred-time/event-key order. Delete an event file only when handling returns `delivered`, `pending`, or `duplicate` after durable enqueue; keep malformed files quarantined by fixed error category without logging content.

- [ ] **Step 5: Wire service and verify GREEN**

Run: `npm test -- --run tests/codex-notification-socket.test.ts tests/codex-notification-outbox.test.ts tests/codex-notification-service.test.ts`  
Expected: all socket, outbox, startup, shutdown, and service tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/notifications/socket-server.ts src/notifications/outbox.ts src/notifications/service.ts tests/codex-notification-socket.test.ts tests/codex-notification-outbox.test.ts tests/codex-notification-service.test.ts
git commit -m "feat(notifications): deliver structured Hook events durably"
```

### Task 7: Cut completion over from JSONL to explicit status

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config/loader.ts`
- Modify: `src/index.ts`
- Modify: `src/notifications/service.ts`
- Modify: `src/notifications/monitor.ts`
- Modify: `config.example.yaml`
- Modify: `tests/config-loader.test.ts`
- Modify: `tests/codex-notification-service.test.ts`
- Modify: `tests/codex-notification-monitor.test.ts`

**Interfaces:**
- Adds `notifications.codex.completionSource: 'legacy' | 'structured'`.
- Structured mode may use JSONL for metadata and exact `request_user_input` recovery, but ignores all completion/assistant-state notification triggers.

- [ ] **Step 1: Write failing cutover tests**

Assert invalid mode is rejected. In structured mode, replay `assistant_state` plus `task_complete` and assert no router call. Replay a structured completed event and assert one green card. Keep native config outside the application untouched.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --run tests/config-loader.test.ts tests/codex-notification-service.test.ts tests/codex-notification-monitor.test.ts`  
Expected: FAIL because completion source is not configurable.

- [ ] **Step 3: Implement the atomic source switch**

Default missing `completionSource` to `legacy` for compatibility. Pass the configured mode into `CodexNotificationService`. In `structured`, ignore parsed `assistant_state` and `completed` for notification routing; keep context hydration and exact question recovery.

Update the example:

```yaml
notifications:
  codex:
    enabled: true
    botName: codexbot
    completionSource: structured
```

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm test -- --run tests/config-loader.test.ts tests/codex-notification-service.test.ts tests/codex-notification-monitor.test.ts`  
Expected: all structured cutover and legacy compatibility tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/config/loader.ts src/index.ts src/notifications/service.ts src/notifications/monitor.ts config.example.yaml tests/config-loader.test.ts tests/codex-notification-service.test.ts tests/codex-notification-monitor.test.ts
git commit -m "fix(notifications): require explicit completion status"
```

### Task 8: Add safe installation, full verification, and production cutover

**Files:**
- Create: `scripts/install-codex-task-notifier.sh`
- Create: `tests/codex-task-notifier-install.test.ts`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-16-codex-structured-feishu-notifications-design.md` only if implementation reveals a factual correction.

**Interfaces:**
- Installer copies the built plugin to a versioned personal plugin directory, updates a personal marketplace entry without overwriting unrelated plugins, and prints the exact Hook trust/restart status.
- Production cutover sets `completionSource: structured` only after plugin build/install verification.

- [ ] **Step 1: Write failing installer tests**

Use isolated `HOME` and config fixtures. Assert idempotent install, preservation of unrelated marketplace/config fields, mode `0600/0700`, no secret output, no deletion, and rollback metadata.

- [ ] **Step 2: Run test and verify RED**

Run: `npm test -- --run tests/codex-task-notifier-install.test.ts`  
Expected: FAIL because installer is absent.

- [ ] **Step 3: Implement installer and documentation**

The installer must:

1. require an existing successful build;
2. copy the plugin to a versioned private destination;
3. merge one personal marketplace entry;
4. back up files before replacement;
5. never change `[tui]` or the existing `notify` command;
6. never delete previous plugin versions or backups;
7. support `--dry-run` and print only paths/statuses, never secrets.

- [ ] **Step 4: Run full verification**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: all tests pass, typecheck succeeds, build completes, and diff check is clean.

- [ ] **Step 5: Commit**

```bash
git add scripts/install-codex-task-notifier.sh tests/codex-task-notifier-install.test.ts README.md docs/superpowers/specs/2026-07-16-codex-structured-feishu-notifications-design.md
git commit -m "chore(notifications): install structured Codex notifier"
```

- [ ] **Step 6: Back up and deploy**

Verify the Mac Studio asset ownership from the Feishu ledger, then back up:

```text
~/.cli2im/config.yaml
~/.cli2im/cli2im.db
~/.codex/config.toml
current dist/index.js
personal plugin marketplace/config files
```

Run the installer, complete Hook trust using `/hooks` if Codex requests it, set production `completionSource: structured`, rebuild, and restart `com.cli2im.bridge`.

- [ ] **Step 7: Production acceptance**

Verify all five cases:

1. `mark_waiting` produces one orange card with project/task in under 3 seconds;
2. `mark_completed` produces one green card with project/task in under 3 seconds;
3. JSONL `task_complete` and plain Stop produce no green card;
4. Stop without status continues once and never loops;
5. with `cli2im` stopped, an event enters outbox and is delivered once after restart.

Read the Feishu messages back, verify database integrity and zero pending failures, confirm the LaunchAgent is running, and confirm native notification settings remain enabled.

---

## Plan Self-Review

- Spec coverage: explicit status tools, Hook fields, Stop enforcement, protocol continuation, task identity, project/task names, subagent exclusion, private outbox, state persistence, source cutover, retries, native notifications, deployment, rollback, and all acceptance cases are assigned to tasks.
- Placeholder scan: the plan contains no TBD/TODO/“implement later” steps.
- Type consistency: `StructuredLifecycleEvent`, `HookTaskState`, `StructuredLifecycleService`, and `completionSource` are defined once and consumed by later tasks with the same names.
- Scope: one plugin plus one existing daemon constitutes one tightly coupled deliverable; no unrelated `cli2im` refactor is included.
