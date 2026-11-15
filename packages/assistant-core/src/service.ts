/**
 * The assistant's lifecycle (ADR-0051): requests the person brings, the agent's turns, asking
 * and handing over to a Factory, notes, settings, and erasing it all.
 *
 * Every method takes the owner first and reads only that owner's rows: another person's (or the
 * same person's in another organization) request is simply not found.
 */
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { nextDigestAt, isTimeZone } from './digest.ts';
import { AssistantError } from './errors.ts';
import type { IncomingFile } from './files.ts';
import { ASSISTANT_FILE_MAX_BYTES, ASSISTANT_MAX_FILES_PER_MESSAGE, cleanFileName, sniffMime } from './files.ts';
import type {
  AssistantAudit,
  AssistantBlobStore,
  AssistantBrain,
  AssistantMemory,
  AssistantModels,
  AssistantSkills,
  AssistantSource,
  BrainFile,
  BrainTurn,
  FactoryClient,
  FactoryGrant,
  FactoryReadTool,
  IngestOutcome,
  RequestView,
  SkillSummary,
  SourceChannelInfo,
  SourceChannelMessages,
  SourceMessage,
} from './ports.ts';
import { FACTORY_READ_TOOLS } from './ports.ts';
import type { AssistantStorage, RequestPatch } from './storage.ts';
import { createAssistantTools } from './tools.ts';
import type {
  AssistantClearReason,
  AssistantFile,
  AssistantNote,
  AssistantOwner,
  AssistantRequest,
  AssistantSettings,
  ChannelRule,
  DigestSettings,
  PendingAction,
  PendingActionKind,
  RequestStatus,
} from './types.ts';
import { classifyTurnFailure } from './turn-failure.ts';
import {
  assertOwner,
  DIGEST_FREQUENCIES,
  MAX_INSTRUCTIONS,
  MAX_RETENTION_DAYS,
  MAX_SKILLS,
  MIN_RETENTION_DAYS,
} from './types.ts';

const notFound = () => new AssistantError('not_found', 'Request not found.', 404);

const MAX_TEXT = 20_000;
const MAX_TOPIC = 120;
const MAX_NOTE = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The cost guards of phase 3: how much the agent's tools, rules and digests may do. */
export interface AssistantLimits {
  /** Model steps (tool calls and answers) in one agent turn. */
  stepsPerTurn: number;
  /** Factory questions channel rules may ask on their own per person per day; past it, they are proposed. */
  autoAsksPerDay: number;
  /** How often a Factory's side session is checked for its answer after asking. */
  answerPollIntervalMs: number;
  /** How long it is checked; after that the person checks by hand ("Check answer"). 0 turns the checks off. */
  answerPollTimeoutMs: number;
  /** Open requests one digest looks at. */
  digestRequests: number;
}

export const DEFAULT_ASSISTANT_LIMITS: AssistantLimits = {
  stepsPerTurn: 8,
  autoAsksPerDay: 10,
  answerPollIntervalMs: 20_000,
  answerPollTimeoutMs: 15 * 60_000,
  digestRequests: 40,
};

/** A sliding window of events per owner, in memory: a restart forgives, never overspends much. */
class OwnerWindow {
  readonly #events = new Map<string, number[]>();
  allow(owner: AssistantOwner, limit: number, windowMs: number, now: number): boolean {
    const key = `${owner.orgId}\u0000${owner.userId}`;
    const recent = (this.#events.get(key) ?? []).filter(at => now - at < windowMs);
    const allowed = recent.length < limit;
    if (allowed) recent.push(now);
    this.#events.set(key, recent);
    return allowed;
  }
  forget(owner: AssistantOwner) {
    this.#events.delete(`${owner.orgId}\u0000${owner.userId}`);
  }
}

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
  /** The Factory skills catalogue the person picks skills from; without it, no skills are offered. */
  skills?: AssistantSkills;
  limits?: Partial<AssistantLimits>;
  /** Waits between checks of a Factory's answer; tests pass one that does not wait. */
  sleep?: (ms: number) => Promise<void>;
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
  readonly #autoAsks = new OwnerWindow();
  readonly #sleep: (ms: number) => Promise<void>;
  readonly limits: AssistantLimits;

