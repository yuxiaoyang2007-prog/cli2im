import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import type { BotConfig, SessionKey } from '../types.js';

export interface AccessActor {
  userId: string;
  chatId: string;
  chatType?: string;
}

export function isGroupChat(chatType?: string): boolean {
  return chatType === 'group' || chatType === 'supergroup' || chatType === 'channel';
}

export function isBotAdmin(bot: BotConfig, userId: string): boolean {
  return !!userId && userId !== '*' && (bot.adminUsers ?? []).map(String).includes(userId);
}

export function getGroupAccessRejection(actor: Pick<AccessActor, 'chatId' | 'chatType'>, bot: BotConfig): string | undefined {
  const groups = (bot.groupAllowFrom ?? []).map(String);
  const restricted = bot.groupPolicy === 'allowlist' || groups.length > 0;
  // An absent chat type must not bypass a configured group restriction.
  if (!actor.chatType && restricted) return 'Missing chat type';
  if (isGroupChat(actor.chatType) && restricted && !groups.includes(actor.chatId)) {
    return 'Unauthorized group';
  }
  return undefined;
}

/** Shared admission rules for messages and buttons; admins still respect group restrictions. */
export function getBotAccessRejection(actor: AccessActor, bot: BotConfig): string | undefined {
  if (bot.enabled === false) return 'Bot disabled';
  if (!actor.userId) return 'Missing user id';
  if (!actor.chatId) return 'Missing chat id';
  const allowed = (bot.allowFrom ?? []).map(String);
  if (!isBotAdmin(bot, actor.userId) && !allowed.filter((id) => id !== '*').includes(actor.userId)
    && !(bot.allowPublic === true && allowed.includes('*'))) {
    return 'Unauthorized user';
  }
  return getGroupAccessRejection(actor, bot);
}

export interface SessionAccessRecord {
  key?: SessionKey;
  agentName?: string;
  workingDirectory?: string;
  cwd?: string;
}

/** Pass only authoritative database/scanner records here, never button-supplied cwd or key. */
export async function canAccessSession(params: {
  bot: BotConfig;
  actor: AccessActor;
  sessionKey: SessionKey;
  session: SessionAccessRecord;
}): Promise<boolean> {
  const { bot, actor, sessionKey, session } = params;
  if (getBotAccessRejection(actor, bot)) return false;
  if (session.agentName && session.agentName !== bot.agent) return false;
  if (isBotAdmin(bot, actor.userId)) return true;
  if (session.key === sessionKey) return true;
  const cwd = session.workingDirectory ?? session.cwd;
  if (!cwd || !(bot.sessionRoots?.length)) return false;
  const actualPath = await resolvePath(cwd);
  if (!actualPath) return false;
  for (const root of bot.sessionRoots) {
    const actualRoot = await resolvePath(root);
    if (!actualRoot) continue;
    const rel = relative(actualRoot, actualPath);
    if (rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel))) return true;
  }
  return false;
}

async function resolvePath(path: string): Promise<string | undefined> {
  const expanded = path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
  if (!isAbsolute(expanded)) return undefined;
  try {
    return await realpath(expanded);
  } catch {
    return undefined;
  }
}
