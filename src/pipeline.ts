import type {
  InboundMessage,
  SessionKey,
  AppConfig,
  BotConfig,
  Session,
  SenderInfo,
} from './types.js';
import { sanitizeInput } from './security/validators.js';
import { RateLimiter } from './security/rate-limiter.js';

function xmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildSenderHeader(sender: SenderInfo): string {
  const parts: string[] = [`channel="${xmlAttr(sender.channel)}"`];
  if (sender.userId) parts.push(`user_id="${xmlAttr(sender.userId)}"`);
  if (sender.botName) parts.push(`bot="${xmlAttr(sender.botName)}"`);
  if (sender.userName) parts.push(`name="${xmlAttr(sender.userName)}"`);
  return `<cti-sender ${parts.join(' ')}/>\n\n`;
}

export function buildSenderEnv(sender: SenderInfo): Record<string, string> {
  const env: Record<string, string> = {};
  if (sender.channel) env.CTI_SENDER_CHANNEL = sender.channel;
  if (sender.userId) env.CTI_SENDER_USER_ID = sender.userId;
  if (sender.userName) env.CTI_SENDER_NAME = sender.userName;
  return env;
}

const BRIDGE_COMMANDS = new Set([
  'new',
  'clear',
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
  'thinking',
  'fast',
  'perm',
  'sessions',
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
  const command = parts[0] === 'clear' ? 'new' : parts[0];
  if (!BRIDGE_COMMANDS.has(command)) return null;
  return { command, args: parts.slice(1) };
}

export function getGroupMessageSkipReason(
  msg: InboundMessage,
  botConfig: BotConfig,
  botOpenId?: string,
  relayBotCount?: number,
): string | undefined {
  if (msg.isRelay) return undefined;
  if (msg.chatType !== 'group') return undefined;

  const groupAllowFrom = botConfig.groupAllowFrom ?? [];
  const requiresAllowlist = botConfig.groupPolicy === 'allowlist' || groupAllowFrom.length > 0;
  if (requiresAllowlist && !groupAllowFrom.includes(msg.chatId)) {
    return 'Unauthorized group';
  }

  const relayImpliesMention = botConfig.relay?.enabled && (relayBotCount ?? 0) >= 2;
  const requireMention = botConfig.requireMention || relayImpliesMention;
  if (requireMention) {
    const mentioned = Boolean(botOpenId && (msg.mentions ?? []).includes(botOpenId));
    if (!mentioned) return 'Bot mention required';
  }

  return undefined;
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
    if (!msg.userId) {
      return { rejected: true, reason: 'Missing user id' };
    }

    const botConfig = this.config.bots[botName];
    if (!botConfig) {
      return { rejected: true, reason: `Unknown bot: ${botName}` };
    }

    const allowList = botConfig.allowFrom.map(String);
    if (!msg.isRelay && allowList.length > 0 && !allowList.includes('*') && !allowList.includes(msg.userId)) {
      return { rejected: true, reason: 'Unauthorized user' };
    }

    // Intentional: relay bypasses auth/mention/sanitization, but still hits
    // chat and user rate limiting as a defense-in-depth guard against bot loops.
    if (!this.rateLimiter.check(msg.chatId, msg.userId)) {
      return { rejected: true, reason: 'Rate limited' };
    }

    if (!msg.isRelay) {
      msg.text = sanitizeInput(msg.text);
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
