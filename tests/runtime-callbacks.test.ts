import { describe, expect, it, vi } from 'vitest';
import {
  createCallbackHandler,
  sendAgentMessageOrNotify,
} from '../src/index.js';
import {
  handlePermissionCallback,
  isCallbackAuthorized,
  parseSessionResumeCallback,
  parsePermissionCallbackData,
} from '../src/runtime/callbacks.js';
import type { BotConfig, CallbackQuery } from '../src/types.js';

describe('parsePermissionCallbackData', () => {
  it('parses Feishu JSON action envelopes', () => {
    expect(parsePermissionCallbackData('{"action":"perm:allow:req_1"}')).toEqual({
      decision: 'allow',
      requestId: 'req_1',
    });
  });

  it('parses raw Telegram callback payloads', () => {
    expect(parsePermissionCallbackData('perm:allow_session:req_2')).toEqual({
      decision: 'allow_session',
      requestId: 'req_2',
    });
  });

  it('returns null for non-permission callback payloads', () => {
    expect(parsePermissionCallbackData('noop')).toBeNull();
    expect(parsePermissionCallbackData('{"action":"noop"}')).toBeNull();
    expect(parsePermissionCallbackData('perm:maybe:req_3')).toBeNull();
  });
});

describe('createCallbackHandler', () => {
  it('serializes session resume callbacks through the chat queue', async () => {
    const queue = {
      enqueue: vi.fn(() => Promise.resolve()),
    };
    const handleSessionResume = vi.fn(() => Promise.resolve());
    const adapter = adapterStub();
    const deps = callbackDeps({ queue, adapter, handleSessionResume });
    const handler = createCallbackHandler(deps);
    const callback: CallbackQuery = {
      platform: 'feishu',
      chatId: 'chat_1',
      userId: 'ou_allowed',
      chatType: 'p2p',
      data: JSON.stringify({
        action: 'resume_cli',
        sessionId: 'session_1',
        cwd: '/Users/test/project',
      }),
      messageId: 'msg_1',
    };

    handler(callback);

    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledWith('chat_1', expect.any(Function));
    expect(handleSessionResume).not.toHaveBeenCalled();

    const task = (queue.enqueue as any).mock.calls[0][1] as () => Promise<void>;
    await task();

    expect(handleSessionResume).toHaveBeenCalledWith(expect.objectContaining({
      callback,
      resume: {
        action: 'resume_cli',
        sessionId: 'session_1',
        cwd: '/Users/test/project',
      },
      botName: 'ccbot',
      botConfig: deps.botConfig,
      adapter,
    }));
  });

  it('handles permission callbacks directly without queueing', () => {
    const queue = {
      enqueue: vi.fn(() => Promise.resolve()),
    };
    const handleSessionResume = vi.fn(() => Promise.resolve());
    const agentManager = {
      approvePermission: vi.fn(),
      denyPermission: vi.fn().mockReturnValue(true),
    };
    const handler = createCallbackHandler(callbackDeps({
      queue,
      agentManager,
      handleSessionResume,
    }));

    handler({
      platform: 'feishu',
      chatId: 'chat_1',
      userId: 'ou_allowed',
      chatType: 'p2p',
      data: 'perm:deny:req_1',
      messageId: 'msg_1',
    });

    expect(agentManager.denyPermission).toHaveBeenCalledWith('feishu:chat_1:ccbot', 'req_1');
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(handleSessionResume).not.toHaveBeenCalled();
  });
});

