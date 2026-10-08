import type { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import * as lark from '@larksuiteoapi/node-sdk';
import { extname } from 'node:path';
import type {
  PlatformAdapter,
  InboundMessage,
  OutboundContent,
  FilePayload,
  CardPayload,
  CallbackQuery,
} from '../../types.js';
import type { AbortableOptions } from '../../abort.js';
import { throwIfAborted } from '../../abort.js';
import { openVerifiedOutboundFile } from '../../security/outbound-file.js';
import { assertWithinAttachmentDownloadLimit } from '../../security/download-limits.js';
import { createPrivateSdkLogger, safeErrorFields } from '../../security/logging.js';
import { buildChildEnv } from '../../security/child-env.js';
import { createWebSocketProxyAgent } from '../../security/network-policy.js';

export interface FeishuAdapterConfig {
  appId: string;
  appSecret: string;
  botName: string;
}

export type FeishuResponseErrorCategory =
  | 'feishu_business_error'
  | 'feishu_invalid_response';

export class FeishuResponseError extends Error {
  readonly category: FeishuResponseErrorCategory;

  constructor(category: FeishuResponseErrorCategory, message: string) {
    super(message);
    this.name = 'FeishuResponseError';
    this.category = category;
  }
}

export class FeishuSdkBoundaryError extends Error {
  readonly category = 'feishu_request_timeout' as const;

  constructor() {
    super('Feishu request timed out');
    this.name = 'FeishuSdkBoundaryError';
  }
}

export class FeishuAdapter implements PlatformAdapter {
  name = 'feishu';
  private client: lark.Client;
  private wsClient?: lark.WSClient;
  private wsAgent?: ReturnType<typeof createWebSocketProxyAgent>;
  private messageHandler?: (msg: InboundMessage) => void;
  private callbackHandler?: (cb: CallbackQuery) => void;
  private config: FeishuAdapterConfig;
  private processedMessageIds = new Set<string>();
  private botOpenId?: string;
  private sentMessageRoutes = new Map<string, { chatId: string; threadId?: string; chatType?: string }>();
  private chatTypes = new Map<string, string>();

  constructor(config: FeishuAdapterConfig) {
    this.config = config;
    this.client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: lark.AppType.SelfBuild,
      logger: createPrivateSdkLogger('feishu'),
      loggerLevel: lark.LoggerLevel.warn,
    });
  }

  async connect(): Promise<void> {
    this.closeConnection();
    const agent = createWebSocketProxyAgent();
    const wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.warn,
      logger: createPrivateSdkLogger('feishu'),
      agent,
    });
    this.wsAgent = agent;
    this.wsClient = wsClient;
    await this.resolveBotIdentity();
    if (this.wsClient !== wsClient) return;

    const eventDispatcher = new lark.EventDispatcher({
      loggerLevel: lark.LoggerLevel.warn,
      logger: createPrivateSdkLogger('feishu'),
    }).register({
      'im.message.receive_v1': (data: unknown) => this.handleMessage(data),
      'card.action.trigger': (data: unknown) => this.handleCardAction(data),
    });

    try {
      await (wsClient.start as (params: unknown) => Promise<void>)({ eventDispatcher });
    } catch (error) {
      if (this.wsClient === wsClient) this.closeConnection();
      throw privateFeishuError(error);
    }
  }

  async disconnect(): Promise<void> {
    this.closeConnection();
  }

  private closeConnection(): void {
    const client = this.wsClient;
    const agent = this.wsAgent;
    this.wsClient = undefined;
    this.wsAgent = undefined;
    try { client?.close({ force: true }); } finally { agent?.destroy(); }
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  onCallback(handler: (cb: CallbackQuery) => void): void {
    this.callbackHandler = handler;
  }

  async send(chatId: string, content: OutboundContent, options: AbortableOptions = {}): Promise<string> {
    if (content.card) {
      return this.sendCard(chatId, content.card, { ...options, threadId: content.threadId ?? options.threadId, replyToMessageId: content.replyToMessageId ?? options.replyToMessageId });
    }

    const resp = await atFeishuSdkBoundary(
      () => this.createMessage(chatId, 'text', JSON.stringify({ text: content.text ?? '' }), {
        ...options,
        threadId: content.threadId ?? options.threadId,
        replyToMessageId: content.replyToMessageId ?? options.replyToMessageId,
      }),
      options.signal,
    );
    return requireSuccessfulFeishuMessageId(resp, 'text create');
  }

  private async createMessage(chatId: string, type: string, content: string, options: AbortableOptions): Promise<unknown> {
    const data = { msg_type: type, content, ...(options.idempotencyKey ? { uuid: options.idempotencyKey } : {}) };
    if (options.replyToMessageId) {
      const response = await this.client.im.message.reply({
        path: { message_id: options.replyToMessageId },
        data: { ...data, reply_in_thread: Boolean(options.threadId) },
      });
      this.rememberSentRoute(response, chatId, options.threadId);
      return response;
    }
    // A Feishu thread cannot be addressed by thread_id alone; never silently post in the main chat.
    if (options.threadId) throw new FeishuResponseError('feishu_invalid_response', 'Feishu thread reply requires an anchor message');
    const response = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' as const },
      data: { ...data, receive_id: chatId },
    });
    this.rememberSentRoute(response, chatId);
    return response;
  }

  private rememberSentRoute(response: unknown, chatId: string, threadId?: string): void {
    const messageId = readNestedString(response, ['data', 'message_id']);
    if ((response as { code?: number } | undefined | null)?.code !== 0 || !messageId) return;
    this.sentMessageRoutes.set(messageId, { chatId, threadId, chatType: this.chatTypes.get(chatId) });
    if (this.sentMessageRoutes.size > 2000) this.sentMessageRoutes.delete(this.sentMessageRoutes.keys().next().value!);
  }

  async editMessage(_chatId: string, msgId: string, content: string): Promise<void> {
    await atFeishuSdkBoundary(() => this.client.im.message.patch({
      path: { message_id: msgId },
      data: { content: JSON.stringify({ text: content }) },
    }));
  }

  async deleteMessage(_chatId: string, msgId: string): Promise<void> {
    await atFeishuSdkBoundary(() => this.client.im.message.delete({
      path: { message_id: msgId },
    }));
  }

  async sendFile(chatId: string, file: FilePayload, options: AbortableOptions = {}): Promise<void> {
    throwIfAborted(options.signal);
    const handle = file.data ? undefined : await openVerifiedOutboundFile(file);
    const stream = handle?.createReadStream();
    stream?.once('close', () => {
      void handle?.close().catch(() => undefined);
    });

    if (isImageFile(file.name || file.path)) {
      throwIfAborted(options.signal);
      const uploadResp = await withFeishuUploadHint(
        atFeishuSdkBoundary(() => this.client.im.image.create(withSignal({
          data: {
            image_type: 'message' as const,
            image: file.data ?? stream!,
          },
        }, options.signal)), options.signal),
        'image upload',
      );
      throwIfAborted(options.signal);

      const imageKey = readNestedString(uploadResp, ['image_key'])
        ?? readNestedString(uploadResp, ['data', 'image_key']);
      if (!imageKey) return;

      throwIfAborted(options.signal);
      await atFeishuSdkBoundary(() => this.createMessage(chatId, 'image', JSON.stringify({ image_key: imageKey }), options), options.signal);
      throwIfAborted(options.signal);
      return;
    }

    throwIfAborted(options.signal);
    const uploadResp = await withFeishuUploadHint(
      atFeishuSdkBoundary(() => this.client.im.file.create(withSignal({
        data: {
          file_type: 'stream' as const,
          file_name: file.name,
          file: file.data ?? stream!,
        },
      }, options.signal)), options.signal),
      'file upload',
    );
    throwIfAborted(options.signal);

    const fileKey = readNestedString(uploadResp, ['file_key'])
      ?? readNestedString(uploadResp, ['data', 'file_key']);
    if (!fileKey) return;

    throwIfAborted(options.signal);
    await atFeishuSdkBoundary(() => this.createMessage(chatId, 'file', JSON.stringify({ file_key: fileKey }), options), options.signal);
    throwIfAborted(options.signal);
  }

  async sendAudio(chatId: string, audioBuffer: Buffer, options: AbortableOptions = {}): Promise<void> {
    throwIfAborted(options.signal);
    throwIfAborted(options.signal);

    const opusBuffer = await new Promise<Buffer | null>((resolve, reject) => {
      try {
        throwIfAborted(options.signal);
        const proc = spawn('ffmpeg', [
          '-i', 'pipe:0', '-c:a', 'libopus', '-b:a', '64k',
          '-ar', '48000', '-ac', '1', '-f', 'ogg', 'pipe:1',
        ], { stdio: ['pipe', 'pipe', 'pipe'], env: buildChildEnv('local-tool') });
        const abort = () => {
          proc.kill('SIGTERM');
          reject(new DOMException('Operation aborted', 'AbortError'));
        };
        if (options.signal?.aborted) {
          abort();
          return;
        }
        options.signal?.addEventListener('abort', abort, { once: true });
        const chunks: Buffer[] = [];
        proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
        proc.on('close', (code) => {
          options.signal?.removeEventListener('abort', abort);
          if (options.signal?.aborted) return;
          resolve(code === 0 && chunks.length > 0 ? Buffer.concat(chunks) : null);
        });
        proc.on('error', () => {
          options.signal?.removeEventListener('abort', abort);
          if (options.signal?.aborted) return;
          resolve(null);
        });
        proc.stdin.write(audioBuffer);
        proc.stdin.end();
      } catch (err) { reject(err); }
    });
    throwIfAborted(options.signal);

    if (!opusBuffer) {
      console.error('[feishu] ffmpeg MP3→Opus conversion failed');
      return;
    }

    const { createReadStream: createTmpRead } = await import('node:fs');
    const { mkdtemp, writeFile: writeTmp, rm: rmTmp } = await import('node:fs/promises');
    const { join: joinPath } = await import('node:path');
    const { tmpdir: getTmpdir } = await import('node:os');
    throwIfAborted(options.signal);
    const tmpDirectory = await mkdtemp(joinPath(getTmpdir(), 'cli2im-opus-'));
    const tmpPath = joinPath(tmpDirectory, 'voice.ogg');
    let uploadResp: unknown;
    let fileStream: ReturnType<typeof createTmpRead> | undefined;
    try {
      await writeTmp(tmpPath, opusBuffer, { mode: 0o600, flag: 'wx' });
      throwIfAborted(options.signal);
      const uploadStream = createTmpRead(tmpPath);
      fileStream = uploadStream;
      uploadResp = await atFeishuSdkBoundary(() => this.client.im.file.create(withSignal({
        data: {
          file_type: 'opus' as const,
          file_name: 'voice.opus',
          file: uploadStream,
        },
      }, options.signal)), options.signal);
      throwIfAborted(options.signal);
    } finally {
      fileStream?.destroy();
      await rmTmp(tmpDirectory, { recursive: true, force: true }).catch(() => {});
    }

    const fileKey = readNestedString(uploadResp, ['file_key'])
      ?? readNestedString(uploadResp, ['data', 'file_key']);
    if (!fileKey) return;

    throwIfAborted(options.signal);
    await atFeishuSdkBoundary(() => this.createMessage(chatId, 'audio', JSON.stringify({ file_key: fileKey }), options), options.signal);
    throwIfAborted(options.signal);
  }

  async downloadFile(messageId: string, fileKey: string, type: string, options: AbortableOptions = {}): Promise<Buffer> {
    throwIfAborted(options.signal);
    const resp = await atFeishuSdkBoundary(() => this.client.im.messageResource.get(withSignal({
      path: { message_id: messageId, file_key: fileKey },
      params: { type: type === 'image' ? 'image' : 'file' },
    }, options.signal)), options.signal);
    throwIfAborted(options.signal);
    const readable = await getReadableStreamFromResponse(resp);
    throwIfAborted(options.signal);
    return streamToBuffer(readable, options.signal);
  }

  async sendCard(chatId: string, card: CardPayload, options: AbortableOptions = {}): Promise<string> {
    const cardJson = this.buildCardJson(card);
    const resp = await atFeishuSdkBoundary(
      () => this.createMessage(chatId, 'interactive', JSON.stringify(cardJson), options),
      options.signal,
    );
    return requireSuccessfulFeishuMessageId(resp, 'card create');
  }

  async updateCard(
    messageId: string,
    content: string,
    _seq: number,
    options: AbortableOptions = {},
  ): Promise<void> {
    const card = this.buildCardJson({ type: 'streaming', content });
    const response = await atFeishuSdkBoundary(
      () => this.client.im.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      }),
      options.signal,
    );
    assertSuccessfulFeishuResponse(response, 'card patch');
  }

  async replaceCard(
    messageId: string,
    card: CardPayload,
    options: AbortableOptions = {},
  ): Promise<void> {
    const cardJson = this.buildCardJson(card);
    const response = await atFeishuSdkBoundary(
      () => this.client.im.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(cardJson) },
      }),
      options.signal,
    );
    assertSuccessfulFeishuResponse(response, 'card patch');
  }

  getClient(): lark.Client {
    return this.client;
  }

  getBotOpenId(): string | undefined {
    return this.botOpenId;
  }

  private async resolveBotIdentity(): Promise<void> {
    try {
      const tokenResp = await fetch(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({
            app_id: this.config.appId,
            app_secret: this.config.appSecret,
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      const tokenBody = await readJsonResponse(tokenResp);
      if (!tokenResp.ok) {
        throw new Error(`Failed to resolve Feishu tenant token: ${formatFeishuError(tokenBody)}`);
      }

      const tenantAccessToken = readNestedString(tokenBody, ['tenant_access_token']);
      if (!tenantAccessToken) {
        throw new Error(`Feishu tenant token response missing tenant_access_token: ${formatFeishuError(tokenBody)}`);
      }

      const botResp = await fetch('https://open.feishu.cn/open-apis/bot/v3/info/', {
        headers: { Authorization: `Bearer ${tenantAccessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      const botBody = await readJsonResponse(botResp);
      if (!botResp.ok) {
        throw new Error(`Failed to resolve Feishu bot identity: ${formatFeishuError(botBody)}`);
      }

      const openId = readNestedString(botBody, ['bot', 'open_id'])
        ?? readNestedString(botBody, ['data', 'bot', 'open_id'])
        ?? readNestedString(botBody, ['data', 'open_id'])
        ?? readNestedString(botBody, ['open_id']);
      if (!openId) {
        throw new Error(`Feishu bot info response missing open_id: ${formatFeishuError(botBody)}`);
      }

      this.botOpenId = openId;
    } catch (err) {
      this.botOpenId = undefined;
      console.warn(
        `[cli2im] Failed to resolve Feishu bot identity: bot=${this.config.botName}`,
        safeErrorFields(err),
      );
    }
  }

  private handleMessage(data: unknown): void {
    if (!this.messageHandler) return;

    const event = unwrapEvent(data);
    const message = event.message;
    if (!message) return;
    if (message.chat_type === 'p2p' || message.chat_type === 'group') {
      this.chatTypes.set(message.chat_id, message.chat_type);
      if (this.chatTypes.size > 2000) this.chatTypes.delete(this.chatTypes.keys().next().value!);
    }

    const msgId = message.message_id;
    if (msgId && this.processedMessageIds.has(msgId)) return;
    if (msgId) {
      this.processedMessageIds.add(msgId);
    }
    if (this.processedMessageIds.size > 1000) {
      const arr = [...this.processedMessageIds];
      this.processedMessageIds = new Set(arr.slice(-500));
    }

    const sender = event.sender;
    if (sender?.sender_type === 'app') return;

    let text = '';
    const attachments = [];
    if (message.message_type === 'text') {
      try {
        const content = JSON.parse(message.content ?? '{}');
        text = content.text ?? '';
      } catch {
        text = message.content ?? '';
      }
    } else if (message.message_type === 'image') {
      const content = parseMessageContent(message.content);
      if (typeof content.image_key === 'string') {
        attachments.push({
          type: 'image' as const,
          fileKey: content.image_key,
          messageId: message.message_id,
          mimeType: 'image/png',
        });
      }
    } else if (message.message_type === 'audio') {
      const content = parseMessageContent(message.content);
      const fileKey = content.file_key ?? content.fileKey;
      if (typeof fileKey === 'string') {
        attachments.push({
          type: 'audio' as const,
          fileKey,
          messageId: message.message_id,
          mimeType: 'audio/ogg',
        });
      }
    } else if (message.message_type === 'file') {
      const content = parseMessageContent(message.content);
      if (typeof content.file_key === 'string') {
        attachments.push({
          type: 'file' as const,
          fileKey: content.file_key,
          messageId: message.message_id,
          fileName: typeof content.file_name === 'string' ? content.file_name : undefined,
        });
      }
    } else if (message.message_type === 'post') {
      const { extractedText, imageKeys } = parsePostContent(message.content);
      text = extractedText;
      for (const key of imageKeys) {
        attachments.push({
          type: 'image' as const,
          fileKey: key,
          messageId: message.message_id,
          mimeType: 'image/png',
        });
      }
    }

    let isVoice = message.message_type === 'audio';
    text = text.replace(/@_user_\d+\s*/g, '').trim();

    const mentions = (message.mentions ?? [])
      .map((mention: FeishuMention) => mention.id?.open_id)
      .filter((openId: string | undefined): openId is string => Boolean(openId));

    this.messageHandler({
      platform: 'feishu',
      chatId: message.chat_id,
      messageId: message.message_id,
      threadId: message.thread_id,
      userId: sender?.sender_id?.open_id ?? '',
      userName: sender?.sender_id?.open_id,
      text,
      chatType: message.chat_type,
      attachments: attachments.length > 0 ? attachments : undefined,
      isVoice,
      mentions,
      raw: data,
    });
  }

  private handleCardAction(data: unknown): unknown {
    const raw = asCallbackRecord(data);
    const ctx = asCallbackRecord(raw.context ?? raw);
    const operator = asCallbackRecord(raw.operator);
    const action = asCallbackRecord(raw.action);
    const actionValue = asCallbackRecord(action.value);
    const messageId = readCallbackString(ctx.open_message_id) ?? readCallbackString(raw.open_message_id);
    const chatId = readCallbackString(ctx.open_chat_id) ?? '';
    const sentRoute = messageId ? this.sentMessageRoutes.get(messageId) : undefined;
    console.log(
      `[feishu] callback=card_action chat=${callbackChatCategory(ctx.chat_type ?? raw.chat_type)}`
      + ` operator=${readCallbackString(operator.open_id) || readCallbackString(raw.open_id) ? 'present' : 'absent'}`
      + ` message=${messageId ? 'present' : 'absent'} valueKeys=${Object.keys(actionValue).length}`,
    );
    if (!this.callbackHandler) return undefined;
    if (!sentRoute || sentRoute.chatId !== chatId) {
      // Reconstructing an old topic from button data would let it target the wrong session.
      return { toast: { type: 'info', content: '这张卡片已失效，请发送 /status 获取新卡片。' } };
    }
    const chatType = sentRoute.chatType ?? this.chatTypes.get(chatId)
      ?? readCallbackString(ctx.chat_type) ?? readCallbackString(raw.chat_type);
    if (chatType !== 'p2p' && chatType !== 'group') {
      return { toast: { type: 'info', content: '请先发送 /status，确认当前聊天后再操作。' } };
    }

    this.callbackHandler({
      platform: 'feishu',
      chatId,
      userId: readCallbackString(operator.open_id) ?? readCallbackString(raw.open_id) ?? '',
      chatType,
      data: JSON.stringify(action.value ?? {}),
      messageId: messageId ?? '',
      threadId: sentRoute.threadId,
    });

    return undefined;
  }

  private buildCardJson(card: CardPayload): object {
    return {
      config: {
        wide_screen_mode: true,
      },
      elements: card.rawElements ?? [
        {
          tag: 'markdown',
          content: card.content,
        },
        ...(card.buttons?.map((btn) => ({
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: btn.text },
              type: btn.type ?? 'default',
              value: { action: btn.value },
            },
          ],
        })) ?? []),
      ],
      header: card.title
        ? {
            title: { tag: 'plain_text', content: card.title },
            ...(card.headerTemplate ? { template: card.headerTemplate } : {}),
          }
        : undefined,
    };
  }
}

function asCallbackRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readCallbackString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function callbackChatCategory(value: unknown): string {
  return value === 'p2p' || value === 'group' || value === 'supergroup' || value === 'channel'
    ? value
    : 'unknown';
}

function assertSuccessfulFeishuResponse(response: unknown, operation: string): void {
  if (
    typeof response !== 'object'
    || response === null
    || !('code' in response)
    || response.code !== 0
  ) {
    throw new FeishuResponseError(
      'feishu_business_error',
      `Feishu ${operation} failed`,
    );
  }
}

function requireSuccessfulFeishuMessageId(response: unknown, operation: string): string {
  assertSuccessfulFeishuResponse(response, operation);
  const messageId = readNestedString(response, ['data', 'message_id'])?.trim();
  if (!messageId) {
    throw new FeishuResponseError(
      'feishu_invalid_response',
      `Feishu ${operation} returned an invalid response`,
    );
  }
  return messageId;
}

interface FeishuMention {
  id?: {
    open_id?: string;
  };
}

interface FeishuCardAction {
  open_chat_id?: string;
  open_id?: string;
  open_message_id?: string;
  action?: {
    value?: Record<string, unknown>;
  };
}

interface FeishuMessageEvent {
  sender?: {
    sender_type?: string;
    sender_id?: {
      open_id?: string;
    };
  };
  message?: {
    message_id?: string;
    thread_id?: string;
    chat_id: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: FeishuMention[];
  };
}

function unwrapEvent(data: unknown): FeishuMessageEvent {
  const root = data as { event?: FeishuMessageEvent };
  return root.event ?? (data as FeishuMessageEvent);
}

function parsePostContent(content: string | undefined): { extractedText: string; imageKeys: string[] } {
  const imageKeys: string[] = [];
  const textParts: string[] = [];
  try {
    const parsed = JSON.parse(content ?? '{}');
    if (parsed.title) textParts.push(parsed.title);
    const paragraphs = parsed.content;
    if (Array.isArray(paragraphs)) {
      for (const paragraph of paragraphs) {
        if (!Array.isArray(paragraph)) continue;
        for (const element of paragraph) {
          if (element.tag === 'text' && element.text) {
            textParts.push(element.text);
          } else if (element.tag === 'a' && element.text) {
            textParts.push(element.text);
          } else if (element.tag === 'img') {
            const key = element.image_key || element.file_key || element.imageKey;
            if (key) imageKeys.push(key);
          }
        }
        textParts.push('\n');
      }
    }
  } catch { /* ignore parse errors */ }
  return { extractedText: textParts.join('').trim(), imageKeys };
}

function parseMessageContent(raw: string | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function isImageFile(pathOrName: string): boolean {
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(extname(pathOrName).toLowerCase());
}

function withSignal<T extends object>(payload: T, signal?: AbortSignal): T {
  if (!signal) return payload;
  return { ...payload, signal } as T;
}

const FEISHU_SDK_TIMEOUT_MS = 10_000;

function atFeishuSdkBoundary<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(feishuSdkAbortError());

  let sdkPromise: Promise<T>;
  try {
    sdkPromise = Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(privateFeishuError(error));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (continuation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      continuation();
    };
    const abort = () => finish(() => reject(feishuSdkAbortError()));
    const timeout = setTimeout(
      () => finish(() => reject(new FeishuSdkBoundaryError())),
      FEISHU_SDK_TIMEOUT_MS,
    );

    signal?.addEventListener('abort', abort, { once: true });
    // The generated SDK ignores AbortSignal. Keep handlers attached so a late
    // HTTP completion is consumed; UUID create recovery and same-message patch
    // idempotency remain the caller's recovery boundary.
    void sdkPromise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(privateFeishuError(error))),
    );
    if (signal?.aborted) abort();
  });
}

function feishuSdkAbortError(): DOMException {
  return new DOMException('Feishu request aborted', 'AbortError');
}

function privateFeishuError(error: unknown): Error {
  if (error instanceof FeishuResponseError || error instanceof FeishuSdkBoundaryError) return error;
  if (error instanceof Error && error.name === 'AbortError') return feishuSdkAbortError();
  return Object.assign(new Error('Feishu request failed'), {
    category: 'feishu_request_failed', ...safeErrorFields(error),
  });
}

async function withFeishuUploadHint<T>(operation: Promise<T>, action: string): Promise<T> {
  try {
    return await operation;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint = 'Feishu file sending requires the app permission scope im:resource.';
    if (safeErrorFields(err).status === 403 || /im:resource|permission|scope|auth|forbidden|denied/i.test(message)) {
      throw new Error(`${action} failed. ${hint}`);
    }
    throw err;
  }
}

function readNestedString(obj: unknown, path: string[]): string | undefined {
  let current: unknown = obj;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : undefined;
}

async function readJsonResponse(resp: Response): Promise<unknown> {
  try {
    return await resp.json();
  } catch {
    return {};
  }
}

function formatFeishuError(body: unknown): string {
  return JSON.stringify(safeErrorFields(body));
}

async function getReadableStreamFromResponse(resp: unknown): Promise<Readable> {
  const direct = resp as { getReadableStream?: () => Readable | Promise<Readable> };
  if (typeof direct.getReadableStream === 'function') {
    return direct.getReadableStream();
  }

  const data = (resp as { data?: unknown })?.data as
    | { getReadableStream?: () => Readable | Promise<Readable> }
    | undefined;
  if (typeof data?.getReadableStream === 'function') {
    return data.getReadableStream();
  }

  throw new Error('Feishu messageResource.get response missing getReadableStream()');
}

async function streamToBuffer(stream: Readable, signal?: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    throwIfAborted(signal);
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    assertWithinAttachmentDownloadLimit(total, 'Feishu file');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}
