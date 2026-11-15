/**
 * The `assistant_*` tables (ADR-0051). Every row carries its owner (`owner_org_id`,
 * `owner_user_id`) and every read and delete is scoped by both: no method takes one half, and an
 * owner with an empty half is refused before a query runs (`assertOwner`), so a delete can never
 * widen past one person in one organization.
 */
import { FactoryStorageDomain, UniqueViolationError } from '@mastra/core/storage';
import type { CollectionSchema, CollectionWhere } from '@mastra/core/storage';

import type {
  AssistantFile,
  AssistantMessage,
  AssistantNote,
  AssistantOwner,
  AssistantRequest,
  AssistantSettings,
  FactoryLink,
  MessageAuthor,
  RequestSource,
  RequestStatus,
} from './types.ts';
import { assertOwner, DEFAULT_RETENTION_DAYS } from './types.ts';

export const ASSISTANT_REQUESTS = 'assistant_requests';
export const ASSISTANT_MESSAGES = 'assistant_messages';
export const ASSISTANT_NOTES = 'assistant_notes';
export const ASSISTANT_SETTINGS = 'assistant_settings';
export const ASSISTANT_FILES = 'assistant_files';
export const ASSISTANT_FACTORY_GRANTS = 'assistant_factory_grants';

const owner = { owner_org_id: { type: 'text' }, owner_user_id: { type: 'text' } } as const;

export const ASSISTANT_SCHEMAS: CollectionSchema[] = [
  {
    name: ASSISTANT_REQUESTS,
    columns: {
      id: { type: 'uuid-pk' },
      ...owner,
      topic: { type: 'text' },
      from_name: { type: 'text', nullable: true },
      source: { type: 'text' },
      source_url: { type: 'text', nullable: true },
      status: { type: 'text' },
      factory: { type: 'json', nullable: true },
      analysing: { type: 'boolean' },
      last_error: { type: 'text', nullable: true },
      unread: { type: 'boolean' },
      created_at: { type: 'timestamp' },
      updated_at: { type: 'timestamp' },
      closed_at: { type: 'timestamp', nullable: true },
    },
    indexes: [
      { name: 'assistant_requests_owner_idx', columns: ['owner_org_id', 'owner_user_id', 'updated_at'] },
      { name: 'assistant_requests_status_idx', columns: ['status'] },
    ],
  },
  {
    name: ASSISTANT_MESSAGES,
    columns: {
      id: { type: 'uuid-pk' },
      ...owner,
      request_id: { type: 'text' },
      // The entry's place in its thread: timestamps tie within a millisecond.
      seq: { type: 'integer' },
      author: { type: 'text' },
      text: { type: 'text' },
      file_ids: { type: 'json' },
      created_at: { type: 'timestamp' },
    },
    indexes: [{ name: 'assistant_messages_request_idx', columns: ['owner_org_id', 'owner_user_id', 'request_id'] }],
  },
  {
    name: ASSISTANT_NOTES,
    columns: {
      id: { type: 'uuid-pk' },
      ...owner,
      request_id: { type: 'text', nullable: true },
      text: { type: 'text' },
      author: { type: 'text' },
      created_at: { type: 'timestamp' },
      updated_at: { type: 'timestamp' },
    },
    indexes: [{ name: 'assistant_notes_owner_idx', columns: ['owner_org_id', 'owner_user_id'] }],
  },
  {
    name: ASSISTANT_SETTINGS,
    columns: {
      id: { type: 'uuid-pk' },
      ...owner,
      model_id: { type: 'text', nullable: true },
      retention_days: { type: 'integer' },
      created_at: { type: 'timestamp' },
      updated_at: { type: 'timestamp' },
    },
    uniqueIndexes: [{ name: 'assistant_settings_owner_key', columns: ['owner_org_id', 'owner_user_id'] }],
  },
  {
    name: ASSISTANT_FILES,
    columns: {
      id: { type: 'uuid-pk' },
      ...owner,
      request_id: { type: 'text' },
      name: { type: 'text' },
      mime: { type: 'text' },
      size: { type: 'bigint' },
      sha256: { type: 'text' },
      created_at: { type: 'timestamp' },
    },
    indexes: [
      { name: 'assistant_files_request_idx', columns: ['owner_org_id', 'owner_user_id', 'request_id'] },
      { name: 'assistant_files_sha256_idx', columns: ['sha256'] },
    ],
  },
  {
    // The person's OAuth grant to Factory's MCP: the client id and, encrypted, the tokens (or the
    // PKCE verifier while the person is on the consent page).
    name: ASSISTANT_FACTORY_GRANTS,
    columns: {
      id: { type: 'uuid-pk' },
      ...owner,
      client_id: { type: 'text' },
      status: { type: 'text' },
      secret: { type: 'text' },
      created_at: { type: 'timestamp' },
      updated_at: { type: 'timestamp' },
    },
    uniqueIndexes: [{ name: 'assistant_factory_grants_owner_key', columns: ['owner_org_id', 'owner_user_id'] }],
  },
];