describe('sendAgentMessageOrNotify', () => {
  it('does not notify when the agent message is delivered', async () => {
    const adapter = adapterStub();
    const agentManager = {
      sendMessage: vi.fn().mockReturnValue(true),
    };

    await sendAgentMessageOrNotify({
      agentManager,
      adapter,
      chatId: 'chat_1',
      sessionKey: 'feishu:chat_1:ccbot',
      agentName: 'claude-code',
      message: { role: 'user', content: 'hello' },
    });

    expect(agentManager.sendMessage).toHaveBeenCalledWith(
      'feishu:chat_1:ccbot',
      'claude-code',
      { role: 'user', content: 'hello' },
    );
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('warns and asks the user to resend when delivery fails', async () => {
    const adapter = adapterStub();
    const agentManager = {
      sendMessage: vi.fn().mockReturnValue(false),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await sendAgentMessageOrNotify({
        agentManager,
        adapter,
        chatId: 'chat_1',
        sessionKey: 'feishu:chat_1:ccbot',
        agentName: 'claude-code',
        message: { role: 'user', content: 'hello' },
      });

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('message not delivered'));
      expect(adapter.send).toHaveBeenCalledWith('chat_1', {
        text: '消息未送达（会话正在切换或重启），请重发',
      });
    } finally {
      warn.mockRestore();
    }
  });
});

describe('handlePermissionCallback', () => {
  function callback(data: string): CallbackQuery {
    return {
      platform: 'telegram',
      chatId: 'chat_1',
      userId: 'ou_allowed',
      data,
      messageId: 'msg_1',
    };
  }

  it('routes deny decisions to denyPermission', () => {
    const agentManager = {
      approvePermission: vi.fn(),
      denyPermission: vi.fn().mockReturnValue(true),
    };

    expect(handlePermissionCallback(callback('perm:deny:req_4'), agentManager, botConfig(), 'ccbot')).toBe(true);
    expect(agentManager.denyPermission).toHaveBeenCalledWith('telegram:chat_1:ccbot', 'req_4');
    expect(agentManager.approvePermission).not.toHaveBeenCalled();
  });

  it('routes allow decisions to approvePermission', () => {
    const agentManager = {
      approvePermission: vi.fn().mockReturnValue(true),
      denyPermission: vi.fn(),
    };

    expect(handlePermissionCallback(callback('perm:allow_session:req_5'), agentManager, botConfig(), 'ccbot')).toBe(true);
    expect(agentManager.approvePermission).toHaveBeenCalledWith('telegram:chat_1:ccbot', 'req_5');
    expect(agentManager.denyPermission).not.toHaveBeenCalled();
  });

  it('rejects permission callbacks from unauthorized direct-message users', () => {
    const agentManager = {
      approvePermission: vi.fn(),
      denyPermission: vi.fn(),
    };

    expect(handlePermissionCallback(
      { ...callback('perm:allow:req_6'), userId: 'ou_intruder' },
      agentManager,
      botConfig(),
      'ccbot',
    )).toBe(false);
    expect(agentManager.approvePermission).not.toHaveBeenCalled();
    expect(agentManager.denyPermission).not.toHaveBeenCalled();
  });

  it('rejects permission callbacks from unauthorized group users', () => {
    const agentManager = {
      approvePermission: vi.fn(),
      denyPermission: vi.fn(),
    };
    const groupCallback = {
      ...callback('perm:deny:req_7'),
      chatType: 'group',
      userId: 'ou_intruder',
    };

    expect(handlePermissionCallback(groupCallback, agentManager, botConfig(), 'ccbot')).toBe(false);
    expect(agentManager.approvePermission).not.toHaveBeenCalled();
    expect(agentManager.denyPermission).not.toHaveBeenCalled();
  });
});

describe('parseSessionResumeCallback', () => {
  it('parses Feishu JSON resume button values', () => {
    expect(parseSessionResumeCallback(JSON.stringify({
      action: 'resume_cli',
      sessionId: '9f53e234-c06b-44e6-b71e-3e1a4b618123',
      cwd: '/Users/testuser/projects/cli2im:with-colon',
    }))).toEqual({
      action: 'resume_cli',
      sessionId: '9f53e234-c06b-44e6-b71e-3e1a4b618123',
      cwd: '/Users/testuser/projects/cli2im:with-colon',
    });
  });

  it('rejects malformed resume callback payloads', () => {
    expect(parseSessionResumeCallback('resume_cli:abc:/tmp')).toBeNull();
    expect(parseSessionResumeCallback(JSON.stringify({ action: 'other', sessionId: 'abc', cwd: '/tmp' }))).toBeNull();
    expect(parseSessionResumeCallback(JSON.stringify({ action: 'resume_cli' }))).toBeNull();
    expect(parseSessionResumeCallback(JSON.stringify({ action: 'resume_cli', sessionId: 'abc' }))).toEqual({
      action: 'resume_cli', sessionId: 'abc', cwd: '',
    });
  });

  it('parses compact Telegram resume format "resume:<sessionId>"', () => {
    expect(parseSessionResumeCallback('resume:9f53e234-c06b-44e6-b71e-3e1a4b618123')).toEqual({
      action: 'resume_cli',
      sessionId: '9f53e234-c06b-44e6-b71e-3e1a4b618123',
      cwd: '',
    });
  });

  it('parses compact resume wrapped in Feishu JSON action envelope', () => {
    expect(parseSessionResumeCallback('{"action":"resume:abc-123"}')).toEqual({
      action: 'resume_cli',
      sessionId: 'abc-123',
      cwd: '',
    });
  });

  it('rejects bare "resume:" with no sessionId', () => {
    expect(parseSessionResumeCallback('resume:')).toBeNull();
  });

  it('rejects session resume callbacks from unauthorized direct-message users', () => {
    const callback: CallbackQuery = {
      platform: 'feishu',
      chatId: 'chat_1',
      userId: 'ou_intruder',
      chatType: 'p2p',
      data: 'resume:session_1',
      messageId: 'msg_1',
    };

    expect(parseSessionResumeCallback(callback.data)).not.toBeNull();
    expect(isCallbackAuthorized(callback, botConfig())).toBe(false);
  });

  it('rejects session resume callbacks from unauthorized group users', () => {
    const callback: CallbackQuery = {
      platform: 'feishu',
      chatId: 'oc_group',
      userId: 'ou_intruder',
      chatType: 'group',
      data: 'resume:session_1',
      messageId: 'msg_1',
    };

    expect(parseSessionResumeCallback(callback.data)).not.toBeNull();
    expect(isCallbackAuthorized(callback, botConfig())).toBe(false);
  });
});

describe('isCallbackAuthorized', () => {
  it('accepts direct-message callbacks from allowed users', () => {
    const callback: CallbackQuery = {
      platform: 'feishu',
      chatId: 'ou_allowed',
      userId: 'ou_allowed',
      chatType: 'p2p',
      data: 'resume:session_1',
      messageId: 'msg_1',
    };

    expect(isCallbackAuthorized(callback, botConfig())).toBe(true);
  });

  it('rejects direct-message callbacks from strangers', () => {
    const callback: CallbackQuery = {
      platform: 'feishu',
      chatId: 'ou_intruder',
      userId: 'ou_intruder',
      chatType: 'p2p',
      data: 'resume:session_1',
      messageId: 'msg_1',
    };

    expect(isCallbackAuthorized(callback, botConfig())).toBe(false);
  });

  it('accepts group callbacks from allowed users', () => {
    const callback: CallbackQuery = {
      platform: 'feishu',
      chatId: 'oc_any_group',
      userId: 'ou_allowed',
      chatType: 'group',
      data: 'resume:session_1',
      messageId: 'msg_1',
    };

    expect(isCallbackAuthorized(callback, botConfig())).toBe(true);
  });

  it('rejects group callbacks from strangers', () => {
    const callback: CallbackQuery = {
      platform: 'feishu',
      chatId: 'oc_group_allowed',
      userId: 'ou_intruder',
      chatType: 'group',
      data: 'resume:session_1',
      messageId: 'msg_1',
    };

    expect(isCallbackAuthorized(callback, botConfig({ groupPolicy: 'allowlist' }))).toBe(false);
  });

  it('rejects group callbacks from non-allowlisted chats when groupPolicy is allowlist', () => {
    const callback: CallbackQuery = {
      platform: 'feishu',
      chatId: 'oc_other_group',
      userId: 'ou_allowed',
      chatType: 'group',
      data: 'resume:session_1',
      messageId: 'msg_1',
    };

    expect(isCallbackAuthorized(callback, botConfig({ groupPolicy: 'allowlist' }))).toBe(false);
  });

  it('rejects callbacks with empty userId even when allowFrom contains wildcard', () => {
    const callback: CallbackQuery = {
      platform: 'feishu',
      chatId: 'oc_any_group',
      userId: '',
      chatType: 'group',
      data: 'resume:session_1',
      messageId: 'msg_1',
    };

    expect(isCallbackAuthorized(callback, botConfig({ allowFrom: ['*'] }))).toBe(false);
  });
});

function botConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    agent: 'claude-code',
    platform: 'feishu',
    feishu: { appId: 'cli_abc', appSecret: 'secret' },
    workingDirectory: '/Users/test/project',
    allowFrom: ['ou_allowed'],
    groupAllowFrom: ['oc_group_allowed'],
    permissionMode: 'blacklist',
    ...overrides,
  };
}

function callbackDeps(overrides: Record<string, unknown> = {}) {
  return {
    botName: 'ccbot',
    botConfig: botConfig(),
    adapter: adapterStub(),
    store: {},
    agentManager: {
      approvePermission: vi.fn(),
      denyPermission: vi.fn().mockReturnValue(true),
    },
    handoffService: {},
    queue: {
      enqueue: vi.fn(() => Promise.resolve()),
    },
    cardController: undefined,
    tgStreamController: undefined,
    handleSessionResume: vi.fn(() => Promise.resolve()),
    ...overrides,
  } as any;
}

function adapterStub() {
  return {
    name: 'feishu',
    send: vi.fn(() => Promise.resolve('msg_1')),
  } as any;
}
