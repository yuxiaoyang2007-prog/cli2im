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

  const contentText = appendAttachmentPaths(text, attachments, false);
  if (agentName !== 'claude-code') {
    // zcode/GLM-5.2 has no native multimodal (no `attachment:true` in its
    // catalog), but it CAN see images by reading the file via its Read tool
    // (which inlines the image as a vision block) and then running the
    // analyze_image tool. So images must reach the agent as explicit file
    // PATHS with a clear Read instruction in the prompt — not as base64
    // blocks (which the model adapter rejects) and not as a bare "Attached
    // files" list (which the agent ignores). The download step above already
    // wrote each image to `attachment.localPath`.
    if (agentName === 'zcode') {
      return { role: 'user', content: appendImageReadInstruction(text, attachments) };
    }
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

function appendAttachmentPaths(text: string, attachments: FileAttachment[], includeImages: boolean): string {
  const lines = attachments
    .filter((attachment) => includeImages || attachment.type !== 'image')
    .map((attachment) => {
      const metadata = formatAttachmentMetadataFields(attachment);
      if (metadata.length === 0) return '- attachment: "unavailable"';
      return ['- attachment', ...metadata.map((field) => `  - ${field}`)].join('\n');
    });

  if (lines.length === 0) return text;
  return `${text}\n\nAttached files:\n${lines.join('\n')}`;
}

// Build a prompt for the zcode agent that makes it READ user-sent images.
// GLM-5.2 has no native multimodal, but its Read tool inlines an image as a
// vision block, after which the agent can analyze it (e.g. via analyze_image).
// The key — verified by live experiment — is to name the Read tool explicitly
// and give absolute paths; a generic "Attached files:" note is ignored.
function appendImageReadInstruction(text: string, attachments: FileAttachment[]): string {
  const images = attachments.filter((a) => a.type === 'image' && a.localPath);
  if (images.length === 0) {
    // No usable image (e.g. download failed) — fall back to the generic list
    // so non-image attachments are still surfaced.
    return appendAttachmentPaths(text, attachments, false);
  }

  const fileList = images.map((a) => `- ${a.localPath}`).join('\n');
  const instruction =
    images.length === 1
      ? `用户发送了一张图片，保存在以下路径，请用 Read 工具读取它，然后结合图片内容回答用户的问题：\n${fileList}`
      : `用户发送了 ${images.length} 张图片，保存在以下路径，请用 Read 工具逐一读取它们，然后结合图片内容回答用户的问题：\n${fileList}`;

  // Non-image attachments (files, audio) still get the generic listing.
  const others = appendAttachmentPaths('', attachments.filter((a) => a.type !== 'image'), false).trim();
  return others ? `${text}\n\n${instruction}\n\n${others}` : `${text}\n\n${instruction}`;
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
