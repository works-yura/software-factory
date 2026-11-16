/**
 * The assistant's own entities (ADR-0051). Everything belongs to one owner: a person in one
 * organization. A person in two organizations has two assistants that never see each other.
 */

import type { TurnFailure } from './turn-failure.ts';

/** Who an assistant belongs to: the pair, never one half of it. */
export interface AssistantOwner {
  orgId: string;
  userId: string;
}

/** The Mastra memory resource of an owner's agent: one per (organization, person). */
export function assistantResourceId(owner: AssistantOwner): string {
  assertOwner(owner);
  return `assistant:${owner.orgId}:${owner.userId}`;
}

/**
 * An owner both halves of which are present. Every delete is scoped by it, so an empty id would
 * widen a delete to rows it must not touch: refuse it before any query runs.
 */
export function assertOwner(owner: AssistantOwner): void {
  if (typeof owner?.orgId !== 'string' || !owner.orgId.trim() || typeof owner.userId !== 'string' || !owner.userId.trim()) {
    throw new Error('An assistant owner needs both an organization id and a user id.');
  }
}

/**
 * Where a request stands: `new` until the agent has looked at it; `waiting_factory` while a
 * Factory works on a question or a handed-over card; `waiting_me` once the agent reported to the
 * person; `answered` once a reply went out (phase 4); `closed` by the person.
 */
