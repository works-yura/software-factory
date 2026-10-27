import { randomUUID } from 'node:crypto';

import type {
  AgentEvent,
  AgentEventListener,
  AgentNotificationInput,
  AgentNotificationOptions,
  AgentNotificationResult,
  AgentRunContext,
  AgentRunEndReason,
  AgentSession,
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
  type ClaudeSpawn,
} from './cli.ts';
import { ClaudeCodeError } from './errors.ts';
import { PLAN_GATE_TOOL, TurnTranslator, type ClaudeTranscriptEntry, type TurnOutcome } from './events.ts';
import { emptyThreadState, type ClaudePendingInput, type ClaudeSessionRecord, type ClaudeSessionStore, type ClaudeThreadState } from './store.ts';
import { parseStreamLine } from './stream.ts';

/** How many delivered signal ids and dedupe keys a thread remembers. */
const RECENT_LIMIT = 200;

export interface ClaudeCodeSessionConfig
  extends Pick<
    ClaudeArgsInput,
    | 'model'
    | 'effort'
    | 'mcpConfig'
    | 'strictMcpConfig'
    | 'allowedTools'
    | 'disallowedTools'
    | 'appendSystemPrompt'
    | 'includePartialMessages'
    | 'maxTurns'
    | 'extraArgs'
  > {
  store: ClaudeSessionStore;
  /** Credentials for one turn as env (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CONFIG_DIR`). */
  credentials: (session: ClaudeCodeSession) => Promise<Record<string, string>>;
  /** The session's working directory; asked once, before its first turn. */
  cwdFor: (sessionId: string) => string | Promise<string>;
  spawn?: ClaudeSpawn;
  /** The CLI binary; `claude` on PATH by default. */
  command?: string;
  /** Mode a new thread starts in. */
  permissionMode?: ClaudePermissionMode;
  /** Mode after a person approves a plan. */
  approvedPermissionMode?: ClaudePermissionMode;
  turnTimeoutMs?: number;
  /** The environment turns inherit, minus credential keys; `process.env` by default. */
  env?: Record<string, string | undefined>;
}

export type ClaudeTranscriptListener = (entry: ClaudeTranscriptEntry, meta: { runId: string; threadId: string }) => void;

interface ActiveRun {
  runId: string;
  threadId: string;
  /** Input that arrived while a turn ran; it becomes the run's next turn. */
  queue: ClaudePendingInput[];
  process?: ClaudeRun;
  abortRequested: boolean;
  settled: boolean;
  /** Resolves once the first turn's process was spawned, rejects when it never was. */
  started: Promise<void>;
  markStarted(error?: unknown): void;
  ended: Promise<AgentRunEndReason>;
  resolveEnded(reason: AgentRunEndReason): void;
  /** The loop driving the run is done and its process has exited. */
  loopDone: Promise<void>;
}

type Accepted = { action: 'deliver' | 'wake'; run: ActiveRun } | { action: 'persist' };

