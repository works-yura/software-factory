import { randomUUID } from 'node:crypto';

import { assignTaskIds } from '@mastra/core/agent-controller';
import type {
  AgentControllerEvent,
  MastraDBMessage,
  MastraMessagePart,
  TokenUsage,
} from '@mastra/core/agent-controller';
import type { NotificationRecord } from '@mastra/core/notifications';
import { notificationSignalAttributes, notificationSignalMetadata } from '@mastra/core/notifications';
import { createSignal } from '@mastra/core/signals';

import type { AgentEvent, AgentTokenUsage, PlanDecision } from '@factory/harness';
import {
  ASK_USER_QUESTION_TOOL,
  askUserPrompt,
  PLAN_GATE_TOOL_IDS,
  type AskUserPrompt,
  type ClaudeNotificationRecord,
  type ClaudeTranscriptEntry,
  type PermissionRequest,
  type PlanGate,
} from '@factory/harness-claude-code';

/** The tool name the chat UI draws the plan card for; Claude calls the gate under its MCP id. */
export const UI_PLAN_TOOL_NAME = 'submit_plan';
/** The tool name the chat UI draws a question card for; Claude asks with `AskUserQuestion`. */
export const UI_QUESTION_TOOL_NAME = 'ask_user';
/** Claude's task list tool; the chat shows it as the task panel, as it does Mastra's `task_write`. */
export const TODO_WRITE_TOOL = 'TodoWrite';
/** The task tool the chat UI keeps out of the transcript and reads the task panel from. */
export const UI_TASK_TOOL_NAME = 'task_write';
/** Claude's tools that start a subagent; the CLI renamed `Task` to `Agent`. */
export const SUBAGENT_TOOLS: readonly string[] = ['Task', 'Agent'];

/** A task in the chat's task panel, as Mastra's task tools keep it. */
export type UiTask = ReturnType<typeof assignTaskIds>[number];

/** What one transcript entry or session event changes: events for the live stream, messages to store. */
export interface Projection {
  events: AgentControllerEvent[];
  /** Whole messages to upsert, by id; a message appears again whenever it changed. */
  writes: MastraDBMessage[];
}

export interface ProjectorOptions {
  /** The memory resource the session's threads live on. */
  resourceId: string;
  now?: () => Date;
  newId?: () => string;
}

type ToolInvocationPart = Extract<MastraMessagePart, { type: 'tool-invocation' }>;
type ReasoningPart = Extract<MastraMessagePart, { type: 'reasoning' }>;

/** A plan the session is parked on, as the chat UI keeps a pending `submit_plan` suspension. */
interface PendingPlan {
  toolCallId: string;
  args: { title?: string; plan?: string };
}

/** A question waiting for the person's answer, as the chat UI keeps a pending `ask_user` suspension. */
interface PendingQuestion {
  toolCallId: string;
  args: AskUserPrompt;
  /** The message the question is stored on: the call's own, or its subagent's parent call's. */
  holderId?: string;
}

/** A tool call waiting for a person's permission, as the chat UI keeps a pending tool approval. */
interface PendingApproval {
  toolCallId: string;
  toolName: string;
  args: unknown;
  /** The message the approval is stored on: the call's own, or its subagent's parent call's. */
  holderId?: string;
}

/** The result a call gets once a person answered its permission request. */
export const PERMISSION_ALLOWED = 'Allowed by a person. Claude retries the call.';
export const PERMISSION_DENIED = 'Denied by a person.';
export const PERMISSION_SUPERSEDED = 'Not answered: new input came first.';

/** A part deltas grew that its full block has not confirmed yet. */
interface StreamedPart {
  index: number;
  kind: 'text' | 'thinking';
}

function displayToolName(toolName: string): string {
  if (toolName === ASK_USER_QUESTION_TOOL) return UI_QUESTION_TOOL_NAME;
  if (toolName === TODO_WRITE_TOOL) return UI_TASK_TOOL_NAME;
  return PLAN_GATE_TOOL_IDS.includes(toolName) ? UI_PLAN_TOOL_NAME : toolName;
}

function planArgs(input: unknown): { title?: string; plan?: string } {
  const record = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  return {
    ...(typeof record.title === 'string' && record.title.trim() ? { title: record.title } : {}),
    ...(typeof record.plan === 'string' ? { plan: record.plan } : {}),
  };
}

const TASK_STATUSES = new Set(['pending', 'in_progress', 'completed']);

/** `TodoWrite`'s `todos` as Mastra's task tools take them; items that are not tasks are dropped. */
function todoTasks(input: unknown): Array<{ content: string; status: UiTask['status']; activeForm: string }> {
  const todos = input && typeof input === 'object' ? (input as { todos?: unknown }).todos : undefined;
  if (!Array.isArray(todos)) return [];
  return todos.flatMap(todo => {
    if (!todo || typeof todo !== 'object') return [];
    const { content, status, activeForm } = todo as Record<string, unknown>;
    if (typeof content !== 'string' || !content.trim()) return [];
    return [
      {
        content,
        status: (typeof status === 'string' && TASK_STATUSES.has(status) ? status : 'pending') as UiTask['status'],
        activeForm: typeof activeForm === 'string' && activeForm.trim() ? activeForm : content,
      },
    ];
  });
}

