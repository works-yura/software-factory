import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
} from '@factory/harness';

import {
  buildClaudeArgs,
  buildClaudeEnv,
  runClaude,
  type ClaudeArgsInput,
  type ClaudePermissionMode,
  type ClaudeRun,
  type ClaudeSessionMode,
  type ClaudeSettingSource,
  type ClaudeSpawn,
} from './cli.ts';
import { ClaudeCodeError } from './errors.ts';
import { TurnTranslator, type ClaudeTranscriptEntry, type PermissionRequest, type PlanGate, type TurnOutcome } from './events.ts';
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
import { claudePermissionRules, type ClaudeToolPermissions } from './permissions.ts';
import { emptyThreadState, type ClaudePendingInput, type ClaudeSessionRecord, type ClaudeSessionStore, type ClaudeThreadState } from './store.ts';
import { parseStreamLine } from './stream.ts';

/** How many delivered signal ids and dedupe keys a thread remembers. */
const RECENT_LIMIT = 200;

/** Settings sources a turn reads by default: the repo's, never the person's own `~/.claude/settings.json`. */
export const DEFAULT_SETTING_SOURCES: ClaudeSettingSource[] = ['project', 'local'];
/** Where plan files would go if the CLI's plan mode ever ran (relative to the session cwd), instead of `~/.claude/plans`. */
export const DEFAULT_PLANS_DIRECTORY = '.claude/plans';

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
  /** Told when a turn's account hit a usage limit or was refused, before the turn asks for another. */
  onCredentialFailure?: (session: ClaudeCodeSession, failure: ClaudeCredentialFailure) => void | Promise<void>;
  /** The session's working directory; asked once, before its first turn. */
  cwdFor: (sessionId: string) => string | Promise<string>;
  /**
   * The CLI's config dir for this session (`CLAUDE_CONFIG_DIR`), so its session
   * files and anything else the CLI writes stay out of the person's `~/.claude`.
   * Unset (or `undefined`) keeps the default dir. The subscription login of the
   * default dir does not carry over: with a custom dir the credentials hook must
   * return `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or
   * `ANTHROPIC_API_KEY`. Keep it stable per session, or `--resume` cannot find
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
   * How the gate server is started. By default each turn writes it next to its
   * MCP config (`gate-server.ts`) and runs it with this process's Node.
   */
  gateServer?: GateServerCommand;
  spawn?: ClaudeSpawn;
  /** The CLI binary; `claude` on PATH by default. */
  command?: string;
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
  abortRequested: boolean;
  settled: boolean;
  /** Tools the current turn asks about on every call (see `ClaudeToolPermissions.askEachTime`). */
  askEachTime?: string[];
  /** Resolves once the first turn's process was spawned, rejects when it never was. */
  started: Promise<void>;
  markStarted(error?: unknown): void;
  ended: Promise<AgentRunEndReason>;
  resolveEnded(reason: AgentRunEndReason): void;
  /** The loop driving the run is done and its process has exited. */
  loopDone: Promise<void>;
}

type Accepted = { action: 'deliver' | 'wake'; run: ActiveRun } | { action: 'persist' };

const escapeAttribute = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
/** Only the envelope's own tags are escaped in the body, so the text reads as written otherwise. */
const escapeNotificationBody = (value: string) =>
  value.replace(/<(\/?)system-notification/gi, (_match, slash: string) => `&lt;${slash}system-notification`);

