import { describe, it, expect, vi } from 'vitest';
import { StreamingCardController } from '../src/platforms/feishu/cards.js';
import { buildCLISessionCard } from '../src/platforms/feishu/markdown.js';
import type { FeishuAdapter } from '../src/platforms/feishu/adapter.js';

describe('StreamingCardController', () => {
  it('does not finalize or update card on status events', async () => {
    const adapter = {
      sendCard: vi.fn().mockResolvedValue('msg_1'),
      updateCard: vi.fn().mockResolvedValue(undefined),
    } as unknown as FeishuAdapter;
    const controller = new StreamingCardController(adapter);

    await controller.startCard('chat_1', 'feishu:chat_1:ccbot', 'Claude Code');
    controller.handleEvent('feishu:chat_1:ccbot', {
      type: 'status',
      sessionId: 'ses_1',
      message: 'thread started',
    });

    expect(adapter.updateCard).not.toHaveBeenCalled();
  });

  it('preserves a replacement card when an old finalize completes later', async () => {
    const oldUpdate = deferred<void>();
    const adapter = {
      sendCard: vi.fn()
        .mockResolvedValueOnce('msg_old')
        .mockResolvedValueOnce('msg_new'),
      updateCard: vi.fn((messageId: string) => (
        messageId === 'msg_old' ? oldUpdate.promise : Promise.resolve()
      )),
    } as unknown as FeishuAdapter;
    const controller = new StreamingCardController(adapter);
    const sessionKey = 'feishu:chat_1:ccbot';

    await controller.startCard('chat_1', sessionKey, 'Claude Code');
    controller.handleEvent(sessionKey, { type: 'text', content: 'old output' });
    controller.interruptCard(sessionKey);
    await vi.waitFor(() => expect(adapter.updateCard).toHaveBeenCalledWith(
      'msg_old',
      expect.any(String),
      expect.any(Number),
    ));

    await controller.startCard('chat_1', sessionKey, 'Claude Code', 'Starting...');
    oldUpdate.resolve();
    await oldUpdate.promise;

    controller.handleEvent(sessionKey, { type: 'text', content: 'new output' });
    controller.handleEvent(sessionKey, { type: 'result', sessionId: 'ses_new' });

    await vi.waitFor(() => expect(adapter.updateCard).toHaveBeenCalledWith(
      'msg_new',
      expect.stringContaining('new output'),
      expect.any(Number),
    ));
  });

  it('does not finalize a card when the event signal is already aborted', async () => {
    const adapter = {
      sendCard: vi.fn().mockResolvedValue('msg_1'),
      updateCard: vi.fn().mockResolvedValue(undefined),
    } as unknown as FeishuAdapter;
    const controller = new StreamingCardController(adapter);
    const sessionKey = 'feishu:chat_1:ccbot';
    const abortController = new AbortController();

    await controller.startCard('chat_1', sessionKey, 'Claude Code');
    abortController.abort();
    controller.handleEvent(sessionKey, { type: 'result', sessionId: 'ses_1' }, {
      signal: abortController.signal,
    });

    await Promise.resolve();
    expect(adapter.updateCard).not.toHaveBeenCalled();
  });
});

describe('buildCLISessionCard', () => {
  it('escapes user-derived markdown in session card body', () => {
    const card = buildCLISessionCard([
      {
        sessionId: 'session_123',
        cwd: '/Users/test/[repo]_`main`',
        title: '[click](https://evil.test) *_`title`',
        gitBranch: 'feat/[admin]_`branch`',
        status: 'idle',
        lastModified: Date.now(),
        fileSize: 42,
      },
    ]);

    const markdown = (card.rawElements?.[0] as { content: string }).content;
    expect(markdown).toContain('\\[click\\]');
    expect(markdown).toContain('\\_');
    expect(markdown).toContain('\\`title\\`');
    expect(markdown).toContain('feat/\\[admin\\]\\_\\`branch\\`');
    expect(markdown).not.toContain('[click](https://evil.test)');
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
