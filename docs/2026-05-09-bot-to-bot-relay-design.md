# Bot-to-Bot Relay Design

## Problem

cli2im runs multiple AI agent bots (Claude Code, Codex, Gemini) in a single daemon process. Users want bots to collaborate in the same IM group chat — one bot writes code, another reviews, they iterate until convergence. Currently bot messages are filtered out (`sender_type === 'app'` on Feishu) and Telegram doesn't deliver bot messages to other bots at all.

## Solution: Daemon-Internal Relay

Route bot output to other bots inside the daemon process. The IM platform is the display layer for humans; bots receive each other's messages through internal routing, not platform event delivery. This sidesteps Telegram's bot-to-bot limitation entirely.

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
    platform: telegram
    relay:
      enabled: true
      maxConsecutiveRounds: 10
```

- `relay.enabled` — opt-in per bot. Both sender and receiver must have it enabled.
- `maxConsecutiveRounds` — max consecutive bot-to-bot turns without human intervention. Exceeding pauses relay and notifies the group.

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

  // Called when a bot connects to a chat (adapter.connect or first message)
  registerBot(botName: string, chatId: string, maxRounds: number): void;

  // Called when a bot produces output. Returns list of bot names to relay to.
  // Returns empty if relay disabled, only one bot, or rounds exceeded.
  getRelayTargets(sourceBotName: string, chatId: string): string[];

  // Called on every human message in the group. Resets counter.
  onHumanMessage(chatId: string): void;

  // Called after each relay delivery. Returns true if limit reached.
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
  3. On 'result' event: call relayManager.getRelayTargets(botName, chatId)
       |
       v
For each target bot:
  - Build synthetic InboundMessage:
      platform: original platform
      chatId: same chatId
      userId: `relay:${sourceBotName}`
      userName: sourceBotName display name
      text: bot's full response text
      chatType: 'group'
      isRelay: true              // new field on InboundMessage
  - Feed into target bot's processMessage() function
       |
       v
Target bot's agent receives message with sender header:
  <cti-sender channel="relay" bot="ccbot" name="Claude Code"/>
       |
       v
Agent decides to respond (or not) → output → relay back (or stop)
```

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
};
```

### Relay Delivery Function

New function in `index.ts` (or `src/relay/deliver.ts`):

```typescript
async function relayToOtherBots(
  sourceBotName: string,
  chatId: string,
  text: string,
): Promise<void> {
  if (relayManager.incrementAndCheck(chatId)) {
    // Round limit reached — notify all adapters in this chat
    for (const botName of relayManager.getBotsInChat(chatId)) {
      const adapter = adapters.get(botName);
      if (adapter) {
        await adapter.send(chatId, {
          text: `[relay] Bot-to-bot conversation paused after ${limit} rounds. Send a message to continue.`,
        });
      }
    }
    return;
  }

  const targets = relayManager.getRelayTargets(sourceBotName, chatId);
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

    const targetAdapter = adapters.get(targetBotName);
    const targetConfig = config.bots[targetBotName];
    const processor = messageProcessors.get(targetBotName);
    if (processor) {
      await queue.enqueue(chatId, () => processor(syntheticMsg));
    }
  }
}
```

### Pipeline Changes

`InboundMessage` gets a new optional field:

```typescript
export interface InboundMessage {
  // ...existing fields...
  isRelay?: boolean;  // true when message is from bot-to-bot relay
}
```

Pipeline adjustments:
- Relay messages bypass `allowFrom` check (they come from internal routing, not external users)
- Relay messages bypass `requireMention` check
- Relay messages bypass `sender_type === 'app'` filter (Feishu adapter)
- Relay messages DO go through rate limiting (prevents runaway loops at the pipeline level too)

### Human Message Detection

In `createMessageProcessor`, before processing, check if the message is from a human (not relay):

```typescript
if (!msg.isRelay) {
  relayManager.onHumanMessage(msg.chatId);
}
```

## Loop Prevention (3 Layers)

1. **Agent judgment** (primary) — the LLM naturally stops responding when it has nothing to add. This is the same mechanism that makes CLI multi-agent code review converge.

2. **Round counter** (safety net) — `maxConsecutiveRounds` per group. Incremented on each relay delivery, reset on human message. When exceeded, relay pauses and notifies group.

3. **Rate limiter** (existing) — the existing per-chat rate limiter applies to relay messages too, preventing burst floods.

## Feishu Adapter Change

In `src/platforms/feishu/adapter.ts`, line 313:

```typescript
// Before:
if (sender?.sender_type === 'app') return;

// After:
// Bot messages are now handled by the relay system internally.
// We still filter them at the adapter level because relay doesn't
// go through the adapter — it uses synthetic InboundMessages directly.
if (sender?.sender_type === 'app') return;
```

No change needed. The Feishu adapter still filters bot messages from the platform event stream, because relay messages are injected directly into `processMessage()` as synthetic `InboundMessage` objects — they never come through the adapter.

## Telegram: No Adapter Change

Same reasoning. Telegram doesn't deliver bot-to-bot messages, and we don't need it to. Relay is internal.

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
| `src/index.ts` | Instantiate RelayManager, collect relay text buffer in event handlers, call `relayToOtherBots` on result, reset counter on human messages, expose `messageProcessors` map |
| `src/pipeline.ts` | Add `botName` to `SenderInfo`, bypass allowFrom/requireMention for relay messages |
| `src/config/loader.ts` | Validate `relay` config fields |
| `config.example.yaml` | Add commented relay config example |
| `tests/relay-manager.test.ts` | **New file.** Unit tests for RelayManager |
| `tests/relay-integration.test.ts` | **New file.** Integration tests for relay message flow |

## Testing Plan

### Unit Tests (relay-manager.test.ts)
- `getRelayTargets` returns correct targets (excludes source bot, non-relay bots)
- `getRelayTargets` returns empty when only one relay bot in chat
- Counter increments and triggers pause at limit
- `onHumanMessage` resets counter
- Multiple chats tracked independently

### Integration Tests (relay-integration.test.ts)
- Full flow: human message → bot output → relay → target bot receives
- Relay message has correct sender header (`channel="relay"`, `bot=` attribute)
- Relay messages bypass allowFrom check
- Round limit triggers pause notification
- Human message resets counter and re-enables relay

### Manual E2E
1. Set up 2 bots in the same Feishu group with relay enabled
2. @mention one bot with instructions to collaborate with the other
3. Verify bot output appears in group AND triggers the other bot
4. Verify multi-round loop converges naturally
5. Verify round limit works by setting `maxConsecutiveRounds: 2`
6. Repeat on Telegram with 2 bots in the same group
