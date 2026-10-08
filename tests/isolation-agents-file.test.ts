import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isolationFixture } from './helpers/isolation.js';
import { assertAgentsFile } from '../src/isolation/policy.js';
import { readAgentsInstructions, resolveBotSpawnOpts } from '../src/index.js';

let f: ReturnType<typeof isolationFixture>;
beforeEach(() => { f = isolationFixture(); });
afterEach(() => rmSync(f.root, { recursive: true, force: true }));

it('B2 agentsFile rejects every writable hop, including a link that escapes back to a maintained file', () => {
  const maintained = join(f.root, 'maintained'); mkdirSync(maintained); writeFileSync(join(maintained, 'AGENTS.md'), 'trusted');
  symlinkSync(maintained, join(f.workspace, 'escape'));
  symlinkSync(join(f.workspace, 'escape'), join(f.root, 'alias'));
  f.bot.agentsFile = join(f.root, 'alias/AGENTS.md');
  expect(() => assertAgentsFile(f.bot, [f.workspace])).toThrow('writable');
});
it('B2 integration: a parent symlink replacement cannot change the validated read target', async () => {
  const maintained = join(f.root, 'maintained'); mkdirSync(maintained); writeFileSync(join(maintained, 'AGENTS.md'), 'trusted');
  writeFileSync(join(f.workspace, 'AGENTS.md'), 'untrusted');
  const alias = join(f.root, 'alias'); symlinkSync(maintained, alias);
  f.bot.agentsFile = join(alias, 'AGENTS.md');
  const validated = assertAgentsFile(f.bot, [f.workspace])!;
  expect(validated).toBe(join(maintained, 'AGENTS.md'));
  renameSync(alias, join(f.root, 'old-alias')); symlinkSync(f.workspace, alias);
  expect(await readAgentsInstructions(validated, f.workspace)).toBe('trusted');
  await expect(resolveBotSpawnOpts({ botConfig: f.bot, workingDirectory: f.workspace, allWritable: [f.workspace] })).rejects.toThrow('writable');
});
