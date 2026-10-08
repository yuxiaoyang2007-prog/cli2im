import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isolationFixture } from './helpers/isolation.js';
import { assertAgentsFile, assertIsolationSearchPath, buildIsolationPolicy, fingerprint, isolationSearchPathDenied, scopeHash, validateIsolationConfig, validateIsolationSearchPath } from '../src/isolation/policy.js';
import { compileClaudeSettings } from '../src/isolation/claude.js';
import { assertNoProviderCredentials } from '../src/isolation/admission.js';
import { buildReadProfile } from '../src/isolation/sbx-read.js';
import { resolveBotSpawnOpts } from '../src/index.js';

describe('slice 5 isolation policy', () => {
  let f: ReturnType<typeof isolationFixture>;
  beforeEach(() => { f = isolationFixture(); });
  afterEach(() => { rmSync(f.root, { recursive: true, force: true }); });
  it.each([undefined, '', 'bin:/usr/bin', '.', '.:/usr/bin', ':/usr/bin', '/usr/bin:', '/usr/bin::/bin',
    '/usr/./bin', '/usr/bin/.', '/usr/../bin', '/usr/bin/..', '/usr//.//bin', '/usr//..//bin'])('PATH hygiene rejects missing, empty, relative or dot-segment entries: %s', PATH => {
    expect(() => buildIsolationPolicy({ config: f.config, botName: 'bot', workspace: f.workspace, paths: f.paths,
      binaryPath: '/bin/cat', effectiveEnv: { PATH } })).toThrow(/^UNSUPPORTED:.*PATH/);
  });
  it.each(['workspace', 'grant', 'inbox'])('PATH resolution rejects symlink targets containing .. through %s', kind => {
    f.bot.workingDirectory = f.workspace; f.bot.userOverrides = undefined;
    const root = kind === 'workspace' ? f.workspace : kind === 'inbox' ? f.policy().inbox : join(f.root, 'grant');
    if (kind === 'grant') f.bot.isolation!.writable = [root];
    mkdirSync(join(root, 'deep/a'), { recursive: true });
    mkdirSync(join(root, 'bin'));
    mkdirSync(join(f.root, 'trusted'));
    mkdirSync(join(f.root, 'bin'));
    symlinkSync(join(root, 'deep/a'), join(root, 'up'));
    const entry = join(f.root, 'trusted', 'search');
    symlinkSync(`${root}/up/../../bin`, entry);
    expect(realpathSync.native(entry)).toBe(realpathSync.native(join(root, 'bin')));
    expect(() => buildIsolationPolicy({ config: f.config, botName: 'bot', workspace: f.workspace, paths: f.paths,
      binaryPath: '/bin/cat', effectiveEnv: { PATH: `${entry}:/usr/bin:/bin` } })).toThrow(/^UNSUPPORTED:.*PATH/);
  });
  it('PATH resolution rewrites trusted symlinks and repeated slashes and drops missing or non-directory entries', () => {
    const outside = join(f.root, 'outside');
    symlinkSync(outside, join(f.root, 'trusted-alias'));
    mkdirSync(join(outside, '.bin')); mkdirSync(join(outside, '...'));
    writeFileSync(join(outside, 'file'), 'not a directory');
    const entries = [`${f.root}//trusted-alias//`, `${outside}/missing-bin`, `${outside}/file`, `${outside}/file/bin`,
      `${outside}/.bin`, `${outside}/...`, '/usr//bin/', '/bin'];
    const policy = buildIsolationPolicy({ config: f.config, botName: 'bot', workspace: f.workspace, paths: f.paths,
      binaryPath: '/bin/cat', effectiveEnv: { PATH: entries.join(':') } });
    expect(policy.searchPath).toEqual([outside, `${outside}/.bin`, `${outside}/...`, '/usr/bin', '/bin'].map(p => realpathSync.native(p)));
  });
  it('PATH resolution rejects an empty result rather than enabling cwd lookup', () => {
    expect(() => validateIsolationSearchPath(join(f.root, 'missing-bin'), [])).toThrow(/^UNSUPPORTED:.*PATH/);
  });
  it.each(['workspace', 'inbox', 'missing-grant'])('PATH resolution rejects ancestors of %s', kind => {
    f.bot.workingDirectory = f.workspace; f.bot.userOverrides = undefined;
    if (kind === 'missing-grant') f.bot.isolation!.writable = [join(f.root, 'outside', 'future-grant')];
    const entry = kind === 'workspace' ? f.root : kind === 'inbox' ? f.paths.dataDir : join(f.root, 'outside');
    expect(() => buildIsolationPolicy({ config: f.config, botName: 'bot', workspace: f.workspace, paths: f.paths,
      binaryPath: '/bin/cat', effectiveEnv: { PATH: `${entry}:/usr/bin` } })).toThrow(/^UNSUPPORTED:.*PATH/);
  });
  it('PATH resolution canonicalizes denied symlink targets with native semantics', () => {
    f.bot.workingDirectory = f.workspace; f.bot.userOverrides = undefined;
    mkdirSync(join(f.root, 'outside', 'deep'));
    symlinkSync(join(f.root, 'outside', 'deep'), join(f.root, 'via'));
    symlinkSync('via/..', join(f.root, 'grant'));
    f.bot.isolation!.writable = [join(f.root, 'grant')];
    expect(() => validateIsolationSearchPath(`${f.root}/outside:/usr/bin`, isolationSearchPathDenied(f.config, f.paths))).toThrow(/^UNSUPPORTED:.*PATH/);
  });
  it.each([
    ['codex', 'configured-dotdot'], ['codex', 'target-dotdot'],
    ['claude-code', 'configured-dotdot'], ['claude-code', 'target-dotdot'],
  ])('PATH denies actual allowed-user writable scopes for %s with %s', (agent, spelling) => {
    f.bot.agent = agent;
    mkdirSync(join(f.root, 'outside', 'deep'));
    mkdirSync(join(f.root, 'outside', 'alice', 'bin'), { recursive: true });
    symlinkSync(join(f.root, 'outside', 'deep'), join(f.root, 'via'));
    const configured = `${f.root}/via/../alice`;
    symlinkSync('via/../alice', join(f.root, 'workspace-link'));
    f.bot.userOverrides!.alice.workingDirectory = spelling === 'configured-dotdot'
      ? configured : join(f.root, 'workspace-link');
    expect(f.bot.allowFrom).toContain('alice');
    const nativeWorkspace = realpathSync.native(f.bot.userOverrides!.alice.workingDirectory!);
    expect(nativeWorkspace).toBe(join(f.root, 'outside', 'alice'));
    const policy = f.policy();
    expect(policy.workspace).toBe(f.workspace);
    expect(policy.writable).toContain(f.workspace);
    expect(nativeWorkspace).not.toBe(policy.workspace);
    if (agent === 'claude-code') {
      expect(compileClaudeSettings(policy, f.paths.home).sandbox.filesystem.allowWrite).toContain(policy.workspace);
    }
    expect(policy.searchPathDenied).toEqual(expect.arrayContaining(policy.writable));
    for (const root of [policy.workspace, nativeWorkspace]) {
      mkdirSync(join(root, 'bin'), { recursive: true });
      expect(policy.searchPathDenied).toContain(realpathSync.native(root));
      for (const entry of [root, join(root, 'bin')]) {
        const effectiveEnv = { PATH: `${entry}:/usr/bin:/bin` };
        expect(() => buildIsolationPolicy({ config: f.config, botName: 'bot', workspace: f.workspace,
          paths: f.paths, binaryPath: '/bin/cat', effectiveEnv })).toThrow(/^UNSUPPORTED:.*PATH overlaps/);
        expect(() => assertIsolationSearchPath(effectiveEnv, policy)).toThrow(/^UNSUPPORTED:.*PATH overlaps/);
      }
    }
  });
  it.each(['configured-dotdot', 'target-dotdot'])('PATH denies actual writable grants with %s', spelling => {
    f.bot.workingDirectory = f.workspace; f.bot.userOverrides = undefined;
    mkdirSync(join(f.root, 'outside', 'deep'));
    mkdirSync(join(f.root, 'outside', 'grant'));
    mkdirSync(join(f.root, 'grant'));
    symlinkSync(join(f.root, 'outside', 'deep'), join(f.root, 'via'));
    symlinkSync('via/../grant', join(f.root, 'grant-link'));
    const grant = spelling === 'configured-dotdot' ? `${f.root}/via/../grant` : join(f.root, 'grant-link');
    f.bot.isolation!.writable = [grant];
    const policy = f.policy();
    expect(policy.writable).toContain(join(f.root, 'grant'));
    expect(realpathSync.native(grant)).toBe(join(f.root, 'outside', 'grant'));
    for (const root of [join(f.root, 'grant'), realpathSync.native(grant)]) {
      mkdirSync(join(root, 'bin'));
      for (const entry of [root, join(root, 'bin')]) {
        expect(() => assertIsolationSearchPath({ PATH: `${entry}:/usr/bin` }, policy)).toThrow(/^UNSUPPORTED:.*PATH overlaps/);
      }
    }
  });
  it.skipIf(process.platform !== 'darwin')('PATH resolution rejects macOS case aliases in both containment directions', () => {
    mkdirSync(join(f.workspace, 'bin'));
    const alias = f.workspace.toUpperCase();
    expect(realpathSync.native(alias)).toBe(realpathSync.native(f.workspace));
    expect(() => validateIsolationSearchPath(`${alias}/BIN:/usr/bin`, [f.workspace])).toThrow(/^UNSUPPORTED:.*PATH/);
    expect(() => validateIsolationSearchPath(`${f.root}:/usr/bin`, [alias])).toThrow(/^UNSUPPORTED:.*PATH/);
    // Missing denied suffixes cannot obtain canonical casing from realpath yet.
    expect(() => validateIsolationSearchPath(`${f.workspace}:/usr/bin`, [`${alias}/FUTURE`])).toThrow(/^UNSUPPORTED:.*PATH/);
  });
  it.each(['workspace', 'other-scope', 'other-bot', 'grant', 'temporary', 'inbox', 'other-inbox', 'symlink', 'normalized'])('PATH hygiene rejects canonical writable and inbox entries: %s', kind => {
    let entry = join(f.workspace, 'bin');
    if (kind === 'other-scope') entry = join(f.root, 'bob', 'bin');
    if (kind === 'other-bot') {
      f.config.bots.other = { ...f.bot, isolation: undefined, workingDirectory: join(f.root, 'other'), userOverrides: undefined };
      entry = join(f.root, 'other', 'bin');
    }
    if (kind === 'grant') {
      f.bot.workingDirectory = f.workspace; f.bot.userOverrides = undefined;
      f.bot.isolation!.writable = [join(f.root, 'grant')]; entry = join(f.root, 'grant', 'bin');
    }
    if (kind === 'temporary') entry = join(f.policy().tmpdir, 'bin');
    if (kind === 'inbox') entry = join(f.policy().inbox, 'bin');
    if (kind === 'other-inbox') entry = join(f.paths.dataDir, 'inbox', scopeHash(join(f.root, 'bob')), 'bin');
    if (kind === 'symlink') { symlinkSync(f.workspace, join(f.root, 'alias')); entry = join(f.root, 'alias', 'bin'); }
    if (kind === 'normalized') entry = `${f.workspace}/../alice/bin`;
    if (kind !== 'normalized') mkdirSync(entry, { recursive: true });
    expect(() => buildIsolationPolicy({ config: f.config, botName: 'bot', workspace: f.workspace, paths: f.paths,
      binaryPath: '/bin/cat', effectiveEnv: { PATH: `${entry}:/usr/bin:/bin` } })).toThrow(/^UNSUPPORTED:.*PATH/);
  });
  it('fingerprints PATH values and order without retaining other environment values', () => {
    const params = { config: f.config, botName: 'bot', workspace: f.workspace, paths: f.paths, binaryPath: '/bin/cat' };
    const base = buildIsolationPolicy({ ...params, effectiveEnv: { PATH: '/usr/bin:/bin' } });
    for (const PATH of ['/bin:/usr/bin', `/usr/bin:/bin:${f.root}/outside`]) {
      expect(buildIsolationPolicy({ ...params, effectiveEnv: { PATH } }).fingerprint).not.toBe(base.fingerprint);
    }
    const env = { PATH: '/usr/bin:/bin', FIXTURE_SECRET: 'never-store-this-value' };
    const same = buildIsolationPolicy({ ...params, effectiveEnv: env });
    expect(same.fingerprint).toBe(base.fingerprint);
    expect(JSON.stringify(same)).not.toContain(env.FIXTURE_SECRET);
    expect(same.searchPath).toEqual(['/usr/bin', '/bin'].map(p => realpathSync.native(p)));
    symlinkSync('/usr/bin', join(f.root, 'trusted-alias'));
    expect(buildIsolationPolicy({ ...params, effectiveEnv: { PATH: `${f.root}/missing:${f.root}/trusted-alias:/bin` } }).fingerprint).toBe(base.fingerprint);
  });
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
    const params = { config: f.config, botName: 'bot', workspace: f.workspace, paths: f.paths, effectiveEnv: { PATH: '/usr/bin:/bin' }, binaryPath: '/bin/cat' };
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
      effectiveEnv: { PATH: '/usr/bin:/bin' }, binaryPath: join(f.paths.home, 'agent') })).toThrow('too broad');
  });
  it('enforces Claude final tmp path length and stable short root', () => {
    f.bot.agent = 'claude-code';
    const p = f.policy();
    expect(p.tmpdir).toBe(`/private/tmp/c2i-${scopeHash(f.workspace).slice(0, 8)}`);
    expect(p.tools).toEqual(['Bash', 'WebFetch', 'WebSearch']);
    expect(() => buildIsolationPolicy({ config: f.config, botName: 'bot', workspace: f.workspace,
      paths: { ...f.paths, claudeTmpRoot: join(f.root, 'very-long-root') }, effectiveEnv: { PATH: '/usr/bin:/bin' }, binaryPath: '/bin/cat' })).toThrow('44');
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
