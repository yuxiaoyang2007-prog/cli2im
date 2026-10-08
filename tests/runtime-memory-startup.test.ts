import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { loadConfig, loadRuntimeConfig } from '../src/config/loader.js';
import { resolvePeople, resolveRuntimeMemoryIdentity } from '../src/memory/principal.js';
import { handleMemoryCommand } from '../src/memory/commands.js';
import { MemoryStore } from '../src/memory/store.js';
import { MemorySessions } from '../src/memory/sessions.js';
import { SessionStore } from '../src/session/store.js';
import { BotLifecycle } from '../src/runtime/bot-lifecycle.js';
import type { BotConfig, MemoryConfig, SessionKey } from '../src/types.js';

describe('runtime memory mappings with filtered bots', () => {
  let directory: string;
  let bots: Record<string, BotConfig>;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cli2im-runtime-memory-'));
    const base: BotConfig = { agent: 'codex', platform: 'feishu',
      feishu: { appId: 'healthy-app', appSecret: 'fixture' }, allowFrom: ['alice'],
      workingDirectory: directory, permissionMode: 'blacklist' };
    bots = {
      bad: { ...base, feishu: { appId: 'bad-app', appSecret: 'fixture' }, memory: true },
      memory: { ...base, memory: true, isolation: { enabled: true },
        userOverrides: { alice: { workingDirectory: join(directory, 'alice') } } },
      plain: { ...base, feishu: { appId: 'plain-app', appSecret: 'fixture' } },
    };
  });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  function fixture(people: MemoryConfig['people']): string {
    const scopedBots = Object.fromEntries(Object.entries(bots).map(([name, bot]) => [name, { ...bot,
      workingDirectory: join(directory, name, 'group'),
      userOverrides: bot.userOverrides && Object.fromEntries(Object.keys(bot.userOverrides).map(user => [user, { workingDirectory: join(directory, name, user) }])) } ]));
    const path = join(directory, 'config.yaml');
    writeFileSync(path, stringify({ bots: scopedBots, memory: { people }, agents: {},
      server: { port: 3900, token: 'fixture' }, dangerousPatterns: [] }));
    return path;
  }

  it.each(['feishu', 'telegram'] as const)(
    'starts memory and non-memory bots after loadRuntimeConfig filters a mapped %s bot', async platform => {
      if (platform === 'telegram') bots.bad = { ...bots.bad, platform, telegram: { token: 'fixture' } };
      const configuredPeople = { shared: [`${platform}:bad:alice`, 'feishu:memory:alice'] };
      const path = fixture(configuredPeople);
      expect(() => loadConfig(path)).toThrow('memory requires isolation.enabled');
      const { config, botErrors, botIdentities } = loadRuntimeConfig(path);
      expect(botErrors).toEqual({ bad: 'Invalid bot configuration' });
      expect(Object.keys(config.bots)).toEqual(['memory', 'plain']);
      expect(config.memory?.people).toEqual(configuredPeople);

      const lifecycle = new BotLifecycle();
      const connect = vi.fn(async (_name: string) => {});
      for (const name of Object.keys(config.bots)) {
        lifecycle.register(name, {
          start: async () => {
            await connect(name);
            resolvePeople(config.memory?.people, botIdentities);
          },
          stop: async () => {},
        });
      }
      expect((await lifecycle.startAll()).map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
      for (const name of ['memory', 'plain']) {
        expect(connect).toHaveBeenCalledWith(name);
        expect(lifecycle.status(name)).toMatchObject({ state: 'running', acceptsMessages: true });
      }
      const { identity, people } = resolveRuntimeMemoryIdentity('memory', botIdentities,
        config.memory?.people, new Map(), { userId: 'alice', chatId: 'chat', chatType: 'p2p' });
      expect(identity.principal).toBe('person:shared');
      expect([...people]).toEqual(platform === 'feishu'
        ? [['feishu:bad-app:alice', 'shared'], ['feishu:healthy-app:alice', 'shared']]
        : [['feishu:healthy-app:alice', 'shared']]);
      expect(botIdentities).toEqual({
        bad: platform === 'feishu' ? { platform, appId: 'bad-app' } : { platform },
        memory: { platform: 'feishu', appId: 'healthy-app' },
        plain: { platform: 'feishu', appId: 'plain-app' },
      });
      await lifecycle.stopAll();
    },
  );

  it('preserves alias-only principal and group creator authorization before and after filtering', async () => {
    bots.bad.feishu = bots.memory.feishu;
    bots.bad.memory = false;
    const configured = { shared: ['feishu:bad:alice', 'feishu:plain:alice'] };
    const before = loadRuntimeConfig(fixture(configured));
    bots.bad.memory = true; // The alias now fails the isolation requirement.
    const after = loadRuntimeConfig(fixture(configured));
    expect(before.config.bots.bad).toBeDefined();
    expect(after.config.bots.bad).toBeUndefined();
    expect(after.botIdentities).toEqual(before.botIdentities);
    const store = new MemoryStore(join(directory, 'memory'));
    for (const runtime of [before, after]) {
      const resolve = (name: string, chatType = 'p2p', userId = 'alice') => resolveRuntimeMemoryIdentity(
        name, runtime.botIdentities, runtime.config.memory?.people, new Map(), { userId, chatId: 'chat', chatType });
      const healthy = resolve('memory');
      const otherApp = resolve('plain');
      expect(healthy.identity.principal).toBe('person:shared');
      expect(otherApp.identity.principal).toBe(healthy.identity.principal);
      const group = resolve('memory', 'group');
      // A creator from the other mapped application must remain the same person.
      const entry = await store.add(group.identity.principal, otherApp.identity.actorKey, 'original');
      const outsider = resolve('memory', 'group', 'outsider');
      const revoke = vi.fn(async () => {});
      expect(await handleMemoryCommand({ command: 'memory', args: ['edit', String(entry.id), 'denied'] },
        runtime.config.bots.memory, 'outsider', { store, ...outsider, revoke })).toContain('只有创建者');
      expect(await handleMemoryCommand({ command: 'memory', args: ['edit', String(entry.id), 'updated'] },
        runtime.config.bots.memory, 'alice', { store, ...group, revoke })).toContain('已修改');
      expect(await handleMemoryCommand({ command: 'forget', args: [String(entry.id)] },
        runtime.config.bots.memory, 'alice', { store, ...group, revoke })).toContain('已忘记');
      expect(revoke).toHaveBeenCalledWith(group.identity.principal);
    }
  });

  it.each([false, true])('preserves alias-only cross-bot revocation scope with filtered=%s', async filtered => {
    bots.bad.feishu = bots.memory.feishu;
    bots.bad.memory = filtered;
    const { config, botIdentities } = loadRuntimeConfig(fixture({ shared: ['feishu:bad:alice', 'feishu:plain:alice'] }));
    const resolve = (name: string, userId = 'alice') => resolveRuntimeMemoryIdentity(
      name, botIdentities, config.memory?.people, new Map(), { userId, chatId: 'chat', chatType: 'p2p' });
    const healthy = resolve('memory');
    const otherApp = resolve('plain');
    const outsider = resolve('memory', 'outsider');
    const store = new MemoryStore(join(directory, 'memory'));
    const sessions = await SessionStore.create(':memory:');
    const invalidate = vi.fn();
    const registry = new MemorySessions(sessions, store, invalidate);
    const keys: SessionKey[] = ['feishu:chat:memory', 'feishu:chat:plain', 'feishu:other:memory'];
    try {
      for (const [index, resolved] of [healthy, otherApp, outsider].entries()) {
        const session = await sessions.getOrCreate(keys[index], { agentName: 'codex', workingDirectory: directory });
        await sessions.updateAgentSessionId(session.id, `agent-${index}`);
        await registry.bind(keys[index], resolved.identity.principal);
      }
      const entry = await store.add(otherApp.identity.principal, otherApp.identity.actorKey, 'shared memory');
      const reply = await handleMemoryCommand({ command: 'forget', args: [String(entry.id)] },
        config.bots.memory, 'alice', { store, ...healthy, revoke: principal => registry.revoke(principal) });
      expect(reply).toContain('已忘记');
      expect(new Set(invalidate.mock.calls.map(([key]) => key))).toEqual(new Set(keys.slice(0, 2)));
      expect((await sessions.getByKey(keys[0]))?.agentSessionId).toBeUndefined();
      expect((await sessions.getByKey(keys[1]))?.agentSessionId).toBeUndefined();
      expect((await sessions.getByKey(keys[2]))?.agentSessionId).toBe('agent-2');
      expect(await store.generation(healthy.identity.principal)).toBe(1);
      expect(await store.generation(otherApp.identity.principal)).toBe(1);
      expect(await store.generation(outsider.identity.principal)).toBe(0);
    } finally { sessions.close(); }
  });

  it('resolves filtered Telegram mappings only after getMe identity is available', () => {
    bots.bad = { ...bots.bad, platform: 'telegram', telegram: { token: 'fixture' } };
    const { config, botIdentities } = loadRuntimeConfig(fixture({ shared: ['telegram:bad:7'] }));
    const ids = new Map<string, string>();
    expect(config.bots.bad).toBeUndefined();
    expect(resolvePeople(config.memory?.people, botIdentities, ids).size).toBe(0);
    expect(() => resolveRuntimeMemoryIdentity('bad', botIdentities, config.memory?.people, ids,
      { userId: '7', chatId: 'chat', chatType: 'private' })).toThrow('尚未就绪');
    ids.set('bad', '123');
    expect([...resolvePeople(config.memory?.people, botIdentities, ids)]).toEqual([['telegram:123:7', 'shared']]);
  });

  it.each(['disabled', 'filtered', 'getMe pending'])(
    'rejects alias-only Telegram identity while %s, then restores person authorization and revocation', async state => {
      bots.memory = { ...bots.memory, platform: 'telegram', telegram: { token: 'fixture' },
        allowFrom: ['7'], userOverrides: { '7': { workingDirectory: join(directory, 'alice') } } };
      bots.bad = { ...bots.memory, enabled: state !== 'disabled',
        isolation: state === 'filtered' ? undefined : { enabled: true } };
      bots.unrelated = { ...bots.memory };
      const { config, botIdentities } = loadRuntimeConfig(fixture({
        shared: ['telegram:bad:7', 'feishu:plain:alice'],
      }));
      if (state === 'filtered') expect(config.bots.bad).toBeUndefined();
      if (state === 'disabled') expect(config.bots.bad.enabled).toBe(false);
      const ids = new Map([['memory', '123'], ['unrelated', '456']]);
      expect(resolvePeople(config.memory?.people, botIdentities, ids).pendingTelegramUserIds).toEqual(new Set(['7']));
      const resolve = (name: string, userId = '7', chatType = 'private') => resolveRuntimeMemoryIdentity(
        name, botIdentities, config.memory?.people, ids, { userId, chatId: 'chat', chatType });
      const pendingError = '记忆身份映射尚未就绪，请管理员确认相关 Telegram 机器人已连接';
      expect(() => resolve('bad')).toThrow(pendingError);
      for (const chatType of ['private', 'group', 'supergroup', 'channel']) {
        expect(() => resolve('memory', '7', chatType)).toThrow(pendingError);
      }
      // Even a different Telegram app cannot disambiguate this user until the alias is known.
      expect(() => resolve('unrelated')).toThrow(pendingError);
      expect(resolve('memory', '8').identity.principal).toBe('actor:telegram:123:8');
      expect(resolve('unrelated', '8').identity.principal).toBe('actor:telegram:456:8');
      expect(resolve('plain', '7').identity.principal).toBe('actor:feishu:plain-app:7');
      const other = resolve('plain', 'alice', 'p2p');
      expect(other.identity.principal).toBe('person:shared');

      // Supply only the getMe result; resolving metadata does not enable alias message handling.
      ids.set('bad', '123');
      expect(resolvePeople(config.memory?.people, botIdentities, ids).pendingTelegramUserIds.size).toBe(0);
      const healthy = resolve('memory');
      const outsider = resolve('memory', '8');
      expect(healthy.identity.principal).toBe(other.identity.principal);
      expect(resolve('unrelated').identity.principal).toBe('actor:telegram:456:7');
      const store = new MemoryStore(join(directory, 'memory'));
      const group = resolve('memory', '7', 'group');
      const entry = await store.add(group.identity.principal, other.identity.actorKey, 'original');
      const revoke = vi.fn(async () => {});
      expect(await handleMemoryCommand({ command: 'memory', args: ['edit', String(entry.id), 'denied'] },
        config.bots.memory, '8', { store, ...resolve('memory', '8', 'group'), revoke })).toContain('只有创建者');
      expect(await handleMemoryCommand({ command: 'memory', args: ['edit', String(entry.id), 'updated'] },
        config.bots.memory, '7', { store, ...group, revoke })).toContain('已修改');

      const sessions = await SessionStore.create(':memory:');
      const invalidate = vi.fn();
      const registry = new MemorySessions(sessions, store, invalidate);
      const keys: SessionKey[] = ['telegram:chat:memory', 'feishu:chat:plain', 'telegram:other:memory'];
      try {
        for (const [index, resolved] of [healthy, other, outsider].entries()) {
          const session = await sessions.getOrCreate(keys[index], { agentName: 'codex', workingDirectory: directory });
          await sessions.updateAgentSessionId(session.id, `agent-${index}`);
          await registry.bind(keys[index], resolved.identity.principal);
        }
        const shared = await store.add(other.identity.principal, other.identity.actorKey, 'shared memory');
        expect(await handleMemoryCommand({ command: 'forget', args: [String(shared.id)] },
          config.bots.memory, '7', { store, ...healthy, revoke: principal => registry.revoke(principal) })).toContain('已忘记');
        expect(new Set(invalidate.mock.calls.map(([key]) => key))).toEqual(new Set(keys.slice(0, 2)));
        expect((await sessions.getByKey(keys[0]))?.agentSessionId).toBeUndefined();
        expect((await sessions.getByKey(keys[1]))?.agentSessionId).toBeUndefined();
        expect((await sessions.getByKey(keys[2]))?.agentSessionId).toBe('agent-2');
        expect(await store.generation(healthy.identity.principal)).toBe(1);
        expect(await store.generation(outsider.identity.principal)).toBe(0);
      } finally { sessions.close(); }
    },
  );

  it('rejects pending Telegram aliases even with a known mapping and rejects conflicts once ready', () => {
    bots.memory = { ...bots.memory, platform: 'telegram', telegram: { token: 'fixture' } };
    bots.bad = { ...bots.memory, enabled: false };
    const { config, botIdentities } = loadRuntimeConfig(fixture({
      first: ['telegram:memory:7'], second: ['telegram:bad:7'],
    }));
    const ids = new Map([['memory', '123']]);
    const resolve = () => resolveRuntimeMemoryIdentity('memory', botIdentities, config.memory?.people, ids,
      { userId: '7', chatId: 'chat', chatType: 'private' });
    expect(() => resolve()).toThrow('记忆身份映射尚未就绪，请管理员确认相关 Telegram 机器人已连接');
    ids.set('bad', '123');
    expect(() => resolve()).toThrow('duplicate memory.people actor');
  });

  it('rejects a mapped filtered Feishu bot whose appId is unknown', () => {
    bots.bad.feishu = { appId: '', appSecret: 'fixture' };
    expect(() => loadRuntimeConfig(fixture({ shared: ['feishu:bad:alice'] }))).toThrow('尚未就绪');
  });

  it.each<{ people: NonNullable<MemoryConfig['people']>; error: string }>([
    { people: { first: ['feishu:missing:alice'] }, error: 'unknown' },
    { people: { first: ['telegram:bad:alice'] }, error: 'unknown' },
    { people: { first: ['feishu:bad:alice'], second: ['feishu:bad:alice'] }, error: 'duplicate' },
    { people: { first: ['feishu:bad:alice'], second: ['feishu:memory:alice'] }, error: 'duplicate' },
  ])('retains strict loading validation for $error mappings', ({ people, error }) => {
    bots.bad.feishu = bots.memory.feishu;
    expect(() => loadRuntimeConfig(fixture(people))).toThrow(error);
  });

  it('still rejects unknown bots and identity conflicts during runtime resolution', () => {
    bots.alias = bots.memory;
    const { botIdentities } = loadRuntimeConfig(fixture({ shared: ['feishu:bad:alice'] }));
    const resolve = (people: MemoryConfig['people']) => resolvePeople(people, botIdentities);
    expect(() => resolve({ shared: ['feishu:missing:alice'] })).toThrow('unknown');
    expect(() => resolve({ first: ['feishu:bad:alice'], second: ['feishu:bad:alice'] })).toThrow('duplicate');
    expect(() => resolve({ first: ['feishu:memory:alice'], second: ['feishu:alias:alice'] })).toThrow('duplicate');
    expect(() => resolve({ shared: ['telegram:memory:alice'] })).toThrow('unknown');
  });
});
