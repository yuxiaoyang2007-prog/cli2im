import type { RelayManager } from './manager.js';
import type {
  AppConfig,
  InboundMessage,
  PlatformAdapter,
} from '../types.js';
import type { AgentManager } from '../agents/manager.js';
import type { ChatQueue } from '../session/queue.js';

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
): Promise<void> {
  const { relayManager, config, agentManager, adapters, messageProcessors, queue } = deps;

  const targets = relayManager.getRelayTargets(sourceBotName, chatId);
  console.log(`[relay] ${sourceBotName} → targets=${JSON.stringify(targets)} textLen=${text.length}`);
  if (targets.length === 0) return;

  if (relayManager.incrementAndCheck(chatId)) {
    // Round limit reached — send ONE notification (pick any adapter in this chat)
    const anyBot = relayManager.getBotsInChat(chatId)[0];
    const adapter = anyBot ? adapters.get(anyBot) : undefined;
    if (adapter) {
      await adapter.send(chatId, {
        text: '[relay] Bot-to-bot conversation paused (round limit reached). Send a message to continue.',
      });
    }
    return;
  }

  const sourcePlugin = agentManager.getPlugin(config.bots[sourceBotName]?.agent);
  const displayName = sourcePlugin?.displayName ?? sourceBotName;

  for (const targetBotName of targets) {
    const targetBotConfig = config.bots[targetBotName];
    if (!targetBotConfig) continue;

    const syntheticMsg: InboundMessage = {
      platform: targetBotConfig.platform,
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