/** Usage as the chat reads it: the three counts always present, the cache counts when Claude reported them. */
export function uiTokenUsage(usage: AgentTokenUsage): TokenUsage {
  const result: TokenUsage = {
    promptTokens: usage.promptTokens ?? 0,
    completionTokens: usage.completionTokens ?? 0,
    totalTokens: usage.totalTokens ?? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0),
  };
  for (const key of [
    'reasoningTokens',
    'cachedInputTokens',
    'cacheCreationInputTokens',
    'cacheCreationInputTokens5m',
    'cacheCreationInputTokens1h',
  ] as const) {
    if (usage[key] !== undefined) result[key] = usage[key];
  }
  return result;
}

/** A running subagent (a `Task`/`Agent` call), as the chat's subagent card follows it. */
interface ActiveSubagent {
  agentType: string;
  startedAt: number;
  /** Its tool calls still running, by id, for the name their end reports. */
  tools: Map<string, string>;
  /** Text streamed since its last full block, which then repeats it. */
  streamed: boolean;
}

function stringField(input: unknown, key: string): string | undefined {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** The result a tool call gets when its run ended before it did. */
export const INTERRUPTED = 'The run ended before this tool call finished.';

const NOTIFICATION = /^<system-notification([^>]*)>\n?([\s\S]*?)\n?<\/system-notification>$/;
const ATTRIBUTE = /(\w+)="([^"]*)"/g;

