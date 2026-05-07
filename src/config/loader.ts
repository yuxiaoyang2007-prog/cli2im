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
}