  constructor(deps: AssistantServiceDeps) {
    this.#deps = deps;
    this.limits = { ...DEFAULT_ASSISTANT_LIMITS, ...deps.limits };
    this.#sleep =
      deps.sleep ??
      (ms =>
        new Promise(resolve => {
          setTimeout(resolve, ms).unref?.();
        }));
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

  /**
   * Runs the agent again on what it has not answered yet: the entries after its last reply (a turn
   * that failed, or source messages left unread by the hourly limit). Same model choice as any
   * turn — never another provider behind the person's back.
   */
  async retry(owner: AssistantOwner, id: string): Promise<AssistantRequest> {
    await this.#ready();
    const request = await this.#require(owner, id);
    if (request.status === 'closed') throw new AssistantError('request_closed', 'This request is closed.', 409);
    if (request.analysing) throw new AssistantError('agent_busy', 'The assistant is still answering.', 409);
    const messages = await this.#deps.storage.listMessages(owner, id);
    let lastAgent = -1;
    messages.forEach((message, index) => {
      if (message.author === 'agent') lastAgent = index;
    });
    const unanswered = messages
      .slice(lastAgent + 1)
      .filter(
        (message): message is typeof message & { author: 'person' | 'factory' | 'source' } =>
          message.author === 'person' || message.author === 'factory' || message.author === 'source',
      );
    const latest = unanswered.at(-1);
    if (!latest) throw new AssistantError('nothing_to_retry', 'The assistant has already answered everything here.', 409);
    const fileIds = new Set(unanswered.flatMap(message => message.fileIds));
    const files = (await this.#deps.storage.listFiles(owner, id)).filter(file => fileIds.has(file.id));
    const withBytes = await Promise.all(files.map(async file => ({ ...file, bytes: await this.#bytes(file) })));
    return this.#startTurn(owner, request, {
      author: latest.author,
      text: unanswered
        .map(message => message.text)
        .filter(Boolean)
        .join('\n\n'),
      files: withBytes,
      fromName: latest.fromName,
      first: lastAgent < 0 && request.source !== 'manual',
    });
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
      if (message.rule?.kind === 'digest_only') {
        // The channel goes into the digest: kept, never a turn of its own.
        await storage.addMessage(owner, { requestId: request.id, author: 'event', text: 'not_analysed:digest', now: this.#now() });
        const waiting = await storage.updateRequest(owner, request.id, { status: 'waiting_me', unread: true }, this.#now());
        return { outcome, request: waiting ?? request };
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
        // A new request of a channel whose rule asks a Factory: asked once the agent has reported.
        ...(message.rule?.kind === 'analyse_and_ask' && outcome !== 'appended' ? { autoAsk: message.rule.factoryId } : {}),
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
    this.#watchAnswer(owner, id, asked.sessionId);
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

  /** One read-only tool of a Factory's MCP, as the person (the agent's Factory tools). */
  async factoryRead(
    owner: AssistantOwner,
    input: { factoryId: string; tool: FactoryReadTool; args: Record<string, unknown> },
  ): Promise<Record<string, unknown>> {
    if (!(FACTORY_READ_TOOLS as readonly string[]).includes(input.tool)) {
      throw new AssistantError('not_read_only', `${input.tool} is not a read-only Factory tool.`, 400);
    }
    const factory = await this.#factoryRef(owner, input.factoryId);
    return this.#factoryCall(() => this.#deps.factory.read(owner, { factoryId: factory.id, tool: input.tool, args: input.args }));
  }

  /** Whether a side session answered yet. */
  async factorySessionStatus(owner: AssistantOwner, input: { factoryId: string; sessionId: string }) {
    const factory = await this.#factoryRef(owner, input.factoryId);
    const answer = await this.#factoryCall(() => this.#deps.factory.readAnswer(owner, { factoryId: factory.id, sessionId: input.sessionId }));
    return { answered: answer.text !== null, answer: answer.text };
  }

  /** Whether a channel rule can run: a rule that asks a Factory needs one the person can reach. */
  async checkChannelRule(owner: AssistantOwner, rule: ChannelRule): Promise<void> {
    if (rule.kind === 'analyse_and_ask') await this.#factoryRef(owner, rule.factoryId);
  }

  // Proposed actions (phase 3): asking a Factory and handing over change something outside, so the
  // agent only proposes them; the person's Confirm runs them.

  /**
   * Proposes a Factory action on a request: stored on it (replacing an older proposal), with an
   * event line in the thread. Nothing runs until the person confirms.
   */
  async proposeAction(
    owner: AssistantOwner,
    id: string,
    input: {
      kind: PendingActionKind;
      factoryId: string;
      question?: string;
      title?: string;
      note?: string;
      reason?: string;
      proposedBy: 'agent' | 'rule';
    },
  ): Promise<PendingAction> {
    await this.#ready();
    const request = await this.#require(owner, id);
    if (request.status === 'closed') throw new AssistantError('request_closed', 'This request is closed.', 409);
    if (input.kind === 'hand_over' && request.factory?.workItemId) {
      throw new AssistantError('already_handed_over', 'This request was already handed to a Factory.', 409);
    }
    const question = input.question?.trim();
    if (input.kind === 'ask' && !question) throw new AssistantError('invalid_action', 'Asking a Factory needs a question.', 400);
    if ((question?.length ?? 0) > 8000) throw new AssistantError('question_too_long', 'The question is longer than 8000 characters.', 400);
    if ((input.note?.length ?? 0) > 4000) throw new AssistantError('note_too_long', 'The note is longer than 4000 characters.', 400);
    const factory = await this.#factoryRef(owner, input.factoryId);
    const action: PendingAction = {
      id: randomUUID(),
      kind: input.kind,
      factoryId: factory.id,
      factoryName: factory.name,
      ...(question ? { question } : {}),
      ...(input.title?.trim() ? { title: input.title.trim().slice(0, 512) } : {}),
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      ...(input.reason?.trim() ? { reason: input.reason.trim().slice(0, 500) } : {}),
      proposedBy: input.proposedBy,
      proposedAt: this.#now(),
    };
    await this.#deps.storage.addMessage(owner, {
      requestId: id,
      author: 'event',
      text: [`proposed:${action.kind}:${factory.name}`, action.question ?? action.title ?? action.note ?? ''].filter(Boolean).join('\n'),
      now: this.#now(),
    });
    const updated = await this.#deps.storage.updateRequest(owner, id, { pendingAction: action, unread: true }, this.#now());
    if (!updated) throw notFound();
    return action;
  }

  /**
   * The person confirms the proposed action: it runs now, as the person. The action is taken off
   * the request atomically first, so it runs at most once; if it fails, it goes back for a retry.
   */
  async confirmAction(owner: AssistantOwner, id: string, actionId: string): Promise<AssistantRequest> {
    await this.#ready();
    await this.#require(owner, id);
    const action = await this.#deps.storage.takePendingAction(owner, id, actionId, this.#now());
    if (!action) throw new AssistantError('no_pending_action', 'There is no such proposed action on this request any more.', 409);
    try {
      const done =
        action.kind === 'ask'
          ? await this.askFactory(owner, id, { factoryId: action.factoryId, question: action.question ?? '' })
          : await this.handOver(owner, id, {
              factoryId: action.factoryId,
              ...(action.title ? { title: action.title } : {}),
              ...(action.note ? { note: action.note } : {}),
            });
      await this.#deps.storage.addMessage(owner, { requestId: id, author: 'event', text: `confirmed:${action.kind}`, now: this.#now() });
      return (await this.#deps.storage.getRequest(owner, id)) ?? done;
    } catch (error) {
      await this.#deps.storage.updateRequest(owner, id, { pendingAction: action }, this.#now()).catch(() => undefined);
      throw error;
    }
  }

  /** The person cancels the proposed action: nothing runs. */
  async cancelAction(owner: AssistantOwner, id: string, actionId: string): Promise<AssistantRequest> {
    await this.#ready();
    await this.#require(owner, id);
    const action = await this.#deps.storage.takePendingAction(owner, id, actionId, this.#now());
    if (!action) throw new AssistantError('no_pending_action', 'There is no such proposed action on this request any more.', 409);
    await this.#deps.storage.addMessage(owner, { requestId: id, author: 'event', text: `cancelled:${action.kind}`, now: this.#now() });
    return this.#require(owner, id);
  }

  // The agent's reads (tools): the owner's own data only.

  /** The owner's requests by text in the topic or sender, and/or status; newest activity first. */
  async searchRequests(owner: AssistantOwner, input: { query?: string; status?: RequestStatus; limit?: number }): Promise<AssistantRequest[]> {
    await this.#ready();
    const text = input.query?.trim().toLowerCase();
    return (await this.#deps.storage.listRequests(owner))
      .filter(request => !input.status || request.status === input.status)
      .filter(request => !text || request.topic.toLowerCase().includes(text) || (request.fromName ?? '').toLowerCase().includes(text))
      .slice(0, Math.min(Math.max(input.limit ?? 10, 1), 50));
  }

  /** A request with its latest thread entries, for the agent: unlike opening it, it stays unread. */
  async readThread(owner: AssistantOwner, id: string, input: { lastMessages?: number } = {}): Promise<RequestView> {
    await this.#ready();
    const request = await this.#require(owner, id);
    const messages = await this.#deps.storage.listMessages(owner, id);
    return {
      request,
      messages: messages.slice(-Math.min(Math.max(input.lastMessages ?? 15, 1), 50)),
      files: await this.#deps.storage.listFiles(owner, id),
    };
  }

  /** A note the agent keeps for the person (shown as the agent's). */
  async createAgentNote(owner: AssistantOwner, input: { text: string; requestId?: string | null }): Promise<AssistantNote> {
    await this.#ready();
    const text = this.#noteText(input.text);
    const requestId = input.requestId ?? null;
    if (requestId) await this.#require(owner, requestId);
    return this.#deps.storage.createNote(owner, { text, requestId, author: 'agent', now: this.#now() });
  }

  /** The chats the person turned on, in every source that can list them. */
  async listEnabledChannels(owner: AssistantOwner): Promise<SourceChannelInfo[]> {
    const channels: SourceChannelInfo[] = [];
    for (const source of this.#deps.sources ?? []) {
      if (source.enabledChannels) channels.push(...(await source.enabledChannels(owner)));
    }
    return channels;
  }

  /** Recent messages of one chat the person turned on, read now by its source. */
  async readSourceChannel(owner: AssistantOwner, input: { ref: string; threadId?: string; limit?: number }): Promise<SourceChannelMessages> {
    const platform = input.ref.split(':')[0];
    const source = (this.#deps.sources ?? []).find(candidate => candidate.platform === platform);
    if (!source?.readChannel) throw new AssistantError('not_found', 'No such chat among the ones you turned on.', 404);
    return source.readChannel(owner, input);
  }

  // Skills

  /** The Factory skills catalogue the person picks from. */
  async skillsCatalogue(owner: AssistantOwner): Promise<SkillSummary[]> {
    if (!this.#deps.skills) return [];
    return this.#deps.skills.list(owner);
  }

  /** A skill's instructions, only when the person picked it. */
  async readSkill(owner: AssistantOwner, name: string) {
    const settings = await this.getSettings(owner);
    if (!settings.skills.includes(name) || !this.#deps.skills) return null;
    return this.#deps.skills.read(owner, name);
  }

  // Digests

  /** Writes the digest of every owner whose digest is due (at most `limit`); how many were due. */
  async runDueDigests(limit = 20): Promise<number> {
    await this.#ready();
    const due = await this.#deps.storage.dueDigests(this.#now(), limit);
    for (const { owner } of due) {
      try {
        await this.writeDigest(owner);
      } catch (error) {
        // Loud, without content; the next one is scheduled anyway so a broken one does not spin.
        console.error(`[assistant] The digest of ${owner.orgId}/${owner.userId} failed:`, errorText(error));
        const settings = await this.#deps.storage.getSettings(owner);
        await this.#deps.storage.patchSettings(owner, { digestNextAt: nextDigestAt(this.#now(), settings.digest) }, this.#now());
      }
    }
    return due.length;
  }

  /**
   * One digest now: a request (source `digest`) listing what is open — topic, sender, status, the
   * latest words, which requests a digest-only channel brought — for the agent to sum up. Nothing
   * open, no request. The next one is scheduled either way.
   */
  async writeDigest(owner: AssistantOwner): Promise<AssistantRequest | null> {
    await this.#ready();
    const { storage } = this.#deps;
    const settings = await storage.getSettings(owner);
    const now = this.#now();
    const open = (await storage.listRequests(owner))
      .filter(request => request.source !== 'digest' && request.status !== 'closed')
      .slice(0, this.limits.digestRequests);
    await storage.patchSettings(owner, { digestLastAt: now, digestNextAt: nextDigestAt(now, settings.digest) }, now);
    if (open.length === 0) return null;
    const lines: string[] = [];
    for (const request of open) {
      const messages = await storage.listMessages(owner, request.id);
      const latest = [...messages].reverse().find(message => (message.author === 'source' || message.author === 'person') && message.text);
      const digestOnly = messages.some(message => message.author === 'event' && message.text === 'not_analysed:digest');
      lines.push(
        [
          `- [${request.status}] ${request.topic}`,
          request.fromName ? ` — from ${request.fromName}` : '',
          digestOnly ? ' (digest-only channel, not analysed yet)' : '',
          request.pendingAction ? ` (waits for the person to confirm: ${request.pendingAction.kind} ${request.pendingAction.factoryName})` : '',
          latest ? `\n  "${latest.text.replace(/\s+/g, ' ').slice(0, 300)}"` : '',
        ].join(''),
      );
    }
    const label = settings.digest.frequency === 'hourly' ? 'Hourly digest' : 'Daily digest';
    const request = await storage.createRequest(owner, {
      topic: `${label} · ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      fromName: null,
      source: 'digest',
      sourceUrl: null,
      now,
    });
    await storage.addMessage(owner, { requestId: request.id, author: 'event', text: `digest:${open.length}`, now });
    return this.#startTurn(owner, request, { author: 'digest', text: lines.join('\n'), files: [] });
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

  /** The digest schedule: when the last one was written, when the next is due. */
  async digestSchedule(owner: AssistantOwner): Promise<{ lastAt: Date | null; nextAt: Date | null }> {
    await this.#ready();
    const state = await this.#deps.storage.getDigestState(owner);
    return { lastAt: state.lastAt, nextAt: state.nextAt };
  }

  async patchSettings(
    owner: AssistantOwner,
    patch: {
      modelId?: string | null;
      retentionDays?: number;
      instructions?: string;
      skills?: string[];
      digest?: Partial<DigestSettings>;
    },
  ): Promise<AssistantSettings> {
    await this.#ready();
    const stored: Parameters<AssistantStorage['patchSettings']>[1] = {};
    if (patch.modelId !== undefined) stored.modelId = patch.modelId;
    if (patch.retentionDays !== undefined) stored.retentionDays = patch.retentionDays;
    if (patch.instructions !== undefined) {
      const instructions = patch.instructions.trim();
      if (instructions.length > MAX_INSTRUCTIONS) {
        throw new AssistantError('instructions_too_long', `Instructions are at most ${MAX_INSTRUCTIONS} characters.`, 400);
      }
      stored.instructions = instructions;
    }
    if (patch.skills !== undefined) {
      const names = [...new Set(patch.skills.map(name => name.trim()).filter(Boolean))];
      if (names.length > MAX_SKILLS) throw new AssistantError('too_many_skills', `Pick at most ${MAX_SKILLS} skills.`, 400);
      if (names.length > 0) {
        const catalogue = new Set((await this.skillsCatalogue(owner)).map(skill => skill.name));
        const unknown = names.filter(name => !catalogue.has(name));
        if (unknown.length) throw new AssistantError('unknown_skill', `There is no skill ${unknown.join(', ')} in the catalogue.`, 400);
      }
      stored.skills = names;
    }
    if (patch.digest !== undefined) {
      const current = (await this.#deps.storage.getSettings(owner)).digest;
      const digest: DigestSettings = { ...current, ...patch.digest };
      if (!(DIGEST_FREQUENCIES as readonly string[]).includes(digest.frequency)) {
        throw new AssistantError('invalid_digest', `The digest is ${DIGEST_FREQUENCIES.join(', ')}.`, 400);
      }
      if (!Number.isInteger(digest.hour) || digest.hour < 0 || digest.hour > 23) {
        throw new AssistantError('invalid_digest', 'The digest hour is 0–23.', 400);
      }
      if (typeof digest.timeZone !== 'string' || !isTimeZone(digest.timeZone)) {
        throw new AssistantError('invalid_digest', `Unknown time zone ${String(digest.timeZone)}.`, 400);
      }
      stored.digest = digest;
      stored.digestNextAt = nextDigestAt(this.#now(), digest);
    }
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
      const catalog = await this.#deps.models.catalog(owner);
      const model = catalog.groups.flatMap(group => group.models).find(candidate => candidate.id === patch.modelId);
      if (!model) {
        throw new AssistantError('unknown_model', `The organization has no model ${patch.modelId}.`, 400);
      }
      if (!model.selectable) {
        throw new AssistantError(
          'model_not_runnable',
          `The assistant cannot run ${model.label}: ${model.availability.reason ?? model.availability.state}.`,
          400,
        );
      }
    }
    return this.#deps.storage.patchSettings(owner, stored, this.#now());
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
    this.#autoAsks.forget(owner);
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
      author: 'person' | 'factory' | 'source' | 'digest';
      text: string;
      files: Array<AssistantFile & { bytes: Uint8Array }>;
      fromName?: string | null;
      first?: boolean;
      where?: string;
      /** A channel rule asks this Factory once the agent has reported. */
      autoAsk?: string;
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
      const run = chain.tail.then(() => this.#runTurn(owner, started, turn, Boolean(input.first), finish, input.autoAsk));
      chain.tail = run;
      return run;
    });
    return started;
  }

  async #runTurn(
    owner: AssistantOwner,
    request: AssistantRequest,
    input: BrainTurn['input'],
    first: boolean,
    finish: () => boolean,
    autoAsk?: string,
  ) {
    let reported: string | undefined;
    try {
      const settings = await this.#deps.storage.getSettings(owner);
      const before = (await this.#deps.storage.getRequest(owner, request.id)) ?? request;
      const skills = await this.#pickedSkills(owner, settings.skills);
      const answer = await this.#deps.brain.respond({
        owner,
        request: before,
        input,
        modelId: settings.modelId,
        first,
        ...(settings.instructions ? { instructions: settings.instructions } : {}),
        ...(skills.length ? { skills } : {}),
        tools: createAssistantTools(this, { owner, requestId: request.id, skills }),
        maxSteps: this.limits.stepsPerTurn,
      });
      await this.#deps.storage.addMessage(owner, { requestId: request.id, author: 'agent', text: answer.text, now: this.#now() });
      reported = answer.text;
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
          { ...(last ? { analysing: false } : {}), lastError: classifyTurnFailure(error), unread: true },
          this.#now(),
        )
        .catch(stored => console.error(`[assistant] Could not record the failure on request ${request.id}:`, stored));
    }
    if (autoAsk) await this.#autoAsk(owner, request.id, autoAsk, reported);
  }

  /** The person's picked skills that the catalogue still has (a removed skill is dropped quietly from the turn). */
  async #pickedSkills(owner: AssistantOwner, names: string[]): Promise<SkillSummary[]> {
    if (names.length === 0 || !this.#deps.skills) return [];
    try {
      const catalogue = await this.#deps.skills.list(owner);
      return catalogue.filter(skill => names.includes(skill.name));
    } catch (error) {
      console.error('[assistant] The skills catalogue could not be read; the turn runs without skills:', errorText(error));
      return [];
    }
  }

  /**
   * A channel rule's own question to a Factory (`analyse_and_ask`), after the agent's report. It
   * starts a side session, which costs, so it runs only for channels the person opted in, within
   * the daily limit; past the limit it becomes a proposal the person confirms, never a silent run.
   * A Factory that cannot be reached leaves an `auto_ask_failed` line in the thread.
   */
  async #autoAsk(owner: AssistantOwner, id: string, factoryId: string, report: string | undefined): Promise<void> {
    try {
      const request = await this.#deps.storage.getRequest(owner, id);
      if (!request || request.status === 'closed' || request.factory?.sessionId) return;
      const summary = await this.#summary(owner, request);
      const question = [
        summary,
        ...(report ? [`The assistant's first reading:\n${report}`] : []),
        'What is the answer, or the next step?',
      ]
        .join('\n\n')
        .slice(0, 8000);
      const allowed = this.#autoAsks.allow(owner, this.limits.autoAsksPerDay, DAY_MS, this.#now().getTime());
      if (!allowed) {
        await this.proposeAction(owner, id, {
          kind: 'ask',
          factoryId,
          question,
          reason: `The channel's rule asks this Factory, but today's limit of ${this.limits.autoAsksPerDay} automatic questions is spent.`,
          proposedBy: 'rule',
        });
        return;
      }
      await this.#deps.storage.addMessage(owner, { requestId: id, author: 'event', text: 'rule:analyse_and_ask', now: this.#now() });
      await this.askFactory(owner, id, { factoryId, question });
    } catch (error) {
      console.error(`[assistant] The channel rule could not ask a Factory on request ${id}:`, errorText(error));
      await this.#deps.storage
        .addMessage(owner, { requestId: id, author: 'event', text: `auto_ask_failed\n${errorText(error)}`, now: this.#now() })
        .catch(() => undefined);
    }
  }

  /**
   * After a question to a Factory: checks its side session every `answerPollIntervalMs` until it
   * answered (the answer goes into the thread and the agent concludes) or `answerPollTimeoutMs`
   * passed (an event says so; "Check answer" still works). Stops once the request no longer waits
   * on that session.
   */
  #watchAnswer(owner: AssistantOwner, id: string, sessionId: string): void {
    if (this.limits.answerPollTimeoutMs <= 0) return;
    const attempts = Math.max(1, Math.ceil(this.limits.answerPollTimeoutMs / this.limits.answerPollIntervalMs));
    this.#schedule(async () => {
      try {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          await this.#sleep(this.limits.answerPollIntervalMs);
          const request = await this.#deps.storage.getRequest(owner, id);
          if (!request || request.status !== 'waiting_factory' || request.factory?.sessionId !== sessionId) return;
          const checked = await this.checkFactoryAnswer(owner, id);
          if (checked.answered) return;
        }
        await this.#deps.storage.addMessage(owner, { requestId: id, author: 'event', text: 'answer_timeout', now: this.#now() });
      } catch (error) {
        console.error(`[assistant] Waiting for the Factory's answer on request ${id} stopped:`, errorText(error));
      }
    });
  }

  /** The request in words for a Factory: what was asked (by the person, or read from a source), by whom, the original link. */
  async #summary(owner: AssistantOwner, request: AssistantRequest): Promise<string> {
    const messages = await this.#deps.storage.listMessages(owner, request.id);
    const said = messages
      .filter(message => (message.author === 'person' || message.author === 'source') && message.text)
      .map(message => (message.author === 'source' && message.fromName ? `${message.fromName}: ${message.text}` : message.text));
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
