import { FactoryStorageDomain } from '@mastra/core/storage';
import type { CollectionSchema } from '@mastra/core/storage';

/**
 * Where an attachment came from. `chat` and `comment` are uploaded in the Factory; the others are
 * the ingest seam for files synced from a tracker or code host (ClickUp, GitHub, GitLab), which
 * record the file's origin in `sourceUrl`.
 */
export const ATTACHMENT_SOURCES = ['chat', 'comment', 'upload', 'clickup', 'github', 'gitlab', 'agent'] as const;
export type AttachmentSource = (typeof ATTACHMENT_SOURCES)[number];

/**
 * A file attached to a card — or, for a session that works no card, to the session. Exactly one of
 * `workItemId` and `sessionId` is set. The bytes live in the `AttachmentBlobStore` under `sha256`;
 * several records may share one blob.
 */
export interface AttachmentRecord {
  id: string;
  orgId: string;
  factoryProjectId: string | null;
  workItemId: string | null;
  sessionId: string | null;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  source: AttachmentSource;
  sourceUrl: string | null;
  addedBy: string;
  addedAt: Date;
}

export type CreateAttachmentInput = Omit<AttachmentRecord, 'id' | 'addedAt'> & { addedAt?: Date };

export const ATTACHMENTS_SCHEMA: CollectionSchema = {
  name: 'factory_attachments',
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    factory_project_id: { type: 'text', nullable: true },
    work_item_id: { type: 'text', nullable: true },
    session_id: { type: 'text', nullable: true },
    name: { type: 'text' },
    mime: { type: 'text' },
    size: { type: 'bigint' },
    sha256: { type: 'text' },
    source: { type: 'text' },
    source_url: { type: 'text', nullable: true },
    added_by: { type: 'text' },
    added_at: { type: 'timestamp' },
  },
  indexes: [
    { name: 'factory_attachments_work_item_idx', columns: ['org_id', 'work_item_id'] },
    { name: 'factory_attachments_session_idx', columns: ['org_id', 'session_id'] },
    { name: 'factory_attachments_sha256_idx', columns: ['sha256'] },
  ],
};

interface AttachmentDbRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  factory_project_id: string | null;
  work_item_id: string | null;
  session_id: string | null;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  source: string;
  source_url: string | null;
  added_by: string;
  added_at: Date;
}

function toRecord(row: AttachmentDbRow): AttachmentRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    factoryProjectId: row.factory_project_id,
    workItemId: row.work_item_id,
    sessionId: row.session_id,
    name: row.name,
    mime: row.mime,
    size: Number(row.size),
    sha256: row.sha256,
    source: row.source as AttachmentSource,
    sourceUrl: row.source_url,
    addedBy: row.added_by,
    addedAt: row.added_at,
  };
}

/** Longest file name kept; longer names are cut, keeping the extension. */
export const MAX_ATTACHMENT_NAME = 200;

/**
 * A display name safe to store and to use as the last segment of a path: no directories, no
 * control characters, never empty or a dot name.
 */
export function cleanAttachmentName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  let name = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name || name === '.' || name === '..') name = 'file';
  if (name.length > MAX_ATTACHMENT_NAME) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    name = name.slice(0, MAX_ATTACHMENT_NAME - ext.length) + ext;
  }
  return name;
}

export class AttachmentsStorage extends FactoryStorageDomain {
  constructor() {
    super('attachments');
  }

  async init(): Promise<void> {
    await this.ensureCollections([ATTACHMENTS_SCHEMA]);
  }

  async dangerouslyClearAll(): Promise<void> {
    await this.ops.deleteMany(ATTACHMENTS_SCHEMA.name, {});
  }

  async create(input: CreateAttachmentInput): Promise<AttachmentRecord> {
    if ((input.workItemId === null) === (input.sessionId === null)) {
      throw new Error('An attachment belongs to exactly one card or one session.');
    }
    if (!(ATTACHMENT_SOURCES as readonly string[]).includes(input.source)) {
      throw new Error(`Unknown attachment source: ${input.source}`);
    }
    const row = await this.ops.insertOne<AttachmentDbRow>(ATTACHMENTS_SCHEMA.name, {
      org_id: input.orgId,
      factory_project_id: input.factoryProjectId,
      work_item_id: input.workItemId,
      session_id: input.sessionId,
      name: cleanAttachmentName(input.name),
      mime: input.mime,
      size: input.size,
      sha256: input.sha256,
      source: input.source,
      source_url: input.sourceUrl,
      added_by: input.addedBy,
      added_at: input.addedAt ?? new Date(),
    });
    return toRecord(row);
  }

  async get({ orgId, id }: { orgId: string; id: string }): Promise<AttachmentRecord | null> {
    const row = await this.ops.findOne<AttachmentDbRow>(ATTACHMENTS_SCHEMA.name, { org_id: orgId, id });
    return row ? toRecord(row) : null;
  }

  /** A card's attachments, oldest first. */
  async listForWorkItem({ orgId, workItemId }: { orgId: string; workItemId: string }): Promise<AttachmentRecord[]> {
    const rows = await this.ops.findMany<AttachmentDbRow>(
      ATTACHMENTS_SCHEMA.name,
      { org_id: orgId, work_item_id: workItemId },
      { orderBy: [['added_at', 'asc'], ['id', 'asc']] },
    );
    return rows.map(toRecord);
  }

  /** The attachments a session holds of its own (it works no card), oldest first. */
  async listForSession({ orgId, sessionId }: { orgId: string; sessionId: string }): Promise<AttachmentRecord[]> {
    const rows = await this.ops.findMany<AttachmentDbRow>(
      ATTACHMENTS_SCHEMA.name,
      { org_id: orgId, session_id: sessionId },
      { orderBy: [['added_at', 'asc'], ['id', 'asc']] },
    );
    return rows.map(toRecord);
  }

  /** The removed record, or `null` when there was none. */
  async delete({ orgId, id }: { orgId: string; id: string }): Promise<AttachmentRecord | null> {
    const existing = await this.get({ orgId, id });
    if (!existing) return null;
    await this.ops.deleteMany(ATTACHMENTS_SCHEMA.name, { org_id: orgId, id });
    return existing;
  }

  /** Whether any record (in any org) still points at this blob; its bytes may go once none does. */
  async isBlobReferenced(sha256: string): Promise<boolean> {
    return (await this.ops.findOne(ATTACHMENTS_SCHEMA.name, { sha256 })) !== null;
  }
}
