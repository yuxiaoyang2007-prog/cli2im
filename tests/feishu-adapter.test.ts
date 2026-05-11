import { EventEmitter } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeishuAdapter } from '../src/platforms/feishu/adapter.js';
import { MAX_ATTACHMENT_DOWNLOAD_BYTES } from '../src/security/download-limits.js';
import type { InboundMessage } from '../src/types.js';

const larkMocks = vi.hoisted(() => {
  const clients: MockClient[] = [];

  class MockClient {
    im = {
      message: {
        create: vi.fn(async () => ({ data: { message_id: 'om_sent' } })),
        patch: vi.fn(async () => ({})),
        delete: vi.fn(async () => ({})),
      },
      image: {
        create: vi.fn(async () => ({ image_key: 'img_top' })),
      },
      file: {
        create: vi.fn(async () => ({ data: { file_key: 'file_data' } })),
      },
      messageResource: {
        get: vi.fn(async () => ({
          getReadableStream: () => Readable.from([Buffer.from('downloaded')]),
        })),
      },
    };

    constructor() {
      clients.push(this);
    }
  }

  return { clients, MockClient };
});

const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

type MockClient = {
  im: {
    message: {
      create: ReturnType<typeof vi.fn>;
      patch: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
    image: { create: ReturnType<typeof vi.fn> };
    file: { create: ReturnType<typeof vi.fn> };
    messageResource: { get: ReturnType<typeof vi.fn> };
  };
};

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: larkMocks.MockClient,
  WSClient: class {
    start = vi.fn(async () => undefined);
    close = vi.fn();
  },
  EventDispatcher: class {
    register = vi.fn(() => this);
  },
  CardActionHandler: class {},
  AppType: { SelfBuild: 0 },
  LoggerLevel: { warn: 1 },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: childProcessMocks.spawn,
  };
});

