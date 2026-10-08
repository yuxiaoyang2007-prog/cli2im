import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TelegramAdapter,
  parseTelegramCallback,
  parseTelegramUpdate,
} from '../src/platforms/telegram/adapter.js';
import { getGroupMessageSkipReason } from '../src/pipeline.js';
import type { BotConfig } from '../src/types.js';
import { MAX_ATTACHMENT_DOWNLOAD_BYTES } from '../src/security/download-limits.js';
import { createCallbackHandler } from '../src/index.js';
import { ChatQueue } from '../src/session/queue.js';

describe('parseTelegramUpdate', () => {
  it('F10 accepts an explicit Telegram mention and rejects an unrelated mention', () => {
    const make = (username: string) => parseTelegramUpdate({ message: {
      message_id: 1, chat: { id: -1, type: 'supergroup' }, from: { id: 42 },
      text: `😀 @${username} hi`, entities: [{ type: 'mention', offset: 3, length: username.length + 1 }],
    } })!;
    const bot = { requireMention: true } as BotConfig;
    expect(getGroupMessageSkipReason(make('MyBot'), bot, '@mybot')).toBeUndefined();
    expect(getGroupMessageSkipReason(make('OtherBot'), bot, '@mybot')).toBe('Bot mention required');
  });

  it('F11 ignores thread ids on non-topic messages and callbacks', () => {
    const message = { message_id: 11, message_thread_id: 55, chat: { id: -1001, type: 'supergroup' }, from: { id: 42 }, text: 'reply' };
    expect(parseTelegramUpdate({ message })?.threadId).toBeUndefined();
    expect(parseTelegramCallback({ callback_query: { message, from: { id: 42 }, data: 'status' } })?.threadId).toBeUndefined();
  });

  it('parses text messages', () => {
    const msg = parseTelegramUpdate({
      update_id: 1,
      message: {
        message_id: 11,
        chat: { id: -1001, type: 'group' },
        from: { id: 42, username: 'testuser' },
        text: 'hello',
      },
    });

    expect(msg).toMatchObject({
      platform: 'telegram',
      chatId: '-1001',
      userId: '42',
      userName: 'testuser',
      text: 'hello',
      chatType: 'group',
    });
    expect(msg?.raw).toBeDefined();
  });

  it('carries the same platform topic identity from messages and callbacks', () => {
    const message = { is_topic_message: true, message_id: 11, message_thread_id: 55, chat: { id: -1001, type: 'supergroup' }, from: { id: 42 }, text: 'hello' };
    expect(parseTelegramUpdate({ message })).toMatchObject({ messageId: '11', threadId: '55' });
    expect(parseTelegramCallback({ callback_query: { message, from: { id: 42 }, data: 'status' } })).toMatchObject({ messageId: '11', threadId: '55' });
  });

  it('parses captions and the largest photo attachment', () => {
    const msg = parseTelegramUpdate({
      update_id: 2,
      message: {
        message_id: 12,
        chat: { id: 1002, type: 'private' },
        from: { id: 43, first_name: 'Jo' },
        caption: 'see image',
        photo: [
          { file_id: 'small', file_unique_id: 'u1', file_size: 10, width: 90, height: 90 },
          { file_id: 'large', file_unique_id: 'u2', file_size: 20, width: 1920, height: 1080 },
        ],
      },
    });

    expect(msg?.text).toBe('see image');
    expect(msg?.attachments).toEqual([
      {
        type: 'image',
        fileKey: 'large',
        size: 20,
        messageId: '12',
      },
    ]);
  });

  it('parses document attachments', () => {
    const msg = parseTelegramUpdate({
      update_id: 3,
      message: {
        message_id: 13,
        chat: { id: 1003 },
        from: { id: 44 },
        document: {
          file_id: 'doc-file',
          file_unique_id: 'doc-u',
          file_name: 'report.pdf',
          mime_type: 'application/pdf',
          file_size: 123,
        },
      },
    });

    expect(msg).toMatchObject({
      text: '',
      attachments: [
        {
          type: 'file',
          fileKey: 'doc-file',
          fileName: 'report.pdf',
          mimeType: 'application/pdf',
          size: 123,
          messageId: '13',
        },
      ],
    });
  });

  it('returns null for empty messages without attachments', () => {
    expect(
      parseTelegramUpdate({
        update_id: 4,
        message: { message_id: 14, chat: { id: 1004 }, from: { id: 45 } },
      }),
    ).toBeNull();
  });
});

