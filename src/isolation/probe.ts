import { spawnSync } from 'node:child_process';
import { codexFilesystem } from './codex.js';
import { randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AppConfig } from '../types.js';
import { canonicalPath } from '../runtime/execution-scope.js';
import { PROVIDER_CREDENTIAL_NAMES } from './admission.js';
import { canonicalClaudePath, claudeImplicitWrites, CLAUDE_WRITE_DEVICES, compileClaudeSettings } from './claude.js';
import { contains, scopeHash, scopeTmpdir, type IsolationPolicy, type PolicyPaths } from './policy.js';

export type ProbeStatus = 'PASS' | 'LEAK' | 'ERROR' | 'UNCOVERED';
export interface ProbeResult { name: string; status: ProbeStatus; errorCategory?: string; evidenceMode?: 'static+readonly' }
type Operation = 'read' | 'write' | 'mkdir' | 'create' | 'directory-write' | 'readwrite' | 'tmpdir' | 'command' | 'environment' | 'keychain' | 'static';
interface ProbeCase {
  name: string; operation: Operation; positive?: boolean; sensitive?: boolean;
  path?: string; command?: string; args?: string[]; expected?: string; valid?: boolean;
}
export interface ProbePlan {
  command: string; expectedNames: string[]; marker: string;
  canaries: Array<{ name: string; path: string }>;
  readonlyTargets: string[]; symlinkPath: string;
  parse: (output: string) => ProbeResult[];
  cleanup: () => void;
}

/** Never turn a missing fixture, unknown error or an unexecuted probe into proof of denial. */
export function classifyProbeError(error: unknown, sensitive = false): Pick<ProbeResult, 'status' | 'errorCategory'> {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'EPERM' || code === 'EACCES') return { status: 'PASS', errorCategory: code };
  if (code === 'ENOENT') return { status: sensitive ? 'UNCOVERED' : 'ERROR', errorCategory: code };
  return { status: 'ERROR', errorCategory: 'OTHER' };
}

export function parseProbeResults(output: string, expectedNames: string[], marker = 'CLI2IM_PROBE_RESULT:'): ProbeResult[] {
  const found = new Map<string, ProbeResult[]>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith(marker)) continue;
    try {
      const value = JSON.parse(line.slice(marker.length));
      if (!value || typeof value.name !== 'string' || !expectedNames.includes(value.name)) continue;
      const validStatus = ['PASS', 'LEAK', 'ERROR', 'UNCOVERED'].includes(value.status);
      const validCategory = value.errorCategory === undefined || ['EPERM', 'EACCES', 'ENOENT', 'OTHER', 'NOT_EXECUTED', 'POSITIVE_FAILED', 'CREDENTIAL_PRESENT', 'DENY_WRITE_MISSING', 'KEYCHAIN_NOT_FOUND', 'KEYCHAIN_DENIED', 'INVALID_RESULT'].includes(value.errorCategory);
      const result: ProbeResult = validStatus && validCategory
        ? { name: value.name, status: value.status, ...(value.errorCategory ? { errorCategory: value.errorCategory } : {}) }
        : { name: value.name, status: 'ERROR', errorCategory: 'INVALID_RESULT' };
      found.set(value.name, [...(found.get(value.name) ?? []), result]);
    } catch { /* A malformed result cannot satisfy any expected check. */ }
  }
  return expectedNames.map(name => {
    const entries = found.get(name);
    if (!entries?.length) return { name, status: 'ERROR', errorCategory: 'NOT_EXECUTED' };
    if (entries.length !== 1) return { name, status: 'ERROR', errorCategory: 'INVALID_RESULT' };
    const result = entries[0];
    // Only explicitly designated real-path probes may be uncovered.
    if (result.status === 'UNCOVERED' && !name.startsWith('sensitive.') && name !== 'environment.keychain') {
      return { name, status: 'ERROR', errorCategory: 'INVALID_RESULT' };
    }
    return result;
  });
}

