import * as lark from '@larksuiteoapi/node-sdk';
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

    const uploadResp = await this.client.im.file.create({
      data: {
        file_type: 'stream',
        file_name: file.name,
        file: stream,
      },
    });

    const fileKey = uploadResp?.file_key;
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
    if (message.message_type === 'text') {
      try {
        const content = JSON.parse(message.content ?? '{}');
        text = content.text ?? '';
      } catch {
        text = message.content ?? '';
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
    message_type?: string;
    content?: string;
    mentions?: FeishuMention[];
  };
}

function unwrapEvent(data: unknown): FeishuMessageEvent {
  const root = data as { event?: FeishuMessageEvent };
  return root.event ?? (data as FeishuMessageEvent);
}
