import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentManager } from '../src/agents/manager.js';
import { hotReloadAgentPlugin } from '../src/agents/plugin-loader.js';
import { ToolGate } from '../src/agents/tool-gate.js';
import { HttpServer } from '../src/services/server.js';
import type { AgentPlugin, AgentProcess, SpawnOpts } from '../src/types.js';

function createFakeProcess(sessionId: string): AgentProcess {
  const emitter = new EventEmitter();
  return {
    pid: 1234,
    sessionId,
    stdin: new Writable({
      write(_chunk, _enc, done) {
        done();
      },
    }),
    stdout: new PassThrough({ objectMode: true }),
    kill: () => {
      emitter.emit('exit', 0);
    },
    on: (event: 'exit' | 'error', handler: (...args: any[]) => void) => {
      emitter.on(event, handler);
    },
  };
}

describe('Plugin hot-reload & HTTP /api/bots reload', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('reloads a plugin from disk with cache-busting without touching other active agents', async () => {
    const bundleDir = mkdtempSync(join(tmpdir(), 'cli2im-hot-plugin-'));
    tempDirs.push(bundleDir);

    const modulePath = join(bundleDir, 'agy.js');
    writeFileSync(
      modulePath,
      `
export class AgyPlugin {
  constructor(binary) {
    this.binary = binary;
    this.name = 'agy';
    this.displayName = 'AGY v1';
    this.capabilities = { streamJson: true, permissionPrompt: false, sessionResume: true, gracefulCancel: false, slashCommands: [] };
  }
  async preflight() { return { ok: true, version: 'v1' }; }
  buildSpawnArgs() { return ['--v1']; }
  createStdoutParser() { return null; }
  formatStdinMessage() { return ''; }
  formatPermissionResponse() { return ''; }
  spawn() { return null; }
  resume() { return null; }
}
`,
      'utf8',
    );

    const manager = new AgentManager(new ToolGate([]), () => undefined);
    const otherShutdown = vi.fn(async () => undefined);
    const otherProc = createFakeProcess('cc-session-1');
    const otherPlugin: AgentPlugin = {
      name: 'claude-code',
      displayName: 'Claude Code',
      capabilities: {
        streamJson: true,
        permissionPrompt: false,
        sessionResume: true,
        gracefulCancel: false,
        slashCommands: [],
      },
      preflight: async () => ({ ok: true }),
      spawn: (_opts: SpawnOpts) => otherProc,
      resume: (_id: string, _opts: SpawnOpts) => otherProc,
      buildSpawnArgs: () => [],
      createStdoutParser: () => new PassThrough({ objectMode: true }),
      formatStdinMessage: () => '',
      formatPermissionResponse: () => '',
      shutdown: otherShutdown,
    };
    manager.registerPlugin(otherPlugin);
    await manager.spawnAgent(
      'feishu:chat1:ccbot',
      'claude-code',
      { workingDirectory: process.cwd(), permissionMode: 'bypass' },
      {
        onEvent: () => undefined,
        onToolBlocked: () => undefined,
        onPermissionTimeout: () => undefined,
        onProcessExit: () => undefined,
      },
    );

    const agyShutdownV1 = vi.fn(async () => undefined);
    const v1 = await hotReloadAgentPlugin({
      agentManager: manager,
      agentName: 'agy',
      agentConfig: { binary: '/bin/agy' },
      bundleDir,
    });
    v1.shutdown = agyShutdownV1;
    expect(v1.displayName).toBe('AGY v1');
    expect((await v1.preflight()).version).toBe('v1');

    // Update bundle on disk and hot-reload again immediately
    writeFileSync(
      modulePath,
      `
export class AgyPlugin {
  constructor(binary) {
    this.binary = binary;
    this.name = 'agy';
    this.displayName = 'AGY v2';
    this.capabilities = { streamJson: true, permissionPrompt: false, sessionResume: true, gracefulCancel: false, slashCommands: [] };
  }
  async preflight() { return { ok: true, version: 'v2' }; }
  buildSpawnArgs() { return ['--v2']; }
  createStdoutParser() { return null; }
  formatStdinMessage() { return ''; }
  formatPermissionResponse() { return ''; }
  spawn() { return null; }
  resume() { return null; }
}
`,
      'utf8',
    );

    const v2 = await hotReloadAgentPlugin({
      agentManager: manager,
      agentName: 'agy',
      agentConfig: { binary: '/bin/agy' },
      bundleDir,
    });

    expect(v2.displayName).toBe('AGY v2');
    expect((await v2.preflight()).version).toBe('v2');
    expect(manager.getPlugin('agy')).toBe(v2);
    expect(agyShutdownV1).toHaveBeenCalledTimes(1);
    expect(manager.hasProcess('feishu:chat1:ccbot')).toBe(true);
    expect(otherShutdown).not.toHaveBeenCalled();

    manager.killAgent('feishu:chat1:ccbot');
  });

  it('accepts action=reload on POST /api/bots', async () => {
    const controlBot = vi.fn(async () => undefined);
    const server = new HttpServer('test-token', {
      acceptHandoff: async () => ({ success: true }),
      releaseHandoff: async () => ({ sessionId: 's', resumeCommand: 'r' }),
      getStatus: () => ({ uptime: 100, activeSessions: 0, bots: ['agy_bot'] }),
      controlBot,
    });

    await server.start('127.0.0.1', 0);
    try {
      const address = (server as unknown as { server: { address: () => { port: number } } }).server.address();
      const resp = await fetch(`http://127.0.0.1:${address.port}/api/bots`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'agy_bot', action: 'reload' }),
      });

      expect(resp.status).toBe(200);
      await expect(resp.json()).resolves.toEqual({ success: true });
      expect(controlBot).toHaveBeenCalledWith('agy_bot', 'reload');
    } finally {
      await server.stop();
    }
  });
});