/** Prove the whole protected subtree disjoint from the FINAL effective write set. */
export function protectedWriteDenied(policy: IsolationPolicy, agent: string, home: string, target: string,
  rules?: { allowWrite: string[]; denyWrite: string[] } | Record<string, string>): boolean {
  target = canonicalPath(target);
  if (agent === 'claude-code') {
    const fs = (rules ?? compileClaudeSettings(policy, home).sandbox.filesystem) as { allowWrite: string[]; denyWrite: string[] };
    const grants = [policy.workspace, ...fs.allowWrite, ...claudeImplicitWrites(home)].map(canonicalClaudePath);
    const denials = fs.denyWrite.map(canonicalPath);
    return grants.every(grant => {
      const intersection = contains(grant, target) ? target : contains(target, grant) ? grant : undefined;
      return !intersection || denials.some(deny => contains(deny, intersection));
    });
  }
  const profile = (rules ?? codexFilesystem(policy)) as Record<string, string>;
  const entries = Object.entries(profile).filter(([path]) => path.startsWith('/'))
    .map(([path, mode]) => [canonicalPath(path), mode] as const);
  if (profile[':tmpdir'] === 'write') entries.push([policy.tmpdir, 'write']);
  const mode = (path: string) => entries.filter(([root]) => contains(root, path)).sort(([a], [b]) => b.length - a.length)[0]?.[1] ?? profile[':root'];
  return mode(target) !== 'write' && entries.every(([path]) => !contains(target, path) || mode(path) !== 'write');
}

