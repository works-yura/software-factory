import type {
  AgentControllerEvent,
  AgentControllerThread,
  MastraDBMessage,
  TokenUsage,
} from '@mastra/core/agent-controller';
import { defaultDisplayState } from '@mastra/core/agent-controller';
import type { MemoryStorage } from '@mastra/core/storage';

import { ASK_USER_QUESTION_TOOL, askUserPrompt } from '@factory/harness-claude-code';

import {
  ClaudeTranscriptProjector,
  UI_QUESTION_TOOL_NAME,
  UI_TASK_TOOL_NAME,
  type Projection,
  type UiTask,
} from './projector.ts';
import type { ChatTranscriptSession } from './session.ts';

/** A memory thread row, as the store reads and writes it. */
type StorageThreadType = Parameters<MemoryStorage['saveThread']>[0]['thread'];

const USAGE_FIELDS = [
  'promptTokens',
  'completionTokens',
  'totalTokens',
  'reasoningTokens',
  'cachedInputTokens',
  'cacheCreationInputTokens',
  'cacheCreationInputTokens5m',
  'cacheCreationInputTokens1h',
] as const;

function emptyTokenUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

/** Folds one step's usage into a running total, as a Mastra session's tally does. */
function addTokenUsage(total: TokenUsage, step: Partial<TokenUsage>): TokenUsage {
  const sum: TokenUsage = { ...total };
  for (const key of USAGE_FIELDS) {
    const value = step[key];
    if (typeof value === 'number' && Number.isFinite(value)) sum[key] = (sum[key] ?? 0) + value;
  }
  return sum;
}

/** The task list of the newest `task_write` call among messages ordered newest first. */
function latestTasks(messages: MastraDBMessage[]): UiTask[] | undefined {
  for (const message of messages) {
    for (const part of [...message.content.parts].reverse()) {
      if (part.type !== 'tool-invocation' || part.toolInvocation.toolName !== UI_TASK_TOOL_NAME) continue;
      const tasks = (part.toolInvocation.args as { tasks?: unknown } | undefined)?.tasks;
      if (Array.isArray(tasks)) return tasks as UiTask[];
    }
  }
  return undefined;
}

/** Where the chat history lives: the Mastra store's memory domain, as `storage.getStore('memory')` gives it. */
export interface ClaudeUiStorage {
  getStore(name: 'memory'): Promise<MemoryStorage | undefined>;
}

export type MemoryStore = Pick<MemoryStorage, 'getThreadById' | 'saveThread' | 'saveMessages' | 'listMessages'>;
export type ClaudeUiEventListener = (event: AgentControllerEvent) => void;

export interface AttachClaudeSessionDeps {
  storage: ClaudeUiStorage;
  now?: () => Date;
}

/** How many of the newest stored messages are searched for a plan parked, or the task list kept, before a restart. */
const ADOPT_WINDOW = 50;

/** Events that come in bursts (streamed text); their state snapshots are coalesced, as Mastra's session bus does. */
const COALESCIBLE_DISPLAY_STATE_EVENTS = new Set(['message_update', 'tool_input_delta']);
/** At most one coalesced snapshot per this many ms, plus a leading one (Mastra's `DISPLAY_STATE_COALESCE_MS`). */
const DISPLAY_STATE_COALESCE_MS = 16;

/** Where a session thread keeps the model its last turn ran on, as a Mastra thread keeps its own. */
export const THREAD_MODEL_KEY = 'currentModelId';

/**
 * One Claude Code session as the chat UI sees it: its transcript recorded into
 * the session's memory thread (resource = the session's resourceId, thread =
 * its threadId) and its live events fanned out to the open streams.
 */
export class ClaudeSessionUiChannel {
  readonly session: ChatTranscriptSession;
  readonly #storage: ClaudeUiStorage;
  readonly #projector: ClaudeTranscriptProjector;
  readonly #listeners = new Set<ClaudeUiEventListener>();
  readonly #pending = new Map<string, MastraDBMessage>();
  readonly #knownThreads = new Set<string>();
  #flushing: Promise<void> = Promise.resolve();
  #flushScheduled = false;
  /** Writes to the thread row (its usage total, its title), one at a time. */
  #threadWrites: Promise<void> = Promise.resolve();
  /** The thread's token usage so far, as a Mastra session's tally (kept on the thread's metadata). */
  #tokenUsage: TokenUsage = emptyTokenUsage();
  /** The model stored on the thread (its last turn's), until this process sees a turn. */
  #storedModelId: string | undefined;
  #displayStateTimer: ReturnType<typeof setTimeout> | undefined;
  #displayStatePending = false;
  readonly #detach: Array<() => void>;
  /** Session state the UI merges in (`PUT /state`); kept so it reads back, never given to Claude. */
  readonly state: Record<string, unknown> = {};
  /** Settles once the thread exists and a parked plan was picked back up. */
  readonly ready: Promise<void>;

