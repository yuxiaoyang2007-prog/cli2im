import { describe, it, expect } from 'vitest';
import { buildSenderHeader, buildSenderEnv } from '../src/pipeline.js';

describe('Sender Injection', () => {
  it('builds cti-sender XML header', () => {
    const header = buildSenderHeader({ channel: 'feishu', userId: 'ou_abc123', userName: '于晓阳' });
    expect(header).toBe('<cti-sender channel="feishu" user_id="ou_abc123" name="于晓阳"/>\n\n');
  });

  it('omits missing fields', () => {
    const header = buildSenderHeader({ channel: 'telegram' });
    expect(header).toBe('<cti-sender channel="telegram"/>\n\n');
  });

  it('escapes XML special chars in name', () => {
    const header = buildSenderHeader({ channel: 'feishu', userName: 'A & B <test>' });
    expect(header).toContain('name="A &amp; B &lt;test&gt;"');
  });

  it('builds sender env vars', () => {
    const env = buildSenderEnv({ channel: 'feishu', userId: 'ou_abc', userName: 'Test' });
    expect(env).toEqual({ CTI_SENDER_CHANNEL: 'feishu', CTI_SENDER_USER_ID: 'ou_abc', CTI_SENDER_NAME: 'Test' });
  });

  it('skips undefined sender fields in env', () => {
    const env = buildSenderEnv({ channel: 'feishu' });
    expect(env).toEqual({ CTI_SENDER_CHANNEL: 'feishu' });
    expect(env).not.toHaveProperty('CTI_SENDER_USER_ID');
  });

  it('includes chat_id and chat_type in header when present', () => {
    const header = buildSenderHeader({ channel: 'feishu', userId: 'ou_abc', chatId: 'oc_xyz', chatType: 'group' });
    expect(header).toContain('chat_id="oc_xyz"');
    expect(header).toContain('chat_type="group"');
  });

  it('includes chat fields in env when present', () => {
    const env = buildSenderEnv({ channel: 'feishu', userId: 'ou_abc', chatId: 'oc_xyz', chatType: 'p2p' });
    expect(env).toMatchObject({ CTI_SENDER_CHAT_ID: 'oc_xyz', CTI_SENDER_CHAT_TYPE: 'p2p' });
  });

  it('omits chat fields in env when absent', () => {
    const env = buildSenderEnv({ channel: 'feishu', userId: 'ou_abc' });
    expect(env).not.toHaveProperty('CTI_SENDER_CHAT_ID');
    expect(env).not.toHaveProperty('CTI_SENDER_CHAT_TYPE');
  });
});
