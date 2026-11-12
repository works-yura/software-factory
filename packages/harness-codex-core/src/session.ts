import { randomUUID } from 'node:crypto';

import { elicitationQuestions, elicitationResponse, splitQuestionAnswers, type ElicitationPlan, type McpElicitationResponse } from '@factory/harness/elicitation';
import type { ModelSelection } from '@factory/harness/models/contracts';
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
import {
  ASK_USER_QUESTION_TOOL,
  askUserPrompt,
  type MessageAuthor,
  type NotificationRecord,
  type PermissionRequest,
  type PlanGate,
  type TranscriptEntry,
} from '@factory/harness/transcript';

import { buildCodexEnv } from './env.ts';
import { CodexError } from './errors.ts';
import { CodexTurnTranslator, codexQuestionInput, type CodexTurnOutcome } from './events.ts';
import { CODEX_FILE_CREDENTIALS_ARGS, codexAppServerArgs, resolveCodexLaunchArgs } from './launchArgs.ts';
import type { CodexTurnModelSelection } from './models/harness-models.ts';
import { codexNotificationDecision } from './notifications.ts';
import { spawnCodexAppServer, type CodexAppServerProcess, type CodexSpawn } from './protocol/client.ts';
import type {
  ApprovalDecision,
  AskForApproval,
  ChatgptAuthTokensRefreshResponse,
  JsonValue,
  RateLimitSnapshot,
  SandboxMode,
  SandboxPolicy,
  ThreadStartParams,
  McpServerElicitationRequestParams,
  ThreadItem,
  ToolRequestUserInputParams,
  TurnStartParams,
} from './protocol/schema.ts';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { emptyCodexThreadState, type CodexPendingInput, type CodexSessionMode, type CodexSessionRecord, type CodexSessionStore, type CodexThreadState } from './store.ts';
import { makeCodexTurnTokenUsageState } from './tokenUsage.ts';
import { codexUsageLimitResetAt, codexUsageLimitsUpdate, mergeCodexRateLimits } from './usageLimits.ts';

/** How many delivered signal ids and dedupe keys a thread remembers. */
const RECENT_LIMIT = 200;
/** How long a live approval or question keeps its turn (and its app-server) waiting before it falls back to the next turn. */
const DEFAULT_PARK_TIMEOUT_MS = 30 * 60_000;
/** How long an interrupted turn may take to stop before its process is ended. */
const INTERRUPT_GRACE_MS = 3_000;

/** The request-context key a person's identity travels under when they write (Mastra's message author key). */
export const MESSAGE_AUTHOR_KEY = 'mastra__messageAuthor';

export function messageAuthor(requestContext: AgentRunContext | undefined): MessageAuthor | undefined {
  const value = requestContext?.get(MESSAGE_AUTHOR_KEY);
  if (!value || typeof value !== 'object') return undefined;
  const { id, name, avatarUrl } = value as Record<string, unknown>;
  if (typeof id !== 'string' || !id) return undefined;
  return {
    id,
    ...(typeof name === 'string' ? { name } : {}),
    ...(typeof avatarUrl === 'string' ? { avatarUrl } : {}),
  };
}

/**
 * How a turn may act, from the reference runtime modes: `approval-required` asks before anything
 * that is not a read; `auto-accept-edits` writes in the workspace and asks for the rest;
 * `full-access` asks for nothing and leaves the sandbox.
 */
export type CodexRuntimeMode = 'approval-required' | 'auto-accept-edits' | 'full-access';

/** A turn's policy, from {@link CodexSessionConfig.policyFor}. */
export interface CodexTurnPolicy {
  runtimeMode?: CodexRuntimeMode;
  /** Whether sandboxed commands may reach the network. */
  networkAccess?: boolean;
  /**
   * Nobody watches the turn (a card run): Codex is told it cannot ask, so what it would ask about
   * is refused, unless `parkAsks` parks it for a person on the board and in the inbox.
   */
  unattended?: boolean;
  parkAsks?: boolean;
  /**
   * Tools asked about on every call (transcript names, e.g. `mcp__factory__factory_retry_decision`):
   * an Allow lets that one call through, never the rest of the session (Claude Code's `askEachTime`).
   */
  askEachTime?: string[];
}

