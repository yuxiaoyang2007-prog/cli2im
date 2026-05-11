import type { RelayManager } from './manager.js';
import type {
  AppConfig,
  InboundMessage,
  PlatformAdapter,
} from '../types.js';
import type { AgentManager } from '../agents/manager.js';
import type { ChatQueue } from '../session/queue.js';
import { stripCtiTags } from '../security/validators.js';
import type { AbortableOptions } from '../abort.js';

export interface RelayDeps {
  relayManager: RelayManager;
  config: AppConfig;
  agentManager: AgentManager;
  adapters: Map<string, PlatformAdapter>;
  messageProcessors: Map<string, (msg: InboundMessage) => Promise<void>>;
  queue: ChatQueue;
}

export async function relayToOtherBots(
  sourceBotName: string,
  chatId: string,
  text: string,
  deps: RelayDeps,
  options: AbortableOptions = {},
): Promise<void> {
  const { relayManager, config, agentManager, adapters, messageProcessors, queue } = deps;
  const { signal } = options;

  if (signal?.aborted) return;
  const targets = relayManager.getRelayTargets(sourceBotName, chatId);
  console.log(`[relay] ${sourceBotName} → targets=${JSON.stringify(targets)} textLen=${text.length}`);
  if (targets.length === 0) return;

  if (signal?.aborted) return;
  if (relayManager.incrementAndCheck(chatId)) {
    // Round limit reached — send ONE notification (pick any adapter in this chat)
    const anyBot = relayManager.getBotsInChat(chatId)[0];
    const adapter = anyBot ? adapters.get(anyBot) : undefined;
    if (adapter) {
      if (signal?.aborted) return;
      await adapter.send(chatId, {
        text: '[relay] Bot-to-bot conversation paused (round limit reached). Send a message to continue.',
      }, { signal });
    }
    return;
  }

  const sourcePlugin = agentManager.getPlugin(config.bots[sourceBotName]?.agent);
  const displayName = sourcePlugin?.displayName ?? sourceBotName;
  const relayText = stripCtiTags(text);

  for (const targetBotName of targets) {
    if (signal?.aborted) return;
    const targetBotConfig = config.bots[targetBotName];
    if (!targetBotConfig) continue;

    const syntheticMsg: InboundMessage = {
      platform: targetBotConfig.platform,
      chatId,
      userId: `relay:${sourceBotName}`,
      userName: displayName,
      text: relayText,
      chatType: 'group',
      isRelay: true,
    };

    const processor = messageProcessors.get(targetBotName);
    if (processor) {
      if (signal?.aborted) return;
      await queue.enqueue(chatId, async () => {
        if (signal?.aborted) return;
        await processor(syntheticMsg);
      });
    }
  }
}
