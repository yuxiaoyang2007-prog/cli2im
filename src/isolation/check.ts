import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentPlugin, AgentProcess, AppConfig, SpawnOpts } from '../types.js';
import type { IsolationPolicy, PolicyPaths } from './policy.js';
import { assertIsolationSearchPath, stableJSON } from './policy.js';
import { identifyBinary, type AgentBinary, type VerificationRecord } from './verification.js';
import { ClaudeCodePlugin } from '../agents/claude-code.js';
import { CodexPlugin } from '../agents/codex.js';
import { prepareTemporaryDirectory } from './sbx-read.js';
import { createCheckOptions } from './check-options.js';
import { createProbePlan, type ProbePlan } from './probe.js';
import { startMockModel, type MockModel } from './mock-model.js';
import { aggregateChecks, globalInstructionEvidence, scanSessionResidue, type EvidenceCheck } from './check-evidence.js';
import { createNativeChecks, shellCall, toolDefinitions } from './native-check.js';
import { checkBridge, BRIDGE_CHECKS } from './check-bridge.js';
import { codexConfigSources, isolationEnvironment, prepareCodexHome } from './codex.js';

export interface IsolationCheckInput {
  bot: string; agent: string; policy: IsolationPolicy; binary: AgentBinary;
  opts: SpawnOpts; env: Record<string, string>; paths: PolicyPaths; config: AppConfig;
}
export interface CheckDependencies {
  timeoutMs?: number;
  plugin?: AgentPlugin;
  prepareTmp?: typeof prepareTemporaryDirectory;
  probe?: typeof createProbePlan;
  bridge?: typeof checkBridge;
  instructions?: typeof globalInstructionEvidence;
  residue?: typeof scanSessionResidue;
}
const LIFECYCLE_CHECKS = ['agent.supported', 'agent.exit-timeout', 'check.execution', 'check.timeout', 'model.close', 'native.cleanup', 'probe.cleanup', 'bridge.cleanup'];
const BASE_CHECKS = ['agent.completed', 'model.roundtrip', 'capabilities', 'global-instructions', 'session-residue', 'binary.stable'];
function textOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map(item => item && typeof item === 'object' && 'text' in item ? String(item.text) : '').join('\n');
  return '';
}

export function forbiddenCodexCapability(name: string): boolean {
  return /(^|[._])mcp([._]|$)/i.test(name)
    || name.split('.').some(part => /^multi_agent/i.test(part)
      || /^(?:get|create|update)_goal$/i.test(part)
      || /^(?:spawn|send|wait|resume|close)[_-]?(?:input|message|agent|agents)(?:_|$)/i.test(part)
      || ['wait', 'send_input'].includes(part));
}

