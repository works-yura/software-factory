import { randomUUID } from 'node:crypto';

import type { AgentControllerEvent, MastraDBMessage } from '@mastra/core/agent-controller';
import type { StorageListMessagesInput } from '@mastra/core/storage';
import type { Context, MiddlewareHandler } from 'hono';

import type { PlanDecision } from '@factory/harness';
import { ClaudeCodeRunContext, type ClaudeCodeSession } from '@factory/harness-claude-code';

import { ClaudeSessionUiChannel, type ClaudeUiStorage } from './channel.ts';

/** How often an idle stream sends a comment so proxies and the client's idle timer keep it open. */
const HEARTBEAT_MS = 25_000;

const SESSION_ROUTE = /\/agent-controller\/([^/]+)\/sessions(?:\/([^/]+)(\/.*)?)?\/?$/;
const ACTIVE_RUNS_ROUTE = /\/agent-controller\/([^/]+)\/active-runs\/?$/;
const THREAD_MESSAGES = /^\/threads\/([^/]+)\/messages\/?$/;

export interface ClaudeSessionUiOptions {
  /** The agent controller whose routes the chat UI calls; only its paths are answered. */
  controllerId: string;
  storage: ClaudeUiStorage;
  /**
   * The Claude Code session behind a session id, loading it if this process
   * has not yet; `undefined` for a session another harness runs. Without it
   * only sessions passed to {@link ClaudeSessionUi.attach} are answered.
   */
  resolveSession?: (sessionId: string) => Promise<ClaudeCodeSession | undefined>;
  heartbeatMs?: number;
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  // A clone, so a request handed on to the Mastra handlers still has its body.
  const body = await c.req.raw
    .clone()
    .json()
    .catch(() => undefined);
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** An event as the Mastra stream route writes it: `Error`s flattened, display-state maps as records. */
export function toWireEvent(event: AgentControllerEvent | { type: 'display_state_changed'; displayState: unknown }): unknown {
  if ('displayState' in event) {
    const state = structuredClone(event.displayState) as Record<string, unknown>;
    for (const [key, value] of Object.entries(state)) if (value instanceof Map) state[key] = Object.fromEntries(value);
    return { ...event, displayState: state };
  }
  if ('error' in event && event.error instanceof Error) {
    return { ...event, error: { name: event.error.name, message: event.error.message } };
  }
  return event;
}

function isPlanDecision(value: unknown): value is PlanDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const action = (value as { action?: unknown }).action;
  return action === 'approved' || action === 'rejected';
}

function listOptions(c: Context): Omit<StorageListMessagesInput, 'threadId' | 'resourceId'> & { legacy: boolean } {
  const query = (name: string) => c.req.query(name);
  const json = (name: string) => {
    const raw = query(name);
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  };
  const number = (name: string) => {
    const raw = query(name);
    const value = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  const limit = number('limit');
  const page = number('page');
  if (limit !== undefined) {
    return { legacy: true, perPage: limit, page: page ?? 0, orderBy: { field: 'createdAt', direction: 'DESC' } };
  }
  const perPage = query('perPage') === 'false' ? false : number('perPage');
  const orderBy = json('orderBy') as StorageListMessagesInput['orderBy'];
  const include = json('include') as StorageListMessagesInput['include'];
  const filter = json('filter') as StorageListMessagesInput['filter'];
  return {
    legacy: false,
    ...(perPage !== undefined ? { perPage } : {}),
    ...(page !== undefined ? { page } : {}),
    ...(orderBy ? { orderBy } : {}),
    ...(include ? { include } : {}),
    ...(filter ? { filter } : {}),
  };
}

function wireMessage(message: MastraDBMessage) {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt instanceof Date ? message.createdAt.toISOString() : undefined,
    threadId: message.threadId,
    resourceId: message.resourceId,
    type: message.type,
  };
}

/**
 * Serves the chat UI's agent-controller session routes for Claude Code
 * sessions, with the shapes the Mastra handlers answer, so the chat page works
 * unchanged. Mount it after the session access guard (which checks every
 * `/agent-controller/:id/sessions/:sid` path whoever answers it) and before the
 * Mastra routes; a request for any other session passes through.
 */
export class ClaudeSessionUi {
  readonly #options: ClaudeSessionUiOptions;
  readonly #channels = new Map<string, ClaudeSessionUiChannel>();
  #resolve: ClaudeSessionUiOptions['resolveSession'];

  constructor(options: ClaudeSessionUiOptions) {
    this.#options = options;
    this.#resolve = options.resolveSession;
  }

