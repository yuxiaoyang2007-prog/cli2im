# Codex Feishu Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send distinct orange “needs attention” and green “task completed” cards from `codexbot` for every supported local Codex task, with project and task names, while leaving native Codex notifications enabled.

**Architecture:** Extend the existing `cli2im` daemon with a Codex JSONL monitor, a user-only Unix socket for `PermissionRequest` hooks, persistent deduplication/retry state in the existing SQL.js database, and a Feishu notification router. Reuse the current `codexbot` adapter and add `/notify-me` for an allowlisted user to bind one private chat safely.

**Tech Stack:** Node.js 22, TypeScript, SQL.js, Feishu Node SDK, Vitest, esbuild, Codex JSONL lifecycle events, Codex user-level hooks.

## Global Constraints

- Keep ChatGPT Work, Codex Desktop, and Codex CLI native notifications enabled and unchanged.
- Support local/synced ChatGPT Work, Codex Desktop, CLI, IDE, and `codexbot` sessions; do not claim coverage for cloud-only web tasks.
- Cards must always include `projectName` and `taskName`; use explicit fallback labels when metadata is unavailable.
- Do not send raw prompts, commands, tool arguments, code, diffs, logs, full local paths, credentials, environment variables, or full agent output to Feishu.
- Do not add direct approval or answer controls to Feishu cards.
- Use orange for `needs_attention` and green for `completed`.
- Target healthy-network delivery time is at most 3 seconds.
- Retry Feishu delivery after 1 second, 5 seconds, and 20 seconds; mark delivery delayed after 30 seconds.
- Use `~/.cli2im/codex-notify.sock` with current-user-only permissions; do not put a token in the hook command.
- Use TDD for every behavior change and preserve unrelated working-tree changes.
- Before editing production config, restarting `com.cli2im.bridge`, or deploying `dist`, verify the machine in the Feishu network asset ledger.

---

## File Map

- `src/types.ts`: add notification config and card-header color contracts.
- `src/config/loader.ts`: validate the narrow `notifications.codex` config.
- `src/platforms/feishu/adapter.ts`: render approved Feishu header colors.
- `src/session/store.ts`: persist binding, file cursors, dedupe keys, retry payloads, and delivery state.
- `src/notifications/types.ts`: notification-domain types shared by parser, monitor, router, and service.
- `src/notifications/metadata.ts`: project/task extraction, source labeling, length limits, and secret/path redaction.
- `src/notifications/codex-events.ts`: parse only the required Codex rollout and permission-hook fields.
- `src/notifications/monitor.ts`: baseline and tail active Codex JSONL files without replaying history.
- `src/notifications/socket-server.ts`: receive sanitized approval events over a protected Unix socket.
- `src/notifications/hook-client.ts`: small hook executable that sanitizes stdin and writes one socket event.
- `src/notifications/card.ts`: build orange and green cards from allowlisted fields.
- `src/notifications/router.ts`: dedupe, route, retry, and mark delivery state.
- `src/notifications/service.ts`: own monitor, socket, router, and lifecycle.
- `src/pipeline.ts`: register `/notify-me` as a bridge command.
- `src/index.ts`: wire the notification service and private-chat binding command into the daemon lifecycle.
- `esbuild.config.mjs`: build `dist/codex-notify-hook.js` alongside the daemon and CLI.
- `config.example.yaml`: document the two-field notification config.
- `tests/*notification*.test.ts`: focused unit and integration coverage.
- `~/.cli2im/config.yaml`: enable `notifications.codex` for production after asset verification.
- `~/.codex/config.toml`: merge one inline `PermissionRequest` hook after backing up the file; preserve `[tui]` and `notify` unchanged.

---

### Task 1: Configuration and Feishu card color contracts

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config/loader.ts`
- Modify: `src/platforms/feishu/adapter.ts`
- Modify: `config.example.yaml`
- Test: `tests/config-loader.test.ts`
- Test: `tests/feishu-adapter.test.ts`

**Interfaces:**
- Produces: `AppConfig.notifications?.codex: { enabled: boolean; botName: string }`
- Produces: `CardPayload.headerTemplate?: 'orange' | 'green'`

- [ ] **Step 1: Write failing config and card tests**

Add this helper inside the existing `describe('loadConfig')` block, reusing its `tmpDir`:

```ts
function loadNotificationFixture(notificationYaml: string): AppConfig {
  const configPath = join(tmpDir, `notifications-${Date.now()}.yaml`);
  writeFileSync(configPath, `
bots:
  codexbot:
    agent: codex
    platform: feishu
    feishu: { appId: app, appSecret: secret }
    workingDirectory: /tmp/project
    allowFrom: [ou_user]
    permissionMode: blacklist
agents:
  codex: { binary: /opt/homebrew/bin/codex }
session: { maxActive: 64, idleResetMinutes: 120, dbPath: /tmp/cli2im.db }
dangerousPatterns: []
streaming: { intervalMs: 200, minDeltaChars: 30, highWaterMark: 1048576 }
server: { port: 3900, host: 127.0.0.1, token: test }
newMessageBehavior: queue
${notificationYaml}
`);
  return loadConfig(configPath);
}
```

Import `AppConfig` from `src/types.ts`, then add these cases to the existing suites:

```ts
it('accepts a valid Codex notification config', () => {
  const config = loadNotificationFixture(`
notifications:
  codex:
    enabled: true
    botName: codexbot
`);
  expect(config.notifications?.codex).toEqual({ enabled: true, botName: 'codexbot' });
});

