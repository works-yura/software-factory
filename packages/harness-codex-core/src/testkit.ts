// A fake `codex app-server` for tests: an in-process peer on a pair of streams that answers the
// client's requests from handlers, sends notifications and its own requests, and records what it got.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { CodexSpawn } from './protocol/client.ts';
import type { ClientRequestMethod, ClientRequests, ServerNotificationMethod, ServerNotifications, ServerRequestMethod, ServerRequests } from './protocol/schema.ts';

type Handler = (params: any, peer: FakeCodexAppServer) => unknown;

export interface FakeCodexAppServerMessage {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** What a default fake answers: a signed-in ChatGPT account and two models. */
export const FAKE_CODEX_MODELS: ClientRequests['model/list']['result'] = {
  data: [
    {
      id: 'gpt-test-sol',
      model: 'gpt-test-sol',
      displayName: 'GPT-Test-Sol',
      description: 'Workhorse',
      hidden: false,
      isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }],
      defaultReasoningEffort: 'low',
      serviceTiers: [
        { id: 'priority', name: 'Fast', description: '2x speed, increased usage' },
        { id: 'ultrafast', name: 'Ultrafast', description: 'Fastest' },
      ],
      defaultServiceTier: null,
    },
    {
      id: 'gpt-test-luna',
      model: 'gpt-test-luna',
      displayName: 'GPT-Test-Luna',
      description: 'Small',
      hidden: false,
      isDefault: false,
      supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
      defaultReasoningEffort: 'medium',
    },
  ],
  nextCursor: null,
};

/**
 * One fake app-server. Requests go to `on(method, handler)` handlers (the defaults answer
 * `initialize`, `account/read`, `model/list`, `thread/start`, `thread/resume`, `turn/start` and
 * `turn/interrupt`); `notify` and `request` speak as the server.
 */
export class FakeCodexAppServer extends EventEmitter {
  /** The client's side: what it reads (our output) and writes (our input). */
  readonly toClient = new PassThrough();
  readonly fromClient = new PassThrough();
  /** Every message the client sent, in order. */
  readonly received: FakeCodexAppServerMessage[] = [];
  readonly #handlers = new Map<string, Handler>();
  readonly #pending = new Map<string, (message: FakeCodexAppServerMessage) => void>();
  #nextRequestId = 10_000;
  #buffer = '';
  #threads = 0;
  #turns = 0;
  closed = false;

  constructor() {
    super();
    this.fromClient.setEncoding('utf8');
    this.fromClient.on('data', (chunk: string) => {
      this.#buffer += chunk;
      let newline: number;
      while ((newline = this.#buffer.indexOf('\n')) !== -1) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        if (line.trim()) this.#onMessage(JSON.parse(line) as FakeCodexAppServerMessage);
      }
    });
    this.handle('initialize', () => ({ userAgent: 'factory/0.166.0 (test)', codexHome: '/tmp/codex-home', platformFamily: 'unix', platformOs: 'macos' }));
    this.handle('account/read', () => ({ account: { type: 'chatgpt', email: null, planType: 'plus' }, requiresOpenaiAuth: true }));
    this.handle('model/list', () => FAKE_CODEX_MODELS);
    this.handle('thread/start', params => ({ thread: { id: `thread-${++this.#threads}`, cwd: params.cwd ?? '/' }, model: params.model ?? 'gpt-test-sol', cwd: params.cwd ?? '/' }));
    this.handle('thread/resume', params => ({ thread: { id: params.threadId, cwd: params.cwd ?? '/' }, model: params.model ?? 'gpt-test-sol', cwd: params.cwd ?? '/' }));
    this.handle('turn/start', () => ({ turn: { id: `turn-${++this.#turns}`, status: 'inProgress', items: [] } }));
    this.handle('turn/interrupt', () => ({}));
    this.handle('account/login/start', params => ({ type: params.type }));
  }

  /** Answers `method` (a client request) with what `handler` returns; a thrown error goes back as a JSON-RPC error. */
  handle<M extends ClientRequestMethod>(method: M | (string & {}), handler: (params: M extends ClientRequestMethod ? ClientRequests[M]['params'] : any, peer: FakeCodexAppServer) => unknown): this {
    this.#handlers.set(method, handler as Handler);
    return this;
  }

  /** Messages the client sent with this method. */
  requests(method: string): FakeCodexAppServerMessage[] {
    return this.received.filter(message => message.method === method);
  }

  notify<M extends ServerNotificationMethod>(method: M, params: ServerNotifications[M]): void;
  notify(method: string, params: unknown): void;
  notify(method: string, params: unknown): void {
    this.#write({ method, params });
  }

  /** Sends a request as the server and resolves with the client's answer. */
  request<M extends ServerRequestMethod>(method: M, params: ServerRequests[M]['params']): Promise<FakeCodexAppServerMessage> {
    const id = this.#nextRequestId++;
    return new Promise(resolve => {
      this.#pending.set(String(id), resolve);
      this.#write({ id, method, params });
    });
  }

  /** Ends the server's output, as a process that exits. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.toClient.end();
  }

  #write(message: FakeCodexAppServerMessage) {
    if (!this.closed) this.toClient.write(`${JSON.stringify(message)}\n`);
  }

  #onMessage(message: FakeCodexAppServerMessage) {
    this.received.push(message);
    this.emit('message', message);
    if (message.method === undefined && message.id !== undefined) {
      const resolve = this.#pending.get(String(message.id));
      this.#pending.delete(String(message.id));
      resolve?.(message);
      return;
    }
    if (message.method) this.emit(message.method, message.params);
    if (message.id === undefined || !message.method) return;
    const handler = this.#handlers.get(message.method);
    if (!handler) {
      this.#write({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
      return;
    }
    const id = message.id;
    void Promise.resolve()
      .then(() => handler(message.params, this))
      .then(
        result => this.#write({ id, result }),
        (error: unknown) =>
          this.#write({ id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }),
      );
  }
}

/**
 * A `spawn` that starts a fake app-server instead of `codex`: each call creates one with `setup`
 * applied and records it in `servers`, plus the command and arguments it was asked to run.
 */
export function fakeCodexSpawn(setup: (server: FakeCodexAppServer) => void = () => {}): CodexSpawn & {
  servers: FakeCodexAppServer[];
  calls: Array<{ command: string; args: string[]; cwd?: string; env?: Record<string, string | undefined> }>;
} {
  const servers: FakeCodexAppServer[] = [];
  const calls: Array<{ command: string; args: string[]; cwd?: string; env?: Record<string, string | undefined> }> = [];
  const spawn = ((command: string, args: string[], options: { cwd?: string | URL; env?: NodeJS.ProcessEnv }) => {
    const server = new FakeCodexAppServer();
    setup(server);
    servers.push(server);
    calls.push({ command, args, ...(typeof options.cwd === 'string' ? { cwd: options.cwd } : {}), ...(options.env ? { env: options.env } : {}) });
    const child = new EventEmitter() as ChildProcessWithoutNullStreams & EventEmitter;
    const stderr = new PassThrough();
    let exited = false;
    const exit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (exited) return;
      exited = true;
      server.close();
      stderr.end();
      setImmediate(() => child.emit('exit', code, signal));
    };
    Object.assign(child, {
      stdin: server.fromClient,
      stdout: server.toClient,
      stderr,
      pid: 4242 + servers.length,
      kill: (signal: NodeJS.Signals = 'SIGTERM') => {
        exit(null, signal);
        return true;
      },
    });
    server.once('exit', (code: number | null) => exit(code ?? 0, null));
    return child;
  }) as unknown as CodexSpawn;
  return Object.assign(spawn, { servers, calls });
}