/** The harness wraps a notification in a `<system-notification>` tag for Claude; the chat shows its body. */
function parseNotification(text: string): { body: string; attributes: Record<string, string> } {
  const match = NOTIFICATION.exec(text.trim());
  if (!match) return { body: text, attributes: {} };
  const attributes: Record<string, string> = {};
  for (const [, key, value] of match[1]!.matchAll(ATTRIBUTE)) attributes[key!] = value!;
  return { body: match[2]!.trim(), attributes };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Claude's models are Anthropic's; stamped beside the model id as Mastra stamps a reply's provider. */
export const CLAUDE_MODEL_PROVIDER = 'anthropic';

/**
 * A run's failure as Mastra stores it on the assistant message (an `error`
 * part, `toPersistedErrorIdentity`): name and message, the HTTP status as
 * `statusCode`, plus what a Claude Code failure knows on top (`kind`, the
 * CLI's `status`, when a limit `resetsAt`). Also the shape a stream's `error`
 * event carries.
 */
export function runErrorIdentity(error: unknown, modelId?: string) {
  const failure = error instanceof Error ? error : new Error(String(error));
  const details = failure as Error & { kind?: unknown; status?: unknown; resetsAt?: unknown };
  const status = typeof details.status === 'number' && Number.isInteger(details.status) ? details.status : undefined;
  return {
    name: failure.name || 'Error',
    message: failure.message || 'Unknown error',
    ...(status !== undefined ? { statusCode: status, status } : {}),
    ...(typeof details.kind === 'string' ? { kind: details.kind } : {}),
    ...(details.resetsAt instanceof Date && !Number.isNaN(details.resetsAt.getTime())
      ? { resetsAt: details.resetsAt.toISOString() }
      : {}),
    ...(modelId ? { modelId } : {}),
  };
}

/** The notification signal Mastra stores for a delivered notification record (`createNotificationSignal`). */
function notificationSignal(record: ClaudeNotificationRecord, id: string, createdAt: Date) {
  const received = new Date(record.createdAt);
  const delivered = {
    ...record,
    threadId: '',
    status: 'delivered',
    createdAt: received,
    updatedAt: received,
  } as unknown as NotificationRecord;
  return createSignal({
    id,
    type: 'notification',
    tagName: 'notification',
    contents: record.summary,
    createdAt,
    attributes: notificationSignalAttributes(delivered),
    metadata: { ...record.metadata, notification: notificationSignalMetadata(delivered) },
  });
}

/**
 * Turns a Claude Code session's transcript and events into what the chat UI
 * reads for a Mastra session: `MastraDBMessage`s for the thread history and
 * agent-controller events for the live stream. Pure bookkeeping; the caller
 * stores the writes and fans the events out.
 *
 * Message model: each input (a person's message, a dispatcher signal, a
 * notification) is a `signal` message, as Mastra stores them; everything
 * Claude says and does between two inputs is one assistant message whose
 * parts are its text, thinking and tool calls in order. Streaming deltas grow
 * the last part live and are stored once the full block arrives, under the
 * same message id. A tool result settles its call's part in place. A plan
 * gate is a `submit_plan` call (the UI's plan card) whose message carries the
 * pending suspension until a decision, or new work, settles it.
 *
 * Subagent output (entries with a `parentToolCallId`) stays out of the stored
 * messages: the chat shows the subagent as its parent tool call, and live as
 * the `subagent_*` events a Mastra subagent sends. `TodoWrite` is stored as
 * Mastra's `task_write` and sends `task_updated`, so the chat shows the task
 * panel instead of a tool row.
 */
export class ClaudeTranscriptProjector {
  readonly #resourceId: string;
  readonly #now: () => Date;
  readonly #newId: () => string;
  #lastCreatedAt = 0;
  #runId: string | undefined;
  #running = false;
  /** The assistant message being written, until the next input or the end of the run. */
  #current: MastraDBMessage | undefined;
  /** The latest assistant message since the last input, kept after it closed: a run's failure is recorded on it. */
  #lastAssistant: MastraDBMessage | undefined;
  /** The thread the latest entry was for, for a failure recorded before anything else was. */
  #lastThreadId: string | undefined;
  /** The part deltas are growing now. */
  #active: StreamedPart | undefined;
  /** Streamed parts of {@link #current} whose full block is still to come, oldest first. */
  #unconfirmed: StreamedPart[] = [];
  #segment = 0;
  /** Messages holding tool calls that have not settled, by tool call id. */
  #openTools = new Map<string, MastraDBMessage>();
  #pendingPlan: PendingPlan | undefined;
  #pendingApproval: PendingApproval | undefined;
  #pendingQuestion: PendingQuestion | undefined;
  #modelId: string | undefined;
  /** The account the run's replies ran on, as Mastra stamps a reply's credential. */
  #credential: { label: string; ownerId?: string } | undefined;
  #tasks: UiTask[] = [];
  /** Running subagents, by their `Task`/`Agent` call id. */
  #subagents = new Map<string, ActiveSubagent>();

  constructor(options: ProjectorOptions) {
    this.#resourceId = options.resourceId;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? randomUUID;
  }

  get running(): boolean {
    return this.#running;
  }

  /** The model Claude reported on the latest turn, e.g. `claude-sonnet-4-5`. */
  get modelId(): string | undefined {
    return this.#modelId;
  }

  /** The task list Claude keeps with `TodoWrite`, as the chat's task panel reads it. */
  get tasks(): UiTask[] {
    return clone(this.#tasks);
  }

  /** Picks up the task list stored before a restart (the latest `task_write` call's). */
  adoptTasks(tasks: UiTask[]): void {
    this.#tasks = clone(tasks);
  }

  /** The live assistant message, for a client that connects mid-run. */
  get currentMessage(): MastraDBMessage | null {
    return this.#current ? clone(this.#current) : null;
  }

  /** The plan the UI should offer approve/reject for, or the question it should take an answer to, if any. */
  get pendingSuspension():
    | { toolCallId: string; toolName: string; args: unknown; suspendPayload: unknown }
    | undefined {
    const plan = this.#pendingPlan;
    if (plan) return { toolCallId: plan.toolCallId, toolName: UI_PLAN_TOOL_NAME, args: plan.args, suspendPayload: plan.args };
    const question = this.#pendingQuestion;
    if (!question) return undefined;
    return {
      toolCallId: question.toolCallId,
      toolName: UI_QUESTION_TOOL_NAME,
      args: clone(question.args),
      suspendPayload: clone(question.args),
    };
  }

  /** The tool call the UI should offer allow/deny for, if any. */
  get pendingApproval(): { toolCallId: string; toolName: string; args: unknown } | undefined {
    const pending = this.#pendingApproval;
    return pending ? { toolCallId: pending.toolCallId, toolName: pending.toolName, args: clone(pending.args) } : undefined;
  }

  /**
   * Picks up a stored message holding the permission request the session is
   * parked on (after a restart), so an answer still settles its call.
   */
  adoptPermission(message: MastraDBMessage, request: PermissionRequest): void {
    const holds = message.content.parts.some(
      part => part.type === 'tool-invocation' && part.toolInvocation.toolCallId === request.toolCallId,
    );
    const copy = clone(message);
    if (holds) this.#openTools.set(request.toolCallId, copy);
    else if (request.parentToolCallId) this.#openTools.set(request.parentToolCallId, copy);
    if (request.toolName === ASK_USER_QUESTION_TOOL) {
      this.#pendingQuestion = { toolCallId: request.toolCallId, args: askUserPrompt(request.input), holderId: message.id };
      this.#lastCreatedAt = Math.max(this.#lastCreatedAt, new Date(message.createdAt).getTime());
      return;
    }
    this.#pendingApproval = {
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      args: request.input,
      holderId: message.id,
    };
    this.#lastCreatedAt = Math.max(this.#lastCreatedAt, new Date(message.createdAt).getTime());
  }

  /**
   * Picks up a stored message holding the plan the session is parked on, so a
   * decision made after a restart still settles its card.
   */
  adopt(message: MastraDBMessage, gate: PlanGate): void {
    this.#openTools.set(gate.toolCallId, clone(message));
    this.#pendingPlan = { toolCallId: gate.toolCallId, args: planArgs(gate) };
    this.#lastCreatedAt = Math.max(this.#lastCreatedAt, new Date(message.createdAt).getTime());
  }

  entry(entry: ClaudeTranscriptEntry, meta: { runId: string; threadId: string }): Projection {
    const out: Projection = { events: [], writes: [] };
    this.#lastThreadId = meta.threadId;
    if (meta.runId !== this.#runId) {
      this.#runId = meta.runId;
      this.#segment = 0;
      this.#lastAssistant = undefined;
      if (!this.#running) {
        this.#running = true;
        out.events.push({ type: 'agent_start' });
      }
    }
    // A subagent's call needs the person too; its approval rides on the subagent's own call.
    if (entry.kind === 'permission') {
      if (entry.toolName === ASK_USER_QUESTION_TOOL) {
        this.#pendingQuestion = { toolCallId: entry.toolCallId, args: askUserPrompt(entry.input) };
      } else {
        this.#pendingApproval = { toolCallId: entry.toolCallId, toolName: entry.toolName, args: entry.input };
      }
      return out;
    }
    if ('parentToolCallId' in entry && entry.parentToolCallId) {
      this.#subagentEntry(entry, entry.parentToolCallId, out);
      return out;
    }

    switch (entry.kind) {
      case 'input':
        this.#closeCurrent(out);
        this.#input(entry, meta.threadId, out);
        break;
      case 'plan_decision':
        this.#closeCurrent(out);
        this.#settlePlan(out, entry.toolCallId, entry.decision);
        break;
      case 'question_answer':
        this.#closeCurrent(out);
        this.#settleQuestion(out, entry.toolCallId, entry.answer, false);
        break;
      case 'permission_decision':
        this.#closeCurrent(out);
        this.#settleApproval(out, entry.toolCallId, entry.approved ? PERMISSION_ALLOWED : PERMISSION_DENIED, !entry.approved);
        break;
      case 'init':
        if (entry.model) this.#modelId = entry.model;
        break;
      case 'credential':
        this.#credential = { label: entry.label, ...(entry.ownerId ? { ownerId: entry.ownerId } : {}) };
        break;
      case 'text':
      case 'thinking':
        this.#block(entry.kind, entry.text, meta.threadId, out);
        break;
      case 'text_delta':
      case 'thinking_delta':
        this.#delta(entry.kind === 'text_delta' ? 'text' : 'thinking', entry.text, meta.threadId, out);
        break;
      case 'tool_call':
        this.#toolCall(entry, meta.threadId, out);
        break;
      case 'tool_result':
        this.#toolResult(entry, out);
        break;
      case 'plan': {
        // The call itself was drawn by its `tool_call`; the gate only makes it a pending plan once the run parks.
        const message = this.#openTools.get(entry.toolCallId);
        if (message) {
          this.#pendingPlan = { toolCallId: entry.toolCallId, args: planArgs({ title: entry.title, plan: entry.plan }) };
        }
        break;
      }
      case 'result':
        this.#closeCurrent(out);
        break;
      case 'user':
      case 'stdout':
        break;
    }
    return out;
  }

  /**
   * A session event. `pendingPlan` is the session's own pending gate, which
   * fills in a plan whose call this projector did not see (e.g. after a restart).
   */
  event(event: AgentEvent | { type: string }, pendingPlan?: PlanGate, pendingPermission?: PermissionRequest): Projection {
    const out: Projection = { events: [], writes: [] };
    switch (event.type) {
      case 'usage_update': {
        // One step's usage, as Mastra sends it; the channel keeps the running total.
        const { usage } = event as Extract<AgentEvent, { type: 'usage_update' }>;
        out.events.push({ type: 'usage_update', usage: uiTokenUsage(usage) });
        break;
      }
      case 'tool_suspended': {
        const { toolCallId } = event as Extract<AgentEvent, { type: 'tool_suspended' }>;
        this.#closeCurrent(out);
        const question =
          this.#pendingQuestion?.toolCallId === toolCallId ||
          (pendingPermission?.toolCallId === toolCallId && pendingPermission.toolName === ASK_USER_QUESTION_TOOL);
        if (question) {
          this.#askQuestion(toolCallId, pendingPermission, out);
        } else if (pendingPermission?.toolCallId === toolCallId || this.#pendingApproval?.toolCallId === toolCallId) {
          this.#requestApproval(toolCallId, pendingPermission, out);
        } else {
          this.#suspend(toolCallId, pendingPlan, out);
        }
        break;
      }
      case 'tool_suspension_cancelled': {
        const { toolCallId } = event as Extract<AgentEvent, { type: 'tool_suspension_cancelled' }>;
        if (this.#pendingQuestion?.toolCallId === toolCallId) {
          this.#settleQuestion(out, toolCallId, PERMISSION_SUPERSEDED, true);
        } else if (this.#pendingApproval?.toolCallId === toolCallId) {
          this.#settleApproval(out, toolCallId, PERMISSION_SUPERSEDED, true);
        } else {
          this.#settlePlan(out, toolCallId, undefined, 'superseded by new work');
        }
        break;
      }
      case 'error': {
        const { error } = event as Extract<AgentEvent, { type: 'error' }>;
        const failure = error instanceof Error ? error : new Error(String(error));
        out.events.push({ type: 'error', error: failure });
        this.#recordError(failure, out);
        break;
      }
      case 'follow_up_queued': {
        const { count } = event as { type: 'follow_up_queued'; count: number };
        out.events.push({ type: 'follow_up_queued', count });
        break;
      }
      case 'agent_end': {
        const { reason } = event as Extract<AgentEvent, { type: 'agent_end' }>;
        this.#closeCurrent(out);
        this.#running = false;
        // A call cut off by an abort or a failure never gets its result; only a parked plan stays open.
        const waiting = this.#pendingApproval ?? this.#pendingQuestion;
        for (const [toolCallId, message] of [...this.#openTools]) {
          if (toolCallId === this.#pendingPlan?.toolCallId) continue;
          if (waiting && (toolCallId === waiting.toolCallId || message.id === waiting.holderId)) continue;
          this.#settleTool(message, toolCallId, INTERRUPTED, true, out);
        }
        out.events.push({ type: 'agent_end', ...(reason ? { reason } : {}) });
        break;
      }
    }
    return out;
  }

  // -- internals ------------------------------------------------------------

  #createdAt(): Date {
    // Strictly increasing, so the history reads back in the order things happened.
    const time = Math.max(this.#now().getTime(), this.#lastCreatedAt + 1);
    this.#lastCreatedAt = time;
    return new Date(time);
  }

  /**
   * Stores a run's failure as Mastra's `recordTerminalErrorMessage` does: an
   * `error` part on the run's latest assistant message (once), or on a new
   * assistant message when the run said nothing yet.
   */
  #recordError(error: Error, out: Projection) {
    const part = { type: 'error' as const, error: runErrorIdentity(error, this.#modelId) };
    const open = this.#current;
    const target = open ?? this.#lastAssistant;
    if (target?.content.parts.some(existing => existing.type === 'error')) return;
    if (open) {
      this.#setPart(open, open.content.parts.length, part, out);
      out.writes.push(clone(open));
      return;
    }
    if (target) {
      target.content.parts.push(part);
      out.writes.push(clone(target));
      return;
    }
    // Nothing said yet: a message of its own, as Mastra creates one for a failed attempt with no output.
    const message = this.#ensureCurrent(this.#lastThreadId ?? '', out);
    this.#setPart(message, 0, part, out);
    this.#closeCurrent(out);
  }

  #input(entry: Extract<ClaudeTranscriptEntry, { kind: 'input' }>, threadId: string, out: Projection) {
    this.#lastAssistant = undefined;
    const createdAt = this.#createdAt();
    const id = entry.id ?? this.#newId();
    // A person's message carries its author, and one that joined a run in flight is marked an
    // interjection, as Mastra's session stamps them (`withMessageAuthor`, `asInterjection`).
    const author = entry.author;
    const signal =
      entry.source === 'signal'
        ? createSignal({
            id,
            type: 'user',
            tagName: 'user',
            contents: entry.text,
            createdAt,
            ...(author ? { author, providerOptions: { mastra: { author: { ...author } } } } : {}),
            ...(entry.delivery ? { attributes: { delivery: entry.delivery } } : {}),
          })
        : entry.notification
          ? notificationSignal(entry.notification, id, createdAt)
          : (() => {
            const { body, attributes } = parseNotification(entry.text);
            return createSignal({
              id,
              type: 'reactive',
              tagName: 'notification',
              contents: body,
              createdAt,
              ...(Object.keys(attributes).length ? { attributes } : {}),
            });
          })();
    const message = signal.toDBMessage({ threadId, resourceId: this.#resourceId }) as MastraDBMessage;
    out.writes.push(clone(message));
    out.events.push({ type: 'message_start', message: clone(message) }, { type: 'message_end', id: message.id });
  }

  #ensureCurrent(threadId: string, out: Projection): MastraDBMessage {
    if (this.#current) return this.#current;
    this.#segment += 1;
    const message: MastraDBMessage = {
      id: `claude-${this.#runId ?? this.#newId()}-${this.#segment}`,
      role: 'assistant',
      createdAt: this.#createdAt(),
      threadId,
      resourceId: this.#resourceId,
      // The model that answered, as Mastra stamps a reply (`stampResponseModel`).
      content: {
        format: 2,
        parts: [],
        ...(this.#modelId ? { metadata: { modelId: this.#modelId, provider: CLAUDE_MODEL_PROVIDER, ...this.#credentialStamp() } } : {}),
      },
    };
    this.#current = message;
    out.events.push({ type: 'message_start', message: clone(message) });
    return message;
  }

  /** `credentialLabel`, and `credentialOwnerId` for someone's own sign-in, as the chat reads a reply's credential. */
  #credentialStamp(): { credentialLabel?: string; credentialOwnerId?: string } {
    const credential = this.#credential;
    if (!credential) return {};
    return { credentialLabel: credential.label, ...(credential.ownerId ? { credentialOwnerId: credential.ownerId } : {}) };
  }

  #setPart(message: MastraDBMessage, index: number, part: MastraMessagePart, out: Projection) {
    message.content.parts[index] = part;
    out.events.push({ type: 'message_update', id: message.id, event: { type: 'part', index, part: clone(part) } });
  }

  #block(kind: 'text' | 'thinking', text: string, threadId: string, out: Projection) {
    const message = this.#ensureCurrent(threadId, out);
    const streamed = this.#unconfirmed.findIndex(part => part.kind === kind);
    let index = message.content.parts.length;
    if (streamed !== -1) {
      const [part] = this.#unconfirmed.splice(streamed, 1);
      index = part!.index;
      if (this.#active === part) this.#active = undefined;
    }
    this.#setPart(message, index, kind === 'text' ? { type: 'text', text } : reasoningPart(text), out);
    out.writes.push(clone(message));
  }

  #delta(kind: 'text' | 'thinking', text: string, threadId: string, out: Projection) {
    if (!text) return;
    const message = this.#ensureCurrent(threadId, out);
    let active = this.#active;
    if (active?.kind !== kind) {
      active = { index: message.content.parts.length, kind };
      this.#active = active;
      this.#unconfirmed.push(active);
      this.#setPart(message, active.index, kind === 'text' ? { type: 'text', text: '' } : reasoningPart(''), out);
    }
    const { index } = active;
    const part = message.content.parts[index]!;
    if (part.type === 'text') {
      message.content.parts[index] = { ...part, text: part.text + text };
      out.events.push({ type: 'message_update', id: message.id, event: { type: 'text-delta', delta: text } });
    } else if (part.type === 'reasoning') {
      message.content.parts[index] = reasoningPart(part.reasoning + text);
      out.events.push({ type: 'message_update', id: message.id, event: { type: 'reasoning-delta', index, delta: text } });
    }
  }

  #toolCall(entry: Extract<ClaudeTranscriptEntry, { kind: 'tool_call' }>, threadId: string, out: Projection) {
    const message = this.#ensureCurrent(threadId, out);
    this.#active = undefined;
    const toolName = displayToolName(entry.toolName);
    const tasks = toolName === UI_TASK_TOOL_NAME ? assignTaskIds(todoTasks(entry.input), this.#tasks) : undefined;
    const args =
      toolName === UI_PLAN_TOOL_NAME
        ? planArgs(entry.input)
        : toolName === UI_QUESTION_TOOL_NAME
          ? askUserPrompt(entry.input)
          : tasks
            ? { tasks }
            : entry.input;
    const part: ToolInvocationPart = {
      type: 'tool-invocation',
      toolInvocation: { state: 'call', toolCallId: entry.toolCallId, toolName, args },
      createdAt: this.#now().getTime(),
    };
    this.#setPart(message, message.content.parts.length, part, out);
    this.#openTools.set(entry.toolCallId, message);
    out.writes.push(clone(message));
    out.events.push({ type: 'tool_start', toolCallId: entry.toolCallId, toolName, args });
    if (tasks) {
      // As Mastra's `task_write` does: the call replaces the whole list and tells the panel.
      this.#tasks = tasks;
      out.events.push({ type: 'task_updated', tasks: clone(tasks) });
    }
    if (SUBAGENT_TOOLS.includes(entry.toolName)) this.#startSubagent(entry, out);
  }

  #startSubagent(entry: Extract<ClaudeTranscriptEntry, { kind: 'tool_call' }>, out: Projection) {
    const agentType = stringField(entry.input, 'subagent_type') ?? 'general-purpose';
    this.#subagents.set(entry.toolCallId, {
      agentType,
      startedAt: this.#now().getTime(),
      tools: new Map(),
      streamed: false,
    });
    out.events.push({
      type: 'subagent_start',
      toolCallId: entry.toolCallId,
      agentType,
      task: stringField(entry.input, 'prompt') ?? stringField(entry.input, 'description') ?? '',
      modelId: stringField(entry.input, 'model') ?? this.#modelId ?? '',
    });
  }

  /** What a subagent says and does, as a Mastra subagent streams it; none of it is stored. */
  #subagentEntry(entry: ClaudeTranscriptEntry, parentToolCallId: string, out: Projection) {
    const subagent = this.#subagents.get(parentToolCallId);
    if (!subagent) return;
    const { agentType } = subagent;
    const toolCallId = parentToolCallId;
    switch (entry.kind) {
      case 'text_delta':
        if (!entry.text) return;
        subagent.streamed = true;
        out.events.push({ type: 'subagent_text_delta', toolCallId, agentType, textDelta: entry.text });
        return;
      case 'text':
        // The full block repeats what its deltas already streamed.
        if (subagent.streamed) subagent.streamed = false;
        else if (entry.text) out.events.push({ type: 'subagent_text_delta', toolCallId, agentType, textDelta: entry.text });
        return;
      case 'tool_call':
        subagent.tools.set(entry.toolCallId, entry.toolName);
        out.events.push({
          type: 'subagent_tool_start',
          toolCallId,
          agentType,
          subToolName: entry.toolName,
          subToolArgs: entry.input,
        });
        return;
      case 'tool_result': {
        const subToolName = subagent.tools.get(entry.toolCallId);
        if (subToolName === undefined) return;
        subagent.tools.delete(entry.toolCallId);
        out.events.push({
          type: 'subagent_tool_end',
          toolCallId,
          agentType,
          subToolName,
          subToolResult: entry.content,
          isError: entry.isError,
        });
        return;
      }
    }
  }

  /** The subagent card's end: with its call's result, or cut off with the run. */
  #endSubagent(toolCallId: string, result: unknown, isError: boolean, out: Projection) {
    const subagent = this.#subagents.get(toolCallId);
    if (!subagent) return;
    this.#subagents.delete(toolCallId);
    out.events.push({
      type: 'subagent_end',
      toolCallId,
      agentType: subagent.agentType,
      result: typeof result === 'string' ? result : JSON.stringify(result),
      isError,
      durationMs: Math.max(0, this.#now().getTime() - subagent.startedAt),
    });
  }

  #settleTool(message: MastraDBMessage, toolCallId: string, result: unknown, isError: boolean, out: Projection): boolean {
    const index = message.content.parts.findIndex(
      part => part.type === 'tool-invocation' && part.toolInvocation.toolCallId === toolCallId,
    );
    const part = message.content.parts[index];
    if (!part || part.type !== 'tool-invocation') return false;
    const { toolName, args } = part.toolInvocation;
    const settled: ToolInvocationPart = {
      ...part,
      toolInvocation: { state: 'result', toolCallId, toolName, args, result, ...(isError ? { isError: true } : {}) },
    };
    this.#setPart(message, index, settled, out);
    this.#openTools.delete(toolCallId);
    out.writes.push(clone(message));
    out.events.push({ type: 'tool_end', toolCallId, result, isError });
    this.#endSubagent(toolCallId, result, isError, out);
    return true;
  }

  #toolResult(entry: Extract<ClaudeTranscriptEntry, { kind: 'tool_result' }>, out: Projection) {
    const message = this.#openTools.get(entry.toolCallId);
    if (message) this.#settleTool(message, entry.toolCallId, entry.content, entry.isError, out);
  }

  #suspend(toolCallId: string, gate: PlanGate | undefined, out: Projection) {
    const args = gate?.toolCallId === toolCallId ? planArgs(gate) : (this.#pendingPlan?.args ?? {});
    const message = this.#openTools.get(toolCallId);
    if (!message) return;
    this.#pendingPlan = { toolCallId, args };
    message.content.metadata = {
      ...message.content.metadata,
      suspendedTools: {
        [toolCallId]: { toolCallId, toolName: UI_PLAN_TOOL_NAME, args, suspendPayload: args },
      },
    };
    out.writes.push(clone(message));
    out.events.push({ type: 'tool_suspended', toolCallId, toolName: UI_PLAN_TOOL_NAME, args, suspendPayload: args });
  }

  /** The message to store a pending approval on: the call's own, or (a subagent's call) the newest open one. */
  #approvalHolder(toolCallId: string): MastraDBMessage | undefined {
    const own = this.#openTools.get(toolCallId);
    if (own) return own;
    const holderId = this.#pendingApproval?.holderId;
    const open = [...this.#openTools.values()];
    return (holderId ? open.find(message => message.id === holderId) : undefined) ?? open.at(-1);
  }

  #requestApproval(toolCallId: string, request: PermissionRequest | undefined, out: Projection) {
    const pending: PendingApproval =
      this.#pendingApproval?.toolCallId === toolCallId
        ? this.#pendingApproval
        : { toolCallId, toolName: request?.toolName ?? 'unknown', args: request?.input };
    const message = this.#approvalHolder(toolCallId);
    pending.holderId = message?.id;
    this.#pendingApproval = pending;
    const approval = { toolCallId, toolName: pending.toolName, args: clone(pending.args) };
    if (message) {
      message.content.metadata = {
        ...message.content.metadata,
        pendingToolApprovals: { ...(message.content.metadata?.pendingToolApprovals as object | undefined), [toolCallId]: approval },
      };
      out.writes.push(clone(message));
    }
    out.events.push({ type: 'tool_approval_required', ...approval } as AgentControllerEvent);
  }

  /** Parks the question card: the call's part becomes an `ask_user` waiting for the person's answer. */
  #askQuestion(toolCallId: string, request: PermissionRequest | undefined, out: Projection) {
    const pending: PendingQuestion =
      this.#pendingQuestion?.toolCallId === toolCallId
        ? this.#pendingQuestion
        : { toolCallId, args: askUserPrompt(request?.input) };
    const message = this.#approvalHolder(toolCallId);
    pending.holderId = message?.id;
    this.#pendingQuestion = pending;
    const suspension = {
      toolCallId,
      toolName: UI_QUESTION_TOOL_NAME,
      args: clone(pending.args),
      suspendPayload: clone(pending.args),
    };
    if (message) {
      message.content.metadata = {
        ...message.content.metadata,
        suspendedTools: { ...(message.content.metadata?.suspendedTools as object | undefined), [toolCallId]: suspension },
      };
      out.writes.push(clone(message));
    }
    out.events.push({ type: 'tool_suspended', ...suspension } as AgentControllerEvent);
  }

  /** Settles the question card: with the person's answer, or as superseded when new input came first. */
  #settleQuestion(out: Projection, toolCallId: string, result: string, isError: boolean) {
    const pending = this.#pendingQuestion?.toolCallId === toolCallId ? this.#pendingQuestion : undefined;
    if (pending) this.#pendingQuestion = undefined;
    const holder =
      this.#openTools.get(toolCallId) ??
      [...this.#openTools.values()].find(message => message.id === pending?.holderId);
    if (holder?.content.metadata?.suspendedTools) {
      const { suspendedTools, ...metadata } = holder.content.metadata as Record<string, unknown> & {
        suspendedTools: Record<string, unknown>;
      };
      const { [toolCallId]: _settled, ...rest } = suspendedTools;
      holder.content.metadata = Object.keys(rest).length ? { ...metadata, suspendedTools: rest } : metadata;
      out.writes.push(clone(holder));
    }
    const message = this.#openTools.get(toolCallId);
    if (message) this.#settleTool(message, toolCallId, result, isError, out);
    else if (holder) {
      for (const [id, open] of [...this.#openTools]) if (open === holder) this.#settleTool(open, id, INTERRUPTED, true, out);
    }
  }

  /** Settles a call that waited for permission: allowed, denied, or superseded by new input. */
  #settleApproval(out: Projection, toolCallId: string, result: string, isError: boolean) {
    const pending = this.#pendingApproval?.toolCallId === toolCallId ? this.#pendingApproval : undefined;
    if (pending) this.#pendingApproval = undefined;
    const holder =
      this.#openTools.get(toolCallId) ??
      [...this.#openTools.values()].find(message => message.id === pending?.holderId);
    if (holder?.content.metadata?.pendingToolApprovals) {
      const { pendingToolApprovals, ...metadata } = holder.content.metadata as Record<string, unknown> & {
        pendingToolApprovals: Record<string, unknown>;
      };
      const { [toolCallId]: _settled, ...rest } = pendingToolApprovals;
      holder.content.metadata = Object.keys(rest).length ? { ...metadata, pendingToolApprovals: rest } : metadata;
      out.writes.push(clone(holder));
    }
    const message = this.#openTools.get(toolCallId);
    if (message) this.#settleTool(message, toolCallId, result, isError, out);
    else if (holder) {
      // A subagent's call: its parent stays as it was, cut off by the stop.
      for (const [id, open] of [...this.#openTools]) if (open === holder) this.#settleTool(open, id, INTERRUPTED, true, out);
    }
  }

  /** Settles the plan card: with the person's decision, or as superseded when new work replaced it. */
  #settlePlan(out: Projection, toolCallId: string, decision: PlanDecision | undefined, cancelled?: string) {
    const pending = this.#pendingPlan?.toolCallId === toolCallId ? this.#pendingPlan : undefined;
    if (pending) this.#pendingPlan = undefined;
    const message = this.#openTools.get(toolCallId);
    if (!message) return;
    const args = pending?.args ?? {};
    if (message.content.metadata?.suspendedTools) {
      const { suspendedTools: _settled, ...metadata } = message.content.metadata;
      message.content.metadata = metadata;
    }
    const submittedPlan = {
      ...args,
      ...(decision?.title ? { title: decision.title } : {}),
      ...(decision?.plan ? { plan: decision.plan } : {}),
      ...(decision?.feedback ? { feedback: decision.feedback } : {}),
    };
    const result = decision ? { action: decision.action, submittedPlan } : { cancelled, submittedPlan };
    this.#settleTool(message, toolCallId, result, false, out);
    if (cancelled) {
      out.events.push({ type: 'tool_suspension_cancelled', toolCallId, toolName: UI_PLAN_TOOL_NAME, reason: cancelled });
    }
  }

  #closeCurrent(out: Projection) {
    const message = this.#current;
    if (!message) return;
    this.#current = undefined;
    this.#lastAssistant = message;
    this.#active = undefined;
    this.#unconfirmed = [];
    // A part that only ever streamed (its full block never came, e.g. on abort) is kept as streamed.
    if (message.content.parts.length > 0) out.writes.push(clone(message));
    out.events.push({ type: 'message_end', id: message.id });
  }
}

function reasoningPart(text: string): ReasoningPart {
  return { type: 'reasoning', reasoning: text, details: [{ type: 'text', text }] };
}
