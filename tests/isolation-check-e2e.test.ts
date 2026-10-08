import { afterEach, describe, expect, it, vi, type TestContext } from 'vitest';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolationFixture } from './helpers/isolation.js';
import { buildIsolationPolicy, contains } from '../src/isolation/policy.js';
import { identifyBinary } from '../src/isolation/verification.js';
import { runIsolationCheck, type IsolationCheckInput } from '../src/isolation/check.js';
import { isolatedCodexHome, prepareCodexHome, isolationEnvironment } from '../src/isolation/codex.js';
import { createProbePlan } from '../src/isolation/probe.js';
import { ClaudeCodePlugin } from '../src/agents/claude-code.js';
import { createCheckOptions } from '../src/isolation/check-options.js';
import { startMockModel } from '../src/isolation/mock-model.js';
import { prepareTemporaryDirectory } from '../src/isolation/sbx-read.js';
import type { AgentEvent, AgentProcess } from '../src/types.js';

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }));
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>() }));

// A skip means the host cannot execute Seatbelt or lacks a CLI, never that a
// security assertion failed. Real CLI/protocol/probe failures remain failures.
function nativeBinary(context: TestContext, agent: 'claude-code' | 'codex'): string {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) context.skip('Native macOS Seatbelt is unavailable');
  const supported = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1) (allow default)', '/usr/bin/true'], { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' } });
  if (supported.status !== 0) context.skip('The current sandbox does not permit nested sandbox-exec');
  return locateNativeBinary(context, agent);
}

function locateNativeBinary(context: TestContext, agent: 'claude-code' | 'codex'): string {
  const explicit = process.env[agent === 'claude-code' ? 'CLI2IM_TEST_CLAUDE_BINARY' : 'CLI2IM_TEST_CODEX_BINARY'];
  const searchPath = (process.env.PATH ?? '').split(delimiter).filter(entry => !resolve(entry).endsWith('/node_modules/.bin')).join(delimiter);
  const located = explicit ?? spawnSync('/usr/bin/which', [agent === 'claude-code' ? 'claude' : 'codex'], { encoding: 'utf8', env: { PATH: searchPath } }).stdout.trim();
  if (!located) context.skip('The real CLI is not installed');
  const repositoryModules = fileURLToPath(new URL('../node_modules', import.meta.url));
  if (contains(repositoryModules, resolve(located))) context.skip('The CLI is inside repository node_modules; set CLI2IM_TEST_CLAUDE_BINARY or CLI2IM_TEST_CODEX_BINARY to a real CLI');
  const forbidden = ['.claude', '.codex', '.gemini', '.cli2im'].map(name => join(homedir(), name));
  if (forbidden.some(root => contains(root, located))) context.skip('The CLI is inside a prohibited real HOME directory');
  const binary = realpathSync(located);
  if (contains(repositoryModules, binary)) context.skip('The CLI resolves inside repository node_modules; set CLI2IM_TEST_CLAUDE_BINARY or CLI2IM_TEST_CODEX_BINARY to a real CLI');
  if (forbidden.some(root => contains(root, binary))) context.skip('The CLI resolves inside a prohibited real HOME directory');
  return binary;
}

describe('real CLI binary resolution', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  const context = { skip: (reason: string) => { throw new Error(reason); } } as TestContext;

  it.each(['claude-code', 'codex'] as const)('filters every node_modules/.bin PATH entry before locating %s', agent => {
    vi.stubEnv('CLI2IM_TEST_CLAUDE_BINARY', undefined); vi.stubEnv('CLI2IM_TEST_CODEX_BINARY', undefined);
    vi.stubEnv('PATH', ['/repo/node_modules/.bin', '/opt/homebrew/bin', '/other/node_modules/.bin/', 'node_modules/.bin', '/usr/bin'].join(delimiter));
    const which = vi.spyOn(childProcess, 'spawnSync').mockReturnValue({ stdout: '/fixture/native-cli\n' } as any);
    vi.spyOn(nodeFs, 'realpathSync').mockReturnValue('/fixture/native-cli');
    expect(locateNativeBinary(context, agent)).toBe('/fixture/native-cli');
    expect(which).toHaveBeenCalledExactlyOnceWith('/usr/bin/which', [agent === 'claude-code' ? 'claude' : 'codex'], {
      encoding: 'utf8', env: { PATH: ['/opt/homebrew/bin', '/usr/bin'].join(delimiter) },
    });
  });

  it.each(['claude-code', 'codex'] as const)('honors the explicit %s binary before PATH lookup', agent => {
    vi.stubEnv(agent === 'claude-code' ? 'CLI2IM_TEST_CLAUDE_BINARY' : 'CLI2IM_TEST_CODEX_BINARY', '/fixture/explicit-cli');
    const which = vi.spyOn(childProcess, 'spawnSync');
    vi.spyOn(nodeFs, 'realpathSync').mockReturnValue('/fixture/explicit-cli');
    expect(locateNativeBinary(context, agent)).toBe('/fixture/explicit-cli');
    expect(which).not.toHaveBeenCalled();
  });

  it.each([false, true])('skips a CLI in repository node_modules with a reason (symlink=%s)', symlink => {
    const shim = fileURLToPath(new URL('../node_modules/.bin/codex', import.meta.url));
    vi.stubEnv('CLI2IM_TEST_CODEX_BINARY', symlink ? '/fixture/codex-link' : shim);
    const realpath = vi.spyOn(nodeFs, 'realpathSync').mockReturnValue(shim);
    expect(() => locateNativeBinary(context, 'codex')).toThrow(/CLI.*inside repository node_modules/);
    expect(realpath).toHaveBeenCalledTimes(symlink ? 1 : 0);
  });
});

