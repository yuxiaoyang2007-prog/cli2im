import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isolationFixture } from './helpers/isolation.js';
import { CLAUDE_WRITE_DEVICES, allowedClaudeTool, claudeToolGuard, compileClaudeSettings, validateClaudePlugins } from '../src/isolation/claude.js';
import { ClaudeCodePlugin, ClaudeCodeVirtualProcess } from '../src/agents/claude-code.js';
import { PROVIDER_CREDENTIAL } from '../src/isolation/admission.js';
import { loadConfig } from '../src/config/loader.js';
import { stringify } from 'yaml';

vi.mock('../src/security/child-env.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/security/child-env.js')>();
  return { ...actual, buildChildEnv: (provider: any, env: any) => actual.buildChildEnv(provider, env, { PATH: '/usr/bin:/bin' }) };
});

describe('slice 6 Claude isolation', () => {
  let f: ReturnType<typeof isolationFixture>;
  beforeEach(() => { f = isolationFixture(); f.bot.agent = 'claude-code'; });
  afterEach(() => { vi.restoreAllMocks(); rmSync(f.root, { recursive: true, force: true }); });
  const settings = () => compileClaudeSettings(f.policy(), f.paths.home);

  it.each([false, true])('compiles complete implicit write denials with synthetic HOME, directories present=%s', present => {
    if (present) for (const name of ['.npm/_logs', '.claude/debug']) mkdirSync(join(f.paths.home, name), { recursive: true });
    f.bot.isolation!.readable!.push(join(f.paths.home, '.claude/debug'));
    const fs = settings().sandbox.filesystem;
    expect(fs.denyRead).toEqual(['/']);
    expect(fs.allowRead).not.toContain('/'); expect(fs.allowRead).not.toContain('/dev');
    expect(fs.denyWrite).toEqual(expect.arrayContaining(['/tmp/claude', '/private/tmp/claude', join(f.paths.home, '.npm/_logs'), join(f.paths.home, '.claude/debug')]));
    expect(fs.denyWrite).not.toContain('/private/tmp');
    for (const device of CLAUDE_WRITE_DEVICES) expect(fs.denyWrite).not.toContain(device);
    expect(fs.allowWrite).toEqual(f.policy().writable);
    const names = settings().sandbox.credentials.envVars.map(v => v.name);
    expect(names.length).toBeGreaterThan(20);
    for (const name of names) expect(PROVIDER_CREDENTIAL.test(name)).toBe(true);
    expect(names).toContain('GOOGLE_ACCESS_TOKEN');
  });
  it('denies read-only subtrees inside implicit default write grants', () => {
    const p = f.policy(); p.readable.push('/private/tmp/claude/reference'); p.readExceptions.push('/private/tmp/claude/reference');
    expect(compileClaudeSettings(p, f.paths.home).sandbox.filesystem.denyWrite).toContain('/private/tmp/claude/reference');
  });
  it('refuses paths whose literal spelling the CLI would interpret as a glob', () => {
    const p = f.policy(); p.readable.push(join(f.root, 'literal[1]'));
    expect(() => compileClaudeSettings(p, f.paths.home)).toThrow('UNSUPPORTED');
  });
  it('rejects both directions of unrepresentable read grants and retains deeper denials', () => {
    const p = f.policy(); p.hardDeny.push(join(p.workspace, 'secret'));
    expect(() => compileClaudeSettings(p, f.paths.home)).toThrow('UNSUPPORTED');
    const other = f.policy(); other.runtimeRead.push(join(f.paths.home, '.claude/bin'));
    expect(() => compileClaudeSettings(other, f.paths.home)).toThrow('UNSUPPORTED');
    const nested = f.policy(); nested.readable.push(join(f.paths.home, '.claude/private'));
    nested.readExceptions.push(join(f.paths.home, '.claude/private'));
    expect(() => compileClaudeSettings(nested, f.paths.home)).not.toThrow();
    nested.hardDeny.push(join(f.paths.home, '.claude/private/deeper'));
    expect(() => compileClaudeSettings(nested, f.paths.home)).toThrow('UNSUPPORTED');
  });
  it.each(['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'NotebookEdit', 'LS', 'Task', 'mcp__server__read', 'unknown'])('denies tool %s', name => {
    expect(allowedClaudeTool(f.policy(), name, {})).toBe(false);
  });
  it('PreToolUse denies exceptions, timeout, abort and sandbox bypass', async () => {
    const p = f.policy();
    const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pwd' } } as any;
    const context = { signal: new AbortController().signal };
    const denied = { hookSpecificOutput: expect.objectContaining({ permissionDecision: 'deny' }) };
    expect(await claudeToolGuard(p)(input, 't', context)).toEqual({});
    expect(await claudeToolGuard(p, () => { throw new Error('failure'); })(input, 't', context)).toMatchObject(denied);
    expect(await claudeToolGuard(p, () => new Promise(() => {}), 5)(input, 't', context)).toMatchObject(denied);
    expect(await claudeToolGuard(p)({ ...input, tool_input: { dangerouslyDisableSandbox: true } }, 't', context)).toMatchObject(denied);
    expect(await claudeToolGuard(p)(input, 't', { signal: AbortSignal.abort() })).toMatchObject(denied);
  });
  it('validates skills-only plugins, rejects every alternate capability and symlink', () => {
    const plugin = join(f.root, 'plugin'); mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
    mkdirSync(join(plugin, 'skills')); writeFileSync(join(plugin, 'skills', 'SKILL.md'), '# Skill');
    for (const capability of ['hooks', 'mcpServers', 'agents', 'commands', 'lspServers']) {
      writeFileSync(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'test', [capability]: {} }));
      expect(() => validateClaudePlugins([plugin])).toThrow('UNSUPPORTED');
    }
    writeFileSync(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'test', skills: './skills' }));
    expect(() => validateClaudePlugins([plugin])).not.toThrow();
    f.bot.plugins = [plugin]; f.bot.skills = ['test:one'];
    expect(allowedClaudeTool(f.policy(), 'Skill', { skill: 'test:one' })).toBe(true);
    expect(allowedClaudeTool(f.policy(), 'Skill', { skill: 'test:two' })).toBe(false);
    symlinkSync(f.workspace, join(plugin, 'skills/link'));
    expect(() => validateClaudePlugins([plugin])).toThrow('UNSUPPORTED');
  });
  it('configuration rejects MCP even with an empty table', () => {
    const file = join(f.root, 'config.yaml');
    writeFileSync(file, stringify({ ...f.config, bots: { bot: { ...f.bot, mcpServers: {} } } }));
    expect(() => loadConfig(file)).toThrow('mcpServers');
  });
  const skillPlugin = (source: string) => {
    const plugin = join(f.root, 'frontmatter-plugin');
    mkdirSync(join(plugin, 'skills', 'nested', 'example'), { recursive: true });
    writeFileSync(join(plugin, 'skills', 'nested', 'example', 'SKILL.md'), source);
    return plugin;
  };
  it.each(['hooks', 'mcpServers', 'lspServers', 'agent', 'context'])('rejects skill frontmatter capability %s even when empty', key => {
    const plugin = skillPlugin(`---\nname: example\n${key}:\n---\n# Skill`);
    expect(() => validateClaudePlugins([plugin])).toThrow('UNSUPPORTED');
    f.bot.plugins = [plugin];
    expect(() => f.policy()).toThrow('UNSUPPORTED');
  });
  it.each([
    ['invalid YAML', '---\nname: [unfinished\n---\n# Skill'],
    ['unterminated', '---\nname: example\n# Skill'],
    ['duplicate keys', '---\nname: one\nname: two\n---\n# Skill'],
    ['sequence', '---\n- name\n---\n# Skill'],
    ['scalar', '---\nexample\n---\n# Skill'],
    ['unknown alias', '---\nname: *missing\n---\n# Skill'],
  ])('fails closed for %s skill frontmatter', (_name, source) => {
    expect(() => validateClaudePlugins([skillPlugin(source)])).toThrow('UNSUPPORTED');
  });
  it('rejects capabilities introduced by YAML merge keys', () => {
    const plugin = skillPlugin('---\ndefaults: &defaults\n  hooks: {}\n<<: *defaults\n---\n# Skill');
    expect(() => validateClaudePlugins([plugin])).toThrow('UNSUPPORTED');
  });
  it.each([
    ['no frontmatter', '# Skill\nUse hooks as an ordinary word.'],
    ['ordinary fields', '---\nname: example\ndescription: A fixture\nallowed-tools: Bash, Read\n---\n# Skill'],
    ['empty frontmatter', '---\n---\n# Skill'],
    ['BOM and CRLF', '\uFEFF---\r\nname: example\r\nallowed-tools: [Bash]\r\n---\r\n# Skill'],
  ])('accepts skills with %s', (_name, source) => {
    expect(() => validateClaudePlugins([skillPlugin(source)])).not.toThrow();
  });
  it.each([false, true])('integration: SDK options snapshot, isolation=%s, resume and autoApprove guard', async isolated => {
    const query = vi.fn(() => (async function* () {})());
    const plugin = new ClaudeCodePlugin('/fixture/claude', query as any);
    const proc = plugin.resume('session', { workingDirectory: f.workspace, permissionMode: 'bypass', autoApprove: true,
      model: 'model', reasoningEffort: 'high', env: { HOME: f.paths.home, ...(isolated ? { CLAUDE_CODE_TMPDIR: f.policy().tmpdir } : {}) }, addDirs: ['/ignored'],
      ...(isolated ? { isolation: f.policy() } : {}) }) as ClaudeCodeVirtualProcess;
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'hello' }));
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    const options = (query.mock.calls as any)[0][0].options;
    const normalize = (value: any, key = ''): any => {
      if (key === 'abortController') return '<AbortController>';
      if (typeof value === 'function') return '<function>';
      if (typeof value === 'string') return value.replaceAll(f.root, '<fixture>').replace(/c2i-[a-f0-9]{8}/g, 'c2i-<scope>').replace(/inbox\/[a-f0-9]{32}/g, 'inbox/<scope>');
      if (Array.isArray(value)) return value.map(item => normalize(item));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, k)]));
      return value;
    };
    const snapshot = normalize(options);
    expect(snapshot).toMatchSnapshot();
    if (isolated) {
      expect(options).not.toHaveProperty('additionalDirectories');
      expect(options.tools).toEqual(['Bash', 'WebFetch', 'WebSearch', 'TodoWrite']);
      expect(await proc.canUseTool('Bash', { dangerouslyDisableSandbox: true }, { toolUseID: 'id', signal: new AbortController().signal })).toMatchObject({ behavior: 'deny' });
      expect(await proc.canUseTool('Read', {}, { toolUseID: 'id', signal: new AbortController().signal })).toMatchObject({ behavior: 'deny' });
    }
    proc.kill();
  });
});
