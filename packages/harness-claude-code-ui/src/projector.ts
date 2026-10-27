import { randomUUID } from 'node:crypto';

import type { AgentControllerEvent, MastraDBMessage, MastraMessagePart } from '@mastra/core/agent-controller';
import { createSignal } from '@mastra/core/signals';

import type { AgentEvent, PlanDecision } from '@factory/harness';
import { PLAN_GATE_TOOL_IDS, type ClaudeTranscriptEntry, type PlanGate } from '@factory/harness-claude-code';

/** The tool name the chat UI draws the plan card for; Claude calls the gate under its MCP id. */
export const UI_PLAN_TOOL_NAME = 'submit_plan';

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

/** A part deltas grew that its full block has not confirmed yet. */
interface StreamedPart {
  index: number;
  kind: 'text' | 'thinking';
}

function displayToolName(toolName: string): string {
  return PLAN_GATE_TOOL_IDS.includes(toolName) ? UI_PLAN_TOOL_NAME : toolName;
}

function planArgs(input: unknown): { title?: string; plan?: string } {
  const record = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  return {
    ...(typeof record.title === 'string' && record.title.trim() ? { title: record.title } : {}),
    ...(typeof record.plan === 'string' ? { plan: record.plan } : {}),
  };
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
 * Subagent output (entries with a `parentToolCallId`) stays out: the chat
 * shows the subagent as its parent tool call.
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
  /** The part deltas are growing now. */
  #active: StreamedPart | undefined;
  /** Streamed parts of {@link #current} whose full block is still to come, oldest first. */
  #unconfirmed: StreamedPart[] = [];
  #segment = 0;
  /** Messages holding tool calls that have not settled, by tool call id. */
  #openTools = new Map<string, MastraDBMessage>();
  #pendingPlan: PendingPlan | undefined;
  #modelId: string | undefined;

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

  /** The live assistant message, for a client that connects mid-run. */
  get currentMessage(): MastraDBMessage | null {
    return this.#current ? clone(this.#current) : null;
  }

  /** The plan the UI should offer approve/reject for, if any. */
  get pendingSuspension():
    | { toolCallId: string; toolName: string; args: unknown; suspendPayload: unknown }
    | undefined {
    const pending = this.#pendingPlan;
    if (!pending) return undefined;
    return { toolCallId: pending.toolCallId, toolName: UI_PLAN_TOOL_NAME, args: pending.args, suspendPayload: pending.args };
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
    if (meta.runId !== this.#runId) {
      this.#runId = meta.runId;
      this.#segment = 0;
      if (!this.#running) {
        this.#running = true;
        out.events.push({ type: 'agent_start' });
      }
    }
    if ('parentToolCallId' in entry && entry.parentToolCallId) return out;

    switch (entry.kind) {
      case 'input':
        this.#closeCurrent(out);
        this.#input(entry, meta.threadId, out);
        break;
      case 'plan_decision':
        this.#closeCurrent(out);
        this.#settlePlan(out, entry.toolCallId, entry.decision);
        break;
      case 'init':
        if (entry.model) this.#modelId = entry.model;
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
  event(event: AgentEvent | { type: string }, pendingPlan?: PlanGate): Projection {
    const out: Projection = { events: [], writes: [] };
    switch (event.type) {
      case 'tool_suspended': {
        const { toolCallId } = event as Extract<AgentEvent, { type: 'tool_suspended' }>;
        this.#closeCurrent(out);
        this.#suspend(toolCallId, pendingPlan, out);
        break;
      }
      case 'tool_suspension_cancelled': {
        const { toolCallId } = event as Extract<AgentEvent, { type: 'tool_suspension_cancelled' }>;
        this.#settlePlan(out, toolCallId, undefined, 'superseded by new work');
        break;
      }
      case 'error': {
        const { error } = event as Extract<AgentEvent, { type: 'error' }>;
        const failure = error instanceof Error ? error : new Error(String(error));
        out.events.push({ type: 'error', error: failure });
        break;
      }
      case 'agent_end': {
        const { reason } = event as Extract<AgentEvent, { type: 'agent_end' }>;
        this.#closeCurrent(out);
        this.#running = false;
        // A call cut off by an abort or a failure never gets its result; only a parked plan stays open.
        for (const [toolCallId, message] of [...this.#openTools]) {
          if (toolCallId === this.#pendingPlan?.toolCallId) continue;
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

  #input(entry: Extract<ClaudeTranscriptEntry, { kind: 'input' }>, threadId: string, out: Projection) {
    const createdAt = this.#createdAt();
    const id = entry.id ?? this.#newId();
    const signal =
      entry.source === 'signal'
        ? createSignal({ id, type: 'user', tagName: 'user', contents: entry.text, createdAt })
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
      content: { format: 2, parts: [] },
    };
    this.#current = message;
    out.events.push({ type: 'message_start', message: clone(message) });
    return message;
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
    const args = toolName === UI_PLAN_TOOL_NAME ? planArgs(entry.input) : entry.input;
    const part: ToolInvocationPart = {
      type: 'tool-invocation',
      toolInvocation: { state: 'call', toolCallId: entry.toolCallId, toolName, args },
      createdAt: this.#now().getTime(),
    };
    this.#setPart(message, message.content.parts.length, part, out);
    this.#openTools.set(entry.toolCallId, message);
    out.writes.push(clone(message));
    out.events.push({ type: 'tool_start', toolCallId: entry.toolCallId, toolName, args });
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
