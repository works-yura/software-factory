// A small client over the `opencode serve` HTTP API (the routes the harness uses, as the CLI's own
// OpenAPI document at `/doc` names them) and its event stream (`GET /event`, server-sent events).
// Plain `fetch`: no SDK, so the harness depends on the wire format alone, which `minimumVersion`
// pins.

/** An event of the server's stream: `{ type, properties }`. */
export interface OpenCodeEvent {
  type: string;
  properties: Record<string, unknown>;
}

/** A model of a provider, as `GET /provider` lists it. */
export interface OpenCodeProviderModel {
  id: string;
  name?: string;
  status?: string;
  cost?: { input?: number; output?: number };
  variants?: Record<string, unknown>;
  limit?: { context?: number; output?: number };
  release_date?: string;
}

export interface OpenCodeProvider {
  id: string;
  name?: string;
  models: Record<string, OpenCodeProviderModel>;
}

export interface OpenCodeProviderList {
  all: OpenCodeProvider[];
  default?: Record<string, string>;
  connected?: string[];
}

/** A part of a prompt: text, as the harness sends it. */
export interface OpenCodeTextPartInput {
  type: 'text';
  text: string;
}

export interface OpenCodePromptInput {
  parts: OpenCodeTextPartInput[];
  model?: { providerID: string; modelID: string };
  /** The OpenCode agent the turn runs as (`build`, `plan`). */
  agent?: string;
  /** The turn's system prompt, ahead of OpenCode's own. */
  system?: string;
  /** The model's reasoning variant (`low`, `high`, …). */
  variant?: string;
}

export type OpenCodePermissionReply = 'once' | 'always' | 'reject';

export class OpenCodeHttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(operation: string, status: number, body: string) {
    super(`OpenCode ${operation} failed (${status})${body ? `: ${body.slice(0, 500)}` : ''}.`);
    this.name = 'OpenCodeHttpError';
    this.status = status;
    this.body = body;
  }
}

export interface OpenCodeClientOptions {
  baseUrl: string;
  /** The server's password (`OPENCODE_SERVER_PASSWORD`); sent as Basic auth. */
  password?: string;
  /** The directory every request acts in (the session's checkout). */
  directory: string;
  fetch?: typeof fetch;
}

/** The routes the harness uses, each acting in {@link OpenCodeClientOptions.directory}. */
export class OpenCodeClient {
  readonly #baseUrl: string;
  readonly #headers: Record<string, string>;
  readonly #directory: string;
  readonly #fetch: typeof fetch;

  constructor(options: OpenCodeClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#directory = options.directory;
    this.#fetch = options.fetch ?? fetch;
    this.#headers = options.password
      ? { authorization: `Basic ${Buffer.from(`opencode:${options.password}`, 'utf8').toString('base64')}` }
      : {};
  }

  #url(path: string): string {
    const url = new URL(`${this.#baseUrl}${path}`);
    url.searchParams.set('directory', this.#directory);
    return url.toString();
  }

  async #request(operation: string, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const response = await this.#fetch(this.#url(path), {
      method,
      headers: { ...this.#headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new OpenCodeHttpError(operation, response.status, await response.text().catch(() => ''));
    return response;
  }

  async #json<T>(operation: string, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.#request(operation, method, path, body, signal);
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  health(): Promise<{ healthy: boolean; version: string }> {
    return this.#json('global.health', 'GET', '/global/health');
  }

  createSession(input: { title?: string } = {}): Promise<{ id: string }> {
    return this.#json('session.create', 'POST', '/session', input);
  }

  /** The session (with the session that started it, for a subagent's), or `undefined` when this server's database does not have it. */
  async getSession(sessionId: string): Promise<{ id: string; parentID?: string } | undefined> {
    try {
      return await this.#json('session.get', 'GET', `/session/${encodeURIComponent(sessionId)}`);
    } catch (error) {
      if (error instanceof OpenCodeHttpError && (error.status === 404 || error.status === 400)) return undefined;
      throw error;
    }
  }

  /** Starts a turn; OpenCode answers at once and the turn's progress comes on the event stream. */
  async promptAsync(sessionId: string, input: OpenCodePromptInput): Promise<void> {
    await this.#request('session.prompt_async', 'POST', `/session/${encodeURIComponent(sessionId)}/prompt_async`, input);
  }

  async abort(sessionId: string): Promise<void> {
    await this.#request('session.abort', 'POST', `/session/${encodeURIComponent(sessionId)}/abort`);
  }

  async replyPermission(requestId: string, reply: OpenCodePermissionReply, message?: string): Promise<void> {
    await this.#request('permission.reply', 'POST', `/permission/${encodeURIComponent(requestId)}/reply`, { reply, ...(message ? { message } : {}) });
  }

  /** Each question's selected labels (or a person's own words), in the order asked. */
  async replyQuestion(requestId: string, answers: string[][]): Promise<void> {
    await this.#request('question.reply', 'POST', `/question/${encodeURIComponent(requestId)}/reply`, { answers });
  }

  async rejectQuestion(requestId: string): Promise<void> {
    await this.#request('question.reject', 'POST', `/question/${encodeURIComponent(requestId)}/reject`);
  }

  providers(signal?: AbortSignal): Promise<OpenCodeProviderList> {
    return this.#json('provider.list', 'GET', '/provider', undefined, signal);
  }

  /** The server's events until `signal` aborts or the server closes the stream. */
  async *events(signal: AbortSignal): AsyncGenerator<OpenCodeEvent> {
    const response = await this.#request('event.subscribe', 'GET', '/event', undefined, signal);
    if (!response.body) return;
    yield* parseServerSentEvents(response.body, signal);
  }
}

/** The JSON `data:` payloads of a server-sent event stream, one event per blank-line-separated block. */
export async function* parseServerSentEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<OpenCodeEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  try {
    while (!signal?.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(buffer.slice(boundary).match(/^\r?\n\r?\n/)![0].length + boundary);
        const data = block
          .split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data) {
          try {
            const event = JSON.parse(data) as OpenCodeEvent;
            if (event && typeof event.type === 'string') yield { type: event.type, properties: event.properties ?? {} };
          } catch {
            // Not an event of ours (a comment, a keep-alive): skipped.
          }
        }
        boundary = buffer.search(/\r?\n\r?\n/);
      }
    }
  } finally {
    reader.releaseLock();
    await body.cancel().catch(() => {});
  }
}
