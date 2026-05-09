# Bot-to-Bot Relay Implementation Plan

Based on design spec: `docs/2026-05-09-bot-to-bot-relay-design.md`

## Step 1: Type Additions (`src/types.ts`)

Add to `BotConfig`:
```typescript
relay?: {
  enabled: boolean;
  maxConsecutiveRounds?: number; // default 10
};
```

Add to `InboundMessage`:
```typescript
isRelay?: boolean;
```

Add to `SenderInfo` (in `pipeline.ts`):
```typescript
botName?: string;
```

## Step 2: RelayManager (`src/relay/manager.ts`) — New File

Create `RelayManager` class:

- `registerBot(botName, chatId, maxRounds)` — lazy registration, idempotent. Updates `maxRounds` to `min(existing, new)`.
- `getRelayTargets(sourceBotName, chatId)` — returns other relay-enabled bot names in same chat. Empty if source not registered, only one bot, or rounds exceeded.
- `getBotsInChat(chatId)` — returns all registered bot names for a chat.
- `onHumanMessage(chatId)` — resets `consecutiveRounds` to 0.
- `incrementAndCheck(chatId)` — increments counter, returns `true` if limit reached.

Internal data: `Map<string, RelayGroup>` keyed by `chatId`.

```typescript
interface RelayGroup {
  botNames: Set<string>;
  consecutiveRounds: number;
  maxRounds: number;
}
```

Export the class.

## Step 3: Relay Delivery (`src/relay/deliver.ts`) — New File

Export `relayToOtherBots(sourceBotName, chatId, text, deps)`:

1. Call `relayManager.getRelayTargets(sourceBotName, chatId)` — if empty, return.
2. Call `relayManager.incrementAndCheck(chatId)` — if true, send ONE pause notification via `deps.adapters.get(relayManager.getBotsInChat(chatId)[0])`, return.
3. For each target bot: build synthetic `InboundMessage` with `isRelay: true`, `userId: 'relay:${sourceBotName}'`, `chatType: 'group'`. Enqueue via `deps.queue.enqueue(chatId, () => processor(msg))`.

Deps interface:
```typescript
interface RelayDeps {
  relayManager: RelayManager;
  config: AppConfig;
  agentManager: AgentManager;
  adapters: Map<string, PlatformAdapter>;
  messageProcessors: Map<string, (msg: InboundMessage) => Promise<void>>;
  queue: ChatQueue;
}
```

## Step 4: Pipeline Changes (`src/pipeline.ts`)

1. Add `botName?: string` to `SenderInfo` interface.
2. Update `buildSenderHeader`: include `bot` attribute when `sender.botName` is set.
3. In `getGroupMessageSkipReason`: add early return `if (msg.isRelay) return undefined;` at top.
4. In `InboundPipeline.process()`: skip `sanitizeInput` for relay messages (`if (!msg.isRelay) msg.text = sanitizeInput(msg.text)`).
5. In `InboundPipeline.process()`: skip `allowFrom` check for relay messages.

## Step 5: Config Validation (`src/config/loader.ts`)

1. Validate `relay` fields if present: `enabled` must be boolean, `maxConsecutiveRounds` must be positive number if set.
2. After validating all bots: if multiple bots have `relay.enabled: true` with different platforms, `console.warn` about cross-platform relay limitation.

## Step 6: Main Integration (`src/index.ts`)

1. Import `RelayManager` and `relayToOtherBots`.
2. Instantiate `RelayManager` in `main()`.
3. Create `messageProcessors` map (`Map<string, (msg: InboundMessage) => Promise<void>>`) before the adapter loop.
4. In the adapter loop, store each processor: `messageProcessors.set(botName, processMessage)`.
5. In `createMessageProcessor`:
   - At top of returned function: lazy relay registration if `botConfig.relay?.enabled && msg.chatType === 'group'`.
   - Reset counter on human messages: `if (!msg.isRelay) relayManager.onHumanMessage(msg.chatId)`.
   - Build sender with `botName` for relay: `if (msg.isRelay) sender.botName = msg.userId.replace('relay:', '')`.
   - Set sender channel to `'relay'` for relay messages.
6. In `createEventHandlers`:
   - Add `let relayTextBuffer = ''` alongside existing state.
   - Accumulate on `event.type === 'text'`: `relayTextBuffer += event.content`.
   - On `event.type === 'result'`: call `relayToOtherBots(botName, chatId, relayTextBuffer.trim(), deps)` if buffer non-empty, then reset.
   - On `event.type === 'error'`: reset `relayTextBuffer = ''` (don't relay errors).
7. **Bug fix**: Guard `sendMessage` at line 541 with `if (!isNewProcess)` to prevent duplicate initial messages.

## Step 7: Config Example (`config.example.yaml`)

Add commented relay example under the bot config section.

## Step 8: Unit Tests (`tests/relay-manager.test.ts`) — New File

- `getRelayTargets` returns correct targets (excludes source, non-relay bots)
- `getRelayTargets` returns empty when only one relay bot
- `getRelayTargets` returns empty for unregistered bot
- Counter increments and pauses at limit
- Counter uses `min()` of all bots' maxRounds
- `onHumanMessage` resets counter
- Multiple chats tracked independently
- `registerBot` idempotent for same bot+chatId

## Step 9: Integration Tests (`tests/relay-integration.test.ts`) — New File

- Relay message has correct sender header (`channel="relay"`, `bot=` attribute)
- Relay messages bypass allowFrom
- Relay messages bypass requireMention
- Relay messages skip sanitizeInput
- Round limit triggers single pause notification
- Human message resets counter
- No relay when only one bot has relay enabled
- New spawn does not duplicate initial message (`!isNewProcess` guard)

## Implementation Order

Steps 1-3 can be done in parallel (types, RelayManager, deliver function — no cross-dependencies).
Step 4 depends on Step 1 (types).
Step 5 depends on Step 1 (types).
Step 6 depends on Steps 1-5 (integrates everything).
Step 7 independent.
Steps 8-9 depend on Steps 1-6.

Recommended: 1 → 2+3 parallel → 4+5 parallel → 6 → 7 → 8+9 parallel.

## Build & Test

After all changes:
```bash
npm run typecheck   # must pass
npm run build       # must succeed
npm test            # all existing + new tests must pass
```