describe('parseTelegramCallback', () => {
  it('extracts callback data and message identity', () => {
    expect(
      parseTelegramCallback({
        update_id: 5,
        callback_query: {
          id: 'cb_1',
          from: { id: 46 },
          data: 'approve',
          message: { message_id: 15, chat: { id: -1005 } },
        },
      }),
    ).toEqual({
      platform: 'telegram',
      chatId: '-1005',
      userId: '46',
      data: 'approve',
      messageId: '15',
    });
  });

  it('returns null when callback data is missing', () => {
    expect(parseTelegramCallback({ update_id: 6, callback_query: { from: { id: 47 } } })).toBeNull();
  });
});

describe('TelegramAdapter', () => {
  const originalFetch = globalThis.fetch;
  const apiPrototype = TelegramAdapter.prototype as unknown as { botApi(method: string, ...args: unknown[]): Promise<unknown> };
  const originalBotApi = apiPrototype.botApi;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(apiPrototype, 'botApi').mockImplementation(function (this: TelegramAdapter, method, ...args) {
      if (method === 'getMe') return Promise.resolve({ id: 123, username: 'MyBot' });
      return originalBotApi.call(this, method, ...args);
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/getUpdates')) {
          return jsonResponse({ ok: true, result: [] });
        }
        if (url.includes('/getFile')) {
          return jsonResponse({ ok: true, result: { file_path: 'documents/a.txt' } });
        }
        if (url.includes('/file/botTOKEN/documents/a.txt')) {
          return new Response('file-data');
        }
        return jsonResponse({ ok: true, result: { message_id: 99 } });
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    globalThis.fetch = originalFetch;
  });

  it('F10 resolves the bot username before polling and admits control-panel mentions', async () => {
    const adapter = new TelegramAdapter({ token: 'TOKEN', botName: 'different-local-name' });
    vi.spyOn(adapter as unknown as { readOffset(): number }, 'readOffset').mockReturnValue(0);
    await adapter.connect();
    expect(adapter.getBotOpenId()).toBe('@mybot');
    expect(getGroupMessageSkipReason({ platform: 'telegram', chatId: '-1', userId: '42',
      chatType: 'supergroup', text: '/status', mentions: [adapter.getBotOpenId()!] },
      { requireMention: true } as BotConfig, adapter.getBotOpenId())).toBeUndefined();
    await adapter.disconnect();
  });

  it('ADDRESSED-COMMAND normalizes the current bot command before dispatch and drops other bot commands', async () => {
    const adapter = new TelegramAdapter({ token: 'TOKEN', botName: 'local-name' });
    vi.spyOn(adapter as unknown as { readOffset(): number }, 'readOffset').mockReturnValue(0);
    const received = vi.fn();
    adapter.onMessage(received);
    await adapter.connect();
    const dispatch = adapter as unknown as { dispatchUpdate(update: unknown): void };
    for (const username of ['MyBot', 'OtherBot']) {
      const text = `/stop@${username}`;
      dispatch.dispatchUpdate({ message: { chat: { id: -1, type: 'supergroup' }, from: { id: 42 },
        text, entities: [{ type: 'bot_command', offset: 0, length: text.length }] } });
    }
    expect(received).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: '/stop', mentions: ['@mybot'] }));
    await adapter.disconnect();
  });

  it('IDENTITY-RECOVERY restores mentions and control-panel admission after the first lookup fails', async () => {
    vi.mocked(apiPrototype.botApi).mockRejectedValueOnce(
      new Error('request failed: https://api.telegram.org/botTOKEN/getMe'),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const adapter = new TelegramAdapter({ token: 'TOKEN', botName: 'bot' });
    const readOffset = vi.spyOn(adapter as unknown as { readOffset(): number }, 'readOffset').mockReturnValue(9);
    const controls = vi.fn();
    const botConfig = { requireMention: true, allowFrom: ['42'] } as BotConfig;
    adapter.onCallback(createCallbackHandler({
      botName: 'bot', botConfig, adapter, store: {} as never, agentManager: {} as never,
      handoffService: {} as never, queue: new ChatQueue(),
      handleControl: async (callback, text) => {
        const msg = { ...callback, text, mentions: adapter.getBotOpenId() ? [adapter.getBotOpenId()!] : [] };
        if (!getGroupMessageSkipReason(msg, botConfig, adapter.getBotOpenId())) controls(text);
      },
    }));
    const dispatch = adapter as unknown as { dispatchUpdate(update: unknown): void };
    const panelUpdate = { callback_query: { from: { id: 42 }, data: 'control:status',
      message: { message_id: 1, chat: { id: -1, type: 'supergroup' } } } };

    try {
      await expect(adapter.connect()).resolves.toBeUndefined();
      expect(adapter.getBotOpenId()).toBeUndefined();
      dispatch.dispatchUpdate(panelUpdate);
      expect(controls).not.toHaveBeenCalled();
      expect(readOffset).toHaveBeenCalledOnce();
      expect(getGroupMessageSkipReason({ platform: 'telegram', chatId: '-1', userId: '42',
        chatType: 'supergroup', text: '/status', mentions: ['@mybot'] },
        { requireMention: true } as BotConfig, adapter.getBotOpenId())).toBe('Bot mention required');

      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledWith(
        'https://api.telegram.org/botTOKEN/getUpdates',
        expect.objectContaining({ body: JSON.stringify({ offset: 9, timeout: 50, allowed_updates: ['message', 'callback_query'] }) }),
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(adapter.getBotOpenId()).toBe('@mybot');
      const mentioned = parseTelegramUpdate({ message: { chat: { id: -1, type: 'supergroup' }, from: { id: 42 },
        text: '@MyBot hello', entities: [{ type: 'mention', offset: 0, length: 6 }] } })!;
      expect(getGroupMessageSkipReason(mentioned, { requireMention: true } as BotConfig, adapter.getBotOpenId())).toBeUndefined();
      dispatch.dispatchUpdate(panelUpdate);
      expect(controls).toHaveBeenCalledExactlyOnceWith('/status');
      expect(warn.mock.calls).toEqual([['Telegram identity lookup failed; continuing polling.']]);
    } finally {
      await adapter.disconnect();
    }
  });

  it('IDENTITY-RECOVERY backs off repeated lookups while polling and cancels a scheduled retry on disconnect', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lookup = vi.fn(async () => { throw new Error('offline'); });
    vi.mocked(apiPrototype.botApi).mockImplementation(function (this: TelegramAdapter, method, ...args) {
      return method === 'getMe' ? lookup() : originalBotApi.call(this, method, ...args);
    });
    const adapter = new TelegramAdapter({ token: 'TOKEN', botName: 'bot' });
    vi.spyOn(adapter as unknown as { readOffset(): number }, 'readOffset').mockReturnValue(0);
    await adapter.connect();
    expect(lookup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(lookup).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(lookup).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenCalledTimes(4);
    await adapter.disconnect();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('IDENTITY-RECOVERY aborts an in-flight retry and ignores its late identity across reconnect', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let resolveOld!: (identity: unknown) => void;
    let retrySignal: AbortSignal | undefined;
    let lookups = 0;
    vi.mocked(apiPrototype.botApi).mockImplementation(function (this: TelegramAdapter, method, ...args) {
      if (method !== 'getMe') return originalBotApi.call(this, method, ...args);
      if (++lookups === 1) return Promise.reject(new Error('offline'));
      if (lookups === 2) {
        retrySignal = (args[1] as { signal: AbortSignal }).signal;
        return new Promise(resolve => { resolveOld = resolve; });
      }
      return Promise.resolve({ username: 'NewBot' });
    });
    const adapter = new TelegramAdapter({ token: 'TOKEN', botName: 'bot' });
    vi.spyOn(adapter as unknown as { readOffset(): number }, 'readOffset').mockReturnValue(0);
    await adapter.connect();
    await vi.advanceTimersByTimeAsync(1000);
    expect(retrySignal?.aborted).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    await adapter.disconnect();
    expect(retrySignal?.aborted).toBe(true);
    await adapter.connect();
    expect(adapter.getBotOpenId()).toBe('@newbot');
    resolveOld({ username: 'OldBot' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(adapter.getBotOpenId()).toBe('@newbot');
    expect(lookups).toBe(3);
    await adapter.disconnect();
  });

  it('F10 does not poll after disconnect during identity lookup', async () => {
    let resolveIdentity!: (value: unknown) => void;
    vi.mocked(apiPrototype.botApi).mockImplementationOnce(() => new Promise(resolve => { resolveIdentity = resolve; }));
    const adapter = new TelegramAdapter({ token: 'TOKEN', botName: 'bot' });
    const readOffset = vi.spyOn(adapter as unknown as { readOffset(): number }, 'readOffset').mockReturnValue(0);
    const connecting = adapter.connect();
    await adapter.disconnect();
    resolveIdentity({ username: 'OldBot' });
    await connecting;
    await vi.advanceTimersByTimeAsync(1000);
    expect(readOffset).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends, edits, deletes, uploads, and downloads through the Bot API', async () => {
    const adapter = new TelegramAdapter({ token: 'TOKEN', botName: 'testbot' });
    const fetchMock = vi.mocked(fetch);
    const uploadDir = mkdtempSync(join(tmpdir(), 'cli2im-upload-'));
    const imagePath = join(uploadDir, 'picture.png');
    const documentPath = join(uploadDir, 'report.pdf');
    writeFileSync(imagePath, 'png-data');
    writeFileSync(documentPath, 'pdf-data');

    await expect(adapter.send('1001', { text: 'hello' })).resolves.toBe('99');
    await adapter.editMessage('1001', '99', 'edited');
    await adapter.deleteMessage('1001', '99');
    await adapter.sendFile('1001', { path: imagePath, name: 'picture.png' });
    await adapter.sendFile('1001', { path: documentPath, name: 'report.pdf' });
    await expect(adapter.downloadFile('msg', 'file-id', 'file')).resolves.toEqual(
      Buffer.from('file-data'),
    );

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toContain('https://api.telegram.org/botTOKEN/sendMessage');
    expect(urls).toContain('https://api.telegram.org/botTOKEN/editMessageText');
    expect(urls).toContain('https://api.telegram.org/botTOKEN/deleteMessage');
    expect(urls).toContain('https://api.telegram.org/botTOKEN/sendPhoto');
    expect(urls).toContain('https://api.telegram.org/botTOKEN/sendDocument');
    expect(urls).toContain('https://api.telegram.org/botTOKEN/getFile');
    expect(urls).toContain('https://api.telegram.org/file/botTOKEN/documents/a.txt');
  });

  it('passes abort signals to Bot API requests', async () => {
    const adapter = new TelegramAdapter({ token: 'TOKEN', botName: 'testbot' });
    const fetchMock = vi.mocked(fetch);
    const controller = new AbortController();

    await adapter.send('1001', { text: 'hello' }, { signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.org/botTOKEN/sendMessage',
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('does not upload files when the signal is already aborted', async () => {
    const adapter = new TelegramAdapter({ token: 'TOKEN', botName: 'testbot' });
    const fetchMock = vi.mocked(fetch);
    const uploadDir = mkdtempSync(join(tmpdir(), 'cli2im-upload-'));
    const imagePath = join(uploadDir, 'picture.png');
    const controller = new AbortController();
    writeFileSync(imagePath, 'png-data');
    controller.abort();

    await expect(
      adapter.sendFile('1001', { path: imagePath, name: 'picture.png' }, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(fetchMock).not.toHaveBeenCalledWith(
      'https://api.telegram.org/botTOKEN/sendPhoto',
      expect.any(Object),
    );
  });

  it('passes abort signals to file downloads', async () => {
    const adapter = new TelegramAdapter({ token: 'TOKEN', botName: 'testbot' });
    const fetchMock = vi.mocked(fetch);
    const controller = new AbortController();

    await adapter.downloadFile('msg', 'file-id', 'file', { signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.org/file/botTOKEN/documents/a.txt',
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('rejects Telegram downloads when getFile reports an oversized file', async () => {
    const adapter = new TelegramAdapter({ token: 'TOKEN', botName: 'testbot' });
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ok: true,
      result: { file_path: 'documents/large.bin', file_size: MAX_ATTACHMENT_DOWNLOAD_BYTES + 1 },
    }));

    await expect(adapter.downloadFile('msg', 'file-id', 'file')).rejects.toThrow(/download limit/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects Telegram downloads when content-length exceeds the attachment cap', async () => {
    const adapter = new TelegramAdapter({ token: 'TOKEN', botName: 'testbot' });
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        result: { file_path: 'documents/large.bin' },
      }))
      .mockResolvedValueOnce(new Response('', {
        headers: { 'content-length': String(MAX_ATTACHMENT_DOWNLOAD_BYTES + 1) },
      }));

    await expect(adapter.downloadFile('msg', 'file-id', 'file')).rejects.toThrow(/download limit/);
  });

  it('scrubs the bot token from Telegram polling errors before logging', async () => {
    const adapter = new TelegramAdapter({ token: 'TOKEN', botName: 'testbot' });
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValueOnce(
      new Error('request failed: https://api.telegram.org/botTOKEN/getUpdates'),
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const privateAdapter = adapter as unknown as { polling: boolean; pollOnce(): Promise<void> };
    privateAdapter.polling = true;

    await privateAdapter.pollOnce();
    await adapter.disconnect();

    expect(consoleSpy).toHaveBeenCalledWith(
      'Telegram polling failed:',
      {},
    );
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toMatch(/TOKEN|api.telegram/);
  });

  it('routes text and voice into the explicitly supplied topic', async () => {
    const adapter = new TelegramAdapter({ token: 'TOKEN', botName: 'testbot' });
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })));
    await adapter.send('-1001', { text: 'hello', threadId: '55', replyToMessageId: '11' });
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(payload).toMatchObject({ chat_id: '-1001', message_thread_id: 55, reply_parameters: { message_id: 11 } });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, result: {} })));
    await adapter.sendVoice('-1001', Buffer.from('voice'), { threadId: '55', replyToMessageId: '11' });
    const form = fetchMock.mock.calls[1][1]?.body as FormData;
    expect(form.get('message_thread_id')).toBe('55');
    expect(form.get('reply_parameters')).toBe('{"message_id":11}');
  });

  it('sends recovery text verbatim without enabling Markdown parsing', async () => {
    const adapter = new TelegramAdapter({ token: 'TOKEN', botName: 'testbot' });
    const text = '原文 * [brackets](url) _name_ <xml> \\ # heading\n```code```';
    await adapter.send('chat', { text, plainText: true });
    const payload = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(payload.text).toBe(text);
    expect(payload).not.toHaveProperty('parse_mode');
  });

  it('aborts an old long poll and never dispatches or reschedules it across a restart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cli2im-tg-generation-'));
    vi.stubEnv('HOME', home);
    mkdirSync(join(home, '.cli2im'));
    const offsetPath = join(home, '.cli2im', 'telegram-offset-testbot.json');
    writeFileSync(offsetPath, '{"offset":5}');
    let resolveOld!: (response: Response) => void;
    let resolveNew!: (response: Response) => void;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveNew = resolve; }));
    const adapter = new TelegramAdapter({ token: 'TOKEN', botName: 'testbot' });
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.connect();
    await vi.advanceTimersByTimeAsync(0);
    const oldSignal = fetchMock.mock.calls[0][1]?.signal;
    expect(oldSignal?.aborted).toBe(false);
    await adapter.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await adapter.disconnect();
    expect(oldSignal?.aborted).toBe(true);
    await adapter.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolveOld(jsonResponse({ ok: true, result: [{ update_id: 9000, message: { message_id: 90, chat: { id: 1 }, from: { id: 2 }, text: 'stale' } }] }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(handler).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(offsetPath, 'utf8'))).toEqual({ offset: 5 });
    resolveNew(jsonResponse({ ok: true, result: [{ update_id: 10, message: { message_id: 11, chat: { id: 1 }, from: { id: 2 }, text: 'current' } }] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ text: 'current' }));
    expect(handler).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(offsetPath, 'utf8'))).toEqual({ offset: 11 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await adapter.disconnect();
  });

  it('does not echo provider descriptions, malformed response content, or URL tokens', async () => {
    const adapter = new TelegramAdapter({ token: 'TOKEN', botName: 'testbot' });
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, description: 'private-chat-content TOKEN' }), { status: 403 }));
    await expect(adapter.send('chat', { text: 'hello' })).rejects.toThrow('Telegram sendMessage failed: HTTP 403');
    fetchMock.mockResolvedValueOnce(new Response('private-chat-content TOKEN'));
    await expect(adapter.send('chat', { text: 'hello' })).rejects.toThrow('Telegram returned an invalid response');
    fetchMock.mockRejectedValueOnce(new Error('https://api.telegram.org/botTOKEN/sendMessage'));
    const failure = await adapter.send('chat', { text: 'hello' }).catch((error) => error);
    expect(failure.message).toBe('Telegram network request failed');
    expect(failure).not.toHaveProperty('cause');
  });

  it('sends card buttons as Telegram inline keyboard callbacks', async () => {
    const adapter = new TelegramAdapter({ token: 'TOKEN', botName: 'testbot' });
    const fetchMock = vi.mocked(fetch);

    await adapter.send('1001', {
      card: {
        type: 'permission',
        content: 'Approve command?',
        buttons: [
          { text: 'Allow', value: 'perm:allow:req_1' },
          { text: 'Deny', value: 'perm:deny:req_1' },
        ],
      },
    });

    const sendMessageCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes('/sendMessage'),
    );
    const body = JSON.parse(String(sendMessageCall?.[1]?.body));
    expect(body.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: 'Allow', callback_data: 'perm:allow:req_1' },
          { text: 'Deny', callback_data: 'perm:deny:req_1' },
        ],
      ],
    });
  });

  it('starts polling with the persisted offset and dispatches allowed messages', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cli2im-tg-'));
    vi.stubEnv('HOME', home);
    mkdirSync(join(home, '.cli2im'));
    writeFileSync(join(home, '.cli2im', 'telegram-offset-testbot.json'), '{"offset": 9}', {
      flag: 'wx',
    });

    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        result: [
          {
            update_id: 9,
            message: {
              message_id: 16,
              chat: { id: 1006 },
              from: { id: 46 },
              text: 'allowed',
            },
          },
          {
            update_id: 10,
            message: {
              message_id: 17,
              chat: { id: 1006 },
              from: { id: 99 },
              text: 'blocked',
            },
          },
        ],
      }),
    );

    const adapter = new TelegramAdapter({ token: 'TOKEN', botName: 'testbot', allowedUsers: ['46'] });
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.connect();
    await vi.advanceTimersByTimeAsync(0);
    await adapter.disconnect();

    const getUpdatesCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/getUpdates'));
    expect(JSON.parse(String(getUpdatesCall?.[1]?.body))).toMatchObject({ offset: 9 });
    expect(
      JSON.parse(readFileSync(join(home, '.cli2im', 'telegram-offset-testbot.json'), 'utf8')),
    ).toEqual({ offset: 11 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ userId: '46', text: 'allowed' }));
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}
