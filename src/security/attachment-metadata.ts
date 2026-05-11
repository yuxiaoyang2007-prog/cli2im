import type { FileAttachment } from '../types.js';
import { stripCtiTags } from './validators.js';

export function formatAttachmentMetadataFields(attachment: FileAttachment): string[] {
  return [
    markdownField('fileName', attachment.fileName),
    markdownField('mimeType', attachment.mimeType),
    markdownField('localPath', attachment.localPath),
    markdownField('url', attachment.url),
    markdownField('fileKey', attachment.fileKey),
  ].filter((field): field is string => Boolean(field));
}

function markdownField(label: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  return `${label}: ${JSON.stringify(stripCtiTags(value))}`;
}
