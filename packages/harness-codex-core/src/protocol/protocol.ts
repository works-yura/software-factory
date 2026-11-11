// Line-delimited JSON-RPC with the app-server: our requests and notifications out, its responses,
// notifications and requests in. One instance per connection; it ends once, for good, when the input
// ends, a read or write fails, or the caller closes it, and fails every request still waiting.
import type { Readable, Writable } from 'node:stream';

import {
  CodexAppServerInputStreamEndedError,
  CodexAppServerProtocolParseError,
  CodexAppServerRequestError,
  CodexAppServerTransportError,
  type CodexAppServerError,
} from './errors.ts';

const MAX_ACTIVE_REQUEST_HANDLERS = 32;
// Bound JSONL lines before joining and parsing; the LF delimiter is excluded.
const MAX_INCOMING_MESSAGE_BYTES = 128 * 1024 * 1024;
const EXIT_STATUS_GRACE_MS = 250;

export type JsonRpcId = string | number;

export interface CodexAppServerProtocolLogEvent {
  readonly direction: 'incoming' | 'outgoing';
  readonly stage: 'decoded' | 'decode_failed';
  readonly payload: unknown;
}

export interface CodexAppServerIncomingNotification {
  readonly method: string;
  readonly params?: unknown;
}

export interface CodexAppServerIncomingRequest {
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface CodexAppServerProtocolOptions {
  /** The peer's output (the app-server's stdout). */
  readonly input: Readable;
  /** The peer's input (the app-server's stdin). */
  readonly output: Writable;
  /** Why the peer went away once its output ended, e.g. the process's exit status. */
  readonly terminationError?: () => Promise<CodexAppServerError>;
  readonly maxIncomingMessageBytes?: number;
  readonly logger?: (event: CodexAppServerProtocolLogEvent) => void;
  readonly onNotification?: (notification: CodexAppServerIncomingNotification) => void;
  /** Answers a request from the peer; a thrown error goes back as a JSON-RPC error. */
  readonly onRequest?: (request: CodexAppServerIncomingRequest) => Promise<unknown>;
  readonly onTermination?: (error: CodexAppServerError) => void;
}

interface PendingRequest {
  readonly method: string;
  resolve(value: unknown): void;
  reject(error: CodexAppServerError): void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || typeof value === 'number';
}

function isIncomingRequest(value: unknown): value is CodexAppServerIncomingRequest {
  return isObject(value) && typeof value.method === 'string' && isJsonRpcId(value.id);
}

function isIncomingNotification(value: unknown): value is CodexAppServerIncomingNotification {
  return isObject(value) && typeof value.method === 'string' && !('id' in value);
}

interface ResponseEnvelope {
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function isIncomingResponse(value: unknown): value is ResponseEnvelope {
  if (!isObject(value) || !isJsonRpcId(value.id) || 'method' in value) return false;
  const error = value.error;
  return (
    error === undefined ||
    (isObject(error) && typeof error.code === 'number' && typeof error.message === 'string')
  );
}

export class CodexAppServerProtocol {
  readonly #options: CodexAppServerProtocolOptions;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #maxIncomingMessageBytes: number;
  #nextRequestId = 1;
  #remainder: string[] = [];
  #remainderBytes = 0;
  #activeRequestHandlers = 0;
  /** Requests the peer settled itself (`serverRequest/resolved`): their answers are no longer sent. */
  readonly #resolvedRequests = new Set<string>();
  #terminated: CodexAppServerError | undefined;
  readonly #terminatedListeners = new Set<(error: CodexAppServerError) => void>();

