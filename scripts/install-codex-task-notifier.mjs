import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative } from 'node:path';

const [source, dryRunValue] = process.argv.slice(2);
const dryRun = dryRunValue === 'true';
if (!source) throw new Error('plugin source is required');

const manifestPath = join(source, '.codex-plugin', 'plugin.json');
const hookPath = join(source, 'dist', 'lifecycle-hook.js');
const mcpPath = join(source, 'dist', 'mcp-server.js');
for (const required of [manifestPath, hookPath, mcpPath, join(source, 'hooks', 'hooks.json')]) {
  if (!(await isFile(required))) throw new Error(`required build output is missing: ${basename(required)}`);
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.name !== 'codex-task-notifier' || typeof manifest.version !== 'string') {
  throw new Error('invalid codex-task-notifier manifest');
}
const contentHash = await hashDirectory(source);
const safeVersion = manifest.version.replace(/[^A-Za-z0-9._-]/g, '-');
const destinationName = `codex-task-notifier-${safeVersion}-${contentHash.slice(0, 12)}`;
const home = homedir();
const destination = join(home, 'plugins', destinationName);
const marketplacePath = join(home, '.agents', 'plugins', 'marketplace.json');
const backupRoot = join(home, '.cli2im', 'backups', 'codex-task-notifier');
const marketplaceBackup = join(backupRoot, `marketplace-before-${contentHash.slice(0, 12)}.json`);
const rollbackPath = join(backupRoot, 'rollback.json');
const sourcePath = `./plugins/${destinationName}`;

console.log(`${dryRun ? 'DRY RUN' : 'INSTALL'} codex-task-notifier`);
console.log(`source: ${source}`);
console.log(`destination: ${destination}`);
console.log(`marketplace: ${marketplacePath}`);
if (dryRun) process.exit(0);

await privateDirectory(join(home, 'plugins'));
await privateDirectory(join(home, '.agents', 'plugins'));
await privateDirectory(backupRoot);

if (!(await exists(destination))) {
  await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
}
await hardenTree(destination);

let marketplace;
if (await isFile(marketplacePath)) {
  const original = await readFile(marketplacePath, 'utf8');
  marketplace = JSON.parse(original);
  if (!(await exists(marketplaceBackup))) await privateWrite(marketplaceBackup, original);
} else {
  marketplace = { name: 'personal', interface: { displayName: 'Personal' }, plugins: [] };
}
if (!Array.isArray(marketplace.plugins)) throw new Error('personal marketplace plugins must be an array');
const entry = {
  name: 'codex-task-notifier',
  source: { source: 'local', path: sourcePath },
  policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
  category: 'Productivity',
};
const index = marketplace.plugins.findIndex((plugin) => plugin?.name === entry.name);
if (index >= 0) marketplace.plugins[index] = entry;
else marketplace.plugins.push(entry);
await atomicPrivateWrite(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);
await atomicPrivateWrite(rollbackPath, `${JSON.stringify({
  version: 1,
  destination,
  marketplacePath,
  marketplaceBackup: await exists(marketplaceBackup) ? marketplaceBackup : null,
  sourcePath,
}, null, 2)}\n`);

console.log('status: installed');
console.log(`rollback: ${rollbackPath}`);

async function hashDirectory(root) {
  const hash = createHash('sha256');
  const files = await listFiles(root);
  for (const file of files) {
    hash.update(relative(root, file));
    hash.update(await readFile(file));
  }
  return hash.digest('hex');
}

async function listFiles(root) {
  const result = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

async function hardenTree(root) {
  const info = await lstat(root);
  if (info.isDirectory()) {
    await chmod(root, 0o700);
    for (const name of await readdir(root)) await hardenTree(join(root, name));
  } else if (info.isFile()) {
    await chmod(root, root.endsWith('/dist/lifecycle-hook.js') || root.endsWith('/dist/mcp-server.js') ? 0o700 : 0o600);
  }
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function privateWrite(path, contents) {
  await writeFile(path, contents, { mode: 0o600, flag: 'wx' });
  await chmod(path, 0o600);
}

async function atomicPrivateWrite(path, contents) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function isFile(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}
