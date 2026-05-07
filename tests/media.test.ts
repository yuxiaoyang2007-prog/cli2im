import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildUserMessageForAgent,
  downloadInboundAttachments,
} from '../src/media.js';
import type { InboundMessage, PlatformAdapter } from '../src/types.js';

describe('media bridge helpers', () => {
  it('downloads inbound attachments to the media directory and sets localPath', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli2im-media-'));
    const msg: InboundMessage = {
      platform: 'feishu',
      chatId: 'oc_1',
      userId: 'ou_1',
      text: 'see attached',
      attachments: [
        {
          type: 'image',
          fileKey: 'img_1',
          messageId: 'om_1',
          mimeType: 'image/png',
        },
      ],
    };
    const adapter: Pick<PlatformAdapter, 'downloadFile'> = {
      downloadFile: vi.fn(async () => Buffer.from('png-data')),
    };

    await downloadInboundAttachments(msg, adapter, dir);

    expect(adapter.downloadFile).toHaveBeenCalledWith('om_1', 'img_1', 'image');
    expect(msg.attachments?.[0].localPath).toMatch(/\.png$/);
    expect(readFileSync(msg.attachments![0].localPath!, 'utf8')).toBe('png-data');
  });

  it('passes downloaded attachments through to Codex user messages', async () => {
    const attachment = {
      type: 'image' as const,
      localPath: '/tmp/picture.png',
      mimeType: 'image/png',
    };

    await expect(buildUserMessageForAgent('codex', 'analyze this', [attachment])).resolves.toEqual({
      role: 'user',
      content: 'analyze this',
      attachments: [attachment],
    });
  });

  it('converts Claude Code images to base64 blocks and injects file paths into text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli2im-media-'));
    const imagePath = join(dir, 'picture.png');
    const filePath = join(dir, 'report.pdf');
    await import('node:fs/promises').then(({ writeFile }) =>
      Promise.all([writeFile(imagePath, 'png-data'), writeFile(filePath, 'pdf-data')]),
    );

    const msg = await buildUserMessageForAgent('claude-code', 'review these', [
      { type: 'image', localPath: imagePath, mimeType: 'image/png', fileName: 'picture.png' },
      { type: 'file', localPath: filePath, fileName: 'report.pdf' },
    ]);

    expect(Array.isArray(msg.content)).toBe(true);
    const parts = msg.content as Array<
      | { type: 'text'; text: string }
      | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
    >;
    expect(parts[0]).toEqual({
      type: 'text',
      text: expect.stringContaining(filePath),
    });
    expect(parts[1]).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: Buffer.from('png-data').toString('base64'),
      },
    });
  });
});
