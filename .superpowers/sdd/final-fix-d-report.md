# Final Whole-Review Fix Batch D Report

Date: 2026-07-15
Base: `09acd4717cb584b2eff0595e1a318bf29b8f831b`

## Scope

- Accept real `request_user_input` turn metadata from both
  `internal_chat_message_metadata_passthrough.turn_id` and `metadata.turn_id`.
- Preserve a no-ID question only as the allowlisted type, request ID, and optional timestamp;
  associate it only when the rollout has exactly one active `turn_context`.
- Abort router delivery before monitor/socket callback drains can block service shutdown.
- Remove raw inbound user, message, mention, recipient, bot-open-id, session, and transcript values
  from the newly audited pipeline logs.
- Return `failed` after the fourth external delivery failure while persisting terminal state.

No machine configuration, deployment, credential, ledger, or production service state was changed.

## RED evidence

Command:

```text
npx vitest run tests/codex-notification-events.test.ts tests/codex-notification-service.test.ts tests/notify-me-command.test.ts tests/codex-notification-router.test.ts
```

Observed before implementation:

- 4 test files failed.
- 7 tests failed and 85 passed.
- SDK metadata and no-ID parser fixtures returned `null`.
- The unique-active-turn service fixture routed no notification.
- The shutdown race returned `timeout` because producer drain preceded router abort.
- The safe inbound logging function did not exist.
- The fourth-failure result was `pending` instead of `failed`.

One timer API return-value assertion was identified as a test defect during RED and corrected before
using that test as evidence. The separate direct fourth-attempt test remained RED for the production
behavior.

## GREEN implementation

### Real request_user_input shapes and safe association

- `ParsedRolloutLine` permits `turnId` to be absent only for `question` events.
- The parser reads turn IDs from the two observed nested metadata shapes and never copies arguments,
  question text, or unrelated metadata into the parsed object.
- `CodexNotificationService` tracks active `turn_context` IDs per rollout.
- A no-ID question is routed only when exactly one active turn exists; zero, multiple, completed, and
  aborted contexts are dropped.
- The associated notification uses the existing stable key:
  `sessionId + associated turnId + requestId + question`.

### Deadlock-free shutdown

- Service stop is idempotent through one shared stop promise.
- Monitor and socket quiesce are initiated before router stop, but all three stop operations run
  concurrently. Router abort therefore unblocks an adapter send that a producer callback is awaiting.
- The service waits for every stop promise before it resolves. Existing daemon shutdown continues to
  disconnect adapters and close the store only after service stop settles.
- The service-level regression uses a real router and store plus an adapter send held on its
  `AbortSignal`. It proves both stop calls resolve, the signal is aborted, the producer drain finishes,
  and a callback invoked after store close causes no new adapter send or store access.

### Privacy logging

- Inbound logging now emits only normalized chat category, relay/command categories, lengths/counts,
  and presence flags. It does not interpolate user IDs, chat IDs, message text, mentions, bot open IDs,
  session IDs, transcripts, or transport errors.
- Spawn/resume and delivery-failure logs in the audited path now use fixed categories plus config-safe
  bot/agent names.
- The `/notify-me` integration regression uses unique synthetic user, prompt, mention, and recipient
  secrets in the same binding flow and asserts every secret is absent while the safe summary and binding
  action are present.

### Fourth delivery failure

- `handleExternalFailure` persists failed state and returns the explicit `failed` result at attempt four.
- Regression coverage checks the exact result, one fourth send, terminal persistence, and no fifth send.

## Verification evidence

Focused regression and adjacent callback suite:

```text
npx vitest run tests/codex-notification-events.test.ts tests/codex-notification-service.test.ts tests/notify-me-command.test.ts tests/codex-notification-router.test.ts tests/runtime-callbacks.test.ts
```

Result: 5 files passed, 117 tests passed, 0 failed.

Full suite:

```text
npm test
```

Result: 60 files passed, 879 tests passed, 0 failed.

Type and build:

```text
npm run typecheck
npm run build
```

Result: both exited 0; build reported `Build complete`.

Diff and privacy checks:

```text
git diff --check
rg -n "incoming .*from=|mentions=.*text=|botOpenId=|STT transcribed for|STT failed for .*session|resuming session .*scrubLog|message not delivered .*session=" src/index.ts
rg -n "unique_private_(user|prompt|mention|chat)|private (structural|no-id|active|dropped) secret" src
```

Result: `git diff --check` exited 0 and both source scans returned no matches.

## Fix Review 1

### Findings addressed

1. The generated Feishu SDK request promises do not honor an `AbortSignal` field placed on the
   request object. A never-settling SDK promise could therefore hold a router callback and daemon
   shutdown indefinitely.
2. `readHeadTailWindow()` is intentionally bounded and can omit lifecycle records from the middle
   of a rollout. A single apparent active turn reconstructed from that window is not trustworthy for
   a `request_user_input` event without a turn ID.
3. Startup rollback stopped monitor and socket sequentially before stopping the router. A socket
   callback waiting on router delivery could therefore prevent the router abort from ever starting.

### RED evidence

Command:

```text
npx vitest run tests/feishu-adapter.test.ts tests/codex-notification-service.test.ts
```

Observed before the review fix:

- 2 files failed; 5 tests failed and 41 passed.
- A large head/tail fixture routed the no-ID question against the stale head turn.
- Callback-blocked startup rollback returned `timeout`.
- A real `FeishuAdapter` with a never-settling generated SDK create promise made service stop return
  `timeout`.
- The adapter still forwarded a discarded `signal` property into the generated SDK request payload.
- A never-settling card patch had no local timeout and hit the test runner's five-second timeout.

### Implementation

- Added a ten-second local Feishu SDK promise boundary for text/card create and text/card patch.
- Already-aborted and live-aborted operations reject with a fixed `AbortError` and safe message.
- Timeout rejects with `FeishuSdkBoundaryError`, category `feishu_request_timeout`, and a fixed safe
  message. Router failure classification records only that category.
- The boundary does not claim to cancel the underlying SDK HTTP request. It keeps resolve/reject
  handlers attached after local abort/timeout so late SDK settlement is consumed. Create retries retain
  the same UUID recovery behavior, while delayed-card patch retries retain same-message full-card
  idempotency.
- SDK request payloads no longer receive the ineffective signal field for the notification-relevant
  calls.
- Rollout context now tracks whether active-turn lifecycle state is trusted. Bounded hydration remains
  untrusted and cannot associate a no-ID question. A fully observed live `turn_context` resets stale
  hydrated state and establishes trusted state; completed/aborted events remove active turns. Explicit
  turn-ID events continue to route independently of this trust flag.
- Startup rollback now initiates attempted monitor/socket quiesce and router stop concurrently, then
  awaits every stop promise. The cleanup promise is reused by later `stop()` calls.

### Verification evidence

Focused:

```text
npx vitest run tests/feishu-adapter.test.ts tests/codex-notification-service.test.ts tests/codex-notification-router.test.ts
```

Result: 3 files passed, 74 tests passed, 0 failed.

Full verification:

```text
npm test
npm run typecheck
npm run build
git diff --check
```

Result: 60 files passed, 884 tests passed, 0 failed; typecheck and build exited 0; build reported
`Build complete`; diff check exited 0.
