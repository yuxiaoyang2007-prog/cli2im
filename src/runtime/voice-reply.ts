import { synthesizeSpeech as defaultSynthesizeSpeech } from '../services/speech.js';
import { scrubLog } from '../security/logging.js';
import type { PlatformAdapter, SessionKey } from '../types.js';
import type { AbortableOptions } from '../abort.js';
import { isAbortError } from '../abort.js';

type VoiceCapableAdapter = PlatformAdapter & {
  sendVoice?: (chatId: string, audioBuffer: Buffer, options?: AbortableOptions) => Promise<void>;
  sendAudio?: (chatId: string, audioBuffer: Buffer, options?: AbortableOptions) => Promise<void>;
};

export interface SendVoiceReplyOptions {
  adapter: PlatformAdapter;
  chatId: string;
  sessionKey: SessionKey;
  text: string;
  isCurrent: () => boolean;
  signal?: AbortSignal;
  forgetVoiceSession: (sessionKey: SessionKey) => void;
  synthesizeSpeech?: (text: string, options?: AbortableOptions) => Promise<Buffer | null>;
}

export async function sendVoiceReply({
  adapter,
  chatId,
  sessionKey,
  text,
  isCurrent,
  signal,
  forgetVoiceSession,
  synthesizeSpeech = defaultSynthesizeSpeech,
}: SendVoiceReplyOptions): Promise<void> {
  const trimmed = text.trim();
  forgetVoiceSession(sessionKey);
  const isActive = () => isCurrent() && !signal?.aborted;
  if (!trimmed || !isActive()) return;

  try {
    const audioBuffer = signal
      ? await synthesizeSpeech(trimmed, { signal })
      : await synthesizeSpeech(trimmed);
    if (!isActive()) return;
    if (audioBuffer) {
      const voiceAdapter = adapter as VoiceCapableAdapter;

      if (typeof voiceAdapter.sendVoice === 'function') {
        await voiceAdapter.sendVoice(chatId, audioBuffer, { signal });
        console.log(`[voice] TTS voice sent for ${scrubLog(sessionKey)}`);
        return;
      }
      if (typeof voiceAdapter.sendAudio === 'function') {
        await voiceAdapter.sendAudio(chatId, audioBuffer, { signal });
        console.log(`[voice] TTS voice sent for ${scrubLog(sessionKey)}`);
        return;
      }
    }
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) return;
    console.error(`[voice] TTS failed for ${scrubLog(sessionKey)}:`, scrubLog(err));
  }

  if (!isActive()) return;
  await adapter.send(chatId, { text: trimmed }, { signal });
}
