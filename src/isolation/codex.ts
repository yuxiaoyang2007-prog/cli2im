import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalPath } from '../runtime/execution-scope.js';
import { RUNTIME_READ_EXCEPTIONS, scopeHash, type IsolationPolicy } from './policy.js';

export function isolatedCodexHome(dataDir: string, botName: string): string {
  return join(canonicalPath(dataDir), 'codex-home', createHash('sha256').update(botName).digest('hex').slice(0, 16));
}
/** Bridge-owned state only. Never seed it from the operator's login/configuration. */
export function prepareCodexHome(path: string): void {
  if (canonicalPath(path) !== path) throw new Error('UNSUPPORTED: Codex home contains a symlink');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('UNSUPPORTED: Invalid Codex home');
  chmodSync(path, 0o700);
}
export function isolationEnvironment(env: Record<string, string>, policy?: IsolationPolicy): Record<string, string> {
  const developerDir = policy ? policy.developerDir : existsSync('/Library/Developer/CommandLineTools') ? '/Library/Developer/CommandLineTools' : undefined;
  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', ...(developerDir ? { DEVELOPER_DIR: developerDir } : {}), ...(policy?.codexHome ? { CODEX_HOME: policy.codexHome } : {}) };
}

export const CODEX_SYSTEM_CONFIGS = ['/etc/codex/config.toml', '/etc/codex/managed_config.toml', '/etc/codex/requirements.toml'];
function exists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export type CodexConfigEnv = { HOME?: string; CODEX_HOME?: string };
export function codexConfigEnvironment(env: CodexConfigEnv) {
  const home = canonicalPath(env.HOME ?? '/');
  return { HOME: home, CODEX_HOME: canonicalPath(env.CODEX_HOME || join(home, '.codex')) };
}
export function codexConfigSources(workspace: string, effectiveEnv: CodexConfigEnv, systemPaths = CODEX_SYSTEM_CONFIGS) {
  const { HOME: home, CODEX_HOME: codexHome } = codexConfigEnvironment(effectiveEnv);
  const stop = canonicalPath(home);
  const userDirs = new Set([canonicalPath(join(home, '.codex')), codexHome]);
  for (let dir = canonicalPath(workspace); ; dir = dirname(dir)) {
    const configDir = canonicalPath(join(dir, '.codex'));
    // --ignore-user-config already excludes these user-level directories.
    if (!userDirs.has(configDir) && exists(join(configDir, 'config.toml'))) throw new Error('UNSUPPORTED: Codex project configuration is present');
    if (dir === stop || dir === dirname(dir)) break;
  }
  return systemPaths.map(path => ({ path, exists: exists(path) }));
}

/** TOML basic strings, including quoted table keys (never SDK dotted-key flattening). */
export function tomlString(value: string): string {
  return JSON.stringify(value).replace(/\u007f/g, '\\u007f');
}
export function tomlInline(value: unknown): string {
  if (typeof value === 'string') return tomlString(value);
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlInline).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([key, item]) => `${tomlString(key)}=${tomlInline(item)}`).join(',')}}`;
  throw new Error('Unsupported inline TOML value');
}

export function codexFilesystem(policy: IsolationPolicy): Record<string, string> {
  // Codex 0.160's embedded seatbelt :minimal profile grants system runtime
  // paths, not HOME. Explicit hard denials below constrain its /private/var/db.
  const filesystem: Record<string, string> = {
    ':root': 'deny', ':minimal': 'read', ':tmpdir': 'write', ':slash_tmp': 'deny', '/private/var/folders': 'deny',
  };
  for (const path of policy.runtimeRead.filter(p => p !== '/' && p !== '/dev')) filesystem[path] = 'read';
  for (const path of policy.readable) filesystem[path] = 'read';
  for (const path of policy.hardDeny) filesystem[path] = 'deny';
  for (const path of [...policy.readExceptions, ...RUNTIME_READ_EXCEPTIONS]) filesystem[path] = 'read';
  for (const path of policy.writable) filesystem[path] = 'write';
  for (const dir of ['.claude', '.codex']) filesystem[join(policy.workspace, dir)] = 'read';
  return filesystem;
}

export function codexPermissionArgs(policy: IsolationPolicy): string[] {
  const name = `cli2im-${scopeHash(policy.scopeKey).slice(0, 8)}`;
  const filesystem = codexFilesystem(policy);
  return [
    '--ignore-user-config', '--ignore-rules',
    '-c', `default_permissions=${tomlString(name)}`,
    '-c', `permissions=${tomlInline({ [name]: { extends: ':workspace', filesystem, network: { enabled: true } } })}`,
    ...['memories', 'hooks', 'plugins', 'apps', 'multi_agent', 'goals'].flatMap(feature => ['--disable', feature]),
    '-c', 'mcp_servers={}', '-c', 'notify=[]', '-c', 'project_root_markers=[]',
  ];
}