it.each([
  ['enabled', 'yes'],
  ['botName', ''],
])('rejects invalid notifications.codex.%s', (field, value) => {
  expect(() => loadNotificationFixture(`
notifications:
  codex:
    enabled: ${field === 'enabled' ? value : 'true'}
    botName: ${field === 'botName' ? JSON.stringify(value) : 'codexbot'}
`)).toThrow('Config error: notifications.codex');
});
```

```ts
it('renders an allowlisted Feishu card header color', async () => {
  const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
  const client = larkMocks.clients[0];
  await adapter.send('oc_1', {
    card: {
      type: 'final',
      title: '🟠 待你处理',
      headerTemplate: 'orange',
      content: '项目：cli2im',
    },
  });
  const createMock = client.im.message.create as ReturnType<typeof vi.fn>;
  const request = createMock.mock.calls[0]?.[0] as { data: { content: string } };
  const sentCard = JSON.parse(request.data.content);
  expect(sentCard.header).toEqual({
    title: { tag: 'plain_text', content: '🟠 待你处理' },
    template: 'orange',
  });
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run tests/config-loader.test.ts tests/feishu-adapter.test.ts
```

Expected: failures because `notifications` and `headerTemplate` are not defined or validated.

- [ ] **Step 3: Add the minimal contracts and validation**

Add to `src/types.ts`:

```ts
export interface CodexNotificationConfig {
  enabled: boolean;
  botName: string;
}

export interface CardPayload {
  type: 'streaming' | 'final' | 'permission' | 'error' | 'session_list';
  content: string;
  title?: string;
  headerTemplate?: 'orange' | 'green';
  buttons?: CardButton[];
  rawElements?: object[];
}

// Inside AppConfig:
notifications?: {
  codex: CodexNotificationConfig;
};
```

Add to `validateConfig()`:

```ts
if (config.notifications?.codex) {
  const codex = config.notifications.codex;
  if (typeof codex.enabled !== 'boolean') {
    throw new Error('Config error: notifications.codex.enabled must be a boolean');
  }
  if (typeof codex.botName !== 'string' || codex.botName.trim().length === 0) {
    throw new Error('Config error: notifications.codex.botName must be a non-empty string');
  }
  if (!config.bots[codex.botName]) {
    throw new Error('Config error: notifications.codex.botName must name an existing bot');
  }
  if (config.bots[codex.botName].platform !== 'feishu') {
    throw new Error('Config error: notifications.codex.botName must use the feishu platform');
  }
}
```

Update `buildCardJson()` so the header is:

```ts
header: card.title
  ? {
      title: { tag: 'plain_text', content: card.title },
      ...(card.headerTemplate ? { template: card.headerTemplate } : {}),
    }
  : undefined,
```

Document only:

```yaml
notifications:
  codex:
    enabled: true
    botName: codexbot
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same Vitest command. Expected: both suites pass with zero failures.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/config/loader.ts src/platforms/feishu/adapter.ts config.example.yaml tests/config-loader.test.ts tests/feishu-adapter.test.ts
git commit -m "feat(notifications): add config and card color contracts"
```

---

### Task 2: Persistent notification binding, cursors, and delivery state

**Files:**
- Create: `src/notifications/types.ts`
- Modify: `src/session/store.ts`
- Test: `tests/notification-store.test.ts`

**Interfaces:**
- Produces: `NotificationBinding`, `NotificationCursor`, `CodexNotificationEvent`, `StoredNotificationDelivery`
- Produces: `SessionStore.bindNotificationTarget()`, `getNotificationBinding()`, `getNotificationCursor()`, `upsertNotificationCursor()`, `enqueueNotification()`, `listPendingNotifications()`, `markNotificationAttempt()`, `markNotificationDelivered()`, `markNotificationFailed()`

- [ ] **Step 1: Write failing persistence tests**

Create an in-memory store test covering replacement, cursor upsert, dedupe, and retry reload:

```ts
function completionEvent(overrides: Partial<CodexNotificationEvent> = {}): CodexNotificationEvent {
  return {
    eventKey: 'evt_default', kind: 'completed', sessionId: 'session_1', turnId: 'turn_1',
    projectName: 'cli2im', taskName: '通知测试', surface: 'CLI', occurredAt: 1000,
    durationMs: 2500, shortTaskId: 'session_', ...overrides,
  };
}

it('replaces one bot private-chat binding without creating duplicates', async () => {
  const store = await SessionStore.create(':memory:');
  await store.bindNotificationTarget({
    botName: 'codexbot', platform: 'feishu', chatId: 'oc_first', userId: 'ou_user', updatedAt: 10,
  });
  await store.bindNotificationTarget({
    botName: 'codexbot', platform: 'feishu', chatId: 'oc_second', userId: 'ou_user', updatedAt: 20,
  });
  expect(await store.getNotificationBinding('codexbot')).toMatchObject({ chatId: 'oc_second' });
});

it('persists a byte cursor by file identity', async () => {
  const store = await SessionStore.create(':memory:');
  await store.upsertNotificationCursor({
    filePath: '/tmp/rollout.jsonl', fileId: '1:2', byteOffset: 48, updatedAt: 20,
  });
  expect(await store.getNotificationCursor('/tmp/rollout.jsonl')).toMatchObject({
    fileId: '1:2', byteOffset: 48,
  });
});

it('enqueues one delivery per event key and reloads pending payload', async () => {
  const store = await SessionStore.create(':memory:');
  const event = completionEvent({ eventKey: 'evt_1' });
  expect(await store.enqueueNotification(event)).toBe(true);
  expect(await store.enqueueNotification(event)).toBe(false);
  expect(await store.listPendingNotifications()).toHaveLength(1);
});
```

- [ ] **Step 2: Run the new suite and verify RED**

```bash
npx vitest run tests/notification-store.test.ts
```

Expected: TypeScript or runtime failures because notification store methods do not exist.

- [ ] **Step 3: Define domain types**

Create `src/notifications/types.ts` with these exact public shapes:

```ts
export type CodexNotificationKind = 'needs_attention' | 'completed';
export type AttentionReason = 'approval' | 'question';
export type CodexSurface = 'ChatGPT Work' | 'Codex Desktop' | 'CLI' | 'IDE' | 'codexbot' | 'Codex';

export interface CodexNotificationEvent {
  eventKey: string;
  kind: CodexNotificationKind;
  reason?: AttentionReason;
  sessionId: string;
  turnId: string;
  requestId?: string;
  projectName: string;
  taskName: string;
  surface: CodexSurface;
  occurredAt: number;
  durationMs?: number;
  shortTaskId: string;
}

export interface NotificationBinding {
  botName: string;
  platform: 'feishu';
  chatId: string;
  userId: string;
  updatedAt: number;
}

export interface NotificationCursor {
  filePath: string;
  fileId: string;
  byteOffset: number;
  updatedAt: number;
}

export interface StoredNotificationDelivery {
  event: CodexNotificationEvent;
  status: 'pending' | 'delivered' | 'failed' | 'discarded';
  attempts: number;
  nextRetryAt: number | null;
  deliveredAt: number | null;
}
```

- [ ] **Step 4: Add SQL tables and exact store methods**

Create tables in `SessionStore.create()`:

```sql
CREATE TABLE IF NOT EXISTS notification_bindings (
  bot_name TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notification_cursors (
  file_path TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  byte_offset INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notification_deliveries (
  event_key TEXT PRIMARY KEY,
  event_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  next_retry_at INTEGER,
  delivered_at INTEGER
);
```

Implement the named methods with parameterized SQL. `enqueueNotification()` must use `INSERT OR IGNORE` and return `this.db.getRowsModified() === 1`. `markNotificationDelivered()` must replace `event_json` with `'{}'` so delivered rows retain only the dedupe key and timestamps. Call `save()` immediately for binding, enqueue, delivered, and failed transitions; cursor updates may call `save()` once per processed file chunk.

- [ ] **Step 5: Run store tests and verify GREEN**

```bash
npx vitest run tests/notification-store.test.ts
```

Expected: all persistence cases pass.

- [ ] **Step 6: Commit**

```bash
git add src/notifications/types.ts src/session/store.ts tests/notification-store.test.ts
git commit -m "feat(notifications): persist bindings cursors and deliveries"
```

---

### Task 3: Codex event parsing and safe metadata resolution

**Files:**
- Create: `src/notifications/codex-events.ts`
- Create: `src/notifications/metadata.ts`
- Test: `tests/codex-notification-events.test.ts`
- Test: `tests/codex-notification-metadata.test.ts`

**Interfaces:**
- Produces: `parseRolloutLine(line: string): ParsedRolloutLine | null`
- Produces: `normalizePermissionHook(input: unknown, now: number): PermissionHookEvent | null`
- Produces: `eventKey(parts: string[]): string`
- Produces: `new NotificationMetadataResolver({ codexDir, resolveGitRoot? })` and `resolve(input): Promise<{ projectName; taskName; surface; shortTaskId }>`
- Produces: `sanitizeTaskTitle(value: string): string`

- [ ] **Step 1: Write failing parser tests with minimal fixtures**

Cover only shapes observed in current Codex JSONL:

```ts
it('parses request_user_input as a question event without retaining arguments', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'function_call', name: 'request_user_input', call_id: 'call_1',
      arguments: '{"questions":[{"question":"secret question"}]}',
      internal_chat_message_metadata_passthrough: { turn_id: 'turn_1' },
    },
  });
  expect(parseRolloutLine(line)).toEqual({ type: 'question', turnId: 'turn_1', requestId: 'call_1' });
  expect(JSON.stringify(parseRolloutLine(line))).not.toContain('secret question');
});

