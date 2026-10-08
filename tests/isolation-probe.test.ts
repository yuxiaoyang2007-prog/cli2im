import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { contains, scopeHash, validateIsolationConfig, type IsolationPolicy } from '../src/isolation/policy.js';
import { isolationFixture } from './helpers/isolation.js';
import { PROBE_SOURCE, protectedWriteDenied, classifyProbeError, createProbePlan, parseProbeResults, type ProbePlan } from '../src/isolation/probe.js';

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }));

describe('slice 9 structured isolation probe', () => {
  let f: ReturnType<typeof isolationFixture>;
  let plan: ProbePlan | undefined;
  beforeEach(() => { f = isolationFixture(); f.paths.home = join(f.root, 'home'); });
  afterEach(() => { try { plan?.cleanup(); } finally { plan = undefined; vi.restoreAllMocks(); fs.rmSync(f.root, { recursive: true, force: true }); } });
  const policy = (): IsolationPolicy => ({ scopeKey: f.workspace, workspace: f.workspace, tmpdir: join(f.workspace, '.cli2im-tmp'),
    inbox: join(f.paths.dataDir, 'inbox', scopeHash(f.workspace)), readable: [join(f.root, 'reference')],
    writable: [f.workspace, join(f.workspace, '.cli2im-tmp')], runtimeRead: ['/usr', '/bin'], hardDeny: [f.paths.dataDir, f.paths.memoryDir],
    readExceptions: [f.workspace], tools: [], plugins: [], skills: [], binaryPath: '/bin/cat', searchPath: ['/usr/bin', '/bin'], searchPathDenied: [], fingerprint: 'fixture' });
  const prepare = () => createProbePlan({ policy: policy(), paths: f.paths, agent: 'codex', config: f.config, fixtureRoot: join(f.root, 'outside'), keychainExists: () => true });

  it.each(['.codex', '.claude/projects', '.gemini', 'Library', '.npm/_logs'])('non-isolated workspace in %s uses static+readonly and never creates or deletes there', async name => {
    const protectedRoot = join(f.paths.home, name); fs.mkdirSync(protectedRoot, { recursive: true });
    const alias = join(f.root, 'personal-alias'); fs.symlinkSync(protectedRoot, alias);
    f.config.bots.personal = { ...f.bot, isolation: undefined, workingDirectory: alias, userOverrides: undefined };
    expect(() => validateIsolationConfig(f.config, f.paths)).not.toThrow();
    const configBefore = JSON.stringify(f.config);
    const writes = [vi.spyOn(fs, 'openSync'), vi.spyOn(fs, 'mkdirSync'), vi.spyOn(fs, 'unlinkSync'), vi.spyOn(fs, 'rmdirSync'), vi.spyOn(fs, 'symlinkSync')];
    plan = await prepare();
    expect(plan.canaries.some(c => contains(protectedRoot, c.path))).toBe(false);
    let cases: any[] = [];
    const source = plan.command.slice("node -e '".length, -1).replaceAll("'\\''", "'");
    runInNewContext(source.replace(`(${PROBE_SOURCE})`, 'capture'), { capture: (value: any[]) => { cases = value; } });
    const label = `personal.${scopeHash(protectedRoot).slice(0, 8)}`;
    expect(cases).toContainEqual({ name: `sensitive.workspace.${label}.read`, operation: 'read', sensitive: true, path: protectedRoot });
    expect(cases).toContainEqual({ name: `protected.workspace.${label}.static-write`, operation: 'static', valid: true });
    expect(cases.filter(c => c.path && contains(protectedRoot, c.path)).every(c => c.operation === 'read' && c.sensitive)).toBe(true);
    plan.cleanup(); plan = undefined;
    for (const spy of writes) expect(spy.mock.calls.some(args => args.some(arg => typeof arg === 'string' && (contains(protectedRoot, arg) || contains(alias, arg))))).toBe(false);
    expect(fs.readdirSync(protectedRoot)).toEqual([]);
    expect(JSON.stringify(f.config)).toBe(configBefore);
  });
  it('rejects a protected mandatory fixture root before creating or deleting any object in it', async () => {
    const forbidden = join(f.paths.home, '.codex'); fs.mkdirSync(forbidden);
    f.paths.memoryDir = join(forbidden, 'missing-memory');
    const mkdir = vi.spyOn(fs, 'mkdirSync'); const open = vi.spyOn(fs, 'openSync');
    const unlink = vi.spyOn(fs, 'unlinkSync'); const rmdir = vi.spyOn(fs, 'rmdirSync');
    await expect(prepare()).rejects.toThrow('UNSUPPORTED');
    for (const spy of [mkdir, open, unlink, rmdir]) expect(spy.mock.calls.some(([target]) => contains(forbidden, String(target)))).toBe(false);
    expect(fs.readdirSync(forbidden)).toEqual([]);
  });
  it('does not create an absent personal CLI workspace or any missing parent', async () => {
    const protectedRoot = join(f.paths.home, '.codex');
    f.config.bots.personal = { ...f.bot, isolation: undefined, workingDirectory: join(protectedRoot, 'sessions/missing'), userOverrides: undefined };
    const mkdir = vi.spyOn(fs, 'mkdirSync'); const open = vi.spyOn(fs, 'openSync');
    const unlink = vi.spyOn(fs, 'unlinkSync'); const rmdir = vi.spyOn(fs, 'rmdirSync');
    plan = await prepare();
    expect(plan.expectedNames.some(name => name.startsWith('sensitive.workspace.personal.'))).toBe(true);
    plan.cleanup(); plan = undefined;
    for (const spy of [mkdir, open, unlink, rmdir]) expect(spy.mock.calls.some(([target]) => contains(protectedRoot, String(target)))).toBe(false);
    expect(fs.existsSync(protectedRoot)).toBe(false);
  });

  it('uses git --version without git-init and cleans all owned probe fixtures', async () => {
    const before = fs.readdirSync(f.workspace).sort();
    plan = await prepare();
    let cases: any[] = [];
    const source = plan.command.slice("node -e '".length, -1).replaceAll("'\\''", "'");
    runInNewContext(source.replace(`(${PROBE_SOURCE})`, 'capture'), { capture: (value: any[]) => { cases = value; } });
    expect(cases.filter(c => c.command === 'git')).toEqual([
      { name: 'positive.command.git', operation: 'command', positive: true, command: 'git', args: ['--version'] },
    ]);
    expect(plan.expectedNames).not.toContain('positive.command.git-init');
    expect(cases.some(c => c.operation === 'git')).toBe(false);
    const ownedFiles = [...plan.canaries.map(c => c.path), plan.symlinkPath];
    plan.cleanup();
    expect(ownedFiles.every(path => !fs.existsSync(path))).toBe(true);
    expect(fs.readdirSync(f.workspace).sort()).toEqual(before);
    expect(() => plan!.cleanup()).not.toThrow();
  });

  it.each(['EPERM', 'EACCES'])('accepts only explicit permission denial: %s', code => {
    expect(classifyProbeError({ code })).toEqual({ status: 'PASS', errorCategory: code });
  });
  it('treats nonexistent fixtures, other failures and missing probes as ERROR', () => {
    expect(classifyProbeError({ code: 'ENOENT' }).status).toBe('ERROR');
    expect(classifyProbeError({ code: 'EIO', message: 'Operation not permitted' }).status).toBe('ERROR');
    expect(classifyProbeError({ code: 'ENOENT' }, true).status).toBe('UNCOVERED');
    expect(parseProbeResults('', ['negative.fixture'])).toEqual([{ name: 'negative.fixture', status: 'ERROR', errorCategory: 'NOT_EXECUTED' }]);
  });
  it('rejects duplicate, malformed and fabricated uncovered results without retaining payload contents', () => {
    const prefix = 'CLI2IM_PROBE_RESULT:';
    const line = prefix + JSON.stringify({ name: 'negative.fixture', status: 'PASS' });
    expect(parseProbeResults(`${line}\n${line}`, ['negative.fixture'])[0].status).toBe('ERROR');
    expect(parseProbeResults(prefix + '{broken', ['negative.fixture'])[0].status).toBe('ERROR');
    expect(parseProbeResults(prefix + JSON.stringify({ name: 'negative.fixture', status: 'UNCOVERED' }), ['negative.fixture'])[0].status).toBe('ERROR');
    expect(parseProbeResults(prefix + JSON.stringify({ name: 'sensitive.0', status: 'UNCOVERED', content: 'private' }), ['sensitive.0'])).toEqual([{ name: 'sensitive.0', status: 'UNCOVERED' }]);
    expect(JSON.stringify(parseProbeResults(prefix + JSON.stringify({ name: 'sensitive.0', status: 'ERROR', errorCategory: 'private file content' }), ['sensitive.0']))).not.toContain('private file content');
  });
  it('prepares only authorized fixtures, never places canaries in synthetic CLI state, and preserves existing files on cleanup', async () => {
    for (const dir of ['.claude', '.codex', '.gemini', 'Library']) fs.mkdirSync(join(f.paths.home, dir));
    const persistent = join(f.workspace, 'user-file'); fs.writeFileSync(persistent, 'existing');
    plan = await prepare();
    expect(plan.canaries.map(c => c.name)).toEqual(expect.arrayContaining(['bridge', 'memory', 'shared-tmp']));
    for (const dir of ['.claude', '.codex', '.gemini', 'Library']) expect(fs.readdirSync(join(f.paths.home, dir))).toEqual([]);
    const canaryPaths = plan.canaries.map(c => c.path); const symlink = plan.symlinkPath;
    plan.cleanup(); plan = undefined;
    expect(canaryPaths.every(p => !fs.existsSync(p))).toBe(true); expect(fs.existsSync(symlink)).toBe(false);
    expect(fs.readFileSync(persistent, 'utf8')).toBe('existing');
  });
  it('refuses symlinked fixture roots and does not write through them', async () => {
    fs.symlinkSync(join(f.root, 'outside'), join(f.paths.dataDir, 'isolation'));
    await expect(prepare()).rejects.toThrow(/Unsafe isolation fixture/);
    expect(fs.readdirSync(join(f.root, 'outside'))).toEqual([]);
  });
  it('executes the generated command in a real child and marks negatives unexecuted after a failed positive control', async () => {
    plan = await prepare();
    const output = execFileSync('/bin/sh', ['-c', plan.command], {
      cwd: f.workspace, env: { PATH: process.env.PATH, HOME: f.paths.home, TMPDIR: join(f.root, 'incorrect-tmp') }, encoding: 'utf8',
    });
    const results = plan.parse(output);
    expect(results.find(r => r.name === 'positive.workspace')?.status).toBe('PASS');
    expect(results.find(r => r.name === 'positive.inbox')?.status).toBe('PASS');
    expect(results.find(r => r.name === 'positive.tmpdir')?.status).toBe('ERROR');
    expect(results.filter(r => !r.name.startsWith('positive.')).every(r => r.status === 'ERROR' && r.errorCategory === 'POSITIVE_FAILED')).toBe(true);
    expect(output).not.toContain('cli2im-isolation-canary');
    expect(fs.readdirSync(f.workspace).filter(n => n.startsWith('.cli2im-canary-'))).toEqual([plan.symlinkPath.split('/').at(-1)]);
  });
  it('runs all negative and sensitive checks against injected denial operations without reading sensitive contents', async () => {
    plan = await prepare();
    const currentPolicy = policy();
    const deniedPaths = new Set(plan.canaries.flatMap(c => [c.path, c.path.slice(0, c.path.lastIndexOf('/'))]));
    let output = ''; let sensitiveReads = 0;
    const deny = (value: unknown, flags?: unknown) => {
      if (typeof value !== 'string') return;
      const relativeSensitive = value.startsWith(f.paths.home + '/');
      if (relativeSensitive || deniedPaths.has(value) || value === plan!.symlinkPath
        || (typeof flags === 'number' && (flags & fs.constants.O_WRONLY) !== 0
          && (value.startsWith(currentPolicy.inbox + '/') || value.startsWith(join(f.root, 'reference') + '/')
            || value.startsWith(join(f.workspace, '.codex') + '/') || value.startsWith(join(f.workspace, '.claude') + '/')))) {
        throw Object.assign(new Error(), { code: 'EPERM' });
      }
    };
    const injected = { ...fs,
      openSync: (path: string, flags: number, mode?: number) => { deny(path, flags); return fs.openSync(path, flags, mode); },
      mkdirSync: (path: string, options?: fs.MakeDirectoryOptions) => {
        if (['.codex', '.claude'].some(name => path === join(f.workspace, name))) throw Object.assign(new Error(), { code: 'EPERM' });
        return fs.mkdirSync(path, options);
      },
      statSync: (path: string) => { deny(path); return fs.statSync(path); },
      readFileSync: (path: string, ...args: unknown[]) => {
        if (path.startsWith(f.paths.home + '/')) sensitiveReads++;
        deny(path); return (fs.readFileSync as (...args: unknown[]) => unknown)(path, ...args);
      },
    };
    const source = plan.command.slice("node -e '".length, -1).replaceAll("'\\''", "'");
    runInNewContext(source, { require: (name: string) => name === 'node:fs' ? injected : name === 'node:child_process'
      ? { spawnSync: (command: string, args: string[], opts: { stdio: string }) => {
        expect(opts.stdio).toBe('ignore');
        if (command === '/usr/bin/security') { expect(args).toEqual(['find-generic-password', '-s', 'Claude Code-credentials']); return { status: 51 }; }
        return { status: 0 };
      } } : { resolve, join, dirname }, process: { env: { TMPDIR: currentPolicy.tmpdir }, stdout: { write: (s: string) => { output += s; } } } });
    expect(plan.parse(output).filter(r => r.status !== 'PASS')).toEqual([]);
    expect(sensitiveReads).toBe(0); expect(output).not.toContain('cli2im-isolation-canary');
  });
  const runCases = (cases: unknown[], overrides: { fs?: unknown; env?: Record<string, string>; spawnSync?: unknown } = {}) => {
    let output = '';
    runInNewContext(`(${PROBE_SOURCE})(${JSON.stringify(cases)}, 'RESULT:', ['OPENAI_API_KEY'], '.owned')`, {
      require: (name: string) => name === 'node:fs' ? overrides.fs ?? fs : name === 'node:path' ? { join, dirname, resolve }
        : { spawnSync: overrides.spawnSync ?? (() => ({ status: 0 })) },
      process: { env: overrides.env ?? {}, stdout: { write: (text: string) => { output += text; } } },
    });
    return output.trim().split('\n').map(line => JSON.parse(line.slice('RESULT:'.length)));
  };
  const workspaceCases = () => {
    let cases: any[] = [];
    const source = plan!.command.slice("node -e '".length, -1).replaceAll("'\\''", "'");
    runInNewContext(source.replace(`(${PROBE_SOURCE})`, 'capture'), { capture: (value: any[]) => { cases = value; } });
    const probes = cases.filter(c => c.name.startsWith('negative.workspace..'));
    expect(probes.map(c => c.path)).toEqual(['.codex', '.claude'].map(name => join(f.workspace, name)));
    return probes;
  };
  it('does not prepare or own workspace agent directories; cleanup preserves CLI-created .cc-writes', async () => {
    plan = await prepare();
    for (const name of ['.codex', '.claude']) expect(fs.existsSync(join(f.workspace, name))).toBe(false);
    const probes = workspaceCases();
    for (const probe of probes) fs.mkdirSync(join(probe.path, '.cc-writes'), { recursive: true });
    const result = runCases(probes, { fs: { ...fs, openSync: () => { throw Object.assign(new Error(), { code: 'EPERM' }); } } });
    expect(result.map(r => r.status)).toEqual(['PASS', 'PASS']);
    expect(() => plan!.cleanup()).not.toThrow();
    for (const probe of probes) expect(fs.readdirSync(probe.path)).toEqual(['.cc-writes']);
  });
  it.each(['existing', 'absent', 'raced'])('workspace agent directory %s: exclusive writes leak and clean only owned objects', async state => {
    plan = await prepare();
    const probes = workspaceCases();
    if (state === 'existing') for (const probe of probes) fs.mkdirSync(probe.path);
    const attempts: string[] = [];
    const opened: string[] = [];
    const injected = { ...fs,
      mkdirSync: (target: string, options: fs.MakeDirectoryOptions) => {
        attempts.push(target); expect(options).toEqual({ mode: 0o700 });
        if (state === 'raced') fs.mkdirSync(target);
        return fs.mkdirSync(target, options);
      },
      openSync: (target: string, flags: number, mode: number) => {
        opened.push(target);
        expect(flags).toBe(fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
        expect(mode).toBe(0o600);
        // The CLI may write its own entries while the sandbox probe is running.
        fs.mkdirSync(join(dirname(target), '.cc-writes'));
        return fs.openSync(target, flags, mode);
      },
    };
    expect(runCases(probes, { fs: injected }).map(r => r.status)).toEqual(['LEAK', 'LEAK']);
    expect(attempts).toEqual(state === 'existing' ? [] : probes.map(c => c.path));
    expect(opened).toEqual(state === 'absent' ? [] : probes.map(c => join(c.path, '.owned')));
    expect(() => plan!.cleanup()).not.toThrow();
    for (const probe of probes) {
      if (state === 'absent') expect(fs.existsSync(probe.path)).toBe(false);
      else expect(fs.readdirSync(probe.path)).toEqual(['.cc-writes']);
    }
  });
  it.each(['existing', 'absent', 'raced'].flatMap(state => ['EPERM', 'EACCES', 'ENOENT', 'EIO', 'EEXIST'].map(code => ({ state, code }))))(
    'workspace agent directory $state: only permission denial passes ($code)', async ({ state, code }) => {
      plan = await prepare();
      const probes = workspaceCases();
      if (state === 'existing') for (const probe of probes) fs.mkdirSync(probe.path);
      const attempts: string[] = [];
      const opened: string[] = [];
      const injected = { ...fs,
        mkdirSync: (target: string, options: fs.MakeDirectoryOptions) => {
          attempts.push(target); expect(options).toEqual({ mode: 0o700 });
          if (state === 'raced') { fs.mkdirSync(target); return fs.mkdirSync(target, options); }
          throw Object.assign(new Error(), { code });
        },
        openSync: (target: string) => { opened.push(target); throw Object.assign(new Error(), { code }); },
      };
      expect(runCases(probes, { fs: injected }).map(r => r.status)).toEqual(Array(2).fill(['EPERM', 'EACCES'].includes(code) ? 'PASS' : 'ERROR'));
      expect(attempts).toEqual(state === 'existing' ? [] : probes.map(c => c.path));
      expect(opened).toEqual(state === 'absent' ? [] : probes.map(c => join(c.path, '.owned')));
      expect(() => plan!.cleanup()).not.toThrow();
      for (const probe of probes) {
        if (state === 'absent') expect(fs.existsSync(probe.path)).toBe(false);
        else expect(fs.readdirSync(probe.path)).toEqual([]);
      }
    });
  it('workspace child EEXIST never owns, overwrites or removes the existing child', async () => {
    plan = await prepare();
    const probes = workspaceCases();
    for (const probe of probes) {
      fs.mkdirSync(probe.path);
      fs.writeFileSync(join(probe.path, '.owned'), 'foreign');
    }
    expect(runCases(probes).map(r => r.status)).toEqual(['ERROR', 'ERROR']);
    expect(() => plan!.cleanup()).not.toThrow();
    for (const probe of probes) expect(fs.readFileSync(join(probe.path, '.owned'), 'utf8')).toBe('foreign');
  });
  it.each(['replacement', 'nonempty'])('workspace directory created inside the probe preserves %s and reports ERROR', async mutation => {
    plan = await prepare();
    const probes = workspaceCases();
    const observed = new Set<string>();
    const injected = { ...fs, lstatSync: (target: string) => {
      if (probes.some(c => c.path === target) && fs.existsSync(target)) {
        if (observed.has(target)) {
          if (mutation === 'replacement') { fs.renameSync(target, target + '-original'); fs.mkdirSync(target); }
          fs.mkdirSync(join(target, '.cc-writes'));
        }
        observed.add(target);
      }
      return fs.lstatSync(target);
    } };
    expect(runCases(probes, { fs: injected }).map(r => r.status)).toEqual(['ERROR', 'ERROR']);
    expect(() => plan!.cleanup()).not.toThrow();
    for (const probe of probes) expect(fs.readdirSync(probe.path)).toEqual(['.cc-writes']);
  });
  it('workspace child cleanup preserves a replaced child and reports ERROR', async () => {
    plan = await prepare();
    const probes = workspaceCases();
    for (const probe of probes) fs.mkdirSync(probe.path);
    const children = probes.map(c => join(c.path, '.owned'));
    const injected = { ...fs, lstatSync: (target: string) => {
      if (children.includes(target)) { fs.renameSync(target, target + '-original'); fs.writeFileSync(target, 'foreign'); }
      return fs.lstatSync(target);
    } };
    expect(runCases(probes, { fs: injected }).map(r => r.status)).toEqual(['ERROR', 'ERROR']);
    expect(() => plan!.cleanup()).not.toThrow();
    for (const target of children) expect(fs.readFileSync(target, 'utf8')).toBe('foreign');
  });
  it.each([true, false])('Claude static proof accounts for implicit writes and denials (denied=%s)', denied => {
    const p = policy(); const target = join(f.paths.home, '.npm/_logs');
    expect(protectedWriteDenied(p, 'claude-code', f.paths.home, target,
      { allowWrite: [], denyWrite: denied ? [target] : [] })).toBe(denied);
  });
  it.each(['claude-code', 'codex'])('%s static proof rejects a deeper write grant anywhere inside a protected subtree', agent => {
    const p = policy(); const target = join(f.root, 'reference'); const deeper = join(target, 'nested/write');
    const rules = agent === 'claude-code' ? { allowWrite: [deeper], denyWrite: [] } : { ':root': 'deny', [target]: 'read', [deeper]: 'write' };
    expect(protectedWriteDenied(p, agent, f.paths.home, target, rules)).toBe(false);
    const denied = agent === 'claude-code' ? { allowWrite: [deeper], denyWrite: [deeper] }
      : { ':root': 'deny', [target]: 'read', [deeper]: 'deny' };
    expect(protectedWriteDenied(p, agent, f.paths.home, target, denied)).toBe(true);
    // An ancestor grant intersecting the target must be denied in full as well.
    expect(protectedWriteDenied(p, agent, f.paths.home, target, agent === 'claude-code'
      ? { allowWrite: [f.root], denyWrite: [join(target, 'only-one-child')] }
      : { ':root': 'deny', [f.root]: 'write', [join(target, 'only-one-child')]: 'deny' })).toBe(false);
  });
  it('registers link controls and confines object creation to authorized targets; protected roots use static+readonly', async () => {
    f.bot.agent = 'claude-code';
    const reference = join(f.paths.home, '.claude/private'); fs.mkdirSync(reference, { recursive: true });
    f.bot.isolation!.readable!.push(reference);
    plan = await createProbePlan({ policy: f.policy(), paths: f.paths, config: f.config, agent: 'claude-code', keychainExists: () => false });
    let cases: any[] = [];
    const source = plan.command.slice("node -e '".length, -1).replaceAll("'\\''", "'");
    runInNewContext(source.replace(`(${PROBE_SOURCE})`, 'capture'), { capture: (value: any[]) => { cases = value; } });
    expect(cases.filter(c => c.name.includes('.link.'))).toHaveLength(10);
    expect(cases.filter(c => c.name.includes('.link.')).map(c => c.path)).toEqual(expect.arrayContaining([
      '/etc/hosts', '/private/etc/hosts', '/var/db', '/private/var/db', '/var/folders', '/private/var/folders',
    ]));
    const creates = cases.filter(c => ['create', 'mkdir', 'readwrite', 'directory-write'].includes(c.operation));
    expect(creates.every(c => c.path.startsWith(f.workspace + '/') || ['/tmp/claude', '/private/tmp/claude'].some(root => c.path === root || c.path.startsWith(root + '/')))).toBe(true);
    expect(cases.some(c => c.operation === 'write-open')).toBe(false);
    expect(cases.filter(c => c.name.startsWith('negative.readonly.')).every(c => c.operation === 'static' && c.valid)).toBe(true);
    const output = cases.map(c => plan!.marker + JSON.stringify({ name: c.name, status: 'PASS' })).join('\n');
    expect(plan.parse(output).filter(c => c.name.startsWith('negative.readonly.')).every(c => c.evidenceMode === 'static+readonly')).toBe(true);
    expect(fs.readdirSync(reference)).toEqual([]);
  });
  it.each([44, 51, 36, 0, 1])('existing keychain uses sandbox exit status %s without reading output', status => {
    const result = runCases([{ name: 'environment.keychain', operation: 'keychain', valid: true }], {
      spawnSync: (_command: string, _args: string[], options: any) => { expect(options.stdio).toBe('ignore'); return { status }; },
    })[0];
    expect(result.status).toBe(status === 0 ? 'LEAK' : [44, 51, 36].includes(status) ? 'PASS' : 'ERROR');
  });
  it('absent keychain is UNCOVERED and never probed inside; credentials are a leak', () => {
    expect(runCases([{ name: 'environment.keychain', operation: 'keychain', valid: false }], {
      spawnSync: () => { throw new Error('must not execute'); },
    })[0]).toMatchObject({ status: 'UNCOVERED', errorCategory: 'ENOENT' });
    expect(runCases([{ name: 'environment.credentials', operation: 'environment' }])[0].status).toBe('PASS');
    expect(runCases([{ name: 'environment.credentials', operation: 'environment' }], { env: { OPENAI_API_KEY: 'placeholder' } })[0].status).toBe('LEAK');
  });
  it.each(['mkdir', 'create'])('exclusive %s leaks are cleaned by identity; EEXIST never conveys ownership', operation => {
    const target = join(f.workspace, 'probe-target');
    const probe = [{ name: 'negative.fixture', operation, path: target }];
    expect(runCases(probe)[0].status).toBe('LEAK'); expect(fs.existsSync(target)).toBe(false);
    if (operation === 'mkdir') fs.mkdirSync(target); else fs.writeFileSync(target, 'existing');
    expect(runCases(probe)[0].status).toBe('ERROR'); expect(fs.existsSync(target)).toBe(true);
  });
  it('directory replacement and nonempty cleanup are ERROR and preserve the replacement', () => {
    const target = join(f.workspace, 'probe-dir');
    let mutated = false;
    const injected = { ...fs, lstatSync: (value: string) => {
      if (value === target && mutated) { fs.writeFileSync(join(target, 'foreign'), 'preserve'); }
      if (value === target) mutated = true;
      return fs.lstatSync(value);
    } };
    expect(runCases([{ name: 'negative.directory', operation: 'mkdir', path: target }], { fs: injected })[0].status).toBe('ERROR');
    expect(fs.readFileSync(join(target, 'foreign'), 'utf8')).toBe('preserve');
    const file = join(f.workspace, 'probe-file'); let replaced = false;
    const replace = { ...fs, lstatSync: (value: string) => {
      if (value === file && !replaced) { fs.renameSync(file, file + '-original'); fs.writeFileSync(file, 'foreign'); replaced = true; }
      return fs.lstatSync(value);
    } };
    expect(runCases([{ name: 'negative.file', operation: 'create', path: file }], { fs: replace })[0].status).toBe('ERROR');
    expect(fs.readFileSync(file, 'utf8')).toBe('foreign');
    expect(classifyProbeError({ code: 'EISDIR' }).status).toBe('ERROR');
  });

});
