/**
 * The assistant's lifecycle (ADR-0051): requests the person brings, the agent's turns, asking
 * and handing over to a Factory, notes, settings, and erasing it all.
 *
 * Every method takes the owner first and reads only that owner's rows: another person's (or the
 * same person's in another organization) request is simply not found.
 */
import { randomUUID } from 'node:crypto';

import { nextDigestAt, isTimeZone } from './digest.ts';
import { assertFileResponse, fetchPublicFile, nameFromUrl, publicUrlProblem } from './download.ts';
import { AssistantError } from './errors.ts';
import type { IncomingFile } from './files.ts';
import { ASSISTANT_AGENT_INSTRUCTIONS, assistantInstructions, instructionsVersion } from './instructions.ts';
import { ASSISTANT_FILE_MAX_BYTES, ASSISTANT_MAX_FILES_PER_MESSAGE, cleanFileName, sniffMime } from './files.ts';
import type {
  AssistantAudit,
  AssistantBlobStore,
  AssistantBrain,
  AssistantMemory,
  AssistantModels,
  AssistantSkillDetail,
  AssistantSkillEntry,
  AssistantSkills,
  AssistantSource,
  AssistantWorkspaceHost,
  BrainAuthor,
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
  SourceContextMessage,
  SourceMessage,
} from './ports.ts';
import { FACTORY_READ_TOOLS } from './ports.ts';
import type { AssistantStorage, RequestPatch } from './storage.ts';
import { createAssistantTools, describeTools, recordToolCalls, summarize } from './tools.ts';
import type { AssistantToolKind } from './tools.ts';
import type {
  AssistantClearReason,
  AssistantFile,
  AssistantNote,
  AssistantOwner,
  AssistantRequest,
  AssistantSettings,
  DigestSettings,
  FactoryActionKind,
  OwnSkill,
  PendingAction,
  RequestStatus,
  ToolCallRecord,
  TurnDetails,
} from './types.ts';
import { classifyTurnFailure } from './turn-failure.ts';
import { AssistantWorkspaces, DOWNLOADS_DIR, recordWorkspaceCalls, requestFolder, workspaceGate } from './workspace.ts';
import type { WorkspaceEntry, WorkspaceFileView, WorkspaceTreeView } from './workspace.ts';
import type { TurnFailure } from './turn-failure.ts';
import {
  assertOwner,
  DIGEST_FREQUENCIES,
  MAX_INSTRUCTIONS,
  MAX_OWN_SKILLS,
  MAX_RETENTION_DAYS,
  MAX_SKILL_DESCRIPTION,
  MAX_SKILL_INSTRUCTIONS,
  MAX_SKILLS,
  MIN_RETENTION_DAYS,
  SKILL_NAME,
} from './types.ts';

/** The base instructions as the settings page shows them: the person's version, the default, the version hash. */
export interface BehaviorView {
  document: string;
  defaultDocument: string;
  customized: boolean;
  updatedAt: Date | null;
  /** The version of the whole system prompt a turn would run on now (`instructionsVersion`). */
  version: string;
}

/** «What the agent sees»: the whole system prompt and every tool with what it may do. */
export interface AgentPreview {
  systemPrompt: string;
  version: string;
  modelId: string | null;
  skills: SkillSummary[];
  tools: Array<{ name: string; description: string; kind: AssistantToolKind }>;
}

/** How a provider fared last for this person: a turn or a model check that worked, or how it failed. */
export interface ProviderState {
  provider: string;
  modelId: string | null;
  state: 'ok' | TurnFailure['kind'];
  detail: string | null;
  at: Date;
}

/** A model check: the model's answer, or how it failed. */
export interface ModelCheck {
  ok: boolean;
  modelId: string | null;
  reply: string | null;
  failure: TurnFailure | null;
  durationMs: number;
}

/** `xai/grok-4.5` → `xai`; a harness model `claude-code:claude-opus-5-5` → `claude-code`. */
export function providerOf(modelId: string | null): string | null {
  if (!modelId) return null;
  const colon = modelId.indexOf(':');
  const slash = modelId.indexOf('/');
  if (colon > 0 && (slash < 0 || colon < slash)) return modelId.slice(0, colon);
  return slash > 0 ? modelId.slice(0, slash) : modelId;
}

const notFound = () => new AssistantError('not_found', 'Request not found.', 404);

const MAX_TEXT = 20_000;
const MAX_TOPIC = 120;
const MAX_NOTE = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The cost guards of phase 3: how much the agent's tools and digests may do. */
export interface AssistantLimits {
  /** Model steps (tool calls and answers) in one agent turn. */
  stepsPerTurn: number;
  /** How often a Factory's side session is checked for its answer after asking. */
  answerPollIntervalMs: number;
  /** How long it is checked; after that the person checks by hand ("Check answer"). 0 turns the checks off. */
  answerPollTimeoutMs: number;
  /** Open requests one digest looks at. */
  digestRequests: number;
  /** Model checks («Check the model») per person per hour. */
  modelChecksPerHour: number;
  /** After a restart: only requests touched this recently are picked up again. */
  resumeWithinMs: number;
  /** After a restart: agent turns run again per person; past it, the request waits for «Analyse». */
  resumeTurnsPerOwner: number;
}

export const DEFAULT_ASSISTANT_LIMITS: AssistantLimits = {
  stepsPerTurn: 8,
  answerPollIntervalMs: 20_000,
  answerPollTimeoutMs: 15 * 60_000,
  digestRequests: 40,
  modelChecksPerHour: 20,
  resumeWithinMs: 24 * 60 * 60_000,
  resumeTurnsPerOwner: 5,
};

