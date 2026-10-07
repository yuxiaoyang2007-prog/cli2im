import { EventEmitter } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FeishuAdapter,
  FeishuResponseError,
  FeishuSdkBoundaryError,
} from '../src/platforms/feishu/adapter.js';
import { MAX_ATTACHMENT_DOWNLOAD_BYTES } from '../src/security/download-limits.js';
import type { InboundMessage } from '../src/types.js';

const larkMocks = vi.hoisted(() => {
  const clients: MockClient[] = [];
  const configurations: Array<Record<string, unknown>> = [];
  const wsClients: MockWsClient[] = [];
  const wsConfigurations: Array<Record<string, unknown>> = [];

  class MockWsClient {
    start = vi.fn(async () => undefined);
    close = vi.fn();
    constructor(options: Record<string, unknown>) {
      wsClients.push(this);
      wsConfigurations.push(options);
    }
  }

  class MockClient {
    im = {
      message: {
        create: vi.fn(async () => ({ code: 0, data: { message_id: 'om_sent' } })),
        reply: vi.fn(async () => ({ code: 0, data: { message_id: 'om_reply' } })),
        patch: vi.fn(async () => ({ code: 0 })),
        delete: vi.fn(async () => ({})),
      },
      image: {
        create: vi.fn(async () => ({ image_key: 'img_top' })),
      },
      file: {
        create: vi.fn(async (_request: any) => ({ data: { file_key: 'file_data' } })),
      },
      messageResource: {
        get: vi.fn(async () => ({
          getReadableStream: () => Readable.from([Buffer.from('downloaded')]),
        })),
      },
    };

    constructor(options: Record<string, unknown>) {
      clients.push(this);
      configurations.push(options);
    }
  }

  return { clients, configurations, MockClient, wsClients, wsConfigurations, MockWsClient };
});

const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

