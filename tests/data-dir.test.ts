import { chmodSync, readFileSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensurePrivateDirectorySync, getCli2imDataDir } from '../src/util/data-dir.js';
import { downloadInboundAttachments } from '../src/media.js';
import type { InboundMessage, PlatformAdapter } from '../src/types.js';

describe('cli2im data directory', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps the production default data directory unchanged when env is unset', () => {
    vi.stubEnv('CLI2IM_DATA_DIR', undefined);

    expect(getCli2imDataDir()).toBe(join(homedir(), '.cli2im'));
  });

  it('uses CLI2IM_DATA_DIR for the default inbound media directory', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cli2im-data-dir-'));
    vi.stubEnv('CLI2IM_DATA_DIR', dataDir);
    const msg: InboundMessage = {
      platform: 'feishu',
      chatId: 'oc_1',
      userId: 'ou_1',
      text: 'see attached',
      attachments: [
        {
          type: 'file',
          fileKey: 'file_1',
          messageId: 'om_1',
          mimeType: 'text/plain',
        },
      ],
    };
    const adapter: Pick<PlatformAdapter, 'downloadFile'> = {
      downloadFile: vi.fn(async () => Buffer.from('file-data')),
    };

    await downloadInboundAttachments(msg, adapter);

    const mediaDir = join(dataDir, 'media');
    expect(msg.attachments?.[0].localPath?.startsWith(`${mediaDir}${sep}`)).toBe(true);
    expect(readFileSync(msg.attachments![0].localPath!, 'utf8')).toBe('file-data');
    expect(readFileSync(join(mediaDir, '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('creates and repairs the cli2im data directory as owner-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cli2im-private-parent-'));
    try {
      const dataDir = join(root, 'nested', 'data');

      ensurePrivateDirectorySync(dataDir);
      expect(statSync(dataDir).mode & 0o777).toBe(0o700);

      chmodSync(dataDir, 0o755);
      ensurePrivateDirectorySync(dataDir);
      expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