/** Executes the exact production plugin, binding its evidence to the production fingerprint. */
export async function runIsolationCheck(input: IsolationCheckInput, deps: CheckDependencies = {}): Promise<VerificationRecord> {
  try { assertIsolationSearchPath(input.env, input.policy); }
  catch {
    return { bot: input.bot, scopeKey: input.policy.scopeKey, policyFingerprint: input.policy.fingerprint,
      agentBinary: input.binary, status: 'UNSUPPORTED', checks: [{ name: 'environment.path', status: 'UNSUPPORTED' }],
      checkedAt: new Date().toISOString() };
  }
  const checks: EvidenceCheck[] = [];
  const expected = [...BASE_CHECKS, ...BRIDGE_CHECKS, ...LIFECYCLE_CHECKS];
  const ids = new Set<string>();
  let agent: AgentProcess | undefined;
  let model: MockModel | undefined;
  let probe: ProbePlan | undefined;
  let native: Awaited<ReturnType<typeof createNativeChecks>> | undefined;
  let checkOverrides: VerificationRecord['checkOverrides'];
  let observedTools: string[] = [];
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let exited: Promise<void> | undefined;
  const waitForExit = async () => {
    if (!exited) return;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([exited, new Promise<void>(resolve => { exitTimer = setTimeout(() => {
        checks.push({ name: 'agent.exit-timeout', status: 'ERROR' }); resolve();
      }, 2000); })]);
    } finally { clearTimeout(exitTimer); }
  };
  const stop = () => { stopped = true; agent?.kill('SIGKILL'); };
  const work = async () => {
    if (input.policy.binaryPath !== input.binary.realpath) throw new Error('Isolation executable binding mismatch');
    if (!['claude-code', 'codex'].includes(input.agent)) { checks.push({ name: 'agent.supported', status: 'UNSUPPORTED' }); return; }
    input = { ...input, env: isolationEnvironment(input.env, input.policy) };
    if (input.policy.codexHome) prepareCodexHome(input.policy.codexHome);
    await (deps.prepareTmp ?? prepareTemporaryDirectory)(input.policy);
    if (stopped) return;
    probe = await (deps.probe ?? createProbePlan)({ policy: input.policy, paths: input.paths, config: input.config, agent: input.agent, env: input.env });
    expected.push(...probe.expectedNames);
    if (stopped) { probe.cleanup(); return; }
    const placeholder = `cli2im-check-${randomUUID()}`;
    model = await startMockModel({ apiKey: placeholder, protocol: input.agent === 'claude-code' ? 'anthropic' : 'responses', script: async request => {
      if (stopped) throw new Error('Check stopped');
      if (input.agent === 'claude-code') return [{ name: 'Bash', input: { command: probe!.command, timeout: 60000 } }];
      native = await createNativeChecks(request, { policy: input.policy, canaryPath: probe!.canaries[0].path,
        readonlyTarget: input.policy.inbox, nonce: randomUUID() });
      expected.push(...native.names);
      return [shellCall(request, probe!.command, input.opts.workingDirectory), ...native.calls.map(call => ({ ...call,
        beforeCall: async () => {
          const positive = probe!.parse(textOutput(model!.results[0]?.output)).filter(c => c.name.startsWith('positive.'));
          if (!positive.length || positive.some(c => c.status !== 'PASS')) throw new Error('Positive control failed');
          await call.beforeCall?.();
        },
      }))];
    } });
    if (stopped) { await model.close(); return; }
    const prepared = createCheckOptions(input.agent, { ...input.opts, isolation: input.policy }, input.env, model.url, placeholder);
    checkOverrides = prepared.checkOverrides;
    const plugin = deps.plugin ?? (input.agent === 'claude-code' ? new ClaudeCodePlugin(input.binary.realpath) : new CodexPlugin(input.binary.realpath));
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (success: boolean) => {
        if (done) return; done = true;
        checks.push({ name: 'agent.completed', status: success ? 'PASS' : 'ERROR' });
        resolve();
      };
      try {
        agent = plugin.spawn(prepared.opts);
        exited = new Promise(resolve => agent!.on('exit', () => resolve()));
        const parser = plugin.createStdoutParser();
        parser.on('data', (event: AgentEvent) => {
          if (event.type === 'status' && event.sessionId) ids.add(event.sessionId);
          if (event.type === 'result') { if (event.sessionId) ids.add(event.sessionId); finish(true); }
          if (event.type === 'error') finish(false);
          // The production permission mode is unchanged. Only the scripted shell request is approved.
          if (event.type === 'permission_request') {
            const command = event.input.command ?? event.input.cmd;
            const allow = ['Bash', 'shell', 'shell_command', 'exec_command'].includes(event.tool) &&
              (command === probe!.command || (Array.isArray(command) && command.includes(probe!.command)));
            agent!.stdin.write(plugin.formatPermissionResponse(event.id, allow ? 'allow' : 'deny'));
          }
        });
        parser.on('error', () => finish(false));
        agent.on('error', () => finish(false));
        agent.on('exit', () => finish(false));
        agent.stdout.pipe(parser);
        agent.stdin.on('error', () => finish(false));
        agent.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'Run the local isolation diagnostic sequence.' }), error => { if (error) finish(false); });
        controller.signal.addEventListener('abort', () => finish(false), { once: true });
      } catch { reject(new Error('Agent start failed')); }
    });
    stop();
    await waitForExit();
    if (timedOut) return;
    checks.push({ name: 'model.roundtrip', status: model.completed ? 'PASS' : 'ERROR' });
    if (probe) checks.push(...probe.parse(textOutput(model.results[0]?.output)));
    if (native) checks.push(...native.evaluate(model.results.slice(1)));
    const tools = model.requests.filter(request => Array.isArray(request.tools) && request.tools.length > 0).map(request => toolDefinitions(request).map(t => t.name).sort());
    observedTools = [...new Set(tools.flat())];
    const capabilityPass = tools.length > 0 && tools.every(names => input.agent === 'claude-code'
      ? stableJSON(names) === stableJSON([...input.policy.tools].sort())
      : names.length > 0 && stableJSON(names) === stableJSON(tools[0]) && !names.some(forbiddenCodexCapability));
    checks.push({ name: 'capabilities', status: capabilityPass ? 'PASS' : 'UNSUPPORTED' });
    if (input.agent === 'codex') {
      const sources = codexConfigSources(input.policy.workspace, input.env, input.paths.codexSystemConfigs);
      const configChecks: EvidenceCheck[] = [{ name: 'config.project-absent', status: 'PASS' }, ...sources.map((source, i): EvidenceCheck =>
        ({ name: `config.trusted.${i}.${source.exists ? 'present' : 'absent'}`, status: 'PASS' }))];
      expected.push(...configChecks.map(c => c.name)); checks.push(...configChecks);
    }
    checks.push(await (deps.instructions ?? globalInstructionEvidence)(input.agent as 'claude-code' | 'codex', input.env, model.requests));
    if (timedOut) return;
    checks.push(await (deps.residue ?? scanSessionResidue)(input.agent as 'claude-code' | 'codex', input.env, [...ids]));
    if (timedOut) return;
    checks.push(...await (deps.bridge ?? checkBridge)(input.policy, probe.canaries[0].path, controller.signal));
    checks.push({ name: 'binary.stable', status: stableJSON(identifyBinary(input.binary.realpath)) === stableJSON(input.binary) ? 'PASS' : 'ERROR' });
  };
  const pending = work();
  try {
    await Promise.race([pending, new Promise<void>(resolve => {
      timer = setTimeout(() => { timedOut = true; controller.abort(); stop(); resolve(); }, deps.timeoutMs ?? 90_000);
    })]);
  } catch { checks.push({ name: 'check.execution', status: 'ERROR' }); }
  finally {
    clearTimeout(timer); stop(); controller.abort();
    if (timedOut) await waitForExit();
    if (timedOut) checks.push({ name: 'check.timeout', status: 'ERROR' });
    // Stop the local API before cleanup; no later tool request can mutate fixtures.
    await model?.close().catch(() => { checks.push({ name: 'model.close', status: 'ERROR' }); });
    await native?.cleanup().catch(() => { checks.push({ name: 'native.cleanup', status: 'ERROR' }); });
    try { probe?.cleanup(); } catch { checks.push({ name: 'probe.cleanup', status: 'ERROR' }); }
    // Late failures are absorbed; stopped checks can never publish a new record.
    void pending.catch(() => {});
  }
  for (const name of LIFECYCLE_CHECKS) if (!checks.some(check => check.name === name)) checks.push({ name, status: 'PASS' });
  // Link exceptions are usable only with demonstrated semantics on this host.
  for (const check of checks) if (/^(positive|negative)\.link\./.test(check.name) && check.status !== 'PASS' && check.status !== 'LEAK') check.status = 'UNSUPPORTED';
  const summary = aggregateChecks(expected, checks);
  return { bot: input.bot, scopeKey: input.policy.scopeKey, policyFingerprint: input.policy.fingerprint, agentBinary: input.binary,
    status: summary.status, checks: summary.checks, observedTools, checkedAt: new Date().toISOString(), ...(checkOverrides ? { checkOverrides } : {}) };
}
