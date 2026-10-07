import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canAccessSession, getBotAccessRejection } from '../src/security/access-policy.js';
import { buildSessionKey, type BotConfig } from '../src/types.js';

const actor = { userId: 'user', chatId: 'chat', chatType: 'p2p' };
const bot: BotConfig = { agent: 'codex', platform: 'feishu', workingDirectory: '/project', allowFrom: ['user'], permissionMode: 'blacklist' };

describe('bot access policy', () => {
  it.each([{ allowFrom: [] }, { allowFrom: ['*'] }])('denies an empty or implicit public user list: %j', ({ allowFrom }) => {
    expect(getBotAccessRejection(actor, { ...bot, allowFrom })).toBe('Unauthorized user');
  });
  it('requires both an explicit public flag and wildcard', () => {
    expect(getBotAccessRejection(actor, { ...bot, allowFrom: ['*'], allowPublic: true })).toBeUndefined();
    expect(getBotAccessRejection(actor, { ...bot, allowFrom: [], allowPublic: true })).toBe('Unauthorized user');
  });
  it('admits named admins without overriding disabled bots or forbidden groups', () => {
    const adminBot = { ...bot, allowFrom: [], adminUsers: ['user'], groupPolicy: 'allowlist' as const, groupAllowFrom: ['good'] };
    expect(getBotAccessRejection(actor, adminBot)).toBeUndefined();
    expect(getBotAccessRejection(actor, { ...adminBot, enabled: false })).toBe('Bot disabled');
    expect(getBotAccessRejection({ ...actor, chatType: 'group' }, adminBot)).toBe('Unauthorized group');
  });
  it.each(['group', 'supergroup', 'channel'])('checks group restrictions for %s', (chatType) => {
    expect(getBotAccessRejection({ ...actor, chatType }, { ...bot, groupAllowFrom: ['other'] })).toBe('Unauthorized group');
  });
  it('preserves old session keys and separates topics without delimiter collisions', () => {
    expect(buildSessionKey('feishu', 'chat', 'bot')).toBe('feishu:chat:bot');
    expect(buildSessionKey('feishu', 'chat', 'bot', 'a:b')).toBe('feishu:chat:bot:a%3Ab');
    expect(buildSessionKey('feishu', 'chat', 'bot', 'a%3Ab')).not.toBe(buildSessionKey('feishu', 'chat', 'bot', 'a:b'));
  });
});

describe('session access policy', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'cli2im-access-test-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const params = { bot, actor, sessionKey: 'feishu:chat:bot' as const };
  it('allows only the current conversation unless explicitly granted', async () => {
    expect(await canAccessSession({ ...params, session: { key: 'feishu:chat:bot', agentName: 'codex' } })).toBe(true);
    expect(await canAccessSession({ ...params, session: { key: 'feishu:other:bot', cwd: root } })).toBe(false);
    expect(await canAccessSession({ ...params, bot: { ...bot, workingDirectory: root }, session: { cwd: root } })).toBe(false);
  });
  it('admits an admin to matching agent histories, never a different agent', async () => {
    const admin = { ...bot, adminUsers: ['user'] };
    expect(await canAccessSession({ ...params, bot: admin, session: { agentName: 'codex', cwd: root } })).toBe(true);
    expect(await canAccessSession({ ...params, bot: admin, session: { agentName: 'claude-code', cwd: root } })).toBe(false);
  });
  it('checks canonical roots and rejects symlink or prefix escapes', async () => {
    const shared = join(root, 'shared');
    const inside = join(shared, 'project');
    const outside = join(root, 'shared-private');
    await mkdir(inside, { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(shared, 'escape'));
    const scoped = { ...bot, sessionRoots: [shared] };
    expect(await canAccessSession({ ...params, bot: scoped, session: { cwd: inside } })).toBe(true);
    expect(await canAccessSession({ ...params, bot: scoped, session: { cwd: outside } })).toBe(false);
    expect(await canAccessSession({ ...params, bot: scoped, session: { cwd: join(shared, 'escape') } })).toBe(false);
    expect(await canAccessSession({ ...params, bot: scoped, session: { cwd: '' } })).toBe(false);
  });
});