  /**
   * Shows a session in the chat: records its transcript and streams its events.
   * Idempotent per session object; a new object for the same id (a rehydrated
   * session) replaces the old one's channel.
   */
  attach(session: ClaudeCodeSession): ClaudeSessionUiChannel {
    const existing = this.#channels.get(session.id);
    if (existing?.session === session) return existing;
    existing?.detach();
    const channel = new ClaudeSessionUiChannel(session, { storage: this.#options.storage });
    this.#channels.set(session.id, channel);
    return channel;
  }

  /** Sets how sessions this process has not attached yet are found, once the harness exists. */
  setSessionResolver(resolve: (sessionId: string) => Promise<ClaudeCodeSession | undefined>): void {
    this.#resolve = resolve;
  }

  channel(sessionId: string): ClaudeSessionUiChannel | undefined {
    return this.#channels.get(sessionId);
  }

  async #channelFor(sessionId: string): Promise<ClaudeSessionUiChannel | undefined> {
    const attached = this.#channels.get(sessionId);
    if (attached) return attached;
    const session = await this.#resolve?.(sessionId);
    return session ? this.attach(session) : undefined;
  }

  middleware(): MiddlewareHandler {
    return async (c, next) => {
      const path = c.req.path;
      const runs = ACTIVE_RUNS_ROUTE.exec(path);
      if (runs && c.req.method === 'GET' && decode(runs[1]!) === this.#options.controllerId) {
        await next();
        await this.#appendActiveRuns(c);
        return;
      }
      const match = SESSION_ROUTE.exec(path);
      if (!match || decode(match[1]!) !== this.#options.controllerId) return next();
      const rest = match[3] ?? '';
      if (!match[2]) {
        if (c.req.method !== 'POST') return next();
        const body = await jsonBody(c);
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
        const channel = sessionId ? await this.#channelFor(sessionId) : undefined;
        if (!channel) return next();
        await channel.ready;
        return c.json({
          controllerId: this.#options.controllerId,
          sessionId: channel.session.id,
          resourceId: channel.resourceId,
          threadId: channel.threadId,
        });
      }
      const channel = await this.#channelFor(decode(match[2]));
      if (!channel) return next();
      return this.#sessionRoute(c, channel, rest);
    };
  }

  async #sessionRoute(c: Context, channel: ClaudeSessionUiChannel, rest: string): Promise<Response> {
    const method = c.req.method;
    const session = channel.session;
    const route = `${method} ${rest || '/'}`;
    switch (route) {
      case 'GET /':
        return this.#state(c, channel);
      case 'GET /stream':
        return this.#stream(c, channel);
      case 'POST /messages':
      case 'POST /follow-up':
      // Claude cannot be interrupted mid-turn: steering joins the run as its next turn.
      case 'POST /steer': {
        const body = await jsonBody(c);
        if (typeof body.message !== 'string' || !body.message.trim()) {
          return c.json({ error: 'message is required' }, 400);
        }
        if (Array.isArray(body.files) && body.files.length > 0) {
          return c.json({ error: 'Claude Code sessions do not take attachments yet.' }, 400);
        }
        const { accepted } = session.sendSignal(
          { id: randomUUID(), type: 'user', tagName: 'user', contents: body.message },
          { requestContext: new ClaudeCodeRunContext() },
        );
        await accepted;
        return c.json({ ok: true });
      }
      case 'POST /abort':
        session.abort();
        return c.json({ ok: true });
      case 'POST /tool-suspension': {
        const body = await jsonBody(c);
        const gate = session.pendingPlan;
        if (!gate) return c.json({ ok: false, reason: 'no_pending_suspension' });
        if (body.toolCallId !== gate.toolCallId) return c.json({ ok: false, reason: 'stale_tool_call' });
        if (!isPlanDecision(body.resumeData)) return c.json({ error: 'resumeData must be a plan decision' }, 400);
        if (session.run.isRunning()) return c.json({ ok: false, reason: 'not_pending' });
        // Answered like the Mastra route: acknowledged now, the resumed run arrives on the stream.
        session.respondToToolSuspension({ resumeData: body.resumeData, toolCallId: gate.toolCallId }).catch(error => {
          // The client was told `ok`; the stream is where it learns the answer did not land.
          channel.emit({ type: 'error', error: error instanceof Error ? error : new Error(String(error)) });
        });
        return c.json({ ok: true });
      }
      case 'POST /tool-approval': {
        const body = await jsonBody(c);
        const request = session.pendingPermission;
        if (!request) return c.json({ ok: false, reason: 'not_pending' });
        if (body.toolCallId !== request.toolCallId) return c.json({ ok: false, reason: 'stale_tool_call' });
        if (typeof body.approved !== 'boolean') return c.json({ error: 'approved must be a boolean' }, 400);
        if (session.run.isRunning()) return c.json({ ok: false, reason: 'not_pending' });
        // Like the Mastra route: acknowledged now, the resumed run arrives on the stream.
        session.respondToToolApproval({ approved: body.approved, toolCallId: request.toolCallId }).catch(error => {
          channel.emit({ type: 'error', error: error instanceof Error ? error : new Error(String(error)) });
        });
        return c.json({ ok: true });
      }
      case 'PUT /state': {
        const body = await jsonBody(c);
        if (body.state && typeof body.state === 'object' && !Array.isArray(body.state)) {
          Object.assign(channel.state, body.state);
        }
        return c.json({ ok: true });
      }
      case 'GET /threads':
        return this.#threads(c, channel);
      case 'GET /permissions':
        return c.json({ categories: {}, tools: {} });
      case 'GET /goal':
      case 'GET /om':
        return c.json({});
      case 'GET /resources':
        return c.json({ resourceIds: [channel.resourceId] });
    }
    const messages = THREAD_MESSAGES.exec(rest);
    if (messages && method === 'GET') return this.#messages(c, channel, decode(messages[1]!));
    return c.json({ error: `Claude Code sessions do not support ${method} ${rest || '/'}.` }, 409);
  }

  async #state(c: Context, channel: ClaudeSessionUiChannel): Promise<Response> {
    const requested = c.req.query('threadId');
    if (requested && requested !== channel.threadId) {
      const thread = await (await channel.memory()).getThreadById({ threadId: requested });
      if (!thread || thread.resourceId !== channel.resourceId) {
        return c.json({ error: `thread "${requested}" not found` }, 404);
      }
    }
    const display = channel.displayState();
    const om = display.omProgress;
    return c.json({
      controllerId: this.#options.controllerId,
      sessionId: channel.session.id,
      resourceId: channel.resourceId,
      threadId: requested ?? channel.threadId,
      modeId: channel.session.mode ?? 'default',
      modelId: channel.modelId ?? '',
      running: channel.running,
      tasks: [],
      omProgress: {
        status: om.status,
        pendingTokens: om.pendingTokens,
        threshold: om.threshold,
        thresholdPercent: om.thresholdPercent,
        observationTokens: om.observationTokens,
        reflectionThreshold: om.reflectionThreshold,
        reflectionThresholdPercent: om.reflectionThresholdPercent,
        projectedMessageRemoval: om.buffered.observations.projectedMessageRemoval,
        projectedReflectionSavings: 0,
      },
      tokenUsage: display.tokenUsage,
      settings: { yolo: false, notifications: 'off', smartEditing: true },
    });
  }

