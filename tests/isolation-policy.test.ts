import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isolationFixture } from './helpers/isolation.js';
import { assertAgentsFile, buildIsolationPolicy, fingerprint, scopeHash, validateIsolationConfig } from '../src/isolation/policy.js';
import { assertNoProviderCredentials } from '../src/isolation/admission.js';
import { buildReadProfile } from '../src/isolation/sbx-read.js';
import { resolveBotSpawnOpts } from '../src/index.js';

describe('slice 5 isolation policy', () => {
  let f: ReturnType<typeof isolationFixture>;
  beforeEach(() => { f = isolationFixture(); });
  afterEach(() => { rmSync(f.root, { recursive: true, force: true }); });
  it('normalizes effective sets, private inbox and Codex temporary directory', () => {
    const p = f.policy();
    expect(p.writable).toEqual([f.workspace, join(f.workspace, '.cli2im-tmp')]);
    expect(p.inbox).toBe(join(f.paths.dataDir, 'inbox', scopeHash(f.workspace)));
    expect(p.readable).toContain(p.inbox);
    expect(p.writable).not.toContain(p.inbox);
    expect(p.hardDeny).toContain(join(f.root, 'bob'));
    expect(p.hardDeny).toContain(f.paths.memoryDir);
    expect(p.runtimeRead).not.toContain('/opt/homebrew/var');
  });
  it.each(['workspace-equal', 'workspace-parent', 'workspace-child', 'writable-other', 'memory-parent', 'memory-child',
    'install', 'bridge', 'plugin', 'readonly-parent', 'readonly-child', 'read-other', 'read-bridge', 'tmp-collision'])('rejects decision O conflict: %s', kind => {
    const alice = f.bot.userOverrides!.alice;
    const iso = f.bot.isolation!;
    if (kind === 'workspace-equal') f.bot.userOverrides!.bob.workingDirectory = f.workspace;
    if (kind === 'workspace-parent') alice.workingDirectory = f.root;
    if (kind === 'workspace-child') alice.workingDirectory = join(f.root, 'bob', 'nested');
    if (kind === 'writable-other') iso.writable = [join(f.root, 'bob')];
    if (kind === 'memory-parent') iso.writable = [f.paths.dataDir];
    if (kind === 'memory-child') iso.writable = [join(f.paths.memoryDir, 'nested')];
    if (kind === 'install') iso.writable = [f.paths.installDir];
    if (kind === 'bridge') iso.writable = [join(f.paths.dataDir, 'inbox')];
    if (kind === 'plugin') { f.bot.plugins = [f.workspace]; }
    if (kind === 'readonly-parent') iso.readable = [f.root];
    if (kind === 'readonly-child') iso.readable = [join(f.workspace, 'nested')];
    if (kind === 'read-other') iso.readable = [join(f.root, 'bob')];
    if (kind === 'read-bridge') iso.readable = [join(f.paths.dataDir, 'memory')];
    if (kind === 'tmp-collision') f.bot.userOverrides!.bob.workingDirectory = join(f.workspace, '.cli2im-tmp');
    expect(() => validateIsolationConfig(f.config, f.paths)).toThrow(/Isolation/);
  });
  it('checks cross-bot writers and canonical symlink aliases, including missing descendants', () => {
    f.config.bots.other = { ...f.bot, isolation: undefined, workingDirectory: join(f.workspace, 'child'), userOverrides: undefined };
    expect(() => validateIsolationConfig(f.config, f.paths)).toThrow(/overlap/);
    delete f.config.bots.other;
    symlinkSync(f.workspace, join(f.root, 'alias'));
    f.bot.userOverrides!.bob.workingDirectory = join(f.root, 'alias', 'missing');
    expect(() => validateIsolationConfig(f.config, f.paths)).toThrow(/overlap/);
  });
  it.each(['/', '/Users', '/Users/example', '/Volumes', '/Volumes/disk', '/usr/local/project', '/private/tmp'])('rejects high-risk workspace %s', path => {
    f.bot.workingDirectory = path;
    expect(() => validateIsolationConfig(f.config, f.paths)).toThrow();
  });
  it.each(['/opt/homebrew/var', '/Library/Keychains', '/private/var/db', '/Users/Shared', '/private/tmp/another-scope'])('rejects writable hard-deny exception %s', path => {
    f.bot.isolation!.writable = [path];
    expect(() => validateIsolationConfig(f.config, f.paths)).toThrow();
  });
  it('fingerprints canonical policy, mapping, SDK, executable identity and plugin bytes', () => {
    expect(fingerprint({ b: 2, a: 1 })).toBe(fingerprint({ a: 1, b: 2 }));
    const root = join(f.root, 'plugin'); mkdirSync(root); writeFileSync(join(root, 'SKILL.md'), 'one'); f.bot.plugins = [root];
    const base = f.policy().fingerprint;
    writeFileSync(join(root, 'SKILL.md'), 'two'); expect(f.policy().fingerprint).not.toBe(base);
    const params = { config: f.config, botName: 'bot', workspace: f.workspace, paths: f.paths, binaryPath: '/bin/cat' };
    expect(buildIsolationPolicy({ ...params, identityMapping: { a: 1 } }).fingerprint)
      .not.toBe(buildIsolationPolicy({ ...params, identityMapping: { a: 2 } }).fingerprint);
    expect(buildIsolationPolicy({ ...params, sdkVersions: '1' }).fingerprint)
      .not.toBe(buildIsolationPolicy({ ...params, sdkVersions: '2' }).fingerprint);
    expect(buildIsolationPolicy({ ...params, binaryPath: '/bin/ls' }).fingerprint)
      .not.toBe(buildIsolationPolicy(params).fingerprint);
  });
  it.each(['readable', 'writable'] as const)('fingerprints changes to the effective %s set', field => {
    f.bot.workingDirectory = f.workspace; f.bot.userOverrides = undefined;
    const base = f.policy().fingerprint;
    f.bot.isolation![field] = [...(f.bot.isolation![field] ?? []), join(f.root, 'extra')];
    expect(f.policy().fingerprint).not.toBe(base);
  });
  it('fingerprints enabling the plugin Skill tool even for an empty plugin directory', () => {
    f.bot.agent = 'claude-code';
    const base = f.policy();
    const plugin = join(f.root, 'plugin'); mkdirSync(plugin); f.bot.plugins = [plugin];
    const changed = f.policy();
    expect(base.tools).not.toContain('Skill'); expect(changed.tools).toContain('Skill');
    expect(changed.fingerprint).not.toBe(base.fingerprint);
  });
  it('refuses an executable-directory exception that would expose HOME', () => {
    expect(() => buildIsolationPolicy({ config: f.config, botName: 'bot', workspace: f.workspace, paths: f.paths,
      binaryPath: join(f.paths.home, 'agent') })).toThrow('too broad');
  });
  it('enforces Claude final tmp path length and stable short root', () => {
    f.bot.agent = 'claude-code';
    const p = f.policy();
    expect(p.tmpdir).toBe(`/private/tmp/c2i-${scopeHash(f.workspace).slice(0, 8)}`);
    expect(p.tools).toEqual(['Bash', 'WebFetch', 'WebSearch', 'TodoWrite']);
    expect(() => buildIsolationPolicy({ config: f.config, botName: 'bot', workspace: f.workspace,
      paths: { ...f.paths, claudeTmpRoot: join(f.root, 'very-long-root') }, binaryPath: '/bin/cat' })).toThrow('44');
  });
  it('subtracts hard denies per SBPL grant, with only narrow read exceptions and safe quoting', () => {
    f.bot.isolation!.readable = [join(f.paths.home, '.claude', 'private'), join(f.root, 'quote"雪')];
    const p = f.policy(); p.hardDeny.push(join(f.workspace, 'private')); const sbpl = buildReadProfile(p);
    expect(sbpl).toContain('(deny default)'); expect(sbpl).toContain('(require-not (subpath');
    expect(sbpl).toContain(JSON.stringify(join(f.root, 'quote"雪')));
    expect(sbpl).toContain(`(subpath ${JSON.stringify(join(f.paths.home, '.claude', 'private'))})`);
    expect(sbpl).not.toContain('allow file-write');
    expect(sbpl).not.toContain('allow network');
    expect(sbpl).not.toContain(`(allow file-read* (subpath ${JSON.stringify(f.paths.home)})`);
  });
  it('allows runtime metadata and literal roots without lifting the dyld parent hard denial', () => {
    const p = f.policy(); const sbpl = buildReadProfile(p);
    expect(p.hardDeny).toContain('/private/var/db');
    expect(p.runtimeRead).toContain('/private/var/db/dyld');
    expect(p.runtimeRead).toContain('/Library/Apple');
    expect(sbpl).toContain('(allow file-read-metadata)');
    expect(sbpl).toContain('(literal "/")'); expect(sbpl).not.toContain('(subpath "/")');
    expect(sbpl).toContain('(literal "/dev")'); expect(sbpl).not.toContain('(subpath "/dev")');
    expect(sbpl).toContain('(subpath "/dev/dtracehelper")');
    expect(sbpl).toContain('(subpath "/private/var/db/dyld")');
    expect(sbpl).not.toContain('(require-all (subpath "/private/var/db/dyld")');
    expect(sbpl).not.toContain('(require-all (subpath "/private/var/db")');
    // A narrower hard denial inside dyld still wins over the runtime exception.
    p.hardDeny.push('/private/var/db/dyld/blocked');
    expect(buildReadProfile(p)).toContain('(require-all (subpath "/private/var/db/dyld") (require-not (subpath "/private/var/db/dyld/blocked")))');
  });
  it.each(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CTI_CODEX_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'])('rejects provider credential %s without logging its value', key => {
    expect(() => assertNoProviderCredentials({ [key]: 'fixture-secret-value' })).toThrow('凭据变量');
    try { assertNoProviderCredentials({ [key]: 'fixture-secret-value' }); } catch (e) { expect(String(e)).not.toContain('fixture-secret-value'); }
  });
  it('integration: skips default workspace instructions, accepts only maintained absolute instructions', async () => {
    writeFileSync(join(f.workspace, 'AGENTS.md'), 'untrusted');
    expect((await resolveBotSpawnOpts({ botConfig: f.bot, workingDirectory: f.workspace })).appendSystemPrompt).toBeUndefined();
    f.bot.agentsFile = 'relative.md'; expect(() => assertAgentsFile(f.bot, [f.workspace])).toThrow();
    f.bot.agentsFile = join(f.root, 'bob', 'instructions.md');
    expect(() => assertAgentsFile(f.bot, [join(f.root, 'bob')])).toThrow();
    f.bot.agentsFile = join(f.root, 'maintained.md'); writeFileSync(f.bot.agentsFile, 'maintained');
    expect((await resolveBotSpawnOpts({ botConfig: f.bot, workingDirectory: f.workspace })).appendSystemPrompt).toBe('maintained');
    f.bot.isolation = undefined; f.bot.agentsFile = undefined;
    expect((await resolveBotSpawnOpts({ botConfig: f.bot, workingDirectory: f.workspace })).appendSystemPrompt).toBe('untrusted');
  });
});
