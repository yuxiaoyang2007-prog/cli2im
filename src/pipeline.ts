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
import { getBotAccessRejection, getGroupAccessRejection, isGroupChat } from './security/access-policy.js';
import { buildSessionKey } from './types.js';

function xmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildSenderHeader(sender: SenderInfo): string {
  const parts: string[] = [`channel="${xmlAttr(sender.channel)}"`];
  if (sender.userId) parts.push(`user_id="${xmlAttr(sender.userId)}"`);
  if (sender.botName) parts.push(`bot="${xmlAttr(sender.botName)}"`);
  if (sender.userName) parts.push(`name="${xmlAttr(sender.userName)}"`);
  if (sender.chatId) parts.push(`chat_id="${xmlAttr(sender.chatId)}"`);
  if (sender.chatType) parts.push(`chat_type="${xmlAttr(sender.chatType)}"`);
  return `<cti-sender ${parts.join(' ')}/>\n\n`;
}

export function buildSenderEnv(sender: SenderInfo): Record<string, string> {
  const env: Record<string, string> = {};
  if (sender.channel) env.CTI_SENDER_CHANNEL = sender.channel;
  if (sender.userId) env.CTI_SENDER_USER_ID = sender.userId;
  if (sender.userName) env.CTI_SENDER_NAME = sender.userName;
  if (sender.chatId) env.CTI_SENDER_CHAT_ID = sender.chatId;
  if (sender.chatType) env.CTI_SENDER_CHAT_TYPE = sender.chatType;
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
  'notify-me',
  'help',
  'projects',
  'cd',
  'task',
  'doctor',
  'bots',
  'result',
  'remember',
  'memory',
  'forget',
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
  const command = parts[0] === 'clear' ? 'new' : parts[0] === 'cd' ? 'cwd' : parts[0];
  if (!BRIDGE_COMMANDS.has(command)) return null;
  if (command === 'remember') return { command, args: [text.replace(/^\/remember\s*/, '')] };
  const edit = command === 'memory' ? /^\/memory\s+edit\s+(\S+)(?:\s+([\s\S]*))?$/.exec(text) : null;
  if (edit) return { command, args: ['edit', edit[1], edit[2] ?? ''] };
  return { command, args: parts.slice(1) };
}

export function getGroupMessageSkipReason(
  msg: InboundMessage,
  botConfig: BotConfig,
  botOpenId?: string,
  relayBotCount?: number,
): string | undefined {
  const groupRejection = getGroupAccessRejection(msg, botConfig);
  if (groupRejection) return groupRejection;
  if (!isGroupChat(msg.chatType)) return undefined;
  // Relay admission is checked by process(); it never overrides group restrictions.
  if (msg.isRelay) return undefined;

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

    if (msg.isRelay) {
      const source = msg.relayFromBot;
      if (botConfig.enabled === false || !botConfig.relay?.enabled || !source
        || !botConfig.relay.allowFromBots?.includes(source)
        || !this.config.bots[source]?.relay?.enabled
        || this.config.bots[source]?.enabled === false
        || this.config.bots[source]?.platform !== msg.platform
        || msg.userId !== `relay:${source}` || !isGroupChat(msg.chatType)) {
        return { rejected: true, reason: 'Unauthorized relay' };
      }
      const rejection = getGroupAccessRejection(msg, botConfig);
      if (rejection) return { rejected: true, reason: rejection };
    } else {
      const rejection = getBotAccessRejection(msg, botConfig);
      if (rejection) return { rejected: true, reason: rejection };
    }

    // Authorized relay messages also hit rate limiting to contain bot loops.
    if (!this.rateLimiter.check(msg.chatId, msg.userId)) {
      return { rejected: true, reason: 'Rate limited' };
    }

    if (!msg.isRelay) {
      msg.text = sanitizeInput(msg.text);
    }

    const sessionKey = buildSessionKey(msg.platform, msg.chatId, botName, msg.threadId);
    // A peer's output is task data; it cannot issue bridge control commands.
    const bridgeCommand = msg.isRelay ? undefined : parseBridgeCommand(msg.text) ?? undefined;

    return {
      message: msg,
      botName,
      botConfig,
      sessionKey,
      bridgeCommand,
    };
  }
}