it('parses task_complete and turn_aborted separately', () => {
  expect(parseRolloutLine(JSON.stringify({
    type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn_1', completed_at: 1000, duration_ms: 2500 },
  }))).toEqual({ type: 'completed', turnId: 'turn_1', occurredAt: 1000, durationMs: 2500 });
  expect(parseRolloutLine(JSON.stringify({
    type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn_1', reason: 'interrupted' },
  }))).toEqual({ type: 'aborted', turnId: 'turn_1' });
});
```

For hook normalization, assert the output excludes `tool_input`, `command`, and `arguments`, and uses `approval_id`, `request_id`, or `tool_use_id` in that order before a time-window digest.

- [ ] **Step 2: Write failing metadata tests**

```ts
it('removes secrets URLs home paths and instruction wrappers from a task title', () => {
  const title = sanitizeTaskTitle(`
<environment_context>ignored</environment_context>
请部署 /Users/test/private/repo token=sk-live-secret https://example.test/a?token=abc
`);
  expect(title).toBe('请部署 repo token=[REDACTED] https://example.test/a');
  expect(title).not.toContain('/Users/test');
  expect(title).not.toContain('sk-live-secret');
});

it('resolves project and title with explicit fallbacks', async () => {
  const resolver = new NotificationMetadataResolver({
    codexDir: '/tmp/missing-codex-dir',
    resolveGitRoot: async () => null,
  });
  const result = await resolver.resolve({
    sessionId: 'abcdefgh-1234', cwd: '/missing/project', source: 'unknown', userText: '', attachmentName: undefined,
  });
  expect(result).toMatchObject({
    projectName: 'project', taskName: '未命名任务 · abcdefgh', surface: 'Codex', shortTaskId: 'abcdefgh',
  });
});
```

- [ ] **Step 3: Run both suites and verify RED**

```bash
npx vitest run tests/codex-notification-events.test.ts tests/codex-notification-metadata.test.ts
```

Expected: module-not-found failures.

- [ ] **Step 4: Implement strict parsers**

`parseRolloutLine()` must parse JSON once, switch on outer and payload types, and construct fresh objects containing only allowlisted scalar fields. Add parsed variants for `session_meta`, `turn_context`, user message title candidates, `question`, `completed`, and `aborted`. Never return the original payload.

Implement `eventKey()` as:

```ts
export function eventKey(parts: string[]): string {
  return createHash('sha256').update(parts.join('\u001f')).digest('hex').slice(0, 24);
}
```

Implement the approval fallback using `Math.floor(now / 10_000)` and the allowlisted identifiers only.

- [ ] **Step 5: Implement deterministic metadata and redaction**

Use `execFile('git', ['-C', cwd, 'rev-parse', '--show-toplevel'])` without a shell and cache results per `cwd`. Read `session_index.jsonl` through the existing bounded head/tail helper and map `sessionId -> thread_name`. Apply title priority: thread name, clean user text, attachment label, explicit unnamed fallback.

The redactor must cover these concrete patterns before truncation:

```ts
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/gi;
const OPENAI_STYLE_KEY = /\b(?:sk|sess)-[A-Za-z0-9_-]{12,}\b/g;
const NAMED_SECRET = /\b(token|password|passwd|secret|cookie|api[_-]?key)\s*[:=]\s*\S+/gi;
const HOME_PATH = /\/(?:Users|home)\/[^/\s]+\//g;
const URL_QUERY = /(https?:\/\/[^\s?#]+)(?:[?#]\S*)/g;
```

Strip `<environment_context>`, `<INSTRUCTIONS>`, `# AGENTS.md instructions`, code fences, and non-user wrapper blocks before selecting the first meaningful line. Truncate by Unicode code points to 40 CJK-heavy or 80 Latin-heavy characters.

- [ ] **Step 6: Run both suites and verify GREEN**

Run the same focused command. Expected: all parser and metadata tests pass, and fixture assertions prove raw secret text is absent.

- [ ] **Step 7: Commit**

```bash
git add src/notifications/codex-events.ts src/notifications/metadata.ts tests/codex-notification-events.test.ts tests/codex-notification-metadata.test.ts
git commit -m "feat(notifications): parse Codex events and safe metadata"
```

---

### Task 4: JSONL monitor and protected approval socket

**Files:**
- Create: `src/notifications/monitor.ts`
- Create: `src/notifications/socket-server.ts`
- Create: `src/notifications/hook-client.ts`
- Modify: `esbuild.config.mjs`
- Test: `tests/codex-notification-monitor.test.ts`
- Test: `tests/codex-notification-socket.test.ts`
- Test: `tests/codex-notification-hook-client.test.ts`

**Interfaces:**
- Consumes: `parseRolloutLine()`, `normalizePermissionHook()`, notification cursor store methods
- Produces: `CodexEventMonitor.start(): Promise<void>`, `stop(): Promise<void>`, `processFile(path): Promise<void>`
- Produces: `CodexNotificationSocket.start(): Promise<void>`, `stop(): Promise<void>`
- Produces: executable `dist/codex-notify-hook.js`

- [ ] **Step 1: Write failing monitor tests**

Use a temporary `sessions` directory and real files. Cover:

```ts
it('baselines existing bytes and emits only appended events', async () => {
  await writeFile(file, historicalCompletion + '\n');
  await monitor.start();
  expect(onEvent).not.toHaveBeenCalled();
  await appendFile(file, questionLine + '\n');
  await monitor.processFile(file);
  expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'question' }));
});

it('keeps an incomplete final line unread until the newline arrives', async () => {
  await monitor.start();
  await appendFile(file, questionLine.slice(0, 20));
  await monitor.processFile(file);
  expect(onEvent).not.toHaveBeenCalled();
  await appendFile(file, questionLine.slice(20) + '\n');
  await monitor.processFile(file);
  expect(onEvent).toHaveBeenCalledTimes(1);
});
```

Add rotation coverage by replacing the file with a new inode and proving it is baselined instead of replayed.

- [ ] **Step 2: Write failing socket and hook-client tests**

Use a temporary Unix socket. Assert mode `0600`, accepted payload size at 8192 bytes, rejection at 8193 bytes, malformed JSON isolation, and one sanitized approval callback. For the hook client, feed stdin-shaped input containing `tool_input.command` and assert the serialized socket payload contains no command.

- [ ] **Step 3: Run the three suites and verify RED**

```bash
npx vitest run tests/codex-notification-monitor.test.ts tests/codex-notification-socket.test.ts tests/codex-notification-hook-client.test.ts
```

Expected: module-not-found failures.

- [ ] **Step 4: Implement byte-accurate tailing**

On first discovery with no stored cursor, save current `stat.size` and `fileId = dev + ':' + ino`. On later changes, open the file, read bytes from `byteOffset`, process only bytes through the final newline, and persist the offset immediately after successful line handling. When `fileId` changes or size shrinks below the cursor, baseline the replacement file at its current end.

Use `watch(sessionsDir, { recursive: true })` for low latency and expose `processFile()` for deterministic tests. Filter paths by basename prefix `rollout-` and suffix `.jsonl`.

- [ ] **Step 5: Implement the protected socket and hook executable**

Use `node:net.createServer()`. Before listen, remove only a stale socket at the exact configured path; after listen, `chmod(socketPath, 0o600)`. Accumulate at most 8192 bytes plus one sentinel byte, require one newline-delimited JSON object, normalize it, invoke `onApproval`, and close the connection.

The hook client must:

```ts
export async function runHookClient(
  input: NodeJS.ReadableStream,
  socketPath = join(homedir(), '.cli2im', 'codex-notify.sock'),
): Promise<void>
```

Read at most 8192 bytes, call `normalizePermissionHook(JSON.parse(text), Date.now())`, connect with a 500 ms timeout, write one JSON line, and exit 0 for invalid input, missing socket, timeout, or connection error. Print nothing.

Add a third esbuild entry:

```js
await build({
  entryPoints: ['src/notifications/hook-client.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/codex-notify-hook.js',
  banner: { js: '#!/usr/bin/env node' },
});
```

Call `runHookClient(process.stdin)` only when the module is executed directly.

- [ ] **Step 6: Run focused tests and build**

```bash
npx vitest run tests/codex-notification-monitor.test.ts tests/codex-notification-socket.test.ts tests/codex-notification-hook-client.test.ts
npm run build
test -f dist/codex-notify-hook.js
```

Expected: all focused tests pass, build exits 0, and the hook bundle exists.

- [ ] **Step 7: Commit**

```bash
git add src/notifications/monitor.ts src/notifications/socket-server.ts src/notifications/hook-client.ts esbuild.config.mjs tests/codex-notification-monitor.test.ts tests/codex-notification-socket.test.ts tests/codex-notification-hook-client.test.ts
git commit -m "feat(notifications): monitor Codex events and approval socket"
```

---

### Task 5: Card builder, dedupe, routing, and retries

**Files:**
- Create: `src/notifications/card.ts`
- Create: `src/notifications/router.ts`
- Test: `tests/codex-notification-card.test.ts`
- Test: `tests/codex-notification-router.test.ts`

**Interfaces:**
- Consumes: `CodexNotificationEvent`, notification binding and delivery store methods, existing `PlatformAdapter.send()`
- Produces: `buildNotificationCard(event, { delayed, timeZone }): CardPayload`
- Produces: `NotificationRouter.handle(event): Promise<'delivered' | 'duplicate' | 'discarded' | 'pending'>`
- Produces: `NotificationRouter.resumePending(): Promise<void>` and `stop(): void`

- [ ] **Step 1: Write failing card tests**

Define a complete event fixture and assert exact visible content:

```ts
function attentionEvent(overrides: Partial<CodexNotificationEvent> = {}): CodexNotificationEvent {
  return {
    eventKey: 'evt_attention', kind: 'needs_attention', reason: 'approval',
    sessionId: 'abcdefgh-1234', turnId: 'turn_1', requestId: 'request_1',
    projectName: 'cli2im', taskName: '为所有 Codex 任务增加飞书提醒',
    surface: 'ChatGPT Work', occurredAt: new Date('2026-07-15T14:32:00-04:00').getTime(),
    shortTaskId: 'abcdefgh', ...overrides,
  };
}

expect(buildNotificationCard(attentionEvent(), {
  delayed: false,
  timeZone: 'America/New_York',
})).toEqual({
  type: 'final',
  title: '🟠 待你处理',
  headerTemplate: 'orange',
  content: [
    '**项目：** cli2im',
    '**任务：** 为所有 Codex 任务增加飞书提醒',
    '**原因：** 需要批准操作',
    '**位置：** ChatGPT Work',
    '**时间：** 14:32',
    '**任务 ID：** abcdefgh',
  ].join('\n'),
});
```

Add the green completion shape with completion time and formatted duration. Add a delayed case whose final line is `⚠️ 延迟送达`.

- [ ] **Step 2: Write failing router tests with fake timers**

Cover: no binding becomes `discarded`, duplicate key sends once, immediate success, failures at 0/1/5 seconds followed by success at 20 seconds, final failure after four total attempts, and `resumePending()` after a simulated restart.

Use `vi.useFakeTimers()` and inject `now`, `setTimeout`, and `clearTimeout` functions so the router has no hard-coded global timer dependency.

- [ ] **Step 3: Run both suites and verify RED**

```bash
npx vitest run tests/codex-notification-card.test.ts tests/codex-notification-router.test.ts
```

Expected: module-not-found failures.

- [ ] **Step 4: Implement allowlisted card rendering**

Escape Feishu markdown metacharacters in every value. Render only `projectName`, `taskName`, reason label, `surface`, formatted timestamps, duration, and `shortTaskId`. Do not accept raw element overrides or buttons from the event.

- [ ] **Step 5: Implement routing and retry state**

`handle()` sequence:

1. Call `enqueueNotification(event)`; return `duplicate` when false.
2. Load the configured bot binding; when missing, mark `discarded` and return.
3. Resolve the configured adapter; when absent or not Feishu, mark failed with error category `adapter_unavailable`.
4. Send immediately.
5. On failure, persist attempts and next retry before scheduling `[1000, 5000, 20000]`.
6. Mark delayed when `now() - occurredAt > 30_000`.
7. On success, clear stored card JSON through `markNotificationDelivered()`.
8. After four failed attempts total, mark `failed` and stop retrying.

Log only kind, short event key, attempt number, and error class.

- [ ] **Step 6: Run both suites and verify GREEN**

Run the same focused Vitest command. Expected: all card and retry cases pass.

- [ ] **Step 7: Commit**

```bash
git add src/notifications/card.ts src/notifications/router.ts tests/codex-notification-card.test.ts tests/codex-notification-router.test.ts
git commit -m "feat(notifications): route distinct Feishu cards with retries"
```

---

### Task 6: Daemon lifecycle and `/notify-me` private binding

**Files:**
- Create: `src/notifications/service.ts`
- Modify: `src/pipeline.ts`
- Modify: `src/index.ts`
- Test: `tests/codex-notification-service.test.ts`
- Test: `tests/pipeline.test.ts`
- Test: `tests/notify-me-command.test.ts`

**Interfaces:**
- Consumes: monitor, socket, metadata resolver, router, `AppConfig.notifications.codex`
- Produces: `CodexNotificationService.start()`, `stop()`, `bindTarget(input)`
- Changes: `handleBridgeCommand(..., botConfig, commandSender, notificationService?)`

- [ ] **Step 1: Write failing command-registration tests**

Add `/notify-me` to pipeline expectations:

```ts
expect(isBridgeCommand('/notify-me')).toBe(true);
expect(parseBridgeCommand('/notify-me')).toEqual({ command: 'notify-me', args: [] });
```

- [ ] **Step 2: Write failing binding tests**

Create a wrapper around the final `handleBridgeCommand` signature so every sender variant uses the same mocks:

```ts
async function runNotifyMe(sender: BridgeCommandSender): Promise<void> {
  await handleBridgeCommand(
    { command: 'notify-me', args: [] },
    'feishu:oc_private:codexbot',
    'codexbot',
    'oc_private',
    adapter,
    store,
    agentManager,
    handoffService,
    undefined,
    undefined,
    new Map(),
    { fastModeBySession: new Map() },
    botConfig,
    sender,
    service,
  );
}
```

Use these exact focused fixtures; the `notify-me` branch must not call the unrelated manager or handoff objects:

```ts
const adapter = {
  name: 'feishu',
  send: vi.fn().mockResolvedValue('message_1'),
} as unknown as PlatformAdapter;
const store = await SessionStore.create(':memory:');
const agentManager = {} as AgentManager;
const handoffService = {} as HandoffService;
const botConfig: BotConfig = {
  agent: 'codex', platform: 'feishu',
  feishu: { appId: 'app', appSecret: 'secret' },
  workingDirectory: '/tmp/project', allowFrom: ['ou_allowed'], permissionMode: 'blacklist',
};
const service = {
  botName: 'codexbot',
  bindTarget: vi.fn().mockResolvedValue(undefined),
} as unknown as CodexNotificationService;
```

Then cover exact outcomes:

```ts
it('binds one allowlisted Feishu private chat', async () => {
  await runNotifyMe({ platform: 'feishu', chatType: 'p2p', userId: 'ou_allowed' });
  expect(service.bindTarget).toHaveBeenCalledWith({
    botName: 'codexbot', platform: 'feishu', chatId: 'oc_private', userId: 'ou_allowed',
  });
  expect(adapter.send).toHaveBeenCalledWith('oc_private', {
    text: 'Codex 通知已绑定到当前私聊。后续只发送项目、任务和状态。',
  });
});
```

Also assert rejection for `chatType: 'group'`, the wrong bot name, Telegram, and a user absent from `allowFrom`. The pipeline already rejects non-allowlisted users before command handling; keep a second service-level check.

- [ ] **Step 3: Write failing service lifecycle test**

Assert `start()` order is router resume, socket start, monitor start; assert `stop()` order is monitor stop, socket stop, router stop. Feed a parsed question and completion event through the service and verify both reach `router.handle()` with resolved metadata and stable event keys.

- [ ] **Step 4: Run the three suites and verify RED**

```bash
npx vitest run tests/pipeline.test.ts tests/notify-me-command.test.ts tests/codex-notification-service.test.ts
```

Expected: `/notify-me` is unknown and service module is missing.

- [ ] **Step 5: Implement service orchestration**

Construct one service only when `config.notifications?.codex.enabled === true`. Pass the configured `botName`, that bot's working directory, `~/.codex/sessions`, `~/.codex/session_index.jsonl`, `~/.cli2im/codex-notify.sock`, the shared `SessionStore`, and an adapter resolver.

For each parsed event, combine monitor context with `NotificationMetadataResolver`, create the exact event key, and call `router.handle()`.

- [ ] **Step 6: Wire `/notify-me` and daemon lifecycle**

Add `notify-me` to `BRIDGE_COMMANDS`. Extend command context with:

```ts
interface BridgeCommandSender {
  platform: string;
  chatType?: string;
  userId: string;
}
```

In `handleBridgeCommand`, require:

```ts
if (
  !notificationService
  || botName !== notificationService.botName
  || commandSender.platform !== 'feishu'
  || commandSender.chatType !== 'p2p'
  || !botConfig.allowFrom.map(String).includes(commandSender.userId)
) {
  await adapter.send(chatId, { text: '通知绑定失败：请使用获授权的 codexbot 飞书私聊。' });
  break;
}
```

Start the service after Feishu adapters connect and before logging `Ready`. Stop it before disconnecting adapters. Do not modify `~/.codex/config.toml` or native notification settings in application code.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run the same three-suite command. Expected: all lifecycle and binding cases pass.

- [ ] **Step 8: Run the complete repository verification**

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: zero test failures, typecheck exit 0, build exit 0, and no whitespace errors.

- [ ] **Step 9: Commit**

```bash
git add src/notifications/service.ts src/pipeline.ts src/index.ts tests/codex-notification-service.test.ts tests/pipeline.test.ts tests/notify-me-command.test.ts
git commit -m "feat(notifications): wire global Codex Feishu alerts"
```

---

### Task 7: Production safety check, configuration, deployment, and live acceptance

**Files:**
- Read: `https://hc1flg077h.feishu.cn/base/A3jnbPlScaaqjfsgUu0ciZrLnBb?table=tblVtFvjUvQMviJ9&view=vewgRAk7oZ`
- Modify after backup: `/Users/xiaoyangyu/.cli2im/config.yaml`
- Modify after backup: `/Users/xiaoyangyu/.codex/config.toml`
- Update by build: `/Users/xiaoyangyu/projects/cli2im/dist/index.js`
- Create by build: `/Users/xiaoyangyu/projects/cli2im/dist/codex-notify-hook.js`
- Runtime: `/Users/xiaoyangyu/Library/LaunchAgents/com.cli2im.bridge.plist` is inspected but not edited.

**Interfaces:**
- Consumes: all implementation tasks
- Produces: running `com.cli2im.bridge`, bound `codexbot` private chat, live orange and green cards

- [ ] **Step 1: Verify asset ownership before machine or service changes**

Open and read the network asset ledger. Confirm the local Mac and `cli2im` environment are Joulian-owned. If the device is missing or ownership is ambiguous, stop before editing config or restarting the service and ask Joulian for the ownership decision.

Do not open the credential register unless authentication actually fails and a credential is required.

- [ ] **Step 2: Capture clean pre-deploy evidence without printing secrets**

Run field-specific checks only:

```bash
git status --short --branch
npm test
npm run typecheck
npm run build
codex --strict-config doctor --json
launchctl print gui/$(id -u)/com.cli2im.bridge
```

For `launchctl`, filter output to service state, PID, program, working directory, and last exit code before displaying it. Never print the environment block.

- [ ] **Step 3: Back up persistent production state**

Create timestamped copies of:

- `~/.cli2im/config.yaml`
- `~/.cli2im/cli2im.db`
- `~/.codex/config.toml`
- current `dist/index.js` and source map

Backups must remain outside Git and must not be deleted during this task.

- [ ] **Step 4: Enable the narrow cli2im config**

Merge exactly:

```yaml
notifications:
  codex:
    enabled: true
    botName: codexbot
```

Parse the edited YAML with the project loader in the existing LaunchAgent environment without printing substituted secret values.

- [ ] **Step 5: Merge the inline Codex PermissionRequest hook**

Because `~/.codex/config.toml` already contains `[hooks.state]`, do not create `~/.codex/hooks.json`. Add this inline hook before `[hooks.state]` and preserve the existing `notify` and `[tui]` blocks byte-for-byte:

```toml
[[hooks.PermissionRequest]]
matcher = "*"

[[hooks.PermissionRequest.hooks]]
type = "command"
command = '/opt/homebrew/bin/node /Users/xiaoyangyu/projects/cli2im/dist/codex-notify-hook.js'
timeout = 2
```

Validate with Python `tomllib` and `codex --strict-config doctor --json`; the required signal is `config.load: ok`.

- [ ] **Step 6: Prepare one synthetic rollout, deploy, and restart the existing service**

Before restart, create one empty task-scoped fixture named `rollout-cli2im-notification-acceptance-<freshUuid>.jsonl` in the current date directory under `~/.codex/sessions/`; fail instead of overwriting if that exact path already exists. It must contain no user data. Record its absolute path and remove it only after Step 8 succeeds; this file is temporary state created solely by this task.

Build once more from the committed source, then restart the existing LaunchAgent without editing its plist. Wait for `[cli2im] Ready`, then verify the stored cursor for the empty acceptance fixture is byte offset `0`. This proves the monitor has baselined the file before any synthetic event is appended. Verify only safe service fields; never print environment variables or message payloads.

- [ ] **Step 7: Bind the recipient safely**

Ask Joulian to send `/notify-me` in the desired `codexbot` private chat. Confirm the bot responds:

```text
Codex 通知已绑定到当前私聊。后续只发送项目、任务和状态。
```

Do not infer a recipient from recent sessions and do not send to every allowlisted user.

- [ ] **Step 8: Run one deterministic live orange and green acceptance test**

Use only the empty fixture prepared in Step 6. Append these newline-delimited objects in order, using a fresh UUID for `sessionId`, `turn_acceptance` for `turnId`, `/Users/xiaoyangyu/projects/cli2im` for `cwd`, and `Codex 飞书通知上线验收` for the user text:

```json
{"type":"session_meta","payload":{"id":"<sessionId>","cwd":"/Users/xiaoyangyu/projects/cli2im","source":"cli"}}
{"type":"turn_context","payload":{"turn_id":"turn_acceptance","cwd":"/Users/xiaoyangyu/projects/cli2im"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Codex 飞书通知上线验收"}],"internal_chat_message_metadata_passthrough":{"turn_id":"turn_acceptance"}}}
```

Wait until the persisted cursor equals the file size. Then invoke the installed hook once with this non-sensitive stdin payload:

```json
{"hook_event_name":"PermissionRequest","session_id":"<sessionId>","turn_id":"turn_acceptance","cwd":"/Users/xiaoyangyu/projects/cli2im","tool_name":"acceptance_test","tool_use_id":"approval_acceptance"}
```

Record the hook invocation time and the successful Feishu send time from safe notification-module timestamps. The orange card must be generated from the hook path. Next append exactly:

```json
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn_acceptance","completed_at":<currentEpochMs>,"duration_ms":1000}}
```

Wait until its cursor is persisted and record the successful Feishu send time. The green card must be generated from the JSONL path. Invoke the same approval payload again and append the same completion line again; after the retry windows have elapsed, the delivery count must remain exactly two. Remove only this temporary acceptance fixture after the evidence is captured.

Verify:

- orange card title and header color;
- green card title and header color;
- correct project and task names;
- no raw command, prompt, full path, environment value, or credential;
- one card per event after replaying the same event;
- healthy-network delivery at most 3 seconds;
- native Codex notifications still appear and `[tui]` remains unchanged.

Temporary test files created solely for this acceptance may be removed after the test; do not delete backups, binding data, config, or user files.

- [ ] **Step 9: Final production verification**

Run fresh:

```bash
npm test
npm run typecheck
npm run build
git status --short --branch
```

Verify service state, socket mode `0600`, one active notification binding, zero pending/failed test deliveries, and no secret-bearing log lines from the notification module.

- [ ] **Step 10: Record the deployed commit without publishing the repository**

If Task 6 already committed all source changes, create no empty commit. Do not commit machine-local config, database, backups, generated files, or secrets. Record the local commit hash used by the running service. Do not push `main`: this rollout is the local `com.cli2im.bridge` deployment, and repository publication is outside the current authorization.

---

## Completion Evidence

Completion requires all of the following in the same final verification run:

- repository tests, typecheck, and build pass;
- Codex strict config reports `config.load: ok`;
- `com.cli2im.bridge` is running the new build;
- `codex-notify.sock` is current-user-only;
- `/notify-me` binding targets one allowlisted Feishu private chat;
- one orange card and one green card arrive with correct project and task names;
- replayed events do not duplicate;
- native Codex notifications remain enabled;
- no sensitive value appears in notification payloads, logs, commits, or command output.