  constructor(session: ChatTranscriptSession, deps: AttachClaudeSessionDeps) {
    this.session = session;
    this.#storage = deps.storage;
    this.#projector = new ClaudeTranscriptProjector({
      resourceId: this.resourceId,
      ...(session.modelProvider ? { modelProvider: session.modelProvider } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
    this.#detach = [
      session.onTranscript((entry, meta) => this.#apply(this.#projector.entry(entry, meta))),
      session.subscribe(event =>
        this.#apply(this.#projector.event(event, session.pendingPlan, session.pendingPermission)),
      ),
    ];
    this.ready = this.#prepare().catch(error => {
      console.warn('[claude-code ui] Unable to prepare the session thread.', error);
    });
  }

  /** The memory resource the session's threads live on; its own id when it has none. */
  get resourceId(): string {
    return this.session.resourceId ?? this.session.id;
  }

  get threadId(): string {
    return this.session.thread.requireId();
  }

  get running(): boolean {
    return this.session.run.isRunning();
  }

  /** The model Claude reported on the latest turn, stored on the thread so it reads back after a restart. */
  get modelId(): string | undefined {
    return this.#projector.modelId ?? this.#storedModelId;
  }

  /** The thread's token usage so far, for the session state and `/cost`. */
  get tokenUsage(): TokenUsage {
    return { ...this.#tokenUsage };
  }

  /** The task list Claude keeps with `TodoWrite`, as the chat's task panel reads it. */
  get tasks(): UiTask[] {
    return this.#projector.tasks;
  }

  /**
   * Names the session's thread, as a Mastra session's rename does: stores the
   * title and tells the streams (`thread_title_updated`), so whoever mirrors
   * titles (the session row) follows. Nothing happens when the title stands.
   */
  async nameThread(title: string): Promise<boolean> {
    const name = title.trim();
    if (!name) return false;
    const threadId = this.threadId;
    let changed = false;
    await this.#writeThread(thread => {
      if (thread.title === name) return undefined;
      changed = true;
      return { ...thread, title: name, updatedAt: new Date() };
    });
    if (changed) this.#apply({ events: [{ type: 'thread_title_updated', threadId, title: name }], writes: [] });
    return changed;
  }

  /** The thread's stored title; empty while it has none. */
  async threadTitle(): Promise<string> {
    return (await this.getThread(this.threadId))?.title ?? '';
  }

  /** One of the session resource's threads, as the controller's `thread.getById` reads it. */
  async getThread(threadId: string): Promise<AgentControllerThread | null> {
    await this.ready;
    const thread = await (await this.memory()).getThreadById({ threadId });
    return thread && thread.resourceId === this.resourceId ? (thread as AgentControllerThread) : null;
  }

  subscribe(listener: ClaudeUiEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** What a stream sends first: the run's state, the live message, the plan waiting for an answer. */
  displayState() {
    const state = defaultDisplayState();
    state.isRunning = this.running;
    state.currentMessage = this.#projector.currentMessage;
    const pending = this.#projector.pendingSuspension ?? this.#sessionPlan();
    if (pending) state.pendingSuspensions.set(pending.toolCallId, { ...pending, threadId: this.threadId });
    const approval = this.#projector.pendingApproval ?? this.#sessionApproval();
    if (approval) state.pendingApprovals.set(approval.toolCallId, { ...approval, threadId: this.threadId });
    state.tokenUsage = this.tokenUsage;
    state.tasks = this.tasks;
    state.queuedFollowUps = this.session.queuedFollowUps;
    return state;
  }

  /** Resolves once everything recorded so far is stored. */
  async flushed(): Promise<void> {
    await this.ready;
    while (this.#flushScheduled || this.#pending.size > 0) await this.#flushing;
    await this.#flushing;
    await this.#threadWrites;
  }

  async memory(): Promise<MemoryStore> {
    const memory = await this.#storage.getStore('memory');
    if (!memory) throw new Error('The memory store is not available.');
    return memory;
  }

  /** Sends an event to the open streams only, e.g. a failure the session itself does not report. */
  emit(event: AgentControllerEvent): void {
    this.#apply({ events: [event], writes: [] });
  }

  detach(): void {
    for (const off of this.#detach.splice(0)) off();
    this.#listeners.clear();
    clearTimeout(this.#displayStateTimer);
    this.#displayStateTimer = undefined;
    this.#displayStatePending = false;
  }

  // -- internals ------------------------------------------------------------

  #sessionPlan() {
    const gate = this.session.pendingPlan;
    if (!gate) return this.#sessionQuestion();
    const args = { ...(gate.title ? { title: gate.title } : {}), ...(gate.plan !== undefined ? { plan: gate.plan } : {}) };
    return { toolCallId: gate.toolCallId, toolName: 'submit_plan', args, suspendPayload: args };
  }

  /** The question the session is parked on, as the chat's `ask_user` card reads it. */
  #sessionQuestion() {
    const request = this.session.pendingPermission;
    if (request?.toolName !== ASK_USER_QUESTION_TOOL) return undefined;
    const args = askUserPrompt(request.input);
    return { toolCallId: request.toolCallId, toolName: UI_QUESTION_TOOL_NAME, args, suspendPayload: args };
  }

  #sessionApproval() {
    const request = this.session.pendingPermission;
    if (!request || request.toolName === ASK_USER_QUESTION_TOOL) return undefined;
    return { toolCallId: request.toolCallId, toolName: request.toolName, args: request.input };
  }

  async #prepare(): Promise<void> {
    const memory = await this.memory();
    const thread = await this.#ensureThread(memory, this.threadId);
    // The total kept before a restart, plus anything this process counted while it was read.
    const saved = thread?.metadata?.tokenUsage;
    if (saved && typeof saved === 'object') this.#tokenUsage = addTokenUsage(this.#tokenUsage, saved as Partial<TokenUsage>);
    const model = thread?.metadata?.[THREAD_MODEL_KEY];
    if (typeof model === 'string' && model) this.#storedModelId = model;
    const gate = this.session.pendingPlan;
    const permission = this.session.pendingPermission;
    const { messages } = await memory.listMessages({
      threadId: this.threadId,
      resourceId: this.resourceId,
      perPage: ADOPT_WINDOW,
      page: 0,
      orderBy: { field: 'createdAt', direction: 'DESC' },
    });
    // A `TodoWrite` already seen in this process is newer than anything stored.
    const tasks = latestTasks(messages);
    if (tasks && this.#projector.tasks.length === 0) this.#projector.adoptTasks(tasks);
    if (gate) {
      const holder = messages.find(message =>
        message.content.parts.some(
          part => part.type === 'tool-invocation' && part.toolInvocation.toolCallId === gate.toolCallId,
        ),
      );
      if (holder) this.#projector.adopt(holder, gate);
    }
    if (permission) {
      // A question parks as a suspension, any other call as an approval.
      const holder = messages.find(message => {
        const pending =
          permission.toolName === ASK_USER_QUESTION_TOOL
            ? message.content.metadata?.suspendedTools
            : message.content.metadata?.pendingToolApprovals;
        return !!pending && typeof pending === 'object' && permission.toolCallId in pending;
      });
      if (holder) this.#projector.adoptPermission(holder, permission);
    }
  }

  /** Makes sure the thread exists; the first time, also returns its stored row. */
  async #ensureThread(memory: MemoryStore, threadId: string): Promise<StorageThreadType | undefined> {
    if (this.#knownThreads.has(threadId)) return undefined;
    const existing = await memory.getThreadById({ threadId });
    if (existing && existing.resourceId !== this.resourceId) {
      throw new Error(`Thread ${threadId} belongs to another resource.`);
    }
    if (!existing) {
      const now = new Date();
      await memory.saveThread({
        thread: { id: threadId, resourceId: this.resourceId, title: '', createdAt: now, updatedAt: now, metadata: {} },
      });
    }
    this.#knownThreads.add(threadId);
    return existing ?? undefined;
  }

  /**
   * Rewrites the session's thread row, one write at a time, always carrying
   * the usage total along (a write made elsewhere from an older read may have
   * dropped it). `change` returns the row to store, or `undefined` to keep it.
   */
  #writeThread(change: (thread: StorageThreadType) => StorageThreadType | undefined): Promise<void> {
    const write = this.#threadWrites.then(async () => {
      await this.ready;
      const memory = await this.memory();
      const thread = await memory.getThreadById({ threadId: this.threadId });
      if (!thread) return;
      const next = change(thread);
      if (!next) return;
      await memory.saveThread({ thread: { ...next, metadata: { ...next.metadata, tokenUsage: this.tokenUsage } } });
    });
    this.#threadWrites = write.catch(() => {});
    return write;
  }

  #countUsage(usage: TokenUsage) {
    this.#tokenUsage = addTokenUsage(this.#tokenUsage, usage);
    // A turn reports a handful of steps at its end; each write stores the total as it then stands.
    this.#writeThread(thread => thread).catch(error => {
      console.warn('[claude-code ui] Unable to record the token usage.', error);
    });
  }

  /** Stores the model a new turn reported on the thread, so `GET /` still names it after a restart. */
  #recordModel() {
    const model = this.#projector.modelId;
    if (!model || model === this.#storedModelId) return;
    this.#storedModelId = model;
    this.#writeThread(thread =>
      thread.metadata?.[THREAD_MODEL_KEY] === model
        ? undefined
        : { ...thread, metadata: { ...thread.metadata, [THREAD_MODEL_KEY]: model } },
    ).catch(error => console.warn('[claude-code ui] Unable to record the model.', error));
  }

  #apply(projection: Projection) {
    for (const event of projection.events) if (event.type === 'usage_update') this.#countUsage(event.usage);
    this.#recordModel();
    for (const message of projection.writes) {
      // Re-inserting keeps the order messages first changed in, which is creation order for new ones.
      this.#pending.delete(message.id);
      this.#pending.set(message.id, message);
    }
    if (projection.writes.length) this.#scheduleFlush();
    for (const event of projection.events) {
      // As a Mastra session's bus: every event is followed by the state it leaves, so the chat's
      // run state, usage (`/cost`) and queued follow-ups follow along; bursts share snapshots.
      const coalesced = COALESCIBLE_DISPLAY_STATE_EVENTS.has(event.type);
      if (!coalesced) this.#flushDisplayState();
      this.#dispatch(event);
      if (event.type === 'display_state_changed' || this.#listeners.size === 0) continue;
      if (coalesced) this.#scheduleDisplayState();
      else this.#dispatchDisplayState();
    }
  }

  #dispatch(event: AgentControllerEvent) {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.warn('[claude-code ui] Stream listener failed.', error);
      }
    }
  }

  #dispatchDisplayState() {
    this.#dispatch({ type: 'display_state_changed', displayState: this.displayState() } as AgentControllerEvent);
  }

  /** A leading snapshot now, then at most one trailing one per window. */
  #scheduleDisplayState() {
    if (this.#displayStateTimer) {
      this.#displayStatePending = true;
      return;
    }
    this.#dispatchDisplayState();
    this.#displayStateTimer = setTimeout(() => {
      this.#displayStateTimer = undefined;
      this.#flushDisplayState();
    }, DISPLAY_STATE_COALESCE_MS);
    this.#displayStateTimer.unref?.();
  }

  /** Sends the snapshot a coalescing window withheld, if any. */
  #flushDisplayState() {
    if (this.#displayStateTimer) {
      clearTimeout(this.#displayStateTimer);
      this.#displayStateTimer = undefined;
    }
    if (!this.#displayStatePending) return;
    this.#displayStatePending = false;
    this.#dispatchDisplayState();
  }

  #scheduleFlush() {
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    this.#flushing = this.#flushing.then(async () => {
      await this.ready;
      this.#flushScheduled = false;
      const messages = [...this.#pending.values()];
      this.#pending.clear();
      if (messages.length === 0) return;
      try {
        const memory = await this.memory();
        for (const threadId of new Set(messages.map(message => message.threadId).filter(Boolean))) {
          await this.#ensureThread(memory, threadId!);
        }
        await memory.saveMessages({ messages });
      } catch (error) {
        console.warn('[claude-code ui] Unable to record the transcript.', error);
      }
    });
  }
}

/**
 * Shows a Claude Code session in the chat: records its transcript into its
 * memory thread and makes its live events available to the stream route.
 * Call once per session object, when the harness creates or rehydrates it;
 * {@link ClaudeSessionUi.attach} does this and also registers the session
 * with the routes.
 */
export function attachClaudeSessionToUi(session: ChatTranscriptSession, deps: AttachClaudeSessionDeps): ClaudeSessionUiChannel {
  return new ClaudeSessionUiChannel(session, deps);
}
