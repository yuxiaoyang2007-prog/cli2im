import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Transform } from 'node:stream';
import { isolationFixture } from './helpers/isolation.js';
import { VerificationStore, identifyBinary, type VerificationRecord, type VerificationStatus } from '../src/isolation/verification.js';
import { assertIsolationAdmission, ISOLATION_PAUSED } from '../src/isolation/admission.js';
import { canResumeIsolated } from '../src/isolation/provenance.js';
import { IsolationRuntime } from '../src/isolation/runtime.js';
import { MemoryStore } from '../src/memory/store.js';
import { SessionStore } from '../src/session/store.js';
import { AgentManager } from '../src/agents/manager.js';
import { ToolGate } from '../src/agents/tool-gate.js';
import type { AgentPlugin, AgentProcess, SpawnOpts } from '../src/types.js';

vi.mock('../src/security/validators.js', () => ({ validateWorkingDirectory: async () => true }));
describe('slice 5 admission and provenance', () => {
  let f: ReturnType<typeof isolationFixture>;
  let verification: VerificationStore;
  let store: SessionStore;
  const key = 'feishu:chat:bot' as const;
  const principal = 'person:alice';
  beforeEach(async () => { f = isolationFixture(); verification = new VerificationStore(join(f.paths.dataDir, 'isolation', 'verification.json')); store = await SessionStore.create(':memory:'); });
  afterEach(() => { vi.restoreAllMocks(); store.close(); rmSync(f.root, { recursive: true, force: true }); });
  const binary = () => identifyBinary('/bin/cat');
  const record = (fingerprint: string, status: VerificationStatus = 'VERIFIED'): VerificationRecord => ({
    bot: 'bot', scopeKey: f.workspace, policyFingerprint: fingerprint, agentBinary: binary(), status,
    checks: [{ name: 'injected fixture', status: 'PASS' }], checkedAt: new Date().toISOString() });
  const context = (fingerprint: string) => ({ bot: 'bot', principal, scope: f.workspace, policyFingerprint: fingerprint, memoryGeneration: 0 });

  it.each(['UNVERIFIED', 'STALE', 'LEAK', 'UNSUPPORTED', 'ERROR'] as const)('denies %s and only permits a current VERIFIED record', status => {
    const policy = f.policy();
    verification.put(record(policy.fingerprint, status));
    expect(() => assertIsolationAdmission({ verification, policy, binary: binary(), expected: context(policy.fingerprint), env: {} })).toThrow(ISOLATION_PAUSED);
  });
  it('persists 600 records, detects binary/policy staleness and fails closed without overwriting corruption', () => {
    const p = f.policy();
    expect(verification.state('bot', p.scopeKey, p.fingerprint, binary())).toBe('UNVERIFIED');
    verification.put(record(p.fingerprint));
    const path = join(f.paths.dataDir, 'isolation', 'verification.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const reopened = new VerificationStore(path);
    expect(reopened.state('bot', p.scopeKey, p.fingerprint, binary())).toBe('VERIFIED');
    expect(reopened.state('bot', p.scopeKey, 'changed', binary())).toBe('STALE');
    expect(reopened.state('bot', p.scopeKey, p.fingerprint, { ...binary(), size: 1 })).toBe('STALE');
    writeFileSync(path, 'damaged');
    expect(reopened.state('bot', p.scopeKey, p.fingerprint, binary())).toBe('ERROR');
    expect(() => reopened.put(record(p.fingerprint))).toThrow('unreadable');
    expect(readFileSync(path, 'utf8')).toBe('damaged');
  });
  it.each(['bot', 'principal', 'scope', 'policyFingerprint', 'memoryGeneration'] as const)('rejects provenance mismatch: %s', field => {
    const expected = context('policy');
    expect(canResumeIsolated(undefined, expected)).toBe(false);
    const valid = { ...expected, agentSessionId: 'session' };
    expect(canResumeIsolated(valid, expected)).toBe(true);
    expect(canResumeIsolated({ ...valid, [field]: field === 'memoryGeneration' ? 1 : 'other' }, expected)).toBe(false);
  });
  it('keeps immutable provenance across database reopen and does not relabel an old session', async () => {
    const path = join(f.paths.dataDir, 'sessions.db'); const db = await SessionStore.create(path);
    const p = { ...context('policy'), agentSessionId: 'history' };
    db.putProvenance(p); db.close();
    const reopened = await SessionStore.create(path);
    expect(reopened.getProvenance('bot', 'history')).toEqual(p);
    expect(() => reopened.putProvenance({ ...p, memoryGeneration: 1 })).toThrow('Conflicting');
    expect(reopened.getProvenance('bot', 'history')).toEqual(p); reopened.close();
  });
  it('keeps VERIFIED admission across /model, reasoning, agentsFile and per-message changes', async () => {
    const invalidate = vi.fn(); const replaceProcess = vi.fn();
    const runtime = new IsolationRuntime({ config: f.config, paths: f.paths, verification, store,
      memory: new MemoryStore(f.paths.memoryDir), inheritedEnv: { PATH: '/bin' }, sdkVersions: { fixture: '1' }, invalidate, replaceProcess });
    const opts: SpawnOpts = { workingDirectory: f.workspace, permissionMode: 'blacklist', model: 'model-a',
      reasoningEffort: 'low', appendSystemPrompt: 'instructions-a', systemPrompt: 'system-a', initialPrompt: 'message-a',
      env: { CTI_SENDER_ID: 'alice', HTTPS_PROXY: 'http://fixture-a.invalid', LANG: 'en_US.UTF-8' } };
    const initial = await runtime.prepare(key, principal, f.workspace, opts, {}, false);
    verification.put(record(initial.fingerprint));
    const variants: Partial<SpawnOpts>[] = [
      { model: 'model-b' }, { reasoningEffort: 'high' }, { appendSystemPrompt: 'instructions-b' },
      { systemPrompt: 'system-b' }, { initialPrompt: 'message-b', turnTimeoutMs: 1000, idleTimeoutMs: 500 },
      { env: { TMPDIR: initial.tmpdir, CTI_SENDER_ID: 'bob', CTI_SENDER_NAME: 'fixture', HTTPS_PROXY: 'http://fixture-b.invalid', TERM: 'dumb' } },
    ];
    f.bot.agentsFile = join(f.root, 'maintained.md'); writeFileSync(f.bot.agentsFile, 'new instructions');
    for (const changes of variants) {
      Object.assign(opts, changes);
      await expect(runtime.assert(key)).resolves.toBeUndefined();
      const next = await runtime.prepare(key, principal, f.workspace, opts, {});
      expect(next.fingerprint).toBe(initial.fingerprint);
      expect(verification.state('bot', f.workspace, next.fingerprint, binary())).toBe('VERIFIED');
    }
    expect(invalidate).not.toHaveBeenCalled(); expect(replaceProcess).not.toHaveBeenCalled();
  });
  it.each(['sandboxMode', 'permissionMode', 'autoApprove', 'addDirs', 'sandbox', 'sandboxBoxRoots',
    'sandboxOtherProtectedRoots', 'envKeys'] as const)('invalidates admission when isolation parameter %s changes', async field => {
    const invalidate = vi.fn();
    const runtime = new IsolationRuntime({ config: f.config, paths: f.paths, verification, store,
      memory: new MemoryStore(f.paths.memoryDir), inheritedEnv: { PATH: '/bin' }, sdkVersions: { fixture: '1' }, invalidate });
    const opts: SpawnOpts = { workingDirectory: f.workspace, permissionMode: 'blacklist' };
    const initial = await runtime.prepare(key, principal, f.workspace, opts, {}, false);
    verification.put(record(initial.fingerprint));
    if (field === 'sandboxMode') opts.sandboxMode = 'read-only';
    if (field === 'permissionMode') opts.permissionMode = 'bypass';
    if (field === 'autoApprove') opts.autoApprove = true;
    if (field === 'addDirs') opts.addDirs = [join(f.root, 'reference')];
    if (field === 'sandbox') opts.sandbox = 'off';
    if (field === 'sandboxBoxRoots') opts.sandboxBoxRoots = [f.root];
    if (field === 'sandboxOtherProtectedRoots') opts.sandboxOtherProtectedRoots = [f.root];
    if (field === 'envKeys') opts.env = { ...opts.env, CODEX_HOME: join(f.root, 'agent-home') };
    await expect(runtime.assert(key)).rejects.toThrow(ISOLATION_PAUSED);
    const changed = await runtime.prepare(key, principal, f.workspace, opts, {}, false, true);
    expect(changed.fingerprint).not.toBe(initial.fingerprint);
    expect(verification.state('bot', f.workspace, changed.fingerprint, binary())).toBe('STALE');
    expect(invalidate).toHaveBeenCalledWith(key);
  });
  it('integration: manager gates spawn/resume, failure kills live children, forgetting rejects old generations', async () => {
    const memory = new MemoryStore(f.paths.memoryDir);
    const manager = new AgentManager(new ToolGate([]), () => {});
    const children: AgentProcess[] = [];
    const spawn = vi.fn(() => {
      const proc = Object.assign(new EventEmitter(), { pid: 1, sessionId: '', stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() }) as AgentProcess;
      children.push(proc); return proc;
    });
    const plugin = { name: 'codex', displayName: 'fixture', capabilities: { streamJson: true, sessionResume: true, permissionPrompt: false, gracefulCancel: false, slashCommands: [] },
      spawn, resume: vi.fn(spawn), createStdoutParser: () => new Transform({ objectMode: true, transform(c, _e, cb) { cb(null, c); } }), formatStdinMessage: () => '',
      buildSpawnArgs: () => [], formatPermissionResponse: () => '' } as unknown as AgentPlugin;
    manager.registerPlugin(plugin);
    const invalidated = vi.fn((k: import('../src/types.js').SessionKey) => manager.forgetSession(k));
    const runtime = new IsolationRuntime({ config: f.config, paths: f.paths, verification, store, memory,
      inheritedEnv: { PATH: '/bin' }, prepareTmp: async policy => { mkdirSync(policy.tmpdir, { recursive: true, mode: 0o700 }); }, sdkVersions: { fixture: '1' }, invalidate: invalidated });
    manager.setIsolationGuard((k, opts, id) => runtime.guardStart(k, opts, id));
    const opts: SpawnOpts = { workingDirectory: f.workspace, permissionMode: 'blacklist' };
    const handlers = { onEvent: vi.fn(), onToolBlocked: vi.fn(), onPermissionTimeout: vi.fn(), onProcessExit: vi.fn() };
    opts.isolation = await runtime.prepare(key, principal, f.workspace, opts, {}, false);
    await expect(manager.spawnAgent(key, 'codex', opts, handlers)).rejects.toThrow(ISOLATION_PAUSED);
    expect(spawn).not.toHaveBeenCalled();
    verification.put(record(opts.isolation.fingerprint));
    await manager.spawnAgent(key, 'codex', opts, handlers);
    const capture = runtime.captureRecorder(key); capture('old');
    expect(await runtime.canResume(key, 'old')).toBe(true);
    manager.forgetSession(key);
    await manager.resumeAgent(key, 'codex', 'old', opts, handlers);
    verification.put(record(opts.isolation.fingerprint, 'LEAK'));
    expect(manager.hasProcess(key)).toBe(false);
    expect(children.at(-1)!.kill).toHaveBeenCalledWith('SIGTERM');
    verification.put(record(opts.isolation.fingerprint));
    const entry = await memory.add(principal, 'actor', 'remember');
    await memory.forget(principal, entry.id, () => true);
    expect(await runtime.canResume(key, 'old')).toBe(false);
    await expect(manager.resumeAgent(key, 'codex', 'old', opts, handlers)).rejects.toThrow();
    opts.isolation = await runtime.prepare(key, principal, f.workspace, opts, {});
    await expect(manager.resumeAgent(key, 'codex', 'old', opts, handlers)).rejects.toThrow('已被撤销');
    expect(await runtime.listDomain({ bot: 'bot', principal, scope: f.workspace, policyFingerprint: opts.isolation.fingerprint })).toEqual([]);
    await manager.spawnAgent(key, 'codex', opts, handlers);
    runtime.captureRecorder(key)('new'); expect(store.getProvenance('bot', 'new')?.memoryGeneration).toBe(1);
    // A late callback must retain its original generation, never adopt a new binding.
    capture('late-old'); expect(store.getProvenance('bot', 'late-old')?.memoryGeneration).toBe(0);
    manager.forgetSession(key);
  });
});
