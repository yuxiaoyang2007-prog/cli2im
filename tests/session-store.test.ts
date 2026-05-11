import { describe, it, expect, beforeEach } from 'vitest';
import { SessionStore } from '../src/session/store.js';
import type { SessionKey } from '../src/types.js';

describe('SessionStore', () => {
  let store: SessionStore;

  beforeEach(async () => {
    store = await SessionStore.create(':memory:');
  });

  it('creates a session', async () => {
    const key: SessionKey = 'feishu:oc_abc:ccbot';
    const session = await store.create({
      key,
      agentName: 'claude-code',
      workingDirectory: '~/projects',
    });
    expect(session.id).toBeDefined();
    expect(session.key).toBe(key);
    expect(session.agentName).toBe('claude-code');
    expect(session.state).toBe('active');
  });

  it('retrieves session by key', async () => {
    const key: SessionKey = 'feishu:oc_abc:ccbot';
    await store.create({ key, agentName: 'claude-code', workingDirectory: '~/projects' });
    const found = await store.getByKey(key);
    expect(found).not.toBeNull();
    expect(found!.key).toBe(key);
  });

  it('returns null for missing key', async () => {
    const found = await store.getByKey('feishu:oc_missing:bot');
    expect(found).toBeNull();
  });

  it('updates lastActiveAt on touch', async () => {
    const key: SessionKey = 'feishu:oc_abc:ccbot';
    const session = await store.create({ key, agentName: 'claude-code', workingDirectory: '~' });
    const before = session.lastActiveAt;

    await new Promise((r) => setTimeout(r, 50));
    await store.touch(session.id);

    const updated = await store.getByKey(key);
    expect(updated!.lastActiveAt).toBeGreaterThan(before);
  });

  it('updates agentSessionId', async () => {
    const key: SessionKey = 'feishu:oc_abc:ccbot';
    const session = await store.create({ key, agentName: 'claude-code', workingDirectory: '~' });
    await store.updateAgentSessionId(session.id, 'ses_abc123');

    const updated = await store.getByKey(key);
    expect(updated!.agentSessionId).toBe('ses_abc123');
  });

  it('finds idle sessions', async () => {
    const key: SessionKey = 'feishu:oc_abc:ccbot';
    await store.create({ key, agentName: 'claude-code', workingDirectory: '~' });

    // With maxIdleMs=0, everything is "idle"
    const idle = await store.findIdle(0);
    expect(idle.length).toBe(1);

    // With huge maxIdleMs, nothing is idle
    const notIdle = await store.findIdle(999999999);
    expect(notIdle.length).toBe(0);
  });

  it('updates state', async () => {
    const key: SessionKey = 'feishu:oc_abc:ccbot';
    const session = await store.create({ key, agentName: 'claude-code', workingDirectory: '~' });
    await store.updateState(session.id, 'handed_off');

    const updated = await store.getByKey(key);
    expect(updated!.state).toBe('handed_off');
  });

  it('deletes session', async () => {
    const key: SessionKey = 'feishu:oc_abc:ccbot';
    const session = await store.create({ key, agentName: 'claude-code', workingDirectory: '~' });
    await store.delete(session.id);

    const found = await store.getByKey(key);
    expect(found).toBeNull();
  });

  it('lists sessions by botName', async () => {
    await store.create({ key: 'feishu:oc_1:ccbot', agentName: 'claude-code', workingDirectory: '~' });
    await store.create({ key: 'feishu:oc_2:ccbot', agentName: 'claude-code', workingDirectory: '~' });
    await store.create({ key: 'feishu:oc_3:other', agentName: 'codex', workingDirectory: '~' });

    const ccbotSessions = await store.listByBot('ccbot');
    expect(ccbotSessions.length).toBe(2);
  });
});