// Plain JavaScript source is embedded in every bundle; never serialize transpiled functions.
export const PROBE_SOURCE = String.raw`function runProbe(cases, marker, providerNames, suffix) {
  const fs = require('node:fs');
  const path = require('node:path');
  const cp = require('node:child_process');
  let positiveFailed = false;
  const denied = (error, sensitive) => {
    const code = error?.code;
    if (code === 'EPERM' || code === 'EACCES') return { status: 'PASS', errorCategory: code };
    if (code === 'ENOENT') return { status: sensitive ? 'UNCOVERED' : 'ERROR', errorCategory: code };
    return { status: 'ERROR', errorCategory: 'OTHER' };
  };
  for (const probe of cases) {
    let result;
    if (!probe.positive && positiveFailed) result = { status: 'ERROR', errorCategory: 'POSITIVE_FAILED' };
    else {
      const created = [];
      try {
        const remember = (target) => {
          const info = fs.lstatSync(target);
          created.push({ path: target, ino: info.ino, dev: info.dev, directory: info.isDirectory(), parent: fs.realpathSync(path.dirname(target)) });
        };
        const openClose = (target, flags) => {
          const fd = fs.openSync(target, flags);
          try { /* Deliberately do not read or truncate sensitive real files. */ } finally { fs.closeSync(fd); }
        };
        const createFile = (target) => {
          const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
          try {
            const info = fs.fstatSync(fd); created.push({ path: target, ino: info.ino, dev: info.dev, directory: false, parent: fs.realpathSync(path.dirname(target)) });
            fs.writeFileSync(fd, 'cli2im-isolation-canary');
          } finally { fs.closeSync(fd); }
        };
        if (probe.operation === 'static') {
          if (!probe.valid) throw Object.assign(new Error(), { code: 'DENY_WRITE_MISSING' });
        } else if (probe.operation === 'environment') {
          if (Object.keys(process.env).some(key => providerNames.some(name => name.toLowerCase() === key.toLowerCase()))) {
            throw Object.assign(new Error(), { code: 'CREDENTIAL_PRESENT' });
          }
        } else if (probe.operation === 'command') {
          const executed = cp.spawnSync(probe.command, probe.args ?? [], { stdio: 'ignore', timeout: 5000 });
          if (executed.error) throw executed.error;
          if (executed.status !== 0) throw new Error();
        } else if (probe.operation === 'keychain') {
          if (probe.valid === false) {
            process.stdout.write(marker + JSON.stringify({ name: probe.name, status: 'UNCOVERED', errorCategory: 'ENOENT' }) + '\n');
            continue;
          }
          if (probe.valid !== true) throw new Error('Keychain existence was not established');
          // No -w or -g: neither password nor item metadata is ever captured/output.
          const executed = cp.spawnSync('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials'], { stdio: 'ignore', timeout: 5000 });
          if (executed.error) throw executed.error;
          // errSecAuthFailed / errSecInteractionNotAllowed low-byte exit status.
          result = executed.status === 0 ? { status: 'LEAK' }
            : [44, 51, 36].includes(executed.status ?? -1) ? { status: 'PASS', errorCategory: 'KEYCHAIN_DENIED' }
              : { status: 'ERROR', errorCategory: executed.status === 44 ? 'KEYCHAIN_NOT_FOUND' : 'OTHER' };
          process.stdout.write(marker + JSON.stringify({ name: probe.name, ...result }) + '\n');
          continue;
        } else {
          let target = probe.path;
          if (probe.operation === 'tmpdir') {
            if (!process.env.TMPDIR || path.resolve(process.env.TMPDIR) !== probe.expected) throw new Error();
            target = path.join(process.env.TMPDIR, suffix);
          }
          if (probe.operation === 'directory-write') {
            const existingDirectory = () => {
              const info = fs.lstatSync(target);
              if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe probe directory');
            };
            let exists = true;
            try { existingDirectory(); }
            catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
            if (!exists) {
              // The CLI may create this directory after the existence check.
              // EEXIST grants no ownership; retry once by creating only a child.
              try { fs.mkdirSync(target, { mode: 0o700 }); }
              catch (error) { if (error.code === 'EEXIST') exists = true; else throw error; }
              if (!exists) remember(target);
            }
            if (exists) { existingDirectory(); createFile(path.join(target, suffix)); }
          } else if (probe.operation === 'mkdir') {
            // Non-recursive and exclusive: EEXIST never grants ownership.
            fs.mkdirSync(target, { mode: 0o700 }); remember(target);
          } else if (['create', 'readwrite', 'tmpdir'].includes(probe.operation)) {
            createFile(target);
            if (probe.operation !== 'create' && fs.readFileSync(target, 'utf8') !== 'cli2im-isolation-canary') throw new Error();
          } else if (probe.operation === 'read') {
            if (probe.sensitive) openClose(target, fs.constants.O_RDONLY);
            else if (fs.statSync(target).isDirectory()) { const dir = fs.opendirSync(target); dir.closeSync(); }
            else fs.readFileSync(target);
          } else {
            const fd = fs.openSync(target, fs.constants.O_WRONLY);
            try { fs.writeSync(fd, 'cli2im-isolation-canary'); } finally { fs.closeSync(fd); }
          }
        }
        result = { status: probe.positive || ['static', 'environment'].includes(probe.operation) ? 'PASS' : 'LEAK' };
      } catch (error) {
        const code = error.code;
        result = probe.positive ? { status: 'ERROR', errorCategory: ['EPERM', 'EACCES', 'ENOENT'].includes(code ?? '') ? code : 'OTHER' }
          : ['CREDENTIAL_PRESENT', 'DENY_WRITE_MISSING'].includes(code ?? '') ? { status: 'LEAK', errorCategory: code }
            : denied(error, probe.sensitive);
      } finally {
        for (const entry of created.reverse()) {
          try {
            if (fs.realpathSync(path.dirname(entry.path)) !== entry.parent) throw new Error();
            const info = fs.lstatSync(entry.path);
            if (info.ino !== entry.ino || info.dev !== entry.dev || info.isSymbolicLink() || info.isDirectory() !== entry.directory) throw new Error();
            if (entry.directory) fs.rmdirSync(entry.path); else if (info.isFile()) fs.unlinkSync(entry.path); else throw new Error();
          } catch { result = { status: 'ERROR', errorCategory: 'OTHER' }; }
        }
      }
    }
    if (probe.positive && result.status !== 'PASS') positiveFailed = true;
    process.stdout.write(marker + JSON.stringify({ name: probe.name, ...result }) + '\n');
  }
}`;

