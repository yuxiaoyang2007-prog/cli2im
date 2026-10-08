import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { policyPaths, buildIsolationPolicy } from '../../src/isolation/policy.js';
import type { AppConfig, BotConfig } from '../../src/types.js';

export function isolationFixture() {
  // System tmp is hard-denied on macOS; each caller removes this fixture in afterEach.
  const root = realpathSync(mkdtempSync(join(fileURLToPath(new URL('../', import.meta.url)), '.tmp-isolation-')));
  for (const dir of ['home', 'bridge', 'install', 'group', 'alice', 'bob', 'reference', 'outside']) mkdirSync(join(root, dir));
  const bot: BotConfig = { agent: 'codex', platform: 'feishu', feishu: { appId: 'fixture', appSecret: 'fixture' },
    permissionMode: 'blacklist', workingDirectory: join(root, 'group'), allowFrom: ['alice', 'bob'],
    isolation: { enabled: true, readable: [join(root, 'reference')] },
    userOverrides: { alice: { workingDirectory: join(root, 'alice') }, bob: { workingDirectory: join(root, 'bob') } } };
  const config: AppConfig = { bots: { bot }, agents: { codex: { binary: '/bin/cat' } },
    memory: { dir: join(root, 'bridge', 'memory') }, session: { dbPath: ':memory:' },
    server: { port: 12345, token: 'fixture' }, dangerousPatterns: [] } as unknown as AppConfig;
  const paths = policyPaths(config, { home: root, dataDir: join(root, 'bridge'), installDir: join(root, 'install'), codexSystemConfigs: [] });
  const workspace = join(root, 'alice');
  const policy = () => buildIsolationPolicy({ config, botName: 'bot', workspace, paths, binaryPath: '/bin/cat', sdkVersions: { fixture: '1' } });
  return { root, bot, config, paths, workspace, policy };
}
