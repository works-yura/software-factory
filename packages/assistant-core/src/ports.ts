/**
 * What the assistant needs from its host, as ports (ADR-0051). The host (the Factory server)
 * supplies them; nothing here reaches into Factory's cards, sessions or harnesses. Factory itself
 * is reached only through {@link FactoryClient}, which speaks Factory's MCP as the person.
 */
import type { AssistantFile, AssistantMessage, AssistantOwner, AssistantRequest, FactoryLink } from './types.ts';

/** Bytes by content hash: the server's `AttachmentBlobStore`, shared with Factory attachments. */
export interface AssistantBlobStore {
  put(
    body: Uint8Array | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
    options?: { maxBytes?: number },
  ): Promise<{ sha256: string; size: number }>;
  get(sha256: string): Promise<ReadableStream<Uint8Array> | null>;
  delete(sha256: string): Promise<boolean>;
}

/** Encrypts secrets at rest: the server's `secret-encryption` envelope. */
export interface SecretCipher {
  encrypt<T>(value: T): Promise<string>;
  decrypt<T>(value: unknown): Promise<{ value: T; needsReencryption: boolean }>;
}

/** One file of a turn, as the model gets it. */
export interface BrainFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

/** What one turn of the agent sees: the request and the new entry it answers. */
export interface BrainTurn {
  owner: AssistantOwner;
  request: AssistantRequest;
  /**
   * The new entry to look at: the person's text, a Factory's answer, or a message read from a
   * source (`fromName` wrote it there).
   */
  input: { author: 'person' | 'factory' | 'source'; text: string; files: BrainFile[]; fromName?: string | null };
  /** The request's first turn: for a request a source made, the agent also names its topic. */
  first?: boolean;
  /** The model the person chose, or `null` for the organization's default. */
  modelId: string | null;
}

/**
 * The per-person agent: a Mastra Agent with memory under `assistant:<orgId>:<userId>`, thread per
 * request. It reports to the person only.
 */
export interface AssistantBrain {
  /** The report, and — when asked on a source request's first turn — a short topic for it. */
  respond(turn: BrainTurn): Promise<{ text: string; topic?: string }>;
}

/** The agent's memory: erased per owner. */
export interface AssistantMemory {
  forget(owner: AssistantOwner): Promise<void>;
  forgetThread(owner: AssistantOwner, requestId: string): Promise<void>;
}

/** A model of the organization's, as the settings picker lists it. */
export interface AssistantModelOption {
  id: string;
  provider: string;
  modelName: string;
}

/** The organization's models (its credential pool, ADR-0032): there are no personal ones. */
export interface AssistantModels {
  list(owner: AssistantOwner): Promise<AssistantModelOption[]>;
}

/** A Factory the person can reach through MCP. */
export interface FactoryRef {
  id: string;
  name: string;
}

/** What asking a Factory started: its side session. */
export interface FactoryQuestion {
  sessionId: string;
  url?: string;
}

/** A side session's answer so far: `null` while it is still working. */
export interface FactoryAnswer {
  text: string | null;
}

/** What handing a request over created. */
export interface FactoryHandover {
  workItemId: string;
  url?: string;
  /** Files the card did not get, with why. The card exists either way. */
  failedFiles: Array<{ name: string; error: string }>;
}

/**
 * Factory, reached only through its MCP endpoint with the person's own OAuth grant (ADR-0051).
 * The person's role decides what works: a viewer cannot hand a card over.
 */
export interface FactoryClient {
  /** Whether the person has allowed the assistant to reach Factory. */
  connected(owner: AssistantOwner): Promise<boolean>;
  listFactories(owner: AssistantOwner): Promise<FactoryRef[]>;
  ask(owner: AssistantOwner, input: { factoryId: string; question: string; title: string }): Promise<FactoryQuestion>;
  readAnswer(owner: AssistantOwner, input: { factoryId: string; sessionId: string }): Promise<FactoryAnswer>;
  handOver(
    owner: AssistantOwner,
    input: {
      factoryId: string;
      title: string;
      description: string;
      files: Array<{ name: string; mime: string; bytes: Uint8Array }>;
    },
  ): Promise<FactoryHandover>;
}

/** The person's OAuth grant to Factory's MCP: revoked first when the assistant is erased. */
export interface FactoryGrant {
  revoke(owner: AssistantOwner): Promise<void>;
}

/** An audit entry for an erased assistant: who, which organization, why. Never content. */
export interface AssistantAuditEvent {
  orgId: string;
  userId: string;
  actorId: string;
  reason: string;
  counts: { requests: number; files: number };
}

export type AssistantAudit = (event: AssistantAuditEvent) => Promise<void>;

/**
 * A source the person connected personally (ADR-0051: ClickUp Chat, later e-mail). The core erases
 * it first when the assistant is erased; the source owns its connection, channels and cursors.
 */
export interface AssistantSource {
  readonly platform: string;
  /** Forgets the person's connection (the encrypted token), channel modes and cursors. */
  disconnect(owner: AssistantOwner): Promise<void>;
  /** Organizations a person has a connection of this source in (for erasing a deleted account). */
  organizationsOf(userId: string): Promise<string[]>;
}

/** One message a source read, as the core takes it in. */
export interface SourceMessage {
  platform: 'clickup';
  /** The thread it belongs to: `platform:workspace:channel:thread` (thread = the root message id). */
  sourceKey: string;
  /** The message's own id at the source: `platform:workspace:message`. Taking it in twice is a no-op. */
  messageKey: string;
  text: string;
  /** Who wrote it, as the source names them. */
  fromName: string | null;
  /** A link to the message at the source. */
  sourceUrl: string | null;
  /** Its attachments, already downloaded. */
  files: Array<{ name: string; declaredMime: string | null; bytes: Uint8Array }>;
  /** The person wrote it themself: it joins an open request as context, but never starts one or a turn. */
  fromMe: boolean;
  /** False when the person's limit on agent turns is spent: the message is kept, the agent skips it. */
  analyse: boolean;
  /** Where the source thread lives, for the agent (`#general`, `DM`). */
  where?: string;
}

export type IngestOutcome = 'duplicate' | 'skipped' | 'created' | 'appended' | 'reopened';

/** What a request and its thread look like to the panel. */
export interface RequestView {
  request: AssistantRequest;
  messages: AssistantMessage[];
  files: AssistantFile[];
}

export type { FactoryLink };
