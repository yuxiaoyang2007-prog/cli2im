import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { basename, join, resolve, dirname } from 'node:path';
import { parse } from 'yaml';
import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import { canonicalPath } from '../runtime/execution-scope.js';
import { contains, RUNTIME_READ, RUNTIME_READ_EXCEPTIONS, type IsolationPolicy } from './policy.js';
import { PROVIDER_CREDENTIAL_NAMES } from './admission.js';

// Statically checked against Claude Code 2.1.293, bundled chunk-ep4t91kn.js:
// MN() returns ne plus HOME-relative X (conditionally reopened by allowRead).
// Keep both /tmp spellings and HOME entries even when absent or currently masked.
export const CLAUDE_RUNTIME_VERSION = '2.1.293';
export const CLAUDE_WRITE_DEVICES = ['/dev/stdout', '/dev/stderr', '/dev/null', '/dev/tty', '/dev/dtracehelper', '/dev/autofs_nowait'];
export function claudeImplicitWrites(home: string): string[] {
  return [...CLAUDE_WRITE_DEVICES, '/tmp/claude', '/private/tmp/claude', join(home, '.npm/_logs'), join(home, '.claude/debug')];
}
const unique = (paths: string[]) => [...new Set(paths)].sort();
// Runtime devices name process-local descriptors; resolving them can fail with
// EBADF or change the grant to the descriptor's current backing file.
export function canonicalClaudePath(path: string): string {
  return CLAUDE_WRITE_DEVICES.includes(path) || (path.startsWith('/dev/') && RUNTIME_READ.includes(path)) ? path : canonicalPath(path);
}
const canonical = (paths: string[]) => unique(paths.map(canonicalClaudePath));

export const CLAUDE_LINK_READ = ['/etc', '/var', '/tmp'];
export function validateClaudeLinks(inspect = lstatSync, readlink = readlinkSync): void {
  for (const path of CLAUDE_LINK_READ) {
    try {
      if (!inspect(path).isSymbolicLink() || resolve(dirname(path), String(readlink(path))) !== `/private${path}`) throw new Error();
    } catch { throw new Error('UNSUPPORTED: Claude runtime link differs from the fixed contract'); }
  }
}

export function compileClaudeSettings(policy: IsolationPolicy, home: string) {
  validateClaudeLinks();
  // These CLI fields accept globs. A literal filesystem path containing glob
  // syntax cannot safely be translated by treating it as an ordinary string.
  if ([home, ...policy.runtimeRead, ...policy.readable, ...policy.writable, ...policy.hardDeny, ...policy.plugins]
    .some(path => /[*?\[\]{}]/.test(path))) throw new Error('UNSUPPORTED: Claude sandbox path contains glob syntax');
  const allowRead = canonical([...policy.runtimeRead.filter(p => p !== '/' && p !== '/dev'), ...policy.readable, ...policy.plugins]);
  if (allowRead.includes('/') || allowRead.includes('/dev')) throw new Error('UNSUPPORTED: Claude read grant is too broad');
  const exceptions = canonical([...policy.readExceptions, ...policy.plugins, ...RUNTIME_READ_EXCEPTIONS]);
  const hardDeny = canonical(policy.hardDeny);
  for (const allow of allowRead) for (const deny of hardDeny) {
    // Exact approved plugin roots can also appear in hardDeny. Descendant
    // denials are never erased by an ancestor exception.
    if (contains(allow, deny) && !exceptions.includes(deny)) throw new Error('UNSUPPORTED: Claude allowRead contains a hard denial');
    if (contains(deny, allow) && !exceptions.some(e => contains(e, allow) && contains(deny, e))) {
      throw new Error('UNSUPPORTED: Claude allowRead lacks an approved exception');
    }
  }
  const allowWrite = canonical(policy.writable);
  const implicit = claudeImplicitWrites(home);
  const actual = canonical([...allowWrite, ...implicit]);
  const readonly = canonical([...policy.readable, ...policy.plugins].filter(p => !allowWrite.some(w => contains(w, p))));
  const denyWrite = unique([
    ...canonical([...hardDeny, ...readonly]).filter(d => actual.some(w => contains(w, d))
      && !allowWrite.some(w => contains(d, w) && d !== w)),
    join(policy.workspace, '.claude'), join(policy.workspace, '.codex'),
    ...implicit.filter(p => !CLAUDE_WRITE_DEVICES.includes(p) && !allowWrite.some(w => contains(w, canonicalPath(p)))),
  ]);
  if (denyWrite.some(d => allowWrite.some(w => contains(canonicalPath(d), w)))) {
    throw new Error('UNSUPPORTED: Claude denyWrite covers an approved write grant');
  }
  return {
    autoMemoryEnabled: false, autoDreamEnabled: false,
    sandbox: {
      enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false, excludedCommands: [],
      filesystem: { denyRead: ['/'], allowRead: unique([...allowRead, ...CLAUDE_LINK_READ]), allowWrite, denyWrite },
      network: { allowedDomains: ['*'] },
      credentials: { envVars: PROVIDER_CREDENTIAL_NAMES.map(name => ({ name, mode: 'deny' as const })) },
    },
  };
}

