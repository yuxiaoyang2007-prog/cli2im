import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { isolationFixture } from './helpers/isolation.js';
import { handleBridgeCommand, createCallbackHandler, createHandoffSpawnResume, startAgentProcessForSession } from '../src/index.js';
import { handleCLISessionResume } from '../src/runtime/session-resume.js';
import { reconcileIsolatedSession } from '../src/isolation/session.js';
import { reportMessageFailure } from '../src/runtime/message-failure.js';
import { TaskTracker } from '../src/runtime/task-tracker.js';
import { IsolationAdmissionError, ISOLATION_PAUSED, assertIsolationAdmission } from '../src/isolation/admission.js';
import { VerificationStore, identifyBinary } from '../src/isolation/verification.js';
import { HandoffService } from '../src/services/handoff.js';
import { SessionStore } from '../src/session/store.js';
import type { PlatformAdapter, SessionKey } from '../src/types.js';

vi.mock('../src/session/codex-scanner.js', () => ({ CodexSessionScanner: class { constructor() { throw new Error('Personal scanner must never run'); } } }));
describe('slice 5 all resume entrypoints and controls', () => {
  let f: ReturnType<typeof isolationFixture>; let store: SessionStore;
  const key: SessionKey = 'feishu:chat:bot';
  const sender = { platform: 'feishu', userId: 'alice', chatType: 'p2p', chatId: 'chat', messageId: 'message', data: 'session:old' };
  const state = { fastModeBySession: new Map<SessionKey, boolean>() };
  beforeEach(async () => { f = isolationFixture(); store = await SessionStore.create(':memory:'); });
  afterEach(() => { vi.restoreAllMocks(); store.close(); rmSync(f.root, { recursive: true, force: true }); });
  const adapter = () => ({ name: 'feishu', send: vi.fn(async () => 'message') }) as unknown as PlatformAdapter;
  function rejectedResume() {
    const p = f.policy(); const binary = identifyBinary('/bin/cat');
    const verification = new VerificationStore(join(f.paths.dataDir, 'verification.json'));
    verification.put({ bot: 'bot', scopeKey: p.scopeKey, policyFingerprint: p.fingerprint, agentBinary: binary,
      status: 'VERIFIED', checks: [], checkedAt: new Date().toISOString() });
    const expected = { bot: 'bot', principal: 'person:alice', scope: f.workspace, policyFingerprint: p.fingerprint, memoryGeneration: 1 };
    const spawn = vi.fn();
    const resume = vi.fn(async (_callback: unknown, sessionId: string) => {
      assertIsolationAdmission({ verification, policy: p, binary, expected, env: {}, sessionId,
        provenance: { ...expected, agentSessionId: sessionId, memoryGeneration: 0 } });
      spawn();
    });
    return { resume, spawn };
  }
  it.each(['ordinary', 'model switch', 'process exit'])('replaces a revoked %s continuation once and spawns fresh', async reason => {
    const session = await store.getOrCreate(key, { agentName: 'codex', workingDirectory: f.workspace });
    session.agentSessionId = 'old'; await store.updateAgentSessionId(session.id, 'old');
    let latest: string | undefined = reason === 'process exit' ? 'old' : undefined;
    const manager = { getLatestSessionId: () => latest, forgetSession: vi.fn(() => { latest = undefined; }),
      getPlugin: () => ({ capabilities: { sessionResume: true } }), spawnAgent: vi.fn(), resumeAgent: vi.fn() };
    const notify = vi.fn(async () => {});
    const runtime = { canResume: vi.fn(async () => false) };
    await reconcileIsolatedSession({ runtime, manager, store, session, key, notify });
    await reconcileIsolatedSession({ runtime, manager, store, session, key, notify });
    await startAgentProcessForSession({ agentManager: manager as never, store, session, sessionKey: key, agentName: 'codex',
      spawnOpts: { workingDirectory: f.workspace, permissionMode: 'blacklist', isolation: f.policy() }, handlers: {} as never });
    expect(notify).toHaveBeenCalledTimes(1); expect(manager.resumeAgent).not.toHaveBeenCalled(); expect(manager.spawnAgent).toHaveBeenCalledTimes(1);
    expect((await store.getByKey(key))?.agentSessionId).toBeUndefined();
  });
  it.each(['resume', 'switch'])('/%s rejects old generations through the isolated route without handoff or scanning', async command => {
    const a = adapter(); const denied = rejectedResume(); const handoff = { acceptHandoff: vi.fn() };
    await handleBridgeCommand({ command, args: ['old'] }, key, 'bot', 'chat', a, store, {} as never, handoff as never,
      undefined, undefined, new Map(), state, f.bot, sender, undefined, { resumeIsolated: denied.resume });
    expect(denied.resume).toHaveBeenCalledTimes(1); expect(denied.spawn).not.toHaveBeenCalled(); expect(handoff.acceptHandoff).not.toHaveBeenCalled();
    expect(a.send).toHaveBeenCalledWith('chat', expect.objectContaining({ text: expect.stringContaining('恢复失败') }));
  });
  it('recovery button invokes the same admission and never trusts callback cwd', async () => {
    const a = adapter(); const denied = rejectedResume();
    const scan = vi.fn(); const handoff = { tryAcquireLock: vi.fn(), acceptHandoff: vi.fn() };
    await handleCLISessionResume({ callback: sender, resume: { sessionId: 'old', cwd: '/untrusted' }, botName: 'bot', botConfig: f.bot,
      adapter: a, store, scanSessions: scan, agentManager: {} as never, handoffService: handoff as never,
      cardController: undefined, tgStreamController: undefined, resumeIsolated: denied.resume });
    expect(denied.resume).toHaveBeenCalledWith(sender, 'old'); expect(scan).not.toHaveBeenCalled(); expect(handoff.acceptHandoff).not.toHaveBeenCalled();
  });
  it('callback dispatcher forwards isolated admission', async () => {
    const a = adapter(); const handleSessionResume = vi.fn(async () => {}); const resumeIsolated = vi.fn();
    const handler = createCallbackHandler({ botName: 'bot', botConfig: f.bot, adapter: a, store, agentManager: {} as never, handoffService: {} as never,
      queue: { enqueue: async (_key: SessionKey, fn: () => Promise<void>) => fn() } as never, handleSessionResume, resumeIsolated });
    handler({ ...sender, data: JSON.stringify({ action: 'resume_cli', sessionId: 'old', cwd: '/untrusted' }) });
    await Promise.resolve();
    expect(handleSessionResume).toHaveBeenCalledWith(expect.objectContaining({ resumeIsolated }));
  });
  it('denies HTTP accept, HTTP release and command handoff before touching any session', async () => {
    const spawnResume = vi.fn(); const getSession = vi.fn();
    const handoff = new HandoffService({ spawnResume, getSession, updateState: vi.fn(), isIsolatedBot: () => true });
    expect(await handoff.acceptHandoff({ botName: 'bot', agentName: 'codex', sessionId: 'old', workDir: f.workspace })).toMatchObject({ success: false });
    await expect(handoff.releaseHandoff(key)).rejects.toThrow('禁用');
    const a = adapter(); await handleBridgeCommand({ command: 'handoff', args: [] }, key, 'bot', 'chat', a, store, {} as never, handoff,
      undefined, undefined, new Map(), state, f.bot, sender);
    expect(spawnResume).not.toHaveBeenCalled(); expect(getSession).not.toHaveBeenCalled();
    const resume = createHandoffSpawnResume({ resumeAgent: vi.fn() }, store, () => ({} as never), () => f.bot);
    await expect(resume(key, 'codex', 'old', f.workspace)).rejects.toThrow('禁用');
  });
  it('reports the required pause message on denied admission, without leaking diagnostic detail', async () => {
    const a = adapter();
    await reportMessageFailure(new IsolationAdmissionError('internal detail'), key, { ...sender, text: 'hello' },
      { store, busyTasks: new TaskTracker(), adapter: a });
    expect(a.send).toHaveBeenCalledWith('chat', { text: ISOLATION_PAUSED });
  });
  it('lists only supplied isolation-domain provenance and keeps diagnostics/stop usable without verification', async () => {
    f.bot.adminUsers = ['alice'];
    const a = adapter(); const manager = { hasProcess: () => false, cancelAgent: vi.fn(), getPlugin: () => undefined };
    const isolatedSessions = vi.fn(async () => [{ agentSessionId: 'own', bot: 'bot', principal: 'person:alice', scope: f.workspace, policyFingerprint: 'p', memoryGeneration: 1 }]);
    for (const command of ['sessions', 'stop', 'doctor']) {
      await handleBridgeCommand({ command, args: [] }, key, 'bot', 'chat', a, store, manager as never, {} as never,
        undefined, undefined, new Map(), state, f.bot, sender, undefined, { isolatedSessions, doctor: async () => 'diagnostic' });
    }
    expect(isolatedSessions).toHaveBeenCalledTimes(1); expect(a.send).toHaveBeenCalledWith('chat', { text: '- own' });
    expect(manager.cancelAgent).toHaveBeenCalledWith(key); expect(a.send).toHaveBeenCalledWith('chat', expect.objectContaining({ text: 'diagnostic' }));
  });
});
