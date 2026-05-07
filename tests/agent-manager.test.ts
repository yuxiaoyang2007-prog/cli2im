import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentManager } from '../src/agents/manager.js';
import { ToolGate } from '../src/agents/tool-gate.js';
import type { AgentPlugin, AgentProcess, SpawnOpts, AgentEvent } from '../src/types.js';
import { Transform } from 'node:stream';
import { EventEmitter, Readable, Writable } from 'node:stream';

function createMockPlugin(): AgentPlugin {
  return {
    name: 'mock-agent',
    displayName: 'Mock Agent',
    capabilities: {
      streamJson: true,
      permissionPrompt: true,
      sessionResume: true,
      gracefulCancel: true,
      slashCommands: [],
    },
    preflight: vi.fn().mockResolvedValue({ ok: true, version: '1.0.0' }),
    spawn: vi.fn().mockImplementation(() => createMockProcess()),
    resume: vi.fn().mockImplementation(() => createMockProcess()),
    buildSpawnArgs: vi.fn().mockReturnValue(['--test']),
    createStdoutParser: vi.fn().mockImplementation(() => new Transform({
      objectMode: true,
      transform(chunk, _, cb) { cb(null, chunk); },
    })),
    formatStdinMessage: vi.fn().mockImplementation((msg) => JSON.stringify(msg) + '\n'),
    formatPermissionResponse: vi.fn().mockImplementation((id, d) => JSON.stringify({ id, d }) + '\n'),
    formatCancelMessage: vi.fn().mockReturnValue('cancel\n'),
  };
}

function createMockProcess(): AgentProcess {
  const stdin = new Writable({ write(_, __, cb) { cb(); } });
  const stdout = new Readable({ read() {} });
  const ee = new EventEmitter();
  return {
    pid: 12345,
    sessionId: '',
    stdin,
    stdout,
    kill: vi.fn(),
    on: (event: string, handler: any) => { ee.on(event, handler); },
  };
}

describe('AgentManager', () => {
  let manager: AgentManager;

  beforeEach(() => {
    const toolGate = new ToolGate(['sudo\\s+']);
    manager = new AgentManager(toolGate);
  });

  it('registers plugins', () => {
    const plugin = createMockPlugin();
    manager.registerPlugin(plugin);
    expect(manager.getPlugin('mock-agent')).toBe(plugin);
  });

  it('returns undefined for unregistered plugin', () => {
    expect(manager.getPlugin('nonexistent')).toBeUndefined();
  });

  it('lists registered plugin names', () => {
    manager.registerPlugin(createMockPlugin());
    expect(manager.listPlugins()).toEqual(['mock-agent']);
  });
});
