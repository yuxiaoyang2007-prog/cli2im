import type { AgentEventContext, AgentManagerEvents } from '../agents/manager.js';
import type { StreamingCardController } from '../platforms/feishu/cards.js';
import type { TelegramStreamController } from '../platforms/telegram/stream.js';
import { buildCrashNotification } from '../platforms/feishu/markdown.js';
import type { SendVoiceReplyOptions } from './voice-reply.js';
import { isAbortError } from '../abort.js';
import { scrubLog } from '../security/logging.js';
import type { PlatformAdapter, SessionKey } from '../types.js';

export interface RuntimeProcessExitHandlerDeps {
  sessionKey: SessionKey;
  stopTyping: (chatId: string) => void;
  voiceSessions: Map<SessionKey, string>;
  cardController?: StreamingCardController;
  tgStream?: TelegramStreamController;
  adapter?: PlatformAdapter;
  voiceResponseBuffer: { value: string };
  sendVoiceReply: (options: SendVoiceReplyOptions) => Promise<void>;
  getCurrentContext: (sessionKey: SessionKey) => AgentEventContext | undefined;
}

export function createRuntimeProcessExitHandler(
  deps: RuntimeProcessExitHandlerDeps,
): AgentManagerEvents['onProcessExit'] {
  const {
    sessionKey,
    stopTyping,
    voiceSessions,
    cardController,
    tgStream,
    adapter,
    voiceResponseBuffer,
    sendVoiceReply,
    getCurrentContext,
  } = deps;
  const chatId = sessionKey.split(':')[1];

  return async (sk, code, exitContext) => {
    const signal = exitContext.signal;
    const isCurrent = () => getCurrentContext(sk)?.signal === signal && !signal.aborted;

    console.log(`[pipeline] ${scrubLog(sk)}: process exited with code=${code}`);
    stopTyping(chatId);

    if (!isCurrent()) return;

    try {
      cardController?.interruptCard(sk, { signal });

      const isVoiceSession = voiceSessions.has(sk);
      if (isVoiceSession) {
        if (code !== 0) voiceResponseBuffer.value += `\n\n${buildCrashNotification(code)}`;
        if (voiceResponseBuffer.value.trim()) {
          await sendVoiceReply({
            adapter: adapter!,
            chatId,
            sessionKey: sk,
            text: voiceResponseBuffer.value,
            isCurrent,
            signal,
            forgetVoiceSession: (key) => voiceSessions.delete(key),
          });
        }
        if (!isCurrent()) return;
        voiceResponseBuffer.value = '';
      } else if (tgStream) {
        if (code !== 0) {
          tgStream.appendText(sk, chatId, `\n\n${buildCrashNotification(code)}`);
        }
        if (!isCurrent()) return;
        await tgStream.finalize(sk, { signal });
      } else if (code !== 0 && adapter) {
        if (!isCurrent()) return;
        await adapter.send(chatId, { text: buildCrashNotification(code) }, { signal });
      }
    } catch (err) {
      if (isAbortError(err) || signal.aborted) return;
      throw err;
    }
  };
}