/** Preparation touches only PLAN 5.5 fixture roots; cleanup never recursively follows agent-controlled paths. */
export async function createProbePlan(params: {
  policy: IsolationPolicy; paths: PolicyPaths; agent: string; config: Pick<AppConfig, 'bots'>;
  env?: NodeJS.ProcessEnv; fixtureRoot?: string; uid?: number; keychainExists?: () => boolean | undefined;
}): Promise<ProbePlan> {
  const { policy, paths, agent } = params;
  const id = randomUUID(); const suffix = `.cli2im-canary-${id}`;
  const marker = `CLI2IM_PROBE_${id}:`;
  const cases: ProbeCase[] = [];
  // Configuration of a workspace is not permission to create diagnostic objects there.
  const readonlyTargets = [...new Set([...policy.readable, ...policy.plugins].filter(p => p !== policy.inbox && !policy.writable.some(w => contains(w, p))))];
  const forbiddenRoots = [...['.claude', '.claude.json', '.codex', '.gemini', 'Library', '.ssh', '.gnupg', '.aws', '.config']
    .map(name => join(paths.home, name)), ...readonlyTargets,
    ...claudeImplicitWrites(paths.home).filter(p => contains(paths.home, p)),
    `/private/tmp/claude-${params.uid ?? process.getuid?.() ?? 0}`].map(canonicalPath);
  const forbiddenCreation = (path: string): boolean => forbiddenRoots.some(root => contains(root, canonicalPath(path)));
  const assertFixtureTarget = (path: string): void => {
    if (forbiddenCreation(path)) throw new Error('UNSUPPORTED: isolation fixture target is protected');
  };
  const owned: Array<{ path: string; ino: number; dev: number; directory: boolean; symbolic: boolean; file: boolean }> = [];
  const remember = (path: string, s = lstatSync(path)) => { owned.push({ path, ino: s.ino, dev: s.dev, directory: s.isDirectory(), symbolic: s.isSymbolicLink(), file: s.isFile() }); };
  const ensureDirectory = (path: string): void => {
    assertFixtureTarget(path);
    try { const s = lstatSync(path); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('Unsafe isolation fixture directory'); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      ensureDirectory(dirname(path)); mkdirSync(path, { mode: 0o700 }); remember(path);
    }
    if (canonicalPath(path) !== resolve(path)) throw new Error('Isolation fixture root contains a symlink');
  };
  const cleanup = () => {
    let failed = false;
    for (const entry of [...owned].reverse()) {
      try {
        if (canonicalPath(dirname(entry.path)) !== resolve(dirname(entry.path))) { failed = true; continue; }
        const s = lstatSync(entry.path);
        if (s.ino !== entry.ino || s.dev !== entry.dev || s.isDirectory() !== entry.directory || s.isSymbolicLink() !== entry.symbolic || s.isFile() !== entry.file) { failed = true; continue; }
        if (entry.directory) rmdirSync(entry.path); else unlinkSync(entry.path);
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') failed = true; }
    }
    if (failed) throw new Error('Isolation fixture cleanup failed');
  };
  const canaries: ProbePlan['canaries'] = [];
  const createCanary = (name: string, root: string, filename = suffix): string => {
    assertFixtureTarget(join(root, filename));
    ensureDirectory(root);
    const path = join(root, filename);
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { remember(path, fstatSync(fd)); writeFileSync(fd, 'cli2im-isolation-canary'); } finally { closeSync(fd); }
    if (readFileSync(path, 'utf8') !== 'cli2im-isolation-canary') throw new Error('Isolation fixture is unreadable');
    canaries.push({ name, path }); return path;
  };
  try {
    const shared = join(params.fixtureRoot ?? '/private/tmp', `c2i-fixture-${id}`);
    createCanary('bridge', join(paths.dataDir, 'isolation', 'fixtures'));
    createCanary('memory', paths.memoryDir, `.canary-${id}`);
    createCanary('shared-tmp', shared);
    const seenWorkspaces = new Set<string>();
    for (const [botName, bot] of Object.entries(params.config.bots)) {
      const workspaces = [...new Set([bot.workingDirectory, ...Object.values(bot.userOverrides ?? {}).flatMap(v => v.workingDirectory ? [v.workingDirectory] : [])].map(canonicalPath))];
      for (const workspace of workspaces) if (workspace !== policy.workspace) {
        if (seenWorkspaces.has(workspace)) continue;
        seenWorkspaces.add(workspace);
        const label = `${botName}.${scopeHash(workspace).slice(0, 8)}`;
        if (forbiddenCreation(workspace)) {
          cases.push({ name: `sensitive.workspace.${label}.read`, operation: 'read', sensitive: true, path: workspace },
            { name: `protected.workspace.${label}.static-write`, operation: 'static', valid: protectedWriteDenied(policy, agent, paths.home, workspace) });
        } else createCanary(`workspace.${label}`, workspace);
        createCanary(`inbox.${label}`, join(paths.dataDir, 'inbox', scopeHash(workspace)));
        if (bot.isolation?.enabled) createCanary(`tmp.${label}`, canonicalPath(scopeTmpdir(bot.agent, workspace, paths)));
      }
    }
    ensureDirectory(policy.workspace); ensureDirectory(policy.tmpdir); ensureDirectory(policy.inbox);
    const inboxCanary = createCanary('own-inbox', policy.inbox);
    canaries.pop(); // This is a positive read control, not a hard-denied fixture.
    cases.push({ name: 'positive.workspace', operation: 'readwrite', positive: true, path: join(policy.workspace, suffix) },
      { name: 'positive.tmpdir', operation: 'tmpdir', positive: true, expected: agent === 'claude-code' ? join(policy.tmpdir, `claude-${params.uid ?? process.getuid?.() ?? 0}`) : policy.tmpdir },
      { name: 'positive.inbox', operation: 'read', positive: true, path: inboxCanary });
    for (const [i, path] of readonlyTargets.entries()) cases.push({ name: `positive.readonly.${i}`, operation: 'read', positive: true, sensitive: true, path });
    for (const [command, args] of [['sh', ['-c', 'exit 0']], ['git', ['--version']], ['node', ['--version']], ['python3', ['--version']], ['lark-cli', ['--version']], ['curl', ['--version']]] as Array<[string, string[]]>) {
      cases.push({ name: `positive.command.${command}`, operation: 'command', positive: true, command, args });
    }
    for (const canary of canaries) {
      for (const operation of ['read', 'write'] as const) cases.push({ name: `negative.${canary.name}.${operation}`, operation, path: canary.path });
      cases.push({ name: `negative.${canary.name}.directory`, operation: 'read', path: dirname(canary.path) });
    }
    cases.push({ name: 'negative.inbox.write', operation: 'write', path: inboxCanary });

    for (const [i, path] of readonlyTargets.entries()) {
      cases.push({ name: `negative.readonly.${i}.write`, operation: 'static', valid: protectedWriteDenied(policy, agent, paths.home, path) });
    }
    const symlinkPath = join(policy.workspace, `${suffix}-link`);
    symlinkSync(canaries[0].path, symlinkPath); remember(symlinkPath);
    for (const operation of ['read', 'write'] as const) cases.push({ name: `negative.symlink.${operation}`, operation, path: symlinkPath });
    for (const name of ['.codex', '.claude']) {
      cases.push({ name: `negative.workspace.${name}.write`, operation: 'directory-write', path: join(policy.workspace, name) });
    }
    const sensitive = ['.claude', '.codex', '.gemini', '.ssh', '.gnupg', '.aws', '.config', 'Library/Keychains', '.cli2im/config.yaml', '.claude/shell-snapshots', '.claude/projects', '.codex/sessions'];
    for (const [i, relative] of sensitive.entries()) {
      const path = join(paths.home, relative);
      cases.push({ name: `sensitive.${i}`, operation: 'read', sensitive: true, path },
        { name: `protected.${i}.static-write`, operation: 'static', valid: protectedWriteDenied(policy, agent, paths.home, path) });
    }
    const keychainExists = params.keychainExists ?? (() => {
      const result = spawnSync('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials'], {
        stdio: 'ignore', timeout: 5000, env: { PATH: '/usr/bin:/bin', HOME: paths.home },
      });
      return result.error || result.status === null ? undefined : result.status === 0 ? true : result.status === 44 ? false : undefined;
    });
    cases.push({ name: 'environment.credentials', operation: 'environment' }, { name: 'environment.keychain', operation: 'keychain', valid: keychainExists() });
    if (agent === 'claude-code') {
      for (const [i, path] of ['/tmp/claude', '/private/tmp/claude'].entries()) {
        let exists = true;
        try { if (!lstatSync(path).isDirectory()) throw new Error('Invalid shared Claude directory'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false; else throw error; }
        cases.push({ name: `claude.shared-default-write.${i}`, operation: exists ? 'create' : 'mkdir', path: exists ? join(path, suffix) : path });
      }
      for (const [i, path] of claudeImplicitWrites(paths.home).filter(p => !CLAUDE_WRITE_DEVICES.includes(p) && contains(paths.home, p)).entries()) {
        cases.push({ name: `claude.convenience-deny.${i}`, operation: 'static', valid: protectedWriteDenied(policy, agent, paths.home, path) },
          { name: `sensitive.claude.convenience-read.${i}`, operation: 'read', sensitive: true, path });
      }
      const sharedTmp = `/private/tmp/claude-${params.uid ?? process.getuid?.() ?? 0}`;
      cases.push({ name: 'sensitive.claude-shared-tmp.read', operation: 'read', sensitive: true, path: sharedTmp },
        { name: 'claude.shared-tmp.static-write', operation: 'static', valid: protectedWriteDenied(policy, agent, paths.home, sharedTmp) });
      for (const [i, path] of ['/etc/hosts', '/private/etc/hosts'].entries()) cases.unshift({ name: `positive.link.system.${i}`, operation: 'read', positive: true, path });
      for (const [i, path] of ['/var/db', '/private/var/db', '/var/folders', '/private/var/folders'].entries()) cases.push({ name: `negative.link.hard-deny.${i}`, operation: 'read', sensitive: true, path });
      const tmpCanary = canaries.find(c => c.name === 'shared-tmp')!.path;
      if (!contains('/private/tmp', tmpCanary)) throw new Error('Claude link control needs a /private/tmp fixture');
      for (const [i, path] of [tmpCanary, tmpCanary.replace(/^\/private\/tmp\//, '/tmp/')].entries()) {
        for (const operation of ['read', 'write'] as const) cases.push({ name: `negative.link.tmp.${i}.${operation}`, operation, path });
      }
    }
    // All positive controls precede negatives.
    cases.sort((a, b) => Number(!!b.positive) - Number(!!a.positive));
    const source = `(${PROBE_SOURCE})(${JSON.stringify(cases)},${JSON.stringify(marker)},${JSON.stringify(PROVIDER_CREDENTIAL_NAMES)},${JSON.stringify(suffix)});`;
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const expectedNames = cases.map(c => c.name);
    return { command: `node -e ${quote(source)}`, expectedNames, marker, canaries, readonlyTargets, symlinkPath,
      parse: output => parseProbeResults(output, expectedNames, marker).map(result => cases.find(c => c.name === result.name)?.operation === 'static' ? { ...result, evidenceMode: 'static+readonly' as const } : result), cleanup };
  } catch (error) { cleanup(); throw error; }
}
