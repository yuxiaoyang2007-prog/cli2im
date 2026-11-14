import { loadDataDirDotEnv } from './dotenv.js';
import { loadRuntimeConfig } from './loader.js';
import type { ToolGate } from '../agents/tool-gate.js';
import { initContentGuard } from '../security/content-guard.js';
import type { AgentConfig, AppConfig, BotConfig } from '../types.js';

export interface HotReloadResult {
  reloadedAt: number;
  updatedBots: string[];
  warnings: string[];
}

export interface HotReloadDeps {
  config: AppConfig;
  configPath: string;
  envPath?: string;
  toolGate?: Pick<ToolGate, 'updatePatterns'>;
  env?: NodeJS.ProcessEnv;
}

const MUTABLE_OPTIONAL_BOT_KEYS: Array<keyof BotConfig> = [
  'adminUsers',
  'allowPublic',
  'sessionRoots',
  'projects',
  'shortcuts',
  'debounceMs',
  'speech',
  'env',
  'agentsFile',
  'larkCliConfigDir',
  'autoApprove',
  'turnTimeoutMs',
  'idleTimeoutMs',
  'requireMention',
  'groupPolicy',
  'groupAllowFrom',
  'userOverrides',
  'sandbox',
  'sandboxMode',
  'relay',
  'isolation',
  'memory',
  'plugins',
  'skills',
];

function syncAgentInPlace(target: AgentConfig, next: AgentConfig): void {
  target.binary = next.binary;
  if (next.defaultModel !== undefined) target.defaultModel = next.defaultModel;
  else delete target.defaultModel;
  if (next.defaultEffort !== undefined) target.defaultEffort = next.defaultEffort;
  else delete target.defaultEffort;
  if (next.env !== undefined) target.env = { ...next.env };
  else delete target.env;
}

function syncBotInPlace(target: BotConfig, next: BotConfig): void {
  target.workingDirectory = next.workingDirectory;
  target.allowFrom = [...next.allowFrom];
  target.permissionMode = next.permissionMode;
  for (const key of MUTABLE_OPTIONAL_BOT_KEYS) {
    if (next[key] !== undefined) {
      (target as unknown as Record<string, unknown>)[key] = structuredClone(next[key]);
    } else {
      delete (target as unknown as Record<string, unknown>)[key];
    }
  }
}

export async function applyHotConfigReload(deps: HotReloadDeps): Promise<HotReloadResult> {
  const { config, configPath, envPath, toolGate, env = process.env } = deps;
  loadDataDirDotEnv(envPath, env, { overwrite: true });

  const { config: nextConfig, botErrors } = loadRuntimeConfig(configPath, env);
  const warnings: string[] = [];
  const updatedBots: string[] = [];

  for (const botName of Object.keys(botErrors)) {
    warnings.push(`Skipped invalid bot "${botName}"`);
  }

  for (const [agentName, nextAgent] of Object.entries(nextConfig.agents)) {
    const currentAgent = config.agents[agentName];
    if (currentAgent) {
      if (currentAgent.binary !== nextAgent.binary) {
        warnings.push(`Agent "${agentName}" binary changed; run bots reload to apply binary change`);
      }
      syncAgentInPlace(currentAgent, nextAgent);
    } else {
      config.agents[agentName] = structuredClone(nextAgent);
    }
  }

  for (const [botName, currentBot] of Object.entries(config.bots)) {
    if (botErrors[botName]) continue;
    const nextBot = nextConfig.bots[botName];
    if (!nextBot) {
      warnings.push(`Bot "${botName}" removed from config; restart daemon to unload`);
      continue;
    }
    if (nextBot.platform !== currentBot.platform || nextBot.agent !== currentBot.agent) {
      warnings.push(`Bot "${botName}" changed platform/agent; restart daemon to apply`);
      continue;
    }
    if ((nextBot.enabled ?? true) !== (currentBot.enabled ?? true)) {
      warnings.push(`Bot "${botName}" enabled flag changed; use bots start/stop to toggle`);
    }
    syncBotInPlace(currentBot, nextBot);
    updatedBots.push(botName);
  }

  for (const botName of Object.keys(nextConfig.bots)) {
    if (!config.bots[botName]) {
      warnings.push(`New bot "${botName}" added in config; restart daemon to start it`);
    }
  }

  config.dangerousPatterns = [...nextConfig.dangerousPatterns];
  toolGate?.updatePatterns(config.dangerousPatterns);

  config.sandboxExtraRoots = nextConfig.sandboxExtraRoots
    ? [...nextConfig.sandboxExtraRoots]
    : undefined;
  config.newMessageBehavior = nextConfig.newMessageBehavior;
  config.streaming = { ...nextConfig.streaming };
  config.contentGuard = nextConfig.contentGuard ? { ...nextConfig.contentGuard } : undefined;
  initContentGuard({
    enabled: config.contentGuard?.enabled !== false,
    blockThreshold: config.contentGuard?.blockThreshold,
  });

  if (
    nextConfig.server.port !== config.server.port
    || nextConfig.server.host !== config.server.host
  ) {
    warnings.push('server.host/port changed; restart daemon to rebind');
  }
  if (nextConfig.session.dbPath !== config.session.dbPath) {
    warnings.push('session.dbPath changed; restart daemon to reopen database');
  }
  if (JSON.stringify(nextConfig.network ?? null) !== JSON.stringify(config.network ?? null)) {
    warnings.push('network config changed; restart daemon to reinitialize network policy');
  }

  return {
    reloadedAt: Date.now(),
    updatedBots,
    warnings,
  };
}
