import type {
  InboundMessage,
  SessionKey,
  AppConfig,
  BotConfig,
  Session,
} from './types.js';
import { sanitizeInput } from './security/validators.js';
import { RateLimiter } from './security/rate-limiter.js';

const BRIDGE_COMMANDS = new Set([
  'new',
  'list',
  'switch',
  'cwd',
  'status',
  'stop',
  'kill',
  'resume',
  'handoff',
  'force-approve',
  'model',
]);

export interface BridgeCommand {
  command: string;
  args: string[];
}

export function isBridgeCommand(text: string): boolean {
  if (!text.startsWith('/')) return false;
  const cmd = text.slice(1).split(/\s+/)[0];
  return BRIDGE_COMMANDS.has(cmd);
}

export function parseBridgeCommand(text: string): BridgeCommand | null {
  if (!text.startsWith('/')) return null;
  const parts = text.slice(1).trim().split(/\s+/);
  const command = parts[0];
  if (!BRIDGE_COMMANDS.has(command)) return null;
  return { command, args: parts.slice(1) };
}

export interface PipelineContext {
  message: InboundMessage;
  botName: string;
  botConfig: BotConfig;
  sessionKey: SessionKey;
  session?: Session;
  bridgeCommand?: BridgeCommand;
}

export class InboundPipeline {
  private config: AppConfig;
  private rateLimiter: RateLimiter;
  private botsByPlatformApp = new Map<string, string>();

  constructor(config: AppConfig) {
    this.config = config;
    this.rateLimiter = new RateLimiter(20, 60000);

    for (const [botName, botConfig] of Object.entries(config.bots)) {
      if (botConfig.feishu) {
        this.botsByPlatformApp.set(`feishu:${botConfig.feishu.appId}`, botName);
      }
      if (botConfig.telegram) {
        this.botsByPlatformApp.set(`telegram:${botConfig.telegram.token}`, botName);
      }
    }
  }

  process(
    msg: InboundMessage,
    botName: string,
  ): PipelineContext | { rejected: true; reason: string } {
    msg.text = sanitizeInput(msg.text);

    const botConfig = this.config.bots[botName];
    if (!botConfig) {
      return { rejected: true, reason: `Unknown bot: ${botName}` };
    }

    if (botConfig.allowFrom.length > 0 && !botConfig.allowFrom.includes(msg.userId)) {
      return { rejected: true, reason: 'Unauthorized user' };
    }

    if (!this.rateLimiter.check(msg.chatId)) {
      return { rejected: true, reason: 'Rate limited' };
    }

    const sessionKey: SessionKey = `${msg.platform}:${msg.chatId}:${botName}`;
    const bridgeCommand = parseBridgeCommand(msg.text) ?? undefined;

    return {
      message: msg,
      botName,
      botConfig,
      sessionKey,
      bridgeCommand,
    };
  }
}
