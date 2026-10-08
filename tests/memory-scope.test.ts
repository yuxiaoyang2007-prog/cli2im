import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { resolveExecutionScope, ensureExecutionSession } from '../src/runtime/execution-scope.js';
import { collectBotIdentities, botAppKey, resolveMemoryIdentity, resolvePeople, resolveRuntimeMemoryIdentity } from '../src/memory/principal.js';
import { loadConfig } from '../src/config/loader.js';
import { SessionStore } from '../src/session/store.js';
import { downloadInboundAttachments } from '../src/media.js';
import { handleBridgeCommand } from '../src/index.js';
import { TelegramAdapter } from '../src/platforms/telegram/adapter.js';
import type { BotConfig, InboundMessage, PlatformAdapter } from '../src/types.js';

describe('slice 2 execution scope and identity', () => {
  let directory: string;
  let bot: BotConfig;
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'cli2im-memory-scope-')));
    await Promise.all(['group', 'alice', 'bob'].map(name => mkdir(join(directory, name))));
    bot = { agent: 'codex', platform: 'feishu', feishu: { appId: 'app', appSecret: 'fixture' },
      allowFrom: ['alice', 'bob'], workingDirectory: join(directory, 'group'), permissionMode: 'blacklist',
      userOverrides: { alice: { workingDirectory: join(directory, 'alice') }, bob: { workingDirectory: join(directory, 'bob') } } };
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
  const message = (chatType = 'p2p', userId = 'alice'): InboundMessage => ({ platform: 'feishu', chatId: 'chat', userId, chatType, text: 'hello' });

  it.each(['group', 'supergroup', 'channel'])('uses the shared workspace for successive senders and topics in %s', type => {
    expect(resolveExecutionScope(bot, message(type)).workingDirectory).toBe(bot.workingDirectory);
    expect(resolveExecutionScope(bot, { ...message(type, 'bob'), threadId: 'topic' } as InboundMessage).workingDirectory).toBe(bot.workingDirectory);
    expect(resolveExecutionScope(bot, message()).workingDirectory).toBe(join(directory, 'alice'));
    expect(resolveExecutionScope(bot, message('p2p', 'other')).workingDirectory).toBe(bot.workingDirectory);
    bot.isolation = { enabled: true };
    expect(() => resolveExecutionScope(bot, message('p2p', 'other'))).toThrow('工作区');
  });

  it('keys identity by application, preserves rename, and shares only explicit people', () => {
    const other = { ...bot, feishu: { appId: 'other-app', appSecret: 'fixture' } };
    const people = resolvePeople({ person: ['feishu:renamed:alice', 'telegram:tg:7'] },
      collectBotIdentities({ renamed: bot, tg: { ...bot, platform: 'telegram' } }), new Map([['tg', '123']]));
    const identity = resolveMemoryIdentity(bot, botAppKey(bot), message(), people);
    expect(identity).toMatchObject({ actorKey: 'feishu:app:alice', principal: 'person:person' });
    expect(resolveMemoryIdentity(other, botAppKey(other), message(), people).principal).toBe('actor:feishu:other-app:alice');
    expect(resolveMemoryIdentity(bot, botAppKey(bot), message('group'), people).principal).toBe('group:feishu:app:chat');
    expect(resolveMemoryIdentity(bot, botAppKey(bot), { ...message('group', 'bob'), chatId: 'chat' }, people).principal).toBe('group:feishu:app:chat');
  });

  it('rejects alias collisions, duplicate people, unknown bots and unresolved Telegram identity', () => {
    expect(() => resolvePeople({ a: ['feishu:one:alice'], b: ['feishu:two:alice'] }, collectBotIdentities({ one: bot, two: bot }))).toThrow('duplicate');
    expect(() => resolvePeople({ a: ['telegram:tg:1'], b: ['telegram:tg:1'] }, collectBotIdentities({ tg: { ...bot, platform: 'telegram' } }), new Map())).toThrow('duplicate');
    expect(() => resolvePeople({ a: ['feishu:missing:a'] }, collectBotIdentities({ bot }))).toThrow('unknown');
    expect(() => botAppKey({ ...bot, platform: 'telegram' })).toThrow('尚未就绪');
    expect(() => resolvePeople({ a: ['telegram:one:1'], b: ['telegram:two:1'] },
      collectBotIdentities({ one: { ...bot, platform: 'telegram' }, two: { ...bot, platform: 'telegram' } }), new Map([['one', '123'], ['two', '123']]))).toThrow('duplicate');
  });

  it('skips a disabled Telegram bot with pending identity without blocking the current Feishu bot', () => {
    const bots = { bot, tg: { ...bot, platform: 'telegram' as const, enabled: false } };
    const configured = { shared: ['feishu:bot:alice', 'telegram:tg:7'] };
    const result = resolveRuntimeMemoryIdentity('bot', collectBotIdentities(bots), configured, new Map(), message());
    expect(result.identity.principal).toBe('person:shared');
    expect([...result.people.keys()]).toEqual(['feishu:app:alice']);
    expect(() => resolveRuntimeMemoryIdentity('tg', collectBotIdentities(bots), configured, new Map(), message())).toThrow('尚未就绪');
  });

  it('isolates getMe failure and revalidates cross-bot mappings after Telegram reconnects', async () => {
    const adapter = new TelegramAdapter({ token: 'fixture', botName: 'tg' });
    const internals = adapter as unknown as { botApi: () => Promise<unknown>; readOffset: () => number; schedulePoll: () => void };
    const api = vi.spyOn(internals, 'botApi').mockRejectedValueOnce(new Error('synthetic getMe failure'));
    vi.spyOn(internals, 'readOffset').mockReturnValue(0);
    vi.spyOn(internals, 'schedulePoll').mockImplementation(() => undefined);
    const bots = { bot, tg: { ...bot, platform: 'telegram' as const }, healthy: { ...bot, platform: 'telegram' as const } };
    const configured = { shared: ['feishu:bot:alice', 'telegram:tg:7'] };
    await adapter.connect(); // getMe failures leave the app identity pending while polling continues.
    const ids = new Map<string, string>([['healthy', '123']]);
    expect(adapter.appKey).toBeUndefined();
    expect(resolveRuntimeMemoryIdentity('bot', collectBotIdentities(bots), configured, ids, message()).identity.principal).toBe('person:shared');
    expect(() => resolveRuntimeMemoryIdentity('tg', collectBotIdentities(bots), undefined, ids, message())).toThrow('尚未就绪');
    expect(() => resolveRuntimeMemoryIdentity('healthy', collectBotIdentities(bots), configured, ids, message('private', '7')))
      .toThrow('记忆身份映射尚未就绪，请管理员确认相关 Telegram 机器人已连接');
    await adapter.disconnect();
    api.mockResolvedValue({ id: 123, username: 'MyBot' });
    await adapter.connect();
    try {
      ids.set('tg', adapter.appKey!);
      expect(resolveRuntimeMemoryIdentity('healthy', collectBotIdentities(bots), configured, ids, message('private', '7')).identity.principal).toBe('person:shared');
      expect(resolveRuntimeMemoryIdentity('tg', collectBotIdentities(bots), configured, ids, message('private', '7')).identity.principal).toBe('person:shared');
      expect(resolveRuntimeMemoryIdentity('bot', collectBotIdentities(bots), configured, ids, message()).people.get('telegram:123:7')).toBe('shared');
      const conflicting = { ...configured, other: ['telegram:alias:7'] };
      const aliases = { ...bots, alias: bots.tg };
      expect(() => resolveRuntimeMemoryIdentity('bot', collectBotIdentities(aliases), conflicting, ids, message())).not.toThrow();
      ids.set('alias', '123');
      expect(() => resolveRuntimeMemoryIdentity('bot', collectBotIdentities(aliases), conflicting, ids, message())).toThrow('duplicate');
      expect(() => resolveRuntimeMemoryIdentity('tg', collectBotIdentities(aliases), conflicting, ids, message('private', '7'))).toThrow('duplicate');
    } finally { await adapter.disconnect(); }
  });

  async function config(changes: Partial<BotConfig> = {}, people?: Record<string, string[]>) {
    const path = join(directory, 'fixture.yaml');
    await writeFile(path, stringify({ bots: { bot: { ...bot, ...changes } }, agents: {},
      memory: { dir: join(directory, 'memory'), people }, dangerousPatterns: [], server: { port: 1234, token: 'fixture' } }));
    return loadConfig(path);
  }
  it('parses optional fields and enforces isolated override and memory gates', async () => {
    expect((await config()).bots.bot.memory).toBeUndefined();
    expect((await config({ memory: true, isolation: { enabled: true, readable: [directory] } })).bots.bot.memory).toBe(true);
    await expect(config({ memory: true })).rejects.toThrow('requires isolation');
    await expect(config({ isolation: { enabled: true }, adminUsers: ['admin'] })).rejects.toThrow('every allowed');
    await expect(config({ isolation: { enabled: true }, allowFrom: ['*'] })).rejects.toThrow('public');
    await expect(config({ isolation: { enabled: true }, userOverrides: { alice: { workingDirectory: directory }, bob: { workingDirectory: join(directory, 'bob') } } })).rejects.toThrow('overlap');
    await expect(config({}, { a: ['feishu:bot:alice'], b: ['feishu:bot:alice'] })).rejects.toThrow('duplicate');
    await symlink(join(directory, 'alice'), join(directory, 'alias'));
    await expect(config({ isolation: { enabled: true }, userOverrides: { alice: { workingDirectory: join(directory, 'alias', 'new') }, bob: { workingDirectory: join(directory, 'alice', 'new', 'nested') } } })).rejects.toThrow('overlap');
  });

  it('integration: migrates a personal group session, downloads into shared inbox, and excludes personal cwd roots', async () => {
    const store = await SessionStore.create(':memory:');
    const key = 'feishu:chat:bot:topic';
    const old = await store.getOrCreate(key, { agentName: 'codex', workingDirectory: join(directory, 'alice') });
    await store.updateAgentSessionId(old.id, 'old-agent');
    const reset = vi.fn();
    const session = await ensureExecutionSession({ bot, message: message('group', 'bob'), key, store, reset });
    expect(reset).toHaveBeenCalledWith(key);
    expect(session.agentSessionId).toBeUndefined();
    const msg = { ...message('group'), attachments: [{ type: 'file' as const, fileKey: 'f', messageId: 'm', fileName: 'fixture.txt' }] };
    await downloadInboundAttachments(msg, { downloadFile: async () => Buffer.from('fixture') }, join(session.workingDirectory, 'inbox'));
    expect(await readFile((msg.attachments[0] as { localPath?: string }).localPath!, 'utf8')).toBe('fixture');
    expect((msg.attachments[0] as { localPath?: string }).localPath).toContain(join(bot.workingDirectory, 'inbox'));
    const adapter = { send: vi.fn(async () => 'sent') } as unknown as PlatformAdapter;
    await handleBridgeCommand({ command: 'cwd', args: [join(directory, 'alice')] }, key, 'bot', 'chat', adapter, store,
      { forgetSession: vi.fn() } as never, {} as never, undefined, undefined, new Map(), { fastModeBySession: new Map() }, bot,
      { platform: 'feishu', userId: 'alice', chatType: 'group' });
    expect((await store.getByKey(key))?.workingDirectory).toBe(bot.workingDirectory);
    expect(adapter.send).toHaveBeenCalledWith('chat', expect.objectContaining({ text: expect.stringContaining('无效路径') }));
    store.close();
  });

  it('integration: exposes getMe numeric id without deriving identity from token', async () => {
    const adapter = new TelegramAdapter({ token: 'fixture', botName: 'test' });
    const internals = adapter as unknown as { botApi: () => Promise<unknown>; readOffset: () => number; schedulePoll: () => void };
    const api = vi.spyOn(internals, 'botApi').mockResolvedValue({ id: 123, username: 'MyBot' });
    vi.spyOn(internals, 'readOffset').mockReturnValue(0);
    vi.spyOn(internals, 'schedulePoll').mockImplementation(() => undefined);
    await adapter.connect();
    expect(adapter.appKey).toBe('123');
    expect(api).toHaveBeenCalledWith('getMe', {}, expect.anything());
    await adapter.disconnect();
  });
});
