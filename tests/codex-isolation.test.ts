import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, copyFileSync, existsSync, statSync, readdirSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { isolationFixture } from './helpers/isolation.js';
import { codexConfigSources, isolatedCodexHome, prepareCodexHome, codexPermissionArgs, tomlInline } from '../src/isolation/codex.js';
import { buildIsolationPolicy } from '../src/isolation/policy.js';
import { codexExecArgs, createCodexExecThread } from '../src/agents/codex-exec.js';
import { CodexPlugin, type CodexThreadEvent } from '../src/agents/codex.js';
import type { AgentEvent, SpawnOpts } from '../src/types.js';
import { identifyBinary } from '../src/isolation/verification.js';
import { createCheckOptions } from '../src/isolation/check-options.js';

const sdk = vi.hoisted(() => ({ construct: vi.fn(), start: vi.fn(), resume: vi.fn(), records: [] as any[] }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});
vi.mock('@openai/codex-sdk', () => ({ Codex: class {
  constructor(options: unknown) { sdk.construct(options); }
  startThread(options: unknown) { sdk.start(options); return this.thread(); }
  resumeThread(id: string, options: unknown) { sdk.resume(id, options); return this.thread(); }
  thread() { return { async runStreamed() { return { events: (async function* () { yield* sdk.records; })() }; } }; }
} }));

vi.mock('../src/security/child-env.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/security/child-env.js')>();
  return { ...actual, buildChildEnv: (provider: any, env: any) => actual.buildChildEnv(provider, env, { PATH: '/usr/bin:/bin' }) };
});

