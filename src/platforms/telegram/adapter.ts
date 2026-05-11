import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { openAsBlob } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import type {
  CallbackQuery,
  FileAttachment,
  FilePayload,
  InboundMessage,
  OutboundContent,
  PlatformAdapter,
} from '../../types.js';
import { toTelegramMarkdownV2 } from './markdown.js';
import type { AbortableOptions } from '../../abort.js';
import { throwIfAborted } from '../../abort.js';
import { openVerifiedOutboundFile } from '../../security/outbound-file.js';
import {
  assertWithinAttachmentDownloadLimit,
  MAX_ATTACHMENT_DOWNLOAD_BYTES,
} from '../../security/download-limits.js';
import { scrubLog } from '../../security/logging.js';

export interface TelegramAdapterConfig {
  token: string;
  allowedUsers?: string[];
  botName: string;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramMessage {
  message_id?: number;
  chat?: {
    id?: number | string;
    type?: string;
  };
  from?: {
    id?: number | string;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  voice?: TelegramVoice;
}

interface TelegramPhotoSize {
  file_id?: string;
  file_unique_id?: string;
  file_size?: number;
  width?: number;
  height?: number;
}

interface TelegramDocument {
  file_id?: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramVoice {
  file_id?: string;
  file_unique_id?: string;
  duration?: number;
  mime_type?: string;
  file_size?: number;
}

interface TelegramCallbackQuery {
  id?: string;
  from?: {
    id?: number | string;
  };
  data?: string;
  message?: TelegramMessage;
}

export class TelegramAdapter implements PlatformAdapter {
  name = 'telegram';
  private readonly config: TelegramAdapterConfig;
  private readonly allowedUsers?: Set<string>;
  private messageHandler?: (msg: InboundMessage) => void;
  private callbackHandler?: (cb: CallbackQuery) => void;
  private offset = 0;
  private polling = false;
  private pollTimer?: ReturnType<typeof setTimeout>;

  constructor(config: TelegramAdapterConfig) {
    this.config = config;
    this.allowedUsers = config.allowedUsers ? new Set(config.allowedUsers.map(String)) : undefined;
  }

  async connect(): Promise<void> {
    this.offset = this.readOffset();
    this.polling = true;
    this.schedulePoll(0);
  }

  async disconnect(): Promise<void> {
    this.polling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  onCallback(handler: (cb: CallbackQuery) => void): void {
    this.callbackHandler = handler;
  }

  async send(chatId: string, content: OutboundContent, options: AbortableOptions = {}): Promise<string> {
    throwIfAborted(options.signal);
    const text = content.text ?? content.card?.content ?? '';
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text: toTelegramMarkdownV2(text),
      parse_mode: 'MarkdownV2',
    };

    if (content.card?.buttons?.length) {
      const mapped = content.card.buttons.map((button) => ({
        text: button.text,
        callback_data: button.value,
      }));
      payload.reply_markup = {
        inline_keyboard: content.card.type === 'session_list'
          ? mapped.map((b) => [b])
          : [mapped],
      };
    }

    const result = await this.botApi<{ message_id?: number | string }>('sendMessage', payload, options);
    throwIfAborted(options.signal);

    return String(result.message_id ?? '');
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    await this.botApi('sendChatAction', { chat_id: chatId, action: 'typing' });
  }

  async editMessage(chatId: string, msgId: string, content: string): Promise<void> {
    await this.botApi('editMessageText', {
      chat_id: chatId,
      message_id: msgId,
      text: toTelegramMarkdownV2(content),
      parse_mode: 'MarkdownV2',
    });
  }

  async deleteMessage(chatId: string, msgId: string): Promise<void> {
    await this.botApi('deleteMessage', {
      chat_id: chatId,
      message_id: msgId,
    });
  }

  async sendFile(chatId: string, file: FilePayload, options: AbortableOptions = {}): Promise<void> {
    throwIfAborted(options.signal);
    const method = isImageFile(file.path || file.name) ? 'sendPhoto' : 'sendDocument';
    const field = method === 'sendPhoto' ? 'photo' : 'document';
    const form = new FormData();
    const blob = fileHasVerificationMetadata(file)
      ? await verifiedFileBlob(file)
      : await openAsBlob(file.path, { type: file.mimeType ?? inferMimeType(file.name) });
    throwIfAborted(options.signal);

    form.append('chat_id', chatId);
    form.append(field, blob, file.name);
    throwIfAborted(options.signal);
    await this.botApi(method, form, options);
    throwIfAborted(options.signal);
  }

  async sendVoice(chatId: string, audioBuffer: Buffer, options: AbortableOptions = {}): Promise<void> {
    throwIfAborted(options.signal);
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('voice', new Blob([audioBuffer as unknown as BlobPart], { type: 'audio/mpeg' }), 'voice.mp3');
    throwIfAborted(options.signal);
    await this.botApi('sendVoice', form, options);
    throwIfAborted(options.signal);
  }

  async downloadFile(_messageId: string, fileKey: string, _type: string, options: AbortableOptions = {}): Promise<Buffer> {
    throwIfAborted(options.signal);
    const file = await this.botApi<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileKey }, options);
    throwIfAborted(options.signal);
    if (!file.file_path) {
      throw new Error('Telegram getFile response missing file_path');
    }
    if (typeof file.file_size === 'number') {
      assertWithinAttachmentDownloadLimit(file.file_size, 'Telegram file');
    }

    const resp = await fetch(
      `https://api.telegram.org/file/bot${this.config.token}/${file.file_path}`,
      { signal: options.signal },
    );
    throwIfAborted(options.signal);
    if (!resp.ok) {
      throw new Error(`Telegram file download failed: HTTP ${resp.status}`);
    }
    const contentLength = readContentLength(resp.headers);
    if (typeof contentLength === 'number') {
      assertWithinAttachmentDownloadLimit(contentLength, 'Telegram file');
    }

    return responseToLimitedBuffer(resp, options.signal);
  }

  private schedulePoll(delayMs: number): void {
    if (!this.polling) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      void this.pollOnce();
    }, delayMs);
  }

  private async pollOnce(): Promise<void> {
    if (!this.polling) return;

    try {
      const updates = await this.botApi<TelegramUpdate[]>('getUpdates', {
        offset: this.offset,
        timeout: 50,
        allowed_updates: ['message', 'callback_query'],
      });

      for (const update of updates) {
        if (typeof update.update_id === 'number') {
          this.offset = update.update_id + 1;
          this.writeOffset(this.offset);
        }
        this.dispatchUpdate(update);
      }
    } catch (err) {
      console.error('Telegram polling failed:', scrubLog(this.scrubToken(err)));
    } finally {
      this.schedulePoll(1000);
    }
  }

  private dispatchUpdate(update: TelegramUpdate): void {
    const callback = parseTelegramCallback(update);
    if (callback) {
      if (this.isAllowed(callback.userId)) {
        this.callbackHandler?.(callback);
      }
      return;
    }

    const message = parseTelegramUpdate(update);
    if (message && this.isAllowed(message.userId)) {
      this.messageHandler?.(message);
    }
  }

  private isAllowed(userId: string): boolean {
    return !this.allowedUsers || this.allowedUsers.has(userId);
  }

  private scrubToken(value: unknown): string {
    const message = value instanceof Error ? value.message : String(value);
    return message.split(this.config.token).join('<redacted-token>');
  }

  private async botApi<T>(
    method: string,
    payload: Record<string, unknown> | FormData,
    options: AbortableOptions = {},
  ): Promise<T> {
    throwIfAborted(options.signal);
    const init: RequestInit =
      payload instanceof FormData
        ? {
            method: 'POST',
            body: payload,
            signal: options.signal,
          }
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal: options.signal,
          };

    const resp = await fetch(`https://api.telegram.org/bot${this.config.token}/${method}`, init);
    throwIfAborted(options.signal);
    const body = (await resp.json()) as TelegramApiResponse<T>;
    if (!resp.ok || !body.ok) {
      throw new Error(
        `Telegram ${method} failed: ${body.description ?? `HTTP ${resp.status}`}`,
      );
    }

    return body.result as T;
  }

  private offsetPath(): string {
    return join(homedir(), '.cli2im', `telegram-offset-${this.config.botName}.json`);
  }

  private readOffset(): number {
    const path = this.offsetPath();
    if (!existsSync(path)) return 0;

    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { offset?: unknown };
      return typeof parsed.offset === 'number' ? parsed.offset : 0;
    } catch {
      return 0;
    }
  }

  private writeOffset(offset: number): void {
    const path = this.offsetPath();
    mkdirSync(join(homedir(), '.cli2im'), { recursive: true });
    writeFileSync(path, JSON.stringify({ offset }, null, 2));
  }
}