type MockClient = {
  im: {
    message: {
      create: ReturnType<typeof vi.fn>;
      reply: ReturnType<typeof vi.fn>;
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
  WSClient: larkMocks.MockWsClient,
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
    larkMocks.configurations.length = 0;
    larkMocks.wsClients.length = 0;
    larkMocks.wsConfigurations.length = 0;
    vi.stubEnv('CLI2IM_NETWORK_REQUIRED', '0');
    vi.stubEnv('https_proxy', '');
    vi.stubEnv('HTTPS_PROXY', '');
  });

  afterEach(() => {
    vi.useRealTimers();
    childProcessMocks.spawn.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('renders an allowlisted Feishu card header color', async () => {
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    const client = larkMocks.clients[0];
    await adapter.send('oc_1', {
      card: {
        type: 'final',
        title: '🟠 待你处理',
        headerTemplate: 'orange',
        content: '项目：cli2im',
      },
    });
    const createMock = client.im.message.create as ReturnType<typeof vi.fn>;
    const request = createMock.mock.calls[0]?.[0] as { data: { content: string } };
    const sentCard = JSON.parse(request.data.content);
    expect(sentCard.header).toEqual({
      title: { tag: 'plain_text', content: '🟠 待你处理' },
      template: 'orange',
    });
  });

  it('serializes the same optional idempotency key for text and card sends', async () => {
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    const client = larkMocks.clients[0];
    const idempotencyKey = '0123456789abcdef01234567';

    await adapter.send('oc_1', { text: 'hello' }, { idempotencyKey });
    await adapter.sendCard('oc_1', {
      type: 'final',
      content: 'safe card',
    }, { idempotencyKey });

    const createMock = client.im.message.create as ReturnType<typeof vi.fn>;
    expect(createMock.mock.calls.map(([request]) => request.data.uuid)).toEqual([
      idempotencyKey,
      idempotencyKey,
    ]);
  });

  it.each([
    {
      label: 'an HTTP-200 business error',
      response: {
        code: 230003,
        msg: 'PRIVATE_TEXT_DETAIL bearer-secret-value',
        data: { message_id: 'must-not-be-accepted' },
      },
      category: 'feishu_business_error',
      message: 'Feishu text create failed',
    },
    {
      label: 'a missing business code',
      response: { data: { message_id: 'om_unverified' } },
      category: 'feishu_business_error',
      message: 'Feishu text create failed',
    },
    {
      label: 'a missing message id',
      response: { code: 0, data: {} },
      category: 'feishu_invalid_response',
      message: 'Feishu text create returned an invalid response',
    },
    {
      label: 'a blank message id',
      response: { code: 0, data: { message_id: '   ' } },
      category: 'feishu_invalid_response',
      message: 'Feishu text create returned an invalid response',
    },
  ] as const)('rejects text create with $label without exposing response details', async ({
    response,
    category,
    message,
  }) => {
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    const client = larkMocks.clients[0];
    client.im.message.create.mockResolvedValueOnce(response as never);

    const failure = await adapter.send('oc_1', { text: 'binding confirmation' })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(FeishuResponseError);
    expect(failure).toMatchObject({
      name: 'FeishuResponseError',
      category,
      message,
    });
    expect(JSON.stringify(failure)).not.toMatch(
      /230003|PRIVATE_TEXT_DETAIL|bearer-secret-value|must-not-be-accepted|om_unverified/,
    );
  });

  it('serializes a full replacement card through Feishu message patch', async () => {
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    const client = larkMocks.clients[0];

    await adapter.replaceCard('om_delayed', {
      type: 'final',
      title: '🟢 任务完成',
      headerTemplate: 'green',
      content: '**项目：** cli2im\n⚠️ 延迟送达',
    });

    expect(client.im.message.patch).toHaveBeenCalledWith({
      path: { message_id: 'om_delayed' },
      data: {
        content: JSON.stringify({
          config: { wide_screen_mode: true },
          elements: [{
            tag: 'markdown',
            content: '**项目：** cli2im\n⚠️ 延迟送达',
          }],
          header: {
            title: { tag: 'plain_text', content: '🟢 任务完成' },
            template: 'green',
          },
        }),
      },
    });
  });

  it('rejects an HTTP-200 card create business error without exposing response details', async () => {
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    const client = larkMocks.clients[0];
    client.im.message.create.mockResolvedValueOnce({
      code: 230001,
      msg: 'PRIVATE_REMOTE_DETAIL bearer-secret-value',
      data: { message_id: 'must-not-be-accepted' },
    } as never);

    const failure = await adapter.sendCard('oc_1', {
      type: 'final',
      content: 'safe card',
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(FeishuResponseError);
    expect(failure).toMatchObject({ category: 'feishu_business_error' });
    expect(String(failure)).toBe('FeishuResponseError: Feishu card create failed');
    expect(JSON.stringify(failure)).not.toMatch(/230001|PRIVATE_REMOTE_DETAIL|bearer-secret-value/);
  });

  it('rejects a successful card create response without a non-empty message id', async () => {
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    const client = larkMocks.clients[0];
    client.im.message.create.mockResolvedValueOnce({ code: 0, data: { message_id: '   ' } });

    await expect(adapter.sendCard('oc_1', {
      type: 'final',
      content: 'safe card',
    })).rejects.toMatchObject({
      name: 'FeishuResponseError',
      category: 'feishu_invalid_response',
      message: 'Feishu card create returned an invalid response',
    });
  });

  it('rejects a card create response whose business code is missing', async () => {
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    const client = larkMocks.clients[0];
    client.im.message.create.mockResolvedValueOnce({
      data: { message_id: 'om_unverified' },
    } as never);

    await expect(adapter.sendCard('oc_1', {
      type: 'final',
      content: 'safe card',
    })).rejects.toMatchObject({
      name: 'FeishuResponseError',
      category: 'feishu_business_error',
      message: 'Feishu card create failed',
    });
  });

  it('rejects an HTTP-200 full-card patch business error safely', async () => {
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    const client = larkMocks.clients[0];
    client.im.message.patch.mockResolvedValueOnce({
      code: 230002,
      msg: 'PRIVATE_PATCH_DETAIL bearer-secret-value',
    } as never);

    const failure = await adapter.replaceCard('om_delayed', {
      type: 'final',
      content: 'safe card',
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: 'FeishuResponseError',
      category: 'feishu_business_error',
      message: 'Feishu card patch failed',
    });
    expect(JSON.stringify(failure)).not.toMatch(/230002|PRIVATE_PATCH_DETAIL|bearer-secret-value/);
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

  it('logs a fixed card action summary without serializing the callback object', async () => {
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const callback = vi.fn();
    adapter.onCallback(callback);
    larkMocks.clients[0].im.message.create.mockResolvedValueOnce({ code: 0, data: { message_id: 'om_private_secret' } });
    await adapter.send('oc_private_secret', { text: 'card placeholder' });

    expect(() =>
      (adapter as unknown as { handleCardAction(data: unknown): unknown }).handleCardAction({
        context: {
          open_chat_id: 'oc_private_secret',
          open_message_id: 'om_private_secret',
          chat_type: 'group',
        },
        operator: { open_id: 'ou_private_secret' },
        action: { value: { action: 'private_action', sessionId: 'private_session' } },
      }),
    ).not.toThrow();

    expect(consoleSpy).toHaveBeenCalledWith(
      '[feishu] callback=card_action chat=group operator=present message=present valueKeys=2',
    );
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain('private_secret');
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain('private_action');
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain('private_session');
    expect(callback).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
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

  it('aborts a never-settling text create at the local promise boundary without forwarding signal', async () => {
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    const client = larkMocks.clients[0];
    const controller = new AbortController();
    const sdkResult = deferred<{ code: number; data: { message_id: string } }>();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    client.im.message.create.mockReturnValueOnce(sdkResult.promise);

    try {
      const sending = adapter.send('oc_1', { text: 'hello' }, { signal: controller.signal });
      expect(client.im.message.create).toHaveBeenCalledTimes(1);
      const createMock = client.im.message.create as ReturnType<typeof vi.fn>;
      expect(createMock.mock.calls[0]?.[0]).not.toHaveProperty('signal');

      controller.abort(new Error('private abort reason'));
      await expect(sending).rejects.toMatchObject({
        name: 'AbortError',
        message: 'Feishu request aborted',
      });

      sdkResult.reject(new Error('private late sdk rejection'));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('rejects an already-aborted card create without starting an SDK request', async () => {
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    const client = larkMocks.clients[0];
    const controller = new AbortController();
    controller.abort(new Error('private already-aborted reason'));

    await expect(adapter.sendCard('oc_1', {
      type: 'final', content: 'safe card',
    }, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Feishu request aborted',
    });
    expect(client.im.message.create).not.toHaveBeenCalled();
  });

  it('times out a never-settling full-card patch with a fixed safe boundary error', async () => {
    vi.useFakeTimers();
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    const client = larkMocks.clients[0];
    client.im.message.patch.mockReturnValueOnce(new Promise(() => undefined));

    const patching = adapter.replaceCard('om_delayed', {
      type: 'final', content: 'safe card',
    });
    const failure = patching.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(failure).resolves.toEqual(expect.objectContaining({
      name: 'FeishuSdkBoundaryError',
      category: 'feishu_request_timeout',
      message: 'Feishu request timed out',
    }));
    expect(await failure).toBeInstanceOf(FeishuSdkBoundaryError);
  });

  it('removes the temporary opus file when audio upload aborts', async () => {
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    const client = larkMocks.clients[0];
    const controller = new AbortController();
    let tmpPath = '';
    mockFfmpegOutput(Buffer.from('opus-data'));
    client.im.file.create.mockImplementationOnce(async (request: { data: { file: { path: string } } }) => {
      tmpPath = request.data.file.path;
      controller.abort();
      throw new DOMException('Operation aborted', 'AbortError');
    });

    await expect(
      adapter.sendAudio('oc_1', Buffer.from('mp3-data'), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(existsSync(tmpPath)).toBe(false);
    expect(existsSync(dirname(tmpPath))).toBe(false);
    expect(client.im.message.create).not.toHaveBeenCalled();
  });

  it('isolates simultaneous audio uploads even when the wall clock is identical', async () => {
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    const client = larkMocks.clients[0];
    vi.spyOn(Date, 'now').mockReturnValue(1234);
    mockFfmpegOutput(Buffer.from('voice-A'));
    mockFfmpegOutput(Buffer.from('voice-B'));
    const uploads: Array<{ path: string; content: string }> = [];
    const gate = deferred<void>();
    client.im.file.create.mockImplementation(async (request: { data: { file: { path: string } } }) => {
      const path = request.data.file.path;
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
      uploads.push({ path, content: readFileSync(path, 'utf8') });
      if (uploads.length === 2) gate.resolve();
      await gate.promise;
      expect(readFileSync(path, 'utf8')).toBe(uploads.find((upload) => upload.path === path)?.content);
      return { data: { file_key: 'uploaded' } };
    });
    await Promise.all([adapter.sendAudio('chat-A', Buffer.from('A')), adapter.sendAudio('chat-B', Buffer.from('B'))]);
    expect(new Set(uploads.map((upload) => upload.path)).size).toBe(2);
    expect(uploads.map((upload) => upload.content).sort()).toEqual(['voice-A', 'voice-B']);
    expect(uploads.every((upload) => !existsSync(dirname(upload.path)))).toBe(true);
  });

  it('installs the private logger at the SDK client boundary', () => {
    new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    const sink = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logger = larkMocks.configurations[0].logger as { error(...values: unknown[]): void };
    logger.error({ config: { data: '{"app_secret":"secret-value"}' }, code: 'ECONNRESET' });
    expect(sink).toHaveBeenCalledWith('[feishu] SDK error', { code: 'ECONNRESET' });
    expect(JSON.stringify(sink.mock.calls)).not.toContain('secret-value');
  });

  it('does not expose Axios request bodies even when callers log the rejected error', async () => {
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    larkMocks.clients[0].im.message.create.mockRejectedValueOnce(Object.assign(new Error('private-message'), {
      config: { data: 'app-secret' }, response: { status: 401, data: 'private-message' },
    }));
    const failure = await adapter.send('chat', { text: 'private-message' }).catch((error) => error);
    expect(failure).toMatchObject({ message: 'Feishu request failed', status: 401 });
    expect(JSON.stringify(failure)).not.toMatch(/private-message|app-secret/);
    expect(failure).not.toHaveProperty('cause');
  });

  it('carries platform topic metadata without treating an ordinary reply as a topic', () => {
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    const received: InboundMessage[] = [];
    adapter.onMessage((message) => received.push(message));
    const handle = adapter as unknown as { handleMessage(data: unknown): void };
    for (const message of [
      { message_id: 'one', thread_id: 'thread-1', root_id: 'root' },
      { message_id: 'two', root_id: 'ordinary-reply' },
    ]) handle.handleMessage({ sender: { sender_type: 'user', sender_id: { open_id: 'user' } }, message: {
      ...message, chat_id: 'group', message_type: 'text', content: '{"text":"hello"}',
    } });
    expect(received[0]).toMatchObject({ messageId: 'one', threadId: 'thread-1' });
    expect(received[1].threadId).toBeUndefined();
  });

  it('replies into an explicit topic and refuses a topic without its anchor', async () => {
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    await adapter.send('chat', { text: 'hello', threadId: 'topic', replyToMessageId: 'anchor' });
    expect(larkMocks.clients[0].im.message.reply).toHaveBeenCalledWith({
      path: { message_id: 'anchor' }, data: { msg_type: 'text', content: '{"text":"hello"}', reply_in_thread: true },
    });
    await expect(adapter.send('chat', { text: 'hello', threadId: 'topic' })).rejects.toThrow('anchor');
    expect(larkMocks.clients[0].im.message.create).not.toHaveBeenCalled();
  });

  it('recovers callback topic only from a sent-message route in the same chat', async () => {
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    const callback = vi.fn();
    adapter.onCallback(callback);
    await adapter.send('chat', { card: { type: 'final', content: 'hello' }, threadId: 'topic', replyToMessageId: 'anchor' });
    const invoke = (chatId: string) => (adapter as unknown as { handleCardAction(data: unknown): void }).handleCardAction({
      context: { open_chat_id: chatId, open_message_id: 'om_reply', chat_type: 'group' }, operator: { open_id: 'user' },
      action: { value: { threadId: 'untrusted-forged-topic' } },
    });
    invoke('chat');
    expect(callback.mock.calls[0][0].threadId).toBe('topic');
    invoke('other-chat');
    expect(callback).toHaveBeenCalledOnce();
  });

  it('rejects cards from before restart instead of treating a missing topic as the main chat', () => {
    const restarted = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    const callback = vi.fn();
    restarted.onCallback(callback);
    const result = (restarted as unknown as { handleCardAction(data: unknown): unknown }).handleCardAction({
      context: { open_chat_id: 'chat', open_message_id: 'old-topic-card' }, operator: { open_id: 'user' },
      action: { value: { action: 'control:/new', threadId: 'forged' } },
    });
    expect(callback).not.toHaveBeenCalled();
    expect(result).toMatchObject({ toast: { content: expect.stringContaining('/status') } });
  });

  it.each(['p2p', 'group'])('recovers trusted %s chat type when a card callback omits it', async (chatType) => {
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    const callback = vi.fn();
    adapter.onMessage(() => undefined);
    adapter.onCallback(callback);
    const internal = adapter as unknown as { handleMessage(data: unknown): void; handleCardAction(data: unknown): unknown };
    internal.handleMessage({ sender: { sender_type: 'user', sender_id: { open_id: 'user' } }, message: {
      message_id: 'inbound', chat_id: 'chat', chat_type: chatType, message_type: 'text', content: '{"text":"/status"}',
    } });
    await adapter.send('chat', { card: { type: 'final', content: 'controls' } });
    internal.handleCardAction({
      context: { open_chat_id: 'chat', open_message_id: 'om_sent' }, operator: { open_id: 'user' },
      action: { value: { action: 'control:/status', chat_type: 'forged' } },
    });
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ chatType }));
  });

  it('recreates the WebSocket client and proxy agent using the current route on reconnect', async () => {
    vi.stubEnv('CLI2IM_NETWORK_REQUIRED', '1');
    vi.stubEnv('https_proxy', 'http://127.0.0.1:7890');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ tenant_access_token: 'tenant_token', bot: { open_id: 'ou_bot' } }))));
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    expect(larkMocks.wsClients).toHaveLength(0);
    await adapter.connect();
    const firstClient = larkMocks.wsClients[0];
    const firstAgent = larkMocks.wsConfigurations[0].agent as import('node:https').Agent;
    const destroyFirst = vi.spyOn(firstAgent, 'destroy');
    expect(firstAgent.options).toMatchObject({ proxyEnv: { HTTPS_PROXY: 'http://127.0.0.1:7890' } });
    vi.stubEnv('https_proxy', 'http://127.0.0.1:7891');
    await adapter.connect();
    const secondClient = larkMocks.wsClients[1];
    const secondAgent = larkMocks.wsConfigurations[1].agent as import('node:https').Agent;
    const destroySecond = vi.spyOn(secondAgent, 'destroy');
    expect(firstClient.close).toHaveBeenCalledOnce();
    expect(firstClient.close).toHaveBeenCalledWith({ force: true });
    expect(destroyFirst).toHaveBeenCalledOnce();
    expect(firstClient.start).toHaveBeenCalledOnce();
    expect(secondClient.start).toHaveBeenCalledOnce();
    expect(secondAgent).not.toBe(firstAgent);
    expect(secondAgent.options).toMatchObject({ proxyEnv: { HTTPS_PROXY: 'http://127.0.0.1:7891' } });
    await adapter.disconnect();
    expect(secondClient.close).toHaveBeenCalledOnce();
    expect(secondClient.close).toHaveBeenCalledWith({ force: true });
    expect(destroySecond).toHaveBeenCalledOnce();
  });

  it('refuses missing required proxy before creating a WebSocket client or resolving identity', async () => {
    vi.stubEnv('CLI2IM_NETWORK_REQUIRED', '1');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    await expect(adapter.connect()).rejects.toThrow('代理未启用');
    expect(larkMocks.wsClients).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not start an obsolete WebSocket client after disconnect during identity resolution', async () => {
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }))
      .mockResolvedValue(new Response(JSON.stringify({ bot: { open_id: 'ou_bot' } }))));
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'bot' });
    const connecting = adapter.connect();
    const client = larkMocks.wsClients[0];
    await adapter.disconnect();
    resolveFetch(new Response(JSON.stringify({ tenant_access_token: 'tenant_token' })));
    await connecting;
    expect(client.close).toHaveBeenCalledOnce();
    expect(client.start).not.toHaveBeenCalled();
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
      {},
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
          setImmediate(() => proc.emit('close', 0));
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