function formatNotification(input: AgentNotificationInput): string {
  const attrs = [`source="${input.source}"`, `kind="${input.kind}"`];
  if (input.priority) attrs.push(`priority="${input.priority}"`);
  const payload = input.payload as { message?: unknown; body?: unknown } | undefined;
  const detail = [payload?.message, payload?.body].find(
    (value): value is string => typeof value === 'string' && value.trim() !== '' && value !== input.summary,
  );
  const body = detail ? `${input.summary}\n\n${detail}` : input.summary;
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
  parts.push('Stay in plan mode and make no changes. Revise the plan and present it again with ExitPlanMode.');
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
 *  - a human gate ends the turn: an `ExitPlanMode` call stops the process and
 *    the run ends `suspended`; the answer resumes the session in a new run.
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

  get permissionMode(): ClaudePermissionMode | undefined {
    return this.#threadState().permissionMode ?? this.#config.permissionMode;
  }

  /** Switches the current thread's mode for its next turn, e.g. into `plan` before a planning stage. */
  async setPermissionMode(mode: ClaudePermissionMode): Promise<void> {
    this.#threadState().permissionMode = mode;
    await this.#save();
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
    hasPending: (): boolean => this.#threadState().pendingGate !== undefined,
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
    input: { id: string; type: 'user'; tagName: 'user'; contents: string },
    options: { requestContext: AgentRunContext; requireDelivery?: boolean },
  ): AgentSignalResult {
    let accepted: Accepted;
    try {
      accepted = this.#accept([{ kind: 'signal', id: input.id, text: input.contents }], true);
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
    const gate = thread.pendingGate;
    if (!gate) throw new Error('This session is not waiting on a person.');
    if (toolCallId && toolCallId !== gate.toolCallId) {
      throw new Error(`This session is waiting on ${gate.toolCallId}, not ${toolCallId}.`);
    }
    if (this.#run) throw new Error('Cannot answer a gate while a run is in flight.');
    thread.pendingGate = undefined;
    const approved = resumeData.action === 'approved';
    thread.permissionMode = approved ? (this.#config.approvedPermissionMode ?? 'acceptEdits') : 'plan';
    const text = approved ? approvalPrompt(resumeData) : rejectionPrompt(resumeData);
    const accepted = this.#accept([{ kind: 'signal', text }], true, { keepGate: true });
    if (accepted.action !== 'persist') await accepted.run.started;
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
        if (outcome.kind === 'gate') {
          const thread = this.#threadState(run.threadId);
          thread.pendingGate = outcome.gate;
          // Whatever arrived while the plan was being written goes with the answer.
          thread.pendingInputs.push(...run.queue);
          run.queue = [];
          this.#emit({ type: 'tool_suspended', toolName: PLAN_GATE_TOOL, toolCallId: outcome.gate.toolCallId });
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

  async #turn(
    run: ActiveRun,
    inputs: ClaudePendingInput[],
  ): Promise<TurnOutcome | { kind: 'aborted' }> {
    const thread = this.#threadState(run.threadId);
    const prompt = inputs.map(input => input.text).join('\n\n');
    const credentials = await this.#config.credentials(this);
    const cwd = await this.#cwd();
    if (run.abortRequested) return { kind: 'aborted' };
    const env = buildClaudeEnv(this.#config.env ?? process.env, credentials);

    // A stale resume id (the CLI's session files were lost) gets one fresh session instead of failing forever.
    for (let attempt = 0; ; attempt += 1) {
      const resumeSessionId = thread.claudeSessionId;
      const permissionMode = thread.permissionMode ?? this.#config.permissionMode;
      const args = buildClaudeArgs({
        ...this.#config,
        ...(resumeSessionId ? { resumeSessionId } : {}),
        ...(permissionMode ? { permissionMode } : {}),
      });
      const translator = new TurnTranslator();
      let processRef: ClaudeRun | undefined;
      let stopForGate = false;
      const onLine = (line: string) => {
        const message = parseStreamLine(line);
        if (!message) return;
        const entries = translator.push(message);
        if (translator.sessionId && translator.sessionId !== thread.claudeSessionId) {
          thread.claudeSessionId = translator.sessionId;
          void this.#save().catch(() => {});
        }
        if (!run.settled) for (const entry of entries) this.#emitTranscript(entry, run);
        if (translator.gate && !stopForGate) {
          // The plan is the turn's last word: stop before Claude acts on a mode it was not granted.
          stopForGate = true;
          processRef?.terminate();
        }
      };
      const proc = runClaude({
        args,
        cwd,
        env,
        prompt,
        onLine,
        ...(this.#config.spawn ? { spawn: this.#config.spawn } : {}),
        ...(this.#config.command ? { command: this.#config.command } : {}),
        ...(this.#config.turnTimeoutMs ? { timeoutMs: this.#config.turnTimeoutMs } : {}),
      });
      processRef = proc;
      if (stopForGate) proc.terminate();
      run.process = proc;
      if (run.abortRequested) proc.terminate();
      this.#markDelivered(inputs);
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
      if (outcome.kind === 'error' && outcome.error.kind === 'unknown_session' && resumeSessionId && attempt === 0) {
        thread.claudeSessionId = undefined;
        await this.#save();
        continue;
      }
      return outcome;
    }
  }
}