/** What a server start did with one request a restart cut short (`resumeAfterRestart`). */
export type ResumeOutcome =
  /** An agent turn runs again, with the restart note. */
  | 'turn'
  /** The wait for a Factory's answer goes on, for what is left of it since the question. */
  | 'polling'
  /** The agent had already answered (or failed); only the «answering» mark was left over. */
  | 'settled'
  /** No model the person can run: the usual turn failure is shown. */
  | 'no_model'
  /** Past the per-person limit, or a resume already cut short once: waits for the person («Analyse»). */
  | 'left'
  /** The wait for a Factory's answer ran out: «Check answer», as after any timeout. */
  | 'timeout'
  /** This server start already picked it up. */
  | 'already';

/** The thread entries a turn answers: what people and sources wrote, a Factory's answer, an approved run's result, a digest. */
function isTurnInput(message: { author: string; text: string }): boolean {
  if (message.author === 'person' || message.author === 'source' || message.author === 'factory') return true;
  return message.author === 'event' && /^(ran|downloaded|digest):/.test(message.text);
}

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
   * The owner's workspace (files and commands in the host's sandbox, as the agent user). Without
   * it the agent has no workspace tools and downloads are refused, saying why.
   */
  workspace?: AssistantWorkspaceHost;
  /** How a confirmed download from a host no source owns is fetched; `fetch` by default. */
  fetch?: typeof fetch;
  maxFileBytes?: number;
  now?: () => Date;
  /** Runs an agent turn after the request answered; the default fires and forgets. Tests await it. */
  schedule?: (task: () => Promise<void>) => void;
}

/** The topic line's title: the first line of the text, or the first file's name. */
/** One quoted message of a tag's context: at most this many characters each. */
const CONTEXT_MESSAGE_CHARS = 2000;

/**
 * What a tag stores in the request's thread and gives the agent: the conversation it points at,
 * quoted with authors and times (oldest first), then the tagger's instruction.
 */
