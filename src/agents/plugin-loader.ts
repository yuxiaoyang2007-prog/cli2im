import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AgentConfig, AgentPlugin } from '../types.js';
import type { AgentManager } from './manager.js';
import { ClaudeCodePlugin } from './claude-code.js';
import { CodexPlugin } from './codex.js';
import { GeminiPlugin } from './gemini.js';
import { AgyPlugin } from './agy.js';
import { ZcodePlugin } from './zcode.js';
import { KimiWorkPlugin } from './kimi-work.js';

export const BUILTIN_AGENT_NAMES = [
  'claude-code',
  'codex',
  'gemini',
  'agy',
  'zcode',
  'kimi-work',
] as const;

type PluginConstructor<T extends unknown[]> = new (...args: T) => AgentPlugin;

const EXPORTED_CLASS_NAMES: Record<string, string> = {
  'claude-code': 'ClaudeCodePlugin',
  codex: 'CodexPlugin',
  gemini: 'GeminiPlugin',
  agy: 'AgyPlugin',
  zcode: 'ZcodePlugin',
  'kimi-work': 'KimiWorkPlugin',
};

export function createStaticAgentPlugin(
  name: string,
  agentConfig: AgentConfig,
): AgentPlugin | undefined {
  switch (name) {
    case 'claude-code':
      return new ClaudeCodePlugin(agentConfig.binary);
    case 'codex':
      return new CodexPlugin(agentConfig.binary);
    case 'gemini':
      return new GeminiPlugin(agentConfig.binary);
    case 'agy':
      return new AgyPlugin(agentConfig.binary);
    case 'zcode':
      return new ZcodePlugin(agentConfig.binary);
    case 'kimi-work':
      return new KimiWorkPlugin(agentConfig);
    default:
      return undefined;
  }
}

let reloadSequence = 0;

export async function loadHotAgentPlugin(
  name: string,
  agentConfig: AgentConfig,
  bundleDir?: string,
): Promise<AgentPlugin> {
  const defaultDir = join(dirname(fileURLToPath(import.meta.url)), 'agents');
  const candidatePath = join(bundleDir ?? defaultDir, `${name}.js`);

  if (!existsSync(candidatePath)) {
    const fallback = createStaticAgentPlugin(name, agentConfig);
    if (!fallback) {
      throw new Error(`Unknown agent plugin: ${name}`);
    }
    return fallback;
  }

  reloadSequence += 1;
  const moduleUrl = `${pathToFileURL(candidatePath).href}?t=${Date.now()}-${reloadSequence}`;
  const mod = (await import(moduleUrl)) as Record<string, unknown>;
  const className = EXPORTED_CLASS_NAMES[name];
  const PluginCtor = className ? mod[className] : undefined;

  if (typeof PluginCtor !== 'function') {
    throw new Error(`Hot-reload bundle ${candidatePath} does not export ${className ?? name}`);
  }

  if (name === 'kimi-work') {
    return new (PluginCtor as PluginConstructor<[AgentConfig]>)(agentConfig);
  }
  return new (PluginCtor as PluginConstructor<[string]>)(agentConfig.binary);
}

export async function hotReloadAgentPlugin(params: {
  agentManager: AgentManager;
  agentName: string;
  agentConfig: AgentConfig;
  bundleDir?: string;
}): Promise<AgentPlugin> {
  const { agentManager, agentName, agentConfig, bundleDir } = params;
  const nextPlugin = await loadHotAgentPlugin(agentName, agentConfig, bundleDir);
  const prevPlugin = agentManager.getPlugin(agentName);
  agentManager.registerPlugin(nextPlugin);

  if (
    prevPlugin
    && prevPlugin !== nextPlugin
    && agentManager.activeProcessCountForAgent(agentName) === 0
  ) {
    await prevPlugin.shutdown?.();
  }

  return nextPlugin;
}
