import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../src/session/store.js';
import { handleBridgeCommand, createHandoffSpawnResume, startAgentProcessForSession } from '../src/index.js';
import type { BotConfig, PlatformAdapter, SessionKey } from '../src/types.js';
import { parseTelegramUpdate } from '../src/platforms/telegram/adapter.js';
import { getGroupMessageSkipReason, InboundPipeline } from '../src/pipeline.js';
import { ChatQueue, MessageBatcher, QueueCancelledError } from '../src/session/queue.js';
import type { AppConfig, InboundMessage } from '../src/types.js';

const scope: SessionKey = 'telegram:chat:bot';

describe('persisted bridge choices and session boundaries', () => {
  let dir: string;
  let store: SessionStore;
  let bot: BotConfig;
  let latestManagerId: string | undefined;
  const adapter = { name: 'telegram', send: vi.fn().mockResolvedValue('message') } as unknown as PlatformAdapter;
  const manager = { killAgent: vi.fn(), cancelAgent: vi.fn(), getPlugin: vi.fn(() => ({ capabilities: { sessionResume: true } })),
    resumeAgent: vi.fn().mockResolvedValue({ pid: 123 }),
    getLatestSessionId: vi.fn(() => latestManagerId), forgetSession: vi.fn(() => { latestManagerId = undefined; }) };
  beforeEach(async () => {
    vi.clearAllMocks();
    latestManagerId = undefined;
    dir = await realpath(await mkdtemp(join(tmpdir(), 'cli2im-command-state-')));
    store = await SessionStore.create(join(dir, 'state.db'));
    bot = { agent: 'codex', platform: 'telegram', workingDirectory: dir,
      allowFrom: ['user'], permissionMode: 'blacklist', larkCliConfigDir: join(dir, 'lark-bot'), sandboxMode: 'workspace-write' };
  });
  afterEach(async () => { store.close(); await rm(dir, { force: true, recursive: true }); });

  async function run(command: string, args: string[]) {
    await handleBridgeCommand({ command, args }, scope, 'bot', 'chat', adapter, store, manager as never, { releaseHandoff: vi.fn(async () => ({ sessionId: 'id', resumeCommand: 'codex resume id' })) } as never,
      undefined, undefined, new Map(), { fastModeBySession: new Map() }, bot,
      { platform: 'telegram', chatType: 'private', userId: 'user' });
  }

  it.each(['stop', 'kill', 'status', 'custom'])('ADDRESSED-COMMAND routes /%s@MyBot through admission, batching and command dispatch', async (command) => {
    bot.requireMention = true;
    const pipeline = new InboundPipeline({ bots: { bot } } as unknown as AppConfig);
    const queue = new ChatQueue();
    const batcher = new MessageBatcher(queue, { delayMs: 5000 });
    const ordinary = vi.fn();
    const dispatch = async (msg: InboundMessage) => {
      const ctx = pipeline.process(msg, 'bot');
      if ('rejected' in ctx) throw new Error(ctx.reason);
      if (ctx.bridgeCommand) await run(ctx.bridgeCommand.command, ctx.bridgeCommand.args);
      else ordinary(msg.text);
    };
    const text = `/${command}@MyBot`;
    const msg = parseTelegramUpdate({ message: { message_id: 1, chat: { id: 'chat', type: 'supergroup' },
      from: { id: 'user' }, text, entities: [{ type: 'bot_command', offset: 0, length: text.length }] } }, 'mybot')!;
    expect(getGroupMessageSkipReason(msg, bot, '@mybot')).toBeUndefined();
    expect(msg.text).toBe(`/${command}`);
    let release!: () => void;
    const active = command === 'stop' || command === 'kill'
      ? queue.enqueue(scope, () => new Promise<void>(resolve => { release = resolve; })) : undefined;
    await Promise.resolve();
    const buffered = batcher.enqueue(scope, { ...msg, text: 'buffered' }, dispatch).catch(error => error);
    await store.updatePreferences(scope, { taskState: 'running' });
    try {
      await batcher.enqueue(scope, msg, dispatch);
      expect(batcher.pending(scope)).toBe(0);
      if (command === 'stop' || command === 'kill') {
        expect(await buffered).toBeInstanceOf(QueueCancelledError);
        expect(command === 'stop' ? manager.cancelAgent : manager.killAgent).toHaveBeenCalledWith(scope);
        expect((await store.getPreferences(scope)).taskState).toBe('interrupted');
        expect(ordinary).not.toHaveBeenCalled();
      } else {
        await buffered;
        expect(ordinary.mock.calls.map(([text]) => text)).toEqual(command === 'custom' ? ['buffered', '/custom'] : ['buffered']);
        if (command === 'status') expect(adapter.send).toHaveBeenCalled();
      }
    } finally {
      release?.();
      await active;
      await queue.drain(scope);
    }
  });

  it.each(['OtherBot', undefined])('ADDRESSED-COMMAND rejects a foreign or unknown bot identity: %s', (identity) => {
    const text = '/stop@MyBot';
    const update = { message: { chat: { id: 'chat', type: 'supergroup' }, from: { id: 'user' },
      text, entities: [{ type: 'bot_command', offset: 0, length: text.length }] } };
    expect(parseTelegramUpdate(update, identity)).toBeNull();
    expect(manager.cancelAgent).not.toHaveBeenCalled();
  });

  it.each(['stop', 'kill', 'handoff'])('F06 idle %s preserves completed task state', async (command) => {
    await store.updatePreferences(scope, { taskState: 'completed' });
    await run(command, []);
    expect((await store.getPreferences(scope)).taskState).toBe('completed');
  });

  it('F06 project switch clears interruption state for the new conversation', async () => {
    await store.updatePreferences(scope, { taskState: 'interrupted' });
    await run('cwd', [dir]);
    expect((await store.getPreferences(scope)).taskState).toBeUndefined();
  });

  it('saves the selected model durably and uses it with the correct bot account on next resume', async () => {
    const session = await store.getOrCreate(scope, { agentName: 'codex', workingDirectory: dir });
    await store.updateAgentSessionId(session.id, 'old-session');
    latestManagerId = 'old-session';
    await run('model', ['chosen-model']);
    expect(manager.killAgent).toHaveBeenCalledWith(scope);
    expect(manager.forgetSession).not.toHaveBeenCalled();
    store.close();
    store = await SessionStore.create(join(dir, 'state.db'));
    expect((await store.getPreferences(scope)).model).toBe('chosen-model');
    const resume = createHandoffSpawnResume(manager, store,
      () => ({ onEvent: vi.fn(), onToolBlocked: vi.fn(), onPermissionTimeout: vi.fn(), onProcessExit: vi.fn() }),
      () => bot, undefined, () => ({ CTI_SENDER_CHANNEL: 'telegram', CTI_SENDER_USER_ID: 'user' }));
    await resume(scope, 'codex', 'old-session', dir);
    expect(manager.resumeAgent).toHaveBeenCalledWith(scope, 'codex', 'old-session', expect.objectContaining({
      model: 'chosen-model', sandboxMode: 'workspace-write', env: {
        LARKSUITE_CLI_CONFIG_DIR: join(dir, 'lark-bot'), CTI_SENDER_CHANNEL: 'telegram', CTI_SENDER_USER_ID: 'user',
      },
    }), expect.anything());
  });

  it('does not change the model or terminate work while a task is running', async () => {
    await store.updatePreferences(scope, { model: 'current-model', taskState: 'running' });
    await run('model', ['other-model']);
    expect((await store.getPreferences(scope)).model).toBe('current-model');
    expect(manager.killAgent).not.toHaveBeenCalled();
  });

  it('keeps historical ownership and model preference after starting a new conversation', async () => {
    const session = await store.getOrCreate(scope, { agentName: 'codex', workingDirectory: dir });
    await store.updateAgentSessionId(session.id, 'my-history');
    latestManagerId = 'my-history';
    await store.updatePreferences(scope, { model: 'chosen-model' });
    await run('new', []);
    expect(manager.forgetSession).toHaveBeenCalledWith(scope);
    expect(await store.getByKey(scope)).toBeNull();
    expect(await store.listSessionAccess(scope)).toEqual([expect.objectContaining({ agentSessionId: 'my-history', key: scope })]);
    expect((await store.getPreferences(scope)).model).toBe('chosen-model');
    expect(await store.listSessionAccess('telegram:other:bot')).toEqual([]);
  });

  it('clears the old CLI session when switching projects while preserving its historical binding', async () => {
    const next = join(dir, 'next-project');
    await mkdir(next);
    bot.projects = { next };
    const session = await store.getOrCreate(scope, { agentName: 'codex', workingDirectory: dir });
    await store.updateAgentSessionId(session.id, 'old-project-history');
    latestManagerId = 'old-project-history';
    await run('cwd', ['next']);
    expect((await store.getByKey(scope))?.workingDirectory).toBe(next);
    expect((await store.getByKey(scope))?.agentSessionId).toBeUndefined();
    expect(await store.listSessionAccess(scope)).toEqual([expect.objectContaining({
      agentSessionId: 'old-project-history', workingDirectory: dir,
    })]);
    const nextSession = (await store.getByKey(scope))!;
    expect(manager.forgetSession).toHaveBeenCalledWith(scope);
    const nextManager = { ...manager, spawnAgent: vi.fn() };
    await startAgentProcessForSession({ agentManager: nextManager as never, store, session: nextSession,
      sessionKey: scope, agentName: 'codex', spawnOpts: { workingDirectory: next, permissionMode: 'blacklist' },
      handlers: { onEvent: vi.fn(), onToolBlocked: vi.fn(), onPermissionTimeout: vi.fn(), onProcessExit: vi.fn() } });
    expect(nextManager.resumeAgent).not.toHaveBeenCalled();
    expect(nextManager.spawnAgent).toHaveBeenCalledWith(scope, 'codex', expect.objectContaining({ workingDirectory: next }), expect.anything());
  });

  it('does not grant one user another user override directory', async () => {
    const mine = join(dir, 'mine');
    const other = join(dir, 'other');
    await mkdir(mine); await mkdir(other);
    bot.userOverrides = { user: { workingDirectory: mine }, someone_else: { workingDirectory: other } };
    const session = await store.getOrCreate(scope, { agentName: 'codex', workingDirectory: mine });
    await store.updateAgentSessionId(session.id, 'my-history');
    await run('cwd', [other]);
    expect((await store.getByKey(scope))?.workingDirectory).toBe(mine);
    expect((await store.getByKey(scope))?.agentSessionId).toBe('my-history');
    expect(manager.killAgent).not.toHaveBeenCalled();
    expect(vi.mocked(adapter.send)).toHaveBeenCalledWith('chat', { text: expect.stringContaining('无效路径') });
  });
});
