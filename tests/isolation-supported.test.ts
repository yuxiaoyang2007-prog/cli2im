import { afterEach, beforeEach, expect, it } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { isolationFixture } from './helpers/isolation.js';
import { assertSupportedIsolationAgent } from '../src/isolation/supported.js';
import { loadConfig, loadRuntimeConfig } from '../src/config/loader.js';

let f: ReturnType<typeof isolationFixture>;
beforeEach(() => { f = isolationFixture(); });
afterEach(() => rmSync(f.root, { recursive: true, force: true }));
it.each(['agy', 'gemini', 'zcode', 'kimi-work', 'future-agent'])('slice 8 unit: %s is UNSUPPORTED', agent => {
  expect(() => assertSupportedIsolationAgent(agent)).toThrow('UNSUPPORTED');
  f.bot.agent = agent;
  expect(() => f.policy()).toThrow('UNSUPPORTED');
});
it.each(['agy', 'gemini', 'zcode', 'kimi-work'])('slice 8 integration: config prevents %s from entering execution, baseline still loads', agent => {
  f.bot.agent = agent;
  const file = join(f.root, 'config.yaml');
  writeFileSync(file, stringify(f.config));
  expect(() => loadConfig(file)).toThrow('UNSUPPORTED');
  expect(loadRuntimeConfig(file).config.bots).toEqual({});
  f.bot.isolation = undefined;
  writeFileSync(file, stringify(f.config));
  expect(loadConfig(file).bots.bot.agent).toBe(agent);
});