export function codexRuntimeModeTurnDefaults(
  runtimeMode: CodexRuntimeMode,
  networkAccess = false,
): { approvalPolicy: AskForApproval; sandboxPolicy: SandboxPolicy; sandbox: SandboxMode } {
  switch (runtimeMode) {
    case 'approval-required':
      return { approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly', networkAccess }, sandbox: 'read-only' };
    case 'full-access':
      return { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, sandbox: 'danger-full-access' };
    default:
      return { approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite', networkAccess }, sandbox: 'workspace-write' };
  }
}

/**
 * Every thread's config: the plan list tool on, MCP servers given time to start, reasoning
 * summaries not holding tool calls, and the question tool (`request_user_input`) offered in every
 * mode, not only in plan mode: every question to a person goes through it, as a question card.
 */
export const CODEX_THREAD_CONFIG: Readonly<Record<string, JsonValue>> = {
  'tools.update_plan.enabled': true,
  mcp_optional_startup_grace_ms: 10_000,
  'features.concurrent_reasoning_summaries': true,
  'features.default_mode_request_user_input': true,
};

/** An MCP server Codex reaches for the session (`mcp_servers.<name>` of the thread's config). */
export type CodexMcpServer =
  | {
      url: string;
      http_headers?: Record<string, string>;
      tool_timeout_sec?: number;
      enabled_tools?: string[];
      disabled_tools?: string[];
      /** Per tool: `approval_mode = "prompt"` makes Codex ask a person before each call (see `codexMcpToolApproval`). */
      tools?: Record<string, { approval_mode?: 'auto' | 'prompt' | 'writes' | 'approve' }>;
    }
  | { command: string; args?: string[]; env?: Record<string, string>; tool_timeout_sec?: number };

/** A Factory tool call can wait on a person for up to an hour; Codex's MCP timeout stays above that. */
export const CODEX_MCP_TOOL_TIMEOUT_SEC = 65 * 60;

/** Leads a planning turn unless the host gives its own. */
export const CODEX_PLANNING_PROMPT =
  'You are planning. Investigate read-only and write the plan; make no changes. A person approves the plan before you implement it.';

/** What a run asks the credentials hook (as a Claude Code turn does). */
export interface CodexCredentialRequest {
  /** The account the session used last; staying on it keeps the provider's prompt cache. */
  preferredAccountId?: string;
  /** Accounts this turn already tried and lost to a limit or a refusal. */
  exclude: string[];
}

/** The tokens Codex runs a ChatGPT sign-in on: the access token and its workspace, never the refresh token. */
export interface CodexChatGptTokens {
  accessToken: string;
  chatgptAccountId: string;
  planType?: string;
}

/** One account's credentials for a run. */
export interface CodexTurnCredentials {
  tokens: CodexChatGptTokens;
  /** Names the account, so the turn can move off it when it runs out. */
  accountId?: string;
  /** How the chat names the account the turn runs on, and whose sign-in it is. */
  credential?: { label: string; ownerId?: string };
}

/** How many times one turn moves to another account before it gives up. */
export const CODEX_MAX_ACCOUNT_SWITCHES = 10;

/**
 * Sent instead of the turn's prompt when it goes on under another account after Codex had the
 * prompt: it is already in the thread, so sending it again would repeat it.
 */
export const CODEX_ACCOUNT_SWITCH_PROMPT =
  'Your previous attempt at this request stopped because the account ran out of usage. The session now runs on another account. Continue where you stopped.';

/** What a process signed in with: the account's tokens, and the accounts the current turn already left. */
interface ProcessCredentials {
  current: CodexTurnCredentials;
  tried: string[];
}

export type CodexTranscriptListener = (entry: TranscriptEntry, meta: { runId: string; threadId: string }) => void;

/** How a person's chat message joins the session (the chat's message, follow-up and steer routes). */
export type CodexChatDelivery = 'message' | 'follow-up' | 'steer';

/** Emitted whenever the number of queued follow-ups changes, as a Mastra session does. */
export interface CodexFollowUpQueuedEvent {
  type: 'follow_up_queued';
  count: number;
}

export type CodexNotificationInput = AgentNotificationInput & {
  id?: string;
  coalesceKey?: string;
  attributes?: Record<string, string | number | boolean | null | undefined>;
  metadata?: Record<string, unknown>;
};

/**
 * Configuration for Codex sessions. Each run starts a `codex app-server` for the session's cwd,
 * starts or resumes its Codex thread with the session's instructions and MCP servers, and runs
 * turns there; the process ends with the run, unless the run parked on a live approval or question
 * (then it waits, up to `parkTimeoutMs`, for the answer to resume the same turn).
 */
export interface CodexSessionConfig {
  store: CodexSessionStore;
  /** The session's working directory; asked once, before its first turn. */
  cwdFor: (sessionId: string) => string | Promise<string>;
  /** The CLI: a path, or the server's resolver (`@factory/harness/executable`); `codex` on PATH by default. */
  command?: HarnessCommand;
  /** Extra launch arguments (`-c key=value`, `--enable feature`); `FACTORY_CODEX_LAUNCH_ARGS` wins. */
  launchArgs?: string;
  spawn?: CodexSpawn;
  /** The environment the CLI inherits from; `process.env` by default (only the allowlisted names pass). */
  env?: Record<string, string | undefined>;
  /** More variable names the CLI may inherit. */
  passEnv?: string[];
  /**
   * `CODEX_HOME` for every session; prefer {@link codexHomeFor}. Unset with neither, the CLI's
   * default (`~/.codex`, the person's own `codex login`) — tests and local tools only.
   */
  codexHome?: string;
  /**
   * The session's own `CODEX_HOME` (its thread history, nothing of a login), stable per session so
   * a later run resumes its thread; wins over {@link codexHome}.
   */
  codexHomeFor?: (session: CodexSession) => string | undefined;
  /**
   * The ChatGPT sign-in a run uses, asked when the run opens its process: Codex gets the access
   * token alone (`account/login/start` with `chatgptAuthTokens`, kept in its memory only) and asks
   * {@link refreshCredentials} when the backend refuses it. When the account hits a usage limit or
   * is refused, the turn asks again with the accounts it tried in `request.exclude` and goes on, in
   * the same Codex thread, with the next one; a hook with no account left throws (a `rate_limit`
   * {@link CodexError} with `resetsAt`, say). Unset, Codex uses whatever login its home holds.
   */
  credentials?: (session: CodexSession, request: CodexCredentialRequest) => Promise<CodexTurnCredentials>;
  /** A fresh access token for the account after Codex said the current one was refused; `undefined` when it is gone. */
  refreshCredentials?: (
    session: CodexSession,
    input: { accountId: string | undefined; accessToken: string },
  ) => Promise<CodexChatGptTokens | undefined>;
  /** Told when a turn's account hit a usage limit or was refused, before the turn asks for another. */
  onCredentialFailure?: (session: CodexSession, failure: { accountId: string; error: CodexError }) => void | Promise<void>;
  /**
   * Whether a run that stopped because every account is out of usage parks the session until the
   * limit resets (`usageLimitPark`, `usage_limit_parked`) instead of failing. Unset, a limited run
   * fails as any other; whoever parks sessions resumes them (`resumeFromUsageLimit` at `until`).
   */
  parkOnUsageLimit?: (session: CodexSession) => boolean | Promise<boolean>;
  /** The model fields of the session's next turn (the harness's model facet), asked before each turn. */
  turnSelectionFor?: (session: CodexSession) => CodexTurnModelSelection | undefined | Promise<CodexTurnModelSelection | undefined>;
  /**
   * An image Codex generated (its `imageGeneration` item, saved under the session's home): the host
   * keeps it as the session's attachment. Errors are logged, never the turn's.
   */
  onImageGenerated?: (session: CodexSession, image: { path: string; prompt?: string; itemId: string }) => void | Promise<void>;
  /** The thread's developer instructions (the Factory's playbook); asked when the run opens its thread. */
  developerInstructions?: string;
  developerInstructionsFor?: (session: CodexSession) => string | undefined | Promise<string | undefined>;
  /** Context the agent reads ahead of this turn's input (the Factory's signals); the transcript does not show it. */
  turnContextFor?: (session: CodexSession) => string | undefined | Promise<string | undefined>;
  /**
   * Context a turn carries over from another conversation (`@factory/harness/turn-handoff`): asked
   * before every turn, with `resume_failed` when the thread's Codex thread could not be resumed and
   * a new one started, so it gets the thread's history instead of none. Its context goes ahead of
   * the prompt; `delivered` is called once Codex accepted the turn, `unsent` when it did not.
   */
  handoffContextFor?: TurnHandoffHook<CodexSession>;
  /** MCP servers for the run (e.g. the Factory's tools with a token minted for it). */
  mcpServersFor?: (session: CodexSession) => Record<string, CodexMcpServer> | undefined | Promise<Record<string, CodexMcpServer> | undefined>;
  /** How the next turn may act; `auto-accept-edits`, asking for the rest, by default. */
  policyFor?: (session: CodexSession) => CodexTurnPolicy | undefined | Promise<CodexTurnPolicy | undefined>;
  /** More thread config (`-c` keys), merged over {@link CODEX_THREAD_CONFIG}. */
  threadConfig?: Record<string, JsonValue>;
  /**
   * More thread config for this session's run, asked when the run opens its thread (once the cwd is
   * known); merged over {@link threadConfig}. E.g. a checkout someone outside wrote reads no
   * project instructions.
   */
  threadConfigFor?: (session: CodexSession) => Record<string, JsonValue> | undefined | Promise<Record<string, JsonValue> | undefined>;
  /** Mode a new thread starts in; `planning` to start with a plan for approval. */
  mode?: CodexSessionMode;
  /** Leads every planning turn's prompt; {@link CODEX_PLANNING_PROMPT} by default. */
  planningPrompt?: string;
  turnTimeoutMs?: number;
  parkTimeoutMs?: number;
}

interface ActiveRun {
  runId: string;
  threadId: string;
  queue: CodexPendingInput[];
  unsent?: CodexPendingInput[];
  server?: CodexAppServerProcess;
  /** The Codex thread the run's process has open. */
  codexThreadId?: string;
  /** The model the thread runs on, as Codex reported it when the thread opened. */
  threadModel?: string;
  /** The thread's Codex thread could not be resumed when the run opened it: a new one started. */
  resumeFailed?: boolean;
  watch?: TurnWatch;
  begun?: boolean;
  abortRequested: boolean;
  settled: boolean;
  policy?: CodexTurnPolicy;
  /** A parked turn this run picked up again; its process is the run's. */
  adopted?: ParkedTurn;
  /** The `turn/start` of the turn in flight, so it can go on under another account. */
  turnParams?: TurnStartParams;
  /** The usage-limit park this run took up (its first park's time counts toward the cap). */
  priorPark?: UsageLimitPark;
  started: Promise<void>;
  markStarted(error?: unknown): void;
  ended: Promise<AgentRunEndReason>;
  resolveEnded(reason: AgentRunEndReason): void;
  loopDone: Promise<void>;
}

/** A turn in flight: its translator, and how it ends. */
interface TurnWatch {
  translator: CodexTurnTranslator;
  finish(outcome: TurnResult): void;
  done: Promise<TurnResult>;
}

type TurnResult =
  | CodexTurnOutcome
  | { kind: 'permission'; request: PermissionRequest; respond: (answer: ParkAnswer) => void; ask?: ParkedAsk };

/** What a person answers on a question card: Codex's own question, or an MCP server's form or link. */
type ParkedAsk = { kind: 'userInput'; params: ToolRequestUserInputParams } | { kind: 'elicitation'; plan: ElicitationPlan };

type ParkAnswer =
  | { decision: ApprovalDecision }
  | { answers: Record<string, { answers: string[] }> }
  | { elicitation: McpElicitationResponse };

/** The answer a question card's request takes from the person's reply. */
function askAnswer(ask: ParkedAsk, answer: string | string[]): ParkAnswer {
  return ask.kind === 'userInput' ? { answers: questionAnswers(ask.params, answer) } : { elicitation: elicitationResponse(ask.plan, answer) };
}

/** The answer a question card's request takes when nobody answers it. */
function askDismissed(ask: ParkedAsk): ParkAnswer {
  return ask.kind === 'userInput' ? { answers: {} } : { elicitation: { action: 'cancel' } };
}

/** A turn that waits, in its live process, for a person's answer. */
interface ParkedTurn {
  server: CodexAppServerProcess;
  watch: TurnWatch;
  request: PermissionRequest;
  respond: (answer: ParkAnswer) => void;
  ask?: ParkedAsk;
  codexThreadId: string;
  threadId: string;
  timer: NodeJS.Timeout;
  /** The parked turn's own `turn/start`, so it can go on under another account after a usage limit. */
  turnParams?: TurnStartParams;
}

type Accepted = { action: 'deliver' | 'wake'; run: ActiveRun } | { action: 'persist' };

const escapeAttribute = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const escapeNotificationBody = (value: string) =>
  value.replace(/<(\/?)system-notification/gi, (_match, slash: string) => `&lt;${slash}system-notification`);

function formatNotification(input: Pick<NotificationRecord, 'source' | 'kind' | 'payload' | 'summary'> & { priority?: string }): string {
  const attrs = [`source="${escapeAttribute(input.source)}"`, `kind="${escapeAttribute(input.kind)}"`];
  if (input.priority) attrs.push(`priority="${escapeAttribute(input.priority)}"`);
  const payload = input.payload as { message?: unknown; body?: unknown } | undefined;
  const detail = [payload?.message, payload?.body].find(
    (value): value is string => typeof value === 'string' && value.trim() !== '' && value !== input.summary,
  );
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

/** Codex takes a turn as text, so a skill kickoff travels in the `<skill name="…">` envelope. */
function signalText(input: AgentSignalInput): string {
  if (input.type === 'system-reminder') throw new Error('Codex holds no goals: a goal reminder cannot reach it.');
  if (input.tagName !== 'skill') return input.contents;
  const contents = input.contents.replace(/<\/skill\s*>/gi, match => match.replace('<', '&lt;').replace('>', '&gt;'));
  return `<skill name="${input.attributes.name.replaceAll('"', '&quot;')}">\n${contents}\n</skill>`;
}

/**
 * The answers a `request_user_input` takes from a person's answer to its question card. The chat
 * sends a card of several questions as one text, each answer under its numbered question; it is
 * split back so each question gets its own.
 */
export function questionAnswers(params: ToolRequestUserInputParams | undefined, answer: string | string[]): Record<string, { answers: string[] }> {
  const questions = params?.questions ?? [];
  if (questions.length <= 1) {
    const values = (Array.isArray(answer) ? answer : [answer]).map(value => value.trim()).filter(Boolean);
    return questions[0] ? { [questions[0].id]: { answers: values } } : {};
  }
  // Split by the questions as the card showed them.
  const answers = splitQuestionAnswers(
    codexQuestionInput(params!).questions.map(question => String(question.question)),
    answer,
  );
  return Object.fromEntries(questions.map((question, index) => [question.id, { answers: answers[index] ? [answers[index]] : [] }]));
}

/**
 * The tool an MCP elicitation asks a person to allow, when it is Codex's `mcp_tool_call` approval
 * (`_meta.codex_approval_kind`); `undefined` for any other elicitation. The CLI (0.166) names the
 * tool in its message (`Allow <server> to run tool "<tool>"?`) and puts only its title, connector
 * and parameters in `_meta` (`tool_title`, `connector_*`, `tool_params`), so the message is read
 * first: the tool's own name is what Factory grants and asks-each-time lists match.
 */
export function codexMcpToolApproval(params: { serverName?: string; message?: string; _meta?: JsonValue | null }):
  | { server: string; tool: string; message?: string }
  | undefined {
  const meta = params._meta && typeof params._meta === 'object' && !Array.isArray(params._meta) ? params._meta : undefined;
  if (meta?.codex_approval_kind !== 'mcp_tool_call' || !params.serverName) return undefined;
  const named = params.message ? /run tool ["“`']([^"”`']+)["”`']/.exec(params.message)?.[1] : undefined;
  const tool = [named, meta.tool_name, meta.tool, meta.tool_title].find((value): value is string => typeof value === 'string' && value.trim() !== '');
  return {
    server: params.serverName,
    tool: tool ?? 'tool',
    ...(params.message ? { message: params.message } : {}),
  };
}

function codexTokensResponse(tokens: CodexChatGptTokens): ChatgptAuthTokensRefreshResponse {
  return { accessToken: tokens.accessToken, chatgptAccountId: tokens.chatgptAccountId, chatgptPlanType: tokens.planType ?? null };
}

function newTurnWatch(translator: CodexTurnTranslator): TurnWatch {
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
 * One Factory session on Codex. A run is a chain of turns in one app-server process: input that
 * arrives mid-turn is queued and sent as the next turn before the run ends. An approval or a
 * question ends the run `suspended` while its turn waits in the live process; the answer resumes
 * that turn. A plan written in planning mode parks the thread on a plan gate.
 */
export class CodexSession implements AgentSession {
  readonly id: string;
  readonly #config: CodexSessionConfig;
  #record: CodexSessionRecord;
  #run: ActiveRun | undefined;
  #parked: ParkedTurn | undefined;
  #barrier: Promise<void> = Promise.resolve();
  #listeners = new Set<AgentEventListener>();
  #transcriptListeners = new Set<CodexTranscriptListener>();
  #saving: Promise<void> = Promise.resolve();
  #rateLimits: RateLimitSnapshot | undefined;
  readonly #usage = makeCodexTurnTokenUsageState();
  /** The sign-in each live process runs on (a parked turn keeps its process, and so its sign-in). */
  readonly #processCredentials = new WeakMap<CodexAppServerProcess, ProcessCredentials>();

  constructor(record: CodexSessionRecord, config: CodexSessionConfig) {
    this.id = record.sessionId;
    this.#record = record;
    this.#config = config;
    this.#threadState(record.threadId);
  }

  /** The harness the chat and the run reports read this session as. */
  readonly harness = 'codex' as const;
  /** The models' provider, stamped beside a reply's model id. */
  readonly modelProvider = 'openai';

  get resourceId(): string | undefined {
    return this.#record.resourceId;
  }

  get cwd(): string | undefined {
    return this.#record.cwd;
  }

  /** Codex's thread id for the current thread, once its first turn started. */
  get codexThreadId(): string | undefined {
    return this.#threadState().codexThreadId;
  }

  get mode(): CodexSessionMode | undefined {
    return this.#threadState().mode ?? this.#config.mode;
  }

  async setMode(mode: CodexSessionMode): Promise<void> {
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

  /** Set while the current thread waits for a usage limit to reset (see `@factory/harness/usage-limit-park`). */
  get usageLimitPark(): UsageLimitPark | undefined {
    const park = this.#threadState().usageLimitPark;
    return park ? { ...park } : undefined;
  }

  /**
   * Takes a session parked on a usage limit up again now: a run with its pending inputs (and, when
   * the limit cut a turn off, a note to go on with it). Still limited, the session parks anew and
   * the result says until when. A person's message resumes a parked session the same way.
   */
  async resumeFromUsageLimit(): Promise<UsageLimitResumeResult> {
    if (this.run.isRunning()) return { action: 'running' };
    if (!this.#threadState().usageLimitPark) return { action: 'not_parked' };
    const accepted = this.#accept([], true);
    if (accepted.action !== 'wake') return { action: 'running' };
    return usageLimitResumeOutcome(accepted.run, () => this.usageLimitPark);
  }

  /** The account the session's last turn ran on, when its credentials named one. */
  get accountId(): string | undefined {
    return this.#record.accountId;
  }

  /** Codex's latest allowance snapshot this session saw (`account/rateLimits/updated`). */
  get rateLimits(): RateLimitSnapshot | undefined {
    return this.#rateLimits ? structuredClone(this.#rateLimits) : undefined;
  }

  /** Whether a parked approval or question still has its turn waiting in a live process. */
  get hasLiveGate(): boolean {
    return this.#parked !== undefined;
  }

  readonly thread = {
    getId: (): string | undefined => this.#record.threadId,
    requireId: (): string => this.#record.threadId,
    switch: async ({ threadId }: { threadId: string }): Promise<void> => {
      if (threadId === this.#record.threadId) return;
      if (this.#run) throw new Error('Cannot switch threads while a run is in flight.');
      this.#dropParked('cancel');
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

  onTranscript(listener: CodexTranscriptListener): () => void {
    this.#transcriptListeners.add(listener);
    return () => this.#transcriptListeners.delete(listener);
  }

  /** Stops the run now: `agent_end: aborted` before this returns; Codex is told to interrupt the turn behind it. */
  abort(): void {
    this.#abort(true);
  }

  /** Ends the session's processes (a parked turn included); what it persisted stays. */
  dispose(): void {
    this.#abort(false);
    this.#dropParked('cancel');
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

  /** A person's chat message: `message` starts or joins a run, `follow-up` waits for it, `steer` replaces it. */
  async sendChatMessage(input: { content: string; requestContext?: AgentRunContext; delivery?: CodexChatDelivery }): Promise<{ action: 'wake' | 'deliver' | 'queued' }> {
    const author = messageAuthor(input.requestContext);
    const message: CodexPendingInput = { kind: 'signal', text: input.content, ...(author ? { author } : {}) };
    const delivery = input.delivery ?? 'message';
    if (delivery === 'follow-up' && this.run.isRunning()) {
      const thread = this.#threadState();
      thread.followUps = [...(thread.followUps ?? []), message];
      await this.#save();
      this.#emitFollowUpCount();
      return { action: 'queued' };
    }
    if (delivery === 'steer') {
      // Codex takes the message into the turn in flight (`turn/steer`): it reads it at its next step, nothing is stopped.
      if (await this.#steer(message)) return { action: 'deliver' };
      this.#abort(false);
    }
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

  /** Gives the agent a notification as a Mastra session's delivery policy would (see {@link codexNotificationDecision}). */
  async sendNotificationSignal(input: CodexNotificationInput, options: AgentNotificationOptions = {}): Promise<AgentNotificationResult> {
    const thread = this.#threadState();
    if (input.dedupeKey && thread.dedupeKeys.includes(input.dedupeKey)) {
      return { persisted: Promise.resolve(), accepted: Promise.resolve({ action: 'deliver' }) };
    }
    if (input.dedupeKey) thread.dedupeKeys = remember(thread.dedupeKeys, input.dedupeKey);
    const record = this.#notificationRecord(thread, input);
    const text = formatNotification({ ...record, priority: input.priority });
    const pending: CodexPendingInput = { kind: 'notification', text, notification: record };
    const active = this.run.isRunning();
    const allowed = active ? (options.ifActive?.behavior ?? 'deliver') === 'deliver' : (options.ifIdle?.behavior ?? 'persist') === 'wake';
    const decision = codexNotificationDecision({ record, threadState: active ? 'active' : 'idle', now: new Date() });
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
    return {
      persisted: this.#save(),
      accepted: run.started.then(() => ({ action: 'wake', output: { consumeStream: () => run.ended } })),
    };
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
   * Answers the call the thread is parked on. With its turn still waiting, Codex gets the decision
   * and the turn goes on; otherwise (a restart, or it waited too long) the answer is the next turn.
   * Allowed, the tool is allowed for the rest of the thread.
   */
  async respondToToolApproval({ approved, toolCallId }: { approved: boolean; toolCallId?: string }): Promise<void> {
    const thread = this.#threadState();
    const request = thread.pendingPermission;
    if (!request) throw new Error('This session is not waiting on a permission.');
    if (toolCallId && toolCallId !== request.toolCallId) throw new Error(`This session is waiting on ${request.toolCallId}, not ${toolCallId}.`);
    if (this.#run) throw new Error('Cannot answer a permission while a run is in flight.');
    if (approved && request.toolName === ASK_USER_QUESTION_TOOL) {
      throw new Error('This session is waiting on an answer to its question, not on a permission.');
    }
    thread.pendingPermission = undefined;
    if (approved && !request.once) thread.grantedTools = [...new Set([...(thread.grantedTools ?? []), request.toolName])];
    const decision = { kind: 'permission_decision' as const, toolCallId: request.toolCallId, toolName: request.toolName, approved };
    const parked = this.#takeParked(request.toolCallId);
    if (parked) {
      const run = this.#adopt(parked, { decision: approved ? (request.once ? 'accept' : 'acceptForSession') : 'decline' });
      this.#emitTranscript(decision, run);
      await run.started;
      return;
    }
    const accepted = this.#accept([{ kind: 'signal', text: permissionPrompt(request, approved), gate: true }], true, { keepGate: true });
    if (accepted.action === 'persist') return;
    this.#emitTranscript(decision, accepted.run);
    await accepted.run.started;
  }

  /** Answers the question (`request_user_input`) the thread is parked on. */
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
      const run = this.#adopt(parked, parked.ask ? askAnswer(parked.ask, answer) : { answers: {} });
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

  /** Gives the turn in flight the message (`turn/steer`); `false` when no turn of this run can take it. */
  async #steer(message: CodexPendingInput): Promise<boolean> {
    const run = this.#run;
    const server = run?.server;
    const translator = run?.watch?.translator;
    if (!run || run.settled || !server?.isAlive() || !run.codexThreadId || !translator?.turnId || translator.completed) return false;
    try {
      await server.client.request('turn/steer', { threadId: run.codexThreadId, expectedTurnId: translator.turnId, input: [{ type: 'text', text: message.text }] });
    } catch {
      // The turn ended (or moved on) before Codex took it: the caller stops the run and starts over with it.
      return false;
    }
    if (run.settled) return false;
    this.#echo([message], run, true);
    if (message.id) this.#markDelivered([message]);
    void this.#save().catch(() => {});
    return true;
  }

  #notificationRecord(thread: CodexThreadState, input: CodexNotificationInput): NotificationRecord {
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
    const matches = ({ notification }: CodexPendingInput) =>
      notification !== undefined &&
      notification.coalesceKey === input.coalesceKey &&
      notification.source === input.source &&
      notification.kind === input.kind;
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
    const event: CodexFollowUpQueuedEvent = { type: 'follow_up_queued', count: this.queuedFollowUps };
    this.#emit(event as unknown as AgentEvent);
  }

  #echo(inputs: CodexPendingInput[], run: ActiveRun, whileActive = false, modelSwitch?: { from: ModelSelection; to: ModelSelection }) {
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

  #fresh(inputs: CodexPendingInput[], ...waiting: CodexPendingInput[][]): CodexPendingInput[] {
    const ids = new Set(waiting.flat().flatMap(input => (input.id ? [input.id] : [])));
    return inputs.filter(input => !input.id || !ids.has(input.id));
  }

  #threadState(threadId = this.#record.threadId): CodexThreadState {
    return (this.#record.threads[threadId] ??= emptyCodexThreadState());
  }

  #emit(event: AgentEvent) {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.warn('[codex harness] Event listener failed.', error);
      }
    }
  }

  #emitTranscript(entry: TranscriptEntry, run: Pick<ActiveRun, 'runId' | 'threadId'>) {
    for (const listener of [...this.#transcriptListeners]) {
      try {
        listener(entry, { runId: run.runId, threadId: run.threadId });
      } catch (error) {
        console.warn('[codex harness] Transcript listener failed.', error);
      }
    }
  }

  #save(): Promise<void> {
    this.#record.updatedAt = new Date().toISOString();
    const record = structuredClone(this.#record);
    const run = this.#run;
    if (run && !run.settled && run.queue.length) record.threads[run.threadId]?.pendingInputs.push(...structuredClone(run.queue));
    const write = this.#saving.then(() => this.#config.store.put(record));
    this.#saving = write.catch(error => console.warn('[codex harness] Unable to persist session.', error));
    return write;
  }

  #markDelivered(inputs: CodexPendingInput[]) {
    const thread = this.#threadState();
    for (const input of inputs) if (input.id) thread.deliveredIds = remember(thread.deliveredIds, input.id);
  }

  #accept(inputs: CodexPendingInput[], wake: boolean, { keepGate = false } = {}): Accepted {
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
      // The turn that waited is given up; Codex hears about the new input in a turn of its own.
      this.#dropParked('cancel');
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

  #startRun(inputs: CodexPendingInput[]): ActiveRun {
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

  /** A run that picks a parked turn up again: Codex gets the answer and the same turn goes on. */
  #adopt(parked: ParkedTurn, answer: ParkAnswer): ActiveRun {
    const run = this.#newRun();
    run.threadId = parked.threadId;
    run.server = parked.server;
    run.codexThreadId = parked.codexThreadId;
    run.adopted = parked;
    run.begun = true;
    if (parked.turnParams) run.turnParams = parked.turnParams;
    this.#run = run;
    const previous = this.#barrier;
    run.loopDone = this.#loop(run, previous, { parked, answer });
    this.#barrier = run.loopDone;
    return run;
  }

  async #loop(
    run: ActiveRun,
    previous: Promise<void>,
    start: { inputs: CodexPendingInput[] } | { parked: ParkedTurn; answer: ParkAnswer },
  ): Promise<void> {
    let reason: AgentRunEndReason = 'complete';
    let keepServer = false;
    let failure: unknown;
    let threw = false;
    try {
      await previous;
      let result: TurnResult;
      if ('parked' in start) {
        // The same turn goes on: a new watch over its translator, then Codex gets the answer.
        const watch = newTurnWatch(start.parked.watch.translator);
        run.watch = watch;
        run.markStarted();
        start.parked.respond(start.answer);
        // A usage limit after the answer moves the turn to another account, as a fresh turn's does.
        result = await this.#switchAccounts(run, await this.#awaitTurn(run, watch));
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
          this.#park(run, result);
          keepServer = true;
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
      if (!keepServer && !run.abortRequested) run.server?.terminate();
      if (!keepServer) await this.#clearSignIn();
    }
    if (run.settled) return;
    let park: Omit<UsageLimitPark, 'continueTurn'> | undefined;
    if (reason === 'error') {
      const parked = await this.#usageLimitPark(run, failure);
      if (run.settled) return;
      if (parked === 'expired' && isUsageLimitFailure(failure)) {
        failure = new CodexError('rate_limit', usageLimitExpiredMessage(run.priorPark, failure.message));
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
   * The park a run's failure leads to: a usage limit parks the session when the host says so,
   * `expired` once it waited past the cap; `undefined` for any other failure.
   */
  async #usageLimitPark(run: ActiveRun, failure: unknown): Promise<Omit<UsageLimitPark, 'continueTurn'> | 'expired' | undefined> {
    if (!isUsageLimitFailure(failure) || run.abortRequested) return undefined;
    try {
      if (!this.#config.parkOnUsageLimit || !(await this.#config.parkOnUsageLimit(this))) return undefined;
    } catch (error) {
      console.warn('[codex harness] Unable to tell whether a limited run may park.', error);
      return undefined;
    }
    return nextUsageLimitPark(failure, { ...(run.priorPark ? { previous: run.priorPark } : {}) });
  }

  #emitPark(event: UsageLimitParkEvent) {
    this.#emit(event as unknown as AgentEvent);
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
        // The cut-off turn's request reached Codex (it is in the thread): the resume goes on with it.
        // (A resume's own note that was never sent waits with the pending inputs instead.)
        const continueTurn = run.unsent === undefined && run.begun === true;
        thread.usageLimitPark = { ...park, ...(continueTurn ? { continueTurn: true as const } : {}) };
      }
      const kept = (input: CodexPendingInput) => input.kind === 'notification' || input.gate || !input.id;
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

  /** Stops the turn in flight: Codex is asked to interrupt it, and its process ends shortly after. */
  #interrupt(run: ActiveRun) {
    const server = run.server;
    const watch = run.watch;
    watch?.finish({ kind: 'aborted' });
    if (!server) return;
    const turnId = watch?.translator.turnId;
    if (run.codexThreadId && turnId && server.isAlive()) {
      void server.client.request('turn/interrupt', { threadId: run.codexThreadId, turnId }).catch(() => {});
    }
    const timer = setTimeout(() => server.terminate(), INTERRUPT_GRACE_MS);
    timer.unref?.();
  }

  #park(run: ActiveRun, result: Extract<TurnResult, { kind: 'permission' }>) {
    this.#dropParked('cancel');
    const server = run.server;
    const watch = run.watch;
    if (!server || !watch || !run.codexThreadId) {
      result.respond({ decision: 'cancel' });
      return;
    }
    run.server = undefined;
    const timer = setTimeout(() => this.#dropParked('cancel'), this.#config.parkTimeoutMs ?? DEFAULT_PARK_TIMEOUT_MS);
    timer.unref?.();
    this.#parked = {
      server,
      watch,
      request: result.request,
      respond: result.respond,
      ...(result.ask ? { ask: result.ask } : {}),
      codexThreadId: run.codexThreadId,
      threadId: run.threadId,
      timer,
      ...(run.turnParams ? { turnParams: run.turnParams } : {}),
    };
    // A process that dies while it waits leaves the answer to the next turn.
    server.client.onTerminated(() => {
      if (this.#parked?.server === server) {
        clearTimeout(this.#parked.timer);
        this.#parked = undefined;
      }
    });
  }

  #takeParked(toolCallId: string): ParkedTurn | undefined {
    const parked = this.#parked;
    if (!parked || parked.request.toolCallId !== toolCallId || parked.threadId !== this.#record.threadId || !parked.server.isAlive()) {
      this.#dropParked('cancel');
      return undefined;
    }
    clearTimeout(parked.timer);
    this.#parked = undefined;
    parked.watch.translator.answered(toolCallId);
    return parked;
  }

  #dropParked(decision: ApprovalDecision) {
    const parked = this.#parked;
    if (!parked) return;
    this.#parked = undefined;
    clearTimeout(parked.timer);
    try {
      parked.respond(parked.ask ? askDismissed(parked.ask) : { decision });
    } catch {
      // The process may already be gone.
    }
    // After the answer went out, so Codex closes the turn it waited in.
    setImmediate(() => parked.server.terminate());
  }

  async #cwd(): Promise<string> {
    if (this.#record.cwd) return this.#record.cwd;
    this.#record.cwd = await this.#config.cwdFor(this.id);
    await this.#save();
    return this.#record.cwd;
  }

  #codexHome(): string | undefined {
    return this.#config.codexHomeFor?.(this) ?? this.#config.codexHome;
  }

  /** Signs the process in with the account's tokens (Codex keeps them in memory) and marks the replies that follow as its. */
  async #signIn(server: CodexAppServerProcess, run: ActiveRun, held: ProcessCredentials): Promise<void> {
    const { tokens, accountId, credential } = held.current;
    await server.client.request('account/login/start', {
      type: 'chatgptAuthTokens',
      accessToken: tokens.accessToken,
      chatgptAccountId: tokens.chatgptAccountId,
      chatgptPlanType: tokens.planType ?? null,
    });
    this.#processCredentials.set(server, held);
    if (accountId && accountId !== this.#record.accountId) {
      this.#record.accountId = accountId;
      void this.#save().catch(() => {});
    }
    // The replies that follow ran on this account, as a Claude Code turn's do.
    if (credential && !run.settled) this.#emitTranscript({ kind: 'credential', ...credential }, run);
  }

  /**
   * The account a turn goes on with after `error`, signed in on the run's process; `undefined`
   * when it must stop: the error is not the account's fault, the turn switched too often, or the
   * hook has no other account (its error then ends the turn).
   */
  async #nextAccount(run: ActiveRun, error: CodexError): Promise<boolean> {
    const server = run.server;
    const held = server ? this.#processCredentials.get(server) : undefined;
    const accountId = held?.current.accountId;
    if (!server || !held || !accountId || !this.#config.credentials) return false;
    if (error.kind !== 'rate_limit' && error.kind !== 'auth') return false;
    if (run.abortRequested || run.settled || held.tried.length >= CODEX_MAX_ACCOUNT_SWITCHES) return false;
    held.tried.push(accountId);
    try {
      await this.#config.onCredentialFailure?.(this, { accountId, error });
    } catch (failure) {
      console.warn('[codex harness] Credential failure hook failed.', failure);
    }
    const next = await this.#config.credentials(this, { exclude: [...held.tried] });
    if (!next.accountId || held.tried.includes(next.accountId)) return false;
    await this.#signIn(server, run, { current: next, tried: held.tried });
    return true;
  }

  /** What a run left in the session's home besides its thread: a sign-in file, should the CLI ever write one. */
  async #clearSignIn(): Promise<void> {
    const home = this.#config.credentials ? this.#codexHome() : undefined;
    if (home) await rm(join(home, 'auth.json'), { force: true }).catch(() => {});
  }

  /** The run's process with the session's Codex thread open: started, or resumed after a restart. */
  async #openThread(run: ActiveRun, policy: CodexTurnPolicy, selection: CodexTurnModelSelection | undefined): Promise<CodexAppServerProcess> {
    if (run.server?.isAlive() && run.codexThreadId) return run.server;
    const cwd = await this.#cwd();
    const codexHome = this.#codexHome();
    const env = buildCodexEnv(this.#config.env ?? process.env, codexHome ? { CODEX_HOME: codexHome } : {}, this.#config.passEnv);
    // Asked before the process starts, so a run with no account to use fails without one.
    const credentials = this.#config.credentials
      ? await this.#config.credentials(this, {
          ...(this.#record.accountId ? { preferredAccountId: this.#record.accountId } : {}),
          exclude: [],
        })
      : undefined;
    const server = await spawnCodexAppServer({
      ...(this.#config.command ? { command: this.#config.command } : {}),
      args: [
        // A run signed in by the host keeps nothing of it in a keyring.
        ...(credentials ? CODEX_FILE_CREDENTIALS_ARGS : []),
        ...codexAppServerArgs(resolveCodexLaunchArgs(this.#config.launchArgs, this.#config.env ?? process.env)),
      ],
      cwd,
      env,
      ...(this.#config.spawn ? { spawn: this.#config.spawn } : {}),
    });
    run.server = server;
    if (run.abortRequested) {
      server.terminate();
      throw new CodexError('process', 'The run was stopped.');
    }
    this.#wire(server);
    if (credentials) await this.#signIn(server, run, { current: credentials, tried: [] });
    const mcpServers = (await this.#config.mcpServersFor?.(this)) ?? {};
    const developerInstructions = (await this.#config.developerInstructionsFor?.(this)) ?? this.#config.developerInstructions;
    const defaults = codexRuntimeModeTurnDefaults(policy.runtimeMode ?? 'auto-accept-edits', policy.networkAccess);
    const config: Record<string, JsonValue> = {
      ...CODEX_THREAD_CONFIG,
      ...this.#config.threadConfig,
      ...(await this.#config.threadConfigFor?.(this)),
      ...Object.fromEntries(
        Object.entries(mcpServers).map(([name, server]) => [`mcp_servers.${name}`, { tool_timeout_sec: CODEX_MCP_TOOL_TIMEOUT_SEC, ...server } as unknown as JsonValue]),
      ),
    };
    const params: ThreadStartParams = {
      cwd,
      config,
      approvalPolicy: defaults.approvalPolicy,
      sandbox: defaults.sandbox,
      ...(developerInstructions ? { developerInstructions } : {}),
      ...(selection?.model ? { model: selection.model } : {}),
      ...(selection?.serviceTier ? { serviceTier: selection.serviceTier } : {}),
    };
    const thread = this.#threadState(run.threadId);
    if (thread.codexThreadId) {
      try {
        const resumed = await server.client.request('thread/resume', { ...params, threadId: thread.codexThreadId });
        run.codexThreadId = resumed.thread.id;
        run.threadModel = resumed.model;
        return server;
      } catch (error) {
        // A thread Codex no longer has (its home was cleared) starts afresh instead of failing every turn;
        // the turn then carries the thread's history (`handoffContextFor`).
        console.warn('[codex harness] Could not resume the Codex thread; starting a new one.', error);
        run.resumeFailed = true;
      }
    }
    const started = await server.client.request('thread/start', { ...params, serviceName: 'factory' });
    thread.codexThreadId = started.thread.id;
    run.codexThreadId = started.thread.id;
    run.threadModel = started.model;
    await this.#save();
    return server;
  }

  /** Routes a process's notifications and requests to the turn in flight. */
  #wire(server: CodexAppServerProcess) {
    const client = server.client;
    const current = () => (this.#run?.server === server ? this.#run.watch : this.#parked?.server === server ? this.#parked.watch : undefined);
    /** The turn a notification of the turn's own thread belongs to. */
    const watchFor = (payload: { threadId?: string; turnId?: string }) => {
      const watch = current();
      return watch && watch.translator.owns(payload) ? watch : undefined;
    };
    /** The turn an item, delta or request belongs to: of its own thread, or of a subagent it started. */
    const workOf = (payload: { threadId?: string; turnId?: string | null }) => {
      const watch = current();
      return watch && watch.translator.accepts(payload) ? watch : undefined;
    };
    const emit = (entries: TranscriptEntry[]) => {
      const run = this.#run;
      if (!run || run.settled || run.server !== server) return;
      for (const entry of entries) this.#emitTranscript(entry, run);
    };
    client.handleServerNotification('turn/started', payload => {
      const watch = watchFor({ threadId: payload.threadId });
      if (watch && !watch.translator.turnId) watch.translator.begin(payload.turn.id);
    });
    client.handleServerNotification('item/started', payload => {
      const watch = workOf(payload);
      if (watch) emit(watch.translator.itemStarted(payload));
    });
    client.handleServerNotification('item/completed', payload => {
      const watch = workOf(payload);
      if (!watch) return;
      emit(watch.translator.itemCompleted(payload));
      if (payload.item.type === 'imageGeneration') this.#imageGenerated(payload.item as Extract<ThreadItem, { type: 'imageGeneration' }>);
    });
    client.handleServerNotification('item/agentMessage/delta', payload => {
      const watch = workOf(payload);
      if (watch) emit(watch.translator.agentMessageDelta(payload));
    });
    client.handleServerNotification('item/reasoning/summaryTextDelta', payload => {
      const watch = workOf(payload);
      if (watch) emit(watch.translator.reasoningDelta(payload));
    });
    client.handleServerNotification('turn/plan/updated', payload => {
      const watch = watchFor(payload);
      if (watch) emit(watch.translator.planUpdated(payload));
    });
    client.handleServerNotification('thread/tokenUsage/updated', payload => {
      const watch = watchFor(payload);
      if (!watch) return;
      const usage = watch.translator.tokenUsage(payload);
      const run = this.#run;
      if (usage && run && !run.settled && run.server === server) this.#emit({ type: 'usage_update', usage });
    });
    client.handleServerNotification('account/rateLimits/updated', payload => {
      this.#rateLimits = mergeCodexRateLimits(this.#rateLimits, payload.rateLimits);
      const limits = codexUsageLimitsUpdate(payload.rateLimits, this.#processCredentials.get(server)?.current.accountId);
      if (limits) this.#emit(limits as unknown as AgentEvent);
    });
    client.handleServerNotification('error', payload => {
      watchFor(payload)?.translator.error(payload);
    });
    client.handleServerNotification('turn/completed', payload => {
      // A subagent's turn ended: its `Agent` call settles; the turn that started it goes on.
      const parent = current();
      if (parent?.translator.isSubagent(payload.threadId)) {
        emit(parent.translator.subagentTurnCompleted(payload));
        return;
      }
      const watch = watchFor({ threadId: payload.threadId, turnId: payload.turn.id });
      if (!watch) return;
      emit(watch.translator.complete(payload));
      watch.finish(watch.translator.outcome());
    });
    client.handleUnknownServerNotification(() => {});

    const park = async (
      payload: { threadId: string; turnId?: string | null },
      build: (translator: CodexTurnTranslator) => { entries: TranscriptEntry[]; permission: PermissionRequest },
      ask?: ParkedAsk,
    ): Promise<ParkAnswer> => {
      const question = ask;
      const watch = workOf(payload);
      if (!watch) return ask ? askDismissed(ask) : { decision: 'cancel' };
      const policy = this.#run?.policy;
      const built = build(watch.translator);
      // A tool asked about on every call: its Allow is for this call alone.
      const once = !question && policy?.askEachTime?.includes(built.permission.toolName) === true;
      const permission: PermissionRequest = once ? { ...built.permission, once: true } : built.permission;
      const entries = once ? built.entries.map(entry => (entry.kind === 'permission' ? { ...entry, once: true } : entry)) : built.entries;
      const thread = this.#threadState();
      const calls = entries.filter(entry => entry.kind !== 'permission');
      if (!question && !once && thread.grantedTools?.includes(permission.toolName)) {
        emit(calls);
        return { decision: 'acceptForSession' };
      }
      // Nobody watches a card run that may not park: what it would ask about is refused.
      if (policy?.unattended && !policy.parkAsks) {
        emit(calls);
        return ask ? askDismissed(ask) : { decision: 'decline' };
      }
      emit(entries);
      return new Promise<ParkAnswer>(resolve => {
        watch.finish({ kind: 'permission', request: permission, respond: resolve, ...(ask ? { ask } : {}) });
      });
    };
    client.handleServerRequest('item/commandExecution/requestApproval', async params => {
      const answer = await park(params, translator => translator.approval({ kind: 'command', params }));
      return 'decision' in answer ? { decision: answer.decision } : { decision: 'cancel' };
    });
    client.handleServerRequest('item/fileChange/requestApproval', async params => {
      const answer = await park(params, translator => translator.approval({ kind: 'fileChange', params }));
      return 'decision' in answer ? { decision: answer.decision } : { decision: 'cancel' };
    });
    client.handleServerRequest('item/permissions/requestApproval', async params => {
      const answer = await park(params, translator => translator.approval({ kind: 'permissions', params }));
      const decision = 'decision' in answer ? answer.decision : 'cancel';
      if (decision !== 'accept' && decision !== 'acceptForSession') return { permissions: {}, scope: 'turn' };
      return { permissions: params.permissions, scope: decision === 'acceptForSession' ? 'session' : 'turn' };
    });
    client.handleServerRequest('item/tool/requestUserInput', async params => {
      const answer = await park(params, translator => translator.question(params), { kind: 'userInput', params });
      return { answers: 'answers' in answer ? answer.answers : {} };
    });
    // The backend refused the access token: the host refreshes the account (under its lock) and hands the new one over.
    client.handleServerRequest('account/chatgptAuthTokens/refresh', async () => {
      const held = this.#processCredentials.get(server);
      if (!held || !this.#config.refreshCredentials) throw new Error('No ChatGPT sign-in to refresh.');
      const tokens = await this.#config.refreshCredentials(this, {
        accountId: held.current.accountId,
        accessToken: held.current.tokens.accessToken,
      });
      if (!tokens) throw new Error('The ChatGPT sign-in was refused; it needs a new sign-in.');
      held.current = { ...held.current, tokens };
      return codexTokensResponse(tokens);
    });
    // An MCP tool call Codex asks a person to allow (a tool the host marked `approval_mode = "prompt"`):
    // parked like a command approval. Any other elicitation (an MCP server's form, or a link to open)
    // is asked as a question card and its answers go back as the content the server asked for.
    client.handleServerRequest('mcpServer/elicitation/request', async params => {
      if (!params.threadId) return { action: 'decline' };
      const where = { threadId: params.threadId, ...(params.turnId ? { turnId: params.turnId } : {}) };
      const approval = codexMcpToolApproval(params);
      if (approval) {
        const answer = await park(where, translator => translator.mcpApproval({ id: `mcp-approval-${randomUUID()}`, threadId: params.threadId, ...approval }));
        const decision = 'decision' in answer ? answer.decision : 'cancel';
        if (decision === 'acceptForSession') return { action: 'accept', content: null, _meta: { persist: 'session' } };
        if (decision === 'accept') return { action: 'accept', content: null, _meta: null };
        return { action: 'decline' };
      }
      return this.#elicit(params, where, park);
    });
  }

  /** An MCP server's form or link as a question card; declined when a person cannot answer it here. */
  async #elicit(
    params: McpServerElicitationRequestParams,
    where: { threadId: string; turnId?: string },
    park: (
      payload: { threadId: string; turnId?: string | null },
      build: (translator: CodexTurnTranslator) => { entries: TranscriptEntry[]; permission: PermissionRequest },
      ask?: ParkedAsk,
    ) => Promise<ParkAnswer>,
  ): Promise<McpElicitationResponse> {
    const card = elicitationQuestions(params);
    if (!card) return { action: 'decline' };
    const id = `elicitation-${params.elicitationId ?? randomUUID()}`;
    const answer = await park(where, translator => translator.elicitation({ id, threadId: params.threadId, ...card }), { kind: 'elicitation', plan: card.plan });
    if ('elicitation' in answer) return answer.elicitation;
    return { action: 'decision' in answer && answer.decision === 'cancel' ? 'cancel' : 'decline' };
  }

  /** Hands an image Codex generated to the host, which keeps it with the session. */
  #imageGenerated(item: Extract<ThreadItem, { type: 'imageGeneration' }>) {
    const hook = this.#config.onImageGenerated;
    if (!hook || !item.savedPath || item.failure) return;
    void Promise.resolve()
      .then(() => hook(this, { path: item.savedPath!, itemId: item.id, ...(item.revisedPrompt ? { prompt: item.revisedPrompt } : {}) }))
      .catch(error => console.warn('[codex harness] Could not keep a generated image.', error));
  }

  /** Waits for the turn to end, park, time out, or lose its process. */
  async #awaitTurn(run: ActiveRun, watch: TurnWatch): Promise<TurnResult> {
    const server = run.server;
    const stopOnExit = server?.client.onTerminated(error => {
      watch.finish({ kind: 'error', error: new CodexError('process', `Codex stopped: ${error.message}`, { cause: error }) });
    });
    let timer: NodeJS.Timeout | undefined;
    if (this.#config.turnTimeoutMs) {
      timer = setTimeout(() => {
        watch.finish({ kind: 'error', error: new CodexError('timeout', 'Codex turn timed out.') });
        if (run.codexThreadId && watch.translator.turnId && server?.isAlive()) {
          void server.client.request('turn/interrupt', { threadId: run.codexThreadId, turnId: watch.translator.turnId }).catch(() => {});
        }
      }, this.#config.turnTimeoutMs);
      timer.unref?.();
    }
    try {
      const result = await watch.done;
      if (result.kind !== 'permission') {
        // Usage went out per response as Codex reported it; this only closes the turn's tally.
        watch.translator.finalUsage();
        if (result.kind === 'error' && result.error.kind === 'rate_limit' && !result.error.resetsAt) {
          const resetsAt = codexUsageLimitResetAt(this.#rateLimits);
          if (resetsAt) {
            return {
              kind: 'error',
              error: new CodexError('rate_limit', result.error.message, { resetsAt: new Date(resetsAt), ...(result.error.code ? { code: result.error.code } : {}), ...(result.error.status !== undefined ? { status: result.error.status } : {}) }),
            };
          }
        }
      }
      return result;
    } finally {
      stopOnExit?.();
      if (timer) clearTimeout(timer);
    }
  }

  async #turn(run: ActiveRun, inputs: CodexPendingInput[]): Promise<TurnResult> {
    const thread = this.#threadState(run.threadId);
    const turnStartedAt = new Date();
    const planning = (thread.mode ?? this.#config.mode) === 'planning';
    const lead = planning ? [this.#config.planningPrompt ?? CODEX_PLANNING_PROMPT] : [];
    const selection = this.#config.turnSelectionFor ? await this.#config.turnSelectionFor(this) : undefined;
    const text = inputs.map(input => input.text).join('\n\n');
    if (!run.settled) this.#echo(inputs, run, false, selection?.modelSwitch);
    run.begun = true;
    run.unsent = inputs;
    const policy = (await this.#config.policyFor?.(this)) ?? {};
    run.policy = policy;
    const turnContext = await this.#config.turnContextFor?.(this);
    if (run.abortRequested) return { kind: 'aborted' };
    const server = await this.#openThread(run, policy, selection);
    run.markStarted();
    if (run.abortRequested) return { kind: 'aborted' };
    const codexThreadId = run.codexThreadId!;
    const model = selection?.model ?? run.threadModel;
    this.#emitTranscript({ kind: 'init', sessionId: codexThreadId, ...(model ? { model } : {}) }, run);
    const translator = new CodexTurnTranslator({ threadId: codexThreadId, usage: this.#usage });
    const watch = newTurnWatch(translator);
    run.watch = watch;
    const defaults = planning
      ? codexRuntimeModeTurnDefaults('approval-required', policy.networkAccess)
      : codexRuntimeModeTurnDefaults(policy.runtimeMode ?? 'auto-accept-edits', policy.networkAccess);
    // The thread's history when its Codex thread is new after a failed resume, or a handoff a move from
    // another harness left pending: ahead of the person's request, which is sent as written.
    const resumeFailed = run.resumeFailed === true;
    run.resumeFailed = false;
    const handoff = await this.#handoffFor(resumeFailed ? 'resume_failed' : 'turn', text, turnStartedAt);
    const prompt = [...lead, ...(turnContext ? [turnContext] : []), promptWithTurnHandoff(handoff, text)].join('\n\n');
    const params: TurnStartParams = {
      threadId: codexThreadId,
      input: [{ type: 'text', text: prompt }],
      cwd: await this.#cwd(),
      ...(selection?.model ? { model: selection.model } : {}),
      ...(selection?.effort ? { effort: selection.effort } : {}),
      ...(selection?.serviceTier ? { serviceTier: selection.serviceTier } : {}),
      // Catalogues can default summaries to "none"; request them explicitly on every turn.
      summary: 'detailed',
      approvalsReviewer: 'user',
      approvalPolicy: policy.unattended && !policy.parkAsks ? 'never' : defaults.approvalPolicy,
      sandboxPolicy: defaults.sandboxPolicy,
      // Codex supplies its own mode instructions; both modes are sent so a turn after planning leaves plan mode.
      ...(model
        ? { collaborationMode: { mode: planning ? 'plan' : 'default', settings: { model, ...(selection?.effort ? { reasoning_effort: selection.effort } : {}) } } }
        : {}),
    };
    const held = this.#processCredentials.get(server);
    if (held) held.tried = [];
    run.turnParams = params;
    const failed = await this.#startTurn(run, server, params, translator);
    if (failed) {
      await handoff?.unsent().catch(error => console.warn('[codex harness] Unable to keep the handoff pending.', error));
      return failed;
    }
    if (handoff) void handoff.delivered().catch(error => console.warn('[codex harness] Unable to record the handoff as delivered.', error));
    // Codex has the prompt: from here on the input counts as delivered.
    if (run.unsent) {
      this.#markDelivered(run.unsent);
      run.unsent = undefined;
      void this.#save().catch(() => {});
    }
    return this.#switchAccounts(run, await this.#awaitTurn(run, watch));
  }

  /** The host's handoff for this turn; a failing hook leaves the turn without one rather than failing it. */
  async #handoffFor(reason: 'turn' | 'resume_failed', prompt: string, turnStartedAt: Date): Promise<TurnHandoffContext | undefined> {
    if (!this.#config.handoffContextFor) return undefined;
    try {
      const handoff = await this.#config.handoffContextFor(this, { reason, prompt, turnStartedAt });
      return handoff?.context ? handoff : undefined;
    } catch (error) {
      console.warn('[codex harness] Unable to read the context handoff for this turn.', error);
      return undefined;
    }
  }

  async #startTurn(run: ActiveRun, server: CodexAppServerProcess, params: TurnStartParams, translator: CodexTurnTranslator): Promise<TurnResult | undefined> {
    try {
      const started = await server.client.request('turn/start', params);
      if (!translator.turnId) translator.begin(started.turn.id);
      return undefined;
    } catch (error) {
      return { kind: 'error', error: error instanceof CodexError ? error : new CodexError('process', `Codex refused the turn: ${error instanceof Error ? error.message : String(error)}`, { cause: error }) };
    }
  }

  /**
   * A turn that ran out of usage (or was refused) goes on under the next account, in the same
   * thread: the prompt is already there, so the new turn tells Codex to go on instead. Whether the
   * turn was fresh or a parked one the person's answer resumed, it switches the same way.
   */
  async #switchAccounts(run: ActiveRun, first: TurnResult): Promise<TurnResult> {
    let result = first;
    while (result.kind === 'error' && run.server && run.codexThreadId && run.turnParams && (await this.#nextAccount(run, result.error))) {
      const server = run.server;
      const translator = new CodexTurnTranslator({ threadId: run.codexThreadId, usage: this.#usage });
      const watch = newTurnWatch(translator);
      run.watch = watch;
      const params: TurnStartParams = { ...run.turnParams, input: [{ type: 'text', text: CODEX_ACCOUNT_SWITCH_PROMPT }] };
      const failed = await this.#startTurn(run, server, params, translator);
      if (failed) return failed;
      result = await this.#awaitTurn(run, watch);
    }
    return result;
  }
}
