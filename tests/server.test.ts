import { describe, expect, it, vi } from 'vitest';
import { HttpServer, isAuthorizedBearerToken } from '../src/services/server.js';

describe('isAuthorizedBearerToken', () => {
  it('accepts the exact bearer token', () => {
    expect(isAuthorizedBearerToken('Bearer secret-token', 'secret-token')).toBe(true);
  });

  it('rejects same-length invalid bearer tokens', () => {
    expect(isAuthorizedBearerToken('Bearer secret-tokem', 'secret-token')).toBe(false);
  });

  it('rejects unequal-length tokens without throwing', () => {
    expect(isAuthorizedBearerToken('Bearer short', 'secret-token')).toBe(false);
    expect(isAuthorizedBearerToken(undefined, 'secret-token')).toBe(false);
  });
});

describe('HttpServer handoff validation', () => {
  it('accepts valid handoff requests', async () => {
    const acceptHandoff = vi.fn().mockResolvedValue({ success: true });
    const server = new HttpServer('secret-token', deps({ acceptHandoff }), {
      botNames: ['ccbot'],
      agentNames: ['claude-code'],
    });

    await server.start('127.0.0.1', 0);
    try {
      const res = await postHandoff(server, {
        botName: 'ccbot',
        sessionId: 'session_123',
        workDir: '/Users/test/project',
        agentName: 'claude-code',
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      expect(acceptHandoff).toHaveBeenCalledTimes(1);
    } finally {
      await server.stop();
    }
  });

  it('rejects invalid handoff workDir with 400 before spawning', async () => {
    const acceptHandoff = vi.fn().mockResolvedValue({ success: true });
    const server = new HttpServer('secret-token', deps({ acceptHandoff }), {
      botNames: ['ccbot'],
      agentNames: ['claude-code'],
    });

    await server.start('127.0.0.1', 0);
    try {
      const res = await postHandoff(server, {
        botName: 'ccbot',
        sessionId: 'session_123',
        workDir: '/etc',
        agentName: 'claude-code',
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('Invalid workDir');
      expect(acceptHandoff).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it('rejects unknown handoff botName with 400 before spawning', async () => {
    const acceptHandoff = vi.fn().mockResolvedValue({ success: true });
    const server = new HttpServer('secret-token', deps({ acceptHandoff }), {
      botNames: ['ccbot'],
      agentNames: ['claude-code'],
    });

    await server.start('127.0.0.1', 0);
    try {
      const res = await postHandoff(server, {
        botName: 'otherbot',
        sessionId: 'session_123',
        workDir: '/Users/test/project',
        agentName: 'claude-code',
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('Unknown botName');
      expect(acceptHandoff).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it('rejects invalid handoff sessionId patterns with 400 before spawning', async () => {
    const acceptHandoff = vi.fn().mockResolvedValue({ success: true });
    const server = new HttpServer('secret-token', deps({ acceptHandoff }), {
      botNames: ['ccbot'],
      agentNames: ['claude-code'],
    });

    await server.start('127.0.0.1', 0);
    try {
      const res = await postHandoff(server, {
        botName: 'ccbot',
        sessionId: '../../etc/passwd',
        workDir: '/Users/test/project',
        agentName: 'claude-code',
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('Invalid sessionId');
      expect(acceptHandoff).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it('rejects colon injection in optional handoff chatId and platform before spawning', async () => {
    const acceptHandoff = vi.fn().mockResolvedValue({ success: true });
    const server = new HttpServer('secret-token', deps({ acceptHandoff }), {
      botNames: ['ccbot'],
      agentNames: ['claude-code'],
    });

    await server.start('127.0.0.1', 0);
    try {
      const withColonChatId = await postHandoff(server, {
        botName: 'ccbot',
        sessionId: 'session_123',
        workDir: '/Users/test/project',
        agentName: 'claude-code',
        chatId: 'realchat:otherbot',
        platform: 'feishu',
      });
      expect(withColonChatId.status).toBe(400);
      expect((await withColonChatId.json()).error).toBe('Invalid chatId');

      const withColonPlatform = await postHandoff(server, {
        botName: 'ccbot',
        sessionId: 'session_123',
        workDir: '/Users/test/project',
        agentName: 'claude-code',
        chatId: 'realchat',
        platform: 'feishu:realchat',
      });
      expect(withColonPlatform.status).toBe(400);
      expect((await withColonPlatform.json()).error).toBe('Invalid platform');

      expect(acceptHandoff).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it('rejects JSON null handoff bodies with 400 before spawning', async () => {
    const acceptHandoff = vi.fn().mockResolvedValue({ success: true });
    const server = new HttpServer('secret-token', deps({ acceptHandoff }), {
      botNames: ['ccbot'],
      agentNames: ['claude-code'],
    });

    await server.start('127.0.0.1', 0);
    try {
      const res = await postRawHandoff(server, 'null');

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid request body' });
      expect(acceptHandoff).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });
});

function deps(overrides: Partial<ConstructorParameters<typeof HttpServer>[1]> = {}): ConstructorParameters<typeof HttpServer>[1] {
  return {
    acceptHandoff: vi.fn().mockResolvedValue({ success: true }),
    releaseHandoff: vi.fn().mockResolvedValue({ sessionId: 'session_123', resumeCommand: 'claude --resume session_123' }),
    getStatus: () => ({ uptime: 1, activeSessions: 0, bots: ['ccbot'] }),
    ...overrides,
  };
}

async function postHandoff(server: HttpServer, body: Record<string, unknown>): Promise<Response> {
  return postRawHandoff(server, JSON.stringify(body));
}

async function postRawHandoff(server: HttpServer, body: string): Promise<Response> {
  const address = (server as unknown as { server: { address: () => { port: number } } }).server.address();
  return fetch(`http://127.0.0.1:${address.port}/api/handoff/accept`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer secret-token',
      'content-type': 'application/json',
    },
    body,
  });
}
