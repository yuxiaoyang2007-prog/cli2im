import * as lark from '@larksuiteoapi/node-sdk';
import { extname } from 'node:path';
import type { Readable } from 'node:stream';
import type {
  PlatformAdapter,
  InboundMessage,
  OutboundContent,
  FilePayload,
  CardPayload,
  CallbackQuery,
} from '../../types.js';

export interface FeishuAdapterConfig {
  appId: string;
  appSecret: string;
  botName: string;
}

export class FeishuAdapter implements PlatformAdapter {
  name = 'feishu';
  private client: lark.Client;
  private wsClient: lark.WSClient;
  private messageHandler?: (msg: InboundMessage) => void;
  private callbackHandler?: (cb: CallbackQuery) => void;
  private config: FeishuAdapterConfig;
  private processedMessageIds = new Set<string>();
  private botOpenId?: string;

  constructor(config: FeishuAdapterConfig) {
    this.config = config;
    this.client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: lark.AppType.SelfBuild,
    });

    this.wsClient = new lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      loggerLevel: lark.LoggerLevel.warn,
    });
  }

  async connect(): Promise<void> {
    await this.resolveBotIdentity();

    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': (data: unknown) => this.handleMessage(data),
    });

    const cardActionHandler = new lark.CardActionHandler({}, (data: unknown) =>
      this.handleCardAction(data),
    );

    await (this.wsClient.start as (params: unknown) => Promise<void>)({
      eventDispatcher,
      cardActionHandler,
    });
  }

  async disconnect(): Promise<void> {
    this.wsClient.close();
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  onCallback(handler: (cb: CallbackQuery) => void): void {
    this.callbackHandler = handler;
  }

  async send(chatId: string, content: OutboundContent): Promise<string> {
    if (content.card) {
      return this.sendCard(chatId, content.card);
    }

    const resp = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: content.text ?? '' }),
      },
    });

    return resp.data?.message_id ?? '';
  }

  async editMessage(_chatId: string, msgId: string, content: string): Promise<void> {
    await this.client.im.message.patch({
      path: { message_id: msgId },
      data: { content: JSON.stringify({ text: content }) },
    });
  }

  async deleteMessage(_chatId: string, msgId: string): Promise<void> {
    await this.client.im.message.delete({
      path: { message_id: msgId },
    });
  }

  async sendFile(chatId: string, file: FilePayload): Promise<void> {
    const { createReadStream } = await import('node:fs');
    const stream = createReadStream(file.path);

    if (isImageFile(file.name || file.path)) {
      const uploadResp = await this.client.im.image.create({
        data: {
          image_type: 'message',
          image: stream,
        },
      });

      const imageKey = readNestedString(uploadResp, ['image_key'])
        ?? readNestedString(uploadResp, ['data', 'image_key']);
      if (!imageKey) return;

      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'image',
          content: JSON.stringify({ image_key: imageKey }),
        },
      });
      return;
    }

    const uploadResp = await this.client.im.file.create({
      data: {
        file_type: 'stream',
        file_name: file.name,
        file: stream,
      },
    });

    const fileKey = readNestedString(uploadResp, ['file_key'])
      ?? readNestedString(uploadResp, ['data', 'file_key']);
    if (!fileKey) return;

    await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'file',
        content: JSON.stringify({ file_key: fileKey }),
      },
    });
  }

  async downloadFile(messageId: string, fileKey: string, type: string): Promise<Buffer> {
    const resp = await this.client.im.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type },
    });
    const readable = await getReadableStreamFromResponse(resp);
    return streamToBuffer(readable);
  }

  async sendCard(chatId: string, card: CardPayload): Promise<string> {
    const cardJson = this.buildCardJson(card);
    const resp = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(cardJson),
      },
    });

    return resp.data?.message_id ?? '';
  }

  async updateCard(messageId: string, content: string, _seq: number): Promise<void> {
    const card = this.buildCardJson({ type: 'streaming', content });
    await this.client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
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
        err,
      );
    }
  }

  private handleMessage(data: unknown): void {
    if (!this.messageHandler) return;

    const event = unwrapEvent(data);
    const message = event.message;
    if (!message) return;

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
    }

    text = text.replace(/@_user_\d+\s*/g, '').trim();

    const mentions = (message.mentions ?? [])
      .map((mention: FeishuMention) => mention.id?.open_id)
      .filter((openId: string | undefined): openId is string => Boolean(openId));

    this.messageHandler({
      platform: 'feishu',
      chatId: message.chat_id,
      userId: sender?.sender_id?.open_id ?? '',
      userName: sender?.sender_id?.open_id,
      text,
      chatType: message.chat_type,
      attachments: attachments.length > 0 ? attachments : undefined,
      mentions,
      raw: data,
    });
  }

  private handleCardAction(data: unknown): unknown {
    if (!this.callbackHandler) return undefined;

    const action = data as FeishuCardAction;
    this.callbackHandler({
      platform: 'feishu',
      chatId: action.open_chat_id ?? '',
      userId: action.open_id ?? '',
      data: JSON.stringify(action.action?.value ?? {}),
      messageId: action.open_message_id ?? '',
    });

    return { toast: { type: 'success', content: 'OK' } };
  }

  private buildCardJson(card: CardPayload): object {
    return {
      config: {
        wide_screen_mode: true,
      },
      elements: [
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
        ? { title: { tag: 'plain_text', content: card.title } }
        : undefined,
    };
  }
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
  if (!body || typeof body !== 'object') return String(body);
  const code = (body as Record<string, unknown>).code;
  const msg = (body as Record<string, unknown>).msg;
  return JSON.stringify({ code, msg });
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

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
