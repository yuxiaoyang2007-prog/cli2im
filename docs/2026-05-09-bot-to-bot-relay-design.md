# Bot-to-Bot Relay Design

## Problem

cli2im runs multiple AI agent bots (Claude Code, Codex, Gemini) in a single daemon process. Users want bots to collaborate in the same IM group chat — one bot writes code, another reviews, they iterate until convergence. Currently bot messages are filtered out (`sender_type === 'app'` on Feishu) and Telegram doesn't deliver bot messages to other bots at all.

## Solution: Daemon-Internal Relay

Route bot output to other bots inside the daemon process. The IM platform is the display layer for humans; bots receive each other's messages through internal routing, not platform event delivery. This sidesteps Telegram's bot-to-bot limitation entirely.

## Constraints

- **Same-platform only.** Relay routes messages between bots that share the same `chatId` (same IM platform, same group). Cross-platform relay (e.g., Feishu bot → Telegram bot) is out of scope — `chatId` semantics differ between platforms.
- **Group chats only.** Relay operates in group chats where multiple bots coexist. DM conversations are unaffected.

## User Flow

1. User @mentions a bot in a group chat with instructions including collaboration (e.g., "Design an API, then have Codex review it")
2. The @mentioned bot works and outputs its result to the group
3. Daemon detects the output, routes it as an inbound message to other relay-enabled bots in the same group
4. Receiving bot's agent decides whether to respond based on content
5. If it responds, its output is routed back to the first bot
6. Loop continues until agents converge (nothing more to add) or the round limit is hit

## Configuration

Add `relay` field to bot config in `config.yaml`:

```yaml
bots:
  ccbot:
    agent: claude-code
    platform: feishu
    relay:
      enabled: true
      maxConsecutiveRounds: 10   # safety cap, default 10
  codexbot:
    agent: codex
    platform: feishu             # must be same platform as ccbot for relay
    relay:
      enabled: true
      maxConsecutiveRounds: 10
```

- `relay.enabled` — opt-in per bot. Both sender and receiver must have it enabled.
- `maxConsecutiveRounds` — max consecutive bot-to-bot turns without human intervention. Exceeding pauses relay and notifies the group. When multiple bots have different values, the minimum is used (safest).

Type additions in `BotConfig`:

```typescript
relay?: {
  enabled: boolean;
  maxConsecutiveRounds?: number; // default 10
};
```

## Architecture

### New Module: `src/relay/manager.ts`

```typescript
interface RelayGroup {
  botNames: Set<string>;          // relay-enabled bots in this chatId
  consecutiveRounds: number;      // reset on human message
  maxRounds: number;              // min of all bots' maxConsecutiveRounds
}

class RelayManager {
  private groups: Map<string, RelayGroup>; // keyed by chatId

  // Lazy registration: called on first message from a relay-enabled bot in a group.
  // If botName is already registered for this chatId, this is a no-op.
  // Updates maxRounds to min(existing, newBot's maxRounds).
  registerBot(botName: string, chatId: string, maxRounds: number): void;

  // Returns list of bot names to relay to.
  // Returns empty if: only one bot, source not registered, or rounds exceeded.
  getRelayTargets(sourceBotName: string, chatId: string): string[];

  // Returns all relay-enabled bots in a chat (for pause notifications).
  getBotsInChat(chatId: string): string[];

  // Called on every human message in the group. Resets counter.
  onHumanMessage(chatId: string): void;

  // Increments counter. Returns true if limit NOW reached.
  incrementAndCheck(chatId: string): boolean;
}
```

### Message Flow

```
Human sends @ccbot message in group
       |
       v
Normal pipeline: adapter → pipeline → agent spawn → agent works
       |
       v
Agent emits 'result' event
       |
       v
createEventHandlers.onEvent:
  1. Send to IM group (existing: adapter.send / card update)
  2. NEW: collect full response text during streaming
  3. On 'result' event: call relayToOtherBots(botName, chatId, text)
       |
       v
relayToOtherBots:
  1. Get targets via relayManager.getRelayTargets(sourceBotName, chatId)
  2. If no targets → return (no relay needed)
  3. Increment counter via relayManager.incrementAndCheck(chatId)
  4. If limit reached → notify group, return
  5. For each target bot → build synthetic InboundMessage → enqueue via processMessage
       |
       v
Target bot's agent receives message with sender header:
  <cti-sender channel="relay" bot="ccbot" name="Claude Code"/>
       |
       v
Agent decides to respond (or not) → output → relay back (or stop)
```

Note: `getRelayTargets` is called BEFORE `incrementAndCheck`. This avoids wasting the counter when there are no actual targets (e.g., source bot is the only relay-enabled bot in the chat).

### Collecting Bot Response Text

Currently streaming output goes directly to cards/messages. For relay, we need the complete text of a bot's response. Add a per-session text accumulator:

