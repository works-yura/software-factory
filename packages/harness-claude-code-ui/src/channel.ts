import type { AgentControllerEvent, MastraDBMessage } from '@mastra/core/agent-controller';
import { defaultDisplayState } from '@mastra/core/agent-controller';
import type { MemoryStorage } from '@mastra/core/storage';

import type { ClaudeCodeSession } from '@factory/harness-claude-code';
import { ASK_USER_QUESTION_TOOL, askUserPrompt } from '@factory/harness-claude-code';

import { ClaudeTranscriptProjector, UI_QUESTION_TOOL_NAME, type Projection } from './projector.ts';

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

/** How many of the newest stored messages are searched for a plan parked before a restart. */
const ADOPT_WINDOW = 50;

/**
 * One Claude Code session as the chat UI sees it: its transcript recorded into
 * the session's memory thread (resource = the session's resourceId, thread =
 * its threadId) and its live events fanned out to the open streams.
 */
export class ClaudeSessionUiChannel {
  readonly session: ClaudeCodeSession;
  readonly #storage: ClaudeUiStorage;
  readonly #projector: ClaudeTranscriptProjector;
  readonly #listeners = new Set<ClaudeUiEventListener>();
  readonly #pending = new Map<string, MastraDBMessage>();
  readonly #knownThreads = new Set<string>();
  #flushing: Promise<void> = Promise.resolve();
  #flushScheduled = false;
  readonly #detach: Array<() => void>;
  /** Session state the UI merges in (`PUT /state`); kept so it reads back, never given to Claude. */
  readonly state: Record<string, unknown> = {};
  /** Settles once the thread exists and a parked plan was picked back up. */
  readonly ready: Promise<void>;

  constructor(session: ClaudeCodeSession, deps: AttachClaudeSessionDeps) {
    this.session = session;
    this.#storage = deps.storage;
    this.#projector = new ClaudeTranscriptProjector({
      resourceId: this.resourceId,
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

  get modelId(): string | undefined {
    return this.#projector.modelId;
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
    return state;
  }

  /** Resolves once everything recorded so far is stored. */
  async flushed(): Promise<void> {
    await this.ready;
    while (this.#flushScheduled || this.#pending.size > 0) await this.#flushing;
    await this.#flushing;
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
    await this.#ensureThread(memory, this.threadId);
    const gate = this.session.pendingPlan;
    const permission = this.session.pendingPermission;
    if (!gate && !permission) return;
    const { messages } = await memory.listMessages({
      threadId: this.threadId,
      resourceId: this.resourceId,
      perPage: ADOPT_WINDOW,
      page: 0,
      orderBy: { field: 'createdAt', direction: 'DESC' },
    });
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

  async #ensureThread(memory: MemoryStore, threadId: string): Promise<void> {
    if (this.#knownThreads.has(threadId)) return;
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
  }

  #apply(projection: Projection) {
    for (const message of projection.writes) {
      // Re-inserting keeps the order messages first changed in, which is creation order for new ones.
      this.#pending.delete(message.id);
      this.#pending.set(message.id, message);
    }
    if (projection.writes.length) this.#scheduleFlush();
    for (const event of projection.events) {
      for (const listener of [...this.#listeners]) {
        try {
          listener(event);
        } catch (error) {
          console.warn('[claude-code ui] Stream listener failed.', error);
        }
      }
    }
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
export function attachClaudeSessionToUi(session: ClaudeCodeSession, deps: AttachClaudeSessionDeps): ClaudeSessionUiChannel {
  return new ClaudeSessionUiChannel(session, deps);
}