  #stream(c: Context, channel: ClaudeSessionUiChannel): Response {
    const heartbeatMs = this.#options.heartbeatMs ?? HEARTBEAT_MS;
    const encoder = new TextEncoder();
    let cleanup = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        let heartbeat: ReturnType<typeof setTimeout> | undefined;
        const send = (chunk: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            cleanup();
          }
        };
        const beat = () => {
          clearTimeout(heartbeat);
          heartbeat = setTimeout(() => {
            send(': heartbeat\n\n');
            beat();
          }, heartbeatMs);
        };
        const unsubscribe = channel.subscribe(event => {
          send(`data: ${JSON.stringify(toWireEvent(event))}\n\n`);
          beat();
        });
        cleanup = () => {
          if (closed) return;
          closed = true;
          clearTimeout(heartbeat);
          unsubscribe();
          try {
            controller.close();
          } catch {
            // Already closed by the client.
          }
        };
        send(`data: ${JSON.stringify(toWireEvent({ type: 'display_state_changed', displayState: channel.displayState() }))}\n\n`);
        beat();
        c.req.raw.signal?.addEventListener('abort', () => cleanup(), { once: true });
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
    });
  }

  async #threads(c: Context, channel: ClaudeSessionUiChannel): Promise<Response> {
    await channel.ready;
    const thread = await (await channel.memory()).getThreadById({ threadId: channel.threadId });
    if (!thread) return c.json({ threads: [] });
    const updatedAt = thread.updatedAt instanceof Date ? thread.updatedAt : new Date(thread.updatedAt);
    return c.json({
      threads: [
        {
          id: thread.id,
          title: thread.title,
          updatedAt: Number.isNaN(updatedAt.getTime()) ? undefined : updatedAt.toISOString(),
          state: channel.running ? 'active' : 'idle',
        },
      ],
    });
  }

  async #messages(c: Context, channel: ClaudeSessionUiChannel, threadId: string): Promise<Response> {
    await channel.flushed();
    const memory = await channel.memory();
    const thread = await memory.getThreadById({ threadId });
    if (!thread || (thread.resourceId && thread.resourceId !== channel.resourceId)) {
      return c.json({ error: 'Thread not found' }, 404);
    }
    const { legacy, ...options } = listOptions(c);
    const result = await memory.listMessages({ threadId, resourceId: channel.resourceId, ...options });
    const messages = legacy ? [...result.messages].reverse() : result.messages;
    return c.json({ ...result, messages: messages.map(wireMessage) });
  }

  async #appendActiveRuns(c: Context): Promise<void> {
    const runs = [...this.#channels.values()].flatMap(channel => {
      const runId = channel.session.runId;
      return channel.running && runId ? [{ runId, resourceId: channel.resourceId, threadId: channel.threadId }] : [];
    });
    if (runs.length === 0 || !c.res.ok) return;
    const body = (await c.res
      .clone()
      .json()
      .catch(() => undefined)) as { runs?: unknown[] } | undefined;
    if (!body || !Array.isArray(body.runs)) return;
    const headers = new Headers(c.res.headers);
    headers.delete('content-length');
    c.res = new Response(JSON.stringify({ ...body, runs: [...body.runs, ...runs] }), { status: c.res.status, headers });
  }
}

export function createClaudeSessionUi(options: ClaudeSessionUiOptions): ClaudeSessionUi {
  return new ClaudeSessionUi(options);
}
