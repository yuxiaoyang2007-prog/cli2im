import { describe, expect, it, vi } from 'vitest';
import { sendVoiceReply } from '../src/runtime/voice-reply.js';
import type { PlatformAdapter, SessionKey } from '../src/types.js';

const sessionKey = 'telegram:chat_1:sourcebot' as SessionKey;

describe('sendVoiceReply', () => {
  it('does not send voice audio when TTS finishes after the process goes stale', async () => {
    let current = true;
    const adapter = {
      ...adapterStub(),
      sendVoice: vi.fn(async () => {}),
    };
    const synthesizeSpeech = vi.fn(async () => {
      current = false;
      return Buffer.from('audio');
    });

    await sendVoiceReply({
      adapter,
      chatId: 'chat_1',
      sessionKey,
      text: 'old response',
      isCurrent: () => current,
      synthesizeSpeech,
      forgetVoiceSession: vi.fn(),
    });

    expect(synthesizeSpeech).toHaveBeenCalledWith('old response');
    expect(adapter.sendVoice).not.toHaveBeenCalled();
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('does not send a fallback text reply when TTS finishes after the process goes stale', async () => {
    let current = true;
    const adapter = adapterStub();
    const synthesizeSpeech = vi.fn(async () => {
      current = false;
      return Buffer.from('audio');
    });

    await sendVoiceReply({
      adapter,
      chatId: 'chat_1',
      sessionKey,
      text: 'old response',
      isCurrent: () => current,
      synthesizeSpeech,
      forgetVoiceSession: vi.fn(),
    });

    expect(synthesizeSpeech).toHaveBeenCalledWith('old response');
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('does not send voice audio when the signal aborts between TTS and adapter send', async () => {
    const controller = new AbortController();
    const adapter = {
      ...adapterStub(),
      sendAudio: vi.fn(async () => {}),
    };
    const synthesizeSpeech = vi.fn(async (_text: string, options?: { signal?: AbortSignal }) => {
      expect(options?.signal).toBe(controller.signal);
      controller.abort();
      return Buffer.from('audio');
    });

    await sendVoiceReply({
      adapter,
      chatId: 'chat_1',
      sessionKey,
      text: 'old response',
      signal: controller.signal,
      isCurrent: () => true,
      synthesizeSpeech,
      forgetVoiceSession: vi.fn(),
    });

    expect(adapter.sendAudio).not.toHaveBeenCalled();
    expect(adapter.send).not.toHaveBeenCalled();
  });
});

function adapterStub(): PlatformAdapter {
  return {
    name: 'mock',
    connect: vi.fn(),
    disconnect: vi.fn(),
    onMessage: vi.fn(),
    send: vi.fn(async () => 'msg_1'),
    editMessage: vi.fn(),
    deleteMessage: vi.fn(),
  };
}