/** Every table an owner has rows in, in the order cleanup erases them (files last: their bytes follow). */
export const OWNER_TABLES = [
  ASSISTANT_MESSAGES,
  ASSISTANT_REQUESTS,
  ASSISTANT_NOTES,
  ASSISTANT_SETTINGS,
  ASSISTANT_FACTORY_GRANTS,
] as const;

function ownerWhere(o: AssistantOwner): CollectionWhere {
  assertOwner(o);
  return { owner_org_id: o.orgId, owner_user_id: o.userId };
}

interface RequestRow extends Record<string, unknown> {
  id: string;
  owner_org_id: string;
  owner_user_id: string;
  topic: string;
  from_name: string | null;
  source: string;
  source_url: string | null;
  status: string;
  factory: FactoryLink | null;
  analysing: boolean;
  last_error: string | null;
  unread: boolean;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
}

interface MessageRow extends Record<string, unknown> {
  id: string;
  request_id: string;
  seq: number;
  author: string;
  text: string;
  file_ids: string[];
  created_at: Date;
}

interface NoteRow extends Record<string, unknown> {
  id: string;
  owner_org_id: string;
  owner_user_id: string;
  request_id: string | null;
  text: string;
  author: string;
  created_at: Date;
  updated_at: Date;
}

interface SettingsRow extends Record<string, unknown> {
  owner_org_id: string;
  owner_user_id: string;
  model_id: string | null;
  retention_days: number;
}

interface FileRow extends Record<string, unknown> {
  id: string;
  owner_org_id: string;
  owner_user_id: string;
  request_id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  created_at: Date;
}

