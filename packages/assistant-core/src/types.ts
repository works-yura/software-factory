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

/** One entry of a request's thread. */
export interface AssistantMessage {
  id: string;
  requestId: string;
  author: MessageAuthor;
  /** Who wrote a `source` entry (as the source names them); `null` otherwise. */
  fromName: string | null;
  text: string;
  fileIds: string[];
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

/** The actions that change something in a Factory, so they wait for the person's confirmation. */
export const PENDING_ACTION_KINDS = ['ask', 'hand_over'] as const;
export type PendingActionKind = (typeof PENDING_ACTION_KINDS)[number];

/** A proposed Factory action on a request: shown in the thread with Confirm / Cancel. */
export interface PendingAction {
  id: string;
  kind: PendingActionKind;
  factoryId: string;
  factoryName: string;
  /** `ask`: the question the side session gets. */
  question?: string;
  /** `hand_over`: the card's title and the note above the request's summary. */
  title?: string;
  note?: string;
  /** Why the agent proposes it, in a sentence the person reads. */
  reason?: string;
  /** The agent proposed it, or a channel rule whose auto-ask limit was spent. */
  proposedBy: 'agent' | 'rule';
  proposedAt: Date;
}

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
  /** The person's own instructions, appended to the assistant's base instructions. */
  instructions: string;
  /** Skills (by name) from the Factory skills catalogue the agent may load. */
  skills: string[];
  digest: DigestSettings;
}

export const MAX_INSTRUCTIONS = 4000;
export const MAX_SKILLS = 10;

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
