import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AppConfig, BotConfig } from '../types.js';

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
  const parsed = readConfig(configPath, env);
  validateConfig(parsed);
  return parsed;
}

/** Runtime loading isolates invalid bots without changing the user's configuration file. */
export function loadRuntimeConfig(
  configPath: string,
  env: Record<string, string | undefined> = process.env,
): { config: AppConfig; botErrors: Record<string, string> } {
  const config = readConfig(configPath, env);
  if (!isRecord(config) || !isRecord(config.bots)) throw new Error('Config error: "bots" section is required');
  const botErrors: Record<string, string> = Object.create(null);
  for (const [name, bot] of Object.entries(config.bots)) {
    try {
      validateBotConfig(name, bot);
    } catch {
      // Do not expose parser exceptions, paths, credentials, or user IDs in health output.
      botErrors[name] = 'Invalid bot configuration';
    }
  }
  validateConfig(config, { skipBots: true, botErrors });
  config.bots = Object.fromEntries(Object.entries(config.bots).filter(([name]) => !botErrors[name]));
  return { config, botErrors };
}

function readConfig(configPath: string, env: Record<string, string | undefined>): AppConfig {
  const substituted = substituteEnvVars(readFileSync(configPath, 'utf-8'), env);
  try {
    return parseYaml(substituted) as AppConfig;
  } catch {
    throw new Error('Config error: invalid YAML');
  }
}

function validateConfig(config: AppConfig, options: { skipBots?: boolean; botErrors?: Record<string, string> } = {}): void {
  if (!isRecord(config) || !isRecord(config.bots)) {
    throw new Error('Config error: "bots" section is required');
  }
  if (!options.skipBots) {
    for (const [name, bot] of Object.entries(config.bots)) validateBotConfig(name, bot);
  }

  // Warn if relay-enabled bots span different platforms
  const relayPlatforms = new Set<string>();
  for (const [name, bot] of Object.entries(config.bots)) {
    if (!options.botErrors?.[name] && bot?.relay?.enabled) {
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
  if (config.network != null) {
    if (!isRecord(config.network) || !['system', 'environment'].includes(config.network.mode)
      || typeof config.network.required !== 'boolean') {
      throw new Error('Config error: network requires mode system/environment and required boolean');
    }
    if (config.network.noProxy != null && (!Array.isArray(config.network.noProxy)
      || config.network.noProxy.some((host) => typeof host !== 'string' || !host.trim() || /[\s,]/.test(host)))) {
      throw new Error('Config error: network.noProxy must be an array of host patterns');
    }
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
    if (!Object.hasOwn(config.bots, codex.botName)) {
      throw new Error('Config error: notifications.codex.botName must name an existing bot');
    }
    if (!options.botErrors?.[codex.botName] && config.bots[codex.botName].platform !== 'feishu') {
      throw new Error('Config error: notifications.codex.botName must use the feishu platform');
    }
    if (options.botErrors?.[codex.botName]) codex.enabled = false;
    codex.completionSource ??= 'legacy';
    if (codex.completionSource !== 'legacy' && codex.completionSource !== 'structured') {
      throw new Error(
        'Config error: notifications.codex.completionSource must be "legacy" or "structured"',
      );
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

function validateBotConfig(name: string, bot: BotConfig): void {
  if (!bot || typeof bot !== 'object' || Array.isArray(bot)) {
    throw new Error(`Config error: bot "${name}" must be an object`);
  }
  for (const field of ['enabled', 'allowPublic'] as const) {
    if (bot[field] != null && typeof bot[field] !== 'boolean') {
      throw new Error(`Config error: bot "${name}" ${field} must be a boolean`);
    }
  }
  // Empty/missing user lists deny access; a wildcard never silently grants public access.
  bot.allowFrom = normalizeIdList(bot.allowFrom ?? [], `bot "${name}" allowFrom`, true);
  if (bot.adminUsers != null) bot.adminUsers = normalizeIdList(bot.adminUsers, `bot "${name}" adminUsers`);
  if (bot.groupAllowFrom != null) bot.groupAllowFrom = normalizeIdList(bot.groupAllowFrom, `bot "${name}" groupAllowFrom`);
  if (bot.sessionRoots != null) {
    if (!Array.isArray(bot.sessionRoots) || bot.sessionRoots.some((root) => typeof root !== 'string' || !root.trim())) {
      throw new Error(`Config error: bot "${name}" sessionRoots must be an array of paths`);
    }
    bot.sessionRoots = [...new Set(bot.sessionRoots.map((root) => {
      const resolved = realpathSync(expandHome(root));
      assertSafeExtraRoot(resolved);
      return resolved;
    }))];
  }
  if (bot.debounceMs != null && (!Number.isFinite(bot.debounceMs) || bot.debounceMs < 0 || bot.debounceMs > 10000)) {
    throw new Error(`Config error: bot "${name}" debounceMs must be between 0 and 10000`);
  }
  if (bot.projects != null) {
    if (!isRecord(bot.projects) || Object.entries(bot.projects).some(([key, value]) => !key.trim() || typeof value !== 'string' || !value.trim())) {
      throw new Error(`Config error: bot "${name}" projects must map names to paths`);
    }
  }
  if (bot.shortcuts != null) {
    if (!isRecord(bot.shortcuts) || Object.entries(bot.shortcuts).some(([key, value]) =>
      !/^[a-zA-Z0-9_-]+$/.test(key) || !isRecord(value) || typeof value.prompt !== 'string' || !value.prompt.trim()
      || (value.description != null && typeof value.description !== 'string'))) {
      throw new Error(`Config error: bot "${name}" shortcuts must map names to prompt/description objects`);
    }
  }
  if (bot.speech != null && (!isRecord(bot.speech)
    || ['stt', 'tts'].some((key) => bot.speech![key as 'stt' | 'tts'] != null && typeof bot.speech![key as 'stt' | 'tts'] !== 'boolean'))) {
    throw new Error(`Config error: bot "${name}" speech.stt/tts must be booleans`);
  }
  if (typeof bot.agent !== 'string' || !bot.agent.trim()) throw new Error(`Config error: bot "${name}" missing "agent"`);
  if (bot.platform !== 'feishu' && bot.platform !== 'telegram') throw new Error(`Config error: bot "${name}" platform must be feishu or telegram`);
  if (typeof bot.workingDirectory !== 'string' || !bot.workingDirectory.trim()) {
    throw new Error(`Config error: bot "${name}" workingDirectory must be a path`);
  }
  if (bot.permissionMode !== 'bypass' && bot.permissionMode !== 'blacklist') {
    throw new Error(`Config error: bot "${name}" permissionMode must be bypass or blacklist`);
  }
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
    if (bot.relay.allowFromBots != null) {
      bot.relay.allowFromBots = normalizeIdList(bot.relay.allowFromBots, `bot "${name}" relay.allowFromBots`);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeIdList(value: unknown, field: string, allowWildcard = false): string[] {
  if (!Array.isArray(value) || value.some((id) =>
    (typeof id !== 'string' && typeof id !== 'number') || !String(id).trim()
    || (!allowWildcard && String(id).trim() === '*'))) {
    throw new Error(`Config error: ${field} must be an array of explicit IDs${allowWildcard ? ' or *' : ''}`);
  }
  return [...new Set(value.map((id) => String(id).trim()))];
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
