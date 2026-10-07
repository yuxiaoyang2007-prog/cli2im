import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecoveryStore } from '../src/runtime/result-recovery.js';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'cli2im-recovery-test-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('private result recovery', () => {
  it('survives restart, separates scopes, and keeps private permissions', async () => {
    const root = join(directory, 'recovery');
    const first = new RecoveryStore(root, { now: () => 123 });
    const saved = await first.save('feishu:chat:bot:alice', { status: 'completed', text: 'Finished output' });
    expect(saved.delivery).toBe('manual');
    const restarted = new RecoveryStore(root);
    expect(await restarted.read('feishu:chat:bot:alice')).toEqual(saved);
    expect(await restarted.read('feishu:chat:bot:bob')).toBeNull();
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    const names = await readdir(root);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    expect((await stat(join(root, names[0]))).mode & 0o777).toBe(0o600);
  });

  it('caps Unicode results without breaking the final code point', async () => {
    const store = new RecoveryStore(directory);
    const result = await store.save('scope', { status: 'completed', text: '你'.repeat(400_000) });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(1024 * 1024);
    expect(result.text).not.toContain('�');
    expect(await store.read('scope')).toEqual(result);
  });

  it('serializes same-scope saves and leaves no partial temporary files', async () => {
    const store = new RecoveryStore(directory);
    await Promise.all([
      store.save('scope', { status: 'completed', text: 'first' }),
      store.save('scope', { status: 'error', text: 'second' }),
    ]);
    expect((await store.read('scope'))?.text).toBe('second');
    expect((await readdir(directory)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('does not follow an attacker-controlled result symlink', async () => {
    const root = join(directory, 'recovery');
    const store = new RecoveryStore(root);
    await store.save('scope', { status: 'completed', text: 'original' });
    const [name] = await readdir(root);
    const target = join(directory, 'outside.json');
    await writeFile(target, JSON.stringify({ version: 1, savedAt: 1, status: 'completed', text: 'private elsewhere', truncated: false, delivery: 'manual' }));
    await rm(join(root, name));
    await symlink(target, join(root, name));
    await expect(store.read('scope')).rejects.toThrow();
    await store.save('scope', { status: 'completed', text: 'replacement' });
    expect(JSON.parse(await readFile(target, 'utf8')).text).toBe('private elsewhere');
  });
});

describe('incoming metadata deduplication', () => {
  it('rejects duplicates across restart but isolates platforms and bots', async () => {
    const first = new RecoveryStore(directory);
    expect(await first.acceptIncoming('feishu', 'bot1', 'message-1')).toBe(true);
    const restarted = new RecoveryStore(directory);
    expect(await restarted.acceptIncoming('feishu', 'bot1', 'message-1')).toBe(false);
    expect(await restarted.acceptIncoming('telegram', 'bot1', 'message-1')).toBe(true);
    expect(await restarted.acceptIncoming('feishu', 'bot2', 'message-1')).toBe(true);
    expect(await restarted.acceptIncoming('feishu', 'bot1', '')).toBe(true);
    const raw = await readFile(join(directory, 'incoming.json'), 'utf8');
    expect(raw).not.toMatch(/message-1|feishu|telegram|bot1/);
  });

  it('keeps bounded metadata and expires entries after the retention window', async () => {
    let now = 100;
    const store = new RecoveryStore(directory, { now: () => now, incomingLimit: 2, incomingTtlMs: 50 });
    await store.acceptIncoming('platform', 'bot', 'oldest');
    await store.acceptIncoming('platform', 'bot', 'middle');
    await store.acceptIncoming('platform', 'bot', 'newest');
    expect(JSON.parse(await readFile(join(directory, 'incoming.json'), 'utf8')).entries).toHaveLength(2);
    expect(await store.acceptIncoming('platform', 'bot', 'newest')).toBe(false);
    now = 151;
    expect(await store.acceptIncoming('platform', 'bot', 'newest')).toBe(true);
    expect(JSON.parse(await readFile(join(directory, 'incoming.json'), 'utf8')).entries).toHaveLength(1);
  });

  it('accepts exactly one copy under simultaneous arrivals from two store instances', async () => {
    const a = new RecoveryStore(directory);
    const b = new RecoveryStore(directory);
    expect(await Promise.all([a.acceptIncoming('p', 'b', 'id'), b.acceptIncoming('p', 'b', 'id')])).toEqual([true, false]);
  });

  it('fails closed on corrupt metadata instead of silently re-running messages', async () => {
    await writeFile(join(directory, 'incoming.json'), '{"wrong": true}');
    await expect(new RecoveryStore(directory).acceptIncoming('p', 'b', 'id')).rejects.toThrow('invalid');
  });
});
