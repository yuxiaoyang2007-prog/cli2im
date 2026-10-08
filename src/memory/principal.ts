import type { BotConfig, InboundMessage, MemoryConfig } from '../types.js';
import { isGroupChat } from '../security/access-policy.js';

/** Identity metadata is independent of whether a configured bot can run. */
export interface BotIdentityMetadata { platform: BotConfig['platform']; appId?: string }

export function collectBotIdentities(bots: Record<string, BotConfig>): Record<string, BotIdentityMetadata> {
  return Object.fromEntries(Object.entries(bots).map(([name, bot]) => [name, {
    platform: bot?.platform,
    ...(bot?.platform === 'feishu' ? { appId: bot.feishu?.appId } : {}),
  }]));
}

function identityAppKey(bot: BotIdentityMetadata, telegramId?: string): string {
  const key = bot.platform === 'feishu' ? bot.appId : telegramId;
  if (typeof key !== 'string' || !key || key.includes(':') || (bot.platform === 'telegram' && !/^[1-9]\d*$/.test(key))) {
    throw new Error('机器人应用身份尚未就绪');
  }
  return key;
}

export function botAppKey(bot: BotConfig, telegramId?: string): string {
  return identityAppKey({ platform: bot.platform, appId: bot.feishu?.appId }, telegramId);
}

export interface ResolvedPeople extends Map<string, string> {
  readonly pendingTelegramUserIds: Set<string>;
}

export function resolvePeople(people: MemoryConfig['people'], bots: Readonly<Record<string, BotIdentityMetadata>>,
  telegramIds: ReadonlyMap<string, string> = new Map()): ResolvedPeople {
  const result = Object.assign(new Map<string, string>(), { pendingTelegramUserIds: new Set<string>() });
  const references = new Map<string, string>();
  for (const [person, entries] of Object.entries(people ?? {})) {
    if (!person.trim() || !Array.isArray(entries)) throw new Error('Config error: invalid memory.people');
    for (const entry of entries) {
      if (typeof entry !== 'string') throw new Error('Config error: invalid memory.people actor');
      const match = /^(feishu|telegram):([^:]+):([^:]+)$/.exec(entry);
      if (!match) throw new Error('Config error: invalid memory.people actor');
      const [, platform, name, user] = match;
      const bot = Object.hasOwn(bots, name) ? bots[name] : undefined;
      if (!bot || bot.platform !== platform) {
        throw new Error('Config error: unknown memory.people bot');
      }
      if (references.has(entry) && references.get(entry) !== person) throw new Error('Config error: duplicate memory.people actor');
      references.set(entry, person);
      if (platform === 'telegram' && !telegramIds.has(name)) {
        result.pendingTelegramUserIds.add(user);
        continue;
      }
      const actor = `${platform}:${identityAppKey(bot, telegramIds.get(name))}:${user}`;
      if (result.has(actor) && result.get(actor) !== person) throw new Error('Config error: duplicate memory.people actor');
      result.set(actor, person);
    }
  }
  return result;
}

export interface MemoryIdentity { actorKey: string; principal: string; group: boolean }

export function resolveMemoryIdentity(bot: Pick<BotConfig, 'platform'>, appKey: string,
  msg: Pick<InboundMessage, 'userId' | 'chatId' | 'chatType'>, people: ReadonlyMap<string, string>): MemoryIdentity {
  if (!msg.userId || !msg.chatId || !['p2p', 'private', 'group', 'supergroup', 'channel'].includes(msg.chatType ?? '')) {
    throw new Error('缺少记忆身份信息');
  }
  const actorKey = `${bot.platform}:${appKey}:${msg.userId}`;
  const group = isGroupChat(msg.chatType);
  const person = people.get(actorKey);
  return { actorKey, group, principal: group ? `group:${bot.platform}:${appKey}:${msg.chatId}`
    : person ? `person:${person}` : `actor:${actorKey}` };
}

/** Pending Telegram aliases block only Telegram users whose mapping could be ambiguous. */
export function resolveRuntimeMemoryIdentity(botName: string, bots: Readonly<Record<string, BotIdentityMetadata>>,
  configuredPeople: MemoryConfig['people'], telegramIds: ReadonlyMap<string, string>,
  message: Pick<InboundMessage, 'userId' | 'chatId' | 'chatType'>): { identity: MemoryIdentity; people: Map<string, string> } {
  const bot = Object.hasOwn(bots, botName) ? bots[botName] : undefined;
  if (!bot) throw new Error('机器人应用身份尚未就绪');
  const people = resolvePeople(configuredPeople, bots, telegramIds);
  if (bot.platform === 'telegram' && people.pendingTelegramUserIds.has(message.userId)) {
    throw new Error('记忆身份映射尚未就绪，请管理员确认相关 Telegram 机器人已连接');
  }
  const appKey = identityAppKey(bot, telegramIds.get(botName));
  return { identity: resolveMemoryIdentity(bot, appKey, message, people), people };
}

export function samePerson(a: string, b: string, people: ReadonlyMap<string, string>): boolean {
  return a === b || (people.has(a) && people.get(a) === people.get(b));
}