function formatNotification(input: AgentNotificationInput): string {
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

  /** The tool call the current thread is parked on until a person allows or denies it, if any. */
  get pendingPermission(): PermissionRequest | undefined {
    const request = this.#threadState().pendingPermission;
    return request ? structuredClone(request) : undefined;
  }

  /** Tools a person allowed for the rest of the current thread. */
  get grantedTools(): string[] {
    return [...(this.#threadState().grantedTools ?? [])];
  }

  /** The id of the run in flight. */
  get runId(): string | undefined {
    return this.#run?.runId;
  }

  readonly thread = {
    getId: (): string | undefined => this.#record.threadId,
    requireId: (): string => this.#record.threadId,
    switch: async ({ threadId }: { threadId: string }): Promise<void> => {
      if (threadId === this.#record.threadId) return;
      if (this.#run) throw new Error('Cannot switch threads while a run is in flight.');
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

  /** Stops the run now: `agent_end: aborted` is emitted before this returns; the process is stopped behind it. */
  abort(): void {
    const run = this.#run;
    if (!run || run.settled) return;
    run.abortRequested = true;
    run.process?.terminate();
    this.#settle(run, 'aborted');
  }

  /** Resolves when the run the message started or joined ends. */
  async sendMessage(input: { content: string; requestContext?: AgentRunContext }): Promise<unknown> {
    const accepted = this.#accept([{ kind: 'signal', id: randomUUID(), text: input.content }], true);
    if (accepted.action === 'persist') return undefined;
    if (accepted.action === 'wake') await accepted.run.started;
    return { reason: await accepted.run.ended };
  }

  sendSignal(
    input: AgentSignalInput,
    options: { requestContext: AgentRunContext; requireDelivery?: boolean },
  ): AgentSignalResult {
    let accepted: Accepted;
    try {
      accepted = this.#accept([{ kind: 'signal', id: input.id, text: signalText(input) }], true);
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

  async sendNotificationSignal(
    input: AgentNotificationInput,
    options: AgentNotificationOptions = {},
  ): Promise<AgentNotificationResult> {
    const thread = this.#threadState();
    if (input.dedupeKey && thread.dedupeKeys.includes(input.dedupeKey)) {
      // Already given to the agent; a retry of the same decision must not repeat it.
      return { persisted: Promise.resolve(), accepted: Promise.resolve({ action: 'deliver' }) };
    }
    if (input.dedupeKey) thread.dedupeKeys = remember(thread.dedupeKeys, input.dedupeKey);
    const pending: ClaudePendingInput = { kind: 'notification', text: formatNotification(input) };
    const active = this.run.isRunning();
    const wake = active
      ? (options.ifActive?.behavior ?? 'deliver') === 'deliver'
      : (options.ifIdle?.behavior ?? 'persist') === 'wake';
    if (!wake) {
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
    thread.pendingPermission = undefined;
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
    const write = this.#saving.then(() => this.#config.store.put(structuredClone(this.#record)));
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
      run.queue.push(...inputs);
      // It will run within this run, so it has landed as far as the dispatcher's replay guard is concerned.
      this.#markDelivered(inputs);
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
    const first = [...thread.pendingInputs, ...inputs];
    thread.pendingInputs = [];
    const previous = this.#barrier;
    run.loopDone = this.#loop(run, first, previous);
    this.#barrier = run.loopDone;
    return run;
  }

  async #loop(run: ActiveRun, first: ClaudePendingInput[], previous: Promise<void>): Promise<void> {
    let next = first;
    let reason: AgentRunEndReason = 'complete';
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
          this.#emit({ type: 'error', error: outcome.error });
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
      if (run.settled) return;
      run.markStarted(error);
      this.#emit({ type: 'error', error });
      reason = 'error';
    }
    this.#settle(run, reason);
  }

  #settle(run: ActiveRun, reason: AgentRunEndReason) {
    if (run.settled) return;
    run.settled = true;
    if (this.#run === run) this.#run = undefined;
    if (reason === 'aborted' || reason === 'error') {
      const thread = this.#threadState(run.threadId);
      // The turn never reached Claude: its notifications wait for the next turn, and its
      // signals stay undelivered, so the dispatcher's replay guard sends them again.
      if (run.unsent) {
        thread.pendingInputs.unshift(...run.unsent.filter(input => input.kind === 'notification' || input.gate));
        run.unsent = undefined;
      }
      // A queued signal never reached Claude: forget it so the dispatcher's replay guard sends it again.
      const dropped = new Set(run.queue.flatMap(input => (input.kind === 'signal' && input.id ? [input.id] : [])));
      thread.deliveredIds = thread.deliveredIds.filter(id => !dropped.has(id));
      thread.pendingInputs.push(...run.queue.filter(input => input.kind === 'notification'));
      run.queue = [];
    }
    run.markStarted();
    void this.#save().catch(() => {});
    run.resolveEnded(reason);
    this.#emit({ type: 'agent_end', reason });
  }

  async #cwd(): Promise<string> {
    if (this.#record.cwd) return this.#record.cwd;
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
  ): ClaudeArgsInput {
    const config = this.#config;
    const mode = thread.mode ?? config.mode;
    // Planning pins the default mode, so a project setting cannot put the turn into the CLI's plan mode.
    const permissionMode: ClaudePermissionMode | undefined = planning ? 'default' : mode === 'planning' ? undefined : mode;
    const settingSources = sessionSettingSources ?? config.settingSources ?? DEFAULT_SETTING_SOURCES;
    const plansDirectory = config.plansDirectory ?? DEFAULT_PLANS_DIRECTORY;
    const rules = permissions.rules;
    const disallowedTools = [
      ...(config.disallowedTools ?? []),
      ...(rules?.deny ?? []),
      ...(planning ? (config.planningDisallowedTools ?? PLANNING_DISALLOWED_TOOLS) : []),
    ];
    const granted = thread.grantedTools ?? [];
    const settings: Record<string, unknown> = {
      ...(plansDirectory ? { plansDirectory } : {}),
      ...(rules?.ask.length ? { permissions: { ask: rules.ask } } : {}),
    };
    return {
      ...(thread.claudeSessionId ? { resumeSessionId: thread.claudeSessionId } : {}),
      ...(model ? { model } : {}),
      ...(config.effort ? { effort: config.effort } : {}),
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
    const planning = (thread.mode ?? this.#config.mode) === 'planning';
    const lead = planning ? [this.#config.planningPrompt ?? PLANNING_PROMPT] : [];
    const prompt = [...lead, ...inputs.map(input => input.text)].join('\n\n');
    if (!run.settled) {
      for (const input of inputs) {
        // A plan answer queued for this turn shows as the decision it is, not as typed input.
        if (input.planDecision) {
          this.#emitTranscript({ kind: 'plan_decision', ...input.planDecision }, run);
          continue;
        }
        if (input.gate) continue;
        this.#emitTranscript({ kind: 'input', source: input.kind, text: input.text, ...(input.id ? { id: input.id } : {}) }, run);
      }
    }
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
    const model = (await this.#config.modelFor?.(this)) || this.#config.model;
    const permissions = await this.#config.permissions?.(this);
    const systemPrompt = (await this.#config.appendSystemPromptFor?.(this)) ?? this.#config.appendSystemPrompt;
    const settingSources = await this.#config.settingSourcesFor?.(this);
    const turnContext = await this.#config.turnContextFor?.(this);
    if (run.abortRequested) return { kind: 'aborted' };
    const configDir = this.#config.configDir?.(this);
    const envFor = (turn: ClaudeTurnCredentials) =>
      buildClaudeEnv(
        this.#config.env ?? process.env,
        {
          ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
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
    try {
      return await this.#attempts(run, {
        thread,
        planning,
        prompt: turnContext ? `${turnContext}\n\n${prompt}` : prompt,
        inputs,
        tried,
        credentials,
        env: envFor(credentials),
        envFor,
        cwd,
        mcpConfigPaths: mcpFile.paths,
        model,
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
      inputs: ClaudePendingInput[];
      tried: string[];
      credentials: ClaudeTurnCredentials;
      env: Record<string, string>;
      envFor: (credentials: ClaudeTurnCredentials) => Record<string, string>;
      cwd: string;
      mcpConfigPaths: string[];
      model: string | undefined;
      systemPrompt: string | undefined;
      settingSources?: ClaudeSettingSource[] | false;
      rules?: { allow: string[]; ask: string[]; deny: string[] };
    },
  ): Promise<TurnOutcome | { kind: 'aborted' }> {
    const { thread, planning, prompt, inputs, tried, envFor, cwd, mcpConfigPaths, model, systemPrompt, settingSources, rules } =
      turn;
    let { credentials, env } = turn;
    let turnPrompt = prompt;
    let resumedStale = false;

    // A stale resume id (the CLI's session files were lost) gets one fresh session instead of failing forever;
    // an account that runs out of usage or is refused hands the turn to the next account.
    while (true) {
      if (run.abortRequested) return { kind: 'aborted' };
      const resumeSessionId = thread.claudeSessionId;
      if (credentials.accountId && credentials.accountId !== this.#record.accountId) {
        this.#record.accountId = credentials.accountId;
        void this.#save().catch(() => {});
      }
      const args = buildClaudeArgs(
        this.#argsInput(thread, planning, mcpConfigPaths, model, rules ? { rules } : {}, systemPrompt, settingSources),
      );
      const translator = new TurnTranslator();
      let processRef: ClaudeRun | undefined;
      let stopForGate = false;
      let stopForAccount = false;
      const onLine = (line: string) => {
        const message = parseStreamLine(line);
        if (!message) return;
        const entries = translator.push(message);
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
        // Once the plan is in, the rest is the process being stopped (e.g. the gate call failing with "Connection closed").
        if (!run.settled && !stopForGate) for (const entry of entries) this.#emitTranscript(entry, run);
        if ((translator.gate || translator.permission) && !stopForGate) {
          // The plan, or a call waiting for a person, is the turn's last word: stop before Claude goes on without the answer.
          stopForGate = true;
          processRef?.terminate();
        }
        // A refused account never recovers by retrying, and a rate-limited one in a pool is faster to leave than to wait out.
        const leaveAccount =
          translator.accountRefused ||
          (credentials.accountId !== undefined && translator.rateLimitRetries >= RATE_LIMIT_RETRIES_BEFORE_SWITCH);
        if (leaveAccount && !stopForAccount) {
          stopForAccount = true;
          processRef?.terminate();
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
      if (stopForGate || stopForAccount) proc.terminate();
      run.process = proc;
      if (run.abortRequested) proc.terminate();
      run.markStarted();
      void this.#save().catch(() => {});

      const exit = await proc.exited;
      run.process = undefined;
      // Usage after the run already ended would be billed to the next run.
      if (!run.settled) for (const usage of translator.usageSteps()) this.#emit({ type: 'usage_update', usage });
      if (run.abortRequested) return { kind: 'aborted' };
      if (exit.spawnError) {
        return { kind: 'error', error: new ClaudeCodeError('process', `Unable to start Claude Code: ${exit.spawnError.message}`) };
      }
      if (exit.timedOut) {
        return { kind: 'error', error: new ClaudeCodeError('timeout', 'Claude Code turn timed out.') };
      }
      const outcome = translator.outcome(exit);
      if (outcome.kind === 'error' && outcome.error.kind === 'unknown_session' && resumeSessionId && !resumedStale) {
        resumedStale = true;
        thread.claudeSessionId = undefined;
        turnPrompt = prompt;
        await this.#save();
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