  constructor(options: CodexAppServerProtocolOptions) {
    this.#options = options;
    this.#maxIncomingMessageBytes = options.maxIncomingMessageBytes ?? MAX_INCOMING_MESSAGE_BYTES;
    options.input.setEncoding('utf8');
    options.input.on('data', (chunk: string) => this.#onChunk(chunk));
    options.input.on('end', () => this.#onInputEnd());
    options.input.on('error', cause => this.#terminate(new CodexAppServerTransportError({ operation: 'read-input-stream', cause })));
    options.output.on('error', cause =>
      this.#terminate(new CodexAppServerTransportError({ operation: 'write-output-stream', cause })),
    );
  }

  /** Why the connection ended, once it did. */
  get termination(): CodexAppServerError | undefined {
    return this.#terminated;
  }

  /** Called once the connection ends (at once when it already has). */
  onTerminated(listener: (error: CodexAppServerError) => void): () => void {
    if (this.#terminated) {
      listener(this.#terminated);
      return () => {};
    }
    this.#terminatedListeners.add(listener);
    return () => this.#terminatedListeners.delete(listener);
  }

  request(method: string, payload?: unknown): Promise<unknown> {
    if (this.#terminated) return Promise.reject(this.#terminated);
    const requestId = this.#nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(String(requestId), { method, resolve, reject });
      try {
        this.#write({ id: requestId, method, ...(payload !== undefined ? { params: payload } : {}) });
      } catch (error) {
        this.#pending.delete(String(requestId));
        reject(error as CodexAppServerError);
      }
    });
  }

  notify(method: string, payload?: unknown): void {
    this.#write({ method, ...(payload !== undefined ? { params: payload } : {}) });
  }

  respond(requestId: JsonRpcId, result: unknown): void {
    if (this.#resolvedRequests.delete(String(requestId))) return;
    this.#write({ id: requestId, ...(result !== undefined ? { result } : {}) });
  }

  respondError(requestId: JsonRpcId, error: CodexAppServerRequestError): void {
    if (this.#resolvedRequests.delete(String(requestId))) return;
    this.#write({ id: requestId, error: error.toProtocolError() });
  }

  /** Ends the connection from this side: waiting requests fail with `error`. */
  close(error: CodexAppServerError = new CodexAppServerInputStreamEndedError()): void {
    this.#terminate(error);
  }

  #log(event: CodexAppServerProtocolLogEvent) {
    try {
      this.#options.logger?.(event);
    } catch {
      // A logger never breaks the connection.
    }
  }

  #write(message: Record<string, unknown>) {
    if (this.#terminated) throw this.#terminated;
    this.#log({ direction: 'outgoing', stage: 'decoded', payload: message });
    let encoded: string;
    try {
      encoded = `${JSON.stringify(message)}\n`;
    } catch (cause) {
      throw new CodexAppServerProtocolParseError({
        operation: 'encode-wire-message',
        ...(typeof message.method === 'string' ? { method: message.method } : {}),
        cause,
      });
    }
    this.#options.output.write(encoded);
  }

  #onChunk(chunk: string) {
    if (this.#terminated) return;
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf('\n', start);
      const fragment = chunk.slice(start, newline === -1 ? chunk.length : newline);
      this.#remainderBytes += Buffer.byteLength(fragment, 'utf8');
      if (this.#remainderBytes > this.#maxIncomingMessageBytes) {
        this.#remainder = [];
        this.#terminate(
          new CodexAppServerTransportError({
            operation: 'read-input-stream',
            cause: new Error(`Incoming message exceeded ${this.#maxIncomingMessageBytes} bytes.`),
          }),
        );
        return;
      }
      this.#remainder.push(fragment);
      if (newline === -1) break;
      const line = this.#remainder.join('').replace(/\r$/, '');
      this.#remainder = [];
      this.#remainderBytes = 0;
      this.#handleLine(line);
      start = newline + 1;
    }
  }

  #onInputEnd() {
    const line = this.#remainder.join('');
    this.#remainder = [];
    if (line.trim()) this.#handleLine(line);
    if (this.#terminated) return;
    const ended = new CodexAppServerInputStreamEndedError();
    const classify = this.#options.terminationError;
    if (!classify) {
      this.#terminate(ended);
      return;
    }
    // Node ends stdout before it reports a crashed process's exit, so wait briefly for its status;
    // stdout can also close while the process keeps running, so the wait must not hang.
    const timer = setTimeout(() => this.#terminate(ended), EXIT_STATUS_GRACE_MS);
    classify().then(
      error => {
        clearTimeout(timer);
        this.#terminate(error);
      },
      () => {
        clearTimeout(timer);
        this.#terminate(ended);
      },
    );
  }

  #handleLine(line: string) {
    if (!line.trim() || this.#terminated) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch (cause) {
      this.#log({ direction: 'incoming', stage: 'decode_failed', payload: { operation: 'decode-wire-message' } });
      this.#terminate(new CodexAppServerProtocolParseError({ operation: 'decode-wire-message', cause }));
      return;
    }
    this.#log({ direction: 'incoming', stage: 'decoded', payload: decoded });
    if (isIncomingRequest(decoded)) this.#handleRequest(decoded);
    else if (isIncomingNotification(decoded)) this.#handleNotification(decoded);
    else if (isIncomingResponse(decoded)) this.#handleResponse(decoded);
    else this.#terminate(CodexAppServerProtocolParseError.fromUnroutableMessage(decoded));
  }

  #handleResponse(response: ResponseEnvelope) {
    const requestId = String(response.id);
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    if (response.error !== undefined) {
      pending.reject(CodexAppServerRequestError.fromProtocolError(response.error, pending.method, requestId));
    } else {
      pending.resolve(response.result);
    }
  }

  #handleRequest(request: CodexAppServerIncomingRequest) {
    const handler = this.#options.onRequest;
    if (!handler) {
      this.respondError(request.id, CodexAppServerRequestError.methodNotFound(request.method));
      return;
    }
    if (this.#activeRequestHandlers >= MAX_ACTIVE_REQUEST_HANDLERS) {
      this.respondError(request.id, CodexAppServerRequestError.overloaded('Too many Codex requests are already active.'));
      return;
    }
    this.#activeRequestHandlers += 1;
    void Promise.resolve()
      .then(() => handler(request))
      .then(
        result => {
          if (!this.#terminated) this.respond(request.id, result);
        },
        error => {
          if (!this.#terminated) this.respondError(request.id, CodexAppServerRequestError.fromAppServerError(error, request.method));
        },
      )
      .catch(error => this.#terminate(error as CodexAppServerError))
      .finally(() => {
        this.#activeRequestHandlers = Math.max(0, this.#activeRequestHandlers - 1);
      });
  }

  #handleNotification(notification: CodexAppServerIncomingNotification) {
    // Codex settles requests itself when their turn ends; an answer that comes later is dropped.
    if (notification.method === 'serverRequest/resolved' && isObject(notification.params)) {
      const requestId = notification.params.requestId;
      if (isJsonRpcId(requestId)) this.#resolvedRequests.add(String(requestId));
    }
    try {
      this.#options.onNotification?.(notification);
    } catch (error) {
      console.warn('[codex harness] Notification handler failed.', error);
    }
  }

  #terminate(error: CodexAppServerError) {
    if (this.#terminated) return;
    this.#terminated = error;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const request of pending) request.reject(error);
    try {
      this.#options.output.end();
    } catch {
      // Already closed.
    }
    this.#options.onTermination?.(error);
    for (const listener of [...this.#terminatedListeners]) listener(error);
    this.#terminatedListeners.clear();
  }
}