```typescript
// In createEventHandlers, alongside existing card/tg-stream logic:
let relayTextBuffer = '';

onEvent: (sk, event) => {
  // existing card/stream handling...

  if (event.type === 'text') {
    relayTextBuffer += event.content;
  }

  if (event.type === 'result') {
    // After sending to IM, trigger relay
    if (relayTextBuffer.trim()) {
      relayToOtherBots(botName, chatId, relayTextBuffer.trim());
    }
    relayTextBuffer = '';
  }

  if (event.type === 'error') {
    // Don't relay errors — the error is shown in the group for humans.
    // The other bot doesn't need to know about internal failures.
    relayTextBuffer = '';
  }
};
```

**Scope:** Only final text responses (`type === 'text'`) are accumulated and relayed. Thinking blocks, tool calls, tool results, and errors are NOT relayed — they are internal to each agent. This matches how CLI multi-agent review works: you see the other agent's final output, not its internal reasoning.

### Relay Delivery Function

New function in `src/relay/deliver.ts`:

```typescript
async function relayToOtherBots(
  sourceBotName: string,
  chatId: string,
  text: string,
  deps: {
    relayManager: RelayManager;
    config: AppConfig;
    agentManager: AgentManager;
    adapters: Map<string, PlatformAdapter>;
    messageProcessors: Map<string, (msg: InboundMessage) => Promise<void>>;
    queue: ChatQueue;
  },
): Promise<void> {
  const { relayManager, config, agentManager, adapters, messageProcessors, queue } = deps;

  const targets = relayManager.getRelayTargets(sourceBotName, chatId);
  if (targets.length === 0) return;

  if (relayManager.incrementAndCheck(chatId)) {
    // Round limit reached — notify all adapters in this chat
    for (const botName of relayManager.getBotsInChat(chatId)) {
      const adapter = adapters.get(botName);
      if (adapter) {
        await adapter.send(chatId, {
          text: '[relay] Bot-to-bot conversation paused (round limit reached). Send a message to continue.',
        });
      }
    }
    return;
  }

  const sourcePlugin = agentManager.getPlugin(config.bots[sourceBotName].agent);
  const displayName = sourcePlugin?.displayName ?? sourceBotName;

  for (const targetBotName of targets) {
    const syntheticMsg: InboundMessage = {
      platform: config.bots[targetBotName].platform,
      chatId,
      userId: `relay:${sourceBotName}`,
      userName: displayName,
      text,
      chatType: 'group',
      isRelay: true,
    };

    const processor = messageProcessors.get(targetBotName);
    if (processor) {
      await queue.enqueue(chatId, () => processor(syntheticMsg));
    }
  }
}
```

### `messageProcessors` Map

The current code creates `processMessage` as a local closure inside a `for...of` loop (index.ts line 364). To allow relay delivery to call any bot's processor, expose a module-level map:

```typescript
// In main(), before the adapter loop:
const messageProcessors = new Map<string, (msg: InboundMessage) => Promise<void>>();

// Inside the loop:
for (const [botName, adapter] of adapters) {
  const botConfig = config.bots[botName];
  const processMessage = createMessageProcessor(botName, botConfig, adapter);
  messageProcessors.set(botName, processMessage);  // NEW: store reference

  adapter.onMessage((msg: InboundMessage) => {
    void queue.enqueue(msg.chatId, () => processMessage(msg)).catch(...);
  });
  // ...
}
```

### Bot Registration (Lazy)

Bots are registered into RelayGroups lazily on first message. In `createMessageProcessor`, at the top of the returned function:

```typescript
return async (msg) => {
  // Lazy relay registration on first group message
  if (msg.chatType === 'group' && botConfig.relay?.enabled) {
    relayManager.registerBot(botName, msg.chatId, botConfig.relay.maxConsecutiveRounds ?? 10);
  }

  // Reset relay counter on human messages
  if (!msg.isRelay) {
    relayManager.onHumanMessage(msg.chatId);
  }

  // ...existing pipeline logic...
};
```

This means a bot won't be a relay target until it has received at least one message in the group. This is acceptable because relay only makes sense after bots are active in a group.

### Pipeline Changes

`InboundMessage` gets a new optional field:

```typescript
export interface InboundMessage {
  // ...existing fields...
  isRelay?: boolean;  // true when message is from bot-to-bot relay
}
```

Pipeline bypass rules for relay messages (in `pipeline.ts`):

1. **`allowFrom` check** (line 130): Add explicit `isRelay` bypass. Currently the check is guarded by `!isGroup`, but relay messages should bypass regardless:
   ```typescript
   if (!msg.isRelay && !isGroup && allowList.length > 0 && ...)
   ```

2. **`getGroupMessageSkipReason`** (line 68-87): Add `isRelay` bypass at the top:
   ```typescript
   export function getGroupMessageSkipReason(msg, botConfig, botOpenId) {
     if (msg.isRelay) return undefined;  // relay messages always pass
     if (msg.chatType !== 'group') return undefined;
     // ...existing checks...
   }
   ```

3. **Content Guard**: Relay messages skip content guard scanning. Bot output has already been through the content guard when it was generated — double-scanning is wasteful.

### Fix: Duplicate Message on New Spawn