export interface GrantRow extends Record<string, unknown> {
  owner_org_id: string;
  owner_user_id: string;
  client_id: string;
  status: 'pending' | 'granted';
  secret: string;
  updated_at: Date;
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function toRequest(row: RequestRow): AssistantRequest {
  return {
    id: row.id,
    owner: { orgId: row.owner_org_id, userId: row.owner_user_id },
    topic: row.topic,
    fromName: row.from_name,
    source: row.source as RequestSource,
    sourceUrl: row.source_url,
    status: row.status as RequestStatus,
    factory: row.factory ?? null,
    analysing: bool(row.analysing),
    lastError: row.last_error,
    unread: bool(row.unread),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

function toMessage(row: MessageRow): AssistantMessage {
  return {
    id: row.id,
    requestId: row.request_id,
    author: row.author as MessageAuthor,
    text: row.text,
    fileIds: Array.isArray(row.file_ids) ? row.file_ids : [],
    createdAt: row.created_at,
  };
}

function toNote(row: NoteRow): AssistantNote {
  return {
    id: row.id,
    owner: { orgId: row.owner_org_id, userId: row.owner_user_id },
    requestId: row.request_id,
    text: row.text,
    author: row.author === 'agent' ? 'agent' : 'person',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toFile(row: FileRow): AssistantFile {
  return {
    id: row.id,
    owner: { orgId: row.owner_org_id, userId: row.owner_user_id },
    requestId: row.request_id,
    name: row.name,
    mime: row.mime,
    size: Number(row.size),
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

export interface RequestPatch {
  topic?: string;
  status?: RequestStatus;
  factory?: FactoryLink | null;
  analysing?: boolean;
  lastError?: string | null;
  unread?: boolean;
  closedAt?: Date | null;
}

export class AssistantStorage extends FactoryStorageDomain {
  constructor() {
    super('assistant');
  }

  async init(): Promise<void> {
    await this.ensureCollections(ASSISTANT_SCHEMAS);
  }

  async dangerouslyClearAll(): Promise<void> {
    for (const schema of ASSISTANT_SCHEMAS) await this.ops.deleteMany(schema.name, {});
  }

  // Requests

  async createRequest(
    o: AssistantOwner,
    input: { topic: string; fromName: string | null; source: RequestSource; sourceUrl: string | null; now?: Date },
  ): Promise<AssistantRequest> {
    const now = input.now ?? new Date();
    const row = await this.ops.insertOne<RequestRow>(ASSISTANT_REQUESTS, {
      ...ownerWhere(o),
      topic: input.topic,
      from_name: input.fromName,
      source: input.source,
      source_url: input.sourceUrl,
      status: 'new',
      factory: null,
      analysing: false,
      last_error: null,
      unread: false,
      created_at: now,
      updated_at: now,
      closed_at: null,
    } as Partial<RequestRow>);
    return toRequest(row);
  }

  async getRequest(o: AssistantOwner, id: string): Promise<AssistantRequest | null> {
    const row = await this.ops.findOne<RequestRow>(ASSISTANT_REQUESTS, { ...ownerWhere(o), id });
    return row ? toRequest(row) : null;
  }

  /** The owner's requests, the latest activity first. */
  async listRequests(o: AssistantOwner): Promise<AssistantRequest[]> {
    const rows = await this.ops.findMany<RequestRow>(ASSISTANT_REQUESTS, ownerWhere(o), {
      orderBy: [
        ['updated_at', 'desc'],
        ['id', 'asc'],
      ],
    });
    return rows.map(toRequest);
  }

  async updateRequest(o: AssistantOwner, id: string, patch: RequestPatch, now = new Date()): Promise<AssistantRequest | null> {
    const set: Partial<RequestRow> = { updated_at: now };
    if (patch.topic !== undefined) set.topic = patch.topic;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.factory !== undefined) set.factory = patch.factory;
    if (patch.analysing !== undefined) set.analysing = patch.analysing;
    if (patch.lastError !== undefined) set.last_error = patch.lastError;
    if (patch.unread !== undefined) set.unread = patch.unread;
    if (patch.closedAt !== undefined) set.closed_at = patch.closedAt;
    const row = await this.ops.updateAtomic<RequestRow>(ASSISTANT_REQUESTS, { ...ownerWhere(o), id }, () => set);
    return row ? toRequest(row) : null;
  }

  /** Every closed request, of every owner, for the retention sweep. */
  async listClosedRequests(): Promise<AssistantRequest[]> {
    const rows = await this.ops.findMany<RequestRow>(ASSISTANT_REQUESTS, { status: 'closed' });
    return rows.map(toRequest);
  }

  /** Removes one request and its thread; its files are left to the caller (their bytes need a refcount). */
  async deleteRequest(o: AssistantOwner, id: string): Promise<void> {
    const where = ownerWhere(o);
    await this.ops.deleteMany(ASSISTANT_MESSAGES, { ...where, request_id: id });
    await this.ops.deleteMany(ASSISTANT_NOTES, { ...where, request_id: id });
    await this.ops.deleteMany(ASSISTANT_REQUESTS, { ...where, id });
  }

  // Thread

  async addMessage(
    o: AssistantOwner,
    input: { requestId: string; author: MessageAuthor; text: string; fileIds?: string[]; now?: Date },
  ): Promise<AssistantMessage> {
    const [last] = await this.ops.findMany<MessageRow>(
      ASSISTANT_MESSAGES,
      { ...ownerWhere(o), request_id: input.requestId },
      { orderBy: [['seq', 'desc']], limit: 1 },
    );
    const row = await this.ops.insertOne<MessageRow>(ASSISTANT_MESSAGES, {
      ...ownerWhere(o),
      request_id: input.requestId,
      seq: (last ? Number(last.seq) : 0) + 1,
      author: input.author,
      text: input.text,
      file_ids: input.fileIds ?? [],
      created_at: input.now ?? new Date(),
    } as Partial<MessageRow>);
    return toMessage(row);
  }

  async listMessages(o: AssistantOwner, requestId: string): Promise<AssistantMessage[]> {
    const rows = await this.ops.findMany<MessageRow>(
      ASSISTANT_MESSAGES,
      { ...ownerWhere(o), request_id: requestId },
      { orderBy: [['seq', 'asc']] },
    );
    return rows.map(toMessage);
  }

  // Notes

  async createNote(
    o: AssistantOwner,
    input: { text: string; requestId: string | null; author: 'person' | 'agent'; now?: Date },
  ): Promise<AssistantNote> {
    const now = input.now ?? new Date();
    const row = await this.ops.insertOne<NoteRow>(ASSISTANT_NOTES, {
      ...ownerWhere(o),
      request_id: input.requestId,
      text: input.text,
      author: input.author,
      created_at: now,
      updated_at: now,
    } as Partial<NoteRow>);
    return toNote(row);
  }

  async listNotes(o: AssistantOwner): Promise<AssistantNote[]> {
    const rows = await this.ops.findMany<NoteRow>(ASSISTANT_NOTES, ownerWhere(o), {
      orderBy: [
        ['updated_at', 'desc'],
        ['id', 'asc'],
      ],
    });
    return rows.map(toNote);
  }

  async updateNote(o: AssistantOwner, id: string, text: string, now = new Date()): Promise<AssistantNote | null> {
    const row = await this.ops.updateAtomic<NoteRow>(ASSISTANT_NOTES, { ...ownerWhere(o), id }, () => ({ text, updated_at: now }));
    return row ? toNote(row) : null;
  }

  async deleteNote(o: AssistantOwner, id: string): Promise<boolean> {
    return (await this.ops.deleteMany(ASSISTANT_NOTES, { ...ownerWhere(o), id })) > 0;
  }

  // Settings

  async getSettings(o: AssistantOwner): Promise<AssistantSettings> {
    const row = await this.ops.findOne<SettingsRow>(ASSISTANT_SETTINGS, ownerWhere(o));
    return row
      ? { modelId: row.model_id, retentionDays: Number(row.retention_days) }
      : { modelId: null, retentionDays: DEFAULT_RETENTION_DAYS };
  }

  async patchSettings(o: AssistantOwner, patch: Partial<AssistantSettings>, now = new Date()): Promise<AssistantSettings> {
    const where = ownerWhere(o);
    const set: Partial<SettingsRow> = { updated_at: now } as Partial<SettingsRow>;
    if (patch.modelId !== undefined) set.model_id = patch.modelId;
    if (patch.retentionDays !== undefined) set.retention_days = patch.retentionDays;
    const update = () => this.ops.updateAtomic<SettingsRow>(ASSISTANT_SETTINGS, where, () => set);
    if (!(await update())) {
      try {
        await this.ops.insertOne<SettingsRow>(ASSISTANT_SETTINGS, {
          ...where,
          model_id: null,
          retention_days: DEFAULT_RETENTION_DAYS,
          created_at: now,
          ...set,
        } as Partial<SettingsRow>);
      } catch (error) {
        if (!(error instanceof UniqueViolationError)) throw error;
        await update();
      }
    }
    return this.getSettings(o);
  }

  // Files

  async createFile(
    o: AssistantOwner,
    input: { requestId: string; name: string; mime: string; size: number; sha256: string; now?: Date },
  ): Promise<AssistantFile> {
    const row = await this.ops.insertOne<FileRow>(ASSISTANT_FILES, {
      ...ownerWhere(o),
      request_id: input.requestId,
      name: input.name,
      mime: input.mime,
      size: input.size,
      sha256: input.sha256,
      created_at: input.now ?? new Date(),
    } as Partial<FileRow>);
    return toFile(row);
  }

  async getFile(o: AssistantOwner, id: string): Promise<AssistantFile | null> {
    const row = await this.ops.findOne<FileRow>(ASSISTANT_FILES, { ...ownerWhere(o), id });
    return row ? toFile(row) : null;
  }

  async listFiles(o: AssistantOwner, requestId?: string): Promise<AssistantFile[]> {
    const rows = await this.ops.findMany<FileRow>(
      ASSISTANT_FILES,
      requestId === undefined ? ownerWhere(o) : { ...ownerWhere(o), request_id: requestId },
      { orderBy: [['created_at', 'asc'], ['id', 'asc']] },
    );
    return rows.map(toFile);
  }

  async deleteFile(o: AssistantOwner, id: string): Promise<void> {
    await this.ops.deleteMany(ASSISTANT_FILES, { ...ownerWhere(o), id });
  }

  /** Whether any assistant file (of anyone) still names these bytes. */
  async isBlobReferenced(sha256: string): Promise<boolean> {
    return (await this.ops.findOne(ASSISTANT_FILES, { sha256 })) !== null;
  }

  // OAuth grant to Factory's MCP

  async getGrant(o: AssistantOwner): Promise<GrantRow | null> {
    return this.ops.findOne<GrantRow>(ASSISTANT_FACTORY_GRANTS, ownerWhere(o));
  }

  async putGrant(o: AssistantOwner, input: { clientId: string; status: 'pending' | 'granted'; secret: string }, now = new Date()) {
    const where = ownerWhere(o);
    const set = { client_id: input.clientId, status: input.status, secret: input.secret, updated_at: now };
    const updated = await this.ops.updateAtomic<GrantRow>(ASSISTANT_FACTORY_GRANTS, where, () => set);
    if (updated) return;
    try {
      await this.ops.insertOne<GrantRow>(ASSISTANT_FACTORY_GRANTS, { ...where, ...set, created_at: now } as Partial<GrantRow>);
    } catch (error) {
      if (!(error instanceof UniqueViolationError)) throw error;
      await this.ops.updateAtomic<GrantRow>(ASSISTANT_FACTORY_GRANTS, where, () => set);
    }
  }

  async deleteGrant(o: AssistantOwner): Promise<void> {
    await this.ops.deleteMany(ASSISTANT_FACTORY_GRANTS, ownerWhere(o));
  }

  // Cleanup

  /** Every table but the files, for one owner. */
  async deleteOwnerRows(o: AssistantOwner): Promise<void> {
    const where = ownerWhere(o);
    for (const table of OWNER_TABLES) await this.ops.deleteMany(table, where);
  }

  /** The organizations a person has any assistant data in (for erasing a deleted account). */
  async organizationsOf(userId: string): Promise<string[]> {
    if (!userId?.trim()) throw new Error('A user id is required.');
    const orgs = new Set<string>();
    for (const table of [...OWNER_TABLES, ASSISTANT_FILES]) {
      const rows = await this.ops.findMany<{ owner_org_id: string }>(table, { owner_user_id: userId });
      for (const row of rows) orgs.add(row.owner_org_id);
    }
    return [...orgs];
  }
}
