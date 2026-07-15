import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleBridgeCommand,
  logInboundMessageSummary,
  type BridgeCommandSender,
} from '../src/index.js';
import { SessionStore } from '../src/session/store.js';
import type { CodexNotificationService } from '../src/notifications/service.js';
import type { AgentManager } from '../src/agents/manager.js';
import type { HandoffService } from '../src/services/handoff.js';
import type {
  BotConfig,
  InboundMessage,
  PlatformAdapter,
  SessionKey,
} from '../src/types.js';

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
    botConfig.allowFrom = ['ou_allowed'];
    vi.mocked(adapter.send).mockClear();
    vi.mocked(service.bindTarget).mockClear();
  });

  afterEach(() => {
    store.close();
  });

  async function runNotifyMe(
    sender: BridgeCommandSender,
    selectedBotName = 'codexbot',
    chatId = 'oc_private',
  ): Promise<void> {
    await handleBridgeCommand(
      { command: 'notify-me', args: [] },
      `feishu:${chatId}:codexbot` as SessionKey,
      selectedBotName,
      chatId,
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

  it('logs a /notify-me inbound message without user, text, mention, or recipient identifiers', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const userSecret = 'ou_unique_private_user_82e1';
    const textSecret = 'unique_private_prompt_613a';
    const mentionSecret = 'ou_unique_private_mention_29bc';
    const recipientSecret = 'oc_unique_private_chat_94d2';
    const message: InboundMessage = {
      platform: 'feishu',
      chatId: recipientSecret,
      userId: userSecret,
      text: `/notify-me ${textSecret}`,
      chatType: 'p2p',
      mentions: [mentionSecret],
    };
    botConfig.allowFrom = [userSecret];

    try {
      logInboundMessageSummary('codexbot', message, 0, true);
      await runNotifyMe({ platform: 'feishu', chatType: 'p2p', userId: userSecret }, 'codexbot', recipientSecret);

      const output = JSON.stringify(log.mock.calls);
      expect(output).toContain(
        `[pipeline] codexbot: inbound chat=p2p relay=false command=notify-me textLength=${message.text.length} mentionCount=1 attachmentCount=0 relayBotCount=0 botIdentity=present`,
      );
      for (const secret of [userSecret, textSecret, mentionSecret, recipientSecret]) {
        expect(output).not.toContain(secret);
      }
      expect(service.bindTarget).toHaveBeenCalledWith({
        botName: 'codexbot', platform: 'feishu', chatId: recipientSecret, userId: userSecret,
      });
    } finally {
      log.mockRestore();
    }
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

  it('propagates a binding-confirmation delivery failure instead of reporting success', async () => {
    vi.mocked(adapter.send).mockRejectedValueOnce(new Error('safe transport failure'));

    await expect(runNotifyMe({
      platform: 'feishu',
      chatType: 'p2p',
      userId: 'ou_allowed',
    })).rejects.toThrow('safe transport failure');

    expect(service.bindTarget).toHaveBeenCalledTimes(1);
    expect(adapter.send).toHaveBeenCalledTimes(1);
  });
});