Pre-existing issue amplified by relay: when `isNewProcess` is true, `spawnOpts.initialPrompt` already contains the message text. Then `agentManager.sendMessage` at line 541 sends it again. Fix:

```typescript
// In createMessageProcessor, after the spawn block:
if (!isNewProcess) {
  agentManager.sendMessage(sessionKey, botConfig.agent, userMessage);
}
```

This fix applies to all messages, not just relay — it's a bug fix for the existing code.

### Human Message Detection

In `createMessageProcessor`, before processing, check if the message is from a human (not relay):

```typescript
if (!msg.isRelay) {
  relayManager.onHumanMessage(msg.chatId);
}
```

## Loop Prevention (3 Layers)

1. **Agent judgment** (primary) — the LLM naturally stops responding when it has nothing to add. This is the same mechanism that makes CLI multi-agent code review converge.

2. **Round counter** (safety net) — `maxConsecutiveRounds` per group (minimum of all bots' configured values). Incremented on each relay delivery, reset on human message. When exceeded, relay pauses and notifies group.

3. **Rate limiter** (existing) — the existing per-chat rate limiter (20/60s) applies to relay messages too, preventing burst floods. Note: relay and human messages share the same rate budget. For v1 this is acceptable; if it causes issues, a separate relay rate counter can be added later.

## Adapter Changes

**None.** Both Feishu and Telegram adapters are unchanged.

- Feishu adapter's `sender_type === 'app'` filter (line 313) stays — it only applies to platform-delivered events. Relay messages are synthetic `InboundMessage` objects injected directly into `processMessage()`, never touching the adapter's event handler.
- Telegram doesn't deliver bot messages to other bots, and we don't need it to. Relay is entirely internal.

## Sender Header Format

Relay messages use a distinct channel value so agents can differentiate:

```xml
<cti-sender channel="relay" bot="ccbot" name="Claude Code"/>
```

The `bot` attribute is new, only present for relay messages. The `channel` value `relay` distinguishes from `feishu` / `telegram`.

Update `buildSenderHeader` in `pipeline.ts`:

```typescript
export interface SenderInfo {
  channel: string;
  userId?: string;
  userName?: string;
  botName?: string;  // new: source bot name for relay messages
}

export function buildSenderHeader(sender: SenderInfo): string {
  const parts: string[] = [`channel="${xmlAttr(sender.channel)}"`];
  if (sender.userId) parts.push(`user_id="${xmlAttr(sender.userId)}"`);
  if (sender.botName) parts.push(`bot="${xmlAttr(sender.botName)}"`);
  if (sender.userName) parts.push(`name="${xmlAttr(sender.userName)}"`);
  return `<cti-sender ${parts.join(' ')}/>\n\n`;
}
```

## File Changes Summary

| File | Change |
|------|--------|
| `src/types.ts` | Add `relay` to `BotConfig`, `isRelay` to `InboundMessage`, `botName` to `SenderInfo` |
| `src/relay/manager.ts` | **New file.** RelayManager class |
| `src/relay/deliver.ts` | **New file.** `relayToOtherBots` function |
| `src/index.ts` | Instantiate RelayManager, create `messageProcessors` map, collect relay text buffer in event handlers, call relay on result, fix duplicate sendMessage on new spawn |
| `src/pipeline.ts` | Add `botName` to `SenderInfo`, add `isRelay` bypass in `process()` and `getGroupMessageSkipReason()` |
| `src/config/loader.ts` | Validate `relay` config fields |
| `config.example.yaml` | Add commented relay config example |
| `tests/relay-manager.test.ts` | **New file.** Unit tests for RelayManager |
| `tests/relay-integration.test.ts` | **New file.** Integration tests for relay message flow |

## Testing Plan

### Unit Tests (relay-manager.test.ts)
- `getRelayTargets` returns correct targets (excludes source bot, non-relay bots)
- `getRelayTargets` returns empty when only one relay bot in chat
- `getRelayTargets` returns empty for unregistered bot
- Counter increments and triggers pause at limit
- Counter uses `min()` of all bots' maxConsecutiveRounds
- `onHumanMessage` resets counter
- Multiple chats tracked independently
- `registerBot` is idempotent for same bot+chatId

### Integration Tests (relay-integration.test.ts)
- Full flow: human message → bot output → relay → target bot receives synthetic message
- Relay message has correct sender header (`channel="relay"`, `bot=` attribute)
- Relay messages bypass allowFrom check
- Relay messages bypass requireMention check
- Round limit triggers pause notification
- Human message resets counter and re-enables relay
- No relay when only one bot has relay enabled
- Duplicate sendMessage fix: new spawn does not send initialPrompt twice

### Manual E2E
1. Set up 2 bots in the same Feishu group with relay enabled
2. @mention one bot with instructions to collaborate with the other
3. Verify bot output appears in group AND triggers the other bot
4. Verify multi-round loop converges naturally
5. Verify round limit works by setting `maxConsecutiveRounds: 2`
6. Repeat on Telegram with 2 bots in the same group
