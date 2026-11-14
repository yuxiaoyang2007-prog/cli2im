import { expandHome } from '../media.js';
import { bindReplyRoute } from '../runtime/reply-route.js';
import { validateWorkingDirectory } from '../security/validators.js';
import type { SessionStore } from '../session/store.js';
import {
  buildSessionKey,
  type AppConfig,
  type PlatformAdapter,
} from '../types.js';

export type CliNotifyStatus = 'completed' | 'error' | 'info';

export interface CliNotifyPayload {
  botName?: string;
  title?: string;
  message: string;
  status?: CliNotifyStatus;
  sessionId?: string;
  workDir?: string;
}

export interface CliNotifyResult {
  success: boolean;
  botName?: string;
  error?: string;
}

export interface CliNotifyDeps {
  config: AppConfig;
  store: Pick<
    SessionStore,
    'getWatchTarget' | 'getNotificationBinding' | 'listWatchTargets' | 'grantSessionAccess'
  >;
  adapters: Map<string, PlatformAdapter>;
}

const VALID_STATUSES = new Set<CliNotifyStatus>(['completed', 'error', 'info']);
const VALID_SESSION_ID = /^[A-Za-z0-9_-]{4,128}$/;

export async function deliverCliNotification(
  rawBody: Record<string, unknown>,
  deps: CliNotifyDeps,
): Promise<CliNotifyResult> {
  const message = typeof rawBody.message === 'string' ? rawBody.message.trim() : '';
  if (!message || message.length > 16_000) {
    return { success: false, error: 'Invalid or missing "message" (1..16000 chars)' };
  }

  const rawStatus = rawBody.status;
  if (rawStatus !== undefined && (typeof rawStatus !== 'string' || !VALID_STATUSES.has(rawStatus as CliNotifyStatus))) {
    return { success: false, error: 'Invalid "status"; expected completed, error, or info' };
  }
  const status: CliNotifyStatus = (rawStatus as CliNotifyStatus | undefined) ?? 'info';

  const rawTitle = rawBody.title;
  if (rawTitle !== undefined && typeof rawTitle !== 'string') {
    return { success: false, error: 'Invalid "title"; expected string' };
  }
  const title = rawTitle?.trim().slice(0, 120);

  const rawSessionId = rawBody.sessionId;
  if (rawSessionId !== undefined && (typeof rawSessionId !== 'string' || !VALID_SESSION_ID.test(rawSessionId))) {
    return { success: false, error: 'Invalid "sessionId" format' };
  }
  const sessionId = rawSessionId;

  const rawWorkDir = rawBody.workDir;
  if (rawWorkDir !== undefined && typeof rawWorkDir !== 'string') {
    return { success: false, error: 'Invalid "workDir"; expected string' };
  }

  const requestedBot = typeof rawBody.botName === 'string' ? rawBody.botName.trim() : undefined;
  if (rawBody.botName !== undefined && !requestedBot) {
    return { success: false, error: 'Invalid "botName"; expected non-empty string' };
  }

  let target: {
    botName: string;
    platform: 'feishu' | 'telegram';
    chatId: string;
    threadId?: string;
  } | null = null;

  if (requestedBot) {
    const watch = await deps.store.getWatchTarget(requestedBot);
    if (watch) {
      target = watch;
    } else {
      const legacy = await deps.store.getNotificationBinding(requestedBot);
      if (legacy) target = legacy;
    }
    if (!target) {
      return {
        success: false,
        error: `No watch target bound for "${requestedBot}"; send /watch to that bot first`,
      };
    }
  } else {
    const allTargets = await deps.store.listWatchTargets();
    if (allTargets.length > 0) {
      target = allTargets[0];
    } else {
      for (const name of Object.keys(deps.config.bots)) {
        const legacy = await deps.store.getNotificationBinding(name);
        if (legacy) {
          target = legacy;
          break;
        }
      }
    }
    if (!target) {
      return {
        success: false,
        error: 'No watch target bound; send /watch to your bot first',
      };
    }
  }

  const adapter = deps.adapters.get(target.botName);
  const botConfig = deps.config.bots[target.botName];
  if (!adapter || !botConfig) {
    return { success: false, error: `Bot "${target.botName}" is not active` };
  }

  if (sessionId) {
    const candidateWorkDir = rawWorkDir ? expandHome(rawWorkDir) : botConfig.workingDirectory;
    if (rawWorkDir && !(await validateWorkingDirectory(candidateWorkDir))) {
      return { success: false, error: 'Invalid "workDir"' };
    }
    if (await validateWorkingDirectory(candidateWorkDir)) {
      const scopeKey = buildSessionKey(target.platform, target.chatId, target.botName, target.threadId);
      await deps.store.grantSessionAccess({
        agentName: botConfig.agent,
        agentSessionId: sessionId,
        key: scopeKey,
        workingDirectory: candidateWorkDir,
      });
    }
  }

  const defaultTitle =
    status === 'completed'
      ? `✅ ${target.botName} 任务完成`
      : status === 'error'
        ? `⚠️ ${target.botName} 任务异常`
        : `📣 ${target.botName} 通知`;

  const route = bindReplyRoute(adapter, target.threadId ? { threadId: target.threadId } : {});
  await route.send(target.chatId, {
    card: {
      type: 'final',
      headerTemplate: status === 'error' ? 'orange' : 'green',
      title: title || defaultTitle,
      content: message,
      ...(sessionId
        ? { buttons: [{ text: '📱 在此接管对话', value: `resume:${sessionId}`, type: 'primary' as const }] }
        : {}),
    },
  });

  return { success: true, botName: target.botName };
}
