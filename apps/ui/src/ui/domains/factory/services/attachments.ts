import { requestJson } from './request';

export type AttachmentSource = 'chat' | 'comment' | 'upload' | 'clickup' | 'github' | 'gitlab' | 'agent';

/** A file attached to a card, or to a session that works no card. */
export interface Attachment {
  id: string;
  workItemId: string | null;
  sessionId: string | null;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  source: AttachmentSource;
  sourceUrl: string | null;
  addedBy: string;
  addedAt: string;
  /** Opens the file; with `?download` it is always saved. */
  contentUrl: string;
  /** Where the agent finds it, relative to its working folder. */
  sandboxPath: string;
}

/** Who holds an upload: the session's card, or the session itself when it works none. */
export type AttachmentTarget = { workItemId: string } | { sessionId: string };

function collectionUrl(baseUrl: string, target: AttachmentTarget): string {
  return 'workItemId' in target
    ? `${baseUrl}/web/factory/work-items/${encodeURIComponent(target.workItemId)}/attachments`
    : `${baseUrl}/web/factory/sessions/${encodeURIComponent(target.sessionId)}/attachments`;
}

export async function listAttachments(
  baseUrl: string,
  target: AttachmentTarget,
  signal?: AbortSignal,
): Promise<Attachment[]> {
  const { attachments } = await requestJson<{ attachments: Attachment[] }>(collectionUrl(baseUrl, target), { signal });
  return attachments;
}

/** The file is the request body: it streams to the server as is, never re-encoded. */
export async function uploadAttachment(
  baseUrl: string,
  target: AttachmentTarget,
  file: Blob | Uint8Array,
  options: { name: string; source: AttachmentSource; type?: string },
): Promise<Attachment> {
  const query = new URLSearchParams({ name: options.name, source: options.source });
  const { attachment } = await requestJson<{ attachment: Attachment }>(`${collectionUrl(baseUrl, target)}?${query}`, {
    method: 'POST',
    body: file as BodyInit,
    headers: { 'content-type': options.type || ('type' in file ? file.type : '') || 'application/octet-stream' },
  });
  return attachment;
}

export async function deleteAttachment(baseUrl: string, id: string): Promise<void> {
  await requestJson(`${baseUrl}/web/factory/attachments/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function attachmentContentUrl(baseUrl: string, attachment: Pick<Attachment, 'contentUrl'>, download = false) {
  return `${baseUrl}${attachment.contentUrl}${download ? '?download' : ''}`;
}

const UNITS = ['B', 'KB', 'MB', 'GB'];

export function formatAttachmentSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${UNITS[unit]}`;
}

/**
 * The lines a sent message carries for its attachments. The «Вкладення:» marker is fixed (not
 * translated): the agents' skills look for it and call `factory_list_attachments`.
 */
export function attachmentMessageLines(attachments: readonly Attachment[]): string {
  return attachments
    .map(attachment => `Вкладення: ${attachment.name} (${formatAttachmentSize(attachment.size)}) → ${attachment.sandboxPath}`)
    .join('\n');
}

/** A base64 payload (a composer image) back as bytes for upload. */
export function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
