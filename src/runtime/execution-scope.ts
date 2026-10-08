import { realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname, basename, join } from 'node:path';
import { expandHome } from '../media.js';
import { isGroupChat } from '../security/access-policy.js';
import type { BotConfig, InboundMessage, Session, SessionKey } from '../types.js';
import type { SessionStore } from '../session/store.js';

export function canonicalPath(path: string): string {
  const expanded = resolve(expandHome(path));
  let parent = expanded;
  const suffix: string[] = [];
  while (true) {
    try { return join(realpathSync(parent), ...suffix.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === dirname(parent)) throw error;
      suffix.push(basename(parent));
      parent = dirname(parent);
    }
  }
}

export function pathContains(root: string, path: string): boolean {
  const rel = relative(canonicalPath(root), canonicalPath(path));
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
}

/** File scope is independent of memory identity and the chat/topic session key. */
export function resolveExecutionScope(bot: BotConfig, msg: Pick<InboundMessage, 'userId' | 'chatType'>) {
  const group = isGroupChat(msg.chatType);
  const override = !group ? bot.userOverrides?.[msg.userId]?.workingDirectory : undefined;
  if (bot.isolation?.enabled && !group && (!override || !['p2p', 'private'].includes(msg.chatType ?? ''))) {
    throw new Error('隔离机器人缺少该私聊身份的工作区');
  }
  const workingDirectory = canonicalPath(override ?? bot.workingDirectory);
  return { workingDirectory, scopeKey: workingDirectory, group };
}

/** Migrate only legacy group sessions pointing into a personal override. */
export async function ensureExecutionSession(params: {
  bot: BotConfig; message: Pick<InboundMessage, 'userId' | 'chatType'>;
  key: SessionKey; store: SessionStore; reset: (key: SessionKey) => void;
}): Promise<Session> {
  const { bot, message, key, store, reset } = params;
  const scope = resolveExecutionScope(bot, message);
  const session = await store.getOrCreate(key, { agentName: bot.agent, workingDirectory: scope.workingDirectory });
  if (scope.group && canonicalPath(session.workingDirectory) !== scope.workingDirectory
    && Object.values(bot.userOverrides ?? {}).some(override => override.workingDirectory
      && pathContains(override.workingDirectory, session.workingDirectory))) {
    reset(key);
    await store.updateWorkingDirectory(session.id, scope.workingDirectory);
    await store.clearAgentSessionId(session.id);
    session.workingDirectory = scope.workingDirectory;
    session.agentSessionId = undefined;
  }
  return session;
}
