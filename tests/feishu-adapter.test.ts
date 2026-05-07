import { Readable } from 'node:stream';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeishuAdapter } from '../src/platforms/feishu/adapter.js';
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

describe('FeishuAdapter file handling', () => {
  beforeEach(() => {
    larkMocks.clients.length = 0;
  });

  afterEach(() => {
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
