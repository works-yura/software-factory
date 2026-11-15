/**
 * The assistant's lifecycle (ADR-0051): requests the person brings, the agent's turns, asking
 * and handing over to a Factory, notes, settings, and erasing it all.
 *
 * Every method takes the owner first and reads only that owner's rows: another person's (or the
 * same person's in another organization) request is simply not found.
 */
import { rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { AssistantError } from './errors.ts';
import type { IncomingFile } from './files.ts';
import { ASSISTANT_FILE_MAX_BYTES, ASSISTANT_MAX_FILES_PER_MESSAGE, cleanFileName, sniffMime } from './files.ts';
import type {
  AssistantAudit,
  AssistantBlobStore,
  AssistantBrain,
  AssistantMemory,
  AssistantModels,
  AssistantSource,
  BrainFile,
  BrainTurn,
  FactoryClient,
  FactoryGrant,
  IngestOutcome,
  RequestView,
  SourceMessage,
} from './ports.ts';
import type { AssistantStorage, RequestPatch } from './storage.ts';
import type {
  AssistantClearReason,
  AssistantFile,
  AssistantNote,
  AssistantOwner,
  AssistantRequest,
  AssistantSettings,
  RequestStatus,
} from './types.ts';
import { assertOwner, MAX_RETENTION_DAYS, MIN_RETENTION_DAYS } from './types.ts';

const notFound = () => new AssistantError('not_found', 'Request not found.', 404);

const MAX_TEXT = 20_000;
const MAX_TOPIC = 120;
const MAX_NOTE = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AssistantServiceDeps {
  storage: AssistantStorage;
  /** Absent when the server has no blob store: requests with files are refused, saying so. */
  blobs?: AssistantBlobStore;
  brain: AssistantBrain;
  memory: AssistantMemory;
  models: AssistantModels;
  factory: FactoryClient;
  grant: FactoryGrant;
  /** The person's own source connections (ClickUp Chat …): disconnected first when the assistant is erased. */
  sources?: AssistantSource[];
  audit: AssistantAudit;
  /** Whether bytes are still named by anything outside the assistant (Factory attachments, avatars). */
  blobReferencedElsewhere: (sha256: string) => Promise<boolean>;
  /**
   * Root of per-owner working folders (`<root>/<orgId>/<userId>`), erased with the assistant.
   * Phase 1 never writes one (the assistant runs no commands), so the server leaves it unset.
   */
  tempRoot?: string;
  maxFileBytes?: number;
  now?: () => Date;
  /** Runs an agent turn after the request answered; the default fires and forgets. Tests await it. */
  schedule?: (task: () => Promise<void>) => void;
}

/** The topic line's title: the first line of the text, or the first file's name. */
export function deriveTopic(text: string, files: Array<{ name: string }>): string {
  const line = text
    .split('\n')
    .map(part => part.trim())
    .find(Boolean);
  const topic = line ?? files[0]?.name ?? '';
  return topic.length > MAX_TOPIC ? `${topic.slice(0, MAX_TOPIC - 1)}…` : topic;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
    size += chunk.length;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AssistantService {
  readonly #deps: AssistantServiceDeps;
  readonly #now: () => Date;
  readonly #schedule: (task: () => Promise<void>) => void;
  /** Turns of one request run one after another; the count says when the last one is done. */
  readonly #turns = new Map<string, { tail: Promise<void>; pending: number }>();

  constructor(deps: AssistantServiceDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
    this.#schedule =
      deps.schedule ??
      (task => {
        void task();
      });
  }

  get maxFileBytes(): number {
    return this.#deps.maxFileBytes ?? ASSISTANT_FILE_MAX_BYTES;
  }

  // Requests

  async listRequests(owner: AssistantOwner): Promise<AssistantRequest[]> {
    await this.#ready();
    return this.#deps.storage.listRequests(owner);
  }

  /** The request with its thread; opening it marks it read. */
  async openRequest(owner: AssistantOwner, id: string): Promise<RequestView> {
    await this.#ready();
    let request = await this.#require(owner, id);
    if (request.unread) request = (await this.#deps.storage.updateRequest(owner, id, { unread: false }, request.updatedAt)) ?? request;
    return {
      request,
      messages: await this.#deps.storage.listMessages(owner, id),
      files: await this.#deps.storage.listFiles(owner, id),
    };
  }

  /** A request the person brought: pasted text, screenshots, files, a forwarded snippet. */
  async createRequest(
    owner: AssistantOwner,
    input: { text: string; fromName?: string | null; sourceUrl?: string | null; files?: IncomingFile[] },
  ): Promise<AssistantRequest> {
    await this.#ready();
    const text = (input.text ?? '').trim();
    const files = input.files ?? [];
    this.#checkMessage(text, files);
    const sourceUrl = input.sourceUrl?.trim() || null;
    if (sourceUrl && !/^https?:\/\//i.test(sourceUrl)) {
      throw new AssistantError('invalid_source_url', 'The link to the original must be an http(s) URL.', 400);
    }
    const fromName = input.fromName?.trim().slice(0, 200) || null;
    const request = await this.#deps.storage.createRequest(owner, {
      topic: deriveTopic(text, files.map(file => ({ name: cleanFileName(file.name) }))),
      fromName,
      source: 'manual',
      sourceUrl,
      now: this.#now(),
    });
    const stored = await this.#storeFiles(owner, request.id, files);
    await this.#deps.storage.addMessage(owner, {
      requestId: request.id,
      author: 'person',
      text,
      fileIds: stored.map(file => file.id),
      now: this.#now(),
    });
    return this.#startTurn(owner, request, { author: 'person', text, files: stored });
  }

  /** The person writes to the agent in a request's thread. */
  async postMessage(owner: AssistantOwner, id: string, input: { text: string; files?: IncomingFile[] }): Promise<AssistantRequest> {
    await this.#ready();
    const request = await this.#require(owner, id);
    if (request.status === 'closed') throw new AssistantError('request_closed', 'This request is closed.', 409);
    if (request.analysing) throw new AssistantError('agent_busy', 'The assistant is still answering.', 409);
    const text = (input.text ?? '').trim();
    const files = input.files ?? [];
    this.#checkMessage(text, files);
    const stored = await this.#storeFiles(owner, id, files);
    await this.#deps.storage.addMessage(owner, {
      requestId: id,
      author: 'person',
      text,
      fileIds: stored.map(file => file.id),
      now: this.#now(),
    });
    return this.#startTurn(owner, request, { author: 'person', text, files: stored });
  }

  async close(owner: AssistantOwner, id: string): Promise<AssistantRequest> {
    await this.#ready();
    await this.#require(owner, id);
    const now = this.#now();
    const closed = await this.#deps.storage.updateRequest(owner, id, { status: 'closed', closedAt: now, unread: false }, now);
    if (!closed) throw notFound();
    return closed;
  }

  /**
   * The person's own edits from the thread header: a new topic, or a status they set by hand
   * (as in any inbox: back to «waiting for me», answered, closed, reopened).
   */
  async updateRequest(owner: AssistantOwner, id: string, input: { topic?: string; status?: RequestStatus }): Promise<AssistantRequest> {
    await this.#ready();
    const request = await this.#require(owner, id);
    const patch: RequestPatch = {};
    if (input.topic !== undefined) {
      const topic = input.topic.replace(/\s+/g, ' ').trim();
      if (!topic) throw new AssistantError('invalid_topic', 'The topic cannot be empty.', 400);
      patch.topic = topic.slice(0, MAX_TOPIC);
    }
    if (input.status !== undefined && input.status !== request.status) {
      const now = this.#now();
      patch.status = input.status;
      if (input.status === 'closed') Object.assign(patch, { closedAt: now, unread: false });
      else if (request.status === 'closed') patch.closedAt = null;
    }
    if (Object.keys(patch).length === 0) return request;
    const updated = await this.#deps.storage.updateRequest(owner, id, patch, this.#now());
    if (!updated) throw notFound();
    return updated;
  }

  // Sources

  /**
   * Takes in one message a source read (ADR-0051 phase 2). The request binding key is the source
   * thread: a message in a thread with an open request joins it; in a thread whose request was
   * closed it opens a new request that continues the previous one; otherwise it starts a new one.
   * The message's own source id makes this idempotent: a message taken in once is a no-op after.
   * The person's own messages only join an open request (as context, without an agent turn).
   */
  async ingestSourceMessage(
    owner: AssistantOwner,
    message: SourceMessage,
  ): Promise<{ outcome: IngestOutcome; request: AssistantRequest | null }> {
    await this.#ready();
    const { storage } = this.#deps;
    if (!message.sourceKey || !message.messageKey) throw new Error('A source message needs its thread key and its own key.');
    if (await storage.hasSourceMessage(owner, message.messageKey)) return { outcome: 'duplicate', request: null };

    const latest = await storage.latestRequestForSource(owner, message.sourceKey);
    const open = latest && latest.status !== 'closed' ? latest : null;
    if (message.fromMe && !open) return { outcome: 'skipped', request: null };

    // Claim the message before anything is written: a concurrent read of the same message stops here.
    if (!(await storage.recordSourceMessage(owner, { messageKey: message.messageKey, requestId: '', now: this.#now() }))) {
      return { outcome: 'duplicate', request: null };
    }
    try {
      const text = (message.text ?? '').trim().slice(0, MAX_TEXT);
      const files = this.#deps.blobs
        ? (message.files ?? [])
            .filter(file => file.bytes.byteLength <= this.maxFileBytes)
            .slice(0, ASSISTANT_MAX_FILES_PER_MESSAGE)
        : [];
      const fromName = message.fromName?.trim().slice(0, 200) || null;
      const sourceUrl = message.sourceUrl && /^https?:\/\//i.test(message.sourceUrl) ? message.sourceUrl : null;
      let request: AssistantRequest;
      let outcome: IngestOutcome;
      if (open) {
        request = open;
        outcome = 'appended';
      } else {
        request = await storage.createRequest(owner, {
          topic: deriveTopic(text, files.map(file => ({ name: cleanFileName(file.name) }))) || message.where || message.platform,
          fromName,
          source: message.platform,
          sourceUrl,
          sourceKey: message.sourceKey,
          previousRequestId: latest?.id ?? null,
          now: this.#now(),
        });
        outcome = latest ? 'reopened' : 'created';
        if (latest) {
          await storage.addMessage(owner, { requestId: request.id, author: 'event', text: `continues:${latest.id}`, now: this.#now() });
        }
      }
      await storage.bindSourceMessage(owner, message.messageKey, request.id);
      const stored = await this.#storeFiles(owner, request.id, files);
      await storage.addMessage(owner, {
        requestId: request.id,
        author: 'source',
        fromName,
        text,
        fileIds: stored.map(file => file.id),
        now: this.#now(),
      });
      if (message.fromMe) {
        return { outcome, request: (await storage.updateRequest(owner, request.id, {}, this.#now())) ?? request };
      }
      if (!message.analyse) {
        await storage.addMessage(owner, { requestId: request.id, author: 'event', text: 'not_analysed:limit', now: this.#now() });
        const waiting = await storage.updateRequest(owner, request.id, { status: 'waiting_me', unread: true }, this.#now());
        return { outcome, request: waiting ?? request };
      }
      const started = await this.#startTurn(owner, request, {
        author: 'source',
        text,
        files: stored,
        fromName,
        first: outcome !== 'appended',
        ...(message.where ? { where: message.where } : {}),
      });
      return { outcome, request: started };
    } catch (error) {
      await storage.forgetSourceMessage(owner, message.messageKey).catch(() => undefined);
      throw error;
    }
  }

  /** Whether a source thread has an open request (a follow-up there joins it whatever the channel's mode). */
  async hasOpenSourceRequest(owner: AssistantOwner, sourceKey: string): Promise<boolean> {
    await this.#ready();
    const latest = await this.#deps.storage.latestRequestForSource(owner, sourceKey);
    return latest !== null && latest.status !== 'closed';
  }

  // Factory

  /** Asks a Factory: a side session with the question; the request waits for Factory. */
  async askFactory(
    owner: AssistantOwner,
    id: string,
    input: { factoryId: string; question?: string },
  ): Promise<AssistantRequest> {
    await this.#ready();
    const request = await this.#require(owner, id);
    if (request.status === 'closed') throw new AssistantError('request_closed', 'This request is closed.', 409);
    const factory = await this.#factoryRef(owner, input.factoryId);
    const question = input.question?.trim() || (await this.#summary(owner, request));
    if (question.length > 8000) throw new AssistantError('question_too_long', 'The question is longer than 8000 characters.', 400);
    const asked = await this.#factoryCall(() =>
      this.#deps.factory.ask(owner, { factoryId: factory.id, question, title: request.topic.slice(0, 80) }),
    );
    await this.#deps.storage.addMessage(owner, {
      requestId: id,
      author: 'event',
      text: `asked:${factory.name}\n${question}`,
      now: this.#now(),
    });
    const updated = await this.#deps.storage.updateRequest(
      owner,
      id,
      {
        status: 'waiting_factory',
        factory: {
          factoryId: factory.id,
          factoryName: factory.name,
          sessionId: asked.sessionId,
          ...(asked.url ? { url: asked.url } : {}),
        },
      },
      this.#now(),
    );
    if (!updated) throw notFound();
    return updated;
  }

  /**
   * Looks for the Factory's answer to the question asked; once it is there, it goes into the
   * thread and the agent concludes from it for the person.
   */
  async checkFactoryAnswer(owner: AssistantOwner, id: string): Promise<{ answered: boolean; request: AssistantRequest }> {
    await this.#ready();
    const request = await this.#require(owner, id);
    const sessionId = request.factory?.sessionId;
    if (!request.factory || !sessionId) {
      throw new AssistantError('no_question', 'No Factory was asked in this request.', 409);
    }
    if (request.status !== 'waiting_factory') return { answered: false, request };
    const answer = await this.#factoryCall(() =>
      this.#deps.factory.readAnswer(owner, { factoryId: request.factory!.factoryId, sessionId }),
    );
    if (!answer.text) return { answered: false, request };
    await this.#deps.storage.addMessage(owner, { requestId: id, author: 'factory', text: answer.text, now: this.#now() });
    const started = await this.#startTurn(owner, request, { author: 'factory', text: answer.text, files: [] });
    return { answered: true, request: started };
  }

  /** Hands the request to a Factory as a card (its files attached, the original linked). */
  async handOver(owner: AssistantOwner, id: string, input: { factoryId: string; title?: string; note?: string }): Promise<AssistantRequest> {
    await this.#ready();
    const request = await this.#require(owner, id);
    if (request.status === 'closed') throw new AssistantError('request_closed', 'This request is closed.', 409);
    if (request.factory?.workItemId) {
      throw new AssistantError('already_handed_over', 'This request was already handed to a Factory.', 409);
    }
    const factory = await this.#factoryRef(owner, input.factoryId);
    const title = (input.title?.trim() || request.topic).slice(0, 512);
    const note = input.note?.trim() ?? '';
    if (note.length > 4000) throw new AssistantError('note_too_long', 'The note is longer than 4000 characters.', 400);
    const description = [note, await this.#summary(owner, request)].filter(Boolean).join('\n\n').slice(0, 8000);
    const files = await Promise.all(
      (await this.#deps.storage.listFiles(owner, id)).map(async file => ({
        name: file.name,
        mime: file.mime,
        bytes: await this.#bytes(file),
      })),
    );
    const handed = await this.#factoryCall(() =>
      this.#deps.factory.handOver(owner, { factoryId: factory.id, title, description, files }),
    );
    const failed = handed.failedFiles.map(file => `${file.name}: ${file.error}`);
    await this.#deps.storage.addMessage(owner, {
      requestId: id,
      author: 'event',
      text: [`handed:${factory.name}`, ...(note ? [note] : []), ...(failed.length ? ['files_failed', ...failed] : [])].join('\n'),
      now: this.#now(),
    });
    const updated = await this.#deps.storage.updateRequest(
      owner,
      id,
      {
        status: 'waiting_factory',
        factory: {
          factoryId: factory.id,
          factoryName: factory.name,
          workItemId: handed.workItemId,
          ...(handed.url ? { url: handed.url } : {}),
        },
      },
      this.#now(),
    );
    if (!updated) throw notFound();
    return updated;
  }

  async factoriesFor(owner: AssistantOwner) {
    if (!(await this.#deps.factory.connected(owner))) return { connected: false as const, factories: [] };
    return { connected: true as const, factories: await this.#factoryCall(() => this.#deps.factory.listFactories(owner)) };
  }

  // Notes

  async listNotes(owner: AssistantOwner): Promise<AssistantNote[]> {
    await this.#ready();
    return this.#deps.storage.listNotes(owner);
  }

  async createNote(owner: AssistantOwner, input: { text: string; requestId?: string | null }): Promise<AssistantNote> {
    await this.#ready();
    const text = this.#noteText(input.text);
    const requestId = input.requestId ?? null;
    if (requestId) await this.#require(owner, requestId);
    return this.#deps.storage.createNote(owner, { text, requestId, author: 'person', now: this.#now() });
  }

  async updateNote(owner: AssistantOwner, id: string, text: string): Promise<AssistantNote> {
    await this.#ready();
    const note = await this.#deps.storage.updateNote(owner, id, this.#noteText(text), this.#now());
    if (!note) throw new AssistantError('not_found', 'Note not found.', 404);
    return note;
  }

  async deleteNote(owner: AssistantOwner, id: string): Promise<void> {
    await this.#ready();
    if (!(await this.#deps.storage.deleteNote(owner, id))) throw new AssistantError('not_found', 'Note not found.', 404);
  }

  // Settings

  async getSettings(owner: AssistantOwner): Promise<AssistantSettings> {
    await this.#ready();
    return this.#deps.storage.getSettings(owner);
  }

  async patchSettings(owner: AssistantOwner, patch: { modelId?: string | null; retentionDays?: number }): Promise<AssistantSettings> {
    await this.#ready();
    if (patch.retentionDays !== undefined) {
      if (!Number.isInteger(patch.retentionDays) || patch.retentionDays < MIN_RETENTION_DAYS || patch.retentionDays > MAX_RETENTION_DAYS) {
        throw new AssistantError(
          'invalid_retention',
          `Keep closed requests between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS} days.`,
          400,
        );
      }
    }
    if (patch.modelId !== undefined && patch.modelId !== null) {
      const models = await this.#deps.models.list(owner);
      if (!models.some(model => model.id === patch.modelId)) {
        throw new AssistantError('unknown_model', `The organization has no model ${patch.modelId}.`, 400);
      }
    }
    return this.#deps.storage.patchSettings(owner, patch, this.#now());
  }

  // Files

  async openFile(owner: AssistantOwner, id: string): Promise<{ file: AssistantFile; content: ReadableStream<Uint8Array> }> {
    await this.#ready();
    const file = await this.#deps.storage.getFile(owner, id);
    if (!file) throw new AssistantError('not_found', 'File not found.', 404);
    const content = await this.#blobs().get(file.sha256);
    if (!content) throw new Error(`Assistant file ${file.id} has no stored content (blob ${file.sha256} is missing).`);
    return { file, content };
  }

  // Erasing

  /**
   * Erases an owner's assistant, in the ADR's order: the OAuth grant to Factory's MCP (and, from
   * phase 2, personal source connections) → the agent's Mastra memory → requests, threads, notes,
   * settings, secrets → file records and the bytes nothing else names → the working folder. Then
   * one audit entry, without content.
   */
  async clear(owner: AssistantOwner, input: { reason: AssistantClearReason; actorId: string }): Promise<{ requests: number; files: number }> {
    assertOwner(owner);
    await this.#ready();
    const { storage } = this.#deps;
    const requests = (await storage.listRequests(owner)).length;
    const files = await storage.listFiles(owner);

    await this.#deps.grant.revoke(owner);
    for (const source of this.#deps.sources ?? []) await source.disconnect(owner);
    await this.#deps.memory.forget(owner);
    await storage.deleteOwnerRows(owner);
    for (const file of files) await storage.deleteFile(owner, file.id);
    await this.#dropUnreferenced(files);
    await this.#removeTempFolder(owner);

    await this.#deps.audit({
      orgId: owner.orgId,
      userId: owner.userId,
      actorId: input.actorId,
      reason: input.reason,
      counts: { requests, files: files.length },
    });
    return { requests, files: files.length };
  }

  /** A deleted account: its assistant in every organization. */
  async clearUser(userId: string, input: { reason: AssistantClearReason; actorId: string }): Promise<number> {
    await this.#ready();
    const orgs = new Set(await this.#deps.storage.organizationsOf(userId));
    for (const source of this.#deps.sources ?? []) {
      for (const orgId of await source.organizationsOf(userId)) orgs.add(orgId);
    }
    for (const orgId of orgs) await this.clear({ orgId, userId }, input);
    return orgs.size;
  }

  /** The daily sweep: closed requests past their owner's retention, with their threads, files and memory. */
  async sweepRetention(): Promise<{ requests: number; files: number }> {
    await this.#ready();
    const now = this.#now().getTime();
    const settings = new Map<string, AssistantSettings>();
    let requests = 0;
    let files = 0;
    for (const request of await this.#deps.storage.listClosedRequests()) {
      const key = `${request.owner.orgId}\u0000${request.owner.userId}`;
      let owned = settings.get(key);
      if (!owned) {
        owned = await this.#deps.storage.getSettings(request.owner);
        settings.set(key, owned);
      }
      const closedAt = (request.closedAt ?? request.updatedAt).getTime();
      if (now - closedAt < owned.retentionDays * DAY_MS) continue;
      files += await this.#deleteRequest(request.owner, request.id);
      requests += 1;
    }
    return { requests, files };
  }

  // Internals

  async #ready(): Promise<void> {
    await this.#deps.storage.ensureReady();
  }

  async #require(owner: AssistantOwner, id: string): Promise<AssistantRequest> {
    if (typeof id !== 'string' || !id) throw notFound();
    const request = await this.#deps.storage.getRequest(owner, id);
    if (!request) throw notFound();
    return request;
  }

  #checkMessage(text: string, files: IncomingFile[]): void {
    if (!text && files.length === 0) throw new AssistantError('empty', 'Write something or attach a file.', 400);
    if (text.length > MAX_TEXT) throw new AssistantError('text_too_long', `The text is longer than ${MAX_TEXT} characters.`, 400);
    if (files.length > ASSISTANT_MAX_FILES_PER_MESSAGE) {
      throw new AssistantError('too_many_files', `Attach at most ${ASSISTANT_MAX_FILES_PER_MESSAGE} files at once.`, 400);
    }
    for (const file of files) {
      if (file.bytes.byteLength > this.maxFileBytes) {
        throw new AssistantError('file_too_large', `${cleanFileName(file.name)} is larger than the limit.`, 413);
      }
    }
    if (files.length > 0) this.#blobs();
  }

  #noteText(raw: string): string {
    const text = (raw ?? '').trim();
    if (!text) throw new AssistantError('empty', 'A note needs text.', 400);
    if (text.length > MAX_NOTE) throw new AssistantError('text_too_long', `A note is at most ${MAX_NOTE} characters.`, 400);
    return text;
  }

  #blobs(): AssistantBlobStore {
    if (!this.#deps.blobs) {
      throw new AssistantError('files_unavailable', 'This server has no file store configured, so files cannot be attached.', 503);
    }
    return this.#deps.blobs;
  }

  async #storeFiles(owner: AssistantOwner, requestId: string, files: IncomingFile[]): Promise<Array<AssistantFile & { bytes: Uint8Array }>> {
    const stored: Array<AssistantFile & { bytes: Uint8Array }> = [];
    for (const file of files) {
      const blob = await this.#blobs().put(file.bytes, { maxBytes: this.maxFileBytes });
      const record = await this.#deps.storage.createFile(owner, {
        requestId,
        name: cleanFileName(file.name),
        mime: sniffMime(file.bytes, file.declaredMime),
        size: blob.size,
        sha256: blob.sha256,
        now: this.#now(),
      });
      stored.push({ ...record, bytes: file.bytes });
    }
    return stored;
  }

  async #bytes(file: AssistantFile): Promise<Uint8Array> {
    const content = await this.#blobs().get(file.sha256);
    if (!content) throw new Error(`Assistant file ${file.id} has no stored content (blob ${file.sha256} is missing).`);
    return readAll(content);
  }

  /** Marks the request as being answered and runs the agent's turn after the caller is answered. */
  async #startTurn(
    owner: AssistantOwner,
    request: AssistantRequest,
    input: {
      author: 'person' | 'factory' | 'source';
      text: string;
      files: Array<AssistantFile & { bytes: Uint8Array }>;
      fromName?: string | null;
      first?: boolean;
      where?: string;
    },
  ): Promise<AssistantRequest> {
    const started = await this.#deps.storage.updateRequest(owner, request.id, { analysing: true, lastError: null }, this.#now());
    if (!started) throw notFound();
    const files: BrainFile[] = input.files.map(file => ({ name: file.name, mime: file.mime, bytes: file.bytes }));
    const turn: BrainTurn['input'] = {
      author: input.author,
      text: input.where && input.author === 'source' ? `(${input.where})\n${input.text}` : input.text,
      files,
      ...(input.fromName !== undefined ? { fromName: input.fromName } : {}),
    };
    // One turn of a request at a time: a follow-up that arrives while the agent answers waits for it.
    const key = `${owner.orgId}\u0000${owner.userId}\u0000${request.id}`;
    const chain = this.#turns.get(key) ?? { tail: Promise.resolve(), pending: 0 };
    chain.pending += 1;
    this.#turns.set(key, chain);
    const finish = () => {
      chain.pending -= 1;
      if (chain.pending === 0 && this.#turns.get(key) === chain) this.#turns.delete(key);
      return chain.pending === 0;
    };
    this.#schedule(() => {
      const run = chain.tail.then(() => this.#runTurn(owner, started, turn, Boolean(input.first), finish));
      chain.tail = run;
      return run;
    });
    return started;
  }

  async #runTurn(owner: AssistantOwner, request: AssistantRequest, input: BrainTurn['input'], first: boolean, finish: () => boolean) {
    try {
      const settings = await this.#deps.storage.getSettings(owner);
      const before = (await this.#deps.storage.getRequest(owner, request.id)) ?? request;
      const answer = await this.#deps.brain.respond({ owner, request: before, input, modelId: settings.modelId, first });
      await this.#deps.storage.addMessage(owner, { requestId: request.id, author: 'agent', text: answer.text, now: this.#now() });
      const last = finish();
      const current = await this.#deps.storage.getRequest(owner, request.id);
      if (!current) return;
      // A request a source made gets its topic from the agent's summary on the first turn.
      const topic = first && current.source !== 'manual' ? answer.topic?.trim().slice(0, MAX_TOPIC) : undefined;
      await this.#deps.storage.updateRequest(
        owner,
        request.id,
        {
          ...(last ? { analysing: false } : {}),
          unread: true,
          ...(topic ? { topic } : {}),
          // The agent reported: the person decides next. A closed request stays closed.
          ...(current.status === 'closed' ? {} : { status: 'waiting_me' as const }),
        },
        this.#now(),
      );
    } catch (error) {
      const last = finish();
      // Loud: the thread shows why, the log names the request (never its content).
      console.error(`[assistant] The agent's turn on request ${request.id} failed:`, errorText(error));
      await this.#deps.storage
        .updateRequest(
          owner,
          request.id,
          { ...(last ? { analysing: false } : {}), lastError: errorText(error), unread: true },
          this.#now(),
        )
        .catch(stored => console.error(`[assistant] Could not record the failure on request ${request.id}:`, stored));
    }
  }

  /** The request in words for a Factory: what was asked, by whom, the original link. */
  async #summary(owner: AssistantOwner, request: AssistantRequest): Promise<string> {
    const messages = await this.#deps.storage.listMessages(owner, request.id);
    const said = messages.filter(message => message.author === 'person' && message.text).map(message => message.text);
    const files = await this.#deps.storage.listFiles(owner, request.id);
    return [
      ...said,
      ...(request.fromName ? [`From: ${request.fromName}`] : []),
      ...(request.sourceUrl ? [`Original: ${request.sourceUrl}`] : []),
      ...(files.length ? [`Files: ${files.map(file => file.name).join(', ')}`] : []),
    ]
      .join('\n\n')
      .slice(0, 8000);
  }

  async #factoryRef(owner: AssistantOwner, factoryId: string) {
    if (!(await this.#deps.factory.connected(owner))) {
      throw new AssistantError(
        'factory_not_connected',
        'Allow the assistant to reach Factory first (Account › Помічник).',
        409,
      );
    }
    const factories = await this.#factoryCall(() => this.#deps.factory.listFactories(owner));
    const factory = factories.find(candidate => candidate.id === factoryId);
    if (!factory) throw new AssistantError('factory_not_found', 'That Factory is not one you can reach.', 404);
    return factory;
  }

  /** A Factory call that failed is the Factory's answer to the person, not a server bug: 502 with its words. */
  async #factoryCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof AssistantError) throw error;
      throw new AssistantError('factory_failed', `Factory answered: ${errorText(error)}`, 502);
    }
  }

  /** One request with its thread, notes, memory thread, file records and unshared bytes. */
  async #deleteRequest(owner: AssistantOwner, id: string): Promise<number> {
    const files = await this.#deps.storage.listFiles(owner, id);
    await this.#deps.memory.forgetThread(owner, id);
    await this.#deps.storage.deleteRequest(owner, id);
    for (const file of files) await this.#deps.storage.deleteFile(owner, file.id);
    await this.#dropUnreferenced(files);
    return files.length;
  }

  /** Bytes go only once no assistant file and nothing else (Factory attachments, avatars) names them. */
  async #dropUnreferenced(files: AssistantFile[]): Promise<void> {
    if (!this.#deps.blobs) return;
    for (const sha256 of new Set(files.map(file => file.sha256))) {
      if (await this.#deps.storage.isBlobReferenced(sha256)) continue;
      if (await this.#deps.blobReferencedElsewhere(sha256)) continue;
      await this.#deps.blobs.delete(sha256);
    }
  }

  /** `<tempRoot>/<orgId>/<userId>`, only when both ids are plain path segments inside the root. */
  async #removeTempFolder(owner: AssistantOwner): Promise<void> {
    const root = this.#deps.tempRoot;
    if (!root) return;
    const folder = assistantTempFolder(root, owner);
    await rm(folder, { recursive: true, force: true });
  }
}

const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** The owner's working folder under `root`, refusing anything that is not a plain segment below it. */
export function assistantTempFolder(root: string, owner: AssistantOwner): string {
  assertOwner(owner);
  if (!root || !isAbsolute(root)) throw new Error('The assistant temp root must be an absolute path.');
  for (const segment of [owner.orgId, owner.userId]) {
    if (!SEGMENT.test(segment) || segment === '.' || segment === '..') {
      throw new Error('An owner id is not a plain path segment; refusing to touch the file system.');
    }
  }
  const folder = resolve(join(root, owner.orgId, owner.userId));
  const inside = relative(resolve(root), folder);
  if (!inside || inside.startsWith('..') || isAbsolute(inside) || inside.split(/[\\/]/).length !== 2) {
    throw new Error('The assistant temp folder resolved outside its root; refusing to remove it.');
  }
  return folder;
}
