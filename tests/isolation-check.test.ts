import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough, Transform, Writable } from 'node:stream';
import { isolationFixture } from './helpers/isolation.js';
import { forbiddenCodexCapability, runIsolationCheck, type CheckDependencies, type IsolationCheckInput } from '../src/isolation/check.js';
import { agentChildEnv, codexCheckArgs } from '../src/isolation/check-options.js';
import { BRIDGE_CHECKS } from '../src/isolation/check-bridge.js';
import { identifyBinary } from '../src/isolation/verification.js';
import { scanSessionResidue } from '../src/isolation/check-evidence.js';
import type { AgentPlugin, AgentProcess, SpawnOpts } from '../src/types.js';
import { ClaudeCodePlugin } from '../src/agents/claude-code.js';
import type { query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

describe('slice 9 automatic isolation check controller', () => {
  let f: ReturnType<typeof isolationFixture>;
  const id = '12345678-1234-4321-a123-123456789abc';
  const cleanups: Array<() => void> = [];
  beforeEach(() => { f = isolationFixture(); f.bot.agent = 'claude-code'; });
  afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); rmSync(f.root, { recursive: true, force: true }); });
  const input = (): IsolationCheckInput => ({ bot: 'bot', agent: 'claude-code', policy: f.policy(), binary: identifyBinary('/bin/cat'),
    opts: { workingDirectory: f.workspace, permissionMode: 'blacklist', env: { HOME: f.paths.home }, model: 'fixture-model' },
    env: { HOME: f.paths.home, PATH: '/usr/bin:/bin' }, paths: f.paths, config: f.config });
  it.each(['claude-code', 'codex'])('reports unsafe check PATH as UNSUPPORTED before any fixture or process is prepared: %s', async agent => {
    f.bot.agent = agent;
    const original = { ...input(), agent };
    const prepareTmp = vi.fn();
    for (const PATH of ['bin:/usr/bin', '', ':/usr/bin', '/usr/bin:', '.', `${f.workspace}/bin:/usr/bin`]) {
      const record = await runIsolationCheck({ ...original, env: { ...original.env, PATH } }, { prepareTmp });
      expect(record.status).toBe('UNSUPPORTED');
      expect(record.checks).toContainEqual({ name: 'environment.path', status: 'UNSUPPORTED' });
    }
    expect(prepareTmp).not.toHaveBeenCalled();
  });
  const post = (url: string, payload: unknown, apiKey: string): Promise<string> => new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey } }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.on('error', reject); response.on('end', () => response.statusCode === 200 ? resolve(body) : reject(new Error('Fixture model rejected request')));
    });
    req.on('error', reject); req.end(JSON.stringify(payload));
  });
  function scriptedPlugin(mode: 'roundtrip' | 'no-request' | 'timeout' | 'wrong-tool' | 'auxiliary' | 'auxiliary-only' = 'roundtrip', emitExit = true) {
    let started: SpawnOpts | undefined;
    const killed = vi.fn();
    const posts: unknown[] = [];
    const spawn = (opts: SpawnOpts): AgentProcess => {
      started = opts;
      const stdout = new PassThrough({ objectMode: true });
      const events = new EventEmitter();
      let active = true;
      const run = async () => {
        if (mode === 'timeout') return;
        if (mode !== 'no-request') {
          const env = agentChildEnv('claude-code', opts);
          const url = `${env.ANTHROPIC_BASE_URL}/v1/messages`;
          const tools = (mode === 'wrong-tool' ? [...opts.isolation!.tools, 'Read'] : opts.isolation!.tools).map(name => ({ name, input_schema: { type: 'object' } }));
          const payload = { model: opts.model, stream: true, system: 'Synthetic test instructions', tools, messages: [{ role: 'user', content: 'fixture' }] };
          if (mode === 'auxiliary' || mode === 'auxiliary-only') {
            await post(url, { ...payload, tools: [] }, env.ANTHROPIC_API_KEY);
            if (mode === 'auxiliary-only') { stdout.write({ type: 'result', sessionId: id }); return; }
          }
          posts.push(payload);
          const first = await post(url, payload, env.ANTHROPIC_API_KEY);
          const blocks = first.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
          const tool = blocks.find(value => value.type === 'content_block_start').content_block;
          const command = JSON.parse(blocks.find(value => value.type === 'content_block_delta').delta.partial_json).command;
          if (command !== 'fixture-probe-command') throw new Error('Unexpected scripted tool command');
          const reply = { ...payload, messages: [...payload.messages, { role: 'assistant', content: [{ ...tool, input: { command } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, content: 'fixture-structured-probe-result' }] }] };
          posts.push(reply); await post(url, reply, env.ANTHROPIC_API_KEY);
        }
        if (active) stdout.write({ type: 'result', sessionId: id });
      };
      const stdin = new Writable({ write(_chunk, _encoding, done) { done(); void run().catch(() => { if (active) stdout.write({ type: 'error', message: 'fixture agent error' }); }); } });
      const kill = () => { killed(); if (active) { active = false; stdout.end(); if (emitExit) events.emit('exit', null); } };
      cleanups.push(kill);
      return Object.assign(events, { pid: 1, sessionId: id, stdin, stdout, kill }) as AgentProcess;
    };
    const plugin = { name: 'claude-code', displayName: 'scripted local transport', capabilities: { streamJson: true, sessionResume: true, permissionPrompt: true, gracefulCancel: true, slashCommands: [] },
      spawn, resume: (_id: string, opts: SpawnOpts) => spawn(opts), buildSpawnArgs: () => [], preflight: async () => ({ ok: true }),
      createStdoutParser: () => new Transform({ objectMode: true, transform(chunk, _encoding, done) { done(null, chunk); } }),
      formatStdinMessage: () => 'fixture', formatPermissionResponse: () => 'fixture-permission' } satisfies AgentPlugin;
    return { plugin, killed, posts, started: () => started };
  }
  function dependencies(plugin: AgentPlugin): CheckDependencies {
    return { plugin, timeoutMs: 2000, prepareTmp: async () => {},
      probe: async () => ({ command: 'fixture-probe-command', expectedNames: ['positive.workspace'], marker: 'fixture',
        canaries: [{ name: 'fixture-canary', path: join(f.root, 'outside/canary') }], readonlyTargets: [join(f.root, 'reference')], symlinkPath: join(f.workspace, 'link'),
        parse: output => [{ name: 'positive.workspace', status: output === 'fixture-structured-probe-result' ? 'PASS' : 'ERROR' }], cleanup: vi.fn() }),
      bridge: async () => BRIDGE_CHECKS.map(name => ({ name, status: 'PASS' })),
      instructions: async (_agent, _env, requests) => ({ name: 'global-instructions', status: requests.length ? 'PASS' : 'ERROR' }),
      residue: async (_agent, _env, ids) => ({ name: 'session-residue', status: ids.includes(id) ? 'PASS' : 'ERROR' }),
    };
  }
  function scriptedCodexPlugin(changeTools = false, forbidden?: string): AgentPlugin {
    const spawn = (opts: SpawnOpts): AgentProcess => {
      const stdout = new PassThrough({ objectMode: true }); const events = new EventEmitter();
      let active = true;
      const run = async () => {
        const env = agentChildEnv('codex', opts);
        const provider = codexCheckArgs(opts).find(arg => arg.startsWith('model_providers.'))!;
        const bearer = JSON.parse(provider.match(/"experimental_bearer_token"=("(?:[^"\\]|\\.)*")/)![1]);
        expect(env.OPENAI_API_KEY).toBeUndefined();
        const baseURL = JSON.parse(provider.match(/"base_url"=("(?:[^"\\]|\\.)*")/)![1]);
        const url = `${baseURL}/responses`;
        const tools = [{ type: 'function', name: 'exec_command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }];
        const payload = { model: opts.model, stream: true, instructions: 'Synthetic test instructions', tools,
          input: [{ role: 'user', content: 'fixture' }] };
        const first = await post(url, payload, bearer);
        const blocks = first.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
        const call = blocks.find(value => value.type === 'response.output_item.done').item;
        if (call.type !== 'function_call' || call.name !== 'exec_command' || JSON.parse(call.arguments).cmd !== 'fixture-probe-command') {
          throw new Error('Unexpected scripted Codex tool command');
        }
        const reply = { ...payload, tools: forbidden ? [...tools, { type: 'namespace', name: 'functions', tools: [{ type: 'function', name: forbidden }] }] : changeTools ? [...tools, { type: 'function', name: 'apply_patch', parameters: { type: 'object' } }] : tools,
          input: [...payload.input, call, { type: 'function_call_output', call_id: call.call_id, output: 'fixture-structured-probe-result' }] };
        const last = await post(url, reply, bearer);
        if (!last.includes('response.completed')) throw new Error('Missing final Responses event');
        if (active) stdout.write({ type: 'result', sessionId: id });
      };
      const stdin = new Writable({ write(_chunk, _encoding, done) { done(); void run().catch(() => {
        if (active) stdout.write({ type: 'error', message: 'fixture Codex agent error' });
      }); } });
      const kill = () => { if (active) { active = false; stdout.end(); events.emit('exit', null); } };
      cleanups.push(kill);
      return Object.assign(events, { pid: 1, sessionId: id, stdin, stdout, kill }) as AgentProcess;
    };
    return { name: 'codex', displayName: 'scripted local Responses transport',
      capabilities: { streamJson: true, sessionResume: true, permissionPrompt: true, gracefulCancel: true, slashCommands: [] },
      spawn, resume: (_id, opts) => spawn(opts), buildSpawnArgs: codexCheckArgs, preflight: async () => ({ ok: true }),
      createStdoutParser: () => new Transform({ objectMode: true, transform(chunk, _encoding, done) { done(null, chunk); } }),
      formatStdinMessage: () => 'fixture', formatPermissionResponse: () => 'fixture-permission' };
  }
  it('integration: local HTTP tool roundtrip produces evidence bound to the exact production fingerprint', async () => {
    const fake = scriptedPlugin(); const production = input(); const before = JSON.stringify(production);
    const record = await runIsolationCheck(production, dependencies(fake.plugin));
    expect(record.status).toBe('VERIFIED');
    expect(record.checks.every(item => item.status === 'PASS')).toBe(true);
    expect(record.policyFingerprint).toBe(production.policy.fingerprint);
    expect(record.agentBinary).toEqual(production.binary);
    expect(record.checkOverrides).toMatchObject({ persistence: { persistSession: false }, modelAccess: { credential: 'placeholder' } });
    expect(JSON.stringify(production)).toBe(before);
    expect(fake.posts).toHaveLength(2);
    expect(fake.started()!.isolation).toBe(production.policy);
    expect(fake.started()!.permissionMode).toBe('blacklist');
    expect(fake.killed).toHaveBeenCalled();
    expect(JSON.stringify(record)).not.toContain('fixture-structured-probe-result');
    expect(JSON.stringify(record)).not.toContain('Synthetic test instructions');
  });
  it('rejects a policy executable that differs from the verification binding before fixture preparation', async () => {
    const production = input(); production.policy.binaryPath = '/fixture/unverified-cli';
    const prepareTmp = vi.fn(); const probe = vi.fn();
    const record = await runIsolationCheck(production, { prepareTmp, probe });
    expect(record.status).toBe('ERROR');
    expect(prepareTmp).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
  });
  it('agent completion without a model request or executed probe is ERROR', async () => {
    const fake = scriptedPlugin('no-request');
    const record = await runIsolationCheck(input(), dependencies(fake.plugin));
    expect(record.status).toBe('ERROR');
    expect(record.checks).toEqual(expect.arrayContaining([{ name: 'model.roundtrip', status: 'ERROR' }, { name: 'positive.workspace', status: 'ERROR' }]));
  });
  it('completes the check with production autoApprove=false and a synchronous permission response', async () => {
    const production = input();
    production.opts.autoApprove = false;
    const permissionResults: unknown[] = [];
    const queryFn = vi.fn(({ options }: Parameters<typeof query>[0]) => (async function* () {
      const env = options!.env!;
      const url = `${env.ANTHROPIC_BASE_URL}/v1/messages`;
      const payload = { model: production.opts.model, stream: true, system: 'Synthetic test instructions',
        tools: production.policy.tools.map(name => ({ name, input_schema: { type: 'object' } })),
        messages: [{ role: 'user', content: 'fixture' }] };
      const first = await post(url, payload, env.ANTHROPIC_API_KEY!);
      const blocks = first.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
      const tool = blocks.find(value => value.type === 'content_block_start').content_block;
      const toolInput = JSON.parse(blocks.find(value => value.type === 'content_block_delta').delta.partial_json);
      expect(toolInput).toMatchObject({ command: 'fixture-probe-command' });
      const result = await options!.canUseTool!(tool.name, toolInput, { toolUseID: tool.id, signal: options!.abortController!.signal });
      permissionResults.push(result);
      expect(result).toEqual({ behavior: 'allow' });
      await post(url, { ...payload, messages: [...payload.messages,
        { role: 'assistant', content: [{ ...tool, input: toolInput }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, content: 'fixture-structured-probe-result' }] },
      ] }, env.ANTHROPIC_API_KEY!);
      yield { type: 'result', subtype: 'success', session_id: id, usage: { input_tokens: 1, output_tokens: 1 } } as SDKMessage;
    })());
    // Inject only the SDK transport; use the real plugin, streams and permission registry.
    const plugin = new ClaudeCodePlugin('/bin/cat', queryFn as unknown as typeof query);
    const errors: string[] = [];
    const originalSpawn = plugin.spawn.bind(plugin);
    const spawn = vi.spyOn(plugin, 'spawn').mockImplementation(opts => {
      const proc = originalSpawn(opts);
      proc.stdout.on('data', event => { if (event.type === 'error') errors.push(event.message); });
      return proc;
    });
    const response = vi.spyOn(plugin, 'formatPermissionResponse');
    const record = await runIsolationCheck(production, dependencies(plugin));
    expect(errors).toEqual([]);
    expect(record.status).toBe('VERIFIED');
    expect(record.checks.every(item => item.status === 'PASS')).toBe(true);
    expect(record.policyFingerprint).toBe(production.policy.fingerprint);
    expect(spawn.mock.calls[0][0]).toMatchObject({ permissionMode: 'blacklist', autoApprove: false });
    expect(queryFn.mock.calls[0][0].options!.permissionMode).toBe('default');
    expect(response).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'allow');
    expect(permissionResults).toEqual([{ behavior: 'allow' }]);
    expect(production.opts.autoApprove).toBe(false);
  });
  it('integration: Codex Responses roundtrip registers configuration evidence and actual tools against the production fingerprint', async () => {
    f.bot.agent = 'codex';
    const system = join(f.root, 'synthetic-system.toml'); writeFileSync(system, '# synthetic trusted source');
    f.paths.codexSystemConfigs = [system, join(f.root, 'synthetic-absent.toml')];
    const production = { ...input(), agent: 'codex' };
    const record = await runIsolationCheck(production, dependencies(scriptedCodexPlugin()));
    expect(record.status).toBe('VERIFIED');
    expect(record.policyFingerprint).toBe(production.policy.fingerprint);
    expect(record.observedTools).toEqual(['exec_command']);
    expect(record.checkOverrides).toMatchObject({ persistence: { ephemeral: true } });
    expect(record.checks).toEqual(expect.arrayContaining([
      { name: 'model.roundtrip', status: 'PASS' }, { name: 'positive.workspace', status: 'PASS' },
      { name: 'config.project-absent', status: 'PASS' },
      { name: 'config.trusted.0.present', status: 'PASS' }, { name: 'config.trusted.1.absent', status: 'PASS' },
    ]));
    expect(record.checks.every(item => item.status === 'PASS')).toBe(true);
  });
  it('integration: a later Codex request adding an untested native tool is UNSUPPORTED', async () => {
    f.bot.agent = 'codex';
    const record = await runIsolationCheck({ ...input(), agent: 'codex' }, dependencies(scriptedCodexPlugin(true)));
    expect(record.status).toBe('UNSUPPORTED');
    expect(record.checks).toContainEqual({ name: 'model.roundtrip', status: 'PASS' });
    expect(record.checks).toContainEqual({ name: 'capabilities', status: 'UNSUPPORTED' });
    expect(record.observedTools).toEqual(expect.arrayContaining(['exec_command', 'apply_patch']));
  });
  it.each(['multi_agent_v1', 'spawn_agent', 'send_input', 'wait_agent', 'resume_agent', 'close_agent', 'get_goal', 'create_goal', 'update_goal'])('rejects disabled Codex capability %s in a later namespaced request', async capability => {
    f.bot.agent = 'codex';
    expect(forbiddenCodexCapability(`functions.${capability}`)).toBe(true);
    const record = await runIsolationCheck({ ...input(), agent: 'codex' }, dependencies(scriptedCodexPlugin(false, capability)));
    expect(record.status).toBe('UNSUPPORTED');
    expect(record.checks).toContainEqual({ name: 'capabilities', status: 'UNSUPPORTED' });
  });
  it.each(['auxiliary', 'auxiliary-only'] as const)('requires at least one main tool request after %s requests', async mode => {
    const fake = scriptedPlugin(mode);
    const record = await runIsolationCheck(input(), dependencies(fake.plugin));
    expect(record.status).toBe(mode === 'auxiliary' ? 'VERIFIED' : 'ERROR');
    expect(record.checks).toContainEqual({ name: 'capabilities', status: mode === 'auxiliary' ? 'PASS' : 'UNSUPPORTED' });
  });
  it.each(['ERROR', 'LEAK'] as const)('requires every link control and retains %s evidence', async status => {
    const fake = scriptedPlugin(); const deps = dependencies(fake.plugin); const original = deps.probe!;
    deps.probe = async params => ({ ...await original(params), expectedNames: ['positive.workspace', 'negative.link.tmp.0.read'],
      parse: () => [{ name: 'positive.workspace', status: 'PASS' }, { name: 'negative.link.tmp.0.read', status }] });
    const record = await runIsolationCheck(input(), deps);
    expect(record.status).toBe(status === 'LEAK' ? 'LEAK' : 'UNSUPPORTED');
  });

  it('registers Claude-specific evidence and cleanup failures without unexpected checks', async () => {
    const fake = scriptedPlugin(); const deps = dependencies(fake.plugin);
    const original = deps.probe!;
    deps.bridge = async () => [...BRIDGE_CHECKS.map(name => ({ name, status: 'PASS' as const })), { name: 'bridge.cleanup', status: 'ERROR' as const }];
    const names = ['claude.shared-default-write.0', 'sensitive.claude.convenience-read.0'];
    deps.probe = async params => ({ ...await original(params), expectedNames: ['positive.workspace', ...names],
      parse: () => ['positive.workspace', ...names].map(name => ({ name, status: 'PASS' })), cleanup: () => { throw new Error('fixture cleanup'); } });
    const record = await runIsolationCheck(input(), deps);
    expect(record.checks).toContainEqual({ name: 'probe.cleanup', status: 'ERROR' });
    expect(record.checks.some(check => check.name === 'check-contract')).toBe(false);
  });

  it('whole-check timeout kills the agent and never converts unexecuted checks into success', async () => {
    const fake = scriptedPlugin('timeout');
    const record = await runIsolationCheck(input(), { ...dependencies(fake.plugin), timeoutMs: 40 });
    expect(record.status).toBe('ERROR');
    expect(record.checks).toContainEqual({ name: 'check.timeout', status: 'ERROR' });
    expect(record.checks.some(item => item.name === 'positive.workspace' && item.status === 'ERROR')).toBe(true);
    expect(fake.killed).toHaveBeenCalled();
  });
  it('a disallowed captured tool makes an otherwise complete check UNSUPPORTED', async () => {
    const fake = scriptedPlugin('wrong-tool');
    const record = await runIsolationCheck(input(), dependencies(fake.plugin));
    expect(record.status).toBe('UNSUPPORTED');
    expect(record.checks).toContainEqual({ name: 'capabilities', status: 'UNSUPPORTED' });
  });
  it('an agent that never confirms exit cannot verify even after a complete tool roundtrip', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const fake = scriptedPlugin('roundtrip', false);
      const pending = runIsolationCheck(input(), { ...dependencies(fake.plugin), timeoutMs: 10_000 });
      await vi.waitFor(() => expect(fake.killed).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(2001);
      const record = await pending;
      expect(record.status).toBe('ERROR');
      expect(record.checks).toContainEqual({ name: 'model.roundtrip', status: 'PASS' });
      expect(record.checks).toContainEqual({ name: 'agent.exit-timeout', status: 'ERROR' });
    } finally { vi.useRealTimers(); }
  });
  it('integration: a real synthetic session residue blocks an otherwise successful roundtrip', async () => {
    const directory = join(f.paths.home, '.claude/projects/synthetic'); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${id}.jsonl`), 'must not be read');
    const fake = scriptedPlugin();
    const record = await runIsolationCheck(input(), { ...dependencies(fake.plugin), residue: scanSessionResidue });
    expect(record.status).toBe('ERROR');
    expect(record.checks).toContainEqual({ name: 'session-residue', status: 'ERROR', errorCategory: 'session-persisted' });
  });
  it('start failure yields ERROR and still cleans the owned probe', async () => {
    const fake = scriptedPlugin(); const deps = dependencies(fake.plugin);
    const cleanup = vi.fn();
    const original = deps.probe!;
    deps.probe = async params => ({ ...await original(params), cleanup });
    deps.plugin = { ...fake.plugin, spawn: () => { throw new Error('fixture start failure'); } };
    const record = await runIsolationCheck(input(), deps);
    expect(record.status).toBe('ERROR'); expect(cleanup).toHaveBeenCalledOnce();
  });
});
