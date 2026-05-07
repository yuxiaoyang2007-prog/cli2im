import { readFileSync } from 'node:fs';
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
    if (bot.groupPolicy != null && bot.groupPolicy !== 'all' && bot.groupPolicy !== 'allowlist') {
      throw new Error(`Config error: bot "${name}" groupPolicy must be "all" or "allowlist"`);
    }
    if (bot.groupAllowFrom != null && !Array.isArray(bot.groupAllowFrom)) {
      throw new Error(`Config error: bot "${name}" groupAllowFrom must be an array`);
    }
    if (bot.userOverrides != null && typeof bot.userOverrides !== 'object') {
      throw new Error(`Config error: bot "${name}" userOverrides must be an object`);
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
  if (!config.agents || typeof config.agents !== 'object') {
    throw new Error('Config error: "agents" section is required');
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
