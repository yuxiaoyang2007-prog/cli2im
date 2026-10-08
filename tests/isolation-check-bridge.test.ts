import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, renameSync, symlinkSync, lstatSync, existsSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkBridge, BRIDGE_CHECKS } from '../src/isolation/check-bridge.js';
import * as sbx from '../src/isolation/sbx-read.js';
import { RUNTIME_READ, type IsolationPolicy } from '../src/isolation/policy.js';

describe('bridge isolation check fixture ownership', () => {
  let root: string;
  let workspace: string;
  let outside: string;
  let policy: IsolationPolicy;
  beforeEach(() => {
    root = mkdtempSync(resolve('tests/.bridge-check-'));
    workspace = join(root, 'workspace'); mkdirSync(workspace);
    outside = join(root, 'outside', 'canary'); mkdirSync(dirname(outside)); writeFileSync(outside, 'outside fixture');
    policy = { scopeKey: workspace, workspace, tmpdir: workspace, inbox: workspace,
      readable: [workspace], writable: [workspace], runtimeRead: RUNTIME_READ,
      hardDeny: [dirname(outside)], readExceptions: [workspace], tools: [], plugins: [], skills: [], binaryPath: '/bin/cat', searchPath: ['/usr/bin', '/bin'], searchPathDenied: [], fingerprint: 'fixture' };
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
  const denied = () => { throw new sbx.SandboxReadError('PERMISSION'); };

  it('performs positive, symbolic, deterministic replacement and concurrent checks, then removes only its fixtures', async () => {
    let count = 0;
    vi.spyOn(sbx, 'sandboxReadFile').mockImplementation(async path => {
      count++;
      if (count === 1 || count === 4) return Buffer.from('safe-control');
      if (count === 3) expect(lstatSync(dirname(path)).isSymbolicLink()).toBe(true);
      return denied();
    });
    const checks = await checkBridge(policy, outside);
    expect(checks).toEqual(BRIDGE_CHECKS.map(name => ({ name, status: 'PASS' })));
    expect(readdirSync(workspace)).toEqual([]);
    expect(readFileSync(outside, 'utf8')).toBe('outside fixture');
  });

  it('does not convert an absent negative target into proof of denial', async () => {
    let count = 0;
    vi.spyOn(sbx, 'sandboxReadFile').mockImplementation(async () => {
      if (++count === 1) return Buffer.from('safe-control');
      throw new sbx.SandboxReadError('ENOENT');
    });
    const checks = await checkBridge(policy, outside);
    expect(checks.filter(check => check.status === 'ERROR').map(check => check.name)).toEqual(BRIDGE_CHECKS.slice(1));
    expect(readdirSync(workspace)).toEqual([]);
  });

  it('preserves a foreign replacement inode and reports cleanup failure', async () => {
    let count = 0;
    vi.spyOn(sbx, 'sandboxReadFile').mockImplementation(async path => {
      if (++count === 1) return Buffer.from('safe-control');
      if (count === 4) {
        const fixture = dirname(dirname(path));
        renameSync(join(fixture, 'safe'), join(fixture, 'owned-safe-retired'));
        writeFileSync(join(fixture, 'safe'), 'foreign replacement');
      }
      return denied();
    });
    const checks = await checkBridge(policy, outside);
    expect(checks).toContainEqual({ name: 'bridge.cleanup', status: 'ERROR' });
    const fixture = join(workspace, readdirSync(workspace)[0]);
    expect(readFileSync(join(fixture, 'safe'), 'utf8')).toBe('foreign replacement');
  });

  it('never follows a replaced ancestor to delete external files during cleanup', async () => {
    const foreign = join(root, 'foreign'); mkdirSync(foreign);
    writeFileSync(join(foreign, 'safe'), 'foreign safe');
    mkdirSync(join(foreign, 'retired')); writeFileSync(join(foreign, 'retired', basename(outside)), 'foreign nested');
    let count = 0;
    vi.spyOn(sbx, 'sandboxReadFile').mockImplementation(async path => {
      if (++count === 1) return Buffer.from('safe-control');
      if (count === 4) {
        const fixture = dirname(dirname(path));
        let changed = false;
        for (let attempt = 0; attempt < 1000; attempt++) {
          try { changed = lstatSync(dirname(path)).isSymbolicLink(); } catch { /* rename window */ }
          if (changed) break;
          await new Promise(resolve => setTimeout(resolve, 1));
        }
        expect(changed).toBe(true);
        renameSync(fixture, `${fixture}-retired`);
        symlinkSync(foreign, fixture);
      }
      return denied();
    });
    const checks = await checkBridge(policy, outside);
    expect(checks).toContainEqual({ name: 'bridge.cleanup', status: 'ERROR' });
    expect(readFileSync(join(foreign, 'safe'), 'utf8')).toBe('foreign safe');
    expect(readFileSync(join(foreign, 'retired', basename(outside)), 'utf8')).toBe('foreign nested');
  });

  it('integration: real Seatbelt rejects external symlink and parent replacements', async context => {
    if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) context.skip('Native Seatbelt is unavailable');
    const probe = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1) (allow default)', '/usr/bin/true'], { env: { PATH: '/usr/bin:/bin' }, timeout: 5000 });
    if (probe.status !== 0) context.skip('This sandbox does not permit nested Seatbelt');
    const checks = await checkBridge(policy, outside);
    expect(checks).toEqual(BRIDGE_CHECKS.map(name => ({ name, status: 'PASS' })));
    expect(readdirSync(workspace)).toEqual([]);
  });
});
