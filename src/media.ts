import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import type { FileAttachment, InboundMessage, PlatformAdapter, UserMessage } from './types.js';
import { formatAttachmentMetadataFields } from './security/attachment-metadata.js';
import { assertWithinAttachmentDownloadLimit } from './security/download-limits.js';
import { getCli2imDataDir } from './util/data-dir.js';

export async function downloadInboundAttachments(
  msg: InboundMessage,
  adapter: Pick<PlatformAdapter, 'downloadFile'>,
  targetDir = join(getCli2imDataDir(), 'media'),
): Promise<void> {
  if (!msg.attachments?.length || !adapter.downloadFile) return;

  await mkdir(targetDir, { recursive: true });
  await ensureTargetDirGitignore(targetDir);
  for (const attachment of msg.attachments) {
    if (attachment.localPath || !attachment.fileKey || !attachment.messageId) continue;
    if (typeof attachment.size === 'number') {
      assertWithinAttachmentDownloadLimit(attachment.size);
    }

    const data = await adapter.downloadFile(
      attachment.messageId,
      attachment.fileKey,
      attachment.type,
    );
    assertWithinAttachmentDownloadLimit(data.byteLength);
    const path = join(targetDir, buildAttachmentFileName(attachment));
    await writeFile(path, data);
    attachment.localPath = path;
  }
}

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export async function buildUserMessageForAgent(
  agentName: string,
  text: string,
  attachments?: FileAttachment[],
): Promise<UserMessage> {
  if (!attachments?.length) {
    return { role: 'user', content: text };
  }

  if (agentName === 'codex') {
    return { role: 'user', content: text, attachments };
  }

  const contentText = appendNonImageAttachmentPaths(text, attachments);
  if (agentName !== 'claude-code') {
    return { role: 'user', content: contentText };
  }

  const imageAttachments = attachments.filter(
    (attachment) => attachment.type === 'image' && attachment.localPath,
  );
  if (imageAttachments.length === 0) {
    return { role: 'user', content: contentText };
  }

  const content: Exclude<UserMessage['content'], string> = [
    { type: 'text', text: contentText },
  ];
  for (const attachment of imageAttachments) {
    const localPath = attachment.localPath;
    if (!localPath) continue;
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: attachment.mimeType ?? inferMimeType(localPath),
        data: (await readFile(localPath)).toString('base64'),
      },
    });
  }

  return { role: 'user', content };
}

function appendNonImageAttachmentPaths(text: string, attachments: FileAttachment[]): string {
  const lines = attachments
    .filter((attachment) => attachment.type !== 'image')
    .map((attachment) => {
      const metadata = formatAttachmentMetadataFields(attachment);
      if (metadata.length === 0) return '- attachment: "unavailable"';
      return ['- attachment', ...metadata.map((field) => `  - ${field}`)].join('\n');
    });

  if (lines.length === 0) return text;
  return `${text}\n\nAttached files:\n${lines.join('\n')}`;
}

function buildAttachmentFileName(attachment: FileAttachment): string {
  const name = sanitizeFileName(attachment.fileName ?? attachment.fileKey ?? 'attachment');
  const ext = extname(name) || extensionForAttachment(attachment);
  const stem = extname(name) ? name.slice(0, -extname(name).length) : name;
  return `${Date.now()}-${randomUUID()}-${stem}${ext}`;
}

async function ensureTargetDirGitignore(targetDir: string): Promise<void> {
  try {
    await writeFile(join(targetDir, '.gitignore'), '*\n', { flag: 'wx' });
  } catch (err) {
    if (isNodeError(err) && err.code === 'EEXIST') return;
    throw err;
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function sanitizeFileName(name: string): string {
  return basename(name).replace(/[^a-zA-Z0-9._-]/g, '_') || 'attachment';
}

function extensionForAttachment(attachment: FileAttachment): string {
  if (attachment.type === 'image') return extensionForMime(attachment.mimeType) ?? '.png';
  return extensionForMime(attachment.mimeType) ?? '';
}

function inferMimeType(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

function extensionForMime(mimeType?: string): string | undefined {
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/gif') return '.gif';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'application/pdf') return '.pdf';
  if (mimeType === 'text/plain') return '.txt';
  return undefined;
}
