import { randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';

import type {
  AgentEvent,
  AgentEventListener,
  AgentNotificationInput,
  AgentNotificationOptions,
  AgentNotificationResult,
  AgentRunContext,
  AgentRunEndReason,
  AgentSession,
  AgentSignalInput,
  AgentSignalResult,
  PlanDecision,
  TurnHandoffContext,
  TurnHandoffHook,
} from '@factory/harness';
import type { HarnessCommand } from '@factory/harness/executable';
import type { ModelSelection } from '@factory/harness/models/contracts';
import { promptWithTurnHandoff } from '@factory/harness/turn-handoff';
import {
  isUsageLimitFailure,
  nextUsageLimitPark,
  USAGE_LIMIT_RESUME_PROMPT,
  usageLimitExpiredMessage,
  usageLimitResumeOutcome,
  type UsageLimitPark,
  type UsageLimitParkEvent,
  type UsageLimitResumeResult,
} from '@factory/harness/usage-limit-park';
import { splitQuestionAnswers } from '@factory/harness/elicitation';
import {
  ASK_USER_QUESTION_TOOL,
  askUserPrompt,
  type MessageAuthor,
  type NotificationRecord,
  type PermissionRequest,
  type PlanGate,
  type TranscriptEntry,
} from '@factory/harness/transcript';
import { claudeNotificationDecision } from '@factory/harness-claude-code/notifications';

import { OpenCodeHttpError, type OpenCodeClient, type OpenCodePermissionReply } from './client.ts';
import { openCodeConfigContent, openCodePermissionRules, type OpenCodeMcpServer, type OpenCodeTurnPolicy } from './config.ts';
import { buildOpenCodeEnv, openCodeAuthContent, openCodeStateDirs, type OpenCodeStateDirs } from './env.ts';
import { OpenCodeError } from './errors.ts';
import { OpenCodeTurnTranslator, type OpenCodeQuestion, type OpenCodeTurnOutcome } from './events.ts';
import { DEFAULT_OPENCODE_START_TIMEOUT_MS, openCodeServerPassword, spawnOpenCodeServer, type OpenCodeServerProcess, type OpenCodeSpawn } from './server.ts';
import {
  emptyOpenCodeThreadState,
  type OpenCodePendingInput,
  type OpenCodeSessionMode,
  type OpenCodeSessionRecord,
  type OpenCodeSessionStore,
  type OpenCodeThreadState,
} from './store.ts';

/** How many delivered signal ids and dedupe keys a thread remembers. */
const RECENT_LIMIT = 200;
/** How long a live approval or question keeps its turn (and its server) waiting before it falls back to the next turn. */
const DEFAULT_PARK_TIMEOUT_MS = 30 * 60_000;
/** How long an aborted turn may take to stop before its server is ended. */
const ABORT_GRACE_MS = 3_000;

/** The request-context key a person's identity travels under when they write (Mastra's message author key). */
export const MESSAGE_AUTHOR_KEY = 'mastra__messageAuthor';

export function messageAuthor(requestContext: AgentRunContext | undefined): MessageAuthor | undefined {
  const value = requestContext?.get(MESSAGE_AUTHOR_KEY);
  if (!value || typeof value !== 'object') return undefined;
  const { id, name, avatarUrl } = value as Record<string, unknown>;
  if (typeof id !== 'string' || !id) return undefined;
  return { id, ...(typeof name === 'string' ? { name } : {}), ...(typeof avatarUrl === 'string' ? { avatarUrl } : {}) };
}

/** Leads a planning turn unless the host gives its own. */
export const OPENCODE_PLANNING_PROMPT =
  'You are planning. Investigate read-only and write the plan; make no changes. A person approves the plan before you implement it.';

/** What one turn sends, from the model facet: OpenCode's `providerID/modelID`, its variant, and the switch marker. */
export interface OpenCodeTurnModelSelection {
  /** `opencode/big-pickle`: OpenCode's provider and model. */
  model?: string;
  /** The model's reasoning variant (`low`, `high`, …). */
  variant?: string;
  modelSwitch?: { from: ModelSelection; to: ModelSelection };
}

export type OpenCodeTranscriptListener = (entry: TranscriptEntry, meta: { runId: string; threadId: string }) => void;

/** How a person's chat message joins the session (the chat's message, follow-up and steer routes). */
export type OpenCodeChatDelivery = 'message' | 'follow-up' | 'steer';

/** Emitted whenever the number of queued follow-ups changes, as a Mastra session does. */
export interface OpenCodeFollowUpQueuedEvent {
  type: 'follow_up_queued';
  count: number;
}

export type OpenCodeNotificationInput = AgentNotificationInput & {
  id?: string;
  coalesceKey?: string;
  attributes?: Record<string, string | number | boolean | null | undefined>;
  metadata?: Record<string, unknown>;
};

/**
 * Configuration for OpenCode sessions. Each run starts an `opencode serve` in the session's
 * checkout with the session's own state folders, goes on in (or starts) the thread's OpenCode
 * session, and runs turns there; the server ends with the run, unless the run parked on a live
 * approval or question (then it waits, up to `parkTimeoutMs`, for the answer to resume the turn).
 */
export interface OpenCodeSessionConfig {
  store: OpenCodeSessionStore;
  /** The session's working directory; asked once, before its first turn. */
  cwdFor: (sessionId: string) => string | Promise<string>;
  /**
   * The session's own state root (its OpenCode database, config and state), stable per session so
   * a later run goes on in its OpenCode session. Required: the person's own OpenCode folders are never used.
   */
  stateRootFor: (session: OpenCodeSession) => string;
  /** One cache folder for every session (the model list and plugins OpenCode downloads); per session when unset. */
  sharedCacheDir?: string;
  /** The CLI: a path, or the server's resolver (`@factory/harness/executable`); `opencode` on PATH by default. */
  command?: HarnessCommand;
  spawn?: OpenCodeSpawn;
  /** The environment the CLI inherits from; `process.env` by default (only the allowlisted names pass). */
  env?: Record<string, string | undefined>;
  /** More variable names the CLI may inherit. */
  passEnv?: string[];
  /**
   * More environment for this session's server, asked when the run opens it: e.g. a checkout someone
   * outside wrote reads no project config (`OPENCODE_DISABLE_PROJECT_CONFIG`).
   */
  envFor?: (session: OpenCodeSession) => Record<string, string> | undefined | Promise<Record<string, string> | undefined>;
  /** The model fields of the session's next turn (the harness's model facet), asked before each turn. */
  turnSelectionFor?: (session: OpenCodeSession) => OpenCodeTurnModelSelection | undefined | Promise<OpenCodeTurnModelSelection | undefined>;
  /** The session's instructions (the Factory's playbook), sent as each turn's system prompt. */
  developerInstructions?: string;
  developerInstructionsFor?: (session: OpenCodeSession) => string | undefined | Promise<string | undefined>;
  /** Context the agent reads ahead of this turn's input (the Factory's signals); the transcript does not show it. */
  turnContextFor?: (session: OpenCodeSession) => string | undefined | Promise<string | undefined>;
  /**
   * Context a turn carries over from another conversation (`@factory/harness/turn-handoff`): asked
   * before every turn, with `resume_failed` when the thread's OpenCode session was gone and a new one
   * started. Its context goes ahead of the prompt.
   */
  handoffContextFor?: TurnHandoffHook<OpenCodeSession>;
  /** MCP servers for the run (the Factory's tools with a token minted for it). */
  mcpServersFor?: (session: OpenCodeSession) => Record<string, OpenCodeMcpServer> | undefined | Promise<Record<string, OpenCodeMcpServer> | undefined>;
  /** How the run may act; edits and commands ask by default. */
  policyFor?: (session: OpenCodeSession) => OpenCodeTurnPolicy | undefined | Promise<OpenCodeTurnPolicy | undefined>;
  /** Mode a new thread starts in; `planning` to start with a plan for approval. */
  mode?: OpenCodeSessionMode;
  /** Leads every planning turn's prompt; {@link OPENCODE_PLANNING_PROMPT} by default. */
  planningPrompt?: string;
  /**
   * The OpenCode account a run signs in with (Settings → Connections → OpenCode): its key goes to the
   * run's server inline (`OPENCODE_AUTH_CONTENT`), never into a file. `undefined`: the run signs in
   * with nothing and only OpenCode's free models answer.
   */
  credentials?: (session: OpenCodeSession, request: OpenCodeCredentialRequest) => Promise<OpenCodeTurnCredentials | undefined>;
  /** Told when a run's account hit a usage limit or was refused, before the run settles. */
  onCredentialFailure?: (session: OpenCodeSession, failure: { accountId: string; error: OpenCodeError }) => void | Promise<void>;
  /**
   * When usage comes back after a run hit a limit: the account's usage windows, or now when another
   * account can take over. `undefined` when nobody knows (OpenCode's free models never say): the run
   * then fails with the provider's words instead of parking.
   */
  usageLimitResetsAt?: (session: OpenCodeSession, failure: { accountId?: string; error: OpenCodeError }) => Promise<Date | undefined>;
  /**
   * Whether a run that hit a usage limit with a known reset parks the session until then
   * (`usageLimitPark`, `usage_limit_parked`) instead of failing; the host resumes it then.
   */
  parkOnUsageLimit?: (session: OpenCodeSession) => boolean | Promise<boolean>;
  turnTimeoutMs?: number;
  parkTimeoutMs?: number;
  /** How long the server gets to start (see `spawnOpenCodeServer`). */
  startTimeoutMs?: number;
  /** Tests: the HTTP client's fetch. */
  fetch?: typeof fetch;
}

/** What a run asks the credentials hook. */
export interface OpenCodeCredentialRequest {
  /** The account the session ran on last; staying on it keeps the provider's cache. */
  preferredAccountId?: string;
  exclude: string[];
}

/** One OpenCode account's key for a run, and how the chat names it. */
export interface OpenCodeTurnCredentials {
  accountId: string;
  apiKey: string;
  credential: { label: string; ownerId?: string };
}

/** One turn of history from elsewhere (the person's own OpenCode): what was asked, then what came back. */
export interface OpenCodeImportedTurn {
  /** The person's message; absent for a reply with no message before it. */
  input?: string;
  /** The reply as transcript entries (text, thinking, tool calls and their results). */
  entries: TranscriptEntry[];
  model?: string;
}

/** Where an imported thread's history came from. */
export interface OpenCodeImportSource {
  openCodeSessionId: string;
  directory: string;
  title: string;
}

interface ActiveRun {
  runId: string;
  threadId: string;
  queue: OpenCodePendingInput[];
  unsent?: OpenCodePendingInput[];
  server?: OpenCodeServerProcess;
  client?: OpenCodeClient;
  /** Stops the run's event stream. */
  stream?: AbortController;
  /** The MCP servers the run's server was started with (their tools' names). */
  mcpServers?: string[];
  /** The OpenCode session the run's server has open. */
  openCodeSessionId?: string;
  /** The thread's OpenCode session was gone when the run opened it: a new one started. */
  resumeFailed?: boolean;
  /** The OpenCode account the run's server signed in with. */
  accountId?: string;
  /** The usage-limit park this run took up (its first park counts toward the cap). */
  priorPark?: UsageLimitPark;
  watch?: TurnWatch;
  begun?: boolean;
  abortRequested: boolean;
  settled: boolean;
  policy?: OpenCodeTurnPolicy;
  /** The permission rules the run's server started with: a turn under other rules needs a server of its own. */
  rules?: string;
  adopted?: ParkedTurn;
  started: Promise<void>;
  markStarted(error?: unknown): void;
  ended: Promise<AgentRunEndReason>;
  resolveEnded(reason: AgentRunEndReason): void;
  loopDone: Promise<void>;
}

/** A turn in flight: its translator, and how it ends. */
interface TurnWatch {
  translator: OpenCodeTurnTranslator;
  finish(outcome: TurnResult): void;
  done: Promise<TurnResult>;
}

type ParkAnswer = { reply: OpenCodePermissionReply } | { answers: string[][] } | { dismissed: true };

type TurnResult = OpenCodeTurnOutcome | { kind: 'permission'; request: PermissionRequest; respond: (answer: ParkAnswer) => void; questions?: OpenCodeQuestion[] };

/** A turn that waits, in its live server, for a person's answer. */
interface ParkedTurn {
  server: OpenCodeServerProcess;
  client: OpenCodeClient;
  stream: AbortController;
  mcpServers: string[];
  watch: TurnWatch;
  request: PermissionRequest;
  respond: (answer: ParkAnswer) => void;
  questions?: OpenCodeQuestion[];
  openCodeSessionId: string;
  threadId: string;
  timer: NodeJS.Timeout;
}

type Accepted = { action: 'deliver' | 'wake'; run: ActiveRun } | { action: 'persist' };

const escapeAttribute = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const escapeNotificationBody = (value: string) => value.replace(/<(\/?)system-notification/gi, (_match, slash: string) => `&lt;${slash}system-notification`);

function formatNotification(input: Pick<NotificationRecord, 'source' | 'kind' | 'payload' | 'summary'> & { priority?: string }): string {
  const attrs = [`source="${escapeAttribute(input.source)}"`, `kind="${escapeAttribute(input.kind)}"`];
  if (input.priority) attrs.push(`priority="${escapeAttribute(input.priority)}"`);
  const payload = input.payload as { message?: unknown; body?: unknown } | undefined;
  const detail = [payload?.message, payload?.body].find((value): value is string => typeof value === 'string' && value.trim() !== '' && value !== input.summary);
  const body = escapeNotificationBody(detail ? `${input.summary}\n\n${detail}` : input.summary);
  return `<system-notification ${attrs.join(' ')}>\n${body}\n</system-notification>`;
}

function approvalPrompt(decision: PlanDecision): string {
  const parts = ['The plan was approved. Implement it.'];
  if (decision.plan?.trim()) parts.push(`The reviewer edited the plan; implement this version:\n\n${decision.plan.trim()}`);
  if (decision.feedback?.trim()) parts.push(`Reviewer notes:\n${decision.feedback.trim()}`);
  return parts.join('\n\n');
}

function rejectionPrompt(decision: PlanDecision): string {
  const parts = ['The plan was not approved.'];
  if (decision.feedback?.trim()) parts.push(`Reviewer feedback:\n${decision.feedback.trim()}`);
  parts.push('Make no changes. Revise the plan and present it again.');
  return parts.join('\n\n');
}

function permissionPrompt(request: PermissionRequest, approved: boolean): string {
  const tool = `\`${request.toolName}\``;
  if (approved && request.once) {
    return `The person allowed this one ${tool} call. Retry the call that was waiting for permission, then go on; another ${tool} call will ask again.`;
  }
  return approved
    ? `The person allowed ${tool} for the rest of this session. Retry the call that was waiting for permission, then go on.`
    : `The person denied permission for the ${tool} call that was waiting. Do not retry it or work around it; go on without it, or say what you would need it for.`;
}

function answerPrompt(request: PermissionRequest, answer: string): string {
  const prompt = askUserPrompt(request.input);
  return [`You asked the person:`, prompt.question, `Their answer:\n${answer}`, 'Go on with that answer; do not ask the same question again.'].join('\n\n');
}

function remember(list: string[], value: string): string[] {
  if (list.includes(value)) return list;
  const next = [...list, value];
  return next.length > RECENT_LIMIT ? next.slice(next.length - RECENT_LIMIT) : next;
}

/** OpenCode takes a turn as text, so a skill kickoff travels in the `<skill name="…">` envelope. */
function signalText(input: AgentSignalInput): string {
  if (input.type === 'system-reminder') throw new Error('OpenCode holds no goals: a goal reminder cannot reach it.');
  if (input.tagName !== 'skill') return input.contents;
  const contents = input.contents.replace(/<\/skill\s*>/gi, match => match.replace('<', '&lt;').replace('>', '&gt;'));
  return `<skill name="${input.attributes.name.replaceAll('"', '&quot;')}">\n${contents}\n</skill>`;
}

/**
 * OpenCode's answers to its questions from a person's answer to the card: the chat sends a card of
 * several questions as one text, each answer under its numbered question; it is split back.
 */
export function openCodeQuestionAnswers(questions: readonly OpenCodeQuestion[], answer: string | string[]): string[][] {
  if (questions.length <= 1) {
    const values = (Array.isArray(answer) ? answer : [answer]).map(value => value.trim()).filter(Boolean);
    return [values];
  }
  const answers = splitQuestionAnswers(
    questions.map(question => question.question),
    answer,
  );
  return questions.map((_, index) => (answers[index] ? [answers[index]!] : []));
}

/** `opencode/big-pickle` as OpenCode's `{ providerID, modelID }`. */
export function openCodeModelRef(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

function newTurnWatch(translator: OpenCodeTurnTranslator): TurnWatch {
  let finish!: (outcome: TurnResult) => void;
  let settled = false;
  const done = new Promise<TurnResult>(resolve => {
    finish = outcome => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
  });
  return { translator, finish, done };
}

/**
 * One Factory session on OpenCode. A run is a chain of turns in one `opencode serve`: input that
 * arrives mid-turn is queued and sent as the next turn before the run ends. An approval or a
 * question ends the run `suspended` while its turn waits in the live server; the answer resumes
 * that turn. A plan written in planning mode parks the thread on a plan gate.
 */
export class OpenCodeSession implements AgentSession {
  readonly id: string;
  readonly #config: OpenCodeSessionConfig;
  #record: OpenCodeSessionRecord;
  #run: ActiveRun | undefined;
  #parked: ParkedTurn | undefined;
  #barrier: Promise<void> = Promise.resolve();
  #listeners = new Set<AgentEventListener>();
  #transcriptListeners = new Set<OpenCodeTranscriptListener>();
  #saving: Promise<void> = Promise.resolve();

  constructor(record: OpenCodeSessionRecord, config: OpenCodeSessionConfig) {
    this.id = record.sessionId;
    this.#record = record;
    this.#config = config;
    this.#threadState(record.threadId);
  }

  /** The harness the chat and the run reports read this session as. */
  readonly harness = 'opencode' as const;
  /** The models' provider, stamped beside a reply's model id. */
  readonly modelProvider = 'opencode';

  get resourceId(): string | undefined {
    return this.#record.resourceId;
  }

  get cwd(): string | undefined {
    return this.#record.cwd;
  }

  /** OpenCode's session id for the current thread, once its first turn started. */
  get openCodeSessionId(): string | undefined {
    return this.#threadState().openCodeSessionId;
  }

  get mode(): OpenCodeSessionMode | undefined {
    return this.#threadState().mode ?? this.#config.mode;
  }

  async setMode(mode: OpenCodeSessionMode): Promise<void> {
    this.#threadState().mode = mode;
    await this.#save();
  }

  get pendingPlan(): PlanGate | undefined {
    const gate = this.#threadState().pendingGate;
    return gate ? { ...gate } : undefined;
  }

  get pendingPermission(): PermissionRequest | undefined {
    const request = this.#threadState().pendingPermission;
    return request ? structuredClone(request) : undefined;
  }

  get grantedTools(): string[] {
    return [...(this.#threadState().grantedTools ?? [])];
  }

  get runId(): string | undefined {
    return this.#run?.runId;
  }

  get queuedFollowUps(): number {
    return (this.#threadState().followUps ?? []).filter(input => input.kind === 'signal').length;
  }

  /**
   * Set while the current thread waits for a usage limit to reset. Only a limit whose reset is known
   * parks (an account's usage window, another account free): OpenCode's free models say when their
   * allowance ran out but not when it comes back, so such a run fails with their words.
   */
  get usageLimitPark(): UsageLimitPark | undefined {
    const park = this.#threadState().usageLimitPark;
    return park ? { ...park } : undefined;
  }

  /** Takes a session parked on a usage limit up again now; still limited, it parks anew. */
  async resumeFromUsageLimit(): Promise<UsageLimitResumeResult> {
    if (this.run.isRunning()) return { action: 'running' };
    if (!this.#threadState().usageLimitPark) return { action: 'not_parked' };
    const accepted = this.#accept([], true);
    if (accepted.action !== 'wake') return { action: 'running' };
    return usageLimitResumeOutcome(accepted.run, () => this.usageLimitPark);
  }

  /** The OpenCode account the session's last run signed in with; none when it ran the free models. */
  get accountId(): string | undefined {
    return this.#record.accountId;
  }

  /** Where the thread's history came from, when it was imported from the person's own OpenCode. */
  get importedFrom(): (OpenCodeImportSource & { importedAt: string }) | undefined {
    return this.#record.importedFrom ? { ...this.#record.importedFrom } : undefined;
  }

  /**
   * Writes history from the person's own OpenCode into the current thread, as the transcript
   * records a turn: its message, then its reply. Only a session that never ran takes it. OpenCode
   * itself starts a new conversation on the first turn, which carries this history (the host's
   * context handoff).
   */
  async importHistory(turns: readonly OpenCodeImportedTurn[], source: OpenCodeImportSource): Promise<void> {
    if (this.#run || this.#threadState().openCodeSessionId || this.#record.importedFrom) {
      throw new Error('Only a session that has not run yet takes imported history.');
    }
    const threadId = this.#record.threadId;
    for (const turn of turns) {
      const meta = { runId: randomUUID(), threadId };
      if (turn.input !== undefined) this.#emitTranscript({ kind: 'input', source: 'signal', text: turn.input }, meta);
      this.#emitTranscript({ kind: 'init', sessionId: source.openCodeSessionId, ...(turn.model ? { model: turn.model } : {}) }, meta);
      for (const entry of turn.entries) this.#emitTranscript(entry, meta);
      this.#emitTranscript({ kind: 'result', subtype: 'success', isError: false }, meta);
    }
    this.#record.importedFrom = { ...source, importedAt: new Date().toISOString() };
    await this.#save();
  }

  /** Whether a parked approval or question still has its turn waiting in a live server. */
  get hasLiveGate(): boolean {
    return this.#parked !== undefined;
  }

  readonly thread = {
    getId: (): string | undefined => this.#record.threadId,
    requireId: (): string => this.#record.threadId,
    switch: async ({ threadId }: { threadId: string }): Promise<void> => {
      if (threadId === this.#record.threadId) return;
      if (this.#run) throw new Error('Cannot switch threads while a run is in flight.');
      this.#dropParked();
      this.#record.threadId = threadId;
      this.#threadState(threadId);
      await this.#save();
    },
    listActiveMessages: async (): Promise<Array<{ id: string }>> => this.#threadState().deliveredIds.map(id => ({ id })),
    getSetting: async ({ key }: { key: string }): Promise<unknown> => this.#threadState().settings[key],
    setSetting: async ({ key, value }: { key: string; value: unknown }): Promise<void> => {
      this.#threadState().settings[key] = value;
      await this.#save();
    },
  };

  readonly stream = {
    isActive: (): boolean => !!this.#run && !this.#run.settled && !!this.#run.server?.isAlive(),
  };

  readonly run = {
    isRunning: (): boolean => !!this.#run && !this.#run.settled,
  };

  readonly suspensions = {
    hasPending: (): boolean => this.#threadState().pendingGate !== undefined || this.#threadState().pendingPermission !== undefined,
  };

  subscribe(listener: AgentEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onTranscript(listener: OpenCodeTranscriptListener): () => void {
    this.#transcriptListeners.add(listener);
    return () => this.#transcriptListeners.delete(listener);
  }

  /** Stops the run now: `agent_end: aborted` before this returns; OpenCode is told to stop the turn behind it. */
  abort(): void {
    this.#abort(true);
  }

  /** Ends the session's servers (a parked turn included); what it persisted stays. */
  dispose(): void {
    this.#abort(false);
    this.#dropParked();
  }

  #abort(drainFollowUps: boolean): void {
    const run = this.#run;
    if (!run || run.settled) return;
    run.abortRequested = true;
    this.#interrupt(run);
    this.#settle(run, 'aborted', { drainFollowUps });
  }

  async sendMessage(input: { content: string; requestContext?: AgentRunContext }): Promise<unknown> {
    const author = messageAuthor(input.requestContext);
    const accepted = this.#accept([{ kind: 'signal', text: input.content, ...(author ? { author } : {}) }], true);
    if (accepted.action === 'persist') return undefined;
    if (accepted.action === 'wake') await accepted.run.started;
    return { reason: await accepted.run.ended };
  }

  /**
   * A person's chat message: `message` starts or joins a run, `follow-up` waits for it, `steer`
   * stops it and starts over with the message (OpenCode cannot take input into a turn in flight).
   */
  async sendChatMessage(input: { content: string; requestContext?: AgentRunContext; delivery?: OpenCodeChatDelivery }): Promise<{ action: 'wake' | 'deliver' | 'queued' }> {
    const author = messageAuthor(input.requestContext);
    const message: OpenCodePendingInput = { kind: 'signal', text: input.content, ...(author ? { author } : {}) };
    const delivery = input.delivery ?? 'message';
    if (delivery === 'follow-up' && this.run.isRunning()) {
      const thread = this.#threadState();
      thread.followUps = [...(thread.followUps ?? []), message];
      await this.#save();
      this.#emitFollowUpCount();
      return { action: 'queued' };
    }
    if (delivery === 'steer') this.#abort(false);
    const accepted = this.#accept([message], true);
    if (accepted.action === 'persist') throw new Error('unreachable: chat messages always wake');
    return { action: accepted.action };
  }

  sendSignal(input: AgentSignalInput, options: { requestContext: AgentRunContext; requireDelivery?: boolean }): AgentSignalResult {
    let accepted: Accepted;
    const author = messageAuthor(options.requestContext);
    try {
      accepted = this.#accept([{ kind: 'signal', id: input.id, text: signalText(input), ...(author ? { author } : {}) }], true);
    } catch (error) {
      return { accepted: Promise.reject(error) };
    }
    if (accepted.action === 'persist') throw new Error('unreachable: signals always wake');
    const result = { accepted: true as const, runId: accepted.run.runId, action: accepted.action };
    if (accepted.action === 'wake' && options.requireDelivery) return { accepted: accepted.run.started.then(() => result) };
    return { accepted: Promise.resolve(result) };
  }

  /** Gives the agent a notification as a Mastra session's delivery policy would. */
  async sendNotificationSignal(input: OpenCodeNotificationInput, options: AgentNotificationOptions = {}): Promise<AgentNotificationResult> {
    const thread = this.#threadState();
    if (input.dedupeKey && thread.dedupeKeys.includes(input.dedupeKey)) {
      return { persisted: Promise.resolve(), accepted: Promise.resolve({ action: 'deliver' }) };
    }
    if (input.dedupeKey) thread.dedupeKeys = remember(thread.dedupeKeys, input.dedupeKey);
    const record = this.#notificationRecord(thread, input);
    const text = formatNotification({ ...record, priority: input.priority });
    const pending: OpenCodePendingInput = { kind: 'notification', text, notification: record };
    const active = this.run.isRunning();
    const allowed = active ? (options.ifActive?.behavior ?? 'deliver') === 'deliver' : (options.ifIdle?.behavior ?? 'persist') === 'wake';
    const decision = claudeNotificationDecision({ record, threadState: active ? 'active' : 'idle', now: new Date() });
    if (allowed && decision.action === 'summarize' && decision.deliverAt) {
      thread.followUps = [...(thread.followUps ?? []), pending];
      return { persisted: this.#save() };
    }
    if (!allowed || decision.action === 'summarize') {
      thread.pendingInputs.push(pending);
      return { persisted: this.#save() };
    }
    const accepted = this.#accept([pending], true);
    if (accepted.action === 'persist') return { persisted: this.#save() };
    const run = accepted.run;
    if (accepted.action === 'deliver') return { persisted: this.#save(), accepted: Promise.resolve({ action: 'deliver' }) };
    return { persisted: this.#save(), accepted: run.started.then(() => ({ action: 'wake', output: { consumeStream: () => run.ended } })) };
  }

  async respondToToolSuspension({ resumeData, toolCallId }: { resumeData: PlanDecision; toolCallId?: string }): Promise<void> {
    const thread = this.#threadState();
    if (!thread.pendingGate && thread.pendingPermission) {
      return this.respondToToolApproval({ approved: resumeData.action === 'approved', ...(toolCallId ? { toolCallId } : {}) });
    }
    const gate = thread.pendingGate;
    if (!gate) throw new Error('This session is not waiting on a person.');
    if (toolCallId && toolCallId !== gate.toolCallId) throw new Error(`This session is waiting on ${gate.toolCallId}, not ${toolCallId}.`);
    if (this.#run) throw new Error('Cannot answer a gate while a run is in flight.');
    thread.pendingGate = undefined;
    const approved = resumeData.action === 'approved';
    thread.mode = approved ? 'default' : 'planning';
    const text = approved ? approvalPrompt(resumeData) : rejectionPrompt(resumeData);
    const accepted = this.#accept([{ kind: 'signal', text, gate: true }], true, { keepGate: true });
    if (accepted.action === 'persist') return;
    this.#emitTranscript({ kind: 'plan_decision', toolCallId: gate.toolCallId, decision: { ...resumeData } }, accepted.run);
    await accepted.run.started;
  }

  /**
   * Answers the call the thread is parked on. With its turn still waiting, OpenCode gets the
   * decision and the turn goes on; otherwise (a restart, or it waited too long) the answer is the
   * next turn. Allowed, the tool is allowed for the rest of the thread.
   */
  async respondToToolApproval({ approved, toolCallId }: { approved: boolean; toolCallId?: string }): Promise<void> {
    const thread = this.#threadState();
    const request = thread.pendingPermission;
    if (!request) throw new Error('This session is not waiting on a permission.');
    if (toolCallId && toolCallId !== request.toolCallId) throw new Error(`This session is waiting on ${request.toolCallId}, not ${toolCallId}.`);
    if (this.#run) throw new Error('Cannot answer a permission while a run is in flight.');
    if (approved && request.toolName === ASK_USER_QUESTION_TOOL) throw new Error('This session is waiting on an answer to its question, not on a permission.');
    thread.pendingPermission = undefined;
    if (approved && !request.once) thread.grantedTools = [...new Set([...(thread.grantedTools ?? []), request.toolName])];
    const decision = { kind: 'permission_decision' as const, toolCallId: request.toolCallId, toolName: request.toolName, approved };
    const parked = this.#takeParked(request.toolCallId);
    if (parked) {
      const run = this.#adopt(parked, { reply: approved ? (request.once ? 'once' : 'always') : 'reject' });
      this.#emitTranscript(decision, run);
      await run.started;
      return;
    }
    const accepted = this.#accept([{ kind: 'signal', text: permissionPrompt(request, approved), gate: true }], true, { keepGate: true });
    if (accepted.action === 'persist') return;
    this.#emitTranscript(decision, accepted.run);
    await accepted.run.started;
  }

  /** Answers the question (`AskUserQuestion`) the thread is parked on. */
  async answerQuestion({ answer, toolCallId }: { answer: string | string[]; toolCallId?: string }): Promise<void> {
    const thread = this.#threadState();
    const request = thread.pendingPermission;
    if (!request || request.toolName !== ASK_USER_QUESTION_TOOL) throw new Error('This session is not waiting on a question.');
    if (toolCallId && toolCallId !== request.toolCallId) throw new Error(`This session is waiting on ${request.toolCallId}, not ${toolCallId}.`);
    if (this.#run) throw new Error('Cannot answer a question while a run is in flight.');
    const text = (Array.isArray(answer) ? answer.join(', ') : answer).trim();
    if (!text) throw new Error('The answer is empty.');
    thread.pendingPermission = undefined;
    const entry = { kind: 'question_answer' as const, toolCallId: request.toolCallId, answer: text };
    const parked = this.#takeParked(request.toolCallId);
    if (parked) {
      const run = this.#adopt(parked, { answers: openCodeQuestionAnswers(parked.questions ?? [], answer) });
      this.#emitTranscript(entry, run);
      await run.started;
      return;
    }
    const accepted = this.#accept([{ kind: 'signal', text: answerPrompt(request, text), gate: true }], true, { keepGate: true });
    if (accepted.action === 'persist') return;
    this.#emitTranscript(entry, accepted.run);
    await accepted.run.started;
  }

  /** Answers the plan gate without starting a run: the answer leads the next turn. */
  async queuePlanAnswer({ resumeData, toolCallId }: { resumeData: PlanDecision; toolCallId?: string }): Promise<void> {
    const thread = this.#threadState();
    const gate = thread.pendingGate;
    if (!gate) throw new Error('This session is not waiting on a person.');
    if (toolCallId && toolCallId !== gate.toolCallId) throw new Error(`This session is waiting on ${gate.toolCallId}, not ${toolCallId}.`);
    thread.pendingGate = undefined;
    const approved = resumeData.action === 'approved';
    thread.mode = approved ? 'default' : 'planning';
    const text = approved ? approvalPrompt(resumeData) : rejectionPrompt(resumeData);
    thread.pendingInputs.unshift({ kind: 'signal', text, gate: true, planDecision: { toolCallId: gate.toolCallId, decision: { ...resumeData } } });
    await this.#save();
  }

  // -- internals ------------------------------------------------------------

  #notificationRecord(thread: OpenCodeThreadState, input: OpenCodeNotificationInput): NotificationRecord {
    const fresh: NotificationRecord = {
      id: input.id ?? randomUUID(),
      source: input.source,
      kind: input.kind,
      priority: input.priority ?? 'medium',
      summary: input.summary,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
      ...(input.coalesceKey ? { coalesceKey: input.coalesceKey } : {}),
      coalescedCount: 1,
      ...(input.attributes ? { attributes: structuredClone(input.attributes) } : {}),
      ...(input.metadata ? { metadata: structuredClone(input.metadata) } : {}),
      createdAt: new Date().toISOString(),
    };
    if (!input.coalesceKey) return fresh;
    const matches = ({ notification }: OpenCodePendingInput) =>
      notification !== undefined && notification.coalesceKey === input.coalesceKey && notification.source === input.source && notification.kind === input.kind;
    for (const list of [thread.pendingInputs, thread.followUps ?? []]) {
      const index = list.findIndex(matches);
      if (index === -1) continue;
      const existing = list.splice(index, 1)[0]!.notification!;
      return {
        ...existing,
        summary: input.summary,
        priority: input.priority ?? existing.priority,
        ...(input.payload !== undefined || existing.payload !== undefined ? { payload: input.payload ?? existing.payload } : {}),
        coalescedCount: (existing.coalescedCount ?? 1) + 1,
        ...(input.attributes || existing.attributes ? { attributes: { ...existing.attributes, ...input.attributes } } : {}),
        ...(input.metadata || existing.metadata ? { metadata: { ...existing.metadata, ...input.metadata } } : {}),
      };
    }
    return fresh;
  }

  #emitFollowUpCount() {
    const event: OpenCodeFollowUpQueuedEvent = { type: 'follow_up_queued', count: this.queuedFollowUps };
    this.#emit(event as unknown as AgentEvent);
  }

  #echo(inputs: OpenCodePendingInput[], run: ActiveRun, whileActive = false, modelSwitch?: { from: ModelSelection; to: ModelSelection }) {
    let marker = modelSwitch;
    for (const input of inputs) {
      if (input.echoed) continue;
      if (input.planDecision) {
        this.#emitTranscript({ kind: 'plan_decision', ...input.planDecision }, run);
      } else if (!input.gate) {
        this.#emitTranscript(
          {
            kind: 'input',
            source: input.kind,
            text: input.text,
            ...(input.id ? { id: input.id } : {}),
            ...(input.author ? { author: input.author } : {}),
            ...(input.notification ? { notification: input.notification } : {}),
            ...(whileActive && input.kind === 'signal' ? { delivery: 'while-active' as const } : {}),
            ...(marker ? { modelSwitch: marker } : {}),
          },
          run,
        );
        marker = undefined;
      }
      input.echoed = true;
    }
  }

  #fresh(inputs: OpenCodePendingInput[], ...waiting: OpenCodePendingInput[][]): OpenCodePendingInput[] {
    const ids = new Set(waiting.flat().flatMap(input => (input.id ? [input.id] : [])));
    return inputs.filter(input => !input.id || !ids.has(input.id));
  }

  #threadState(threadId = this.#record.threadId): OpenCodeThreadState {
    return (this.#record.threads[threadId] ??= emptyOpenCodeThreadState());
  }

  #emit(event: AgentEvent) {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.warn('[opencode harness] Event listener failed.', error);
      }
    }
  }

  #emitTranscript(entry: TranscriptEntry, run: Pick<ActiveRun, 'runId' | 'threadId'>) {
    for (const listener of [...this.#transcriptListeners]) {
      try {
        listener(entry, { runId: run.runId, threadId: run.threadId });
      } catch (error) {
        console.warn('[opencode harness] Transcript listener failed.', error);
      }
    }
  }

  #save(): Promise<void> {
    this.#record.updatedAt = new Date().toISOString();
    const record = structuredClone(this.#record);
    const run = this.#run;
    if (run && !run.settled && run.queue.length) record.threads[run.threadId]?.pendingInputs.push(...structuredClone(run.queue));
    const write = this.#saving.then(() => this.#config.store.put(record));
    this.#saving = write.catch(error => console.warn('[opencode harness] Unable to persist session.', error));
    return write;
  }

  #markDelivered(inputs: OpenCodePendingInput[]) {
    const thread = this.#threadState();
    for (const input of inputs) if (input.id) thread.deliveredIds = remember(thread.deliveredIds, input.id);
  }

  #accept(inputs: OpenCodePendingInput[], wake: boolean, { keepGate = false } = {}): Accepted {
    const run = this.#run;
    if (run && !run.settled) {
      const fresh = this.#fresh(inputs, run.queue, this.#threadState(run.threadId).pendingInputs);
      run.queue.push(...fresh);
      if (run.begun) this.#echo(fresh, run, true);
      void this.#save().catch(() => {});
      return { action: 'deliver', run };
    }
    if (!wake) {
      this.#threadState().pendingInputs.push(...inputs);
      return { action: 'persist' };
    }
    const thread = this.#threadState();
    if (thread.pendingGate && !keepGate) {
      const { toolCallId } = thread.pendingGate;
      thread.pendingGate = undefined;
      this.#emit({ type: 'tool_suspension_cancelled', toolCallId });
    }
    if (thread.pendingPermission && !keepGate) {
      const { toolCallId } = thread.pendingPermission;
      thread.pendingPermission = undefined;
      // The turn that waited is given up; OpenCode hears about the new input in a turn of its own.
      this.#dropParked();
      this.#emit({ type: 'tool_suspension_cancelled', toolCallId });
    }
    return { action: 'wake', run: this.#startRun(inputs) };
  }

  #newRun(): ActiveRun {
    let markStarted!: ActiveRun['markStarted'];
    let resolveEnded!: ActiveRun['resolveEnded'];
    const started = new Promise<void>((resolve, reject) => {
      markStarted = error => (error === undefined ? resolve() : reject(error));
    });
    started.catch(() => {});
    return {
      runId: randomUUID(),
      threadId: this.#record.threadId,
      queue: [],
      abortRequested: false,
      settled: false,
      started,
      markStarted,
      ended: new Promise(resolve => {
        resolveEnded = resolve;
      }),
      resolveEnded,
      loopDone: Promise.resolve(),
    };
  }

  #startRun(inputs: OpenCodePendingInput[]): ActiveRun {
    const run = this.#newRun();
    this.#run = run;
    const thread = this.#threadState();
    const first = [...thread.pendingInputs, ...this.#fresh(inputs, thread.pendingInputs)];
    thread.pendingInputs = [];
    const park = thread.usageLimitPark;
    if (park) {
      // The run takes the park up: a limit it runs into again parks anew, counted from the first park.
      run.priorPark = park;
      thread.usageLimitPark = undefined;
      if (park.continueTurn) first.unshift({ kind: 'signal', text: USAGE_LIMIT_RESUME_PROMPT, gate: true });
      this.#emitPark({ type: 'usage_limit_cleared', reason: 'resumed' });
    }
    const previous = this.#barrier;
    run.loopDone = this.#loop(run, previous, { inputs: first });
    this.#barrier = run.loopDone;
    return run;
  }

  /** A run that picks a parked turn up again: OpenCode gets the answer and the same turn goes on. */
  #adopt(parked: ParkedTurn, answer: ParkAnswer): ActiveRun {
    const run = this.#newRun();
    run.threadId = parked.threadId;
    run.server = parked.server;
    run.client = parked.client;
    run.stream = parked.stream;
    run.mcpServers = parked.mcpServers;
    run.openCodeSessionId = parked.openCodeSessionId;
    run.adopted = parked;
    run.begun = true;
    this.#run = run;
    const previous = this.#barrier;
    run.loopDone = this.#loop(run, previous, { parked, answer });
    this.#barrier = run.loopDone;
    return run;
  }

  async #loop(run: ActiveRun, previous: Promise<void>, start: { inputs: OpenCodePendingInput[] } | { parked: ParkedTurn; answer: ParkAnswer }): Promise<void> {
    let reason: AgentRunEndReason = 'complete';
    let keepServer = false;
    let failure: unknown;
    let threw = false;
    try {
      await previous;
      let result: TurnResult;
      if ('parked' in start) {
        // The same turn goes on: a new watch over its translator, then OpenCode gets the answer.
        const watch = newTurnWatch(start.parked.watch.translator);
        run.watch = watch;
        run.markStarted();
        start.parked.respond(start.answer);
        // OpenCode ended the turn while it waited (it dropped the ask): the answer has nothing to go on.
        if (watch.translator.completed) watch.finish(watch.translator.outcome());
        result = await this.#awaitTurn(run, watch);
      } else {
        result = await this.#turn(run, start.inputs);
      }
      while (true) {
        if (run.settled) return;
        if (result.kind === 'aborted') {
          reason = 'aborted';
          break;
        }
        if (result.kind === 'error') {
          failure = result.error;
          reason = 'error';
          break;
        }
        if (result.kind === 'permission') {
          const thread = this.#threadState(run.threadId);
          thread.pendingPermission = result.request;
          thread.pendingInputs.push(...run.queue);
          run.queue = [];
          keepServer = this.#park(run, result);
          this.#emit({ type: 'tool_suspended', toolName: result.request.toolName, toolCallId: result.request.toolCallId });
          reason = 'suspended';
          break;
        }
        if (result.kind === 'gate') {
          const thread = this.#threadState(run.threadId);
          thread.pendingGate = result.gate;
          thread.pendingInputs.push(...run.queue);
          run.queue = [];
          this.#emit({ type: 'tool_suspended', toolName: 'submit_plan', toolCallId: result.gate.toolCallId });
          reason = 'suspended';
          break;
        }
        if (run.queue.length === 0) break;
        const next = run.queue;
        run.queue = [];
        result = await this.#turn(run, next);
      }
    } catch (error) {
      if (run.settled) return;
      threw = true;
      failure = error;
      reason = 'error';
    } finally {
      if (!keepServer && !run.abortRequested) this.#closeServer(run);
    }
    if (run.settled) return;
    let park: Omit<UsageLimitPark, 'continueTurn'> | undefined;
    if (reason === 'error') {
      failure = await this.#limitFailure(run, failure);
      const parked = await this.#usageLimitPark(run, failure);
      if (run.settled) return;
      if (parked === 'expired' && isUsageLimitFailure(failure)) {
        failure = new OpenCodeError('rate_limit', usageLimitExpiredMessage(run.priorPark, failure.message));
        this.#emitPark({ type: 'usage_limit_cleared', reason: 'expired' });
      } else if (parked && parked !== 'expired') {
        park = parked;
      }
      // A parked run says so instead of failing: the chat shows when it resumes, not an error.
      if (!park) this.#emit({ type: 'error', error: failure });
    }
    // A run that could not start says so only once it settled: a send that follows at once starts a
    // run of its own, instead of joining this one's queue and ending with its failure.
    if (threw) run.markStarted(failure);
    this.#settle(run, reason, { ...(park ? { park } : {}) });
  }

  /**
   * A limit or a refusal on the run's account: the host is told (the account sits out or is turned
   * off), and a limit learns when usage comes back, when the host knows.
   */
  async #limitFailure(run: ActiveRun, failure: unknown): Promise<unknown> {
    if (!(failure instanceof OpenCodeError) || (failure.kind !== 'rate_limit' && failure.kind !== 'auth') || run.abortRequested) return failure;
    let error = failure;
    try {
      if (error.kind === 'rate_limit' && !error.resetsAt && this.#config.usageLimitResetsAt) {
        const resetsAt = await this.#config.usageLimitResetsAt(this, { ...(run.accountId ? { accountId: run.accountId } : {}), error });
        if (resetsAt) error = error.withResetsAt(resetsAt);
      }
      if (run.accountId) await this.#config.onCredentialFailure?.(this, { accountId: run.accountId, error });
    } catch (hookError) {
      console.warn('[opencode harness] Unable to report a limited or refused account.', hookError);
    }
    return error;
  }

  /**
   * The park a limited run leads to: only when the reset is known and the host lets the session
   * park, `expired` once it waited past the cap; `undefined` otherwise (the run fails).
   */
  async #usageLimitPark(run: ActiveRun, failure: unknown): Promise<Omit<UsageLimitPark, 'continueTurn'> | 'expired' | undefined> {
    if (!isUsageLimitFailure(failure) || !failure.resetsAt || run.abortRequested) return undefined;
    try {
      if (!this.#config.parkOnUsageLimit || !(await this.#config.parkOnUsageLimit(this))) return undefined;
    } catch (error) {
      console.warn('[opencode harness] Unable to tell whether a limited run may park.', error);
      return undefined;
    }
    return nextUsageLimitPark(failure, { ...(run.priorPark ? { previous: run.priorPark } : {}) });
  }

  #emitPark(event: UsageLimitParkEvent) {
    this.#emit(event as unknown as AgentEvent);
  }

  #closeServer(run: Pick<ActiveRun, 'stream' | 'server'>) {
    run.stream?.abort();
    run.server?.terminate();
  }

  #settle(
    run: ActiveRun,
    reason: AgentRunEndReason,
    { drainFollowUps = true, park }: { drainFollowUps?: boolean; park?: Omit<UsageLimitPark, 'continueTurn'> } = {},
  ) {
    if (run.settled) return;
    run.settled = true;
    if (this.#run === run) this.#run = undefined;
    if (reason === 'aborted' || reason === 'error') {
      const thread = this.#threadState(run.threadId);
      if (park && run.threadId === this.#record.threadId) {
        // The cut-off turn reached OpenCode (it is in its session): the resume goes on with it.
        const continueTurn = run.unsent === undefined && run.begun === true;
        thread.usageLimitPark = { ...park, ...(continueTurn ? { continueTurn: true as const } : {}) };
      }
      const kept = (input: OpenCodePendingInput) => input.kind === 'notification' || input.gate || !input.id;
      if (run.unsent) {
        thread.pendingInputs.unshift(...run.unsent.filter(kept));
        run.unsent = undefined;
      }
      thread.pendingInputs.push(...run.queue.filter(kept));
      run.queue = [];
    }
    run.markStarted();
    void this.#save().catch(() => {});
    run.resolveEnded(reason);
    const parked = this.#threadState(run.threadId).usageLimitPark;
    if (park && parked) this.#emitPark({ type: 'usage_limit_parked', park: { ...parked } });
    this.#emit({ type: 'agent_end', reason });
    // A parked session waits for the limit: its follow-ups go with the resume, not into another limited run.
    if (drainFollowUps && reason !== 'suspended' && !park) this.#drainFollowUps(run.threadId);
  }

  #drainFollowUps(threadId: string) {
    if (this.#run || threadId !== this.#record.threadId) return;
    const thread = this.#threadState(threadId);
    const waiting = thread.followUps ?? [];
    if (waiting.length === 0) return;
    const hadFollowUps = waiting.some(input => input.kind === 'signal');
    thread.followUps = [];
    this.#accept(waiting, true);
    if (hadFollowUps) this.#emitFollowUpCount();
  }

  /** Stops the turn in flight: OpenCode is asked to abort it, and its server ends shortly after. */
  #interrupt(run: ActiveRun) {
    const watch = run.watch;
    watch?.translator.aborted();
    watch?.finish({ kind: 'aborted' });
    const { client, server, openCodeSessionId } = run;
    if (!server) return;
    if (client && openCodeSessionId && server.isAlive()) void client.abort(openCodeSessionId).catch(() => {});
    const timer = setTimeout(() => this.#closeServer(run), ABORT_GRACE_MS);
    timer.unref?.();
  }

  /** Keeps a turn that asked a person waiting in its live server; `false` when it cannot wait (no server). */
  #park(run: ActiveRun, result: Extract<TurnResult, { kind: 'permission' }>): boolean {
    this.#dropParked();
    const { server, client, stream, watch, openCodeSessionId } = run;
    if (!server || !client || !stream || !watch || !openCodeSessionId) {
      result.respond({ dismissed: true });
      return false;
    }
    run.server = undefined;
    run.client = undefined;
    run.stream = undefined;
    const timer = setTimeout(() => this.#dropParked(), this.#config.parkTimeoutMs ?? DEFAULT_PARK_TIMEOUT_MS);
    timer.unref?.();
    this.#parked = {
      server,
      client,
      stream,
      mcpServers: run.mcpServers ?? [],
      watch,
      request: result.request,
      respond: result.respond,
      ...(result.questions ? { questions: result.questions } : {}),
      openCodeSessionId,
      threadId: run.threadId,
      timer,
    };
    // A server that dies while it waits leaves the answer to the next turn.
    void server.exited.then(() => {
      if (this.#parked?.server === server) {
        clearTimeout(this.#parked.timer);
        this.#parked = undefined;
      }
    });
    return true;
  }

  #takeParked(toolCallId: string): ParkedTurn | undefined {
    const parked = this.#parked;
    if (!parked || parked.request.toolCallId !== toolCallId || parked.threadId !== this.#record.threadId || !parked.server.isAlive()) {
      this.#dropParked();
      return undefined;
    }
    clearTimeout(parked.timer);
    this.#parked = undefined;
    parked.watch.translator.answered(toolCallId);
    return parked;
  }

  /** Gives a parked turn up: OpenCode's ask is refused (a question dismissed) and its server ends. */
  #dropParked() {
    const parked = this.#parked;
    if (!parked) return;
    this.#parked = undefined;
    clearTimeout(parked.timer);
    try {
      parked.respond({ dismissed: true });
    } catch {
      // The server may already be gone.
    }
    // After the answer went out, so OpenCode closes the turn it waited in.
    setTimeout(() => this.#closeServer(parked), 500).unref?.();
  }

  async #cwd(): Promise<string> {
    const recorded = this.#record.cwd;
    if (recorded) {
      if (await directoryExists(recorded)) return recorded;
      // The checkout was removed from disk (the sandbox went to sleep, a retired or cleaned folder):
      // asking for the cwd again sets it up anew. It must come back at the same path, as Claude
      // Code's and Codex's do; anywhere else is refused rather than silently moved.
      const restored = await this.#config.cwdFor(this.id);
      if (restored !== recorded) {
        throw new OpenCodeError('process', `The checkout of session ${this.id} is gone from ${recorded}, and setting it up again put it at ${restored}.`);
      }
      return recorded;
    }
    this.#record.cwd = await this.#config.cwdFor(this.id);
    await this.#save();
    return this.#record.cwd;
  }

  /** The session's state folders, created on first use. */
  async #stateDirs(): Promise<OpenCodeStateDirs> {
    const dirs = openCodeStateDirs(this.#config.stateRootFor(this), this.#config.sharedCacheDir);
    await Promise.all(Object.values(dirs).map(dir => mkdir(dir, { recursive: true, mode: 0o700 })));
    return dirs;
  }

  /** The run's server with the thread's OpenCode session open: started, or resumed after a restart. */
  async #openSession(run: ActiveRun, policy: OpenCodeTurnPolicy): Promise<OpenCodeClient> {
    const rules = JSON.stringify(openCodePermissionRules(policy));
    if (run.server?.isAlive() && run.client && run.openCodeSessionId) {
      if (run.rules === rules) return run.client;
      // The settings changed between two turns of the run: OpenCode reads its rules when it starts,
      // so the next turn goes on in the same OpenCode session on a server started with the new ones.
      this.#closeServer(run);
      run.server = undefined;
      run.client = undefined;
      run.stream = undefined;
      run.openCodeSessionId = undefined;
    }
    run.rules = rules;
    const cwd = await this.#cwd();
    const mcpServers = (await this.#config.mcpServersFor?.(this)) ?? {};
    const credentials = await this.#config.credentials?.(this, {
      ...(this.#record.accountId ? { preferredAccountId: this.#record.accountId } : {}),
      exclude: [],
    });
    const extra = {
      ...(await this.#config.envFor?.(this)),
      // The account's key inline: no file of the session's holds it, and nothing else signs in.
      ...(credentials ? { OPENCODE_AUTH_CONTENT: openCodeAuthContent(credentials.apiKey) } : {}),
    };
    this.#record.accountId = credentials?.accountId;
    if (credentials) {
      run.accountId = credentials.accountId;
      this.#emitTranscript({ kind: 'credential', ...credentials.credential }, run);
    }
    const env = buildOpenCodeEnv(
      this.#config.env ?? process.env,
      { dirs: await this.#stateDirs(), configContent: openCodeConfigContent({ policy, mcpServers }), password: openCodeServerPassword(), ...(extra ? { extra } : {}) },
      this.#config.passEnv,
    );
    const server = await spawnOpenCodeServer({
      ...(this.#config.command ? { command: this.#config.command } : {}),
      cwd,
      env,
      ...(this.#config.spawn ? { spawn: this.#config.spawn } : {}),
      ...(this.#config.startTimeoutMs ? { startTimeoutMs: this.#config.startTimeoutMs } : {}),
      ...(this.#config.fetch ? { fetch: this.#config.fetch } : {}),
    });
    run.server = server;
    run.mcpServers = Object.keys(mcpServers);
    if (run.abortRequested) {
      server.terminate();
      throw new OpenCodeError('process', 'The run was stopped.');
    }
    const client = server.client(cwd);
    run.client = client;
    const stream = new AbortController();
    run.stream = stream;
    // Subscribed before any prompt, so no event of the turn is missed.
    await this.#pump(server, client, stream);
    const thread = this.#threadState(run.threadId);
    if (thread.openCodeSessionId) {
      if (await client.getSession(thread.openCodeSessionId)) {
        run.openCodeSessionId = thread.openCodeSessionId;
        return client;
      }
      // An OpenCode session its database no longer has (its folders were cleared) starts afresh
      // instead of failing every turn; the turn then carries the thread's history (`handoffContextFor`).
      console.warn(`[opencode harness] OpenCode session ${thread.openCodeSessionId} of ${this.id} is gone; starting a new one.`);
      run.resumeFailed = true;
    }
    const created = await client.createSession({ title: this.id });
    thread.openCodeSessionId = created.id;
    run.openCodeSessionId = created.id;
    await this.#save();
    return client;
  }

  /** Reads a server's events into the turn that owns them; resolves once the stream is open. */
  async #pump(server: OpenCodeServerProcess, client: OpenCodeClient, stream: AbortController): Promise<void> {
    const iterator = client.events(stream.signal)[Symbol.asyncIterator]();
    const current = () => (this.#run?.server === server ? this.#run.watch : this.#parked?.server === server ? this.#parked.watch : undefined);
    // The stream answers with `server.connected` first: once it came, the subscription is open.
    const first = iterator.next();
    let connected: IteratorResult<Parameters<OpenCodeTurnTranslator['handle']>[0]>;
    const timeoutMs = this.#config.startTimeoutMs ?? DEFAULT_OPENCODE_START_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    try {
      connected = await Promise.race([
        first,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            stream.abort();
            reject(new OpenCodeError('timeout', `The OpenCode server did not open its event stream within ${timeoutMs} ms.`));
          }, timeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      if (error instanceof OpenCodeError) throw error;
      throw new OpenCodeError('process', `Could not subscribe to the OpenCode server's events: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      clearTimeout(timer);
    }
    if (connected.done) throw new OpenCodeError('process', 'The OpenCode server closed its event stream at once.');
    void (async () => {
      try {
        while (true) {
          const { value, done } = await iterator.next();
          if (done) break;
          const watch = current();
          if (!watch) continue;
          // Awaited, so the events after it wait: they keep their order.
          if (await this.#ownsAsk(watch, client, value)) this.#dispatch(server, current() ?? watch, value);
        }
      } catch (error) {
        if (stream.signal.aborted) return;
        current()?.translator.fail(new OpenCodeError('process', `The OpenCode event stream failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
      }
      if (stream.signal.aborted) return;
      const watch = current();
      if (watch) {
        watch.translator.fail(new OpenCodeError('process', 'The OpenCode server closed its event stream.'));
        watch.finish(watch.translator.outcome());
      }
    })();
  }

  /**
   * Whether the turn gets this event. An ask (a permission, a question) from a session the stream has
   * not tied to the turn yet may be a subagent's whose `task` call has not shown up: OpenCode is asked
   * who started that session, so the ask parks the turn instead of leaving it waiting unseen.
   */
  async #ownsAsk(watch: TurnWatch, client: OpenCodeClient, event: Parameters<OpenCodeTurnTranslator['handle']>[0]): Promise<boolean> {
    if (event.type !== 'permission.asked' && event.type !== 'question.asked') return true;
    const sessionId = event.properties.sessionID;
    if (typeof sessionId !== 'string' || watch.translator.accepts(sessionId)) return true;
    const seen = new Set<string>();
    let next: string | undefined = sessionId;
    const chain: Array<{ id: string; parent?: string }> = [];
    try {
      // A subagent's own subagent asks too: up the chain until a session of the turn, or none.
      while (next && !seen.has(next) && !watch.translator.accepts(next)) {
        seen.add(next);
        const info = await client.getSession(next);
        chain.push({ id: next, ...(info?.parentID ? { parent: info.parentID } : {}) });
        next = info?.parentID;
      }
    } catch (error) {
      // An ask nobody can place would leave the turn waiting on it: the turn ends with why instead.
      watch.translator.fail(new OpenCodeError('process', `OpenCode asked from session ${sessionId}, and the Factory could not tell whose it is: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
      watch.finish(watch.translator.outcome());
      return false;
    }
    for (const link of chain.reverse()) watch.translator.adoptChild(link.id, link.parent);
    return watch.translator.accepts(sessionId);
  }

  /** One event: its transcript entries, its usage, and a park, an end or a stop it means for the turn. */
  #dispatch(server: OpenCodeServerProcess, watch: TurnWatch, event: Parameters<OpenCodeTurnTranslator['handle']>[0]) {
    const update = watch.translator.handle(event);
    const run = this.#run;
    const live = run && !run.settled && run.server === server ? run : undefined;
    // The client that answers OpenCode for this server, held by the run or the parked turn now.
    const client = live?.client ?? (this.#parked?.server === server ? this.#parked.client : undefined);
    const emit = (entries: TranscriptEntry[]) => {
      if (live) for (const entry of entries) this.#emitTranscript(entry, live);
    };
    if (update.usage && live) this.#emit({ type: 'usage_update', usage: update.usage });
    if (update.terminal) {
      emit(update.entries);
      if (client) void client.abort(watch.translator.sessionId).catch(() => {});
      watch.finish({ kind: 'error', error: update.terminal });
      return;
    }
    if (update.permission) {
      const { requestId, request, alwaysAsks } = update.permission;
      this.#ask(live, watch, update.entries, emit, alwaysAsks ? { ...request, once: true } : request, answer => {
        if (!client) return;
        const reply: OpenCodePermissionReply = 'reply' in answer ? answer.reply : 'reject';
        void client.replyPermission(requestId, reply).catch(error => this.#answerFailed(server, 'permission', error));
      });
      return;
    }
    if (update.question) {
      const { requestId, request, questions } = update.question;
      this.#ask(
        live,
        watch,
        update.entries,
        emit,
        request,
        answer => {
          if (!client) return;
          const sent = 'answers' in answer ? client.replyQuestion(requestId, answer.answers) : client.rejectQuestion(requestId);
          void sent.catch(error => this.#answerFailed(server, 'question', error));
        },
        questions,
      );
      return;
    }
    emit(update.entries);
    if (update.idle) watch.finish(watch.translator.outcome());
  }

  /**
   * OpenCode did not take an answer: the turn that waits for it ends with why, instead of waiting
   * forever. An ask OpenCode already dropped (404) took its answer as far as anyone can.
   */
  #answerFailed(server: OpenCodeServerProcess, kind: 'permission' | 'question', error: unknown) {
    if (error instanceof OpenCodeHttpError && error.status === 404) return;
    console.warn(`[opencode harness] Unable to answer a ${kind}.`, error);
    const run = this.#run;
    const watch = run && !run.settled && run.server === server ? run.watch : undefined;
    if (!watch) return;
    watch.translator.fail(new OpenCodeError('process', `OpenCode did not take the answer to its ${kind}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
    watch.finish(watch.translator.outcome());
  }

  /**
   * A call (or question) OpenCode asks a person about: allowed at once when the person already
   * allowed the tool for the thread, refused when nobody can answer, else the turn parks on it.
   */
  #ask(
    live: ActiveRun | undefined,
    watch: TurnWatch,
    entries: TranscriptEntry[],
    emit: (entries: TranscriptEntry[]) => void,
    built: PermissionRequest,
    respond: (answer: ParkAnswer) => void,
    questions?: OpenCodeQuestion[],
  ) {
    const policy = live?.policy;
    const question = built.toolName === ASK_USER_QUESTION_TOOL;
    // A tool asked about on every call (or an ask OpenCode always makes): its Allow is for this call alone.
    const once = !question && (built.once === true || policy?.askEachTime?.includes(built.toolName) === true);
    const request: PermissionRequest = once ? { ...built, once: true } : built;
    const calls = entries.filter(entry => entry.kind !== 'permission');
    const thread = this.#threadState();
    if (!question && !once && thread.grantedTools?.includes(request.toolName)) {
      emit(calls);
      respond({ reply: 'always' });
      return;
    }
    // Nobody watches a card run that may not park: what it would ask about is refused.
    if (policy?.unattended && !policy.parkAsks) {
      emit(calls);
      respond({ dismissed: true });
      return;
    }
    emit(once ? entries.map(entry => (entry.kind === 'permission' ? { ...entry, once: true } : entry)) : entries);
    watch.finish({ kind: 'permission', request, respond, ...(questions ? { questions } : {}) });
  }

  /** Waits for the turn to end, park, time out, or lose its server. */
  async #awaitTurn(run: ActiveRun, watch: TurnWatch): Promise<TurnResult> {
    const server = run.server;
    let exited = false;
    void server?.exited.then(({ code, signal, stderr }) => {
      exited = true;
      watch.translator.fail(new OpenCodeError('process', `OpenCode stopped (${signal ?? code}).${stderr ? `\n${stderr.slice(-2000)}` : ''}`));
      watch.finish(watch.translator.outcome());
    });
    let timer: NodeJS.Timeout | undefined;
    if (this.#config.turnTimeoutMs) {
      timer = setTimeout(() => {
        watch.finish({ kind: 'error', error: new OpenCodeError('timeout', 'OpenCode turn timed out.') });
        if (run.client && run.openCodeSessionId && !exited) void run.client.abort(run.openCodeSessionId).catch(() => {});
      }, this.#config.turnTimeoutMs);
      timer.unref?.();
    }
    try {
      return await watch.done;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async #turn(run: ActiveRun, inputs: OpenCodePendingInput[]): Promise<TurnResult> {
    const thread = this.#threadState(run.threadId);
    const turnStartedAt = new Date();
    const planning = (thread.mode ?? this.#config.mode) === 'planning';
    const lead = planning ? [this.#config.planningPrompt ?? OPENCODE_PLANNING_PROMPT] : [];
    const selection = this.#config.turnSelectionFor ? await this.#config.turnSelectionFor(this) : undefined;
    const text = inputs.map(input => input.text).join('\n\n');
    if (!run.settled) this.#echo(inputs, run, false, selection?.modelSwitch);
    run.begun = true;
    run.unsent = inputs;
    const policy = (await this.#config.policyFor?.(this)) ?? {};
    run.policy = policy;
    const turnContext = await this.#config.turnContextFor?.(this);
    if (run.abortRequested) return { kind: 'aborted' };
    const client = await this.#openSession(run, policy);
    run.markStarted();
    if (run.abortRequested) return { kind: 'aborted' };
    const openCodeSessionId = run.openCodeSessionId!;
    this.#emitTranscript({ kind: 'init', sessionId: openCodeSessionId, ...(selection?.model ? { model: selection.model } : {}) }, run);
    const translator = new OpenCodeTurnTranslator({ sessionId: openCodeSessionId, mcpServers: run.mcpServers ?? [], planning, promptedAt: Date.now() });
    const watch = newTurnWatch(translator);
    run.watch = watch;
    // The thread's history when its OpenCode session is new after a failed resume, or a handoff a move
    // from another harness left pending: ahead of the person's request, which is sent as written.
    const resumeFailed = run.resumeFailed === true;
    run.resumeFailed = false;
    const handoff = await this.#handoffFor(resumeFailed ? 'resume_failed' : 'turn', text, turnStartedAt);
    const prompt = [...lead, ...(turnContext ? [turnContext] : []), promptWithTurnHandoff(handoff, text)].join('\n\n');
    const system = (await this.#config.developerInstructionsFor?.(this)) ?? this.#config.developerInstructions;
    const model = openCodeModelRef(selection?.model);
    try {
      await client.promptAsync(openCodeSessionId, {
        parts: [{ type: 'text', text: prompt }],
        agent: planning ? 'plan' : 'build',
        ...(model ? { model } : {}),
        ...(selection?.variant ? { variant: selection.variant } : {}),
        ...(system ? { system } : {}),
      });
    } catch (error) {
      await handoff?.unsent().catch(failure => console.warn('[opencode harness] Unable to keep the handoff pending.', failure));
      // A server failing (5xx) is the transient kind a retry may get past; anything else is refused.
      const kind = error instanceof OpenCodeHttpError && error.status >= 500 ? 'overloaded' : 'process';
      return {
        kind: 'error',
        error: error instanceof OpenCodeError ? error : new OpenCodeError(kind, `OpenCode refused the turn: ${error instanceof Error ? error.message : String(error)}`, { cause: error, ...(error instanceof OpenCodeHttpError ? { status: error.status } : {}) }),
      };
    }
    if (handoff) void handoff.delivered().catch(error => console.warn('[opencode harness] Unable to record the handoff as delivered.', error));
    // OpenCode has the prompt: from here on the input counts as delivered.
    if (run.unsent) {
      this.#markDelivered(run.unsent);
      run.unsent = undefined;
      void this.#save().catch(() => {});
    }
    return this.#awaitTurn(run, watch);
  }

  /** The host's handoff for this turn; a failing hook leaves the turn without one rather than failing it. */
  async #handoffFor(reason: 'turn' | 'resume_failed', prompt: string, turnStartedAt: Date): Promise<TurnHandoffContext | undefined> {
    if (!this.#config.handoffContextFor) return undefined;
    try {
      const handoff = await this.#config.handoffContextFor(this, { reason, prompt, turnStartedAt });
      return handoff?.context ? handoff : undefined;
    } catch (error) {
      console.warn('[opencode harness] Unable to read the context handoff for this turn.', error);
      return undefined;
    }
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