export const REQUEST_STATUSES = ['new', 'waiting_factory', 'waiting_me', 'answered', 'closed'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export function isRequestStatus(value: unknown): value is RequestStatus {
  return typeof value === 'string' && (REQUEST_STATUSES as readonly string[]).includes(value);
}

/**
 * Where a request came from: what the person brought into the panel themself (`manual`), or a
 * message the assistant read in one of the person's own source connections (ADR-0051 phase 2), or
 * a digest the assistant wrote on the person's schedule (phase 3).
 */
export const REQUEST_SOURCES = ['manual', 'clickup', 'digest'] as const;
export type RequestSource = (typeof REQUEST_SOURCES)[number];

/** A Factory the request was asked of or handed to, as the topic line shows it. */
export interface FactoryLink {
  factoryId: string;
  factoryName: string;
  /** The side session a question runs in. */
  sessionId?: string;
  /** The card a hand-over created. */
  workItemId?: string;
  url?: string;
}

/** A request: one thread, one topic line. */
export interface AssistantRequest {
  id: string;
  owner: AssistantOwner;
  /** What it is about: the topic line's title. */
  topic: string;
  /** Who it is from, when the person said so (a colleague's or client's name). */
  fromName: string | null;
  source: RequestSource;
  /** The original, when the person pasted a link to it. */
  sourceUrl: string | null;
  /**
   * The source thread the request is bound to (`platform:workspace:channel:thread`), for requests a
   * source made; `null` for manual ones. A new message in that thread joins the open request.
   */
  sourceKey: string | null;
  /** The closed request of the same source thread this one continues. */
  previousRequestId: string | null;
  status: RequestStatus;
  factory: FactoryLink | null;
  /** The agent is working on the latest message now. */
  analysing: boolean;
  /** Why the agent's last turn failed, shown in the thread; cleared by the next turn. */
  lastError: TurnFailure | null;
  /** True until the person opened the thread after the agent last wrote to it. */
  unread: boolean;
  /**
   * What the agent (or a channel rule past its limit) proposed to do outside the assistant —
   * ask a Factory, hand the request over — waiting for the person's Confirm or Cancel. Nothing
   * that changes something in a Factory runs without it.
   */
  pendingAction: PendingAction | null;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
}

/**
 * Who wrote an entry in a request's thread: the person (to the agent), the agent, a Factory, an
 * event line, or `source` — a message read from a source (a colleague's, or the person's own reply
 * there), with its author's name in `fromName`.
 */
export const MESSAGE_AUTHORS = ['person', 'agent', 'factory', 'event', 'source'] as const;
export type MessageAuthor = (typeof MESSAGE_AUTHORS)[number];

/** One tool call of an agent turn, as the thread's «Turn details» shows it: summaries, never whole payloads. */
export interface ToolCallRecord {
  name: string;
  /** The arguments, as short JSON. */
  args: string;
  /** The answer, as short JSON; absent when the call failed. */
  result?: string;
  /** Why it failed (a thrown error, or the `{ error }` the tool answered with). */
  error?: string;
  durationMs: number;
}

/**
 * What drove one agent reply (ADR-0051 transparency): the model that ran, the version of the
 * system prompt (a hash of the whole effective text), the skills it could load, and every tool
 * call with its outcome.
 */
export interface TurnDetails {
  modelId: string | null;
  instructionsVersion: string;
  skills: string[];
  toolCalls: ToolCallRecord[];
  durationMs: number;
}

/** One entry of a request's thread. */
export interface AssistantMessage {
  id: string;
  requestId: string;
  author: MessageAuthor;
  /** Who wrote a `source` entry (as the source names them); `null` otherwise. */
  fromName: string | null;
  text: string;
  fileIds: string[];
  /** On an agent reply: what drove it. `null` elsewhere (and on replies from before it was kept). */
  details: TurnDetails | null;
  createdAt: Date;
}

/** A note the person (or the agent, for the person) keeps; optionally about one request. */
export interface AssistantNote {
  id: string;
  owner: AssistantOwner;
  requestId: string | null;
  text: string;
  author: 'person' | 'agent';
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The actions that wait for the person's confirmation: asking a Factory and handing a request over
 * (they change something in a Factory), a workspace tool call the permission rules say to ask about
 * (`workspace_tool`: a command, an edit), and downloading from a host none of the person's sources
 * owns (`download`).
 */
export const PENDING_ACTION_KINDS = ['ask', 'hand_over', 'workspace_tool', 'download'] as const;
export type PendingActionKind = (typeof PENDING_ACTION_KINDS)[number];
export type FactoryActionKind = Extract<PendingActionKind, 'ask' | 'hand_over'>;

interface PendingActionBase {
  id: string;
  /** Why the agent proposes it, in a sentence the person reads. */
  reason?: string;
  /** The agent proposed it, or a channel rule whose auto-ask limit was spent. */
  proposedBy: 'agent' | 'rule';
  proposedAt: Date;
}

/** A proposed Factory action on a request: shown in the thread with Confirm / Cancel. */
export interface FactoryPendingAction extends PendingActionBase {
  kind: FactoryActionKind;
  factoryId: string;
  factoryName: string;
  /** `ask`: the question the side session gets. */
  question?: string;
  /** `hand_over`: the card's title and the note above the request's summary. */
  title?: string;
  note?: string;
  /** `hand_over`: workspace files (paths in the request's folder) the card gets besides the request's files. */
  workspaceFiles?: string[];
}

/** A workspace tool call that asks first: run exactly as proposed once the person confirms. */
export interface WorkspaceToolPendingAction extends PendingActionBase {
  kind: 'workspace_tool';
  /** The tool's name as the agent calls it (`execute_command`, `write_file`, …). */
  toolName: string;
  /** Its arguments, exactly as they will run. */
  args: Record<string, unknown>;
  /** What the person reads: the command line, or the file it writes. */
  summary: string;
}

/** A download from a host none of the person's sources owns: fetched without credentials once confirmed. */
export interface DownloadPendingAction extends PendingActionBase {
  kind: 'download';
  url: string;
  /** The file name it gets in the request's folder. */
  name: string;
}

export type PendingAction = FactoryPendingAction | WorkspaceToolPendingAction | DownloadPendingAction;

/** How often the assistant writes the person a digest request; `off` by default. */
export const DIGEST_FREQUENCIES = ['off', 'hourly', 'daily'] as const;
export type DigestFrequency = (typeof DIGEST_FREQUENCIES)[number];

export interface DigestSettings {
  frequency: DigestFrequency;
  /** The hour (0–23, in `timeZone`) a daily digest is written. */
  hour: number;
  /** IANA time zone of `hour`, e.g. `Europe/Kyiv`. */
  timeZone: string;
}

export const DEFAULT_DIGEST: DigestSettings = { frequency: 'off', hour: 9, timeZone: 'UTC' };

/** The person's assistant settings in one organization. */
export interface AssistantSettings {
  /** A model of the organization's; `null` → the organization's default. */
  modelId: string | null;
  /** Closed requests and their files are erased this many days after closing. */
  retentionDays: number;
  /** Skills (by name), from the Factory catalogue or the person's own, the agent may load. */
  skills: string[];
  digest: DigestSettings;
}

/** The person's version of the base instructions (one Markdown document) is at most this long. */
export const MAX_INSTRUCTIONS = 20_000;
export const MAX_SKILLS = 10;
/** A skill's text (the person's override or own skill), and its one-line description. */
export const MAX_SKILL_INSTRUCTIONS = 20_000;
export const MAX_SKILL_DESCRIPTION = 500;
/** Skills of the person's own (not overrides) per assistant. */
export const MAX_OWN_SKILLS = 30;
/** A skill's name: what the agent loads it by. */
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * A skill the person keeps for their assistant only: an `override` of a Factory catalogue skill
 * (the original and every Factory's edits stay untouched) or a `personal` skill of their own.
 */
export interface OwnSkill {
  name: string;
  kind: 'override' | 'personal';
  description: string;
  instructions: string;
  createdAt: Date;
  updatedAt: Date;
}

/** The base instructions as the person keeps them: `null` → the shipped default. */
export interface BehaviorDocument {
  document: string | null;
  updatedAt: Date | null;
}

export const DEFAULT_RETENTION_DAYS = 30;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 365;

/** A file of a request: a screenshot or a document the person brought. Bytes are in the blob store under `sha256`. */
export interface AssistantFile {
  id: string;
  owner: AssistantOwner;
  requestId: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  createdAt: Date;
}

/** Why an assistant was erased, for the audit entry (never its content). */
export type AssistantClearReason = 'member_removed' | 'account_deleted' | 'cleared_by_person';

/**
 * How the assistant reads one channel of a source (ADR-0051): `ignore` (the default for a channel),
 * `addressed` — only what is addressed to the person: a direct message, a mention, a reply in a
 * thread they are in (the default for DMs) — or `watch`, where every new thread becomes a request.
 */
export const CHANNEL_MODES = ['ignore', 'addressed', 'watch'] as const;
export type ChannelMode = (typeof CHANNEL_MODES)[number];

export function isChannelMode(value: unknown): value is ChannelMode {
  return typeof value === 'string' && (CHANNEL_MODES as readonly string[]).includes(value);
}

/**
 * What the assistant does with a new request from a channel (phase 3): `analyse` (the default) —
 * the agent's report; `analyse_and_ask` — the report, then the channel's Factory is asked on its
 * own (a side session, which costs: only when the person turned it on for the channel, never by
 * default, and within a daily limit); `digest_only` — no turn per message, the request goes into
 * the next digest.
 */
export type ChannelRule = { kind: 'analyse' } | { kind: 'analyse_and_ask'; factoryId: string } | { kind: 'digest_only' };

export const DEFAULT_CHANNEL_RULE: ChannelRule = { kind: 'analyse' };

/** `analyse`, `analyse_and_ask:<factoryId>`, `digest_only` → the rule; anything else → `null`. */
export function parseChannelRule(value: unknown): ChannelRule | null {
  if (value === 'analyse' || value === 'digest_only') return { kind: value };
  if (typeof value !== 'string') return null;
  const match = /^analyse_and_ask:([A-Za-z0-9._-]{1,128})$/.exec(value);
  return match ? { kind: 'analyse_and_ask', factoryId: match[1]! } : null;
}

export function formatChannelRule(rule: ChannelRule): string {
  return rule.kind === 'analyse_and_ask' ? `analyse_and_ask:${rule.factoryId}` : rule.kind;
}
