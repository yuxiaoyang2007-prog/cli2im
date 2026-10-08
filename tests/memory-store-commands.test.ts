import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory/store.js';
import { handleMemoryCommand, type MemoryCommandContext } from '../src/memory/commands.js';
import { InboundPipeline, parseBridgeCommand } from '../src/pipeline.js';
import { handleBridgeCommand } from '../src/index.js';
import { SessionStore } from '../src/session/store.js';
import type { AppConfig, BotConfig, PlatformAdapter } from '../src/types.js';

describe('slice 3 memory store and bridge commands', () => {
  let directory: string;
  let store: MemoryStore;
  const principal = 'group:feishu:app:chat';
  const actor = 'feishu:app:alice';
  const bot: BotConfig = { agent: 'codex', platform: 'feishu', allowFrom: ['alice', 'bob', 'alias'], adminUsers: ['admin'],
    workingDirectory: '/fixture', permissionMode: 'blacklist', memory: true, isolation: { enabled: true } };
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'cli2im-memory-store-')); store = new MemoryStore(join(directory, 'memory')); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
  const context = (user = 'alice'): MemoryCommandContext => ({ store,
    identity: { principal, actorKey: `feishu:app:${user}`, group: true }, people: new Map([[actor, 'p'], ['feishu:app:alias', 'p']]), revoke: vi.fn(async () => {}) });

  it('serializes concurrent writes, persists counters, and uses 700/600 modes', async () => {
    const second = new MemoryStore(store.directory);
    const added = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? store : second).add(principal, actor, `text-${i}`)));
    expect(new Set(added.map(entry => entry.id)).size).toBe(40);
    expect((await second.read(principal)).nextId).toBe(41);
    expect((await stat(store.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(store.filePath(principal))).mode & 0o777).toBe(0o600);
    expect(await readdir(store.directory)).toHaveLength(1);
    expect(store.filePath(principal)).toMatch(/\/[a-f0-9]{32}\.json$/);
    expect((await store.read('actor:other')).entries).toEqual([]);
  });

  it('bounds history at 20 and atomically forgets entry/history with durable generation', async () => {
    await store.add(principal, actor, 'first');
    for (let i = 0; i < 25; i++) await store.edit(principal, actor, 1, `version-${i}`, () => true);
    const document = await store.read(principal);
    expect(document.entries[0].history).toHaveLength(20);
    expect(document.entries[0].history.at(-1)).toMatchObject({ text: 'version-23', by: actor });
    await expect(store.forget(principal, 1, () => false)).rejects.toThrow('创建者');
    expect(await store.generation(principal)).toBe(0);
    expect(await store.forget(principal, 1, () => true)).toBe(1);
    expect(await new MemoryStore(store.directory).generation(principal)).toBe(1);
    const bytes = await readFile(store.filePath(principal), 'utf8');
    expect(bytes).not.toContain('version-');
    expect((await store.add(principal, actor, 'next')).id).toBe(2);
  });

  it.each(['not-json', '{"version":1}', '{"version":2,"principal":"other","entries":[]}'])('refuses to overwrite corrupt files: %s', async bytes => {
    await store.add(principal, actor, 'valid');
    await writeFile(store.filePath(principal), bytes);
    await expect(store.add(principal, actor, 'overwrite')).rejects.toThrow('损坏');
    await expect(store.forget(principal, 1, () => true)).rejects.toThrow('损坏');
    expect(await readFile(store.filePath(principal), 'utf8')).toBe(bytes);
  });

  it('enforces 2000 characters and 200 entries without consuming IDs on rejection', async () => {
    await expect(store.add(principal, actor, '')).rejects.toThrow('2000');
    await expect(store.add(principal, actor, 'x'.repeat(2001))).rejects.toThrow('2000');
    await Promise.all(Array.from({ length: 200 }, () => store.add(principal, actor, 'x')));
    await expect(store.add(principal, actor, 'overflow')).rejects.toThrow('200 条');
    expect((await store.read(principal)).nextId).toBe(201);
  });

  it('enforces group ownership and permits mapped creators and bot admins', async () => {
    expect(await handleMemoryCommand({ command: 'remember', args: ['original'] }, bot, 'alice', context())).toBe('已记住 #1');
    expect(await handleMemoryCommand({ command: 'memory', args: ['edit', '1', 'bad'] }, bot, 'bob', context('bob'))).toContain('只有创建者');
    expect(await handleMemoryCommand({ command: 'forget', args: ['1'] }, bot, 'bob', context('bob'))).toContain('只有创建者');
    expect(await handleMemoryCommand({ command: 'memory', args: ['edit', '1', 'alias edit'] }, bot, 'alias', context('alias'))).toContain('/new');
    expect(await handleMemoryCommand({ command: 'memory', args: ['history', '1'] }, bot, 'bob', context('bob'))).toContain('original');
    const admin = context('admin');
    expect(await handleMemoryCommand({ command: 'forget', args: ['1'] }, bot, 'admin', admin)).toContain('旧聊天记录仍保存');
    expect(admin.revoke).toHaveBeenCalledWith(principal);
  });

  it('paginates list/history and reports missing entries and malformed IDs', async () => {
    const ctx = context();
    expect(await handleMemoryCommand({ command: 'memory', args: [] }, bot, 'alice', ctx)).toBe('暂无记忆');
    for (let i = 0; i < 3; i++) await store.add(principal, actor, 'x'.repeat(2000));
    expect(await handleMemoryCommand({ command: 'memory', args: [] }, bot, 'alice', ctx)).toContain('/memory 2');
    expect(await handleMemoryCommand({ command: 'memory', args: ['99'] }, bot, 'alice', ctx)).toContain('页码无效');
    expect(await handleMemoryCommand({ command: 'forget', args: ['0'] }, bot, 'alice', ctx)).toContain('有效的记忆编号');
    expect(await handleMemoryCommand({ command: 'memory', args: ['history', '99'] }, bot, 'alice', ctx)).toContain('未找到');
  });

  it('preserves explicit multiline text and reports incomplete revocation without claiming success', async () => {
    const ctx = context();
    await handleMemoryCommand(parseBridgeCommand('/remember first\n  second')!, bot, 'alice', ctx);
    expect((await store.read(principal)).entries[0].text).toBe('first\n  second');
    await handleMemoryCommand(parseBridgeCommand('/memory edit 1 edited\n  text')!, bot, 'alice', ctx);
    expect((await store.read(principal)).entries[0].text).toBe('edited\n  text');
    ctx.revoke = async () => { throw new Error('synthetic failure'); };
    const reply = await handleMemoryCommand(parseBridgeCommand('/forget 1')!, bot, 'alice', ctx);
    expect(reply).toContain('部分会话清理失败');
    expect(reply).not.toContain('相关对话已重新开始');
    expect(await store.generation(principal)).toBe(1);
  });

  it.each(['remember', 'memory', 'forget'])('integration: pipeline and bridge dispatch /%s without an agent; disabled bots are untouched', async command => {
    const pipeline = new InboundPipeline({ bots: { bot } } as unknown as AppConfig);
    const message = { platform: 'feishu', chatId: 'chat', userId: 'alice', chatType: 'group', text: `/${command} ${command === 'remember' ? 'saved' : ''}` };
    const ctx = pipeline.process(message, 'bot');
    expect('rejected' in ctx).toBe(false);
    if ('rejected' in ctx) throw new Error(ctx.reason);
    expect(ctx.bridgeCommand?.command).toBe(command);
    expect('rejected' in pipeline.process({ ...message, userId: 'outsider' }, 'bot')).toBe(true);
    const sessions = await SessionStore.create(':memory:');
    const adapter = { send: vi.fn(async () => 'sent') } as unknown as PlatformAdapter;
    const manager = { sendMessage: vi.fn() };
    await handleBridgeCommand(ctx.bridgeCommand!, ctx.sessionKey, 'bot', 'chat', adapter, sessions, manager as never, {} as never,
      undefined, undefined, new Map(), { fastModeBySession: new Map() }, { ...bot, memory: false },
      { platform: 'feishu', userId: 'alice', chatType: 'group' }, undefined, { memory: context() });
    expect(adapter.send).toHaveBeenLastCalledWith('chat', { text: '该机器人未开启长期记忆', plainText: true });
    expect(manager.sendMessage).not.toHaveBeenCalled();
    expect((await store.read(principal)).entries).toEqual([]);
    if (command === 'remember') {
      await handleBridgeCommand(ctx.bridgeCommand!, ctx.sessionKey, 'bot', 'chat', adapter, sessions, manager as never, {} as never,
        undefined, undefined, new Map(), { fastModeBySession: new Map() }, bot,
        { platform: 'feishu', userId: 'alice', chatType: 'group' }, undefined, { memory: context() });
      expect((await store.read(principal)).entries[0].text).toBe('saved');
      expect(manager.sendMessage).not.toHaveBeenCalled();
    }
    sessions.close();
  });
});
