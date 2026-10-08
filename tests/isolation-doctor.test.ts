import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { isolationFixture } from './helpers/isolation.js';
import { SessionStore } from '../src/session/store.js';
import { MemoryStore } from '../src/memory/store.js';
import { IsolationRuntime } from '../src/isolation/runtime.js';
import { VerificationStore } from '../src/isolation/verification.js';
import { runIsolationDoctor, formatIsolationReport, isolationExitCode } from '../src/services/isolation-doctor.js';

describe('slice 9 isolation doctor command integration', () => {
  let f: ReturnType<typeof isolationFixture>;
  let store: SessionStore;
  beforeEach(async () => { f = isolationFixture(); store = await SessionStore.create(':memory:'); });
  afterEach(() => { store.close(); rmSync(f.root, { recursive: true, force: true }); });
  it('checks each configured scope via the admission runtime and emits only names and states', async () => {
    const runCheck = vi.fn(async (input: import('../src/isolation/check.js').IsolationCheckInput) => ({
      bot: input.bot, scopeKey: input.policy.scopeKey, policyFingerprint: input.policy.fingerprint, agentBinary: input.binary,
      status: 'ERROR' as const, checks: [{ name: 'sensitive.read', status: 'ERROR' }, { name: 'protected.static-write', status: 'PASS', evidenceMode: 'static+readonly' as const }], checkedAt: new Date().toISOString(),
    }));
    const verification = new VerificationStore(join(f.root, 'verification.json'));
    const runtime = new IsolationRuntime({ config: f.config, paths: f.paths, verification, store, memory: new MemoryStore(f.paths.memoryDir),
      inheritedEnv: { HOME: f.paths.home, PATH: '/bin' }, invalidate: vi.fn(), runCheck });
    const rows = await runIsolationDoctor({ config: f.config, paths: f.paths, runtime });
    expect(runCheck).toHaveBeenCalledTimes(3);
    expect(rows.every(row => row.status === 'ERROR' && row.failures.join() === 'sensitive.read')).toBe(true);
    expect(formatIsolationReport(rows)).not.toContain(f.root);
    expect(formatIsolationReport(rows)).toContain('静态+只读: protected.static-write');
    expect(formatIsolationReport(rows)).not.toContain('fixture');
    expect(isolationExitCode(rows)).toBe(1);
    expect(isolationExitCode(rows.map(row => ({ ...row, status: 'VERIFIED', failures: [] })))).toBe(0);
    expect(isolationExitCode([])).toBe(1);
    expect(verification.get('bot', f.workspace)?.status).toBe('ERROR');
  });
  it('keeps disabled and non-isolated bots out of the checker', async () => {
    f.bot.isolation = undefined;
    const runtime = { prepare: vi.fn(), check: vi.fn() } as unknown as IsolationRuntime;
    expect(await runIsolationDoctor({ config: f.config, paths: f.paths, runtime })).toEqual([]);
    expect(runtime.prepare).not.toHaveBeenCalled();
    expect(formatIsolationReport([])).toContain('未配置');
  });
});
