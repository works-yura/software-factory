// A typed client over the protocol: our requests by method, handlers for the app-server's
// notifications and requests, and `spawnCodexAppServer` to start `codex app-server` and shake hands.
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import {
  CodexAppServerProcessExitedError,
  CodexAppServerRequestError,
  CodexAppServerSpawnError,
  type CodexAppServerError,
} from './errors.ts';
import {
  CodexAppServerProtocol,
  type CodexAppServerIncomingNotification,
  type CodexAppServerIncomingRequest,
  type CodexAppServerProtocolLogEvent,
} from './protocol.ts';
import type {
  ClientRequestMethod,
  ClientRequests,
  InitializeParams,
  InitializeResponse,
  ServerNotificationMethod,
  ServerNotifications,
  ServerRequestMethod,
  ServerRequests,
} from './schema.ts';

type NotificationHandler = (payload: unknown) => void;
type RequestHandler = (payload: unknown) => Promise<unknown>;

export interface CodexAppServerConnection {
  readonly input: Readable;
  readonly output: Writable;
  /** Why the peer went away once its output ended, e.g. the process's exit status. */
  readonly terminationError?: () => Promise<CodexAppServerError>;
}

export interface CodexAppServerClientOptions {
  readonly logger?: (event: CodexAppServerProtocolLogEvent) => void;
}

export class CodexAppServerClient {
  readonly #protocol: CodexAppServerProtocol;
  readonly #notificationHandlers = new Map<string, NotificationHandler[]>();
  readonly #requestHandlers = new Map<string, RequestHandler>();
  #unknownNotification: ((method: string, params: unknown) => void) | undefined;
  #unknownRequest: ((method: string, params: unknown) => Promise<unknown>) | undefined;

  constructor(connection: CodexAppServerConnection, options: CodexAppServerClientOptions = {}) {
    this.#protocol = new CodexAppServerProtocol({
      input: connection.input,
      output: connection.output,
      ...(connection.terminationError ? { terminationError: connection.terminationError } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
      onNotification: notification => this.#onNotification(notification),
      onRequest: request => this.#onRequest(request),
    });
  }

  get termination(): CodexAppServerError | undefined {
    return this.#protocol.termination;
  }

  onTerminated(listener: (error: CodexAppServerError) => void): () => void {
    return this.#protocol.onTerminated(listener);
  }

  request<M extends ClientRequestMethod>(method: M, payload: ClientRequests[M]['params']): Promise<ClientRequests[M]['result']> {
    return this.#protocol.request(method, payload) as Promise<ClientRequests[M]['result']>;
  }

  /** A method this client has no type for. */
  requestRaw(method: string, payload?: unknown): Promise<unknown> {
    return this.#protocol.request(method, payload);
  }

  notify(method: 'initialized' | (string & {}), payload?: unknown): void {
    this.#protocol.notify(method, payload);
  }

  handleServerNotification<M extends ServerNotificationMethod>(method: M, handler: (payload: ServerNotifications[M]) => void): () => void {
    const list = this.#notificationHandlers.get(method) ?? [];
    const entry = handler as NotificationHandler;
    list.push(entry);
    this.#notificationHandlers.set(method, list);
    return () => {
      const current = this.#notificationHandlers.get(method) ?? [];
      this.#notificationHandlers.set(
        method,
        current.filter(candidate => candidate !== entry),
      );
    };
  }

  handleServerRequest<M extends ServerRequestMethod>(
    method: M,
    handler: (payload: ServerRequests[M]['params']) => Promise<ServerRequests[M]['result']>,
  ): void {
    this.#requestHandlers.set(method, handler as RequestHandler);
  }

  handleUnknownServerNotification(handler: (method: string, params: unknown) => void): void {
    this.#unknownNotification = handler;
  }

  handleUnknownServerRequest(handler: (method: string, params: unknown) => Promise<unknown>): void {
    this.#unknownRequest = handler;
  }

  close(): void {
    this.#protocol.close();
  }

  #onNotification(notification: CodexAppServerIncomingNotification) {
    const handlers = this.#notificationHandlers.get(notification.method);
    if (!handlers?.length) {
      this.#unknownNotification?.(notification.method, notification.params);
      return;
    }
    for (const handler of [...handlers]) {
      try {
        handler(notification.params);
      } catch (error) {
        console.warn(`[codex harness] Handler for ${notification.method} failed.`, error);
      }
    }
  }

  async #onRequest(request: CodexAppServerIncomingRequest): Promise<unknown> {
    const handler = this.#requestHandlers.get(request.method);
    if (handler) return handler(request.params);
    if (this.#unknownRequest) return this.#unknownRequest(request.method, request.params);
    throw CodexAppServerRequestError.methodNotFound(request.method);
  }
}

