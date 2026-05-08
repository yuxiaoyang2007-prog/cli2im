import type { Transform, Writable, Readable } from 'node:stream';

// === Agent Plugin ===

export interface AgentCapabilities {
  streamJson: boolean;
  permissionPrompt: boolean;
  sessionResume: boolean;
  gracefulCancel: boolean;
  slashCommands: string[];
}

export interface SpawnOpts {
  workingDirectory: string;
  model?: string;
  permissionMode: 'bypass' | 'blacklist';
  env?: Record<string, string>;
  systemPrompt?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  sandboxMode?: string;
  autoApprove?: boolean;
  turnTimeoutMs?: number;
  idleTimeoutMs?: number;
  initialPrompt?: string;
}

export interface AgentProcess {
  pid: number;
  sessionId: string;
  stdin: Writable;
  stdout: Readable;
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void;
  on(event: 'exit', handler: (code: number | null) => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
}

export interface AgentPlugin {
  name: string;
  displayName: string;
  preflight(): Promise<{ ok: boolean; version?: string; error?: string }>;
  spawn(opts: SpawnOpts): AgentProcess;
  resume(sessionId: string, opts: SpawnOpts): AgentProcess;
  buildSpawnArgs(opts: SpawnOpts): string[];
  createStdoutParser(): Transform;
  formatStdinMessage(msg: UserMessage): string;
  formatPermissionResponse(requestId: string, decision: 'allow' | 'deny'): string;
  formatCancelMessage?(): string;
  capabilities: AgentCapabilities;
}

// === Agent Events ===

export type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; output: string; isError?: boolean }
  | { type: 'permission_request'; id: string; tool: string; input: Record<string, unknown> }
  | { type: 'status'; sessionId?: string; message?: string }
  | { type: 'result'; sessionId: string; usage?: TokenUsage; createdFiles?: string[] }
  | { type: 'error'; message: string }
  | { type: 'file'; path: string; mimeType?: string };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

// === Platform Adapter ===

export interface FileAttachment {
  type: 'image' | 'audio' | 'file';
  url?: string;
  localPath?: string;
  mimeType?: string;
  fileName?: string;
  size?: number;
  fileKey?: string;
  messageId?: string;
}

export interface SenderInfo {
  channel: string;
  userId?: string;
  userName?: string;
}

export interface InboundMessage {
  platform: string;
  chatId: string;
  userId: string;
  userName?: string;
  text: string;
  chatType?: string;
  attachments?: FileAttachment[];
  replyTo?: string;
  mentions?: string[];
  raw?: unknown;
}

export interface OutboundContent {
  text?: string;
  card?: CardPayload;
  file?: FilePayload;
}

export interface CardPayload {
  type: 'streaming' | 'final' | 'permission' | 'error';
  content: string;
  title?: string;
  buttons?: CardButton[];
}

export interface CardButton {
  text: string;
  value: string;
  type?: 'primary' | 'danger' | 'default';
}

export interface FilePayload {
  path: string;
  name: string;
  mimeType?: string;
}

export interface PlatformAdapter {
  name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => void): void;
  onCallback?(handler: (cb: CallbackQuery) => void): void;
  send(chatId: string, content: OutboundContent): Promise<string>;
  editMessage(chatId: string, msgId: string, content: string): Promise<void>;
  deleteMessage(chatId: string, msgId: string): Promise<void>;
  sendFile?(chatId: string, file: FilePayload): Promise<void>;
  sendCard?(chatId: string, card: CardPayload): Promise<string>;
  updateCard?(messageId: string, content: string, seq: number): Promise<void>;
  downloadFile?(messageId: string, fileKey: string, type: string): Promise<Buffer>;
}

export interface CallbackQuery {
  platform: string;
  chatId: string;
  userId: string;
  data: string;
  messageId: string;
}

// === User Message (to agent stdin) ===

export interface UserMessage {
  role: 'user';
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
      >;
  attachments?: FileAttachment[];
}

// === Session ===

export type SessionKey = `${string}:${string}:${string}`;

export interface Session {
  id: string;
  key: SessionKey;
  agentName: string;
  agentSessionId?: string;
  workingDirectory: string;
  process?: AgentProcess;
  state: 'active' | 'idle' | 'handed_off';
  createdAt: number;
  lastActiveAt: number;
}

// === Tool Gate ===

export interface ToolGateResult {
  action: 'allow' | 'block';
  reason?: string;
  command?: string;
}

export interface PendingPermission {
  requestId: string;
  tool: string;
  command: string;
  chatId: string;
  sessionKey: SessionKey;
  agentName: string;
  timer: ReturnType<typeof setTimeout>;
  createdAt: number;
}

// === Handoff ===

export interface HandoffRequest {
  botName: string;
  sessionId: string;
  workDir: string;
  agentName: string;
  chatId?: string;
}

export interface HandoffResult {
  success: boolean;
  error?: string;
}

export interface HandoffRelease {
  sessionId: string;
  resumeCommand: string;
}

// === Config ===

export interface BotConfig {
  agent: string;
  platform: 'feishu' | 'telegram';
  feishu?: {
    appId: string;
    appSecret: string;
  };
  telegram?: {
    token: string;
  };
  workingDirectory: string;
  allowFrom: string[];
  permissionMode: 'bypass' | 'blacklist';
  larkCliConfigDir?: string;
  autoApprove?: boolean;
  turnTimeoutMs?: number;
  idleTimeoutMs?: number;
  requireMention?: boolean;
  groupPolicy?: 'all' | 'allowlist';
  groupAllowFrom?: string[];
  userOverrides?: Record<string, { workingDirectory?: string }>;
  sandboxMode?: string;
}

export interface AgentConfig {
  binary: string;
  defaultModel?: string;
  env?: Record<string, string>;
}

export interface AppConfig {
  bots: Record<string, BotConfig>;
  agents: Record<string, AgentConfig>;
  session: {
    maxActive: number;
    idleResetMinutes: number;
    dbPath: string;
  };
  dangerousPatterns: string[];
  streaming: {
    intervalMs: number;
    minDeltaChars: number;
    highWaterMark: number;
  };
  server: {
    port: number;
    host: string;
    token: string;
  };
  newMessageBehavior: 'queue' | 'interrupt';
  contentGuard?: {
    enabled: boolean;
    blockThreshold?: number;
  };
}
