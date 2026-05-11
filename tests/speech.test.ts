import { afterEach, describe, expect, it, vi } from 'vitest';
import { synthesizeSpeech, transcribeAudio } from '../src/services/speech.js';

describe('speech service abort plumbing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('passes abort signals to STT fetch operations', async () => {
    vi.stubEnv('DASHSCOPE_API_KEY', 'key');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'hello' } }],
    })));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await transcribeAudio(Buffer.from('audio'), 'ogg', { signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('passes abort signals to TTS request and audio download fetch operations', async () => {
    vi.stubEnv('DASHSCOPE_API_KEY', 'key');
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/SpeechSynthesizer')) {
        return new Response(JSON.stringify({
          output: { audio: { url: 'https://dashscope.aliyuncs.com/audio/a.mp3' } },
        }));
      }
      return new Response('audio-bytes');
    });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await synthesizeSpeech('hello', { signal: controller.signal });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://dashscope.aliyuncs.com/audio/a.mp3',
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('rejects TTS audio URLs outside DashScope before fetching audio bytes', async () => {
    vi.stubEnv('DASHSCOPE_API_KEY', 'key');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      output: { audio: { url: 'https://attacker.example/a.mp3' } },
    })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(synthesizeSpeech('hello')).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