/** Skills are data; all other plugin capability entry points are rejected. */
function validateSkillFrontmatter(path: string): void {
  const source = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  if (!/^---[^\S\r\n]*(?:\r?\n|$)/.test(source)) return;
  const match = /^---[^\S\r\n]*\r?\n([\s\S]*?)^(?:---|\.\.\.)[^\S\r\n]*(?:\r?\n|$)/m.exec(source);
  if (!match) throw new Error('UNSUPPORTED: skill frontmatter is invalid');
  let metadata: unknown;
  try { metadata = parse(match[1], { merge: true }); }
  catch { throw new Error('UNSUPPORTED: skill frontmatter is invalid'); }
  if (metadata == null) return;
  if (typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('UNSUPPORTED: skill frontmatter must be a mapping');
  if (['hooks', 'mcpServers', 'lspServers', 'agent', 'context'].some(key => Object.hasOwn(metadata, key))) {
    throw new Error('UNSUPPORTED: skill frontmatter contains capabilities');
  }
}

export function validateClaudePlugins(roots: string[]): void {
  const metadata = new Set(['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'skills']);
  for (const root of roots) {
    const visit = (path: string): void => {
      const info = lstatSync(path);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error('UNSUPPORTED: plugin contains a link or special file');
      if (info.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
      else if (basename(path).toLowerCase() === 'skill.md') validateSkillFrontmatter(path);
    };
    visit(root);
    if (readdirSync(root).some(n => !['skills', '.claude-plugin', 'README.md', 'LICENSE', 'LICENSE.md'].includes(n))) {
      throw new Error('UNSUPPORTED: plugin may only provide skills');
    }
    const manifestDir = join(root, '.claude-plugin');
    try {
      if (readdirSync(manifestDir).some(n => n !== 'plugin.json')) throw new Error('UNSUPPORTED: plugin metadata contains capabilities');
      const manifest = JSON.parse(readFileSync(join(manifestDir, 'plugin.json'), 'utf8'));
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
        || Object.keys(manifest).some(k => !metadata.has(k))
        || (manifest.skills !== undefined && manifest.skills !== './skills')) throw new Error('UNSUPPORTED: plugin manifest contains capabilities');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

export function allowedClaudeTool(policy: IsolationPolicy, name: string, input: unknown): boolean {
  if (!policy.tools.includes(name) || !input || typeof input !== 'object') return false;
  const args = input as Record<string, unknown>;
  if (name === 'Bash' && args.dangerouslyDisableSandbox !== undefined && args.dangerouslyDisableSandbox !== false) return false;
  return name !== 'Skill' || !policy.skills.length || (typeof args.skill === 'string' && policy.skills.includes(args.skill));
}

export function claudeToolGuard(policy: IsolationPolicy, check: (policy: IsolationPolicy, name: string, input: unknown) => boolean | Promise<boolean> = allowedClaudeTool, timeoutMs = 1000): HookCallback {
  return async (input, _id, { signal }) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const allowed = await Promise.race([
        Promise.resolve().then(() => input.hook_event_name === 'PreToolUse' && check(policy, input.tool_name, input.tool_input)),
        new Promise<false>(resolve => {
          timer = setTimeout(() => resolve(false), timeoutMs);
          abort = () => resolve(false);
          if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
        }),
      ]);
      return allowed && !signal.aborted ? {} : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Isolation tool guard denied this request' } };
    } catch {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Isolation tool guard failed' } };
    } finally {
      clearTimeout(timer);
      if (abort) signal.removeEventListener('abort', abort);
    }
  };
}

export function claudeIsolationOptions(policy: IsolationPolicy, home: string): Partial<Options> {
  validateClaudePlugins(policy.plugins);
  return {
    extraArgs: { restricted: null }, settingSources: [], strictMcpConfig: true, mcpServers: {},
    permissionMode: 'default', allowDangerouslySkipPermissions: false,
    tools: policy.tools, settings: compileClaudeSettings(policy, home),
    plugins: policy.plugins.map(path => ({ type: 'local' as const, path })),
    hooks: { PreToolUse: [{ hooks: [claudeToolGuard(policy)], timeout: 2 }] },
  };
}
