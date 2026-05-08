const STT_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const TTS_URL = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer';

function getApiKey(): string | undefined {
  return process.env.DASHSCOPE_STT_API_KEY || process.env.DASHSCOPE_API_KEY;
}

export async function transcribeAudio(audioBuffer: Buffer, format = 'ogg'): Promise<string | null> {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn('[speech] DASHSCOPE_STT_API_KEY not set, cannot transcribe audio');
    return null;
  }

  try {
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
    });

    if (!res.ok) {
      console.error(`[speech] STT API error: ${res.status} ${res.statusText}`);
      return null;
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error('[speech] STT failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

export async function synthesizeSpeech(
  text: string,
  voice = 'longanyang',
  format = 'mp3',
): Promise<Buffer | null> {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn('[speech] DASHSCOPE_API_KEY not set, cannot synthesize speech');
    return null;
  }

  if (!text.trim()) return null;

  try {
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
    });

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

    const audioRes = await fetch(audioUrl);
    if (!audioRes.ok) {
      console.error(`[speech] TTS audio download failed: ${audioRes.status}`);
      return null;
    }

    return Buffer.from(await audioRes.arrayBuffer());
  } catch (err) {
    console.error('[speech] TTS failed:', err instanceof Error ? err.message : err);
    return null;
  }
}
