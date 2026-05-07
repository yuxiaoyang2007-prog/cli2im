import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TelegramAdapter,
  parseTelegramCallback,
  parseTelegramUpdate,
} from '../src/platforms/telegram/adapter.js';

describe('parseTelegramUpdate', () => {
  it('parses text messages', () => {
    const msg = parseTelegramUpdate({
      update_id: 1,
      message: {
        message_id: 11,
        chat: { id: -1001, type: 'group' },
        from: { id: 42, username: 'joulian' },
        text: 'hello',
      },
    });

    expect(msg).toMatchObject({
      platform: 'telegram',
      chatId: '-1001',
      userId: '42',
      userName: 'joulian',
      text: 'hello',
      chatType: 'group',
    });
    expect(msg?.raw).toBeDefined();
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

  beforeEach(() => {
    vi.useFakeTimers();
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
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
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
