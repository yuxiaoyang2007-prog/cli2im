import { describe, expect, it, vi } from 'vitest';
import { TelegramStreamController } from '../src/platforms/telegram/stream.js';
import type { PlatformAdapter, SessionKey } from '../src/types.js';

describe('TelegramStreamController', () => {
  it('does not send buffered text twice when finalize is called concurrently', async () => {
    const sendGate = deferred<string>();
    const adapter = {
      send: vi.fn(() => sendGate.promise),
    } as unknown as PlatformAdapter;
    const controller = new TelegramStreamController(adapter);
    const sessionKey = 'telegram:chat_1:ccbot' as SessionKey;

    controller.appendText(sessionKey, 'chat_1', 'final output');
    const firstFinalize = controller.finalize(sessionKey);
    await vi.waitFor(() => expect(adapter.send).toHaveBeenCalledTimes(1));

    const secondFinalize = controller.finalize(sessionKey);
    sendGate.resolve('msg_1');
    await Promise.all([firstFinalize, secondFinalize]);

    expect(adapter.send).toHaveBeenCalledTimes(1);
    expect(adapter.send).toHaveBeenCalledWith('chat_1', { text: 'final output' });
  });

  it('preserves a replacement stream when an old finalize completes later', async () => {
    const oldSend = deferred<string>();
    const adapter = {
      send: vi.fn((chatId: string, content: { text?: string }) => (
        content.text === 'old output' ? oldSend.promise : Promise.resolve(`msg_${chatId}`)
      )),
    } as unknown as PlatformAdapter;
    const controller = new TelegramStreamController(adapter);
    const sessionKey = 'telegram:chat_1:ccbot' as SessionKey;

    controller.appendText(sessionKey, 'chat_1', 'old output');
    const oldFinalize = controller.finalize(sessionKey);
    await vi.waitFor(() => expect(adapter.send).toHaveBeenCalledWith('chat_1', {
      text: 'old output',
    }));

    controller.appendText(sessionKey, 'chat_1', 'new output');
    oldSend.resolve('msg_old');
    await oldFinalize;

    await controller.finalize(sessionKey);

    expect(adapter.send).toHaveBeenCalledWith('chat_1', { text: 'new output' });
  });

  it('does not send a finalized stream when the signal is already aborted', async () => {
    const adapter = {
      send: vi.fn(async () => 'msg_1'),
    } as unknown as PlatformAdapter;
    const controller = new TelegramStreamController(adapter);
    const sessionKey = 'telegram:chat_1:ccbot' as SessionKey;
    const abortController = new AbortController();

    controller.appendText(sessionKey, 'chat_1', 'final output');
    abortController.abort();
    await controller.finalize(sessionKey, { signal: abortController.signal });

    expect(adapter.send).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
