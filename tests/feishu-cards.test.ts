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

  it('reopens the card for a drained turn so its output is not dropped after finalize', async () => {
    const adapter = {
      sendCard: vi.fn().mockResolvedValue('msg_1'),
      updateCard: vi.fn().mockResolvedValue(undefined),
    } as unknown as FeishuAdapter;
    const controller = new StreamingCardController(adapter);
    const sessionKey = 'feishu:chat_1:ccbot';

    await controller.startCard('chat_1', sessionKey, 'Claude Code');

    // Turn A: streams, then finalizes.
    controller.handleEvent(sessionKey, { type: 'text', content: 'answer A' });
    controller.handleEvent(sessionKey, { type: 'result', sessionId: 'ses_1' });
    await vi.waitFor(() => expect(adapter.updateCard).toHaveBeenCalledWith(
      'msg_1',
      expect.stringContaining('answer A'),
      expect.any(Number),
    ));

    // Turn B drained from the plugin's internal queue — no new startCard.
    // Its events must reopen the same card instead of being dropped.
    controller.handleEvent(sessionKey, { type: 'text', content: 'answer B' });
    controller.handleEvent(sessionKey, { type: 'result', sessionId: 'ses_1' });

    await vi.waitFor(() => expect(adapter.updateCard).toHaveBeenCalledWith(
      'msg_1',
      expect.stringContaining('answer B'),
      expect.any(Number),
    ));
    // The same Feishu message is reused — no second card was sent.
    expect(adapter.sendCard).toHaveBeenCalledTimes(1);
  });

  it('renders an error-only drained turn after the previous turn finalized', async () => {
    const adapter = {
      sendCard: vi.fn().mockResolvedValue('msg_1'),
      updateCard: vi.fn().mockResolvedValue(undefined),
    } as unknown as FeishuAdapter;
    const controller = new StreamingCardController(adapter);
    const sessionKey = 'feishu:chat_1:ccbot';

    await controller.startCard('chat_1', sessionKey, 'Claude Code');
    controller.handleEvent(sessionKey, { type: 'text', content: 'answer A' });
    controller.handleEvent(sessionKey, { type: 'result', sessionId: 'ses_1' });
    await vi.waitFor(() => expect(adapter.updateCard).toHaveBeenCalledWith(
      'msg_1',
      expect.stringContaining('answer A'),
      expect.any(Number),
    ));

    // A drained turn that fails before any text — its only event is `error`,
    // which must still reopen + render so the user gets the failure message.
    controller.handleEvent(sessionKey, { type: 'error', message: 'turn B blew up' });

    await vi.waitFor(() => expect(adapter.updateCard).toHaveBeenCalledWith(
      'msg_1',
      expect.stringContaining('turn B blew up'),
      expect.any(Number),
    ));
    expect(adapter.sendCard).toHaveBeenCalledTimes(1);
  });

  it('serializes patches so a slow previous finalize cannot overwrite the reopened turn', async () => {
    const aFinal = deferred<void>();
    let calls = 0;
    const adapter = {
      sendCard: vi.fn().mockResolvedValue('msg_1'),
      updateCard: vi.fn(() => {
        calls++;
        return calls === 1 ? aFinal.promise : Promise.resolve();
      }),
    } as unknown as FeishuAdapter;
    const controller = new StreamingCardController(adapter);
    const sessionKey = 'feishu:chat_1:ccbot';
    const updateMock = adapter.updateCard as unknown as ReturnType<typeof vi.fn>;

    await controller.startCard('chat_1', sessionKey, 'Claude Code');
    controller.handleEvent(sessionKey, { type: 'text', content: 'answer A' });
    controller.handleEvent(sessionKey, { type: 'result', sessionId: 'ses_1' }); // finalize A → patch #1 hangs
    await Promise.resolve();
    expect(updateMock.mock.calls.length).toBe(1);

    // Drained turn B reopens + finalizes while A's finalize patch is in flight.
    controller.handleEvent(sessionKey, { type: 'text', content: 'answer B' });
    controller.handleEvent(sessionKey, { type: 'result', sessionId: 'ses_1' });
    await Promise.resolve();
    await Promise.resolve();

    // B's patch is chained behind A's pending finalize — not issued yet.
    expect(updateMock.mock.calls.length).toBe(1);

    // Release A's finalize; B's patch now runs and the last write is B's.
    aFinal.resolve();
    await vi.waitFor(() => {
      const last = updateMock.mock.calls[updateMock.mock.calls.length - 1];
      expect(last[1]).toContain('answer B');
    });
  });

  it('does not reopen a finalized card on a non-content event', async () => {
    const adapter = {
      sendCard: vi.fn().mockResolvedValue('msg_1'),
      updateCard: vi.fn().mockResolvedValue(undefined),
    } as unknown as FeishuAdapter;
    const controller = new StreamingCardController(adapter);
    const sessionKey = 'feishu:chat_1:ccbot';

    await controller.startCard('chat_1', sessionKey, 'Claude Code');
    controller.handleEvent(sessionKey, { type: 'text', content: 'answer A' });
    controller.handleEvent(sessionKey, { type: 'result', sessionId: 'ses_1' });
    await vi.waitFor(() => expect(adapter.updateCard).toHaveBeenCalled());
    const callsAfterFinalize = (adapter.updateCard as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    // Stray non-content events after finalize must not reopen / re-render.
    controller.handleEvent(sessionKey, { type: 'status', sessionId: 'ses_1', message: 'late' });
    controller.handleEvent(sessionKey, { type: 'result', sessionId: 'ses_1' });
    await Promise.resolve();

    expect((adapter.updateCard as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFinalize);
    expect(adapter.sendCard).toHaveBeenCalledTimes(1);
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
