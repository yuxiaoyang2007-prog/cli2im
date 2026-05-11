export const MAX_ATTACHMENT_DOWNLOAD_BYTES = 50 * 1024 * 1024;

export function assertWithinAttachmentDownloadLimit(size: number, label = 'Attachment'): void {
  if (size > MAX_ATTACHMENT_DOWNLOAD_BYTES) {
    throw new Error(
      `${label} exceeds ${MAX_ATTACHMENT_DOWNLOAD_BYTES} byte download limit`,
    );
  }
}
