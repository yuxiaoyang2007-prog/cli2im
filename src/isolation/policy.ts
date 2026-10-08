import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalPath } from '../runtime/execution-scope.js';
import { getCli2imDataDir } from '../util/data-dir.js';
import type { AppConfig, BotConfig, SpawnOpts } from '../types.js';
import { compileClaudeSettings, validateClaudePlugins } from './claude.js';
import { codexConfigSources, codexPermissionArgs } from './codex.js';
import { assertSupportedIsolationAgent } from './supported.js';

export interface IsolationPolicy {
  scopeKey: string;
  workspace: string;
  tmpdir: string;
  inbox: string;
  readable: string[];
  writable: string[];
  runtimeRead: string[];
  hardDeny: string[];
  readExceptions: string[];
  tools: string[];
  plugins: string[];
  skills: string[];
  fingerprint: string;
}
export interface PolicyPaths {
  home: string; dataDir: string; memoryDir: string; installDir: string; claudeTmpRoot: string;
  codexSystemConfigs?: string[];
}
export function policyPaths(config: Pick<AppConfig, 'memory'>, overrides: Partial<PolicyPaths> = {}): PolicyPaths {
  const home = overrides.home ?? homedir();
  const dataDir = overrides.dataDir ?? getCli2imDataDir();
  const expand = (path: string) => path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const installDir = basename(moduleDir) === 'isolation' ? resolve(moduleDir, '../..') : resolve(moduleDir, '..');
  return { home, dataDir, memoryDir: expand(config.memory?.dir ?? join(dataDir, 'memory')),
    installDir, claudeTmpRoot: '/private/tmp', ...overrides };
}
export function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('../') && rel !== '..' && !isAbsolute(rel));
}
const overlap = (a: string, b: string) => contains(a, b) || contains(b, a);
const normalized = (paths: string[]) => [...new Set(paths.map(canonicalPath))].sort();
export function stableJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableJSON(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const fingerprint = (value: unknown): string => createHash('sha256').update(stableJSON(value)).digest('hex');
export const scopeHash = (scopeKey: string): string => createHash('sha256').update(scopeKey).digest('hex').slice(0, 32);
export function scopeTmpdir(agent: string, workspace: string, paths: PolicyPaths): string {
  return agent === 'claude-code' ? join(paths.claudeTmpRoot, `c2i-${scopeHash(workspace).slice(0, 8)}`) : join(workspace, '.cli2im-tmp');
}
function scopes(config: Pick<AppConfig, 'bots'>, paths: PolicyPaths) {
  return Object.entries(config.bots).flatMap(([bot, value]) => [value.workingDirectory,
    ...Object.values(value.userOverrides ?? {}).flatMap(v => v.workingDirectory ? [v.workingDirectory] : [])]
    .map(path => {
      const workspace = canonicalPath(path);
      const tmpdir = canonicalPath(scopeTmpdir(value.agent, workspace, paths));
      return { bot, workspace, tmpdir, writable: normalized([workspace, ...(value.isolation?.enabled ? [tmpdir] : []), ...(value.isolation?.writable ?? [])]) };
    }));
}
const systemHardDeny = ['/opt/homebrew/var', '/Library/Keychains', '/private/var/db', '/private/var/folders', '/tmp', '/private/tmp', '/Volumes', '/Users/Shared'];
const sensitiveHome = (home: string) => ['.claude', '.claude.json', '.codex', '.gemini', 'Library', '.ssh', '.gnupg', '.aws', '.config',
  '.zshrc', '.zshenv', '.zprofile', '.zlogin', '.bashrc', '.bash_profile', '.profile', '.bash_login'].map(p => join(home, p));
export function isolationWritablePaths(config: Pick<AppConfig, 'bots'>, paths: PolicyPaths): string[] {
  return normalized(scopes(config, paths).flatMap(s => s.writable));
}
function unsafeWorkspace(path: string, paths: PolicyPaths): boolean {
  const home = canonicalPath(paths.home);
  const exact = normalized(['/', home, '/Users', '/Volumes', '/private', '/tmp', '/private/tmp',
    '/private/var', '/private/var/folders', join(home, 'Desktop'), join(home, 'Downloads')]);
  return exact.includes(path) || ['/Users', '/Volumes'].includes(dirname(path))
    || normalized(['/System', '/Library', '/Applications', '/bin', '/sbin', '/usr', '/etc', '/opt', '/dev', '/private/var/db'])
      .some(root => contains(root, path));
}
/** Decision O is checked against all configured bots, including non-isolated writers. */
export function validateIsolationConfig(config: Pick<AppConfig, 'bots' | 'memory'>, paths = policyPaths(config)): void {
  if (!Object.values(config.bots).some(b => b.isolation?.enabled)) return;
  for (const bot of Object.values(config.bots)) if (bot.isolation?.enabled) assertSupportedIsolationAgent(bot.agent);
  const all = scopes(config, paths);
  const protectedReadRoots = normalized([paths.memoryDir, paths.installDir, paths.dataDir, join(paths.home, '.cli2im')]);
  const protectedRoots = normalized([...protectedReadRoots, ...Object.values(config.bots).flatMap(b => b.plugins ?? [])]);
  if (all.some(scope => scope.writable.some(w => protectedRoots.some(root => overlap(w, root))))) {
    throw new Error('Isolation configuration contains a writer overlapping protected data');
  }
  for (const [name, bot] of Object.entries(config.bots)) {
    if (!bot.isolation?.enabled) continue;
    const own = all.filter(s => s.bot === name);
    const ro = normalized(bot.isolation.readable ?? []);
    if (ro.some(root => normalized(sensitiveHome(paths.home)).some(deny => contains(root, deny)))) throw new Error('Isolation readable grant must not expose a hard-denied root');
    for (const scope of own) {
      if (scope.tmpdir === scope.workspace || (bot.agent !== 'claude-code' && !contains(scope.workspace, scope.tmpdir))) throw new Error('Isolation temporary directory escapes workspace');
      if (unsafeWorkspace(scope.workspace, paths)) throw new Error('Isolation workspace is a high-risk directory');
      for (const writable of scope.writable) {
        if (writable !== scope.workspace && writable !== scope.tmpdir
          && !contains(scope.workspace, writable)
          && normalized(systemHardDeny).some(root => overlap(writable, root))) throw new Error('Isolation writable grant overlaps a hard-denied directory');
        if ([...protectedRoots, ...normalized(sensitiveHome(paths.home))].some(root => overlap(writable, root))) throw new Error('Isolation writable directory overlaps protected data');
        if (ro.some(root => overlap(writable, root))) throw new Error('Isolation read-only grant overlaps writable directory');
        if (all.some(other => other !== scope && other.writable.some(root => overlap(writable, root)))) {
          throw new Error('Isolation execution scopes overlap');
        }
      }
      if (ro.some(root => protectedReadRoots.some(protectedRoot => overlap(root, protectedRoot))
        || all.some(other => other !== scope && other.writable.some(w => overlap(root, w))))) {
        throw new Error('Isolation readable grant overlaps protected data or another scope');
      }
    }
    assertAgentsFile(bot, all.flatMap(s => s.writable));
  }
}
export function assertAgentsFile(bot: BotConfig, writable: string[]): string | undefined {
  if (!bot.isolation?.enabled || bot.agentsFile === undefined || bot.agentsFile === false || bot.agentsFile === '') return;
  if (!isAbsolute(bot.agentsFile)) {
    throw new Error('Isolation agentsFile must be an absolute path outside every writable scope');
  }
  const roots = [...writable.map(p => resolve(p)), ...writable.map(canonicalPath)];
  let links = 0;
  const follow = (path: string): string => {
    let current = '/';
    for (const part of path.split('/').filter(Boolean)) {
      current = join(current, part);
      if (roots.some(root => contains(root, current))) throw new Error('Isolation agentsFile resolution crosses a writable scope');
      try {
        if (lstatSync(current).isSymbolicLink()) {
          if (++links > 40) throw new Error('Isolation agentsFile symlink loop');
          const target = readlinkSync(current);
          current = follow(isAbsolute(target) ? target : `${dirname(current)}/${target}`);
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return current;
  };
  return follow(bot.agentsFile);
}
// Runtime-only OS/toolchain directories from PLAN 5.2; no HOME, Homebrew var or shared tmp grant.
// Root and /dev are directory literals in SBPL, never recursive filesystem grants.
export const RUNTIME_READ = ['/', '/bin', '/sbin', '/usr', '/System', '/private/etc', '/private/var/db/dyld', '/Library/Apple',
  '/dev', '/dev/null', '/dev/zero', '/dev/urandom', '/dev/random', '/dev/fd', '/dev/dtracehelper',
  '/Library/Developer/CommandLineTools', ...['bin', 'sbin', 'lib', 'libexec', 'opt', 'Cellar', 'share', 'etc', 'include', 'Frameworks'].map(p => `/opt/homebrew/${p}`)];
// Only this OS runtime subtree may override the /private/var/db hard denial.
export const RUNTIME_READ_EXCEPTIONS = ['/private/var/db/dyld'];
export type IsolationProductionParameters = Pick<SpawnOpts, 'sandboxMode' | 'permissionMode' | 'autoApprove' | 'addDirs'
  | 'sandbox' | 'sandboxBoxRoots' | 'sandboxOtherProtectedRoots'> & { envKeys: string[] };
function pluginHash(root: string): string {
  const entries: Array<[string, string]> = [];
  const visit = (path: string) => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error('Isolation plugin symlink is not supported');
    if (info.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
    else if (info.isFile()) entries.push([relative(root, path), createHash('sha256').update(readFileSync(path)).digest('hex')]);
    else throw new Error('Isolation plugin contains a non-regular file');
  };
  visit(root);
  return fingerprint(entries);
}
export function buildIsolationPolicy(params: {
  config: Pick<AppConfig, 'bots' | 'memory'>; botName: string; workspace: string;
  paths?: PolicyPaths; binaryPath: string; identityMapping?: unknown; production?: IsolationProductionParameters; sdkVersions?: unknown; uid?: number;
}): IsolationPolicy {
  const { config, botName } = params;
  const paths = params.paths ?? policyPaths(config);
  validateIsolationConfig(config, paths);
  const bot = config.bots[botName];
  const workspace = canonicalPath(params.workspace);
  const all = scopes(config, paths);
  const own = all.find(s => s.bot === botName && s.workspace === workspace);
  if (!own) throw new Error('Isolation workspace is not a configured execution scope');
  const tmpdir = own.tmpdir;
  if (bot.agent === 'claude-code' && Buffer.byteLength(join(tmpdir, `claude-${params.uid ?? process.getuid?.() ?? 0}`)) > 44) {
    throw new Error('UNSUPPORTED: Claude temporary path exceeds 44 bytes');
  }
  const inbox = canonicalPath(join(paths.dataDir, 'inbox', scopeHash(workspace)));
  if (all.some(s => s.writable.some(w => overlap(w, inbox)))) throw new Error('Isolation inbox overlaps an agent writable directory');
  const plugins = normalized(bot.plugins ?? []);
  const readable = normalized([...(bot.isolation?.readable ?? []), inbox, ...own.writable]);
  const binaryDirectory = canonicalPath(dirname(params.binaryPath));
  if (contains(binaryDirectory, canonicalPath(paths.home)) || all.some(s => contains(binaryDirectory, s.workspace))) {
    throw new Error('Isolation executable directory is too broad or agent-writable');
  }
  const runtimeRead = normalized([...RUNTIME_READ, binaryDirectory]);
  const hardDeny = normalized(['.claude', '.claude.json', '.codex', '.gemini', '.cli2im', 'Library', '.ssh', '.gnupg', '.aws', '.config',
    '.zshrc', '.zshenv', '.zprofile', '.zlogin', '.bashrc', '.bash_profile', '.profile', '.bash_login'].map(p => join(paths.home, p)).concat([
    ...systemHardDeny,
    paths.dataDir, paths.memoryDir, paths.installDir, ...plugins,
    ...all.filter(s => s !== own).flatMap(s => s.writable),
  ]));
  const policy = { scopeKey: workspace, workspace, tmpdir, inbox, readable, writable: own.writable, runtimeRead, hardDeny,
    readExceptions: normalized([...own.writable, inbox, ...(bot.isolation?.readable ?? [])]),
    tools: bot.agent === 'claude-code' ? ['Bash', 'WebFetch', 'WebSearch', 'TodoWrite', ...(plugins.length ? ['Skill'] : [])] : [],
    plugins, skills: [...(bot.skills ?? [])].sort() };
  let launchPolicy: unknown;
  if (bot.agent === 'claude-code') {
    validateClaudePlugins(plugins);
    launchPolicy = { settings: compileClaudeSettings({ ...policy, fingerprint: '' }, paths.home),
      extraArgs: { restricted: null }, settingSources: [], strictMcpConfig: true, mcpServers: {}, tools: policy.tools };
  } else if (bot.agent === 'codex') {
    launchPolicy = { args: codexPermissionArgs({ ...policy, fingerprint: '' }), sources: codexConfigSources(workspace, paths.home, paths.codexSystemConfigs) };
  }
  const binaryStat = statSync(params.binaryPath);
  const production = params.production;
  return { ...policy, fingerprint: fingerprint({ agent: bot.agent, policy, launchPolicy,
    binary: { realpath: canonicalPath(params.binaryPath), size: binaryStat.size, mtime: binaryStat.mtimeMs },
    // Bump when the SBPL operations or exception semantics change.
    profileVersion: 2, runtimeReadExceptions: normalized(RUNTIME_READ_EXCEPTIONS),
    production: production ? { sandboxMode: production.sandboxMode, permissionMode: production.permissionMode,
      autoApprove: production.autoApprove, addDirs: normalized(production.addDirs ?? []), sandbox: production.sandbox,
      sandboxBoxRoots: normalized(production.sandboxBoxRoots ?? []),
      sandboxOtherProtectedRoots: normalized(production.sandboxOtherProtectedRoots ?? []),
      envKeys: [...new Set(production.envKeys)].sort() } : {},
    sdkVersions: params.sdkVersions ?? {}, identityMapping: params.identityMapping ?? config.memory?.people ?? {},
    plugins: plugins.map(root => [root, pluginHash(root)]) }) };
}
