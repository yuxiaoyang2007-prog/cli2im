import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  KimiWorkRpcClient,
  KimiWorkRpcError,
  parseKimiDaimonReadyLine,
  type KimiWorkWebSocketLike,
} from '../src/agents/kimi-work-protocol.js';

class FakeWebSocket extends EventEmitter implements KimiWorkWebSocketLike {
  readyState = 0;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', 1000, Buffer.alloc(0));
  }
}

describe('KimiWorkRpcClient', () => {
  it('connects with Bearer auth and matches JSON-RPC responses by id', async () => {
    const socket = new FakeWebSocket();
    const factory = vi.fn(() => socket);
    const client = new KimiWorkRpcClient('ws://127.0.0.1:1234/control', 'secret-token', {}, factory);

    const connecting = client.connect();
    expect(factory).toHaveBeenCalledWith('ws://127.0.0.1:1234/control', {
      headers: { Authorization: 'Bearer secret-token' },
    });
    socket.readyState = 1;
    socket.emit('open');
    await connecting;

    const response = client.sendRequest<{ accepted: boolean }>('conversations.send', {
      conversationKey: 'conversation-1',
      text: 'hello',
    });
    const request = JSON.parse(socket.sent[0]);
    expect(request).toEqual({
      jsonrpc: '2.0',
      id: 'client-1',
      method: 'conversations.send',
      params: { conversationKey: 'conversation-1', text: 'hello' },
    });

    socket.emit('message', JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: { accepted: true },
    }));
    await expect(response).resolves.toEqual({ accepted: true });
  });

  it('rejects a still-pending connect when disposed before open', async () => {
    const socket = new FakeWebSocket();
    const client = new KimiWorkRpcClient('ws://local/control', 'token', {}, () => socket);
    const connecting = client.connect();
    // Never emit 'open' — simulate the daimon exiting during the handshake, which
    // triggers dispose() from the shared-failure path. connect() must not hang.
    client.dispose('daimon failed');
    await expect(connecting).rejects.toThrow('daimon failed');
  });

  it('dispatches message and interaction notifications without an id', async () => {
    const socket = new FakeWebSocket();
    const onNotification = vi.fn();
    const client = new KimiWorkRpcClient('ws://local/control', 'token', { onNotification }, () => socket);
    const connecting = client.connect();
    socket.readyState = 1;
    socket.emit('open');
    await connecting;

    const snapshot = {
      conversationKey: 'conversation-1',
      turnId: 'turn-1',
      message: { id: 'message-1', role: 'assistant', status: 'streaming', parts: [{ kind: 'text', text: 'hi' }] },
    };
    const pending = {
      interaction: {
        id: 'ci_1',
        kind: 'tool-approval',
        createdAt: '2026-07-18T00:00:00.000Z',
        expiresAt: '2026-07-18T00:02:00.000Z',
        turn: { conversationKey: 'conversation-1', toolCallId: 'tool_1', toolName: 'Bash' },
      },
    };

    socket.emit('message', JSON.stringify({ jsonrpc: '2.0', method: 'conversations.message.snapshot', params: snapshot }));
    socket.emit('message', JSON.stringify({ jsonrpc: '2.0', method: 'interaction.pending', params: pending }));

    expect(onNotification).toHaveBeenNthCalledWith(1, {
      jsonrpc: '2.0',
      method: 'conversations.message.snapshot',
      params: snapshot,
    });
    expect(onNotification).toHaveBeenNthCalledWith(2, {
      jsonrpc: '2.0',
      method: 'interaction.pending',
      params: pending,
    });
  });

  it('rejects JSON-RPC errors with KimiWorkRpcError', async () => {
    const socket = new FakeWebSocket();
    const client = new KimiWorkRpcClient('ws://local/control', 'token', {}, () => socket);
    const connecting = client.connect();
    socket.readyState = 1;
    socket.emit('open');
    await connecting;

    const response = client.sendRequest('conversations.create', { sessionKey: '' });
    const request = JSON.parse(socket.sent[0]);
    socket.emit('message', JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32602, message: 'Invalid params', data: { field: 'sessionKey' } },
    }));

    await expect(response).rejects.toEqual(expect.objectContaining<KimiWorkRpcError>({
      name: 'KimiWorkRpcError',
      code: -32602,
      message: 'Invalid params',
    }));
  });

  it('rejects pending requests when the socket closes', async () => {
    const socket = new FakeWebSocket();
    const onClose = vi.fn();
    const client = new KimiWorkRpcClient('ws://local/control', 'token', { onClose }, () => socket);
    const connecting = client.connect();
    socket.readyState = 1;
    socket.emit('open');
    await connecting;

    const response = client.sendRequest('conversations.getMessages', { conversationKey: 'conversation-1' });
    socket.readyState = 3;
    socket.emit('close', 1006, Buffer.from('lost'));

    await expect(response).rejects.toThrow('closed');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('encodes interaction.respond with the measured nested response frame', async () => {
    const socket = new FakeWebSocket();
    const client = new KimiWorkRpcClient('ws://local/control', 'token', {}, () => socket);
    const connecting = client.connect();
    socket.readyState = 1;
    socket.emit('open');
    await connecting;

    // Verified wire shape: interactionId + nested response{decision:approved|rejected}.
    const response = client.sendRequest('interaction.respond', {
      interactionId: 'ci_1',
      response: { decision: 'rejected', feedback: 'Denied by user' },
    });
    const request = JSON.parse(socket.sent[0]);
    expect(request).toEqual({
      jsonrpc: '2.0',
      id: 'client-1',
      method: 'interaction.respond',
      params: { interactionId: 'ci_1', response: { decision: 'rejected', feedback: 'Denied by user' } },
    });
    socket.emit('message', JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }));
    await expect(response).resolves.toEqual({});
  });
});

describe('parseKimiDaimonReadyLine', () => {
  it('extracts the control URL and token from the real ready-line shape', () => {
    expect(parseKimiDaimonReadyLine(
      '2026-07-18 control server ready url=ws://127.0.0.1:4321/control auth=loopback-dev-token token=redacted fdRpc=unavailable',
    )).toEqual({ url: 'ws://127.0.0.1:4321/control', token: 'redacted' });
  });

  it('ignores unrelated log lines', () => {
    expect(parseKimiDaimonReadyLine('status=running')).toBeUndefined();
  });
});
