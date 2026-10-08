import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { MemoryStore } from '../src/memory/store.js';
import { handleMemoryCommand, type MemoryCommandContext } from '../src/memory/commands.js';
import { MemorySessions } from '../src/memory/sessions.js';
import { SessionStore } from '../src/session/store.js';
import { ChatQueue, QueueCancelledError } from '../src/session/queue.js';
import { AgentManager } from '../src/agents/manager.js';
import { ToolGate } from '../src/agents/tool-gate.js';
import type { AgentPlugin, AgentProcess, BotConfig, SessionKey } from '../src/types.js';

const fault = vi.hoisted(() => ({ point: '' }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  const fail = (point: string) => {
    if (fault.point !== point) return;
    fault.point = '';
    throw new Error('synthetic filesystem failure');
  };
  return { ...fs,
    mkdir: async (...args: Parameters<typeof fs.mkdir>) => { fail('mkdir'); return fs.mkdir(...args); },
    chmod: async (...args: Parameters<typeof fs.chmod>) => { fail('chmod'); return fs.chmod(...args); },
    readdir: async (...args: Parameters<typeof fs.readdir>) => { fail('readdir'); return fs.readdir(...args); },
    unlink: async (...args: Parameters<typeof fs.unlink>) => { fail('unlink'); return fs.unlink(...args); },
    rename: async (...args: Parameters<typeof fs.rename>) => { fail('rename'); return fs.rename(...args); },
    open: async (...args: Parameters<typeof fs.open>) => {
      const kind = args[1] === 'wx' ? 'temp' : 'directory';
      fail(`${kind}-open`);
      const handle = await fs.open(...args);
      return new Proxy(handle, { get(target, property) {
        if (property === 'writeFile') return async (...values: Parameters<typeof handle.writeFile>) => {
          await handle.writeFile(...values); fail('write');
        };
        if (property === 'sync' || property === 'close') return async () => {
          await handle[property](); fail(`${kind}-${property}`);
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    },
  };
});

const beforeRename = ['mkdir', 'chmod', 'readdir', 'temp-open', 'write', 'temp-sync', 'temp-close', 'rename'];
const afterRename = ['directory-open', 'directory-sync', 'directory-close'];

describe('B1 memory write failures', () => {
  let directory: string;
  let memory: MemoryStore;
  const principal = 'person:shared';
  const actor = 'feishu:app:alice';
  const bot = { memory: true, isolation: { enabled: true } } as BotConfig;
  beforeEach(async () => {
    fault.point = '';
    directory = await mkdtemp(join(process.cwd(), 'tests', '.memory-failures-'));
    memory = new MemoryStore(join(directory, 'memory'));
    await memory.add(principal, actor, 'target-original');
    await memory.edit(principal, actor, 1, 'target-edited', () => true);
  });
  afterEach(async () => { fault.point = ''; await rm(directory, { recursive: true, force: true }); });
  const context = (revoke = vi.fn(async (_principal: string) => {})): MemoryCommandContext => ({ store: memory,
    identity: { principal, actorKey: actor, group: false }, people: new Map(), revoke });

  it.each([...beforeRename, ...afterRename])('authorized forget failure at %s revokes running and queued sessions exactly once', async point => {
    const store = await SessionStore.create(':memory:');
    const queue = new ChatQueue();
    const manager = new AgentManager(new ToolGate([]), () => {});
    const spawn = (): AgentProcess => {
      const events = new EventEmitter();
      return { pid: 1, sessionId: 'old', stdin: new PassThrough(), stdout: new PassThrough({ objectMode: true }),
        on: (event: string, handler: (...args: any[]) => void) => { events.on(event, handler); },
        kill: vi.fn(() => { events.emit('exit', 0); }) };
    };
    manager.registerPlugin({ name: 'fake', spawn, resume: spawn,
      capabilities: { streamJson: true, permissionPrompt: false, sessionResume: true, gracefulCancel: false, slashCommands: [] },
      createStdoutParser: () => new PassThrough({ objectMode: true }),
    } as unknown as AgentPlugin);
    const registry = new MemorySessions(store, memory, key => { queue.cancelPending(key); manager.forgetSession(key); });
    const keys: SessionKey[] = ['feishu:chat:a:t1', 'telegram:chat:b:t2'];
    const processes: AgentProcess[] = [];
    const releases: Array<() => void> = [];
    const running: Promise<void>[] = [];
    const queued: Promise<unknown>[] = [];
    const queuedTask = vi.fn(async () => {});
    try {
      for (const key of keys) {
        const session = await store.getOrCreate(key, { agentName: 'fake', workingDirectory: directory });
        await store.updateAgentSessionId(session.id, 'old');
        await registry.bind(key, principal);
        processes.push(await manager.spawnAgent(key, 'fake', { workingDirectory: directory, permissionMode: 'blacklist' }, {
          onEvent: vi.fn(), onToolBlocked: vi.fn(), onPermissionTimeout: vi.fn(), onProcessExit: vi.fn(),
        }));
        running.push(queue.enqueue(key, () => new Promise<void>(resolve => { releases.push(resolve); })));
        queued.push(queue.enqueue(key, queuedTask).catch(error => error));
      }
      const revoke = vi.fn((p: string) => registry.revoke(p));
      fault.point = point;
      const reply = await handleMemoryCommand({ command: 'forget', args: ['1'] }, bot, 'alice', context(revoke));
      expect(fault.point).toBe('');
      expect(reply).toBe('删除结果未确认，已重置相关对话，请管理员检查');
      expect(revoke).toHaveBeenCalledExactlyOnceWith(principal);
      for (const result of await Promise.all(queued)) expect(result).toBeInstanceOf(QueueCancelledError);
      expect(queuedTask).not.toHaveBeenCalled();
      for (const [i, key] of keys.entries()) {
        expect(manager.hasProcess(key)).toBe(false);
        expect(processes[i].kill).toHaveBeenCalledOnce();
        expect((await store.getByKey(key))?.agentSessionId).toBeUndefined();
      }
      const doc = await memory.read(principal);
      expect(doc.generation).toBe(afterRename.includes(point) ? 1 : 0);
      expect(doc.entries).toHaveLength(afterRename.includes(point) ? 0 : 1);
      expect(await readdir(memory.directory)).toEqual([basename(memory.filePath(principal))]);
    } finally {
      releases.forEach(release => release());
      await Promise.all(running);
      for (const key of keys) manager.forgetSession(key);
      store.close();
    }
  });

  it('reports both uncertain deletion and failed revocation without claiming a reset', async () => {
    fault.point = 'directory-sync';
    const revoke = vi.fn(async (_p: string) => { throw new Error('synthetic revoke failure'); });
    expect(await handleMemoryCommand({ command: 'forget', args: ['1'] }, bot, 'alice', context(revoke)))
      .toBe('删除结果未确认，部分会话清理失败，请管理员检查');
    expect(revoke).toHaveBeenCalledOnce();
  });

  it('does not revoke for invalid IDs, missing entries or denied authorization', async () => {
    const ctx = context();
    for (const id of ['0', '99']) await handleMemoryCommand({ command: 'forget', args: [id] }, bot, 'alice', ctx);
    ctx.identity = { principal, actorKey: 'feishu:app:other', group: true };
    expect(await handleMemoryCommand({ command: 'forget', args: ['1'] }, bot, 'other', ctx)).toContain('只有创建者');
    expect(ctx.revoke).not.toHaveBeenCalled();
    expect((await memory.read(principal)).entries).toHaveLength(1);
  });

  it.each(['write', 'temp-sync', 'temp-close', 'rename'])('failed edit at %s then forget leaves no target text in official or managed temp files', async point => {
    fault.point = point;
    await expect(memory.edit(principal, actor, 1, 'target-new', () => true)).rejects.toThrow('未确认');
    expect(fault.point).toBe('');
    expect(await readdir(memory.directory)).toEqual([basename(memory.filePath(principal))]);
    // Simulate a previous process crashing before its failure cleanup.
    const orphan = `${memory.filePath(principal)}.tmp-${randomUUID()}`;
    await writeFile(orphan, 'target-original target-edited target-new');
    expect(await handleMemoryCommand({ command: 'forget', args: ['1'] }, bot, 'alice', context())).toContain('已忘记');
    const files = await readdir(memory.directory);
    expect(files).toEqual([basename(memory.filePath(principal))]);
    for (const name of files) expect(await readFile(join(memory.directory, name), 'utf8')).not.toContain('target-');
  });

  it('cleans only this principal managed UUID temps and serializes cleanup with other store instances', async () => {
    const path = memory.filePath(principal);
    const keep = [`${path}.tmp-manual`, `${path}.tmp-${randomUUID()}.backup`, `${memory.filePath('person:other')}.tmp-${randomUUID()}`];
    for (const name of keep) await writeFile(name, 'unrelated');
    const stale = `${path}.tmp-${randomUUID()}`;
    await writeFile(stale, 'target-original');
    const second = new MemoryStore(memory.directory);
    await Promise.all([
      memory.edit(principal, actor, 1, 'target-new', () => true),
      second.forget(principal, 1, () => true),
    ]);
    expect(await readdir(memory.directory)).toEqual(expect.arrayContaining(keep.map(name => basename(name))));
    expect(await readdir(memory.directory)).toHaveLength(keep.length + 1);
    expect(await readFile(path, 'utf8')).not.toContain('target-');
    for (const name of keep) expect(await readFile(name, 'utf8')).toBe('unrelated');
  });

  it('revokes when orphan cleanup fails before an authorized forget write', async () => {
    await writeFile(`${memory.filePath(principal)}.tmp-${randomUUID()}`, 'target-original');
    fault.point = 'unlink';
    const ctx = context();
    expect(await handleMemoryCommand({ command: 'forget', args: ['1'] }, bot, 'alice', ctx)).toContain('删除结果未确认');
    expect(ctx.revoke).toHaveBeenCalledOnce();
    // A later successful forget retries managed cleanup and removes every copy.
    expect(await handleMemoryCommand({ command: 'forget', args: ['1'] }, bot, 'alice', ctx)).toContain('已忘记');
    expect(await readdir(memory.directory)).toEqual([basename(memory.filePath(principal))]);
    expect(await readFile(memory.filePath(principal), 'utf8')).not.toContain('target-');
  });
});
