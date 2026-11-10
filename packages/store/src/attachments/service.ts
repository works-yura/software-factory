/**
 * The one way files become attachments, whatever brought them: the upload routes (chat, comments,
 * the card's «Файли»), and later the tracker / code-host syncs (ClickUp, GitHub, GitLab), which call
 * `ingest` with their `source` and the file's `sourceUrl`.
 */

import type { AttachmentRecord, AttachmentSource, AttachmentsStorage } from './base.ts';
import { cleanAttachmentName } from './base.ts';
import type { AttachmentBlobBody, AttachmentBlobStore } from './blob-store.ts';
import { resolveAttachmentMime } from './mime.ts';

/** Default per-file limit: 50 MiB. */
export const DEFAULT_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
const SNIFF_BYTES = 16;

export type AttachmentOwner =
  | { workItemId: string; factoryProjectId: string; sessionId?: never }
  | { sessionId: string; factoryProjectId: string | null; workItemId?: never };

export interface IngestAttachmentInput {
  orgId: string;
  owner: AttachmentOwner;
  name: string;
  /** The type the sender declared, if any; the content's signature wins over it. */
  declaredMime?: string | null;
  body: AttachmentBlobBody;
  source: AttachmentSource;
  sourceUrl?: string | null;
  addedBy: string;
}

/** Where an attachment is placed in a session's sandbox, relative to the session's working folder. */
export function attachmentSandboxPath(record: Pick<AttachmentRecord, 'id' | 'name'>): string {
  return `.factory/attachments/${record.id.slice(0, 8)}-${cleanAttachmentName(record.name)}`;
}

/** Pass the stream through while keeping its first bytes, for sniffing the type. */
function capturingHead(body: AttachmentBlobBody): { body: AsyncIterable<Uint8Array>; head: () => Uint8Array } {
  let head = new Uint8Array(0);
  async function* pass(): AsyncIterable<Uint8Array> {
    const source: Iterable<Uint8Array> | AsyncIterable<Uint8Array> =
      body instanceof Uint8Array ? [body] : (body as AsyncIterable<Uint8Array>);
    for await (const chunk of source) {
      if (head.length < SNIFF_BYTES) {
        const merged = new Uint8Array(Math.min(SNIFF_BYTES, head.length + chunk.length));
        merged.set(head);
        merged.set(chunk.subarray(0, merged.length - head.length), head.length);
        head = merged;
      }
      yield chunk;
    }
  }
  return { body: pass(), head: () => head };
}

export class AttachmentService {
  readonly records: AttachmentsStorage;
  readonly blobs: AttachmentBlobStore;
  readonly maxBytes: number;

  constructor(options: { records: AttachmentsStorage; blobs: AttachmentBlobStore; maxBytes?: number }) {
    const maxBytes = options.maxBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error(`Attachment size limit must be a positive integer of bytes, got ${maxBytes}.`);
    }
    this.records = options.records;
    this.blobs = options.blobs;
    this.maxBytes = maxBytes;
  }

  /** Stores the bytes (rejecting past `maxBytes`) and records the attachment. */
  async ingest(input: IngestAttachmentInput): Promise<AttachmentRecord> {
    const name = cleanAttachmentName(input.name);
    const captured = capturingHead(input.body);
    const blob = await this.blobs.put(captured.body, { maxBytes: this.maxBytes });
    const mime = resolveAttachmentMime({ head: captured.head(), declared: input.declaredMime ?? null, name });
    await this.records.ensureReady();
    try {
      return await this.records.create({
        orgId: input.orgId,
        factoryProjectId: input.owner.factoryProjectId,
        workItemId: input.owner.workItemId ?? null,
        sessionId: input.owner.sessionId ?? null,
        name,
        mime,
        size: blob.size,
        sha256: blob.sha256,
        source: input.source,
        sourceUrl: input.sourceUrl ?? null,
        addedBy: input.addedBy,
      });
    } catch (error) {
      await this.#dropBlobIfUnreferenced(blob.sha256);
      throw error;
    }
  }

  /** The record and its content, or `null` when either is gone. */
  async open(scope: { orgId: string; id: string }): Promise<{ record: AttachmentRecord; content: ReadableStream<Uint8Array> } | null> {
    await this.records.ensureReady();
    const record = await this.records.get(scope);
    if (!record) return null;
    const content = await this.blobs.get(record.sha256);
    if (!content) throw new Error(`Attachment ${record.id} has no stored content (blob ${record.sha256} is missing).`);
    return { record, content };
  }

  /** Removes the record, and its bytes once no other record shares them. */
  async remove(scope: { orgId: string; id: string }): Promise<AttachmentRecord | null> {
    await this.records.ensureReady();
    const removed = await this.records.delete(scope);
    if (removed) await this.#dropBlobIfUnreferenced(removed.sha256);
    return removed;
  }

  async #dropBlobIfUnreferenced(sha256: string): Promise<void> {
    if (!(await this.records.isBlobReferenced(sha256))) await this.blobs.delete(sha256);
  }
}