describe('slice 7 Codex isolation', () => {
  let f: ReturnType<typeof isolationFixture>;
  let binary: string;
  let records: CodexThreadEvent[];
  const processes: ReturnType<CodexPlugin['spawn']>[] = [];
  beforeEach(() => {
    f = isolationFixture();
    vi.stubEnv('CODEX_HOME', join(f.root, 'codex-state'));
    // Synthetic success-path replay using the SDK event contract. The offline
    // installed-CLI test below separately checks native JSONL when available.
    records = readFileSync(new URL('./fixtures/codex-exec-events.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    sdk.records = records; sdk.construct.mockClear(); sdk.start.mockClear(); sdk.resume.mockClear();
    binary = join(f.root, 'fake-codex.cjs');
    // A local scripted executable: no socket, authentication, or model requests.
    writeFileSync(binary, `#!${process.execPath}\nconst fs = require('node:fs');\nlet prompt = ''; process.stdin.on('data', x => prompt += x); process.stdin.on('end', () => {
      fs.writeFileSync(process.env.CAPTURE, JSON.stringify({ args: process.argv.slice(2), prompt, tmpdir: process.env.TMPDIR, codexHome: process.env.CODEX_HOME, developerDir: process.env.DEVELOPER_DIR, envKeys: Object.keys(process.env) }));
      for (const event of ${JSON.stringify(records)}) process.stdout.write(JSON.stringify(event) + '\\n');
    });\n`);
    chmodSync(binary, 0o700);
  });
  afterEach(() => { for (const proc of processes.splice(0)) proc.kill(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(f.root, { recursive: true, force: true }); });
  const opts = (): SpawnOpts => ({ workingDirectory: f.workspace, permissionMode: 'bypass', autoApprove: true,
    sandboxMode: 'danger-full-access', model: 'fixture-model', reasoningEffort: 'high',
    isolation: { ...f.policy(), binaryPath: binary }, env: { HOME: f.paths.home, TMPDIR: f.policy().tmpdir, CAPTURE: join(f.root, 'capture.json') } });
  const normalize = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll(f.root, '<fixture>').replace(/cli2im-[a-f0-9]{8}/g, 'cli2im-<scope>').replace(/inbox\/[a-f0-9]{32}/g, 'inbox/<scope>'));

  it('builds a unique single inline permissions table, quotes every key, and disables ambient capabilities', () => {
    const options = opts();
    const paths = ['dot.name', 'has space', 'a"quote', '雪', 'back\\slash'].map(n => join(f.root, n));
    options.isolation!.readable.push(...paths); options.isolation!.readExceptions.push(...paths);
    const args = codexExecArgs(options);
    expect(args).not.toContain('--sandbox');
    expect(args.filter(a => a.startsWith('permissions='))).toHaveLength(1);
    expect(args.filter(a => a.startsWith('project_root_markers='))).toEqual(['project_root_markers=[]']);
    expect(args[args.indexOf('project_root_markers=[]') - 1]).toBe('-c');
    const table = args.find(a => a.startsWith('permissions='))!;
    for (const path of paths) expect(table).toContain(`${JSON.stringify(path)}="read"`);
    for (const feature of ['memories', 'hooks', 'plugins', 'apps', 'multi_agent', 'goals']) expect(args.join(' ')).toContain(`--disable ${feature}`);
    expect(normalize(args)).toMatchSnapshot();
    expect(codexPermissionArgs({ ...options.isolation!, scopeKey: 'another-scope' })[3]).not.toBe(codexPermissionArgs(options.isolation!)[3]);
  });
  it('round trips unusual TOML keys through an independent TOML parser when available', context => {
    const probe = spawnSync('python3', ['-c', 'import tomllib']);
    if (probe.status !== 0) context.skip('Requires Python 3.11 tomllib');
    const expected = { '路径.with.dot "quote" \\ \t\n': { ':root': 'deny', network: { enabled: true }, list: [] } };
    const parsed = spawnSync('python3', ['-c', 'import sys,json,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())["value"]))'], { input: `value=${tomlInline(expected)}`, encoding: 'utf8' });
    expect(parsed.status).toBe(0); expect(JSON.parse(parsed.stdout)).toEqual(expected);
  });
  it('ignores synthetic HOME user config during admission and before each exec', async () => {
    const before = f.policy().fingerprint;
    mkdirSync(join(f.paths.home, '.codex')); writeFileSync(join(f.paths.home, '.codex/config.toml'), 'fixture user config');
    expect(codexConfigSources(f.workspace, { HOME: f.paths.home }, [])).toEqual([]);
    expect(f.policy().fingerprint).toBe(before);
    const options = opts();
    await turn(new CodexPlugin(binary), options);
  });
  it.each(['workspace', 'ancestor'])('rejects %s project config below synthetic HOME', location => {
    const workspace = join(f.workspace, 'nested'); mkdirSync(workspace);
    const dir = location === 'workspace' ? workspace : f.workspace;
    mkdirSync(join(dir, '.codex')); writeFileSync(join(dir, '.codex/config.toml'), '');
    expect(() => codexConfigSources(workspace, { HOME: f.paths.home }, [])).toThrow('UNSUPPORTED');
  });
  it('rejects project configs including dangling links', () => {
    expect(codexConfigSources(f.workspace, { HOME: f.paths.home }, [])).toEqual([]);
    const sub = join(f.workspace, 'nested'); mkdirSync(sub);
    mkdirSync(join(f.workspace, '.codex')); symlinkSync(join(f.root, 'absent'), join(f.workspace, '.codex/config.toml'));
    expect(() => codexConfigSources(sub, { HOME: f.paths.home }, [])).toThrow('UNSUPPORTED');
    expect(() => codexConfigSources(f.workspace, { HOME: f.paths.home }, [])).toThrow('UNSUPPORTED');
  });
  it.each(['direct', 'symlink'])('ignores only the canonical explicit CODEX_HOME directory (%s)', spelling => {
    const configDir = join(f.workspace, '.codex'); mkdirSync(configDir);
    writeFileSync(join(configDir, 'config.toml'), '');
    const alias = join(f.root, 'codex-alias'); symlinkSync(configDir, alias);
    const env = { HOME: f.paths.home, CODEX_HOME: spelling === 'direct' ? configDir : alias };
    const workspace = join(f.workspace, 'nested'); mkdirSync(workspace);
    expect(codexConfigSources(workspace, env, [])).toEqual([]);
    mkdirSync(join(workspace, '.codex')); writeFileSync(join(workspace, '.codex/config.toml'), '');
    expect(() => codexConfigSources(workspace, env, [])).toThrow('UNSUPPORTED');
  });
  it('normalizes a synthetic HOME alias before excluding its user config', () => {
    mkdirSync(join(f.paths.home, '.codex')); writeFileSync(join(f.paths.home, '.codex/config.toml'), '');
    const alias = join(f.root, 'home-alias'); symlinkSync(f.paths.home, alias);
    expect(codexConfigSources(f.workspace, { HOME: alias }, [])).toEqual([]);
  });
  it('production, resume and subsequent turns force the bridge-owned home and skip both user configurations', async () => {
    const options = opts();
    const home = isolatedCodexHome(f.paths.dataDir, 'bot');
    mkdirSync(join(f.paths.home, '.codex')); writeFileSync(join(f.paths.home, '.codex/config.toml'), 'personal config');
    prepareCodexHome(home); writeFileSync(join(home, 'config.toml'), 'bot config');
    options.env!.CODEX_HOME = join(f.root, 'ignored-override');
    const thread = createCodexExecThread(options, 'existing-thread');
    for (let i = 0; i < 2; i++) {
      const { events } = await thread.runStreamed('fixture');
      for await (const _event of events) { /* exhaust the production exec path */ }
      const captured = JSON.parse(readFileSync(join(f.root, 'capture.json'), 'utf8'));
      expect(captured.codexHome).toBe(home);
      expect(captured.developerDir).toBe(options.isolation!.developerDir);
      expect(statSync(home).mode & 0o777).toBe(0o700);
    }
    expect(readdirSync(home)).toEqual(['config.toml']); // no copied login material
    mkdirSync(join(f.workspace, '.codex')); writeFileSync(join(f.workspace, '.codex/config.toml'), 'project');
    await expect(thread.runStreamed('fixture')).rejects.toThrow('UNSUPPORTED');
  });
  it.each([false, true])('uses the explicit child HOME rather than the parent HOME (child user source=%s)', childUserSource => {
    const configDir = join(f.workspace, '.codex'); mkdirSync(configDir); writeFileSync(join(configDir, 'config.toml'), '');
    vi.stubEnv('HOME', childUserSource ? f.paths.home : f.workspace);
    const env = { HOME: childUserSource ? f.workspace : f.paths.home };
    if (childUserSource) expect(codexConfigSources(f.workspace, env, [])).toEqual([]);
    else expect(() => codexConfigSources(f.workspace, env, [])).toThrow('UNSUPPORTED');
  });
  it('binds normalized effective configuration homes into the policy fingerprint', () => {
    const params = { config: f.config, botName: 'bot', workspace: f.workspace, paths: f.paths, binaryPath: '/bin/cat', effectiveEnv: { PATH: '/usr/bin:/bin' } };
    const first = buildIsolationPolicy({ ...params, effectiveEnv: { PATH: '/usr/bin:/bin', HOME: f.paths.home, CODEX_HOME: join(f.root, 'state-a') } });
    const ignored = buildIsolationPolicy({ ...params, effectiveEnv: { PATH: '/usr/bin:/bin', HOME: f.paths.home, CODEX_HOME: join(f.root, 'state-b') } });
    expect(first.fingerprint).toBe(ignored.fingerprint);
    const second = buildIsolationPolicy({ ...params, paths: { ...f.paths, dataDir: join(f.root, 'bridge-new') } });
    expect(first.codexHome).not.toBe(second.codexHome);
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });
  it('fingerprints system/managed source existence without reading contents', () => {
    const system = join(f.root, 'system-config'); f.paths.codexSystemConfigs = [system];
    const before = f.policy().fingerprint;
    writeFileSync(system, 'fixture');
    expect(codexConfigSources(f.workspace, { HOME: f.paths.home }, [system])).toEqual([{ path: system, exists: true }]);
    expect(f.policy().fingerprint).not.toBe(before);
    const exists = f.policy().fingerprint; writeFileSync(system, 'changed contents');
    expect(f.policy().fingerprint).toBe(exists);
  });
  async function turn(plugin: CodexPlugin, options: SpawnOpts, resume?: string) {
    const proc = resume ? plugin.resume(resume, options) : plugin.spawn(options); processes.push(proc);
    const events: AgentEvent[] = []; proc.stdout.on('data', event => events.push(event));
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'fixture prompt' }));
    await vi.waitFor(() => { expect(events.filter(e => e.type === 'error')).toEqual([]); expect(events.some(e => e.type === 'result')).toBe(true); });
    return { proc, events };
  }
  it('binds spawn, resume, later turns and checks despite executable and node shadows created after policy verification', async () => {
    const trustedBin = join(f.paths.installDir, 'bin'); mkdirSync(trustedBin);
    const trusted = join(trustedBin, 'fixture-codex.cjs');
    writeFileSync(trusted, readFileSync(binary, 'utf8').replace(/^#!.*\n/, '#!/usr/bin/env node\n'), { mode: 0o700 });
    symlinkSync(process.execPath, join(trustedBin, 'node'));
    const options = opts(); options.env!.PATH = `${trustedBin}:/usr/bin:/bin`;
    const verified = identifyBinary('fixture-codex.cjs', options.env!.PATH);
    expect(verified.realpath).toBe(trusted);
    options.isolation = buildIsolationPolicy({ config: f.config, botName: 'bot', workspace: f.workspace, paths: f.paths, binaryPath: verified.realpath, effectiveEnv: options.env! });
    const shadowBin = join(f.workspace, 'bin'); mkdirSync(shadowBin);
    const marker = join(f.workspace, 'shadow-ran');
    const shadow = join(shadowBin, 'fixture-codex.cjs');
    writeFileSync(shadow, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe');\n`); chmodSync(shadow, 0o700);
    copyFileSync(shadow, join(shadowBin, 'node')); chmodSync(join(shadowBin, 'node'), 0o700);
    const plugin = new CodexPlugin('fixture-codex.cjs');
    await turn(plugin, options);
    const resumed = await turn(plugin, options, 'existing-thread');
    resumed.proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'later turn' }));
    await vi.waitFor(() => expect(resumed.events.filter(e => e.type === 'result')).toHaveLength(2));
    expect(JSON.parse(readFileSync(join(f.root, 'capture.json'), 'utf8')).args.slice(-2)).toEqual(['fixture-thread', '-']);
    const check = createCheckOptions('codex', options, options.env!, 'http://127.0.0.1:12345');
    await turn(plugin, check.opts);
    expect(existsSync(marker)).toBe(false);
    expect(sdk.construct).not.toHaveBeenCalled();
    await turn(plugin, { ...options, isolation: undefined });
    expect(sdk.construct.mock.calls[0][0].codexPathOverride).toBe('fixture-codex.cjs');
  });
  it('integration: exec JSONL and SDK produce identical mapped events, baseline options snapshot is unchanged', async () => {
    const options = opts();
    const isolated = await turn(new CodexPlugin(binary), options);
    expect(sdk.construct).not.toHaveBeenCalled();
    const capture = JSON.parse(readFileSync(join(f.root, 'capture.json'), 'utf8'));
    expect(capture.tmpdir).toBe(options.isolation!.tmpdir); expect(capture.prompt).toBe('fixture prompt');
    expect(capture.args).not.toContain('--sandbox'); expect(capture.envKeys).not.toContain('OPENAI_API_KEY');
    const baseline = await turn(new CodexPlugin(binary), { ...options, isolation: undefined });
    expect(isolated.events).toEqual(baseline.events);
    expect(normalize({ client: sdk.construct.mock.calls[0][0], thread: sdk.start.mock.calls[0][0], args: new CodexPlugin(binary).buildSpawnArgs({ ...options, isolation: undefined }) })).toMatchSnapshot();
    const resumed = await turn(new CodexPlugin(binary), options, 'existing-thread');
    const args = JSON.parse(readFileSync(join(f.root, 'capture.json'), 'utf8')).args;
    expect(args.slice(-4)).toEqual(['resume', '--', 'existing-thread', '-']);
    resumed.proc.stdin.write(new CodexPlugin(binary).formatStdinMessage({ role: 'user', content: 'second' }));
    await vi.waitFor(() => expect(resumed.events.filter(e => e.type === 'result')).toHaveLength(2));
    expect(JSON.parse(readFileSync(join(f.root, 'capture.json'), 'utf8')).args.slice(-2)).toEqual(['fixture-thread', '-']);
  });
  it('integration: isolation never scans the shared generated_images directory', async () => {
    const fs = await import('node:fs/promises');
    const readdir = vi.mocked(fs.readdir); readdir.mockClear();
    await turn(new CodexPlugin(binary), opts());
    expect(readdir.mock.calls.some(([path]) => String(path).includes('generated_images'))).toBe(false);
  });
  it('integration: project configuration added after admission prevents exec', async () => {
    const options = opts(); mkdirSync(join(f.workspace, '.codex')); writeFileSync(join(f.workspace, '.codex/config.toml'), '');
    const plugin = new CodexPlugin(binary); const proc = plugin.spawn(options); processes.push(proc);
    const events: AgentEvent[] = []; proc.stdout.on('data', e => events.push(e));
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'fixture' }));
    await vi.waitFor(() => expect(events.some(e => e.type === 'error')).toBe(true));
    expect(sdk.construct).not.toHaveBeenCalled();
  });
  it.each([
    ['malformed', 'process.stdout.write("not json\\n")', 'Invalid Codex JSONL event'],
    ['incomplete', 'process.stdout.write(JSON.stringify({type:"turn.started"}) + "\\n")', 'before turn completion'],
    ['nonzero', 'process.exit(7)', 'code 7'],
  ])('integration: %s exec output fails closed without SDK fallback', async (_name, script, message) => {
    writeFileSync(binary, `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => { ${script} });\n`);
    const plugin = new CodexPlugin(binary); const proc = plugin.spawn(opts()); processes.push(proc);
    const events: AgentEvent[] = []; proc.stdout.on('data', e => events.push(e));
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'fixture' }));
    await vi.waitFor(() => expect(events.some(e => e.type === 'error' && e.message.includes(message))).toBe(true));
    expect(events.some(e => e.type === 'result')).toBe(false); expect(sdk.construct).not.toHaveBeenCalled();
  });
  it('integration: an unavailable binary is an error and cancellation terminates exec', async () => {
    const missing = new CodexPlugin(join(f.root, 'missing'));
    const missingOptions = opts(); missingOptions.isolation!.binaryPath = join(f.root, 'missing');
    const failed = missing.spawn(missingOptions); processes.push(failed);
    const events: AgentEvent[] = []; failed.stdout.on('data', e => events.push(e));
    failed.stdin.write(missing.formatStdinMessage({ role: 'user', content: 'fixture' }));
    await vi.waitFor(() => expect(events.some(e => e.type === 'error')).toBe(true));
    writeFileSync(binary, `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'cancel'})+'\\n'); setInterval(()=>{},1000); });\n`);
    const plugin = new CodexPlugin(binary); const proc = plugin.spawn(opts()); processes.push(proc);
    const exit = vi.fn(); proc.on('exit', exit); proc.stdout.on('data', () => {});
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'fixture' }));
    await vi.waitFor(() => expect(proc.sessionId).toBe('cancel'));
    proc.kill(); await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
    expect(sdk.construct).not.toHaveBeenCalled();
  });
  it('integration: inline images use the bridge inbox and agent-writable image paths are rejected', async () => {
    const options = opts(); const plugin = new CodexPlugin(binary); const proc = plugin.spawn(options); processes.push(proc);
    const events: AgentEvent[] = []; proc.stdout.on('data', e => events.push(e));
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'Zml4dHVyZQ==' } }] }));
    await vi.waitFor(() => expect(events.some(e => e.type === 'result')).toBe(true));
    const args = JSON.parse(readFileSync(join(f.root, 'capture.json'), 'utf8')).args as string[];
    expect(args[args.indexOf('--image') + 1]).toMatch(new RegExp(`^${options.isolation!.inbox}/`));
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: '', attachments: [{ type: 'image', localPath: join(f.workspace, 'outside.png') }] }));
    await vi.waitFor(() => expect(events.some(e => e.type === 'error')).toBe(true));
  });
  it('installed CLI: offline JSONL contract (no paid provider)', async context => {
    const state = join(f.root, 'codex-state'); mkdirSync(state);
    mkdirSync(f.policy().tmpdir);
    const env = { PATH: process.env.PATH, HOME: f.paths.home, CODEX_HOME: state, TMPDIR: f.policy().tmpdir,
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    // npm prepends node_modules/.bin, which can contain a different/broken CLI.
    const cli = process.env.CLI2IM_CODEX_TEST_BINARY ?? '/opt/homebrew/bin/codex';
    const version = spawnSync(cli, ['--version'], { env, encoding: 'utf8', timeout: 5000 });
    if ((version.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') context.skip('Codex CLI is not installed');
    expect(version.status).toBe(0);
    let requests = 0;
    const server = createServer((request, response) => {
      requests++; request.resume();
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Offline fixture rejects all requests', type: 'invalid_request_error' } }));
    });
    try {
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const address = server.address();
      expect(address).toMatchObject({ address: '127.0.0.1' });
      if (!address || typeof address === 'string') throw new Error('Missing fixture server address');
      const args = codexExecArgs(opts());
      args.splice(args.lastIndexOf('--'), 0, '--ephemeral', '-c', 'model_provider="cli2im_offline_fixture"', '-c',
        `model_providers.cli2im_offline_fixture={name="Offline fixture",base_url="http://127.0.0.1:${address.port}",wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}`);
      const child = spawn(cli, args, { cwd: f.workspace, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = ''; let failure: Error | undefined; let timedOut = false;
      child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', error => { failure = error; });
      child.stdin.on('error', error => { failure ??= error; });
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
        child.on('close', (code, signal) => resolve({ code, signal }));
      });
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 12000);
      child.stdin.end('Reply with fixture.');
      const result = await closed.finally(() => clearTimeout(timer));
      if (stderr.includes('sandbox_apply: Operation not permitted')) context.skip('Runner cannot initialize the native filesystem sandbox');
      expect(timedOut).toBe(false);
      expect(failure).toBeUndefined();
      expect(result.signal).toBeNull();
      const events = stdout.trim().split('\n').map(line => JSON.parse(line));
      expect(events.some(e => e.type === 'thread.started' && typeof e.thread_id === 'string')).toBe(true);
      expect(events.some(e => e.type === 'turn.failed' && typeof e.error?.message === 'string')).toBe(true);
      expect(result.code).not.toBeNull();
      expect(result.code).not.toBe(0);
      expect(requests).toBeGreaterThan(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 20000);
});
