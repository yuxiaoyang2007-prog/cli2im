import { lstat, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { AgentEventContext, AgentManagerEvents } from '../agents/manager.js';
import type { RelayDeps } from '../relay/deliver.js';
import { relayToOtherBots } from '../relay/deliver.js';
import { persistAgentSessionIdIfCurrent } from './agent-session-id.js';
import type { SessionStore } from '../session/store.js';
import type { FilePayload, PlatformAdapter, SessionKey } from '../types.js';
import type { StreamingCardController } from '../platforms/feishu/cards.js';
import type { TelegramStreamController } from '../platforms/telegram/stream.js';
import { scrubLog } from '../security/logging.js';
import { assertOutboundFileMatches } from '../security/outbound-file.js';
import type { SendVoiceReplyOptions } from './voice-reply.js';
import { isAbortError } from '../abort.js';

const TERMINAL_PATTERNS = /^(done|lgtm|confirmed|accepted|acknowledged|agreed|ok|收到|完成|没问题|好的|通过|stop here)/i;

export type SessionIdStore = Pick<SessionStore, 'getByKey' | 'updateAgentSessionId'>;

export interface RuntimeEventHandlerDeps {
  sessionKey: SessionKey;
  store: SessionIdStore;
  voiceSessions: Map<SessionKey, string>;
  cardController?: StreamingCardController;
  tgStream?: TelegramStreamController;
  adapter?: PlatformAdapter;
  voiceResponseBuffer: { value: string };
  stopTyping: (chatId: string) => void;
  sendVoiceReply: (options: SendVoiceReplyOptions) => Promise<void>;
  relayDeps: RelayDeps;
  relayToOtherBotsFn?: typeof relayToOtherBots;
}

export function isTerminalRelayText(text: string): boolean {
  if (text.length > 500) return false;
  const firstLine = text.split('\n')[0].trim();
  return TERMINAL_PATTERNS.test(firstLine);
}

export function createRuntimeEventHandler(
  deps: RuntimeEventHandlerDeps,
): AgentManagerEvents['onEvent'] {
  const {
    sessionKey,
    store,
    voiceSessions,
    cardController,
    tgStream,
    adapter,
    voiceResponseBuffer,
    stopTyping,
    sendVoiceReply,
    relayDeps,
    relayToOtherBotsFn = relayToOtherBots,
  } = deps;
  const botName = sessionKey.split(':')[2];
  const chatId = sessionKey.split(':')[1];
  let relayTextBuffer = '';

  return async (_sk, event, eventContext: AgentEventContext) => {
    try {
    // AgentManager creates this context for the emitting process; this is the
    // captured process identity check used after async boundaries below.
    const signal = eventContext.signal;
    const ensureCurrent = () => eventContext.isCurrent();
    const ensureActive = () => ensureCurrent() && !signal.aborted;
    if (!ensureActive()) return;

    const isVoiceSession = voiceSessions.has(sessionKey);
    console.log(`[event] ${scrubLog(sessionKey)}: type=${event.type} voice=${isVoiceSession} hasCard=${!!cardController} hasTgStream=${!!tgStream}`);

    if ((event.type === 'result' || event.type === 'status') && event.sessionId) {
      await persistAgentSessionIdIfCurrent(
        store,
        sessionKey,
        event.sessionId,
        ensureActive,
        { signal },
      );
      if (!ensureActive()) return;
    }

    // Accumulate text for relay
    if (event.type === 'text' && !event.noRelay) {
      relayTextBuffer += event.content;
    }

    if (isVoiceSession && adapter) {
      if (event.type === 'text' && event.content.trim()) {
        voiceResponseBuffer.value += event.content;
      } else if (event.type === 'error') {
        voiceResponseBuffer.value += `\n\nError: ${event.message}`;
      }
      if (!ensureActive()) return;
      cardController?.handleEvent(sessionKey, event, { signal });
      if (event.type === 'result' || event.type === 'error') {
        if (!ensureActive()) return;
        stopTyping(chatId);
        await sendVoiceReply({
          adapter,
          chatId,
          sessionKey,
          text: voiceResponseBuffer.value,
          isCurrent: ensureActive,
          signal,
          forgetVoiceSession: (key) => voiceSessions.delete(key),
        });
        if (!ensureActive()) return;
        voiceResponseBuffer.value = '';
      }
    } else if (cardController) {
      if (!ensureActive()) return;
      cardController.handleEvent(sessionKey, event, { signal });
    } else if (adapter) {
      if (event.type === 'text' && event.content.trim()) {
        if (!ensureActive()) return;
        if (tgStream) {
          tgStream.appendText(sessionKey, chatId, event.content);
        } else {
          await adapter.send(chatId, { text: event.content }, { signal });
          if (!ensureActive()) return;
        }
      } else if (event.type === 'error') {
        if (!ensureActive()) return;
        stopTyping(chatId);
        if (tgStream) {
          tgStream.appendText(sessionKey, chatId, `\n\nError: ${event.message}`);
          await tgStream.finalize(sessionKey, { signal });
          if (!ensureActive()) return;
        } else {
          await adapter.send(chatId, { text: `Error: ${event.message}` }, { signal });
          if (!ensureActive()) return;
        }
      } else if (event.type === 'result') {
        if (!ensureActive()) return;
        stopTyping(chatId);
        if (tgStream) {
          await tgStream.finalize(sessionKey, { signal });
          if (!ensureActive()) return;
        }
      }
    }

    // Trigger relay on result, reset on error
    if (event.type === 'result') {
      if (!ensureActive()) return;
      if (event.noRelay) {
        relayTextBuffer = '';
      } else {
        const trimmedRelay = relayTextBuffer.trim();
        const shouldRelay = trimmedRelay.length > 0 && !isTerminalRelayText(trimmedRelay);
        console.log(`[relay-trigger] ${scrubLog(botName)}: len=${trimmedRelay.length} relay=${shouldRelay} preview=${scrubLog(trimmedRelay, 100)}`);
        relayTextBuffer = '';
        if (shouldRelay) {
          await relayToOtherBotsFn(botName, chatId, trimmedRelay, relayDeps, { signal });
          if (!ensureActive()) return;
        }
      }
    }
    if (event.type === 'error') {
      relayTextBuffer = '';
    }

    if (event.type === 'file' && adapter?.sendFile) {
      if (!ensureActive()) return;
      await adapter.sendFile(chatId, {
        path: event.path,
        name: basename(event.path),
        mimeType: event.mimeType,
      }, { signal });
      if (!ensureActive()) return;
    }

    if (event.type === 'result' && event.createdFiles?.length && adapter?.sendFile) {
      const files = dedupeCreatedFiles(event.createdFiles);
      for (const file of files) {
        if (!ensureActive()) return;
        try {
          if (!(await isCreatedFileCurrent(file))) {
            console.warn(`[file-send] skip changed or missing file: ${scrubLog(file.path)}`);
            continue;
          }
          if (!ensureActive()) return;
          await adapter.sendFile(chatId, file, { signal });
        } catch (err) {
          if (isAbortError(err) || signal.aborted) return;
          console.warn(`[file-send] failed to send ${scrubLog(file.path)}: ${scrubLog(err instanceof Error ? err.message : String(err))}`);
        }
        if (!ensureActive()) return;
      }
    }
    } catch (err) {
      if (isAbortError(err) || eventContext.signal.aborted) return;
      throw err;
    }
  };
}

function normalizeCreatedFile(file: string | FilePayload): FilePayload {
  if (typeof file === 'string') {
    return { path: file, name: basename(file) };
  }
  return {
    ...file,
    name: file.name || basename(file.path),
  };
}

function dedupeCreatedFiles(files: Array<string | FilePayload>): FilePayload[] {
  const seen = new Set<string>();
  const out: FilePayload[] = [];
  for (const raw of files) {
    const file = normalizeCreatedFile(raw);
    const key = typeof file.dev === 'number' && typeof file.ino === 'number'
      ? `${file.dev}:${file.ino}`
      : file.path;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

async function isCreatedFileCurrent(file: FilePayload): Promise<boolean> {
  let info;
  try {
    const linkInfo = await lstat(file.path);
    if (!linkInfo.isFile()) return false;
    info = await stat(file.path);
    assertOutboundFileMatches(file, info);
  } catch {
    return false;
  }

  return true;
}
