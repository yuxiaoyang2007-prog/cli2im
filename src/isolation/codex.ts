import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalPath } from '../runtime/execution-scope.js';
import { RUNTIME_READ_EXCEPTIONS, scopeHash, type IsolationPolicy } from './policy.js';

export const CODEX_SYSTEM_CONFIGS = ['/etc/codex/config.toml', '/etc/codex/managed_config.toml', '/etc/codex/requirements.toml'];
function exists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export function codexConfigSources(workspace: string, home: string, systemPaths = CODEX_SYSTEM_CONFIGS) {
  const stop = canonicalPath(home);
  const userDirs = new Set([canonicalPath(join(home, '.codex')),
    ...(process.env.CODEX_HOME ? [canonicalPath(process.env.CODEX_HOME)] : [])]);
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

export function codexPermissionArgs(policy: IsolationPolicy): string[] {
  const name = `cli2im-${scopeHash(policy.scopeKey).slice(0, 8)}`;
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
  return [
    '--ignore-user-config', '--ignore-rules',
    '-c', `default_permissions=${tomlString(name)}`,
    '-c', `permissions=${tomlInline({ [name]: { extends: ':workspace', filesystem, network: { enabled: true } } })}`,
    ...['memories', 'hooks', 'plugins', 'apps'].flatMap(feature => ['--disable', feature]),
    '-c', 'mcp_servers={}', '-c', 'notify=[]', '-c', 'project_root_markers=[]',
  ];
}
