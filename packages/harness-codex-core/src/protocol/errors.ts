// The app-server protocol's errors. Each carries a `_tag` and its fields, so a caller switches on
// `_tag` and can send `{ _tag, ...fields, message }` over the wire.

export interface CodexAppServerProtocolErrorShape {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export type CodexAppServerProtocolParseOperation =
  | 'decode-wire-message'
  | 'encode-wire-message'
  | 'route-message'
  | 'decode-notification-payload';

export type CodexAppServerTransportOperation = 'read-input-stream' | 'write-output-stream';

abstract class TaggedCodexError<F extends object = object> extends Error {
  abstract readonly _tag: string;
  constructor(message: string, fields: F) {
    const cause = (fields as { cause?: unknown }).cause;
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    Object.assign(this, fields);
  }
}

export class CodexAppServerSpawnError extends TaggedCodexError<{ command?: string; cause?: unknown }> {
  readonly _tag = 'CodexAppServerSpawnError';
  declare readonly command?: string;
  constructor(fields: { command?: string; cause?: unknown }) {
    super(
      fields.command
        ? `Failed to spawn Codex App Server process for command: ${fields.command}`
        : 'Failed to spawn Codex App Server process',
      fields,
    );
  }
}

export class CodexAppServerProcessExitedError extends TaggedCodexError {
  readonly _tag = 'CodexAppServerProcessExitedError';
  declare readonly code?: number;
  declare readonly stderr?: string;
  constructor(fields: { code?: number; stderr?: string; cause?: unknown }) {
    const base =
      fields.code === undefined ? 'Codex App Server process exited' : `Codex App Server process exited with code ${fields.code}`;
    super(fields.stderr ? `${base}: ${fields.stderr}` : base, fields);
  }
}

export class CodexAppServerProtocolParseError extends TaggedCodexError {
  readonly _tag = 'CodexAppServerProtocolParseError';
  declare readonly operation: CodexAppServerProtocolParseOperation;
  declare readonly method?: string;
  declare readonly requestId?: string;
  constructor(fields: { operation: CodexAppServerProtocolParseOperation; method?: string; requestId?: string; cause?: unknown }) {
    const method = fields.method === undefined ? '' : ` for method '${fields.method}'`;
    super(`Codex App Server protocol ${fields.operation} failed${method}.`, fields);
  }

  static fromUnroutableMessage(message: unknown): CodexAppServerProtocolParseError {
    return new CodexAppServerProtocolParseError({ operation: 'route-message', cause: message });
  }
}

export class CodexAppServerTransportError extends TaggedCodexError {
  readonly _tag = 'CodexAppServerTransportError';
  declare readonly operation: CodexAppServerTransportOperation;
  constructor(fields: { operation: CodexAppServerTransportOperation; cause?: unknown }) {
    super(`Codex App Server transport operation '${fields.operation}' failed.`, fields);
  }
}

export class CodexAppServerInputStreamEndedError extends TaggedCodexError {
  readonly _tag = 'CodexAppServerInputStreamEndedError';
  constructor() {
    super('Codex App Server input stream ended.', {});
  }
}

interface RequestErrorFields {
  code: number;
  errorMessage: string;
  data?: unknown;
  method?: string;
  requestId?: string;
  cause?: unknown;
}

export class CodexAppServerRequestError extends TaggedCodexError<RequestErrorFields> {
  readonly _tag = 'CodexAppServerRequestError';
  declare readonly code: number;
  declare readonly errorMessage: string;
  declare readonly data?: unknown;
  declare readonly method?: string;
  declare readonly requestId?: string;
  constructor(fields: RequestErrorFields) {
    super(fields.errorMessage, fields);
  }

  static fromProtocolError(error: CodexAppServerProtocolErrorShape, method: string, requestId: string): CodexAppServerRequestError {
    return new CodexAppServerRequestError({
      code: error.code,
      errorMessage: error.message,
      ...(error.data !== undefined ? { data: error.data } : {}),
      method,
      requestId,
      cause: error,
    });
  }

  static fromAppServerError(error: unknown, method: string): CodexAppServerRequestError {
    if (error instanceof CodexAppServerRequestError) return error;
    return CodexAppServerRequestError.internalError(`Codex App Server request handler failed for method '${method}'`, undefined, {
      method,
      cause: error,
    });
  }

  static methodNotFound(method: string): CodexAppServerRequestError {
    return new CodexAppServerRequestError({ code: -32601, errorMessage: `Method not found: ${method}` });
  }

  static internalError(
    message = 'Internal error',
    data?: unknown,
    diagnostics: { method?: string; cause?: unknown } = {},
  ): CodexAppServerRequestError {
    return new CodexAppServerRequestError({
      code: -32603,
      errorMessage: message,
      ...(data !== undefined ? { data } : {}),
      ...diagnostics,
    });
  }

  static overloaded(message = 'Server overloaded; retry later.', data?: unknown): CodexAppServerRequestError {
    return new CodexAppServerRequestError({ code: -32001, errorMessage: message, ...(data !== undefined ? { data } : {}) });
  }

  toProtocolError(): CodexAppServerProtocolErrorShape {
    return { code: this.code, message: this.errorMessage, ...(this.data !== undefined ? { data: this.data } : {}) };
  }
}

export type CodexAppServerError =
  | CodexAppServerRequestError
  | CodexAppServerSpawnError
  | CodexAppServerProcessExitedError
  | CodexAppServerProtocolParseError
  | CodexAppServerTransportError
  | CodexAppServerInputStreamEndedError;

export function isCodexAppServerError(error: unknown): error is CodexAppServerError {
  return (
    error instanceof CodexAppServerRequestError ||
    error instanceof CodexAppServerSpawnError ||
    error instanceof CodexAppServerProcessExitedError ||
    error instanceof CodexAppServerProtocolParseError ||
    error instanceof CodexAppServerTransportError ||
    error instanceof CodexAppServerInputStreamEndedError
  );
}
