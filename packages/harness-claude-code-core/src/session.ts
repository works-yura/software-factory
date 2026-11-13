import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { elicitationQuestions, elicitationResponse, type ElicitationPlan, type McpElicitationResponse } from '@factory/harness/elicitation';
import { applyClaudePromptEffortPrefix } from '@factory/harness/models/model';
import type { ModelSelection } from '@factory/harness/models/contracts';
import type { UsageLimitsUpdateEvent } from '@factory/harness/usage';
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
  buildClaudeArgs,
  buildClaudeEnv,
  runClaude,
  userMessage,
  type ClaudeArgsInput,
  type ClaudePermissionMode,
  type ClaudeRun,
  type ClaudeSessionMode,
  type ClaudeSettingSource,
  type ClaudeSpawn,
} from './cli.ts';
import { ClaudeCodeError } from './errors.ts';
import {
  ASK_USER_QUESTION_TOOL,
  askUserPrompt,
  TurnTranslator,
  type ClaudeMessageAuthor,
  type ClaudeNotificationRecord,
  type ClaudeTranscriptEntry,
  type PermissionRequest,
  type PlanGate,
  type TurnOutcome,
} from './events.ts';
import {
  GATE_SERVER_NAME,
  GATE_UNATTENDED_ARG,
  GATE_SYSTEM_PROMPT,
  PERMISSION_PROMPT_TOOL_ID,
  PLANNING_DISALLOWED_TOOLS,
  PLANNING_PROMPT,
  SUBMIT_PLAN_TOOL_ID,
  SUBMIT_PLAN_TOOL_NAME,
  gateMcpConfig,
  type GateServerCommand,
} from './gate.ts';
import { writeGateServerScript } from './gate-server.ts';
import { claudeNotificationDecision } from './notifications.ts';
import { claudePermissionRules, type ClaudeToolPermissions } from './permissions.ts';
import { emptyThreadState, type ClaudePendingInput, type ClaudeSessionRecord, type ClaudeSessionStore, type ClaudeThreadState } from './store.ts';
import { parseStreamLine, type ClaudeStreamMessage } from './stream.ts';
import { claudeRateLimitWindows } from './usageLimits.ts';

/** How many delivered signal ids and dedupe keys a thread remembers. */
const RECENT_LIMIT = 200;
/** How long a turn waits, in its live process, for a person to answer an MCP server's form. */
const DEFAULT_PARK_TIMEOUT_MS = 30 * 60_000;
/** Leads the id of the question card an MCP elicitation is asked as. */
const ELICITATION_CALL_PREFIX = 'elicitation-';

/** What the chat says when a run was stopped before Claude read a person's message (an `undelivered` error). */
export const UNDELIVERED_MESSAGE =
  'The run was stopped before Claude read this message. It is kept and goes to Claude with the next message you send.';

/** A person's message (or a signal) the chat already shows as sent: not a notification, a gate answer or a plan decision. */
function isShownMessage(input: ClaudePendingInput): boolean {
  return input.kind === 'signal' && !input.gate && !input.planDecision && input.echoed === true;
}

/**
 * The request-context key a person's identity travels under when they write
 * (Mastra's `MASTRA_MESSAGE_AUTHOR_KEY`); their message is stamped with it.
 */
export const MESSAGE_AUTHOR_KEY = 'mastra__messageAuthor';

