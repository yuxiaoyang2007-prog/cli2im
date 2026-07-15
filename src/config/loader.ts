import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AppConfig } from '../types.js';

export function substituteEnvVars(
  content: string,
  env: Record<string, string | undefined>,
): string {
  return content.replace(/\$\{([^}]+)\}/g, (_, key) => env[key] ?? '');
}

export function loadConfig(
  configPath: string,
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const raw = readFileSync(configPath, 'utf-8');
  const substituted = substituteEnvVars(raw, env);
  const parsed = parseYaml(substituted) as AppConfig;
  validateConfig(parsed);
  return parsed;
}

function validateConfig(config: AppConfig): void {
  if (!config.bots || typeof config.bots !== 'object') {
    throw new Error('Config error: "bots" section is required');
  }
  for (const [name, bot] of Object.entries(config.bots)) {
    if (!bot.agent) throw new Error(`Config error: bot "${name}" missing "agent"`);
    if (!bot.platform) throw new Error(`Config error: bot "${name}" missing "platform"`);
    if (bot.platform === 'feishu' && (!bot.feishu?.appId || !bot.feishu?.appSecret)) {
      throw new Error(`Config error: bot "${name}" missing feishu appId/appSecret`);
    }
    if (bot.platform === 'telegram' && !bot.telegram?.token) {
      throw new Error(`Config error: bot "${name}" missing telegram token`);
    }
    if (bot.turnTimeoutMs != null && (typeof bot.turnTimeoutMs !== 'number' || bot.turnTimeoutMs <= 0)) {
      throw new Error(`Config error: bot "${name}" turnTimeoutMs must be a positive number`);
    }
    if (bot.idleTimeoutMs != null && (typeof bot.idleTimeoutMs !== 'number' || bot.idleTimeoutMs <= 0)) {
      throw new Error(`Config error: bot "${name}" idleTimeoutMs must be a positive number`);
    }
    if (bot.autoApprove != null && typeof bot.autoApprove !== 'boolean') {
      throw new Error(`Config error: bot "${name}" autoApprove must be a boolean`);
    }
    if (bot.requireMention != null && typeof bot.requireMention !== 'boolean') {
      throw new Error(`Config error: bot "${name}" requireMention must be a boolean`);
    }
    if (
      bot.agentsFile != null
      && bot.agentsFile !== false
      && typeof bot.agentsFile !== 'string'
    ) {
      throw new Error(`Config error: bot "${name}" agentsFile must be a string or false`);
    }
    if (bot.groupPolicy != null && bot.groupPolicy !== 'all' && bot.groupPolicy !== 'allowlist') {
      throw new Error(`Config error: bot "${name}" groupPolicy must be "all" or "allowlist"`);
    }
    if (bot.groupAllowFrom != null && !Array.isArray(bot.groupAllowFrom)) {
      throw new Error(`Config error: bot "${name}" groupAllowFrom must be an array`);
    }
    if (bot.userOverrides != null && typeof bot.userOverrides !== 'object') {
      throw new Error(`Config error: bot "${name}" userOverrides must be an object`);
    }
    if (bot.sandbox == null) {
      bot.sandbox = 'workdir';
    } else if (bot.sandbox !== 'workdir' && bot.sandbox !== 'off') {
      throw new Error(`Config error: bot "${name}" sandbox must be "workdir" or "off"`);
    }
    if (bot.relay != null) {
      if (typeof bot.relay !== 'object' || Array.isArray(bot.relay)) {
        throw new Error(`Config error: bot "${name}" relay must be an object`);
      }
      if (typeof bot.relay.enabled !== 'boolean') {
        throw new Error(`Config error: bot "${name}" relay.enabled must be a boolean`);
      }
      if (
        bot.relay.maxConsecutiveRounds != null
        && (typeof bot.relay.maxConsecutiveRounds !== 'number' || bot.relay.maxConsecutiveRounds <= 0)
      ) {
        throw new Error(`Config error: bot "${name}" relay.maxConsecutiveRounds must be a positive number`);
      }
    }
    if (bot.userOverrides) {
      for (const [userId, override] of Object.entries(bot.userOverrides)) {
        if (typeof override !== 'object' || override == null || Array.isArray(override)) {
          throw new Error(`Config error: bot "${name}" userOverrides.${userId} must be an object`);
        }
        if (
          override.workingDirectory != null
          && typeof override.workingDirectory !== 'string'
        ) {
          throw new Error(
            `Config error: bot "${name}" userOverrides.${userId}.workingDirectory must be a string`,
          );
        }
      }
    }
  }

  // Warn if relay-enabled bots span different platforms
  const relayPlatforms = new Set<string>();
  for (const [, bot] of Object.entries(config.bots)) {
    if (bot.relay?.enabled) {
      relayPlatforms.add(bot.platform);
    }
  }
  if (relayPlatforms.size > 1) {
    console.warn(
      `[config] Relay-enabled bots span different platforms (${[...relayPlatforms].join(', ')}) — relay only works between bots sharing the same group chat.`,
    );
  }

  if (!config.agents || typeof config.agents !== 'object') {
    throw new Error('Config error: "agents" section is required');
  }
  if (config.notifications !== undefined) {
    const codex = config.notifications?.codex;
    if (typeof codex !== 'object' || codex === null || Array.isArray(codex)) {
      throw new Error('Config error: notifications.codex must be an object');
    }
    if (typeof codex.enabled !== 'boolean') {
      throw new Error('Config error: notifications.codex.enabled must be a boolean');
    }
    if (typeof codex.botName !== 'string' || codex.botName.trim().length === 0) {
      throw new Error('Config error: notifications.codex.botName must be a non-empty string');
    }
    if (!config.bots[codex.botName]) {
      throw new Error('Config error: notifications.codex.botName must name an existing bot');
    }
    if (config.bots[codex.botName].platform !== 'feishu') {
      throw new Error('Config error: notifications.codex.botName must use the feishu platform');
    }
  }
  if (config.sandboxExtraRoots != null) {
    if (!Array.isArray(config.sandboxExtraRoots)) {
      throw new Error('Config error: "sandboxExtraRoots" must be an array');
    }
    const roots = config.sandboxExtraRoots.map((root, index) => {
      if (typeof root !== 'string') {
        throw new Error(`Config error: sandboxExtraRoots[${index}] must be a string`);
      }
      const resolved = realpathSync(expandHome(root));
      assertSafeExtraRoot(resolved);
      return resolved;
    });
    config.sandboxExtraRoots = [...new Set(roots)];
  }
  if (!config.server?.port || !config.server?.token) {
    throw new Error('Config error: "server.port" and "server.token" are required');
  }
  if (!Array.isArray(config.dangerousPatterns)) {
    throw new Error('Config error: "dangerousPatterns" must be an array');
  }
  if (config.contentGuard) {
    if (typeof config.contentGuard.enabled !== 'boolean') {
      throw new Error('Config error: "contentGuard.enabled" must be a boolean');
    }
    if (
      config.contentGuard.blockThreshold != null
      && (
        typeof config.contentGuard.blockThreshold !== 'number'
        || config.contentGuard.blockThreshold <= 0
      )
    ) {
      throw new Error('Config error: "contentGuard.blockThreshold" must be a positive number');
    }
  }
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return `${homedir()}/${path.slice(2)}`;
  return path;
}

function assertSafeExtraRoot(path: string): void {
  const home = realpathSync(expandHome('~'));
  const denied = new Set([
    '/',
    '/Users',
    home,
    '/private',
    '/private/tmp',
    '/System',
    '/Library',
    '/Applications',
    '/Volumes',
  ]);
  if (denied.has(path)) {
    throw new Error(`Config error: sandboxExtraRoots must not include ${path}`);
  }
}

function isPathWithinAnyRoot(path: string, roots: string[]): boolean {
  return roots.some((root) => {
    const rel = relative(root, path);
    return rel === '' || (!!rel && !rel.startsWith('..') && !rel.startsWith('/'));
  });
}