export function parseTelegramUpdate(update: unknown): InboundMessage | null {
  const typed = update as TelegramUpdate;
  const message = typed.message;
  if (message?.chat?.id === undefined || message.from?.id === undefined) return null;

  const attachments: FileAttachment[] = [];
  const messageId = message.message_id === undefined ? undefined : String(message.message_id);

  const photo = largestPhoto(message.photo);
  if (photo?.file_id) {
    attachments.push({
      type: 'image',
      fileKey: photo.file_id,
      size: photo.file_size,
      messageId,
    });
  }

  if (message.document?.file_id) {
    attachments.push({
      type: 'file',
      fileKey: message.document.file_id,
      fileName: message.document.file_name,
      mimeType: message.document.mime_type,
      size: message.document.file_size,
      messageId,
    });
  }

  const isVoice = Boolean(message.voice?.file_id);
  if (message.voice?.file_id) {
    attachments.push({
      type: 'audio',
      fileKey: message.voice.file_id,
      mimeType: message.voice.mime_type ?? 'audio/ogg',
      size: message.voice.file_size,
      messageId,
    });
  }

  const text = message.text ?? message.caption ?? '';
  if (!text && attachments.length === 0) return null;

  return {
    platform: 'telegram',
    chatId: String(message.chat.id),
    userId: String(message.from.id),
    userName: message.from.username ?? formatTelegramName(message.from),
    text,
    chatType: message.chat.type,
    attachments: attachments.length > 0 ? attachments : undefined,
    isVoice,
    raw: update,
  };
}