export function formatTaggedMessage(context: SourceContextMessage[], instruction: string): string {
  const quoted = context
    .filter(item => item.text.trim())
    .map(item => {
      const when = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(item.at) ? ` · ${item.at.slice(0, 16).replace('T', ' ')} UTC` : '';
      const body = item.text.trim().slice(0, CONTEXT_MESSAGE_CHARS);
      return [`**${item.fromName?.trim() || 'Someone'}**${when}`, ...body.split('\n')].map(line => `> ${line}`.trimEnd()).join('\n');
    })
    .join('\n>\n');
  return [quoted, instruction].filter(Boolean).join('\n\n');
}

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
  readonly #modelChecks = new OwnerWindow();
  /** The latest outcome per provider per owner (turns and model checks), in memory. */
  readonly #providerStates = new Map<string, Map<string, ProviderState>>();
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #workspaces: AssistantWorkspaces | undefined;
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
    this.#workspaces = deps.workspace ? new AssistantWorkspaces(deps.workspace) : undefined;
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
   * The person deletes a request now, as the retention sweep does later: its thread, notes, memory
   * thread, workspace, file records and the bytes nothing else names. Gone for good.
   */
  async deleteRequest(owner: AssistantOwner, id: string): Promise<void> {
    await this.#ready();
    await this.#require(owner, id);
    await this.#deleteRequest(owner, id);
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
   * Takes in a tag a source found (ADR-0051 amendment 2026-11-16: the person's tag in their chat is
   * the only way a source makes a request). The request binding key is the source thread: a tag in a
   * thread with an open request joins it; in a thread whose request was closed it opens a new
   * request that continues the previous one; otherwise it starts a new one. The tagged message's own
   * source id makes this idempotent. What is stored is the conversation the tag points at (quoted,
   * with its authors) and the tagger's instruction; nothing else of the chat is kept.
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

    // Claim the message before anything is written: a concurrent read of the same message stops here.
    if (!(await storage.recordSourceMessage(owner, { messageKey: message.messageKey, requestId: '', now: this.#now() }))) {
      return { outcome: 'duplicate', request: null };
    }
    try {
      const instruction = (message.text ?? '').trim();
      const text = formatTaggedMessage(message.context ?? [], instruction).slice(0, MAX_TEXT);
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
        const about = instruction || [...(message.context ?? [])].reverse().find(item => item.text.trim())?.text || '';
        request = await storage.createRequest(owner, {
          topic: deriveTopic(about, files.map(file => ({ name: cleanFileName(file.name) }))) || message.where || message.platform,
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
  async handOver(
    owner: AssistantOwner,
    id: string,
    input: { factoryId: string; title?: string; note?: string; workspaceFiles?: string[] },
  ): Promise<AssistantRequest> {
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
    // Files the person picked from the request's workspace folder go with the card too.
    const picked = [...new Set(input.workspaceFiles ?? [])];
    if (picked.length > ASSISTANT_MAX_FILES_PER_MESSAGE) {
      throw new AssistantError('too_many_files', `Pick at most ${ASSISTANT_MAX_FILES_PER_MESSAGE} workspace files.`, 400);
    }
    for (const path of picked) {
      const file = await this.#requireWorkspaces().read(owner, id, path);
      if (file.bytes.byteLength > this.maxFileBytes) throw new AssistantError('file_too_large', `${file.name} is larger than the limit.`, 413);
      files.push(file);
    }
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
      kind: FactoryActionKind;
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
    await this.#propose(owner, id, action, [`proposed:${action.kind}:${factory.name}`, action.question ?? action.title ?? action.note ?? '']);
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
      let done: AssistantRequest;
      if (action.kind === 'ask') {
        done = await this.askFactory(owner, id, { factoryId: action.factoryId, question: action.question ?? '' });
      } else if (action.kind === 'hand_over') {
        done = await this.handOver(owner, id, {
          factoryId: action.factoryId,
          ...(action.title ? { title: action.title } : {}),
          ...(action.note ? { note: action.note } : {}),
          ...(action.workspaceFiles?.length ? { workspaceFiles: action.workspaceFiles } : {}),
        });
      } else {
        done = await this.#runApproved(owner, id, action);
      }
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

  /** The chats where the person tagged the assistant, in every source that can list them. */
  async listTaggedChannels(owner: AssistantOwner): Promise<SourceChannelInfo[]> {
    const channels: SourceChannelInfo[] = [];
    for (const source of this.#deps.sources ?? []) {
      if (source.taggedChannels) channels.push(...(await source.taggedChannels(owner)));
    }
    return channels;
  }

  /** Recent messages of one chat where the person tagged the assistant, read now by its source. */
  async readSourceChannel(owner: AssistantOwner, input: { ref: string; threadId?: string; limit?: number }): Promise<SourceChannelMessages> {
    const platform = input.ref.split(':')[0];
    const source = (this.#deps.sources ?? []).find(candidate => candidate.platform === platform);
    if (!source?.readChannel) throw new AssistantError('not_found', 'No such chat among the ones you tagged the assistant in.', 404);
    return source.readChannel(owner, input);
  }

  // Skills

  /**
   * Every skill the person can pick: the Factory catalogue (with their overrides' descriptions) and
   * their own, each with whether it is picked.
   */
  async skillsCatalogue(owner: AssistantOwner): Promise<AssistantSkillEntry[]> {
    await this.#ready();
    const [catalogue, own, settings] = await Promise.all([
      this.#catalogue(owner),
      this.#deps.storage.listOwnSkills(owner),
      this.#deps.storage.getSettings(owner),
    ]);
    const picked = new Set(settings.skills);
    const overrides = new Map(own.filter(skill => skill.kind === 'override').map(skill => [skill.name, skill]));
    const names = new Set(catalogue.map(skill => skill.name));
    return [
      ...catalogue.map(skill => {
        const override = overrides.get(skill.name);
        return {
          name: skill.name,
          description: override?.description ?? skill.description,
          origin: 'factory' as const,
          overridden: Boolean(override),
          enabled: picked.has(skill.name),
        };
      }),
      ...own
        .filter(skill => skill.kind === 'personal' && !names.has(skill.name))
        .map(skill => ({ name: skill.name, description: skill.description, origin: 'personal' as const, overridden: false, enabled: picked.has(skill.name) })),
    ];
  }

  /** One skill in full: the text the agent would load, and the catalogue's original when overridden. */
  async getSkill(owner: AssistantOwner, name: string): Promise<AssistantSkillDetail> {
    await this.#ready();
    const own = await this.#deps.storage.getOwnSkill(owner, name);
    const original = this.#deps.skills ? await this.#deps.skills.read(owner, name).catch(() => null) : null;
    const picked = (await this.#deps.storage.getSettings(owner)).skills.includes(name);
    if (original) {
      const override = own?.kind === 'override' ? own : null;
      return {
        name,
        description: override?.description ?? original.description,
        instructions: override?.instructions ?? original.instructions,
        origin: 'factory',
        overridden: Boolean(override),
        enabled: picked,
        original: { description: original.description, instructions: original.instructions },
        updatedAt: override?.updatedAt ?? null,
      };
    }
    if (own?.kind === 'personal') {
      return {
        name,
        description: own.description,
        instructions: own.instructions,
        origin: 'personal',
        overridden: false,
        enabled: picked,
        original: null,
        updatedAt: own.updatedAt,
      };
    }
    throw new AssistantError('skill_not_found', `There is no skill ${name}.`, 404);
  }

  /**
   * Saves the person's text of a skill for their assistant only: an override of a catalogue skill
   * (the original and every Factory's edits stay as they are), or their own skill's new text.
   */
  async saveSkill(owner: AssistantOwner, name: string, input: { description: string; instructions: string }): Promise<AssistantSkillDetail> {
    await this.#ready();
    const fields = this.#skillFields(input);
    const inCatalogue = (await this.#catalogue(owner)).some(skill => skill.name === name);
    const own = await this.#deps.storage.getOwnSkill(owner, name);
    if (!inCatalogue && own?.kind !== 'personal') throw new AssistantError('skill_not_found', `There is no skill ${name}.`, 404);
    await this.#deps.storage.putOwnSkill(owner, { name, kind: inCatalogue ? 'override' : 'personal', ...fields }, this.#now());
    return this.getSkill(owner, name);
  }

  /** A skill of the person's own, for their assistant only. */
  async createSkill(owner: AssistantOwner, input: { name: string; description: string; instructions: string }): Promise<AssistantSkillDetail> {
    await this.#ready();
    const name = (input.name ?? '').trim();
    if (!SKILL_NAME.test(name)) {
      throw new AssistantError('invalid_skill_name', 'A skill name is lowercase letters, digits and dashes, up to 64.', 400);
    }
    const fields = this.#skillFields(input);
    if ((await this.#catalogue(owner)).some(skill => skill.name === name) || (await this.#deps.storage.getOwnSkill(owner, name))) {
      throw new AssistantError('skill_exists', `There is already a skill ${name}.`, 409);
    }
    const own = (await this.#deps.storage.listOwnSkills(owner)).filter(skill => skill.kind === 'personal');
    if (own.length >= MAX_OWN_SKILLS) throw new AssistantError('too_many_own_skills', `Keep at most ${MAX_OWN_SKILLS} skills of your own.`, 400);
    await this.#deps.storage.putOwnSkill(owner, { name, kind: 'personal', ...fields }, this.#now());
    return this.getSkill(owner, name);
  }

  /**
   * An override goes back to the catalogue's original; a skill of the person's own is deleted (and
   * unpicked).
   */
  async deleteSkill(owner: AssistantOwner, name: string): Promise<{ reverted: boolean; deleted: boolean }> {
    await this.#ready();
    const own = await this.#deps.storage.getOwnSkill(owner, name);
    if (!own) throw new AssistantError('skill_not_found', `You have no own text of ${name}.`, 404);
    await this.#deps.storage.deleteOwnSkill(owner, name);
    if (own.kind === 'override') return { reverted: true, deleted: false };
    const settings = await this.#deps.storage.getSettings(owner);
    if (settings.skills.includes(name)) {
      await this.#deps.storage.patchSettings(owner, { skills: settings.skills.filter(skill => skill !== name) }, this.#now());
    }
    return { reverted: false, deleted: true };
  }

  /** A skill's instructions, only when the person picked it: their own text first, then the catalogue's. */
  async readSkill(owner: AssistantOwner, name: string) {
    const settings = await this.getSettings(owner);
    if (!settings.skills.includes(name)) return null;
    const own = await this.#deps.storage.getOwnSkill(owner, name);
    if (own) return { name, description: own.description, instructions: own.instructions };
    if (!this.#deps.skills) return null;
    return this.#deps.skills.read(owner, name);
  }

  // Behaviour: the base instructions as one document the person edits

  /**
   * The base instructions: the person's version or the shipped default. A person who wrote «own
   * instructions» before (phase 3) gets them merged into their document once, on first read.
   */
  async getBehavior(owner: AssistantOwner): Promise<BehaviorView> {
    await this.#ready();
    const stored = await this.#behaviorDocument(owner);
    const skills = await this.#pickedSkills(owner, (await this.#deps.storage.getSettings(owner)).skills);
    return {
      document: stored.document ?? ASSISTANT_AGENT_INSTRUCTIONS,
      defaultDocument: ASSISTANT_AGENT_INSTRUCTIONS,
      customized: stored.document !== null,
      updatedAt: stored.updatedAt,
      version: instructionsVersion(assistantInstructions({ ...(stored.document ? { base: stored.document } : {}), skills })),
    };
  }

  /** Saves the person's version; the default text itself is kept as «not customized». */
  async saveBehavior(owner: AssistantOwner, document: string): Promise<BehaviorView> {
    await this.#ready();
    const text = (document ?? '').trim();
    if (!text) throw new AssistantError('empty', 'The instructions cannot be empty; use «Restore default» instead.', 400);
    if (text.length > MAX_INSTRUCTIONS) {
      throw new AssistantError('instructions_too_long', `Instructions are at most ${MAX_INSTRUCTIONS} characters.`, 400);
    }
    const now = this.#now();
    const custom = text === ASSISTANT_AGENT_INSTRUCTIONS ? null : text;
    await this.#deps.storage.patchSettings(owner, { behavior: { document: custom, updatedAt: custom ? now : null } }, now);
    return this.getBehavior(owner);
  }

  /** Back to the shipped default. */
  async resetBehavior(owner: AssistantOwner): Promise<BehaviorView> {
    await this.#ready();
    await this.#deps.storage.patchSettings(owner, { behavior: { document: null, updatedAt: null } }, this.#now());
    return this.getBehavior(owner);
  }

  /** «What the agent sees»: the system prompt a turn would run on now, and its tools. */
  async agentPreview(owner: AssistantOwner): Promise<AgentPreview> {
    await this.#ready();
    const settings = await this.#deps.storage.getSettings(owner);
    const skills = await this.#pickedSkills(owner, settings.skills);
    const stored = await this.#behaviorDocument(owner);
    const systemPrompt = assistantInstructions({ ...(stored.document ? { base: stored.document } : {}), skills });
    return {
      systemPrompt,
      version: instructionsVersion(systemPrompt),
      modelId: settings.modelId,
      skills,
      tools: [
        ...describeTools(createAssistantTools(this, { owner, requestId: 'preview', skills, workspace: this.#workspaces !== undefined })),
        ...(this.#workspaces
          ? (await this.#workspaces.describeTools(owner)).map(tool => ({
              name: tool.name,
              description: tool.description,
              kind: tool.approval === 'allow' ? ('workspace' as const) : ('asks' as const),
            }))
          : []),
      ],
    };
  }

  // Models: how each provider fared, and a check

  /** The latest outcome per provider: from this server's turns and checks, else the requests' last failures. */
  async providerStates(owner: AssistantOwner): Promise<ProviderState[]> {
    await this.#ready();
    const states = new Map<string, ProviderState>();
    for (const request of await this.#deps.storage.listRequests(owner)) {
      const failure = request.lastError;
      const provider = providerOf(failure?.modelId ?? null);
      if (!failure || !provider) continue;
      const known = states.get(provider);
      if (known && known.at >= request.updatedAt) continue;
      states.set(provider, { provider, modelId: failure.modelId, state: failure.kind, detail: failure.detail, at: request.updatedAt });
    }
    for (const [provider, state] of this.#providerStates.get(this.#ownerKey(owner)) ?? []) {
      const known = states.get(provider);
      if (!known || known.at <= state.at) states.set(provider, state);
    }
    return [...states.values()].sort((a, b) => a.provider.localeCompare(b.provider));
  }

  /** «Check the model»: a tiny call to the model (the chosen one, or the organization's default). */
  async testModel(owner: AssistantOwner, modelId?: string | null): Promise<ModelCheck> {
    await this.#ready();
    const probe = this.#deps.brain.probe;
    if (!probe) throw new AssistantError('model_check_unavailable', 'This server cannot check a model.', 503);
    if (!this.#modelChecks.allow(owner, this.limits.modelChecksPerHour, 60 * 60_000, this.#now().getTime())) {
      throw new AssistantError('too_many_checks', `At most ${this.limits.modelChecksPerHour} model checks an hour.`, 409);
    }
    const chosen = modelId === undefined ? (await this.#deps.storage.getSettings(owner)).modelId : modelId;
    const started = Date.now();
    try {
      const answer = await probe.call(this.#deps.brain, owner, chosen);
      this.#noteProvider(owner, answer.modelId, null);
      return { ok: true, modelId: answer.modelId, reply: answer.text, failure: null, durationMs: Date.now() - started };
    } catch (error) {
      const failure = classifyTurnFailure(error, chosen);
      this.#noteProvider(owner, failure.modelId, failure);
      return { ok: false, modelId: failure.modelId, reply: null, failure, durationMs: Date.now() - started };
    }
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
   * latest words — for the agent to sum up. It reads only the person's own requests, never a chat.
   * Nothing open, no request. The next one is scheduled either way.
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
      lines.push(
        [
          `- [${request.status}] ${request.topic}`,
          request.fromName ? ` — from ${request.fromName}` : '',
          request.pendingAction ? ` (waits for the person to confirm: ${pendingLabel(request.pendingAction)})` : '',
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
      skills?: string[];
      digest?: Partial<DigestSettings>;
    },
  ): Promise<AssistantSettings> {
    await this.#ready();
    const stored: Parameters<AssistantStorage['patchSettings']>[1] = {};
    if (patch.modelId !== undefined) stored.modelId = patch.modelId;
    if (patch.retentionDays !== undefined) stored.retentionDays = patch.retentionDays;
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

  // The workspace (ADR-0051, «Де живе помічник»)

  /** Whether this server gives the assistant a workspace. */
  get hasWorkspace(): boolean {
    return this.#workspaces !== undefined;
  }

  /** The request's folder in the owner's workspace: what the person, a source and the agent put there. */
  async listWorkspaceFiles(owner: AssistantOwner, id: string): Promise<WorkspaceEntry[]> {
    await this.#ready();
    await this.#require(owner, id);
    return this.#requireWorkspaces().list(owner, id);
  }

  /** One directory of the request's folder, as a session's Files tree lists one. */
  async workspaceTree(owner: AssistantOwner, id: string, path: string): Promise<WorkspaceTreeView> {
    await this.#ready();
    await this.#require(owner, id);
    return this.#requireWorkspaces().tree(owner, id, path);
  }

  /** One file of the request's folder, as a session's file view shows it. */
  async workspaceFileView(owner: AssistantOwner, id: string, path: string): Promise<WorkspaceFileView> {
    await this.#ready();
    await this.#require(owner, id);
    return this.#requireWorkspaces().fileView(owner, id, path);
  }

  /** One file of the request's folder. */
  async readWorkspaceFile(owner: AssistantOwner, id: string, path: string): Promise<{ name: string; mime: string; bytes: Uint8Array }> {
    await this.#ready();
    await this.#require(owner, id);
    return this.#requireWorkspaces().read(owner, id, path);
  }

  /**
   * The agent's download into the request's folder: a link on one of the person's sources is
   * fetched with that source's connection now; any other link becomes a proposal the person
   * confirms first (fetched then without credentials).
   */
  async downloadToWorkspace(
    owner: AssistantOwner,
    id: string,
    input: { url: string; name?: string; reason?: string },
  ): Promise<{ path: string; mime: string; size: number } | { status: 'awaiting_approval'; message: string }> {
    await this.#ready();
    const request = await this.#require(owner, id);
    this.#requireWorkspaces();
    const name = input.name?.trim() ? input.name : nameFromUrl(input.url);
    for (const source of this.#deps.sources ?? []) {
      const fetched = await source.download?.(owner, input.url, this.maxFileBytes);
      if (!fetched) continue;
      return this.#saveDownload(owner, id, name, fetched);
    }
    const problem = publicUrlProblem(input.url);
    if (problem) throw new AssistantError('download_refused', problem, 400);
    if (request.status === 'closed') throw new AssistantError('request_closed', 'This request is closed.', 409);
    await this.#propose(
      owner,
      id,
      {
        id: randomUUID(),
        kind: 'download',
        url: input.url,
        name: name.slice(0, 200),
        ...(input.reason?.trim() ? { reason: input.reason.trim().slice(0, 500) } : {}),
        proposedBy: 'agent',
        proposedAt: this.#now(),
      },
      ['proposed:download', input.url],
    );
    return {
      status: 'awaiting_approval',
      message:
        'This link is not on any of the person’s sources, so it is fetched only after they confirm it (without credentials). Tell them what it is and why you need it, and stop.',
    };
  }

  // Erasing

  /**
   * Erases an owner's assistant, in the ADR's order: the OAuth grant to Factory's MCP (and, from
   * phase 2, personal source connections) → the agent's Mastra memory → requests, threads, notes,
   * settings, secrets → file records and the bytes nothing else names → the workspace folder. Then
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
    this.#modelChecks.forget(owner);
    this.#providerStates.delete(this.#ownerKey(owner));
    await storage.deleteOwnerRows(owner);
    for (const file of files) await storage.deleteFile(owner, file.id);
    await this.#dropUnreferenced(files);
    // Last: the owner's workspace folder, with whatever still runs in it.
    await this.#workspaces?.erase(owner);

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

  // After a restart

  /**
   * Picks up what a server restart cut short (once per server start, `bootId` naming it). Turns run
   * in memory and the wait for a Factory's answer is a timer, so both die with the process; the
   * rest is stored, and what to pick up is read from it:
   * - a turn that was running (`analysing`) whose thread has entries after the agent's last reply
   *   runs again — a normal turn with the restart note; the agent checks with its tools where it
   *   stopped. A request whose resume was itself cut short is left for the person («Analyse»);
   * - a request waiting for a Factory's answer (asked, no answer, no timeout yet) is polled again
   *   for what is left of the original wait; once that ran out, the agent checks once with its tool.
   * Bounded: requests touched within `resumeWithinMs`, at most `resumeTurnsPerOwner` turns a person,
   * newest first; a person with no model they can run gets the usual failure. Every pick-up leaves
   * `resumed:<bootId>` in the thread, so one server start never runs a request twice.
   */
  async resumeAfterRestart(bootId: string): Promise<Array<{ owner: AssistantOwner; requestId: string; outcome: ResumeOutcome }>> {
    await this.#ready();
    if (!bootId) throw new Error('A resume needs the id of the server start it belongs to.');
    const since = new Date(this.#now().getTime() - this.limits.resumeWithinMs);
    const turns = new Map<string, number>();
    const models = new Map<string, Promise<TurnFailure | null>>();
    const outcomes: Array<{ owner: AssistantOwner; requestId: string; outcome: ResumeOutcome }> = [];
    for (const request of await this.#deps.storage.listResumeCandidates(since)) {
      const owner = request.owner;
      const key = this.#ownerKey(owner);
      const budget = {
        model: () => {
          if (!models.has(key)) models.set(key, this.#modelProblem(owner));
          return models.get(key)!;
        },
        take: () => {
          const used = turns.get(key) ?? 0;
          if (used >= this.limits.resumeTurnsPerOwner) return false;
          turns.set(key, used + 1);
          return true;
        },
      };
      try {
        const outcome = await this.#resumeOne(owner, request, bootId, budget);
        if (outcome) outcomes.push({ owner, requestId: request.id, outcome });
      } catch (error) {
        console.error(`[assistant] Request ${request.id} could not be picked up after the restart:`, errorText(error));
      }
    }
    return outcomes;
  }

  async #resumeOne(
    owner: AssistantOwner,
    request: AssistantRequest,
    bootId: string,
    budget: { model: () => Promise<TurnFailure | null>; take: () => boolean },
  ): Promise<ResumeOutcome | null> {
    const { storage } = this.#deps;
    const messages = await storage.listMessages(owner, request.id);
    const marker = `resumed:${bootId}`;
    if (messages.some(message => message.author === 'event' && message.text === marker)) return 'already';
    const event = (text: string) => storage.addMessage(owner, { requestId: request.id, author: 'event', text, now: this.#now() });
    const lastAgent = messages.findLastIndex(message => message.author === 'agent');
    const lastInput = messages.findLastIndex((message, index) => index > lastAgent && isTurnInput(message));
    const eventAfter = (index: number, test: (text: string) => boolean) =>
      messages.slice(index + 1).some(message => message.author === 'event' && test(message.text));

    // Whether a turn may run now: a model the person can run, and their share of resumes.
    const runnable = async (): Promise<'no_model' | 'left' | null> => {
      const problem = await budget.model();
      if (problem) {
        await storage.updateRequest(owner, request.id, { analysing: false, lastError: problem, unread: true }, this.#now());
        return 'no_model';
      }
      return budget.take() ? null : 'left';
    };

    if (request.analysing && (lastInput < 0 || request.lastError)) {
      // A resumed check of a Factory's answer that was cut short too: the wait is decided below.
      const lostResume = !request.lastError && eventAfter(lastAgent, text => text.startsWith('resumed:'));
      if (!lostResume) {
        // The agent had answered (or failed) when the server stopped; only the mark was left.
        const reported = !request.lastError && request.status !== 'closed';
        await storage.updateRequest(owner, request.id, { analysing: false, ...(reported ? { status: 'waiting_me' as const, unread: true } : {}) }, this.#now());
        return 'settled';
      }
      await storage.updateRequest(owner, request.id, { analysing: false }, this.#now());
    } else if (request.analysing) {
      const leave = async (): Promise<'left'> => {
        if (!eventAfter(lastInput, text => text.startsWith('not_analysed:'))) await event('not_analysed:restart');
        await storage.updateRequest(owner, request.id, { analysing: false, unread: true }, this.#now());
        return 'left';
      };
      // Picked up once already and cut short again: never a loop of restarts; the person decides.
      if (eventAfter(lastInput, text => text.startsWith('resumed:'))) return leave();
      const blocked = await runnable();
      if (blocked === 'left') return leave();
      if (blocked) return blocked;
      const entries = messages.slice(lastAgent + 1).filter(isTurnInput);
      const fileIds = new Set(entries.flatMap(message => message.fileIds));
      const files = (await storage.listFiles(owner, request.id)).filter(file => fileIds.has(file.id));
      const withBytes = await Promise.all(files.map(async file => ({ ...file, bytes: await this.#bytes(file) })));
      await event(marker);
      await this.#startTurn(owner, request, {
        author: 'resumed',
        text: ['The entries since your last reply (what you were answering):', ...entries.map(entryLine)].join('\n\n'),
        files: withBytes,
      });
      return 'turn';
    }

    const sessionId = request.factory?.sessionId;
    if (request.status !== 'waiting_factory' || !request.factory || !sessionId || this.limits.answerPollTimeoutMs <= 0) return null;
    const asked = messages.findLastIndex(message => message.author === 'event' && message.text.startsWith('asked:'));
    if (asked < 0) return null;
    if (messages.slice(asked + 1).some(message => message.author === 'factory') || eventAfter(asked, text => text === 'answer_timeout')) {
      return null;
    }
    const question = messages[asked]!;
    const left = this.limits.answerPollTimeoutMs - (this.#now().getTime() - new Date(question.createdAt).getTime());
    if (left > 0) {
      await event(marker);
      this.#watchAnswer(owner, request.id, sessionId, left);
      return 'polling';
    }
    // The wait ran out while the server was down: the agent checks once; past that, «Check answer».
    if (eventAfter(asked, text => text.startsWith('resumed:'))) {
      await event('answer_timeout');
      return 'timeout';
    }
    const blocked = await runnable();
    if (blocked) {
      await event('answer_timeout');
      return blocked === 'left' ? 'timeout' : blocked;
    }
    await event(marker);
    await this.#startTurn(owner, request, {
      author: 'resumed',
      text: [
        `You were waiting for the answer of Factory ${request.factory.factoryName} (factoryId ${request.factory.factoryId}, sessionId ${sessionId}) to the question asked at ${new Date(question.createdAt).toISOString()}:`,
        question.text.split('\n').slice(1).join('\n'),
        'The wait for it ran out while the server was down. Check it once with factory_session_status: give the person the conclusion if it answered, or say it has not answered yet (they can check again later).',
      ].join('\n\n'),
      files: [],
    });
    return 'turn';
  }

  /** Why the person's turns cannot run now (no model to run them on), or null; a catalog that cannot be read lets the turn say why. */
  async #modelProblem(owner: AssistantOwner): Promise<TurnFailure | null> {
    const settings = await this.#deps.storage.getSettings(owner);
    let catalog: Awaited<ReturnType<AssistantModels['catalog']>>;
    try {
      catalog = await this.#deps.models.catalog(owner);
    } catch {
      return null;
    }
    if (!settings.modelId) return catalog.default ? null : { kind: 'no_model', modelId: null, status: null, detail: catalog.defaultReason };
    const model = catalog.groups.flatMap(group => group.models).find(candidate => candidate.id === settings.modelId);
    if (model?.selectable) return null;
    return {
      kind: model ? 'no_model' : 'model_not_found',
      modelId: settings.modelId,
      status: null,
      detail: model
        ? `The assistant cannot run ${model.label}: ${model.availability.reason ?? model.availability.state}.`
        : `The organization has no model ${settings.modelId}.`,
    };
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
      author: BrainAuthor;
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

  async #runTurn(
    owner: AssistantOwner,
    request: AssistantRequest,
    input: BrainTurn['input'],
    first: boolean,
    finish: () => boolean,
  ) {
    try {
      const settings = await this.#deps.storage.getSettings(owner);
      const before = (await this.#deps.storage.getRequest(owner, request.id)) ?? request;
      const skills = await this.#pickedSkills(owner, settings.skills);
      const behavior = await this.#behaviorDocument(owner);
      const systemPrompt = assistantInstructions({ ...(behavior.document ? { base: behavior.document } : {}), skills });
      const calls: ToolCallRecord[] = [];
      const started = Date.now();
      const workspace = await this.#turnWorkspace(owner, request.id, calls);
      let answer: Awaited<ReturnType<AssistantBrain['respond']>>;
      try {
        answer = await this.#deps.brain.respond({
          owner,
          request: before,
          input,
          modelId: settings.modelId,
          first,
          systemPrompt,
          ...(skills.length ? { skills } : {}),
          tools: recordToolCalls(createAssistantTools(this, { owner, requestId: request.id, skills, workspace: workspace !== undefined }), calls),
          ...(workspace ? { workspace: workspace.workspace, workspaceFolder: workspace.folder } : {}),
          maxSteps: this.limits.stepsPerTurn,
        });
      } catch (error) {
        const failure = classifyTurnFailure(error);
        this.#noteProvider(owner, failure.modelId, failure);
        throw error;
      }
      const details: TurnDetails = {
        modelId: answer.modelId ?? settings.modelId,
        instructionsVersion: instructionsVersion(systemPrompt),
        skills: skills.map(skill => skill.name),
        toolCalls: calls,
        durationMs: Date.now() - started,
      };
      this.#noteProvider(owner, details.modelId, null);
      await this.#deps.storage.addMessage(owner, { requestId: request.id, author: 'agent', text: answer.text, details, now: this.#now() });
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
  }

  /** The person's picked skills that the catalogue still has (a removed skill is dropped quietly from the turn). */
  async #pickedSkills(owner: AssistantOwner, names: string[]): Promise<SkillSummary[]> {
    if (names.length === 0) return [];
    let catalogue: SkillSummary[] = [];
    try {
      catalogue = await this.#catalogue(owner);
    } catch (error) {
      console.error('[assistant] The skills catalogue could not be read; the turn runs without its skills:', errorText(error));
    }
    const own = new Map<string, OwnSkill>((await this.#deps.storage.listOwnSkills(owner)).map(skill => [skill.name, skill]));
    const listed = [
      ...catalogue.map(skill => ({ name: skill.name, description: own.get(skill.name)?.description ?? skill.description })),
      ...[...own.values()].filter(skill => skill.kind === 'personal').map(skill => ({ name: skill.name, description: skill.description })),
    ];
    return listed.filter(skill => names.includes(skill.name));
  }

  /** The Factory skills catalogue (originals), or nothing without one. */
  async #catalogue(owner: AssistantOwner): Promise<SkillSummary[]> {
    return this.#deps.skills ? this.#deps.skills.list(owner) : [];
  }

  #skillFields(input: { description: string; instructions: string }) {
    const description = (input.description ?? '').replace(/\s+/g, ' ').trim();
    const instructions = (input.instructions ?? '').trim();
    if (!description) throw new AssistantError('invalid_skill', 'A skill needs a description: the agent decides by it when to load it.', 400);
    if (description.length > MAX_SKILL_DESCRIPTION) {
      throw new AssistantError('invalid_skill', `A skill's description is at most ${MAX_SKILL_DESCRIPTION} characters.`, 400);
    }
    if (!instructions) throw new AssistantError('invalid_skill', 'A skill needs instructions.', 400);
    if (instructions.length > MAX_SKILL_INSTRUCTIONS) {
      throw new AssistantError('invalid_skill', `A skill's instructions are at most ${MAX_SKILL_INSTRUCTIONS} characters.`, 400);
    }
    return { description, instructions };
  }

  /** The stored base document; «own instructions» from phase 3 are merged into it once. */
  async #behaviorDocument(owner: AssistantOwner): Promise<{ document: string | null; updatedAt: Date | null }> {
    const stored = await this.#deps.storage.getBehavior(owner);
    if (stored.document !== null || !stored.legacyInstructions) return { document: stored.document, updatedAt: stored.updatedAt };
    const now = this.#now();
    const document = `${ASSISTANT_AGENT_INSTRUCTIONS}\n\n## My instructions\n\n${stored.legacyInstructions}`;
    await this.#deps.storage.patchSettings(owner, { behavior: { document, updatedAt: now } }, now);
    return { document, updatedAt: now };
  }

  #ownerKey(owner: AssistantOwner): string {
    return `${owner.orgId}\u0000${owner.userId}`;
  }

  /** Remembers how a provider fared for this person (a turn, a check): «ok», or the failure. */
  #noteProvider(owner: AssistantOwner, modelId: string | null, failure: TurnFailure | null): void {
    const provider = providerOf(modelId);
    if (!provider) return;
    const key = this.#ownerKey(owner);
    const states = this.#providerStates.get(key) ?? new Map<string, ProviderState>();
    states.set(provider, {
      provider,
      modelId,
      state: failure ? failure.kind : 'ok',
      detail: failure?.detail ?? null,
      at: this.#now(),
    });
    this.#providerStates.set(key, states);
  }

  /**
   * After a question to a Factory: checks its side session every `answerPollIntervalMs` until it
   * answered (the answer goes into the thread and the agent concludes) or `answerPollTimeoutMs`
   * passed (an event says so; "Check answer" still works). Stops once the request no longer waits
   * on that session.
   */
  #watchAnswer(owner: AssistantOwner, id: string, sessionId: string, timeoutMs = this.limits.answerPollTimeoutMs): void {
    if (this.limits.answerPollTimeoutMs <= 0 || timeoutMs <= 0) return;
    const attempts = Math.max(1, Math.ceil(timeoutMs / this.limits.answerPollIntervalMs));
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
    await this.#workspaces?.removeRequest(owner, id);
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

  #requireWorkspaces(): AssistantWorkspaces {
    if (!this.#workspaces) {
      throw new AssistantError(
        'workspace_unavailable',
        'This server gives the assistant no workspace (it runs no local sandbox), so the assistant has no files or commands.',
        503,
      );
    }
    return this.#workspaces;
  }

  /**
   * The owner's workspace for a turn, the request's files in its folder, every workspace tool call
   * gated by the rules (what asks becomes a proposal) and recorded for «Turn details».
   */
  async #turnWorkspace(owner: AssistantOwner, requestId: string, calls: ToolCallRecord[]) {
    const workspaces = this.#workspaces;
    if (!workspaces) return undefined;
    const files = await Promise.all(
      (await this.#deps.storage.listFiles(owner, requestId)).map(async file => ({ name: file.name, bytes: await this.#bytes(file) })),
    );
    return workspaces.forTurn(owner, {
      requestId,
      files,
      hooks: workspaceGate({
        approval: toolName => workspaces.approval(toolName),
        record: recordWorkspaceCalls(calls, summarize),
        propose: async call => {
          await this.#propose(
            owner,
            requestId,
            { id: randomUUID(), kind: 'workspace_tool', ...call, proposedBy: 'agent', proposedAt: this.#now() },
            [`proposed:workspace_tool:${call.toolName}`, call.summary],
          );
        },
      }),
    });
  }

  /** Stores a proposal on the request (replacing an older one) with its event line in the thread. */
  async #propose(owner: AssistantOwner, id: string, action: PendingAction, event: string[]): Promise<void> {
    await this.#deps.storage.addMessage(owner, { requestId: id, author: 'event', text: event.filter(Boolean).join('\n'), now: this.#now() });
    const updated = await this.#deps.storage.updateRequest(owner, id, { pendingAction: action, unread: true }, this.#now());
    if (!updated) throw notFound();
  }

  /**
   * Runs a workspace call or a download the person confirmed, writes what it gave into the thread
   * and lets the agent carry on from it.
   */
  async #runApproved(owner: AssistantOwner, id: string, action: PendingAction): Promise<AssistantRequest> {
    const request = await this.#require(owner, id);
    if (request.status === 'closed') throw new AssistantError('request_closed', 'This request is closed.', 409);
    let text: string;
    if (action.kind === 'workspace_tool') {
      const output = await this.#requireWorkspaces().runApproved(owner, id, { toolName: action.toolName, args: action.args });
      text = `ran:${action.toolName}\n${action.summary}\n\n${typeof output === 'string' ? output : JSON.stringify(output, null, 2)}`.slice(0, 8000);
    } else if (action.kind === 'download') {
      const fetched = await fetchPublicFile(action.url, this.maxFileBytes, this.#deps.fetch);
      const saved = await this.#saveDownload(owner, id, action.name, fetched);
      text = `downloaded:${saved.path}\n${action.url}\n${saved.mime}, ${saved.size} bytes`;
    } else {
      throw new Error(`${action.kind} is not a workspace action.`);
    }
    await this.#deps.storage.addMessage(owner, { requestId: id, author: 'event', text, now: this.#now() });
    return this.#startTurn(owner, request, { author: 'approved', text, files: [] });
  }

  /** A downloaded file into the request's `downloads/` folder: a file (never a web page), within the limit. */
  async #saveDownload(owner: AssistantOwner, id: string, name: string, fetched: { bytes: Uint8Array; mime: string | null }) {
    assertFileResponse(fetched.mime);
    if (fetched.bytes.byteLength > this.maxFileBytes) throw new AssistantError('file_too_large', 'The file is larger than the limit.', 413);
    const mime = sniffMime(fetched.bytes, fetched.mime);
    const path = await this.#requireWorkspaces().write(owner, id, { dir: DOWNLOADS_DIR, name, bytes: fetched.bytes });
    return { path: `${requestFolder(id)}/${path}`, mime, size: fetched.bytes.byteLength };
  }
}

/** One thread entry as a resumed turn quotes it. */
function entryLine(message: { author: string; fromName: string | null; text: string }): string {
  if (message.author === 'event') return `[result] ${message.text}`;
  const who = message.author === 'source' ? (message.fromName ?? 'someone in the chat') : message.author;
  return `[${who}] ${message.text}`;
}

/** A proposal in one line, for the digest. */
function pendingLabel(action: PendingAction): string {
  if (action.kind === 'workspace_tool') return `run ${action.toolName}`;
  if (action.kind === 'download') return `download ${action.url}`;
  return `${action.kind} ${action.factoryName}`;
}
