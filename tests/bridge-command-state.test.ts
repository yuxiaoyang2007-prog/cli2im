import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexPlugin, parseCodexModelsCache } from '../src/agents/codex.js';
import { ClaudeCodePlugin, parseClaudeModelCatalog } from '../src/agents/claude-code.js';
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

  it('sends interactive /model and /effort picker cards when called without arguments', async () => {
    await run('model', []);
    expect(vi.mocked(adapter.send)).toHaveBeenLastCalledWith('chat', {
      card: expect.objectContaining({
        type: 'final',
        title: '切换模型',
        buttons: expect.arrayContaining([
          expect.objectContaining({ value: 'model:gpt-6-astra' }),
          expect.objectContaining({ value: 'model:default' }),
        ]),
      }),
    });

    await run('effort', []);
    expect(vi.mocked(adapter.send)).toHaveBeenLastCalledWith('chat', {
      card: expect.objectContaining({
        type: 'final',
        title: '切换推理强度 (Effort)',
        buttons: expect.arrayContaining([
          expect.objectContaining({ value: 'effort:low' }),
          expect.objectContaining({ value: 'effort:xhigh' }),
          expect.objectContaining({ value: 'effort:default' }),
        ]),
      }),
    });
  });

  it('persists /effort preference across reloads and guards running tasks', async () => {
    await run('effort', ['xhigh']);
    expect(manager.killAgent).toHaveBeenCalledWith(scope);
    store.close();
    store = await SessionStore.create(join(dir, 'state.db'));
    expect((await store.getPreferences(scope)).effort).toBe('xhigh');

    await store.updatePreferences(scope, { taskState: 'running' });
    vi.mocked(manager.killAgent).mockClear();
    await run('effort', ['low']);
    expect((await store.getPreferences(scope)).effort).toBe('xhigh');
    expect(manager.killAgent).not.toHaveBeenCalled();

    await store.updatePreferences(scope, { taskState: 'completed' });
    await run('effort', ['default']);
    expect((await store.getPreferences(scope)).effort).toBeUndefined();
  });

  it('includes hydrogen fallback presets and dynamic plugin listModels() results for agy /model', async () => {
    const agyBot: BotConfig = { ...bot, agent: 'agy' };
    await handleBridgeCommand(
      { command: 'model', args: [] },
      scope,
      'bot',
      'chat',
      adapter,
      store,
      manager as never,
      { releaseHandoff: vi.fn() } as never,
      undefined,
      undefined,
      new Map(),
      { fastModeBySession: new Map() },
      agyBot,
      { platform: 'telegram', chatType: 'private', userId: 'user' },
    );
    expect(vi.mocked(adapter.send)).toHaveBeenLastCalledWith('chat', {
      card: expect.objectContaining({
        title: '切换模型',
        buttons: expect.arrayContaining([
          expect.objectContaining({ value: 'model:gemini-4-hydrogen-xhigh' }),
          expect.objectContaining({ value: 'model:gemini-4-hydrogen-high' }),
          expect.objectContaining({ value: 'model:default' }),
        ]),
      }),
    });

    vi.mocked(manager.getPlugin).mockReturnValueOnce({
      capabilities: { sessionResume: true },
      listModels: vi.fn(async () => ['gemini-4-hydrogen-xhigh', 'gemini-5-preview']),
    } as never);
    await handleBridgeCommand(
      { command: 'model', args: [] },
      scope,
      'bot',
      'chat',
      adapter,
      store,
      manager as never,
      { releaseHandoff: vi.fn() } as never,
      undefined,
      undefined,
      new Map(),
      { fastModeBySession: new Map() },
      agyBot,
      { platform: 'telegram', chatType: 'private', userId: 'user' },
    );
    expect(vi.mocked(adapter.send)).toHaveBeenLastCalledWith('chat', {
      card: expect.objectContaining({
        title: '切换模型',
        buttons: expect.arrayContaining([
          expect.objectContaining({ value: 'model:gemini-4-hydrogen-xhigh' }),
          expect.objectContaining({ value: 'model:gemini-5-preview' }),
        ]),
      }),
    });
  });

  it('discovers codex models from models_cache.json excluding hidden/unsupported entries sorted by priority', async () => {
    const sample = JSON.stringify({
      models: [
        { slug: 'gpt-6-luna', visibility: 'list', supported_in_api: true, priority: 6 },
        { slug: 'gpt-reserve', visibility: 'hide', supported_in_api: true, priority: 5 },
        { slug: 'codex-auto-review', visibility: 'hide', supported_in_api: true, priority: 10 },
        { slug: 'gpt-legacy-off', visibility: 'list', supported_in_api: false, priority: 3 },
        { slug: 'gpt-6-astra', visibility: 'list', supported_in_api: true, priority: 2 },
        { slug: 'gpt-6.1-sol', visibility: 'list', supported_in_api: true, priority: 1 },
      ],
    });
    expect(parseCodexModelsCache(sample)).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna']);

    const codexHome = join(dir, 'codex-home');
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, 'models_cache.json'), sample, 'utf-8');
    const plugin = new CodexPlugin('codex', codexHome);
    expect(await plugin.listModels()).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna']);
  });

  it('discovers claude-code models from model-catalog json with main models before overflow', async () => {
    const sample = JSON.stringify({
      catalog: {
        config: {
          models: [
            { id: 'claude-opus-4-8', section: 'overflow' },
            { id: 'claude-opus-5-5', section: 'main' },
            { id: 'claude-fable-5-2', section: 'main' },
            { id: 'claude-sonnet-5-5', section: 'main' },
            { id: 'claude-opus-5-5', section: 'overflow' },
          ],
        },
      },
    });
    expect(parseClaudeModelCatalog(sample)).toEqual([
      'claude-opus-5-5',
      'claude-fable-5-2',
      'claude-sonnet-5-5',
      'claude-opus-4-8',
    ]);

    const catalogDir = join(dir, 'claude-catalog');
    await mkdir(catalogDir, { recursive: true });
    await writeFile(join(catalogDir, 'catalog.json'), sample, 'utf-8');
    const plugin = new ClaudeCodePlugin('claude');
    expect(await plugin.listModels(catalogDir)).toEqual([
      'claude-opus-5-5',
      'claude-fable-5-2',
      'claude-sonnet-5-5',
      'claude-opus-4-8',
    ]);
  });

  it('includes reasoning effort buttons (including ultra) inside /model for codex and supports /model <model> [effort]', async () => {
    await run('model', []);
    expect(vi.mocked(adapter.send)).toHaveBeenLastCalledWith('chat', {
      card: expect.objectContaining({
        title: '切换模型',
        buttons: expect.arrayContaining([
          expect.objectContaining({ value: 'model:gpt-6.1-sol' }),
          expect.objectContaining({ value: 'effort:low' }),
          expect.objectContaining({ value: 'effort:xhigh' }),
          expect.objectContaining({ value: 'effort:ultra' }),
          expect.objectContaining({ value: 'effort:default' }),
        ]),
        rawElements: expect.arrayContaining([
          expect.objectContaining({ tag: 'hr' }),
          expect.objectContaining({ tag: 'markdown', content: expect.stringContaining('推理级别 (Effort)') }),
        ]),
      }),
    });

    await run('model', ['gpt-6.1-sol', 'ultra']);
    const saved = await store.getPreferences(scope);
    expect(saved.model).toBe('gpt-6.1-sol');
    expect(saved.effort).toBe('ultra');
    expect(vi.mocked(adapter.send)).toHaveBeenLastCalledWith('chat', {
      text: expect.stringContaining('gpt-6.1-sol'),
    });

    await run('model', ['gpt-6-astra']);
    expect((await store.getPreferences(scope)).model).toBe('gpt-6-astra');
    expect(vi.mocked(adapter.send)).toHaveBeenLastCalledWith('chat', {
      card: expect.objectContaining({
        title: '模型已切换',
        buttons: expect.arrayContaining([
          expect.objectContaining({ value: 'effort:ultra' }),
          expect.objectContaining({ value: 'effort:default' }),
        ]),
      }),
    });
  });
});
