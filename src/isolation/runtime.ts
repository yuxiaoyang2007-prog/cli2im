import { sdkIdentity } from './sdk-identity.js';
import { prepareTemporaryDirectory } from './sbx-read.js';
import type { AppConfig, SessionKey, SpawnOpts } from '../types.js';
import type { SessionStore } from '../session/store.js';
import type { MemoryStore } from '../memory/store.js';
import { buildChildEnv, type ChildProvider } from '../security/child-env.js';
import { buildIsolationPolicy, scopeTmpdir, contains, type PolicyPaths, type IsolationPolicy, type IsolationProductionParameters } from './policy.js';
import { canonicalPath as canonicalPolicyWorkspace } from '../runtime/execution-scope.js';
import { assertIsolationAdmission, assertNoProviderCredentials, IsolationAdmissionError } from './admission.js';
import { identifyBinary, type VerificationStore } from './verification.js';
import { canResumeIsolated, type ProvenanceContext } from './provenance.js';

function productionParameters(opts: SpawnOpts, env: Record<string, string>): IsolationProductionParameters {
  return { sandboxMode: opts.sandboxMode, permissionMode: opts.permissionMode, autoApprove: opts.autoApprove,
    addDirs: opts.addDirs, sandbox: opts.sandbox, sandboxBoxRoots: opts.sandboxBoxRoots,
    sandboxOtherProtectedRoots: opts.sandboxOtherProtectedRoots,
    // Values can contain credentials or per-message identity. Presentation/model keys do not set boundaries.
    envKeys: Object.keys(env).filter(key => !key.startsWith('CTI_SENDER_')
      && !/^(?:ANTHROPIC_MODEL|LANG|LC_.*|TZ|TERM|COLORTERM|NO_COLOR|FORCE_COLOR|USER|LOGNAME)$/.test(key)).sort() };
}
type Binding = { policy: IsolationPolicy; expected: ProvenanceContext; opts: SpawnOpts; input: Parameters<typeof buildIsolationPolicy>[0] };
/** One admission boundary shared by starts, resumes, live messages and explicit restoration. */
export class IsolationRuntime {
  private bindings = new Map<SessionKey, Binding>();
  constructor(private deps: {
    config: AppConfig; paths: PolicyPaths; verification: VerificationStore; store: SessionStore; memory: MemoryStore;
    invalidate: (key: SessionKey) => void; replaceProcess?: (key: SessionKey) => void;
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
  async prepare(key: SessionKey, principal: string, scopeKey: string, opts: SpawnOpts, identityMapping: unknown, requireVerified = true, inspectOnly = false): Promise<IsolationPolicy> {
    try {
      const botName = key.split(':')[2];
      const bot = this.deps.config.bots[botName];
      const tmpdir = scopeTmpdir(bot.agent, canonicalPolicyWorkspace(scopeKey), this.deps.paths);
      opts.env = { ...opts.env, ...(bot.agent === 'claude-code' ? { CLAUDE_CODE_TMPDIR: tmpdir } : { TMPDIR: tmpdir }) };
      const env = buildChildEnv(bot.agent as ChildProvider, opts.env, this.deps.inheritedEnv ?? process.env);
      assertNoProviderCredentials(env);
      const binary = identifyBinary(this.deps.config.agents[bot.agent]?.binary ?? '', env.PATH);
      const input: Parameters<typeof buildIsolationPolicy>[0] = { config: this.deps.config, botName, workspace: scopeKey, paths: this.deps.paths,
        binaryPath: binary.realpath, identityMapping, sdkVersions: this.deps.sdkVersions ?? sdkIdentity(bot.agent),
        // Production launch values only: no prompt, session ID, ephemeral probe flags or credential values.
        production: productionParameters(opts, env) };
      const policy = buildIsolationPolicy(input);
      if (!contains(policy.workspace, canonicalPolicyWorkspace(opts.workingDirectory))) throw new IsolationAdmissionError();
      const expected = { bot: botName, principal, scope: canonicalPolicyWorkspace(opts.workingDirectory), policyFingerprint: policy.fingerprint,
        memoryGeneration: await this.deps.memory.generation(principal) };
      if (inspectOnly) return policy;
      const previous = this.bindings.get(key);
      if (previous && !canResumeIsolated({ ...previous.expected, agentSessionId: '' }, expected)) this.deps.replaceProcess?.(key);
      this.bindings.set(key, { policy, expected, opts, input });
      if (requireVerified) await this.assert(key);
      return policy;
    } catch (error) {
      if (!inspectOnly) this.deps.invalidate(key);
      throw error instanceof IsolationAdmissionError ? error : new IsolationAdmissionError();
    }
  }
  async assert(key: SessionKey, sessionId?: string): Promise<void> {
    if (!this.deps.config.bots[key.split(':')[2]]?.isolation?.enabled) return;
    const binding = this.bindings.get(key);
    if (!binding) throw new IsolationAdmissionError();
    try {
      const bot = this.deps.config.bots[binding.expected.bot];
      const env = buildChildEnv(bot.agent as ChildProvider, binding.opts.env, this.deps.inheritedEnv ?? process.env);
      assertNoProviderCredentials(env);
      const binary = identifyBinary(this.deps.config.agents[bot.agent].binary, env.PATH);
      const currentPolicy = buildIsolationPolicy({ ...binding.input, binaryPath: binary.realpath,
        production: productionParameters(binding.opts, env), sdkVersions: this.deps.sdkVersions ?? sdkIdentity(bot.agent) });
      if (currentPolicy.fingerprint !== binding.policy.fingerprint) throw new IsolationAdmissionError();
      const generation = await this.deps.memory.generation(binding.expected.principal);
      // A revocation between preparation and process creation invalidates the preparation itself.
      if (generation !== binding.expected.memoryGeneration) throw new IsolationAdmissionError();
      assertIsolationAdmission({ verification: this.deps.verification, policy: binding.policy, binary,
        expected: binding.expected, env });
    } catch (error) { this.deps.invalidate(key); throw error instanceof IsolationAdmissionError ? error : new IsolationAdmissionError(); }
    if (sessionId && !canResumeIsolated(this.deps.store.getProvenance(binding.expected.bot, sessionId), binding.expected)) {
      throw new IsolationAdmissionError('该会话不属于当前隔离范围或已被撤销，无法恢复');
    }
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
