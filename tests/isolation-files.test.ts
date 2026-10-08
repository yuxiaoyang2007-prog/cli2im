import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolationFixture } from './helpers/isolation.js';
import { downloadInboundAttachments } from '../src/media.js';
import { buildReadProfile, prepareTemporaryDirectory, sandboxReadFile } from '../src/isolation/sbx-read.js';
import { FeishuAdapter } from '../src/platforms/feishu/adapter.js';
import { TelegramAdapter } from '../src/platforms/telegram/adapter.js';
import { createRuntimeEventHandler } from '../src/runtime/event-handler.js';
import type { InboundMessage, FilePayload } from '../src/types.js';

function kernelSandboxAvailable(): boolean {
  if (process.platform !== 'darwin') return false;
  const capability = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/bin/cat', '/dev/null'], { encoding: 'utf8' });
  if (capability.status === 0) return true;
  console.warn('ENVIRONMENT: sandbox-exec cannot initialize in this runner; kernel integration not performed');
  return false;
}

describe('slice 5 bridge file IO', () => {
  let f: ReturnType<typeof isolationFixture>;
  beforeEach(() => { f = isolationFixture(); });
  afterEach(() => { vi.restoreAllMocks(); rmSync(f.root, { recursive: true, force: true }); });
  it('integration: isolated attachments use bridge-owned inbox despite a workspace inbox symlink', async () => {
    symlinkSync(join(f.root, 'outside'), join(f.workspace, 'inbox'));
    const msg: InboundMessage = { platform: 'feishu', chatId: 'chat', userId: 'alice', chatType: 'p2p', text: '',
      attachments: [{ type: 'file', messageId: 'm', fileKey: 'f', fileName: 'fixture.txt' }] };
    const policy = f.policy();
    await downloadInboundAttachments(msg, { downloadFile: async () => Buffer.from('fixture') }, join(f.workspace, 'inbox'), policy);
    expect(msg.attachments![0].localPath).toContain(policy.inbox);
    expect(readFileSync(msg.attachments![0].localPath!, 'utf8')).toBe('fixture');
    expect(statSync(policy.inbox).mode & 0o777).toBe(0o700);
    expect(statSync(msg.attachments![0].localPath!).mode & 0o777).toBe(0o600);
    msg.attachments![0].localPath = join(f.workspace, 'agent-owned'); writeFileSync(msg.attachments![0].localPath, 'untrusted');
    await expect(downloadInboundAttachments(msg, { downloadFile: vi.fn() }, '', policy)).rejects.toThrow('outside');
  });
  it('integration: both adapters upload trusted bytes without reopening an agent path', async () => {
    const file = { path: '/does-not-exist/agent.txt', name: 'fixture.txt', data: Buffer.from('trusted') };
    const tg = new TelegramAdapter({ token: 'fixture', botName: 'fixture' });
    const api = vi.spyOn(tg as never as { botApi: (...args: unknown[]) => Promise<unknown> }, 'botApi').mockResolvedValue({});
    await tg.sendFile('chat', file);
    const body = api.mock.calls[0][1] as FormData;
    expect(await (body.get('document') as Blob).text()).toBe('trusted');
    const feishu = new FeishuAdapter({ appId: 'fixture', appSecret: 'fixture', botName: 'fixture' });
    const client = (feishu as unknown as { client: { im: { file: { create: (...args: unknown[]) => Promise<unknown> } } } }).client;
    const upload = vi.spyOn(client.im.file, 'create').mockResolvedValue({});
    await feishu.sendFile('chat', file);
    expect(upload.mock.calls[0][0]).toMatchObject({ data: { file: Buffer.from('trusted') } });
  });
  it.each(['file', 'result'] as const)('routes every %s event through the bounded reader and never trusts supplied data', async type => {
    const sendFile = vi.fn(); const readOutbound = vi.fn(async (file: FilePayload) => ({ ...file, data: Buffer.from('sandboxed') }));
    const handler = createRuntimeEventHandler({ sessionKey: 'feishu:chat:bot', store: { getByKey: async () => null, updateAgentSessionId: vi.fn() },
      voiceSessions: new Map(), voiceResponseBuffer: { value: '' }, stopTyping: vi.fn(), sendVoiceReply: vi.fn(),
      adapter: { sendFile } as never, relayDeps: { config: { bots: {} } } as never, readOutbound });
    const event = type === 'file' ? { type, path: '/untrusted/path' } : { type, sessionId: '', createdFiles: [{ path: '/untrusted/path', name: 'fixture', data: Buffer.from('forged') }] };
    await handler('feishu:chat:bot', event, { isCurrent: () => true, signal: new AbortController().signal });
    expect(readOutbound).toHaveBeenCalledTimes(1);
    expect(sendFile.mock.calls[0][1].data.toString()).toBe('sandboxed');
  });
  it('fails closed when a kernel sandbox cannot run', async () => {
    const p = f.policy();
    writeFileSync(join(f.workspace, 'safe'), 'safe');
    const probe = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/bin/cat', '/dev/null'], { encoding: 'utf8' });
    if (probe.status === 0) return;
    await expect(sandboxReadFile(join(f.workspace, 'safe'), p)).rejects.toThrow(/sandbox unavailable|read denied/);
  });
  it('macOS integration: real sandbox denies symlink and parent replacement, including a concurrent swap', async ctx => {
    if (!kernelSandboxAvailable()) return ctx.skip();
    const p = f.policy(); const safe = join(f.workspace, 'safe'); const outside = join(f.root, 'outside', 'value');
    writeFileSync(safe, 'safe'); writeFileSync(outside, 'OUTSIDE');
    expect((await sandboxReadFile(safe, p)).toString()).toBe('safe');
    const reference = join(f.root, 'reference', 'safe'); writeFileSync(reference, 'reference');
    expect((await sandboxReadFile(reference, p)).toString()).toBe('reference');
    await expect(sandboxReadFile(outside, p)).rejects.toThrow('denied');
    // Synthetic HOME only: never inspect the runner's real credentials/configuration.
    for (const name of ['.cli2im', '.ssh']) {
      const dir = join(f.paths.home, name); mkdirSync(dir); const file = join(dir, 'fixture'); writeFileSync(file, 'PRIVATE');
      await expect(sandboxReadFile(file, p)).rejects.toThrow('denied');
    }
    await expect(sandboxReadFile(safe, p, { maxBytes: 1 })).rejects.toThrow('size limit');
    symlinkSync(outside, join(f.workspace, 'link'));
    await expect(sandboxReadFile(join(f.workspace, 'link'), p)).rejects.toThrow('denied');
    const parent = join(f.workspace, 'parent'); mkdirSync(parent); writeFileSync(join(parent, 'value'), 'safe');
    const observed = realpathSync(join(parent, 'value'));
    renameSync(parent, join(f.workspace, 'retired')); symlinkSync(join(f.root, 'outside'), parent);
    await expect(sandboxReadFile(observed, p)).rejects.toThrow('denied');
    rmSync(parent); renameSync(join(f.workspace, 'retired'), parent);
    const pending = sandboxReadFile(join(parent, 'value'), p).then(b => b.toString(), () => 'DENIED');
    renameSync(parent, join(f.workspace, 'retired')); symlinkSync(join(f.root, 'outside'), parent);
    expect(['safe', 'DENIED']).toContain(await pending);
    // Hard denial inside an otherwise granted workspace remains effective.
    const profile = buildReadProfile({ ...p, hardDeny: [...p.hardDeny, safe] });
    const denied = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/cat', safe], { encoding: 'utf8' });
    expect(denied.status).not.toBe(0); expect(denied.stdout).not.toContain('safe');
  });
  it.for(['new', 'existing'] as const)('macOS integration: prepares a %s temporary directory with mode 700', async (state, ctx) => {
    if (!kernelSandboxAvailable()) return ctx.skip();
    const p = f.policy();
    if (state === 'existing') { mkdirSync(p.tmpdir); chmodSync(p.tmpdir, 0o755); }
    await prepareTemporaryDirectory(p);
    expect(statSync(p.tmpdir).isDirectory()).toBe(true);
    expect(statSync(p.tmpdir).mode & 0o777).toBe(0o700);
    await prepareTemporaryDirectory(p);
    expect(statSync(p.tmpdir).mode & 0o777).toBe(0o700);
  });
  it('macOS integration: temporary directory preparation refuses an external symlink without chmodding its target', async ctx => {
    if (!kernelSandboxAvailable()) return ctx.skip();
    const p = f.policy(); const outside = join(f.root, 'outside'); chmodSync(outside, 0o755);
    symlinkSync(outside, p.tmpdir);
    await expect(prepareTemporaryDirectory(p)).rejects.toThrow('sandbox unavailable or denied');
    expect(statSync(outside).mode & 0o777).toBe(0o755);
  });
});