export function parseTelegramCallback(update: unknown): CallbackQuery | null {
  const callback = (update as TelegramUpdate).callback_query;
  const chatId = callback?.message?.chat?.id;
  const messageId = callback?.message?.message_id;
  const userId = callback?.from?.id;

  if (!callback?.data || chatId === undefined || messageId === undefined || userId === undefined) {
    return null;
  }

  return {
    platform: 'telegram',
    chatId: String(chatId),
    userId: String(userId),
    chatType: callback.message?.chat?.type,
    data: callback.data,
    messageId: String(messageId),
  };
}

function largestPhoto(photos: TelegramPhotoSize[] | undefined): TelegramPhotoSize | undefined {
  return photos?.reduce<TelegramPhotoSize | undefined>((largest, photo) => {
    if (!largest) return photo;
    return photoScore(photo) > photoScore(largest) ? photo : largest;
  }, undefined);
}

function photoScore(photo: TelegramPhotoSize): number {
  return photo.file_size ?? (photo.width ?? 0) * (photo.height ?? 0);
}

function formatTelegramName(from: NonNullable<TelegramMessage['from']>): string | undefined {
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || undefined;
}

function isImageFile(path: string): boolean {
  return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff'].includes(
    extname(path).toLowerCase(),
  );
}

function fileHasVerificationMetadata(file: FilePayload): boolean {
  return typeof file.size === 'number'
    || typeof file.mtimeMs === 'number'
    || typeof file.dev === 'number'
    || typeof file.ino === 'number';
}

async function verifiedFileBlob(file: FilePayload): Promise<Blob> {
  const handle = await openVerifiedOutboundFile(file);
  try {
    const buffer = await handle.readFile();
    return new Blob([buffer as unknown as BlobPart], {
      type: file.mimeType ?? inferMimeType(file.name),
    });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function inferMimeType(name: string): string | undefined {
  const ext = extname(name).toLowerCase();
  const mimes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
  };

  return mimes[ext];
}

function readContentLength(headers: Headers): number | undefined {
  const raw = headers.get('content-length');
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

async function responseToLimitedBuffer(resp: Response, signal?: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  if (!resp.body) {
    const buffer = Buffer.from(await resp.arrayBuffer());
    assertWithinAttachmentDownloadLimit(buffer.byteLength, 'Telegram file');
    return buffer;
  }

  for await (const chunk of resp.body as unknown as AsyncIterable<Uint8Array>) {
    throwIfAborted(signal);
    const buffer = Buffer.from(chunk);
    total += buffer.byteLength;
    assertWithinAttachmentDownloadLimit(total, 'Telegram file');
    chunks.push(buffer);
  }

  return Buffer.concat(chunks, total);
}
