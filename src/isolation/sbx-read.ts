import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute } from 'node:path';
import type { IsolationPolicy } from './policy.js';
import { contains, RUNTIME_READ_EXCEPTIONS } from './policy.js';

export class SandboxReadError extends Error {
  constructor(readonly category: 'PERMISSION' | 'ENOENT' | 'OTHER') { super('Isolation outbound read denied'); }
}

export const MAX_OUTBOUND_BYTES = 30 * 1024 * 1024;
const quote = (value: string) => JSON.stringify(value);
const subtree = (path: string) => `(subpath ${quote(path)})`;
const readFilter = (path: string) => path === '/' || path === '/dev' ? `(literal ${quote(path)})` : subtree(path);
/** Denials are subtracted inside each allow filter so narrow exceptions never lift a whole hard-denied parent. */
function pathFilters(policy: IsolationPolicy, grants: string[], exceptions = policy.readExceptions): string[] {
  if ([...grants, ...policy.hardDeny, ...exceptions].some(p => !isAbsolute(p) || /[\x00-\x1f]/.test(p))) throw new Error('Invalid sandbox path');
  return [...new Set(grants)].map(grant => {
    const denied = policy.hardDeny.filter(deny => {
      if (contains(deny, grant)) return !exceptions.some(exception => contains(deny, exception) && contains(exception, grant));
      return contains(grant, deny);
    });
    return denied.length ? `(require-all ${readFilter(grant)} ${denied.map(d => `(require-not ${subtree(d)})`).join(' ')})` : readFilter(grant);
  });
}
export function buildReadProfile(policy: IsolationPolicy): string {
  const filters = [...pathFilters(policy, policy.readable),
    ...pathFilters(policy, policy.runtimeRead, [...policy.readExceptions, ...RUNTIME_READ_EXCEPTIONS])];
  return ['(version 1)', '(deny default)', '(allow process-exec (literal "/bin/cat"))', '(allow process-fork)',
    '(allow sysctl-read)', '(allow file-read-metadata)', `(allow file-read* ${filters.join(' ')})`].join('\n');
}
/** Never return partial stdout after a denial, timeout or size overflow. Never fall back to a parent-process open. */
export function sandboxReadFile(path: string, policy: IsolationPolicy, options: { signal?: AbortSignal; maxBytes?: number } = {}): Promise<Buffer> {
  if (!isAbsolute(path)) return Promise.reject(new Error('Isolation outbound path must be absolute'));
  const profile = buildReadProfile(policy);
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, '/bin/cat', path], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C' }, signal: options.signal,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    const timer = setTimeout(() => { failure = new Error('Isolation outbound read timed out'); child.kill('SIGKILL'); }, 10_000);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > (options.maxBytes ?? MAX_OUTBOUND_BYTES)) { failure = new Error('Outbound file exceeds size limit'); child.kill('SIGKILL'); }
      else chunks.push(chunk);
    });
    let diagnostics = '';
    child.stderr.on('data', (chunk: Buffer) => { if (diagnostics.length < 4096) diagnostics += chunk.toString().slice(0, 4096 - diagnostics.length); });
    child.once('error', () => { clearTimeout(timer); reject(new Error('Isolation outbound sandbox unavailable')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure || code !== 0) reject(failure ?? new SandboxReadError(/Operation not permitted|Permission denied|EACCES|EPERM/i.test(diagnostics)
        ? 'PERMISSION' : /No such file|ENOENT/i.test(diagnostics) ? 'ENOENT' : 'OTHER'));
      else resolve(Buffer.concat(chunks));
    });
  });
}

/** TMPDIR lives under an agent-writable workspace for Codex: creation/chmod need the same open-time boundary. */
export function buildTemporaryDirectoryProfile(policy: IsolationPolicy): string {
  return buildReadProfile(policy).replace('(allow process-exec (literal "/bin/cat"))',
    '(allow process-exec (literal "/bin/mkdir") (literal "/bin/chmod"))')
    + `\n(allow file-write* ${pathFilters(policy, [policy.tmpdir], policy.writable).join(' ')})`;
}
export async function prepareTemporaryDirectory(policy: IsolationPolicy): Promise<void> {
  const profile = buildTemporaryDirectoryProfile(policy);
  for (const [command, args] of [['/bin/mkdir', ['-p', '-m', '700', policy.tmpdir]], ['/bin/chmod', ['700', policy.tmpdir]]] as const) {
    try {
      await promisify(execFile)('/usr/bin/sandbox-exec', ['-p', profile, command, ...args], {
        env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 10_000, maxBuffer: 1024,
      });
    } catch { throw new Error('Isolation temporary directory sandbox unavailable or denied'); }
  }
}
