import { isolatedCodexHome, prepareCodexHome, isolationEnvironment } from './codex.js';
import { sdkIdentity } from './sdk-identity.js';
import { prepareTemporaryDirectory } from './sbx-read.js';
import type { AppConfig, SessionKey, SpawnOpts } from '../types.js';
import type { SessionStore } from '../session/store.js';
import type { MemoryStore } from '../memory/store.js';
import { buildChildEnv, type ChildProvider } from '../security/child-env.js';
import { buildIsolationPolicy, scopeTmpdir, contains, assertIsolationSearchPath, isolationSearchPathDenied, validateIsolationSearchPath, type PolicyPaths, type IsolationPolicy, type IsolationProductionParameters } from './policy.js';
import { canonicalPath as canonicalPolicyWorkspace } from '../runtime/execution-scope.js';
import { assertIsolationAdmission, assertNoProviderCredentials, IsolationAdmissionError } from './admission.js';
import type { IsolationCheckInput } from './check.js';
import { identifyBinary, type AgentBinary, type VerificationRecord, type VerificationStore } from './verification.js';
import { canResumeIsolated, type ProvenanceContext } from './provenance.js';

function productionParameters(opts: SpawnOpts, env: Record<string, string>): IsolationProductionParameters {
  return { sandboxMode: opts.sandboxMode, permissionMode: opts.permissionMode, autoApprove: opts.autoApprove,
    addDirs: opts.addDirs, sandbox: opts.sandbox, sandboxBoxRoots: opts.sandboxBoxRoots,
    sandboxOtherProtectedRoots: opts.sandboxOtherProtectedRoots,
    // Values can contain credentials or per-message identity. Presentation/model keys do not set boundaries.
    envKeys: Object.keys(env).filter(key => !key.startsWith('CTI_SENDER_')
      && !/^(?:ANTHROPIC_MODEL|LANG|LC_.*|TZ|TERM|COLORTERM|NO_COLOR|FORCE_COLOR|USER|LOGNAME)$/.test(key)).sort() };
}
type Binding = { binary: AgentBinary; policy: IsolationPolicy; expected: ProvenanceContext; opts: SpawnOpts; input: Parameters<typeof buildIsolationPolicy>[0] };
/** One admission boundary shared by starts, resumes, live messages and explicit restoration. */
export class IsolationRuntime {
  private bindings = new Map<SessionKey, Binding>();
  private checking = new Map<string, Promise<void>>();
  constructor(private deps: {
    config: AppConfig; paths: PolicyPaths; verification: VerificationStore; store: SessionStore; memory: MemoryStore;
    invalidate: (key: SessionKey) => void; replaceProcess?: (key: SessionKey) => void;
    runCheck?: (input: IsolationCheckInput) => Promise<VerificationRecord>;
    prepareTmp?: typeof prepareTemporaryDirectory; inheritedEnv?: NodeJS.ProcessEnv; sdkVersions?: unknown;
  }) {
    deps.verification.onChange(record => {
      for (const [key, binding] of this.bindings) {
        if (binding.expected.bot === record.bot && (record.status !== 'VERIFIED'
          || (record.scopeKey === binding.policy.scopeKey && record.policyFingerprint !== binding.policy.fingerprint))) deps.invalidate(key);
      }
    });
  }
  policy(key: SessionKey): IsolationPolicy | undefined { return this.bindings.get(key)?.policy; }
  clearPreparationFailure(bot: string): void { this.deps.verification.clearPreparationFailure(bot); }
  revokePreparation(bot: string, error: unknown): IsolationAdmissionError {
    const failure = error instanceof IsolationAdmissionError ? error : new IsolationAdmissionError(undefined,
      error instanceof Error && error.message.startsWith('UNSUPPORTED') ? 'UNSUPPORTED' : 'ERROR');
    // Terminate first, even if the verification store cannot be written.
    for (const [key, binding] of this.bindings) if (binding.expected.bot === bot) this.deps.invalidate(key);
    this.deps.verification.revokeBot(bot, failure.status);
    return failure;
  }
  async prepare(key: SessionKey, principal: string, scopeKey: string, opts: SpawnOpts, identityMapping: unknown, requireVerified = true, inspectOnly = false): Promise<IsolationPolicy> {
    let prepared = false;
    try {
      const botName = key.split(':')[2];
      const bot = this.deps.config.bots[botName];
      const tmpdir = scopeTmpdir(bot.agent, canonicalPolicyWorkspace(scopeKey), this.deps.paths);
      opts.env = isolationEnvironment({ ...opts.env, ...(bot.agent === 'codex' ? { CODEX_HOME: isolatedCodexHome(this.deps.paths.dataDir, botName) } : {}), ...(bot.agent === 'claude-code' ? { CLAUDE_CODE_TMPDIR: tmpdir } : { TMPDIR: tmpdir }) });
      const env = buildChildEnv(bot.agent as ChildProvider, opts.env, this.deps.inheritedEnv ?? process.env);
      assertNoProviderCredentials(env);
      validateIsolationSearchPath(env.PATH, isolationSearchPathDenied(this.deps.config, this.deps.paths));
      const binary = identifyBinary(this.deps.config.agents[bot.agent]?.binary ?? '', env.PATH);
      const input: Parameters<typeof buildIsolationPolicy>[0] = { config: this.deps.config, botName, workspace: scopeKey, paths: this.deps.paths,
        binaryPath: binary.realpath, effectiveEnv: env, identityMapping, sdkVersions: this.deps.sdkVersions ?? sdkIdentity(bot.agent),
        // Production launch values only: no prompt, session ID, ephemeral probe flags or credential values.
        production: productionParameters(opts, env) };
      const policy = buildIsolationPolicy(input);
      if (!contains(policy.workspace, canonicalPolicyWorkspace(opts.workingDirectory))) throw new IsolationAdmissionError();
      const expected = { bot: botName, principal, scope: canonicalPolicyWorkspace(opts.workingDirectory), policyFingerprint: policy.fingerprint,
        memoryGeneration: await this.deps.memory.generation(principal) };
      if (inspectOnly) return policy;
      if (policy.codexHome) prepareCodexHome(policy.codexHome);
      const previous = this.bindings.get(key);
      if (previous && !canResumeIsolated({ ...previous.expected, agentSessionId: '' }, expected)) this.deps.replaceProcess?.(key);
      this.bindings.set(key, { binary, policy, expected, opts, input });
      prepared = true;
      if (requireVerified) await this.assert(key);
      return this.bindings.get(key)!.policy;
    } catch (error) {
      if (!inspectOnly) this.deps.invalidate(key);
      if (!inspectOnly && !prepared) throw this.revokePreparation(key.split(':')[2], error);
      throw error instanceof IsolationAdmissionError ? error : new IsolationAdmissionError(undefined,
        error instanceof Error && error.message.startsWith('UNSUPPORTED') ? 'UNSUPPORTED' : 'ERROR');
    }
  }
  async assert(key: SessionKey, sessionId?: string): Promise<void> {
    if (!this.deps.config.bots[key.split(':')[2]]?.isolation?.enabled) return;
    const binding = this.bindings.get(key);
    if (!binding) throw new IsolationAdmissionError();
    try {
      const bot = this.deps.config.bots[binding.expected.bot];
      const env = isolationEnvironment(buildChildEnv(bot.agent as ChildProvider, binding.opts.env, this.deps.inheritedEnv ?? process.env), binding.policy);
      assertNoProviderCredentials(env);
      validateIsolationSearchPath(env.PATH, isolationSearchPathDenied(this.deps.config, this.deps.paths));
      const binary = identifyBinary(this.deps.config.agents[bot.agent].binary, env.PATH);
      const currentPolicy = buildIsolationPolicy({ ...binding.input, binaryPath: binary.realpath, effectiveEnv: env,
        production: productionParameters(binding.opts, env), sdkVersions: this.deps.sdkVersions ?? sdkIdentity(bot.agent) });
      if (currentPolicy.fingerprint !== binding.policy.fingerprint) {
        const binaryChanged = binary.realpath !== binding.binary.realpath || binary.size !== binding.binary.size || binary.mtime !== binding.binary.mtime;
        if (!binaryChanged || !this.deps.runCheck) throw new IsolationAdmissionError();
        for (const [otherKey, other] of this.bindings) if (other.expected.bot === binding.expected.bot) this.deps.invalidate(otherKey);
        binding.binary = binary;
        binding.policy = currentPolicy;
        binding.opts.isolation = currentPolicy;
        binding.expected = { ...binding.expected, policyFingerprint: currentPolicy.fingerprint };
      }
      await this.checkBinding(binding, env, binary);
      const generation = await this.deps.memory.generation(binding.expected.principal);
      // A revocation between preparation and process creation invalidates the preparation itself.
      if (generation !== binding.expected.memoryGeneration) throw new IsolationAdmissionError();
      assertIsolationAdmission({ verification: this.deps.verification, policy: binding.policy, binary,
        expected: binding.expected, env });
    } catch (error) { this.deps.invalidate(key); throw error instanceof IsolationAdmissionError ? error : new IsolationAdmissionError(undefined,
      error instanceof Error && error.message.startsWith('UNSUPPORTED') ? 'UNSUPPORTED' : 'ERROR'); }
    if (sessionId && !canResumeIsolated(this.deps.store.getProvenance(binding.expected.bot, sessionId), binding.expected)) {
      throw new IsolationAdmissionError('该会话不属于当前隔离范围或已被撤销，无法恢复');
    }
  }
  private async checkBinding(binding: Binding, env: Record<string, string>, binary: AgentBinary, force = false): Promise<void> {
    assertIsolationSearchPath(env, binding.policy);
    if (!this.deps.runCheck) return;
    const bot = binding.expected.bot;
    const state = this.deps.verification.state(bot, binding.policy.scopeKey, binding.policy.fingerprint, binary);
    if (!force && state !== 'UNVERIFIED' && state !== 'STALE') return;
    const id = `${bot}:${binding.policy.scopeKey}:${binding.policy.fingerprint}`;
    const existing = this.checking.get(id);
    if (existing) return existing;
    const pending = (async () => {
      let record: VerificationRecord;
      try {
        record = await this.deps.runCheck!({ bot, agent: this.deps.config.bots[bot].agent, policy: binding.policy, binary,
          opts: binding.opts, env, paths: this.deps.paths, config: this.deps.config });
      } catch {
        record = { bot, scopeKey: binding.policy.scopeKey, policyFingerprint: binding.policy.fingerprint, agentBinary: binary,
          status: 'ERROR', checks: [{ name: 'check.execution', status: 'ERROR' }], checkedAt: new Date().toISOString() };
      }
      this.deps.verification.put(record);
    })();
    this.checking.set(id, pending);
    try { await pending; } finally { this.checking.delete(id); }
  }
  async check(key: SessionKey, force = true): Promise<VerificationRecord | undefined> {
    const binding = this.bindings.get(key);
    if (!binding) return;
    const bot = this.deps.config.bots[binding.expected.bot];
    const env = isolationEnvironment(buildChildEnv(bot.agent as ChildProvider, binding.opts.env, this.deps.inheritedEnv ?? process.env), binding.policy);
    try { assertIsolationSearchPath(env, binding.policy); }
    catch (error) { throw this.revokePreparation(binding.expected.bot, error); }
    assertNoProviderCredentials(env);
    const binary = identifyBinary(this.deps.config.agents[bot.agent].binary, env.PATH);
    await this.checkBinding(binding, env, binary, force);
    return this.deps.verification.get(binding.expected.bot, binding.policy.scopeKey);
  }
  /** A standalone doctor publishes through the same store; revoke daemon children on its failures too. */
  monitor(intervalMs = 500): () => void {
    if (!Object.values(this.deps.config.bots).some(bot => bot.isolation?.enabled)) return () => {};
    const observed = new Map<string, string>();
    const timer = setInterval(() => {
      const failed = new Set<string>();
      for (const [key, binding] of this.bindings) {
        try {
          const record = this.deps.verification.preparationFailure(binding.expected.bot)
            ?? this.deps.verification.get(binding.expected.bot, binding.policy.scopeKey);
          const signature = record ? `${record.checkedAt}:${record.status}:${record.policyFingerprint}` : 'missing';
          if (observed.get(key) === signature) continue;
          observed.set(key, signature);
          if (!record || record.status !== 'VERIFIED') failed.add(binding.expected.bot);
          else if (record.policyFingerprint !== binding.policy.fingerprint) this.deps.invalidate(key);
        } catch { failed.add(binding.expected.bot); }
      }
      for (const [key, binding] of this.bindings) if (failed.has(binding.expected.bot)) this.deps.invalidate(key);
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
  async canResume(key: SessionKey, sessionId: string): Promise<boolean> {
    const binding = this.bindings.get(key);
    if (!binding) return false;
    const expected = { ...binding.expected, memoryGeneration: await this.deps.memory.generation(binding.expected.principal) };
    return canResumeIsolated(this.deps.store.getProvenance(expected.bot, sessionId), expected);
  }
  async guardStart(key: SessionKey, opts: SpawnOpts, sessionId?: string): Promise<void> {
    if (!this.deps.config.bots[key.split(':')[2]]?.isolation?.enabled) return;
    await this.assert(key, sessionId);
    const binding = this.bindings.get(key)!;
    if (opts.isolation !== binding.policy || canonicalPolicyWorkspace(opts.workingDirectory) !== binding.expected.scope) throw new IsolationAdmissionError();
    try { await (this.deps.prepareTmp ?? prepareTemporaryDirectory)(binding.policy); }
    catch { this.deps.invalidate(key); throw new IsolationAdmissionError(); }
    await this.assert(key, sessionId);
  }
  captureRecorder(key: SessionKey): (id: string) => void {
    const expected = this.bindings.get(key)?.expected;
    return id => { if (expected) this.deps.store.putProvenance({ ...expected, agentSessionId: id }); };
  }
  async listDomain(expected: Omit<ProvenanceContext, 'memoryGeneration'>) {
    const current = { ...expected, memoryGeneration: await this.deps.memory.generation(expected.principal) };
    return this.deps.store.listProvenance(expected.bot).filter(r => canResumeIsolated(r, current));
  }
}
