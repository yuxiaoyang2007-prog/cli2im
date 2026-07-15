import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleBridgeCommand, type BridgeCommandSender } from '../src/index.js';
import { SessionStore } from '../src/session/store.js';
import type { CodexNotificationService } from '../src/notifications/service.js';
import type { AgentManager } from '../src/agents/manager.js';
import type { HandoffService } from '../src/services/handoff.js';
import type { BotConfig, PlatformAdapter, SessionKey } from '../src/types.js';

describe('/notify-me', () => {
  let store: SessionStore;

  const adapter = {
    name: 'feishu',
    send: vi.fn().mockResolvedValue('message_1'),
  } as unknown as PlatformAdapter;
  const agentManager = {} as AgentManager;
  const handoffService = {} as HandoffService;
  const botConfig: BotConfig = {
    agent: 'codex',
    platform: 'feishu',
    feishu: { appId: 'app', appSecret: 'secret' },
    workingDirectory: '/tmp/project',
    allowFrom: ['ou_allowed'],
    permissionMode: 'blacklist',
  };
  const service = {
    botName: 'codexbot',
    bindTarget: vi.fn().mockResolvedValue(undefined),
  } as unknown as CodexNotificationService;

  beforeEach(async () => {
    store = await SessionStore.create(':memory:');
    vi.mocked(adapter.send).mockClear();
    vi.mocked(service.bindTarget).mockClear();
  });

  afterEach(() => {
    store.close();
  });

  async function runNotifyMe(
    sender: BridgeCommandSender,
    selectedBotName = 'codexbot',
  ): Promise<void> {
    await handleBridgeCommand(
      { command: 'notify-me', args: [] },
      'feishu:oc_private:codexbot' as SessionKey,
      selectedBotName,
      'oc_private',
      adapter,
      store,
      agentManager,
      handoffService,
      undefined,
      undefined,
      new Map(),
      { fastModeBySession: new Map() },
      botConfig,
      sender,
      service,
    );
  }

  it('binds one allowlisted Feishu private chat', async () => {
    await runNotifyMe({ platform: 'feishu', chatType: 'p2p', userId: 'ou_allowed' });

    expect(service.bindTarget).toHaveBeenCalledWith({
      botName: 'codexbot',
      platform: 'feishu',
      chatId: 'oc_private',
      userId: 'ou_allowed',
    });
    expect(adapter.send).toHaveBeenCalledWith('oc_private', {
      text: 'Codex 通知已绑定到当前私聊。后续只发送项目、任务和状态。',
    });
  });

  it.each([
    ['a group chat', { platform: 'feishu', chatType: 'group', userId: 'ou_allowed' }, 'codexbot'],
    ['the wrong bot', { platform: 'feishu', chatType: 'p2p', userId: 'ou_allowed' }, 'otherbot'],
    ['Telegram', { platform: 'telegram', chatType: 'p2p', userId: 'ou_allowed' }, 'codexbot'],
    ['a user outside allowFrom', { platform: 'feishu', chatType: 'p2p', userId: 'ou_denied' }, 'codexbot'],
  ] as const)('rejects %s', async (_label, sender, selectedBotName) => {
    await runNotifyMe(sender, selectedBotName);

    expect(service.bindTarget).not.toHaveBeenCalled();
    expect(adapter.send).toHaveBeenCalledWith('oc_private', {
      text: '通知绑定失败：请使用获授权的 codexbot 飞书私聊。',
    });
  });
});
