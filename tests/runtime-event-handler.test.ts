import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeEventHandler } from '../src/runtime/event-handler.js';
import { createRuntimeProcessExitHandler } from '../src/runtime/process-exit-handler.js';
import type { AgentEventContext } from '../src/agents/manager.js';
import type { RelayDeps } from '../src/relay/deliver.js';
import type { PlatformAdapter, SessionKey } from '../src/types.js';
import type { TelegramStreamController } from '../src/platforms/telegram/stream.js';
import type { StreamingCardController } from '../src/platforms/feishu/cards.js';

const sessionKey = 'telegram:chat_1:sourcebot' as SessionKey;

describe('createRuntimeEventHandler stale continuation guard', () => {
  it('bails before text side effects when the context signal is already aborted', async () => {
    const adapter = adapterStub();
    const controller = new AbortController();
    const { handler } = createHandler({ adapter });
    controller.abort();

    await handler(
      sessionKey,
      { type: 'text', content: 'stale text' },
      context(() => true, controller.signal),
    );

    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('passes the context signal to adapter sends and relay delivery', async () => {
    const adapter = adapterStub();
    const relayToOtherBotsFn = vi.fn();
    const controller = new AbortController();
    const { handler } = createHandler({ adapter, relayToOtherBotsFn });

    await handler(
      sessionKey,
      { type: 'text', content: 'hello' },
      context(() => true, controller.signal),
    );
    await handler(
      sessionKey,
      { type: 'result', sessionId: 'agent-new' },
      context(() => true, controller.signal),
    );

    expect(adapter.send).toHaveBeenCalledWith(
      'chat_1',
      { text: 'hello' },
      { signal: controller.signal },
    );
    expect(relayToOtherBotsFn).toHaveBeenCalledWith(
      'sourcebot',
      'chat_1',
      'hello',
      expect.any(Object),
      { signal: controller.signal },
    );
  });

  it('does not accumulate or forward noRelay slash events', async () => {
    const adapter = adapterStub();
    const relayToOtherBotsFn = vi.fn();
    const { handler } = createHandler({ adapter, relayToOtherBotsFn });

    await handler(
      sessionKey,
      { type: 'text', content: 'slash output', noRelay: true },
      context(() => true),
    );
    await handler(
      sessionKey,
      { type: 'result', sessionId: 'agent-new', noRelay: true },
      context(() => true),
    );
    await handler(
      sessionKey,
      { type: 'text', content: 'ordinary output' },
      context(() => true),
    );
    await handler(
      sessionKey,
      { type: 'result', sessionId: 'agent-new' },
      context(() => true),
    );

    expect(adapter.send).toHaveBeenCalledWith('chat_1', { text: 'slash output' }, expect.any(Object));
    expect(relayToOtherBotsFn).toHaveBeenCalledTimes(1);
    expect(relayToOtherBotsFn).toHaveBeenCalledWith(
      'sourcebot',
      'chat_1',
      'ordinary output',
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('passes the context signal to voice replies and created file sends', async () => {
    const adapter = adapterStub();
    const sendVoiceReply = vi.fn();
    const voiceSessions = new Map<SessionKey, string>([[sessionKey, 'voice']]);
    const controller = new AbortController();
    const { handler } = createHandler({ adapter, sendVoiceReply, voiceSessions });

    await handler(
      sessionKey,
      { type: 'result', sessionId: 'agent-new' },
      context(() => true, controller.signal),
    );

    expect(sendVoiceReply).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );

    const fileHandler = createHandler({ adapter }).handler;
    const dir = mkdtempSync(join(tmpdir(), 'cli2im-created-files-'));
    const filePath = join(dir, 'new-output.txt');
    try {
      writeFileSync(filePath, 'x');
      await fileHandler(
        sessionKey,
        { type: 'result', sessionId: 'agent-new', createdFiles: [filePath] },
        context(() => true, controller.signal),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(adapter.sendFile).toHaveBeenCalledWith(
      'chat_1',
      { path: filePath, name: 'new-output.txt' },
      { signal: controller.signal },
    );
  });

  it('passes the context signal to Feishu card events and Telegram stream finalization', async () => {
    const controller = new AbortController();
    const cardEvent = { type: 'text' as const, content: 'hello' };
    const cardController = {
      handleEvent: vi.fn(),
    } as unknown as StreamingCardController;
    const cardHandler = createHandler({ cardController }).handler;

    await cardHandler(sessionKey, cardEvent, context(() => true, controller.signal));

    expect(cardController.handleEvent).toHaveBeenCalledWith(
      sessionKey,
      cardEvent,
      { signal: controller.signal },
    );

    const tgStream = {
      appendText: vi.fn(),
      finalize: vi.fn(),
    } as unknown as TelegramStreamController;
    const tgHandler = createHandler({ tgStream }).handler;

    await tgHandler(
      sessionKey,
      { type: 'result', sessionId: 'agent-new' },
      context(() => true, controller.signal),
    );

    expect(tgStream.finalize).toHaveBeenCalledWith(sessionKey, { signal: controller.signal });
  });

  it('does not finalize the current Telegram stream when a result continuation goes stale', async () => {
    let current = true;
    const tgStream = {
      appendText: vi.fn(),
      finalize: vi.fn(),
    } as unknown as TelegramStreamController;
    const { handler, store } = createHandler({
      tgStream,
      storeUpdate: async () => {
        current = false;
      },
    });

    await handler(sessionKey, { type: 'result', sessionId: 'agent-old' }, context(() => current));

    expect(store.updateAgentSessionId).toHaveBeenCalledWith('db-session', 'agent-old');
    expect(tgStream.finalize).not.toHaveBeenCalled();
  });

  it('does not relay old buffered text when a result continuation goes stale', async () => {
    let current = true;
    const relayToOtherBotsFn = vi.fn();
    const { handler } = createHandler({
      relayToOtherBotsFn,
      storeUpdate: async () => {
        current = false;
      },
    });

    await handler(sessionKey, { type: 'text', content: 'old relay payload' }, context(() => current));
    await handler(sessionKey, { type: 'result', sessionId: 'agent-old' }, context(() => current));

    expect(relayToOtherBotsFn).not.toHaveBeenCalled();
  });

  it('does not send files from a stale result continuation after replacement', async () => {
    let current = true;
    const adapter = adapterStub();
    const { handler } = createHandler({
      adapter,
      storeUpdate: async () => {
        current = false;
      },
    });

    await handler(
      sessionKey,
      {
        type: 'result',
        sessionId: 'agent-old',
        createdFiles: ['/tmp/old-output.txt'],
      },
      context(() => current),
    );

    expect(adapter.sendFile).not.toHaveBeenCalled();
  });

  it('continues sending remaining created files when one send fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli2im-send-fail-'));
    try {
      const first = join(dir, 'first.md');
      const second = join(dir, 'second.md');
      writeFileSync(first, 'first');
      writeFileSync(second, 'second');
      const adapter = adapterStub();
      adapter.sendFile = vi.fn()
        .mockRejectedValueOnce(new Error('missing im:resource'))
        .mockResolvedValueOnce(undefined);
      const { handler } = createHandler({ adapter });

      await handler(
        sessionKey,
        {
          type: 'result',
          sessionId: 'agent-new',
          createdFiles: [first, second],
        },
        context(() => true),
      );

      expect(adapter.sendFile).toHaveBeenCalledTimes(2);
      expect(adapter.sendFile).toHaveBeenLastCalledWith(
        'chat_1',
        { path: second, name: 'second.md' },
        expect.any(Object),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips created files whose metadata changed before send', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli2im-created-file-'));
    try {
      const filePath = join(dir, 'out.md');
      writeFileSync(filePath, 'old');
      const info = statSync(filePath);
      writeFileSync(filePath, 'new content');
      const adapter = adapterStub();
      const { handler } = createHandler({ adapter });

      await handler(
        sessionKey,
        {
          type: 'result',
          sessionId: 'agent-new',
          createdFiles: [{
            path: filePath,
            name: 'out.md',
            size: info.size,
            mtimeMs: info.mtimeMs,
            dev: info.dev,
            ino: info.ino,
          }],
        },
        context(() => true),
      );

      expect(adapter.sendFile).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createRuntimeProcessExitHandler stale exit guard', () => {
  it('does not interrupt a replacement card when an old process exits', async () => {
    const oldController = new AbortController();
    const replacementController = new AbortController();
    oldController.abort();
    const cardController = {
      interruptCard: vi.fn(),
    } as unknown as StreamingCardController;
    const handler = createRuntimeProcessExitHandler({
      sessionKey,
      store: sessionIdStore(),
      stopTyping: vi.fn(),
      voiceSessions: new Map(),
      cardController,
      voiceResponseBuffer: { value: '' },
      sendVoiceReply: vi.fn(),
      getCurrentContext: () => context(() => true, replacementController.signal),
    });

    await handler(sessionKey, 1, context(() => false, oldController.signal), 'agent-session-old');

    expect(cardController.interruptCard).not.toHaveBeenCalled();
  });

  it('does not send crash notifications when the exit context signal is aborted', async () => {
    const adapter = adapterStub();
    const controller = new AbortController();
    controller.abort();
    const handler = createRuntimeProcessExitHandler({
      sessionKey,
      store: sessionIdStore(),
      adapter,
      stopTyping: vi.fn(),
      voiceSessions: new Map(),
      voiceResponseBuffer: { value: '' },
      sendVoiceReply: vi.fn(),
      getCurrentContext: () => undefined,
    });

    await handler(sessionKey, 1, context(() => false, controller.signal), 'agent-session-old');

    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('persists the exiting process session id before exit finalization work', async () => {
    const store = sessionIdStore();
    const order: string[] = [];
    store.updateAgentSessionId.mockImplementation(async () => {
      order.push('persist');
    });
    const cardController = {
      interruptCard: vi.fn(() => {
        order.push('finalize');
      }),
    } as unknown as StreamingCardController;
    const controller = new AbortController();
    const handler = createRuntimeProcessExitHandler({
      sessionKey,
      store,
      stopTyping: vi.fn(),
      voiceSessions: new Map(),
      cardController,
      voiceResponseBuffer: { value: '' },
      sendVoiceReply: vi.fn(),
      getCurrentContext: () => context(() => true, controller.signal),
    });

    await handler(sessionKey, 0, context(() => true, controller.signal), 'agent-session-s2');

    expect(store.updateAgentSessionId).toHaveBeenCalledWith('db-session', 'agent-session-s2');
    expect(order).toEqual(['persist', 'finalize']);
  });

  it('does not persist when the exiting context has been superseded', async () => {
    const store = sessionIdStore();
    const oldController = new AbortController();
    const replacementController = new AbortController();
    const handler = createRuntimeProcessExitHandler({
      sessionKey,
      store,
      stopTyping: vi.fn(),
      voiceSessions: new Map(),
      voiceResponseBuffer: { value: '' },
      sendVoiceReply: vi.fn(),
      getCurrentContext: () => context(() => true, replacementController.signal),
    });

    await handler(sessionKey, 0, context(() => false, oldController.signal), 'agent-session-s2');

    expect(store.updateAgentSessionId).not.toHaveBeenCalled();
  });

  it('does not persist when no session id is available on exit', async () => {
    const store = sessionIdStore();
    const controller = new AbortController();
    const handler = createRuntimeProcessExitHandler({
      sessionKey,
      store,
      stopTyping: vi.fn(),
      voiceSessions: new Map(),
      voiceResponseBuffer: { value: '' },
      sendVoiceReply: vi.fn(),
      getCurrentContext: () => context(() => true, controller.signal),
    });

    await handler(sessionKey, 0, context(() => true, controller.signal), undefined);

    expect(store.updateAgentSessionId).not.toHaveBeenCalled();
  });
});

function createHandler(opts: {
  adapter?: PlatformAdapter;
  tgStream?: TelegramStreamController;
  cardController?: StreamingCardController;
  relayToOtherBotsFn?: Parameters<typeof createRuntimeEventHandler>[0]['relayToOtherBotsFn'];
  sendVoiceReply?: Parameters<typeof createRuntimeEventHandler>[0]['sendVoiceReply'];
  voiceSessions?: Map<SessionKey, string>;
  storeUpdate?: () => Promise<void>;
}) {
  const store = {
    getByKey: vi.fn(async () => ({
      id: 'db-session',
      key: sessionKey,
      agentName: 'mock-agent',
      workingDirectory: '/tmp',
      state: 'active' as const,
      createdAt: 0,
      lastActiveAt: 0,
    })),
    updateAgentSessionId: vi.fn(async () => {
      await opts.storeUpdate?.();
    }),
  };

  const handler = createRuntimeEventHandler({
    sessionKey,
    store,
    voiceSessions: opts.voiceSessions ?? new Map(),
    adapter: opts.adapter ?? adapterStub(),
    cardController: opts.cardController,
    tgStream: opts.tgStream,
    voiceResponseBuffer: { value: '' },
    stopTyping: vi.fn(),
    sendVoiceReply: opts.sendVoiceReply ?? vi.fn(),
    relayDeps: {} as RelayDeps,
    relayToOtherBotsFn: opts.relayToOtherBotsFn,
  });

  return { handler, store };
}

function sessionIdStore() {
  return {
    getByKey: vi.fn(async () => ({
      id: 'db-session',
      key: sessionKey,
      agentName: 'mock-agent',
      workingDirectory: '/tmp',
      state: 'active' as const,
      createdAt: 0,
      lastActiveAt: 0,
    })),
    updateAgentSessionId: vi.fn(async () => undefined),
  };
}

function adapterStub(): PlatformAdapter {
  return {
    name: 'mock',
    connect: vi.fn(),
    disconnect: vi.fn(),
    onMessage: vi.fn(),
    send: vi.fn(async () => 'msg_1'),
    editMessage: vi.fn(),
    deleteMessage: vi.fn(),
    sendFile: vi.fn(),
  };
}

function context(isCurrent: () => boolean, signal = new AbortController().signal): AgentEventContext {
  return { isCurrent, signal } as AgentEventContext;
}
