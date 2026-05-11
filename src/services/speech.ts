import type { AbortableOptions } from '../abort.js';
import { isAbortError, throwIfAborted } from '../abort.js';

const STT_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const TTS_URL = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer';
const DASH_SCOPE_AUDIO_URL_PREFIX = 'https://dashscope.aliyuncs.com/';

function getApiKey(): string | undefined {
  return process.env.DASHSCOPE_STT_API_KEY || process.env.DASHSCOPE_API_KEY;
}

export async function transcribeAudio(
  audioBuffer: Buffer,
  format = 'ogg',
  options: AbortableOptions = {},
): Promise<string | null> {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn('[speech] DASHSCOPE_STT_API_KEY not set, cannot transcribe audio');
    return null;
  }

  try {
    throwIfAborted(options.signal);
    const base64 = audioBuffer.toString('base64');
    const res = await fetch(STT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'qwen3-asr-flash',
        messages: [{
          role: 'user',
          content: [{
            type: 'input_audio',
            input_audio: {
              data: `data:audio/${format};base64,${base64}`,
              format,
            },
          }],
        }],
        stream: false,
      }),
      signal: options.signal,
    });
    throwIfAborted(options.signal);

    if (!res.ok) {
      console.error(`[speech] STT API error: ${res.status} ${res.statusText}`);
      return null;
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    if (isAbortError(err) || options.signal?.aborted) throw err;
    console.error('[speech] STT failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

export async function synthesizeSpeech(
  text: string,
  voiceOrOptions: string | AbortableOptions = 'longanyang',
  format = 'mp3',
  options: AbortableOptions = {},
): Promise<Buffer | null> {
  const voice = typeof voiceOrOptions === 'string' ? voiceOrOptions : 'longanyang';
  const mergedOptions = typeof voiceOrOptions === 'string' ? options : voiceOrOptions;
  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn('[speech] DASHSCOPE_API_KEY not set, cannot synthesize speech');
    return null;
  }

  if (!text.trim()) return null;

  try {
    throwIfAborted(mergedOptions.signal);
    const res = await fetch(TTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'cosyvoice-v3-flash',
        input: {
          text,
          voice,
          format,
          sample_rate: 22050,
        },
      }),
      signal: mergedOptions.signal,
    });
    throwIfAborted(mergedOptions.signal);

    if (!res.ok) {
      console.error(`[speech] TTS API error: ${res.status} ${res.statusText}`);
      return null;
    }

    const data = await res.json() as {
      output?: { audio?: { url?: string } };
    };
    const audioUrl = data.output?.audio?.url;
    if (!audioUrl) {
      console.error('[speech] TTS response missing audio URL');
      return null;
    }
    if (!audioUrl.startsWith(DASH_SCOPE_AUDIO_URL_PREFIX)) {
      console.error('[speech] TTS response returned untrusted audio URL');
      return null;
    }

    throwIfAborted(mergedOptions.signal);
    const audioRes = await fetch(audioUrl, { signal: mergedOptions.signal });
    throwIfAborted(mergedOptions.signal);
    if (!audioRes.ok) {
      console.error(`[speech] TTS audio download failed: ${audioRes.status}`);
      return null;
    }

    return Buffer.from(await audioRes.arrayBuffer());
  } catch (err) {
    if (isAbortError(err) || mergedOptions.signal?.aborted) throw err;
    console.error('[speech] TTS failed:', err instanceof Error ? err.message : err);
    return null;
  }
}