/** The author a request context carries, in the shape Mastra stamps on a message. */
export function messageAuthor(requestContext: AgentRunContext | undefined): ClaudeMessageAuthor | undefined {
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
 * A notification as Factory callers send it: the contract's fields plus the
 * ones a Mastra notification record also keeps (`SendNotificationSignalInput`).
 */
export type ClaudeNotificationInput = AgentNotificationInput & {
  id?: string;
  coalesceKey?: string;
  attributes?: Record<string, string | number | boolean | null | undefined>;
  metadata?: Record<string, unknown>;
};

/** What one turn runs on, from {@link ClaudeCodeSessionConfig.turnSelectionFor}. */
export interface ClaudeTurnSelection {
  /** `--model`. */
  model?: string;
  /** `--effort`. */
  effort?: string;
  /** Joins the turn's `--settings` (e.g. `fastMode`, `ultracode`). */
  settings?: Record<string, unknown>;
  /** An effort the CLI reads from the prompt: `ultrathink` prefixes the input with `Ultrathink:`. */
  promptEffort?: string;
  /** The selection changed since the thread's last turn: recorded on the turn's first input. */
  modelSwitch?: ClaudeModelSwitch;
}

/** A model or effort change between two turns, recorded on the user message that starts the turn. */
export interface ClaudeModelSwitch {
  from: ModelSelection;
  to: ModelSelection;
}

/** How a person's chat message joins the session (the chat's message, follow-up and steer routes). */
export type ClaudeChatDelivery = 'message' | 'follow-up' | 'steer';

/** Emitted (besides the contract's events) whenever the number of queued follow-ups changes, as Mastra does. */
export interface FollowUpQueuedEvent {
  type: 'follow_up_queued';
  count: number;
}

/** Settings sources a turn reads by default: the repo's, never the person's own `~/.claude/settings.json`. */
export const DEFAULT_SETTING_SOURCES: ClaudeSettingSource[] = ['project', 'local'];
/** Where plan files would go if the CLI's plan mode ever ran (relative to the session cwd), instead of `~/.claude/plans`. */
export const NO_ATTRIBUTION = { commit: '', pr: '' };
const DEFAULT_PLANS_DIRECTORY = '.claude/plans';

/**
 * Configuration for Claude Code sessions.
 *
 * Planning: a thread in mode `planning` runs with the default permission
 * mode, the file-editing tools denied (`planningDisallowedTools`) and a
 * planning preamble on its prompt; Claude ends the plan by calling the gate's
 * `submit_plan` tool (`mcp__factory_gate__submit_plan`), which stops the turn,
 * emits `tool_suspended` and parks the thread. Approval resumes the same
 * Claude session in `approvedPermissionMode`; rejection resumes it in
 * `planning` with the feedback. The CLI's own plan mode is never used: `-p`
 * has no ExitPlanMode and plan mode writes into the config dir.
 *
 * Isolation: by default turns read only the project's and local settings
 * (`settingSources`) and only the MCP servers given here (`strictMcpConfig`),
 * so the person's global plugins, hooks, output style and MCP servers stay out
 * of Factory sessions. `configDir` moves everything else the CLI writes
 * (session files, todos, plans) out of `~/.claude`.
 */
export interface ClaudeCodeSessionConfig
  extends Pick<
    ClaudeArgsInput,
    'model' | 'effort' | 'allowedTools' | 'disallowedTools' | 'appendSystemPrompt' | 'includePartialMessages' | 'maxTurns' | 'extraArgs'
  > {
  store: ClaudeSessionStore;
  /**
   * Credentials for one turn as env (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
   * `CLAUDE_CONFIG_DIR`). A `CLAUDE_CONFIG_DIR` returned here wins over {@link configDir}.
   *
   * A hook with several accounts returns {@link ClaudeTurnCredentials} naming the
   * account. When that account hits a usage limit or is refused, the turn asks
   * again with the accounts it tried in `request.exclude` and goes on, in the
   * same Claude session, with the next one; a hook with no account left throws
   * (a `rate_limit` {@link ClaudeCodeError} with `resetsAt`, say).
   */
  credentials: (
    session: ClaudeCodeSession,
    request: ClaudeCredentialRequest,
  ) => Promise<Record<string, string> | ClaudeTurnCredentials>;
  /**
   * Whether a run that stopped because every account is out of usage parks the session until the
   * limit resets (`usageLimitPark`, `usage_limit_parked`) instead of failing. Unset, a limited run
   * fails as any other. A host whose own scheduler resumes some sessions (a card's run) answers
   * `false` for those; whoever parks sessions resumes them (`resumeFromUsageLimit` at `until`).
   */
  parkOnUsageLimit?: (session: ClaudeCodeSession) => boolean | Promise<boolean>;
  /** Told when a turn's account hit a usage limit or was refused, before the turn asks for another. */
  onCredentialFailure?: (session: ClaudeCodeSession, failure: ClaudeCredentialFailure) => void | Promise<void>;
  /** The session's working directory; asked once, before its first turn. */
  cwdFor: (sessionId: string) => string | Promise<string>;
  /**
   * The CLI's config dir for this session (`CLAUDE_CONFIG_DIR`), so its session
   * files and anything else the CLI writes stay out of the person's `~/.claude`.
   * Unset (or `undefined`) keeps the default dir. The CLI's stored sign-in moves
   * with it (`CLAUDE_SECURESTORAGE_CONFIG_DIR`), so nothing of the default dir's
   * login carries over: the credentials hook must return `CLAUDE_CODE_OAUTH_TOKEN`
   * or `ANTHROPIC_API_KEY`. Keep it stable per session, or `--resume` cannot find
   * the session's files.
   */
  configDir?: (session: ClaudeCodeSession) => string | undefined;
  /**
   * `--model` for this session, asked before each turn; wins over the static {@link model}.
   * `undefined` falls back to {@link model}, and with neither the CLI picks its own default.
   * A function so a host can read a per-session setting (a Factory's chosen model) when the turn starts.
   */
  modelFor?: (session: ClaudeCodeSession) => string | undefined | Promise<string | undefined>;
  /**
   * The model selection for this session's next turn, asked before each turn (before its input is
   * echoed). Its `model` and `effort` win over {@link modelFor} and {@link effort}; its `settings`
   * join `--settings`; a `promptEffort` the CLI reads from the prompt (`ultrathink`) prefixes the
   * input (slash commands excepted); a `modelSwitch` marks the turn's first input in the transcript.
   */
  turnSelectionFor?: (session: ClaudeCodeSession) => ClaudeTurnSelection | undefined | Promise<ClaudeTurnSelection | undefined>;
  /**
   * MCP servers for every turn (e.g. the Factory MCP endpoint); the gate server is added to them.
   * A function is asked before each turn, so per-session servers can carry credentials minted for that turn.
   */
  mcpConfig?:
    | ClaudeMcpConfig
    | ((session: ClaudeCodeSession) => ClaudeMcpConfig | undefined | Promise<ClaudeMcpConfig | undefined>);
  /** Only the MCP servers given here and the gate; `true` by default. `false` also loads the user's and project's. */
  strictMcpConfig?: boolean;
  /**
   * `--setting-sources`; `['project', 'local']` by default, which leaves out the
   * person's `~/.claude/settings.json` (plugins, hooks, output style). `false`
   * passes no flag, so the CLI reads every source.
   */
  settingSources?: ClaudeSettingSource[] | false;
  /**
   * `--setting-sources` for this session's next turn; wins over {@link settingSources}.
   * `[]` reads no settings file at all: for a checkout someone outside wrote (a
   * pull request), whose `.claude/settings.json` hooks would otherwise run here.
   */
  settingSourcesFor?: (
    session: ClaudeCodeSession,
  ) => ClaudeSettingSource[] | false | undefined | Promise<ClaudeSettingSource[] | false | undefined>;
  /**
   * The CLI's `plansDirectory` setting, relative to the session cwd; `.claude/plans`
   * by default. The harness never enters plan mode itself; this keeps plan files
   * out of `~/.claude/plans` should a project's settings turn plan mode on. `false` leaves it unset.
   */
  plansDirectory?: string | false;
  /**
   * The CLI's `attribution` setting: the text it adds to commits and pull requests.
   * Empty by default, so nothing says "Generated with Claude Code" or adds a
   * Co-Authored-By line. `false` leaves it to the CLI.
   */
  attribution?: { commit: string; pr: string } | false;
  /**
   * The tool permissions for this session's next turn (the host's settings),
   * asked before each turn so a change applies from the next one. Each
   * category's policy becomes CLI rules (see `claudePermissionRules`): `ask`
   * calls go to the gate's permission tool, which parks the run until a person
   * answers ({@link ClaudeCodeSession.respondToToolApproval}). Unset, the turn
   * runs with {@link allowedTools} and the CLI's own defaults, and a call the
   * CLI would ask about still parks the run.
   */
  permissions?: (session: ClaudeCodeSession) => ClaudeToolPermissions | undefined | Promise<ClaudeToolPermissions | undefined>;
  /** MCP servers that are the host's own plumbing (e.g. the Factory's tools): the MCP category never governs them. */
  trustedMcpServers?: string[];
  /**
   * The appended system prompt for this session, asked before each turn; wins
   * over {@link appendSystemPrompt}. It must not change between a session's
   * turns (the CLI replays the first one on resume), so answer per session,
   * e.g. a different playbook for a host's own assistant session.
   */
  appendSystemPromptFor?: (session: ClaudeCodeSession) => string | undefined | Promise<string | undefined>;
  /**
   * Context the agent reads ahead of this turn's input, asked once the
   * working directory is ready (e.g. which repositories it holds and where).
   * Unlike the system prompt it may change between turns; the transcript does
   * not show it.
   */
  turnContextFor?: (session: ClaudeCodeSession) => string | undefined | Promise<string | undefined>;
  /**
   * Context a turn carries over from another conversation (`@factory/harness/turn-handoff`):
   * asked before every turn, and again with `resume_failed` when the CLI no longer has the session
   * the thread resumes, so the fresh conversation gets the thread's history instead of none. Its
   * context goes ahead of the prompt (after `turnContextFor`'s); `delivered` is called once the
   * CLI has the prompt, `unsent` when it never did.
   */
  handoffContextFor?: TurnHandoffHook<ClaudeCodeSession>;
  /**
   * How the gate server is started. By default each turn writes it next to its
   * MCP config (`gate-server.ts`) and runs it with this process's Node.
   */
  gateServer?: GateServerCommand;
  spawn?: ClaudeSpawn;
  /** The CLI: a path, or the server's resolver (`@factory/harness/executable`); `claude` on PATH by default. */
  command?: HarnessCommand;
  /** Mode a new thread starts in; `planning` to start with a plan for approval. */
  mode?: ClaudeSessionMode;
  /** Mode after a person approves a plan; `acceptEdits` by default. */
  approvedPermissionMode?: ClaudePermissionMode;
  /**
   * Leads every planning turn's prompt; {@link PLANNING_PROMPT} by default. A host
   * whose instructions name another terminal step (e.g. a skill that ends with a
   * card move) says here that the plan gate replaces it.
   */
  planningPrompt?: string;
  /** Tools denied while planning; {@link PLANNING_DISALLOWED_TOOLS} by default. */
  planningDisallowedTools?: string[];
  turnTimeoutMs?: number;
  /**
   * How long a turn waits, in its live process, for a person to answer an MCP
   * server's elicitation (30 minutes by default). Past it the process is
   * stopped and a later answer goes to Claude as the next turn.
   */
  parkTimeoutMs?: number;
  /**
   * The environment turns inherit from; `process.env` by default. Only the
   * names in `DEFAULT_CLAUDE_ENV_ALLOWLIST` and {@link passEnv} reach the CLI,
   * never credential keys.
   */
  env?: Record<string, string | undefined>;
  /** Where a turn's private MCP config file goes; the OS temp dir by default. */
  tempDir?: string;
  /** More variable names the CLI may inherit, e.g. a test runner's or package registry's settings. */
  passEnv?: string[];
}

export type ClaudeMcpConfig = string | Record<string, unknown> | Array<string | Record<string, unknown>>;

/** What a turn asks the credentials hook. */
export interface ClaudeCredentialRequest {
  /** The account the session used last; staying on it keeps the provider's prompt cache. */
  preferredAccountId?: string;
  /** Accounts this turn already tried and lost to a limit or a refusal. */
  exclude: string[];
}

/** One account's credentials for a turn. */
export interface ClaudeTurnCredentials {
  env: Record<string, string>;
  /** Names the account, so the turn can move off it when it runs out. */
  accountId?: string;
  /** How the chat names the account the turn runs on (a reply's credential), and whose sign-in it is. */
  credential?: { label: string; ownerId?: string };
}

export interface ClaudeCredentialFailure {
  accountId: string;
  error: ClaudeCodeError;
}

/**
 * How many times the CLI may retry a rate-limited request before a turn with
 * an account pool moves to the next account. The CLI's own backoff runs ten
 * retries over minutes; without a pool it is left to do so.
 */
export const RATE_LIMIT_RETRIES_BEFORE_SWITCH = 2;

/** How many times one turn moves to another account before it gives up. */
export const MAX_ACCOUNT_SWITCHES = 10;

/**
 * Sent instead of the turn's prompt when it goes on under another account
 * after the CLI had started the conversation: the prompt is already in the
 * session, so sending it again would repeat it.
 */
export const ACCOUNT_SWITCH_PROMPT =
  'Your previous attempt at this request stopped because the account ran out of usage. The session now runs on another account. Continue where you stopped.';

function turnCredentials(value: Record<string, string> | ClaudeTurnCredentials): ClaudeTurnCredentials {
  return typeof (value as ClaudeTurnCredentials).env === 'object' ? (value as ClaudeTurnCredentials) : { env: value as Record<string, string> };
}

export type ClaudeTranscriptListener = (entry: ClaudeTranscriptEntry, meta: { runId: string; threadId: string }) => void;

interface ActiveRun {
  runId: string;
  threadId: string;
  /** Input that arrived while a turn ran; it becomes the run's next turn. */
  queue: ClaudePendingInput[];
  /** The current turn's input until the CLI took it (its `init`); given back if the turn never started. */
  unsent?: ClaudePendingInput[];
  process?: ClaudeRun;
  /** The current attempt's stream, so a stop still counts the usage it saw. */
  translator?: TurnTranslator;
  /** The run's first turn recorded its input; input that joins later is recorded as it comes. */
  begun?: boolean;
  abortRequested: boolean;
  settled: boolean;
  /** Tools the current turn asks about on every call (see `ClaudeToolPermissions.askEachTime`). */
  askEachTime?: string[];
  /** Nobody attends the current turn and it may not park: an MCP server's question is dismissed. */
  unattended?: boolean;
  /** The usage-limit park this run took up (its first park's time counts toward the cap). */
  priorPark?: UsageLimitPark;
  /** Resolves once the first turn's process was spawned, rejects when it never was. */
  started: Promise<void>;
  markStarted(error?: unknown): void;
  ended: Promise<AgentRunEndReason>;
  resolveEnded(reason: AgentRunEndReason): void;
  /** The loop driving the run is done and its process has exited. */
  loopDone: Promise<void>;
}

type Accepted = { action: 'deliver' | 'wake'; run: ActiveRun } | { action: 'persist' };

/**
 * A turn that waits, in its live process, for a person to answer an MCP
 * server's elicitation (asked as a question card). Its run ended `suspended`;
 * the answer picks the same run object up again and the turn goes on.
 */
interface ParkedElicitation {
  run: ActiveRun;
  process: ClaudeRun;
  /** The CLI's `control_request` id the answer goes back under. */
  requestId: string;
  toolCallId: string;
  plan: ElicitationPlan;
  timer: NodeJS.Timeout;
}

/** The CLI's answer to one of its control requests. */
function controlResponse(requestId: string, response: Record<string, unknown>): Record<string, unknown> {
  return { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } };
}