/** The name and version the app-server sees this client as. */
export const CODEX_CLIENT_INFO = { name: 'factory', title: 'Factory', version: '0.1.0' } as const;

export function buildCodexInitializeParams(clientInfo: InitializeParams['clientInfo'] = CODEX_CLIENT_INFO): InitializeParams {
  return {
    clientInfo,
    capabilities: {
      experimentalApi: true,
      // The aggregated turn diff repeats every file change; the harness reads the items instead.
      optOutNotificationMethods: ['turn/diff/updated'],
    },
  };
}

export type CodexSpawn = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

export interface SpawnCodexAppServerInput {
  /** The CLI binary; `codex` on PATH by default. */
  readonly command?: string;
  /** Arguments after `app-server` (see `codexAppServerArgs`). */
  readonly args?: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly spawn?: CodexSpawn;
  readonly logger?: (event: CodexAppServerProtocolLogEvent) => void;
  readonly clientInfo?: InitializeParams['clientInfo'];
}

export interface CodexAppServerProcess {
  readonly client: CodexAppServerClient;
  readonly initialize: InitializeResponse;
  /** The CLI version from the user agent (`factory/0.166.0 (…)`). */
  readonly version: string | undefined;
  readonly pid: number | undefined;
  isAlive(): boolean;
  /** Ends the process: SIGTERM, then SIGKILL after a grace period. */
  terminate(): void;
  /** Resolves once the process exited. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const STDERR_TAIL_BYTES = 8 * 1024;
const FORCE_KILL_AFTER_MS = 2_000;

/** `codex-cli 0.159.0`, `0.160.0-alpha.1` or a client user agent's `name/0.166.0`. */
export function parseCodexVersion(userAgent: string): string | undefined {
  return /\/([^\s]+)/.exec(userAgent)?.[1];
}

/** Starts `codex app-server`, sends `initialize` and `initialized`, and returns the connected client. */
export async function spawnCodexAppServer(input: SpawnCodexAppServerInput): Promise<CodexAppServerProcess> {
  const command = input.command ?? 'codex';
  const args = ['app-server', ...(input.args ?? [])];
  const spawn = input.spawn ?? (nodeSpawn as CodexSpawn);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(command, args, { cwd: input.cwd, env: input.env as NodeJS.ProcessEnv, stdio: 'pipe' } as SpawnOptionsWithoutStdio);
  } catch (cause) {
    throw new CodexAppServerSpawnError({ command: `${command} app-server`, cause });
  }
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
  });
  let alive = true;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('exit', (code, signal) => {
      alive = false;
      resolve({ code, signal });
    });
  });
  const spawnFailed = new Promise<never>((_, reject) => {
    child.once('error', cause => {
      alive = false;
      reject(new CodexAppServerSpawnError({ command: `${command} app-server`, cause }));
    });
  });
  spawnFailed.catch(() => {});
  const client = new CodexAppServerClient(
    {
      input: child.stdout,
      output: child.stdin,
      terminationError: async () => {
        const { code } = await exited;
        const tail = stderr.trim();
        return new CodexAppServerProcessExitedError({ ...(code !== null ? { code } : {}), ...(tail ? { stderr: tail } : {}) });
      },
    },
    input.logger ? { logger: input.logger } : {},
  );
  let killTimer: NodeJS.Timeout | undefined;
  const terminate = () => {
    if (!alive) return;
    client.close();
    child.kill('SIGTERM');
    killTimer ??= setTimeout(() => {
      if (alive) child.kill('SIGKILL');
    }, FORCE_KILL_AFTER_MS);
    killTimer.unref?.();
  };
  void exited.then(() => {
    if (killTimer) clearTimeout(killTimer);
  });
  try {
    const initialize = await Promise.race([
      client.request('initialize', buildCodexInitializeParams(input.clientInfo)),
      spawnFailed,
    ]);
    client.notify('initialized');
    return {
      client,
      initialize,
      version: parseCodexVersion(initialize.userAgent),
      pid: child.pid,
      isAlive: () => alive,
      terminate,
      exited,
    };
  } catch (error) {
    terminate();
    throw error;
  }
}