describe('slice 9 real CLI isolation acceptance (synthetic HOME; not production verification)', () => {
  let fixture: ReturnType<typeof isolationFixture> | undefined;
  let claudeTmp: string | undefined;
  afterEach(() => {
    // Entire roots are freshly allocated test fixtures, never production CLI state.
    if (fixture) rmSync(fixture.root, { recursive: true, force: true });
    if (claudeTmp) rmSync(claudeTmp, { recursive: true, force: true });
    fixture = undefined; claudeTmp = undefined;
  });
  function setup(agent: 'claude-code' | 'codex', binary: string): IsolationCheckInput {
    const f = fixture = isolationFixture();
    // HOME is an ancestor of every workspace, so config-source traversal stops
    // within the synthetic fixture instead of reaching the operator's HOME.
    expect(f.paths.home).toBe(f.root);
    f.bot.agent = agent;
    const other = join(f.root, 'other-bot'); mkdirSync(other);
    f.config.bots.other = { ...f.bot, workingDirectory: other, userOverrides: undefined };
    f.config.agents = { [agent]: { binary } };
    mkdirSync(join(f.root, '.claude')); mkdirSync(join(f.root, '.codex'));
    writeFileSync(join(f.root, '.claude', 'CLAUDE.md'), 'CLI2IM_SYNTHETIC_CLAUDE_GLOBAL_INSTRUCTION_CANARY_593158');
    writeFileSync(join(f.root, '.codex', 'AGENTS.md'), 'CLI2IM_SYNTHETIC_CODEX_GLOBAL_INSTRUCTION_CANARY_829563');
    const env = { HOME: f.root, CODEX_HOME: isolatedCodexHome(f.paths.dataDir, 'bot'), PATH: process.env.PATH ?? '/usr/bin:/bin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8' };
    if (agent === 'codex') prepareCodexHome(env.CODEX_HOME);
    const policy = buildIsolationPolicy({ config: f.config, botName: 'bot', workspace: f.workspace, paths: f.paths, binaryPath: binary, effectiveEnv: env });
    if (agent === 'claude-code') {
      // Unique scope hash comes from the newly allocated fixture. Refuse an
      // unexpected existing path instead of cleaning someone else's directory.
      expect(existsSync(policy.tmpdir)).toBe(false); claudeTmp = policy.tmpdir;
    }
    return { bot: 'bot', agent, binary: identifyBinary(binary), policy, paths: f.paths, config: f.config,
      env: { ...isolationEnvironment(env, policy), ...(agent === 'claude-code' ? { CLAUDE_CODE_TMPDIR: policy.tmpdir } : { TMPDIR: policy.tmpdir }) },
      opts: { workingDirectory: f.workspace, permissionMode: 'blacklist', autoApprove: true, isolation: policy } };
  }

  it.for(['claude-code', 'codex'] as const)('%s completes the full production-plugin/local-model check', { timeout: 110_000 }, async (agent, context) => {
    const binary = nativeBinary(context, agent);
    const input = setup(agent, binary);
    const record = await runIsolationCheck(input, {
      timeoutMs: 90_000,
      probe: params => createProbePlan(params),
    });
    expect(record.status, JSON.stringify(record.checks.filter(c => c.status !== 'PASS'))).toBe('VERIFIED');
    expect(record.policyFingerprint).toBe(input.policy.fingerprint);
    expect(record.checks.length).toBeGreaterThan(30);
    expect(record.checks.every(check => check.status === 'PASS' || ((check.name.startsWith('sensitive.') || check.name === 'environment.keychain') && check.status === 'UNCOVERED'))).toBe(true);
    expect(record.checks).toContainEqual(expect.objectContaining({ name: 'session-residue', status: 'PASS' }));
  });

  it.for(['AGENTS.md', 'AGENTS.override.md'])('Codex effective home %s canary prevents VERIFIED', { timeout: 110_000 }, async (file, context) => {
    const input = setup('codex', nativeBinary(context, 'codex'));
    writeFileSync(join(input.policy.codexHome!, file), 'CLI2IM_EFFECTIVE_HOME_INSTRUCTION_CANARY_756289');
    const record = await runIsolationCheck(input);
    expect(record.status).not.toBe('VERIFIED');
    expect(record.checks).toContainEqual(expect.objectContaining({ name: 'global-instructions', status: 'LEAK' }));
  });

  it.for([
    { present: true, readable: false }, { present: false, readable: false },
    { present: true, readable: true }, { present: false, readable: true },
  ])('Claude synthetic HOME write regression: existing=$present readonly=$readable', { timeout: 80_000 }, async ({ present, readable }, context) => {
    const binary = nativeBinary(context, 'claude-code');
    const input = setup('claude-code', binary);
    const roots = [join(input.paths.home, '.npm', '_logs'), join(input.paths.home, '.claude', 'debug')];
    if (present) roots.forEach(path => mkdirSync(path, { recursive: true }));
    if (readable) {
      fixture!.bot.isolation!.readable = [...fixture!.bot.isolation!.readable!, ...roots];
      input.policy = buildIsolationPolicy({ config: input.config, botName: 'bot', workspace: input.policy.workspace, paths: input.paths,
        binaryPath: binary, effectiveEnv: input.env });
      input.opts.isolation = input.policy;
    }
    await prepareTemporaryDirectory(input.policy);
    // This deliberately mutates only an authorized synthetic HOME fixture. It
    // produces no verification record and is not evidence for a production HOME.
    const source = `const fs=require('node:fs'); const roots=${JSON.stringify(roots)}; const results=[];
      const control=${JSON.stringify(join(input.policy.workspace, '.synthetic-positive'))};
      try {fs.writeFileSync(control,'synthetic',{flag:'wx'});fs.unlinkSync(control);results.push({name:'positive',status:'PASS'});}catch{results.push({name:'positive',status:'ERROR'});}
      for(const [i,root] of roots.entries()) {try {fs.mkdirSync(root,{recursive:true});const fd=fs.openSync(root+'/.cli2im-synthetic-write','wx');fs.closeSync(fd);results.push({name:'write.'+i,status:'LEAK'});}catch(e){results.push({name:'write.'+i,status:['EPERM','EACCES'].includes(e.code)?'PASS':'ERROR'});}}
      console.log('CLI2IM_SYNTHETIC_HOME_RESULT:'+JSON.stringify(results));`;
    const command = `node -e '${source.replaceAll("'", "'\\''")}'`;
    const apiKey = randomUUID();
    const model = await startMockModel({ protocol: 'anthropic', apiKey, script: () => [{ name: 'Bash', input: { command, timeout: 30000 } }] });
    let child: AgentProcess | undefined; let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const plugin = new ClaudeCodePlugin(binary);
      const prepared = createCheckOptions('claude-code', input.opts, input.env, model.url, apiKey);
      await new Promise<void>((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Synthetic HOME real CLI regression timed out')), 60_000);
        child = plugin.spawn(prepared.opts);
        const parser = plugin.createStdoutParser();
        parser.on('data', (event: AgentEvent) => {
          if (event.type === 'permission_request') child!.stdin.write(plugin.formatPermissionResponse(event.id,
            event.tool === 'Bash' && event.input.command === command ? 'allow' : 'deny'));
          if (event.type === 'result') resolve();
          if (event.type === 'error') reject(new Error('Synthetic HOME CLI failure'));
        });
        child.on('error', () => reject(new Error('Synthetic HOME CLI start failed')));
        child.on('exit', () => reject(new Error('Synthetic HOME CLI exited before completion')));
        child.stdout.pipe(parser);
        child.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'Run the synthetic HOME regression.' }));
      });
      expect(model.completed).toBe(true);
      const raw = model.results[0]?.output;
      const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map(item => (item as { text?: string }).text ?? '').join('\n') : '';
      const line = text.split('\n').find(line => line.startsWith('CLI2IM_SYNTHETIC_HOME_RESULT:'));
      expect(line).toBeDefined();
      expect(JSON.parse(line!.slice('CLI2IM_SYNTHETIC_HOME_RESULT:'.length))).toEqual([
        { name: 'positive', status: 'PASS' }, { name: 'write.0', status: 'PASS' }, { name: 'write.1', status: 'PASS' },
      ]);
    } finally { clearTimeout(timeout); child?.kill('SIGKILL'); await model.close(); }
  });
});
