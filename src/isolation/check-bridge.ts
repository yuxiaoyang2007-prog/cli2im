import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, symlink, rename, unlink, rmdir, realpath, lstat } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { sandboxReadFile, SandboxReadError } from './sbx-read.js';
import type { IsolationPolicy } from './policy.js';
import type { EvidenceCheck } from './check-evidence.js';

export const BRIDGE_CHECKS = ['bridge.positive', 'bridge.symlink', 'bridge.parent-replaced', 'bridge.concurrent-replacement'];
export async function checkBridge(policy: IsolationPolicy, outside: string, signal?: AbortSignal): Promise<EvidenceCheck[]> {
  const root = join(policy.workspace, `.cli2im-canary-bridge-${randomUUID()}`);
  const checks: EvidenceCheck[] = [];
  let inFlight: Promise<void> | undefined;
  type Owned = { path: string; ino: number; dev: number; directory: boolean };
  const owned: Owned[] = [];
  const parents = new Map<string, { ino: number; dev: number }>();
  const checkParent = async (path: string, remember = false) => {
    const parent = dirname(path);
    const actual = await lstat(parent);
    const expected = parents.get(parent);
    if (!actual.isDirectory() || actual.isSymbolicLink() || await realpath(parent) !== resolve(parent)
      || (expected && (expected.ino !== actual.ino || expected.dev !== actual.dev)) || (!expected && !remember)) {
      throw new Error('Bridge fixture parent was replaced');
    }
    if (!expected) parents.set(parent, { ino: actual.ino, dev: actual.dev });
  };
  const remember = async (path: string, directory = false) => {
    const info = await lstat(path);
    owned.push({ path, ino: info.ino, dev: info.dev, directory });
  };
  const directory = async (path: string) => { await checkParent(path, true); await mkdir(path, { mode: 0o700 }); await remember(path, true); };
  const file = async (path: string) => {
    await checkParent(path, true);
    await writeFile(path, 'safe-control', { flag: 'wx', mode: 0o600 });
    await remember(path);
  };
  const link = async (path: string, target: string) => { await checkParent(path, true); await symlink(target, path); await remember(path); };
  const checkEntry = async (entry: Owned) => {
    await checkParent(entry.path);
    const actual = await lstat(entry.path);
    if (actual.ino !== entry.ino || actual.dev !== entry.dev) throw new Error('Bridge fixture entry was replaced');
  };
  const remove = async (entry: Owned) => {
    await checkEntry(entry);
    if (entry.directory) await rmdir(entry.path); else await unlink(entry.path);
    owned.splice(owned.indexOf(entry), 1);
  };
  const move = async (source: string, target: string) => {
    const entry = owned.find(entry => entry.path === source);
    if (!entry) throw new Error('Unowned bridge fixture');
    await checkEntry(entry);
    await checkParent(target, true);
    try { await lstat(target); throw new Error('Bridge fixture destination exists'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await rename(source, target);
    for (const item of owned) if (item.path === source || item.path.startsWith(source + '/')) item.path = target + item.path.slice(source.length);
    for (const [path, identity] of [...parents]) if (path === source || path.startsWith(source + '/')) {
      parents.delete(path); parents.set(target + path.slice(source.length), identity);
    }
  };
  const deny = async (name: string, path: string, racing = false) => {
    try {
      const bytes = await sandboxReadFile(path, policy, { signal });
      checks.push({ name, status: racing && bytes.equals(Buffer.from('safe-control')) ? 'PASS' : 'LEAK' });
    } catch (e) { checks.push({ name, status: e instanceof SandboxReadError && e.category === 'PERMISSION' ? 'PASS' : 'ERROR' }); }
  };
  try {
    await directory(root);
    const safe = join(root, 'safe'); await file(safe);
    try { checks.push({ name: BRIDGE_CHECKS[0], status: (await sandboxReadFile(safe, policy, { signal })).equals(Buffer.from('safe-control')) ? 'PASS' : 'ERROR' }); }
    catch { checks.push({ name: BRIDGE_CHECKS[0], status: 'ERROR' }); }
    const symbolic = join(root, 'link'); await link(symbolic, outside);
    await deny(BRIDGE_CHECKS[1], symbolic);
    const parent = join(root, 'parent'); const retired = join(root, 'retired');
    await directory(parent);
    const leaf = join(parent, basename(outside)); await file(leaf);
    const observed = await realpath(leaf);
    await move(parent, retired);
    await link(parent, dirname(outside));
    await deny(BRIDGE_CHECKS[2], observed);
    // All paths belong to this invocation; never rename or remove a preexisting directory.
    await remove(owned.find(entry => entry.path === parent)!);
    await move(retired, parent);
    const read = inFlight = deny(BRIDGE_CHECKS[3], leaf, true);
    await move(parent, retired);
    await link(parent, dirname(outside));
    await read;
  } catch { for (const name of BRIDGE_CHECKS) if (!checks.some(c => c.name === name)) checks.push({ name, status: 'ERROR' }); }
  finally {
    await inFlight;
    let failed = false;
    for (const entry of [...owned].reverse()) {
      try { await remove(entry); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failed = true; }
    }
    if (failed) checks.push({ name: 'bridge.cleanup', status: 'ERROR' });
  }
  return checks;
}