function controlError(requestId: string, error: string): Record<string, unknown> {
  return { type: 'control_response', response: { subtype: 'error', request_id: requestId, error } };
}

function textField(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** An `elicitation` control request in the shape the question-card mapping reads. */
function elicitationRequest(request: Record<string, unknown>) {
  const serverName = textField(request.mcp_server_name);
  const mode = textField(request.mode);
  const message = textField(request.message);
  const url = textField(request.url);
  const elicitationId = textField(request.elicitation_id);
  return {
    ...(serverName ? { serverName } : {}),
    ...(mode ? { mode } : {}),
    ...(message ? { message } : {}),
    ...(request.requested_schema !== undefined ? { requestedSchema: request.requested_schema } : {}),
    ...(url ? { url } : {}),
    ...(elicitationId ? { elicitationId } : {}),
  };
}

const escapeAttribute = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
/** Only the envelope's own tags are escaped in the body, so the text reads as written otherwise. */
const escapeNotificationBody = (value: string) =>
  value.replace(/<(\/?)system-notification/gi, (_match, slash: string) => `&lt;${slash}system-notification`);

function formatNotification(
  input: Pick<ClaudeNotificationRecord, 'source' | 'kind' | 'payload' | 'summary'> & { priority?: string },
): string {
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
  if (request.toolCallId.startsWith(ELICITATION_CALL_PREFIX)) {
    // The server's request closed with the turn that asked it; Claude hears the answer instead.
    return [
      'An MCP server asked the person this while a tool call ran; the request closed before they answered:',
      prompt.question,
      `Their answer:\n${answer}`,
      "If you still need what the server asked for, call its tool again; don't ask the person the same question.",
    ].join('\n\n');
  }
  return [
    `You asked the person (\`${ASK_USER_QUESTION_TOOL}\`, which does not run here):`,
    prompt.question,
    `Their answer:\n${answer}`,
    'Go on with that answer; do not ask the same question again.',
  ].join('\n\n');
}

function rejectionPrompt(decision: PlanDecision): string {
  const parts = ['The plan was not approved.'];
  if (decision.feedback?.trim()) parts.push(`Reviewer feedback:\n${decision.feedback.trim()}`);
  parts.push(`Make no changes. Revise the plan and submit it again with \`${SUBMIT_PLAN_TOOL_ID}\`.`);
  return parts.join('\n\n');
}

function remember(list: string[], value: string): string[] {
  if (list.includes(value)) return list;
  const next = [...list, value];
  return next.length > RECENT_LIMIT ? next.slice(next.length - RECENT_LIMIT) : next;
}

/**
 * One Factory session on Claude Code. The CLI is turn-based, so the contract's
 * live-run primitives are emulated:
 *  - a run is a chain of CLI turns: input that arrives mid-turn is queued and
 *    sent as the next turn (`--resume`) before the run ends, so a `deliver`
 *    really joins the run in flight;
 *  - a human gate ends the turn: a `submit_plan` call (the gate MCP server's
 *    tool, or ExitPlanMode should a CLI offer it) stops the process and the
 *    run ends `suspended`; the answer resumes the session in a new run.
 */
export class ClaudeCodeSession implements AgentSession {
  readonly id: string;
  readonly #config: ClaudeCodeSessionConfig;
  #record: ClaudeSessionRecord;
  #run: ActiveRun | undefined;
  /** A turn waiting in its live process for a person's answer to an MCP server's form. */
  #parked: ParkedElicitation | undefined;
  /** The last run's loop; a new turn waits for it so two processes never write one Claude session. */
  #barrier: Promise<void> = Promise.resolve();
  #listeners = new Set<AgentEventListener>();
  #transcriptListeners = new Set<ClaudeTranscriptListener>();
  #saving: Promise<void> = Promise.resolve();

  constructor(record: ClaudeSessionRecord, config: ClaudeCodeSessionConfig) {
    this.id = record.sessionId;
    this.#record = record;
    this.#config = config;
    this.#threadState(record.threadId);
  }

  get resourceId(): string | undefined {
    return this.#record.resourceId;
  }

  /** Where the CLI runs, once the first turn fixed it. */
  get cwd(): string | undefined {
    return this.#record.cwd;
  }

  /** The CLI session id of the current thread, once its first turn started. */
  get claudeSessionId(): string | undefined {
    return this.#threadState().claudeSessionId;
  }

  /** The current thread's mode; `undefined` runs with the CLI's default permission mode. */
  get mode(): ClaudeSessionMode | undefined {
    return this.#threadState().mode ?? this.#config.mode;
  }

  /** Switches the current thread's mode for its next turn, e.g. into `planning` before a planning stage. */
  async setMode(mode: ClaudeSessionMode): Promise<void> {
    this.#threadState().mode = mode;
    await this.#save();
  }

  /** The plan the current thread is parked on, if any. */
  get pendingPlan(): PlanGate | undefined {
    const gate = this.#threadState().pendingGate;
    return gate ? { ...gate } : undefined;
  }

  /** Whether the question the thread is parked on still has its turn waiting in a live process (an MCP server's form). */
  get hasLiveGate(): boolean {
    return this.#parked !== undefined;
  }

  /** The tool call the current thread is parked on until a person allows or denies it, if any. */
  get pendingPermission(): PermissionRequest | undefined {
    const request = this.#threadState().pendingPermission;
    return request ? structuredClone(request) : undefined;
  }

  /** Tools a person allowed for the rest of the current thread. */
  get grantedTools(): string[] {
    return [...(this.#threadState().grantedTools ?? [])];
  }

  /** The account the session's last turn ran on, when its credentials named one. */
  get accountId(): string | undefined {
    return this.#record.accountId;
  }

  /** The id of the run in flight. */
  get runId(): string | undefined {
    return this.#run?.runId;
  }

  /** A person's follow-ups waiting for the run in flight to end (Mastra's `queuedFollowUps`). */
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
    listActiveMessages: async (): Promise<Array<{ id: string }>> =>
      this.#threadState().deliveredIds.map(id => ({ id })),
    getSetting: async ({ key }: { key: string }): Promise<unknown> => this.#threadState().settings[key],
    setSetting: async ({ key, value }: { key: string; value: unknown }): Promise<void> => {
      this.#threadState().settings[key] = value;
      await this.#save();
    },
  };

  readonly stream = {
    isActive: (): boolean => !!this.#run && !this.#run.settled && !!this.#run.process?.isAlive(),
  };

  readonly run = {
    isRunning: (): boolean => !!this.#run && !this.#run.settled,
  };

  readonly suspensions = {
    hasPending: (): boolean =>
      this.#threadState().pendingGate !== undefined || this.#threadState().pendingPermission !== undefined,
  };

  subscribe(listener: AgentEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The turn's text, thinking and tool calls, for the UI thread. */
  onTranscript(listener: ClaudeTranscriptListener): () => void {
    this.#transcriptListeners.add(listener);
    return () => this.#transcriptListeners.delete(listener);
  }

  /**
   * Stops the run now: `agent_end: aborted` is emitted before this returns; the
   * process is stopped behind it. The usage the turn reported so far is
   * counted first. Queued follow-ups then start their own run, as Mastra's
   * queue drains once the thread is idle.
   *
   * `source` names who stopped it (`chat`, `delete`, …) for the log. A person's message the run
   * carried that Claude never read (e.g. the run was still setting its checkout up) waits for the
   * next turn, and the chat says so with an `undelivered` error instead of going quiet.
   */
  abort(source = 'host'): void {
    this.#abort(true, { source, reportUndelivered: true });
  }

  #abort(drainFollowUps: boolean, { source, reportUndelivered = false }: { source: string; reportUndelivered?: boolean }): void {
    const run = this.#run;
    if (!run || run.settled) return;
    run.abortRequested = true;
    // A stop ends a run without a word from Claude: the log says who stopped it and how far it got.
    console.info('[claude-code harness] Run stopped.', {
      sessionId: this.id,
      runId: run.runId,
      source,
      stage: run.process ? 'running' : run.begun ? 'setting up, no Claude process yet' : 'waiting to start',
    });
    run.process?.terminate();
    this.#reportUsage(run, true);
    this.#settle(run, 'aborted', { drainFollowUps, reportUndelivered });
  }

  /** Resolves when the run the message started or joined ends. */
  async sendMessage(input: { content: string; requestContext?: AgentRunContext }): Promise<unknown> {
    const author = messageAuthor(input.requestContext);
    const accepted = this.#accept([{ kind: 'signal', text: input.content, ...(author ? { author } : {}) }], true);
    if (accepted.action === 'persist') return undefined;
    if (accepted.action === 'wake') await accepted.run.started;
    return { reason: await accepted.run.ended };
  }

  /**
   * A person's chat message, as Mastra's session routes take one: `message`
   * starts a run or joins the one in flight (an interjection); `follow-up`
   * waits for the run in flight to end and then starts its own
   * (`follow_up_queued` tells the chat how many wait); `steer` gives the
   * message to the turn in flight on its stdin, where Claude reads it at its
   * next step without stopping, or, when no live turn can take it, stops the
   * run and starts a new one with it, keeping queued follow-ups. The message
   * carries its author from the request context.
   * Resolves once the message is taken; a run that then fails says so as an
   * `error` event.
   */
  async sendChatMessage(input: {
    content: string;
    requestContext?: AgentRunContext;
    delivery?: ClaudeChatDelivery;
  }): Promise<{ action: 'wake' | 'deliver' | 'queued' }> {
    const author = messageAuthor(input.requestContext);
    const message: ClaudePendingInput = { kind: 'signal', text: input.content, ...(author ? { author } : {}) };
    const delivery = input.delivery ?? 'message';
    if (delivery === 'follow-up' && this.run.isRunning()) {
      const thread = this.#threadState();
      thread.followUps = [...(thread.followUps ?? []), message];
      await this.#save();
      this.#emitFollowUpCount();
      return { action: 'queued' };
    }
    if (delivery === 'steer') {
      if (this.#steer(message)) return { action: 'deliver' };
      // What the stopped run carried goes with the steer's own run, which starts right below.
      this.#abort(false, { source: 'steer' });
    }
    const accepted = this.#accept([message], true);
    if (accepted.action === 'persist') throw new Error('unreachable: chat messages always wake');
    return { action: accepted.action };
  }

  sendSignal(
    input: AgentSignalInput,
    options: { requestContext: AgentRunContext; requireDelivery?: boolean },
  ): AgentSignalResult {
    let accepted: Accepted;
    const author = messageAuthor(options.requestContext);
    try {
      accepted = this.#accept([{ kind: 'signal', id: input.id, text: signalText(input), ...(author ? { author } : {}) }], true);
    } catch (error) {
      return { accepted: Promise.reject(error) };
    }
    if (accepted.action === 'persist') throw new Error('unreachable: signals always wake');
    const result = { accepted: true as const, runId: accepted.run.runId, action: accepted.action };
    if (accepted.action === 'wake' && options.requireDelivery) {
      return { accepted: accepted.run.started.then(() => result) };
    }
    return { accepted: Promise.resolve(result) };
  }

  /**
   * Gives the agent a notification as a Mastra session's delivery policy
   * would (see {@link claudeNotificationDecision}): urgent ones, and high and
   * medium ones on an idle thread, are delivered (`ifActive`/`ifIdle` decide
   * whether that joins the run in flight or wakes an idle session); a high one
   * that comes mid-run is delivered in a run of its own once the run in
   * flight ends; medium ones mid-run and low ones are held for the next run
   * instead of interrupting or waking (Mastra summarizes them into its
   * notification inbox; Claude has no inbox to read them from, so the full
   * notice goes with the next run). A notice still waiting merges a newer one with the same
   * source, kind and coalesce key, as Mastra's notification store does.
   */
  async sendNotificationSignal(
    input: ClaudeNotificationInput,
    options: AgentNotificationOptions = {},
  ): Promise<AgentNotificationResult> {
    const thread = this.#threadState();
    if (input.dedupeKey && thread.dedupeKeys.includes(input.dedupeKey)) {
      // Already given to the agent; a retry of the same decision must not repeat it.
      return { persisted: Promise.resolve(), accepted: Promise.resolve({ action: 'deliver' }) };
    }
    if (input.dedupeKey) thread.dedupeKeys = remember(thread.dedupeKeys, input.dedupeKey);
    const record = this.#notificationRecord(thread, input);
    // The text Claude reads names a priority only when the sender gave one.
    const text = formatNotification({ ...record, priority: input.priority });
    const pending: ClaudePendingInput = { kind: 'notification', text, notification: record };
    const active = this.run.isRunning();
    const allowed = active
      ? (options.ifActive?.behavior ?? 'deliver') === 'deliver'
      : (options.ifIdle?.behavior ?? 'persist') === 'wake';
    const decision = claudeNotificationDecision({ record, threadState: active ? 'active' : 'idle', now: new Date() });
    if (allowed && decision.action === 'summarize' && decision.deliverAt) {
      // Mastra delivers the full notice once the run in flight is over.
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
    if (accepted.action === 'deliver') {
      return { persisted: this.#save(), accepted: Promise.resolve({ action: 'deliver' }) };
    }
    return {
      persisted: this.#save(),
      accepted: run.started.then(() => ({
        action: 'wake',
        output: { consumeStream: () => run.ended },
      })),
    };
  }

  async respondToToolSuspension({ resumeData, toolCallId }: { resumeData: PlanDecision; toolCallId?: string }): Promise<void> {
    const thread = this.#threadState();
    // A caller that only knows the contract's gate answers a permission request with a plan decision.
    if (!thread.pendingGate && thread.pendingPermission) {
      return this.respondToToolApproval({
        approved: resumeData.action === 'approved',
        ...(toolCallId ? { toolCallId } : {}),
      });
    }
    const gate = thread.pendingGate;
    if (!gate) throw new Error('This session is not waiting on a person.');
    if (toolCallId && toolCallId !== gate.toolCallId) {
      throw new Error(`This session is waiting on ${gate.toolCallId}, not ${toolCallId}.`);
    }
    if (this.#run) throw new Error('Cannot answer a gate while a run is in flight.');
    thread.pendingGate = undefined;
    const approved = resumeData.action === 'approved';
    thread.mode = approved ? (this.#config.approvedPermissionMode ?? 'acceptEdits') : 'planning';
    const text = approved ? approvalPrompt(resumeData) : rejectionPrompt(resumeData);
    const accepted = this.#accept([{ kind: 'signal', text, gate: true }], true, { keepGate: true });
    if (accepted.action === 'persist') return;
    this.#emitTranscript({ kind: 'plan_decision', toolCallId: gate.toolCallId, decision: { ...resumeData } }, accepted.run);
    await accepted.run.started;
  }

  /**
   * Answers the tool call the thread is parked on. Allowed, the tool is
   * allowed for the rest of the thread and Claude is told to retry the call;
   * denied, Claude is told so. Either way the same Claude session goes on in a
   * new run.
   */
  async respondToToolApproval({ approved, toolCallId }: { approved: boolean; toolCallId?: string }): Promise<void> {
    const thread = this.#threadState();
    const request = thread.pendingPermission;
    if (!request) throw new Error('This session is not waiting on a permission.');
    if (toolCallId && toolCallId !== request.toolCallId) {
      throw new Error(`This session is waiting on ${request.toolCallId}, not ${toolCallId}.`);
    }
    if (this.#run) throw new Error('Cannot answer a permission while a run is in flight.');
    // Allowing the question would only run it where nobody can answer; it takes an answer instead.
    if (approved && request.toolName === ASK_USER_QUESTION_TOOL) {
      throw new Error('This session is waiting on an answer to its question, not on a permission.');
    }
    thread.pendingPermission = undefined;
    // Declining an MCP server's form while its turn still waits: the server hears the decline and the turn goes on.
    const parked = this.#takeParked(request.toolCallId);
    if (parked) {
      const run = this.#resumeParked(parked, { action: 'decline' });
      if (run) {
        this.#emitTranscript({ kind: 'permission_decision', toolCallId: request.toolCallId, toolName: request.toolName, approved }, run);
        return;
      }
    }
    if (approved && request.once) thread.grantedOnce = [...new Set([...(thread.grantedOnce ?? []), request.toolName])];
    else if (approved) thread.grantedTools = [...new Set([...(thread.grantedTools ?? []), request.toolName])];
    const accepted = this.#accept([{ kind: 'signal', text: permissionPrompt(request, approved), gate: true }], true, {
      keepGate: true,
    });
    if (accepted.action === 'persist') return;
    this.#emitTranscript(
      { kind: 'permission_decision', toolCallId: request.toolCallId, toolName: request.toolName, approved },
      accepted.run,
    );
    await accepted.run.started;
  }

  /**
   * Answers the question (`AskUserQuestion`) the thread is parked on. The call
   * itself never runs: Claude gets the answer as the next turn, in a new run.
   */
  async answerQuestion({ answer, toolCallId }: { answer: string | string[]; toolCallId?: string }): Promise<void> {
    const thread = this.#threadState();
    const request = thread.pendingPermission;
    if (!request || request.toolName !== ASK_USER_QUESTION_TOOL) throw new Error('This session is not waiting on a question.');
    if (toolCallId && toolCallId !== request.toolCallId) {
      throw new Error(`This session is waiting on ${request.toolCallId}, not ${toolCallId}.`);
    }
    if (this.#run) throw new Error('Cannot answer a question while a run is in flight.');
    const text = (Array.isArray(answer) ? answer.join(', ') : answer).trim();
    if (!text) throw new Error('The answer is empty.');
    thread.pendingPermission = undefined;
    // An MCP server's form whose turn still waits: the server gets the typed answers and the same turn goes on.
    const parked = this.#takeParked(request.toolCallId);
    if (parked) {
      const run = this.#resumeParked(parked, elicitationResponse(parked.plan, answer));
      if (run) {
        this.#emitTranscript({ kind: 'question_answer', toolCallId: request.toolCallId, answer: text }, run);
        return;
      }
    }
    const accepted = this.#accept([{ kind: 'signal', text: answerPrompt(request, text), gate: true }], true, {
      keepGate: true,
    });
    if (accepted.action === 'persist') return;
    this.#emitTranscript({ kind: 'question_answer', toolCallId: request.toolCallId, answer: text }, accepted.run);
    await accepted.run.started;
  }

  /**
   * Answers the plan gate without starting a run: the answer leads the next
   * turn instead. For hosts where the approval itself starts the next stage,
   * e.g. a card moved into Building whose kickoff then resumes this session.
   */
  async queuePlanAnswer({ resumeData, toolCallId }: { resumeData: PlanDecision; toolCallId?: string }): Promise<void> {
    const thread = this.#threadState();
    const gate = thread.pendingGate;
    if (!gate) throw new Error('This session is not waiting on a person.');
    if (toolCallId && toolCallId !== gate.toolCallId) {
      throw new Error(`This session is waiting on ${gate.toolCallId}, not ${toolCallId}.`);
    }
    thread.pendingGate = undefined;
    const approved = resumeData.action === 'approved';
    thread.mode = approved ? (this.#config.approvedPermissionMode ?? 'acceptEdits') : 'planning';
    const text = approved ? approvalPrompt(resumeData) : rejectionPrompt(resumeData);
    // Ahead of anything that queued while the plan waited, so Claude reads the verdict first.
    thread.pendingInputs.unshift({
      kind: 'signal',
      text,
      gate: true,
      planDecision: { toolCallId: gate.toolCallId, decision: { ...resumeData } },
    });
    await this.#save();
  }

  // -- internals ------------------------------------------------------------

  /**
   * The record a notification is kept as. One still waiting (not given to the
   * agent yet) with the same source, kind and coalesce key is taken out and
   * merged into it, as Mastra's store coalesces a pending record.
   */
  #notificationRecord(thread: ClaudeThreadState, input: ClaudeNotificationInput): ClaudeNotificationRecord {
    const fresh: ClaudeNotificationRecord = {
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
    const matches = ({ notification }: ClaudePendingInput) =>
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
    const event: FollowUpQueuedEvent = { type: 'follow_up_queued', count: this.queuedFollowUps };
    this.#emit(event as unknown as AgentEvent);
  }

  /** Reports the usage the run's current attempt saw and has not reported yet; `final` takes the rest. */
  #reportUsage(run: ActiveRun, final: boolean) {
    // Usage after the run already ended would be billed to the next run.
    if (run.settled || !run.translator) return;
    for (const usage of run.translator.takeUsage(final)) this.#emit({ type: 'usage_update', usage });
  }

  /** Tells listeners how much of the account's allowance Claude says is used (`usage_limits_update`). */
  #reportUsageLimits(raw: Record<string, unknown>, accountId: string | undefined) {
    const windows = claudeRateLimitWindows(raw.rate_limit_info);
    if (windows.length === 0) return;
    const event: UsageLimitsUpdateEvent = {
      type: 'usage_limits_update',
      ...(accountId ? { accountId } : {}),
      windows,
      checkedAt: new Date().toISOString(),
    };
    this.#emit(event as unknown as AgentEvent);
  }

  /** Records input as the session takes it, once; `whileActive` marks input that joins a run in flight. */
  #echo(inputs: ClaudePendingInput[], run: ActiveRun, whileActive = false, modelSwitch?: ClaudeModelSwitch) {
    let marker = modelSwitch;
    for (const input of inputs) {
      if (input.echoed) continue;
      // A plan answer queued for this turn shows as the decision it is, not as typed input.
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

  /** Input not already waiting under the same signal id (a sender's retry of what is still queued). */
  #fresh(inputs: ClaudePendingInput[], ...waiting: ClaudePendingInput[][]): ClaudePendingInput[] {
    const ids = new Set(waiting.flat().flatMap(input => (input.id ? [input.id] : [])));
    return inputs.filter(input => !input.id || !ids.has(input.id));
  }

  #threadState(threadId = this.#record.threadId): ClaudeThreadState {
    return (this.#record.threads[threadId] ??= emptyThreadState());
  }

  #emit(event: AgentEvent) {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.warn('[claude-code harness] Event listener failed.', error);
      }
    }
  }

  #emitTranscript(entry: ClaudeTranscriptEntry, run: ActiveRun) {
    for (const listener of [...this.#transcriptListeners]) {
      try {
        listener(entry, { runId: run.runId, threadId: run.threadId });
      } catch (error) {
        console.warn('[claude-code harness] Transcript listener failed.', error);
      }
    }
  }

  #save(): Promise<void> {
    this.#record.updatedAt = new Date().toISOString();
    const record = structuredClone(this.#record);
    // Input queued for the run in flight survives a restart: it waits for the next turn there.
    const run = this.#run;
    if (run && !run.settled && run.queue.length) {
      record.threads[run.threadId]?.pendingInputs.push(...structuredClone(run.queue));
    }
    const write = this.#saving.then(() => this.#config.store.put(record));
    // A failed write fails its caller but must not wedge every later write.
    this.#saving = write.catch(error => console.warn('[claude-code harness] Unable to persist session.', error));
    return write;
  }

  #markDelivered(inputs: ClaudePendingInput[]) {
    const thread = this.#threadState();
    for (const input of inputs) if (input.id) thread.deliveredIds = remember(thread.deliveredIds, input.id);
  }

  /** Routes input to the run in flight, or starts one. */
  #accept(inputs: ClaudePendingInput[], wake: boolean, { keepGate = false } = {}): Accepted {
    const run = this.#run;
    if (run && !run.settled) {
      const fresh = this.#fresh(inputs, run.queue, this.#threadState(run.threadId).pendingInputs);
      run.queue.push(...fresh);
      // It joins the run now, as a Mastra interjection does: the chat shows it at once. It counts as
      // delivered (the dispatcher's replay guard) only once the turn that carries it starts.
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
      // New work supersedes the plan nobody answered.
      const { toolCallId } = thread.pendingGate;
      thread.pendingGate = undefined;
      this.#emit({ type: 'tool_suspension_cancelled', toolCallId });
    }
    if (thread.pendingPermission && !keepGate) {
      // And the permission nobody gave: Claude hears about it with the new input instead.
      const { toolCallId } = thread.pendingPermission;
      thread.pendingPermission = undefined;
      // An MCP server's form nobody answered: its waiting turn ends, so the new run can take the session.
      this.#dropParked();
      this.#emit({ type: 'tool_suspension_cancelled', toolCallId });
    }
    return { action: 'wake', run: this.#startRun(inputs) };
  }

  #startRun(inputs: ClaudePendingInput[]): ActiveRun {
    let markStarted!: ActiveRun['markStarted'];
    let resolveEnded!: ActiveRun['resolveEnded'];
    const started = new Promise<void>((resolve, reject) => {
      markStarted = error => (error === undefined ? resolve() : reject(error));
    });
    // A caller that did not ask for delivery never awaits this; its failure surfaces as an error event.
    started.catch(() => {});
    const run: ActiveRun = {
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
    run.loopDone = this.#loop(run, first, previous);
    this.#barrier = run.loopDone;
    return run;
  }

  async #loop(run: ActiveRun, first: ClaudePendingInput[], previous: Promise<void>): Promise<void> {
    let next = first;
    let reason: AgentRunEndReason = 'complete';
    let failure: unknown;
    let threw = false;
    try {
      await previous;
      while (true) {
        const outcome = await this.#turn(run, next);
        if (run.settled) return;
        if (outcome.kind === 'aborted') {
          reason = 'aborted';
          break;
        }
        if (outcome.kind === 'error') {
          failure = outcome.error;
          reason = 'error';
          break;
        }
        if (outcome.kind === 'permission') {
          const thread = this.#threadState(run.threadId);
          thread.pendingPermission = run.askEachTime?.includes(outcome.request.toolName)
            ? { ...outcome.request, once: true }
            : outcome.request;
          thread.pendingInputs.push(...run.queue);
          run.queue = [];
          this.#emit({ type: 'tool_suspended', toolName: outcome.request.toolName, toolCallId: outcome.request.toolCallId });
          reason = 'suspended';
          break;
        }
        if (outcome.kind === 'gate') {
          const thread = this.#threadState(run.threadId);
          thread.pendingGate = outcome.gate;
          // Whatever arrived while the plan was being written goes with the answer.
          thread.pendingInputs.push(...run.queue);
          run.queue = [];
          this.#emit({ type: 'tool_suspended', toolName: SUBMIT_PLAN_TOOL_NAME, toolCallId: outcome.gate.toolCallId });
          reason = 'suspended';
          break;
        }
        if (run.queue.length === 0) break;
        next = run.queue;
        run.queue = [];
      }
    } catch (error) {
      if (run.settled) {
        // Stopped while it set up, then the setup failed: the chat already heard of the stop, the log hears of this.
        console.warn('[claude-code harness] A stopped run failed while it wound down.', { sessionId: this.id, runId: run.runId, error });
        return;
      }
      threw = true;
      failure = error;
      reason = 'error';
    }
    let park: UsageLimitPark | undefined;
    if (reason === 'error') {
      const parked = await this.#usageLimitPark(run, failure);
      if (run.settled) return;
      if (parked === 'expired' && isUsageLimitFailure(failure)) {
        failure = new ClaudeCodeError('rate_limit', usageLimitExpiredMessage(run.priorPark, failure.message));
        this.#emitPark({ type: 'usage_limit_cleared', reason: 'expired' });
      } else if (parked && parked !== 'expired') {
        park = parked;
      }
      // A parked run says so instead of failing: the chat shows when it resumes, not an error.
      if (!park) {
        console.warn('[claude-code harness] Run ended in error.', { sessionId: this.id, runId: run.runId, error: failure });
        this.#emit({ type: 'error', error: failure });
      }
    }
    // A run that could not start says so only once it settled: a send that follows at once starts a
    // run of its own, instead of joining this one's queue and ending with its failure.
    if (threw) run.markStarted(failure);
    this.#settle(run, reason, { ...(park ? { park } : {}) });
  }

  /**
   * The park a run's failure leads to: a usage limit parks the session (unless the host resumes
   * this session itself), `expired` once it waited past the cap; `undefined` for any other failure.
   */
  async #usageLimitPark(run: ActiveRun, failure: unknown): Promise<Omit<UsageLimitPark, 'continueTurn'> | 'expired' | undefined> {
    if (!isUsageLimitFailure(failure) || run.abortRequested) return undefined;
    try {
      if (!this.#config.parkOnUsageLimit || !(await this.#config.parkOnUsageLimit(this))) return undefined;
    } catch (error) {
      console.warn('[claude-code harness] Unable to tell whether a limited run may park.', error);
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
    {
      drainFollowUps = true,
      park,
      reportUndelivered = false,
    }: { drainFollowUps?: boolean; park?: Omit<UsageLimitPark, 'continueTurn'>; reportUndelivered?: boolean } = {},
  ) {
    if (run.settled) return;
    run.settled = true;
    if (this.#run === run) this.#run = undefined;
    // A person's messages the chat shows as sent that Claude never read: they wait for the next turn.
    let undelivered = 0;
    if (reason === 'aborted' || reason === 'error') {
      const thread = this.#threadState(run.threadId);
      if (park && run.threadId === this.#record.threadId) {
        // The cut-off turn's request reached Claude (it is in the conversation): the resume goes on with it.
        // (A resume's own note that was never sent waits with the pending inputs instead.)
        const continueTurn = run.unsent === undefined && run.begun === true;
        thread.usageLimitPark = { ...park, ...(continueTurn ? { continueTurn: true as const } : {}) };
      }
      // Input that never reached Claude waits for the next turn: notifications, gate answers and
      // a person's messages. A signal with an id stays undelivered instead, so its sender (the
      // dispatcher's replay guard) sends it again.
      const kept = (input: ClaudePendingInput) => input.kind === 'notification' || input.gate || !input.id;
      const waiting = [...(run.unsent ?? []), ...run.queue].filter(kept);
      if (run.unsent) {
        thread.pendingInputs.unshift(...run.unsent.filter(kept));
        run.unsent = undefined;
      }
      thread.pendingInputs.push(...run.queue.filter(kept));
      run.queue = [];
      undelivered = waiting.filter(isShownMessage).length;
    }
    run.markStarted();
    void this.#save().catch(() => {});
    run.resolveEnded(reason);
    const parked = this.#threadState(run.threadId).usageLimitPark;
    if (park && parked) this.#emitPark({ type: 'usage_limit_parked', park: { ...parked } });
    // A parked session waits for the limit: its follow-ups go with the resume, not into another limited run.
    const drain = drainFollowUps && reason !== 'suspended' && !park;
    // Follow-ups about to start their own run take the waiting messages along: nothing is left to say.
    const drainsNow = drain && (this.#threadState(run.threadId).followUps?.length ?? 0) > 0;
    if (reason === 'aborted' && reportUndelivered && undelivered > 0 && !drainsNow) {
      console.warn('[claude-code harness] Run stopped before Claude read the message; it waits for the next turn.', {
        sessionId: this.id,
        runId: run.runId,
        messages: undelivered,
      });
      this.#emit({ type: 'error', error: new ClaudeCodeError('undelivered', UNDELIVERED_MESSAGE) });
    }
    this.#emit({ type: 'agent_end', reason });
    if (drain) this.#drainFollowUps(run.threadId);
  }

  /** Starts a run with what waited for the last one to end (follow-ups, a high notice that came mid-run). */
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

  /**
   * Gives the turn in flight a person's message on the CLI's stdin: Claude reads it at its next
   * step (between tool calls) within the same turn, or, when the turn has just finished, the CLI
   * runs it as one more turn in the same process. `false` when no live turn can take it.
   */
  #steer(message: ClaudePendingInput): boolean {
    const run = this.#run;
    const process = run?.process;
    if (!run || run.settled || !run.translator?.started || !process?.acceptsInput()) return false;
    if (!process.send(userMessage(message.text))) return false;
    this.#echo([message], run, true);
    return true;
  }

  /** A `control_request` from the CLI: an MCP server's elicitation is asked as a question card; anything else is refused. */
  #controlRequest(
    run: ActiveRun,
    process: ClaudeRun,
    message: Extract<ClaudeStreamMessage, { type: 'control_request' }>,
    stopping: boolean,
  ) {
    const { requestId } = message;
    if (message.subtype !== 'elicitation') {
      process.send(controlError(requestId, `The Factory does not answer ${message.subtype || 'this'} control requests.`));
      return;
    }
    const answer = (response: McpElicitationResponse) => process.send(controlResponse(requestId, response));
    // Nobody can answer: the run already ended (another question waits), it is being stopped, or nobody attends it.
    if (run.settled || stopping || run.unattended || this.#parked) {
      answer({ action: 'cancel' });
      return;
    }
    const card = elicitationQuestions(elicitationRequest(message.request));
    if (!card) {
      answer({ action: 'decline' });
      return;
    }
    const elicitationId = textField(message.request.elicitation_id);
    const toolCallId = `${ELICITATION_CALL_PREFIX}${elicitationId ?? requestId}`;
    const permission: PermissionRequest = { toolCallId, toolName: ASK_USER_QUESTION_TOOL, input: card.input };
    this.#emitTranscript({ kind: 'tool_call', toolCallId, toolName: ASK_USER_QUESTION_TOOL, input: card.input }, run);
    this.#emitTranscript({ kind: 'permission', ...permission }, run);
    this.#reportUsage(run, false);
    const thread = this.#threadState(run.threadId);
    thread.pendingPermission = permission;
    // Whatever arrived while the turn ran goes with the turn's next step.
    thread.pendingInputs.push(...run.queue);
    run.queue = [];
    // The person may take a while: the turn's own budget waits with it, the park's limit applies instead.
    process.pauseTimeout();
    const timer = setTimeout(() => this.#dropParked(), this.#config.parkTimeoutMs ?? DEFAULT_PARK_TIMEOUT_MS);
    timer.unref?.();
    const parked: ParkedElicitation = { run, process, requestId, toolCallId, plan: card.plan, timer };
    this.#parked = parked;
    // A process that dies while it waits leaves the answer to the next turn.
    void process.exited.then(() => {
      if (this.#parked !== parked) return;
      clearTimeout(parked.timer);
      this.#parked = undefined;
    });
    this.#emit({ type: 'tool_suspended', toolName: ASK_USER_QUESTION_TOOL, toolCallId });
    this.#settle(run, 'suspended');
  }

  /** The CLI withdrew the elicitation the thread waits on (the server gave up): the card goes too. */
  #controlCancelled(requestId: string) {
    const parked = this.#parked;
    if (!parked || parked.requestId !== requestId) return;
    const thread = this.#threadState(parked.run.threadId);
    if (thread.pendingPermission?.toolCallId === parked.toolCallId) thread.pendingPermission = undefined;
    this.#dropParked();
    void this.#save().catch(() => {});
    this.#emit({ type: 'tool_suspension_cancelled', toolCallId: parked.toolCallId });
  }

  /** The turn waiting on this question, still alive in its process; takes it off the shelf. */
  #takeParked(toolCallId: string): ParkedElicitation | undefined {
    const parked = this.#parked;
    if (!parked || parked.toolCallId !== toolCallId || parked.run.threadId !== this.#record.threadId || !parked.process.isAlive()) {
      this.#dropParked();
      return undefined;
    }
    clearTimeout(parked.timer);
    this.#parked = undefined;
    return parked;
  }

  /**
   * Answers the parked elicitation and picks its run up again: the same run object (its loop
   * still waits on the process) under a new run id. `undefined` when the CLI cannot take the
   * answer any more; the caller then sends it as the next turn.
   */
  #resumeParked(parked: ParkedElicitation, response: McpElicitationResponse): ActiveRun | undefined {
    const { run, process } = parked;
    if (this.#run || !process.send(controlResponse(parked.requestId, response))) {
      process.terminate();
      return undefined;
    }
    let resolveEnded!: ActiveRun['resolveEnded'];
    run.runId = randomUUID();
    run.queue = [];
    run.abortRequested = false;
    run.settled = false;
    run.started = Promise.resolve();
    run.markStarted = () => {};
    run.ended = new Promise(resolve => {
      resolveEnded = resolve;
    });
    run.resolveEnded = resolveEnded;
    this.#run = run;
    process.resumeTimeout();
    void this.#save().catch(() => {});
    return run;
  }

  /** Ends the turn a form waits on (nobody will answer it there); a later answer goes as the next turn. */
  #dropParked() {
    const parked = this.#parked;
    if (!parked) return;
    clearTimeout(parked.timer);
    this.#parked = undefined;
    parked.run.abortRequested = true;
    parked.process.send(controlResponse(parked.requestId, { action: 'cancel' }));
    parked.process.terminate();
  }

  async #cwd(): Promise<string> {
    const recorded = this.#record.cwd;
    if (recorded) {
      if (await directoryExists(recorded)) return recorded;
      // The checkout was removed from disk (a retired sandbox, a cleaned folder): asking for the cwd
      // again sets it up anew. It must come back at the same path, since the CLI files the session's
      // transcripts by project directory; anywhere else is refused rather than silently moved.
      const restored = await this.#config.cwdFor(this.id);
      if (restored !== recorded) {
        throw new ClaudeCodeError(
          'process',
          `The checkout of session ${this.id} is gone from ${recorded}, and setting it up again put it at ${restored}.`,
        );
      }
      if (!(await directoryExists(restored))) {
        throw new ClaudeCodeError('process', `The checkout of session ${this.id} is gone from ${recorded} and could not be set up again.`);
      }
      return recorded;
    }
    this.#record.cwd = await this.#config.cwdFor(this.id);
    await this.#save();
    return this.#record.cwd;
  }

  /** The CLI options for one turn of this thread. */
  #argsInput(
    thread: ClaudeThreadState,
    planning: boolean,
    mcpConfigPaths: string[],
    model: string | undefined,
    permissions: { rules?: { allow: string[]; ask: string[]; deny: string[] } } = {},
    systemPrompt: string | undefined = this.#config.appendSystemPrompt,
    sessionSettingSources?: ClaudeSettingSource[] | false,
    selection: { effort?: string; settings?: Record<string, unknown> } = {},
  ): ClaudeArgsInput {
    const config = this.#config;
    const mode = thread.mode ?? config.mode;
    // Planning pins the default mode, so a project setting cannot put the turn into the CLI's plan mode.
    const permissionMode: ClaudePermissionMode | undefined = planning ? 'default' : mode === 'planning' ? undefined : mode;
    const settingSources = sessionSettingSources ?? config.settingSources ?? DEFAULT_SETTING_SOURCES;
    const plansDirectory = config.plansDirectory ?? DEFAULT_PLANS_DIRECTORY;
    const attribution = config.attribution ?? NO_ATTRIBUTION;
    const rules = permissions.rules;
    const disallowedTools = [
      ...(config.disallowedTools ?? []),
      ...(rules?.deny ?? []),
      ...(planning ? (config.planningDisallowedTools ?? PLANNING_DISALLOWED_TOOLS) : []),
    ];
    const granted = thread.grantedTools ?? [];
    const settings: Record<string, unknown> = {
      ...selection.settings,
      ...(attribution ? { attribution } : {}),
      ...(plansDirectory ? { plansDirectory } : {}),
      ...(rules?.ask.length ? { permissions: { ask: rules.ask } } : {}),
    };
    return {
      ...(thread.claudeSessionId ? { resumeSessionId: thread.claudeSessionId } : {}),
      ...(model ? { model } : {}),
      ...((selection.effort ?? config.effort) ? { effort: selection.effort ?? config.effort } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(settingSources ? { settingSources } : {}),
      ...(Object.keys(settings).length ? { settings } : {}),
      mcpConfig: mcpConfigPaths,
      strictMcpConfig: config.strictMcpConfig ?? true,
      allowedTools: [
        ...new Set([
          ...(config.allowedTools ?? []),
          ...(rules?.allow ?? []),
          ...granted,
          SUBMIT_PLAN_TOOL_ID,
          PERMISSION_PROMPT_TOOL_ID,
        ]),
      ],
      ...(disallowedTools.length ? { disallowedTools: [...new Set(disallowedTools)] } : {}),
      permissionPromptTool: PERMISSION_PROMPT_TOOL_ID,
      appendSystemPrompt: [systemPrompt, GATE_SYSTEM_PROMPT].filter(Boolean).join('\n\n'),
      ...(config.includePartialMessages ? { includePartialMessages: true } : {}),
      ...(config.maxTurns ? { maxTurns: config.maxTurns } : {}),
      ...(config.extraArgs ? { extraArgs: config.extraArgs } : {}),
    };
  }

  async #turn(
    run: ActiveRun,
    inputs: ClaudePendingInput[],
  ): Promise<TurnOutcome | { kind: 'aborted' }> {
    const thread = this.#threadState(run.threadId);
    const turnStartedAt = new Date();
    const planning = (thread.mode ?? this.#config.mode) === 'planning';
    const lead = planning ? [this.#config.planningPrompt ?? PLANNING_PROMPT] : [];
    // Asked before the echo, so the turn's first input can carry the model-switch marker.
    const selection = this.#config.turnSelectionFor ? await this.#config.turnSelectionFor(this) : undefined;
    const text = inputs.map(input => input.text).join('\n\n');
    const prompt = [...lead, selection?.promptEffort ? applyClaudePromptEffortPrefix(text, selection.promptEffort) : text].join(
      '\n\n',
    );
    if (!run.settled) this.#echo(inputs, run, false, selection?.modelSwitch);
    run.begun = true;
    run.unsent = inputs;
    const tried: string[] = [];
    const credentials = turnCredentials(
      await this.#config.credentials(this, {
        ...(this.#record.accountId ? { preferredAccountId: this.#record.accountId } : {}),
        exclude: tried,
      }),
    );
    const cwd = await this.#cwd();
    const mcpConfig =
      typeof this.#config.mcpConfig === 'function' ? await this.#config.mcpConfig(this) : this.#config.mcpConfig;
    const model = selection?.model || (await this.#config.modelFor?.(this)) || this.#config.model;
    const permissions = await this.#config.permissions?.(this);
    const systemPrompt = (await this.#config.appendSystemPromptFor?.(this)) ?? this.#config.appendSystemPrompt;
    const settingSources = await this.#config.settingSourcesFor?.(this);
    const turnContext = await this.#config.turnContextFor?.(this);
    const handoffFor = (reason: 'turn' | 'resume_failed') => this.#handoffFor(reason, text, turnStartedAt);
    const handoff = await handoffFor('turn');
    if (run.abortRequested) {
      await handoff?.unsent();
      return { kind: 'aborted' };
    }
    const configDir = this.#config.configDir?.(this);
    const envFor = (turn: ClaudeTurnCredentials) =>
      buildClaudeEnv(
        this.#config.env ?? process.env,
        {
          // The stored sign-in moves with the config dir: the CLI never falls back to the default
          // `~/.claude` credentials or Keychain item, so the credentials hook is its only login.
          ...(configDir ? { CLAUDE_CONFIG_DIR: configDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: configDir } : {}),
          ...turn.env,
        },
        this.#config.passEnv,
      );
    const configured = mcpConfig === undefined ? [] : Array.isArray(mcpConfig) ? mcpConfig : [mcpConfig];
    // MCP configs carry per-turn tokens: a private file, not the command line every local user can read.
    const mcpFile = await writeMcpConfigFile(configured, this.#config.tempDir, {
      gate: this.#config.gateServer ?? 'embedded',
      unattended: permissions?.unattended === true && permissions.parkAsks !== true,
    });
    // A call a person allowed once goes through on this turn (the retry), and asks again after it.
    const grantedOnce = thread.grantedOnce ?? [];
    if (grantedOnce.length) {
      thread.grantedOnce = undefined;
      void this.#save().catch(() => {});
    }
    const rules = permissions
      ? claudePermissionRules(permissions, {
          mcpServers: mcpFile.servers.filter(server => server !== GATE_SERVER_NAME),
          trustedMcpServers: this.#config.trustedMcpServers ?? [],
          granted: [...(thread.grantedTools ?? []), ...grantedOnce],
        })
      : undefined;
    run.askEachTime = permissions?.yolo ? [] : (permissions?.askEachTime ?? []);
    run.unattended = permissions?.unattended === true && permissions.parkAsks !== true;
    try {
      return await this.#attempts(run, {
        thread,
        planning,
        prompt,
        ...(turnContext ? { turnContext } : {}),
        ...(handoff ? { handoff } : {}),
        handoffFor,
        inputs,
        tried,
        credentials,
        env: envFor(credentials),
        envFor,
        cwd,
        mcpConfigPaths: mcpFile.paths,
        model,
        ...(selection?.effort ? { effort: selection.effort } : {}),
        ...(selection?.settings ? { settings: selection.settings } : {}),
        systemPrompt,
        ...(settingSources !== undefined ? { settingSources } : {}),
        ...(rules ? { rules } : {}),
      });
    } finally {
      await mcpFile.cleanup();
    }
  }

  async #attempts(
    run: ActiveRun,
    turn: {
      thread: ClaudeThreadState;
      planning: boolean;
      prompt: string;
      turnContext?: string;
      /** Context carried over from another conversation, ahead of `prompt`. */
      handoff?: TurnHandoffContext;
      handoffFor: (reason: 'turn' | 'resume_failed') => Promise<TurnHandoffContext | undefined>;
      inputs: ClaudePendingInput[];
      tried: string[];
      credentials: ClaudeTurnCredentials;
      env: Record<string, string>;
      envFor: (credentials: ClaudeTurnCredentials) => Record<string, string>;
      cwd: string;
      mcpConfigPaths: string[];
      model: string | undefined;
      effort?: string;
      settings?: Record<string, unknown>;
      systemPrompt: string | undefined;
      settingSources?: ClaudeSettingSource[] | false;
      rules?: { allow: string[]; ask: string[]; deny: string[] };
    },
  ): Promise<TurnOutcome | { kind: 'aborted' }> {
    const { thread, planning, inputs, tried, envFor, cwd, mcpConfigPaths, model, systemPrompt, settingSources, rules } = turn;
    const selection = { ...(turn.effort ? { effort: turn.effort } : {}), ...(turn.settings ? { settings: turn.settings } : {}) };
    let { credentials, env } = turn;
    // The handoff's context goes ahead of the person's request, which is sent as written.
    let handoff = turn.handoff;
    let handoffSent = false;
    const compose = () => {
      const body = promptWithTurnHandoff(handoff, turn.prompt);
      return turn.turnContext ? `${turn.turnContext}\n\n${body}` : body;
    };
    const prompt = compose();
    let turnPrompt = prompt;
    let resumedStale = false;
    try {
      // A stale resume id (the CLI's session files were lost) gets one fresh session instead of failing forever;
      // an account that runs out of usage or is refused hands the turn to the next account.
      while (true) {
        // A run that ended while its process lived on (a form nobody answered) starts nothing more.
        if (run.abortRequested || run.settled) return { kind: 'aborted' };
        const resumeSessionId = thread.claudeSessionId;
        if (credentials.accountId && credentials.accountId !== this.#record.accountId) {
          this.#record.accountId = credentials.accountId;
          void this.#save().catch(() => {});
        }
        // The replies that follow ran on this account, as a Mastra reply names its credential.
        if (credentials.credential) this.#emitTranscript({ kind: 'credential', ...credentials.credential }, run);
        const args = buildClaudeArgs(
          this.#argsInput(
            thread,
            planning,
            mcpConfigPaths,
            model,
            rules ? { rules } : {},
            systemPrompt,
            settingSources,
            selection,
          ),
        );
        const translator = new TurnTranslator();
        run.translator = translator;
        let processRef: ClaudeRun | undefined;
        let stopForGate = false;
        let stopForAccount = false;
        let inputDone = false;
        const onLine = (line: string) => {
          const message = parseStreamLine(line);
          if (!message) return;
          const entries = translator.push(message);
          if (message.type === 'rate_limit') this.#reportUsageLimits(message.raw, credentials.accountId);
          if (translator.sessionId && translator.sessionId !== thread.claudeSessionId) {
            thread.claudeSessionId = translator.sessionId;
            void this.#save().catch(() => {});
          }
          // The CLI has the prompt: from here on the input counts as delivered.
          if (translator.started && run.unsent) {
            this.#markDelivered(run.unsent);
            run.unsent = undefined;
            void this.#save().catch(() => {});
          }
          if (translator.started && handoff && !handoffSent) {
            handoffSent = true;
            void handoff.delivered().catch(error => console.warn('[claude-code harness] Unable to record the handoff as delivered.', error));
          }
          // Once the plan is in, the rest is the process being stopped (e.g. the gate call failing with "Connection closed").
          if (!run.settled && !stopForGate) for (const entry of entries) this.#emitTranscript(entry, run);
          // A model message's usage counts as soon as the stream has it whole, so a run's cost shows as it goes.
          this.#reportUsage(run, false);
          if ((translator.gate || translator.permission) && !stopForGate) {
            // The plan, or a call waiting for a person, is the turn's last word: stop before Claude goes on without the answer.
            stopForGate = true;
            processRef?.closeInput();
            processRef?.terminate();
          }
          // A refused account never recovers by retrying, and a rate-limited one in a pool is faster to leave than to wait out.
          const leaveAccount =
            translator.accountRefused ||
            (credentials.accountId !== undefined && translator.rateLimitRetries >= RATE_LIMIT_RETRIES_BEFORE_SWITCH);
          if (leaveAccount && !stopForAccount) {
            stopForAccount = true;
            processRef?.closeInput();
            processRef?.terminate();
          }
          if (message.type === 'control_request' && processRef) {
            this.#controlRequest(run, processRef, message, stopForGate || stopForAccount);
          } else if (message.type === 'control_cancel_request') {
            this.#controlCancelled(message.requestId);
          } else if (message.type === 'result' && !(message.queuedTurns && message.queuedTurns > 0)) {
            // Nothing more queued: closing stdin lets the CLI exit. A steer already written still runs, as its own turn.
            inputDone = true;
            processRef?.closeInput();
          }
        };
        const proc = runClaude({
          args,
          cwd,
          env,
          prompt: turnPrompt,
          onLine,
          ...(this.#config.spawn ? { spawn: this.#config.spawn } : {}),
          ...(this.#config.command ? { command: this.#config.command } : {}),
          ...(this.#config.turnTimeoutMs ? { timeoutMs: this.#config.turnTimeoutMs } : {}),
        });
        processRef = proc;
        if (stopForGate || stopForAccount || inputDone) proc.closeInput();
        if (stopForGate || stopForAccount) proc.terminate();
        run.process = proc;
        if (run.abortRequested) proc.terminate();
        run.markStarted();
        void this.#save().catch(() => {});

        const exit = await proc.exited;
        run.process = undefined;
        this.#reportUsage(run, true);
        if (run.abortRequested) return { kind: 'aborted' };
        if (exit.spawnError) {
          // The spawn failure stays the cause: a missing CLI is told apart from a crash by it (`isHarnessExecutableUnavailable`).
          return {
            kind: 'error',
            error: new ClaudeCodeError('process', `Unable to start Claude Code: ${exit.spawnError.message}`, { cause: exit.spawnError }),
          };
        }
        if (exit.timedOut) {
          return { kind: 'error', error: new ClaudeCodeError('timeout', 'Claude Code turn timed out.') };
        }
        const outcome = translator.outcome(exit);
        if (outcome.kind === 'error' && outcome.error.kind === 'unknown_session' && resumeSessionId && !resumedStale) {
          resumedStale = true;
          thread.claudeSessionId = undefined;
          await this.#save();
          // The fresh conversation knows nothing of the thread: it gets the thread's history.
          if (handoff && !handoffSent) await handoff.unsent();
          handoff = await turn.handoffFor('resume_failed');
          handoffSent = false;
          turnPrompt = compose();
          continue;
        }
        if (outcome.kind === 'error') {
          const next = await this.#nextAccount(run, credentials, outcome.error, tried);
          if (next) {
            credentials = next;
            env = envFor(next);
            // Once the CLI started the conversation the prompt is in it; the next account picks up from there.
            if (translator.started) turnPrompt = ACCOUNT_SWITCH_PROMPT;
            continue;
          }
        }
        return outcome;
      }
    } finally {
      if (handoff && !handoffSent) {
        await handoff.unsent().catch(error => console.warn('[claude-code harness] Unable to keep the handoff pending.', error));
      }
    }
  }

  /** The host's handoff for this turn; a failing hook leaves the turn without one rather than failing it. */
  async #handoffFor(reason: 'turn' | 'resume_failed', prompt: string, turnStartedAt: Date): Promise<TurnHandoffContext | undefined> {
    if (!this.#config.handoffContextFor) return undefined;
    try {
      const handoff = await this.#config.handoffContextFor(this, { reason, prompt, turnStartedAt });
      return handoff?.context ? handoff : undefined;
    } catch (error) {
      console.warn('[claude-code harness] Unable to read the context handoff for this turn.', error);
      return undefined;
    }
  }

  /**
   * The account a turn goes on with after `error`, or `undefined` when it must
   * stop: the error is not the account's fault, the turn already switched too
   * often, or the hook has no other account (its error then ends the turn).
   */
  async #nextAccount(
    run: ActiveRun,
    current: ClaudeTurnCredentials,
    error: ClaudeCodeError,
    tried: string[],
  ): Promise<ClaudeTurnCredentials | undefined> {
    const accountId = current.accountId;
    if (!accountId || (error.kind !== 'rate_limit' && error.kind !== 'auth')) return undefined;
    if (run.abortRequested || run.settled || tried.length >= MAX_ACCOUNT_SWITCHES) return undefined;
    tried.push(accountId);
    try {
      await this.#config.onCredentialFailure?.(this, { accountId, error });
    } catch (failure) {
      console.warn('[claude-code harness] Credential failure hook failed.', failure);
    }
    const next = turnCredentials(await this.#config.credentials(this, { exclude: [...tried] }));
    if (!next.accountId || tried.includes(next.accountId)) return undefined;
    return next;
  }
}

/**
 * Claude Code takes a turn as plain text, so a skill kickoff travels in the
 * `<skill name="…">` envelope a human-invoked skill sends; only an early
 * closing tag in the contents is escaped.
 */
function signalText(input: AgentSignalInput): string {
  // The harness exposes no goals, so the dispatcher puts a phase's goal in the kickoff instead.
  if (input.type === 'system-reminder') throw new Error('Claude Code holds no goals: a goal reminder cannot reach it.');
  if (input.tagName !== 'skill') return input.contents;
  const contents = input.contents.replace(/<\/skill\s*>/gi, match => match.replace('<', '&lt;').replace('>', '&gt;'));
  return `<skill name="${input.attributes.name.replaceAll('"', '&quot;')}">\n${contents}\n</skill>`;
}

/**
 * Writes a turn's MCP servers into one file only this user can read, and
 * returns the `--mcp-config` values: that file, then any config given as a
 * path. Configs given inline (objects or JSON text) are merged into the file.
 * `gate` adds the gate server: a command, or `'embedded'` to write the gate
 * server's script into the same private folder and run it with this Node.
 */
export async function writeMcpConfigFile(
  configs: ClaudeMcpConfig[],
  dir = tmpdir(),
  { gate, unattended = false }: { gate?: GateServerCommand | 'embedded'; unattended?: boolean } = {},
): Promise<{ paths: string[]; servers: string[]; cleanup: () => Promise<void> }> {
  const servers: Record<string, unknown> = {};
  const paths: string[] = [];
  for (const config of configs.flat()) {
    let value: unknown = config;
    if (typeof config === 'string') {
      if (!config.trim().startsWith('{')) {
        paths.push(config);
        continue;
      }
      value = JSON.parse(config);
    }
    Object.assign(servers, (value as { mcpServers?: Record<string, unknown> }).mcpServers ?? {});
  }
  const folder = await mkdtemp(join(dir, 'factory-claude-'));
  if (gate) {
    const command =
      gate === 'embedded' ? { command: process.execPath, args: [await writeGateServerScript(folder)] } : gate;
    Object.assign(
      servers,
      gateMcpConfig(unattended ? { ...command, args: [...(command.args ?? []), GATE_UNATTENDED_ARG] } : command).mcpServers,
    );
  }
  const file = join(folder, 'mcp.json');
  await writeFile(file, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
  return {
    paths: [file, ...paths],
    /** The servers written into the file (configs given as paths are not read). */
    servers: Object.keys(servers),
    cleanup: () => rm(folder, { recursive: true, force: true }).catch(() => {}),
  };
}

/** Whether `path` is a directory on this host's disk. */
async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
