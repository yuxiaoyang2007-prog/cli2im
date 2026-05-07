import { describe, expect, it, vi } from 'vitest';
import {
  handlePermissionCallback,
  parsePermissionCallbackData,
} from '../src/runtime/callbacks.js';
import type { CallbackQuery } from '../src/types.js';

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

describe('handlePermissionCallback', () => {
  function callback(data: string): CallbackQuery {
    return {
      platform: 'telegram',
      chatId: 'chat_1',
      userId: 'user_1',
      data,
      messageId: 'msg_1',
    };
  }

  it('routes deny decisions to denyPermission', () => {
    const agentManager = {
      approvePermission: vi.fn(),
      denyPermission: vi.fn().mockReturnValue(true),
    };

    expect(handlePermissionCallback(callback('perm:deny:req_4'), agentManager)).toBe(true);
    expect(agentManager.denyPermission).toHaveBeenCalledWith('req_4');
    expect(agentManager.approvePermission).not.toHaveBeenCalled();
  });

  it('routes allow decisions to approvePermission', () => {
    const agentManager = {
      approvePermission: vi.fn().mockReturnValue(true),
      denyPermission: vi.fn(),
    };

    expect(handlePermissionCallback(callback('perm:allow_session:req_5'), agentManager)).toBe(true);
    expect(agentManager.approvePermission).toHaveBeenCalledWith('req_5');
    expect(agentManager.denyPermission).not.toHaveBeenCalled();
  });
});