describe('FeishuAdapter file handling', () => {
  beforeEach(() => {
    larkMocks.clients.length = 0;
  });

  afterEach(() => {
    childProcessMocks.spawn.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('parses image and file receive events into inbound attachments', () => {
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    const received: InboundMessage[] = [];
    adapter.onMessage((msg) => received.push(msg));

    (adapter as unknown as { handleMessage(data: unknown): void }).handleMessage({
      event: {
        sender: { sender_type: 'user', sender_id: { open_id: 'ou_1' } },
        message: {
          message_id: 'om_img',
          chat_id: 'oc_1',
          chat_type: 'group',
          message_type: 'image',
          content: JSON.stringify({ image_key: 'img_key' }),
        },
      },
    });
    (adapter as unknown as { handleMessage(data: unknown): void }).handleMessage({
      event: {
        sender: { sender_type: 'user', sender_id: { open_id: 'ou_1' } },
        message: {
          message_id: 'om_file',
          chat_id: 'oc_1',
          chat_type: 'p2p',
          message_type: 'file',
          content: JSON.stringify({ file_key: 'file_key', file_name: 'report.pdf' }),
        },
      },
    });

    expect(received[0]).toMatchObject({
      platform: 'feishu',
      chatId: 'oc_1',
      chatType: 'group',
      attachments: [
        {
          type: 'image',
          fileKey: 'img_key',
          messageId: 'om_img',
          mimeType: 'image/png',
        },
      ],
    });
    expect(received[1]).toMatchObject({
      chatType: 'p2p',
      attachments: [
        {
          type: 'file',
          fileKey: 'file_key',
          messageId: 'om_file',
          fileName: 'report.pdf',
        },
      ],
    });
  });

  it('downloads message resources through the Feishu readable-stream response', async () => {
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    const client = larkMocks.clients[0];

    await expect(adapter.downloadFile('om_1', 'file_1', 'file')).resolves.toEqual(
      Buffer.from('downloaded'),
    );
    expect(client.im.messageResource.get).toHaveBeenCalledWith({
      path: { message_id: 'om_1', file_key: 'file_1' },
      params: { type: 'file' },
    });
  });

  it('rejects Feishu downloads when the readable stream exceeds the attachment cap', async () => {
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    const client = larkMocks.clients[0];
    client.im.messageResource.get.mockResolvedValueOnce({
      getReadableStream: () => Readable.from([Buffer.alloc(MAX_ATTACHMENT_DOWNLOAD_BYTES + 1)]),
    });

    await expect(adapter.downloadFile('om_1', 'file_1', 'file')).rejects.toThrow(/download limit/);
  });

  it('scrubs card action trigger logs before callback handling', () => {
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() =>
      (adapter as unknown as { handleCardAction(data: unknown): unknown }).handleCardAction(circular),
    ).not.toThrow();

    expect(consoleSpy).toHaveBeenCalledWith(
      '[feishu] card.action.trigger received:',
      '[object Object]',
    );
  });

  it('uses raw card elements directly when provided', async () => {
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    const client = larkMocks.clients[0];
    const rawElements = [
      { tag: 'markdown', content: '**CLI Sessions**' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Resume' },
            value: { action: 'resume_cli', sessionId: 'ses_1', cwd: '/tmp/project' },
          },
        ],
      },
    ];

    await adapter.sendCard('oc_1', {
      type: 'session_list',
      title: 'CLI Sessions',
      content: 'fallback',
      rawElements,
    });

    const createMock = client.im.message.create as ReturnType<typeof vi.fn>;
    const firstCall = createMock.mock.calls[0]?.[0] as { data: { content: string } } | undefined;
    expect(firstCall).toBeDefined();
    const content = firstCall!.data.content;
    expect(JSON.parse(content)).toMatchObject({
      elements: rawElements,
      header: { title: { tag: 'plain_text', content: 'CLI Sessions' } },
    });
  });

  it('sends image paths as image messages and other paths as file messages', async () => {
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    const client = larkMocks.clients[0];
    const dir = mkdtempSync(join(tmpdir(), 'cli2im-feishu-'));
    const imagePath = join(dir, 'picture.png');
    const filePath = join(dir, 'report.pdf');
    writeFileSync(imagePath, 'image-data');
    writeFileSync(filePath, 'file-data');

    await adapter.sendFile('oc_1', { path: imagePath, name: 'picture.png' });
    await adapter.sendFile('oc_1', { path: filePath, name: 'report.pdf' });

    expect(client.im.image.create).toHaveBeenCalledTimes(1);
    expect(client.im.file.create).toHaveBeenCalledTimes(1);
    expect(client.im.message.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          msg_type: 'image',
          content: JSON.stringify({ image_key: 'img_top' }),
        }),
      }),
    );
    expect(client.im.message.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          msg_type: 'file',
          content: JSON.stringify({ file_key: 'file_data' }),
        }),
      }),
    );
  });

  it('does not create an image message when aborted after upload', async () => {
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    const client = larkMocks.clients[0];
    const dir = mkdtempSync(join(tmpdir(), 'cli2im-feishu-'));
    const imagePath = join(dir, 'picture.png');
    const controller = new AbortController();
    writeFileSync(imagePath, 'image-data');
    client.im.image.create.mockImplementationOnce(async () => {
      controller.abort();
      return { image_key: 'img_after_abort' };
    });

    await expect(
      adapter.sendFile('oc_1', { path: imagePath, name: 'picture.png' }, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(client.im.message.create).not.toHaveBeenCalled();
  });

  it('passes abort signals through text message creation', async () => {
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    const client = larkMocks.clients[0];
    const controller = new AbortController();

    await adapter.send('oc_1', { text: 'hello' }, { signal: controller.signal });

    expect(client.im.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: controller.signal,
      }),
    );
  });

  it('removes the temporary opus file when audio upload aborts', async () => {
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    const client = larkMocks.clients[0];
    const controller = new AbortController();
    const now = 1_765_000_000_000;
    const tmpPath = join(tmpdir(), `cli2im-opus-${now}.ogg`);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    mockFfmpegOutput(Buffer.from('opus-data'));
    client.im.file.create.mockImplementationOnce(async () => {
      controller.abort();
      throw new DOMException('Operation aborted', 'AbortError');
    });

    await expect(
      adapter.sendAudio('oc_1', Buffer.from('mp3-data'), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(existsSync(tmpPath)).toBe(false);
    expect(client.im.message.create).not.toHaveBeenCalled();
  });

  it('resolves bot open id before starting the websocket client', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const textUrl = String(url);
      if (textUrl.endsWith('/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ tenant_access_token: 'tenant_token' }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ bot: { open_id: 'ou_bot' } }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });

    await adapter.connect();

    expect(adapter.getBotOpenId()).toBe('ou_bot');
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      expect.objectContaining({
        method: 'POST',
        signal: expect.any(AbortSignal),
        body: JSON.stringify({ app_id: 'app', app_secret: 'secret' }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://open.feishu.cn/open-apis/bot/v3/info/',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer tenant_token',
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('continues connecting when bot identity resolution fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 999, msg: 'bad' }), {
      status: 500,
    })));

    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });

    await expect(adapter.connect()).resolves.toBeUndefined();
    expect(adapter.getBotOpenId()).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[cli2im] Failed to resolve Feishu bot identity:'),
      expect.any(Error),
    );

    warn.mockRestore();
  });
});

function mockFfmpegOutput(output: Buffer): void {
  childProcessMocks.spawn.mockImplementationOnce(() => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stdin: Writable;
      kill: ReturnType<typeof vi.fn>;
    };
    proc.stdout = new PassThrough();
    proc.stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
      final(callback) {
        callback();
        setImmediate(() => {
          proc.stdout.end(output);
          proc.emit('close', 0);
        });
      },
    });
    proc.kill = vi.fn(() => {
      proc.emit('close', null);
      return true;
    });
    return proc;
  });
}
