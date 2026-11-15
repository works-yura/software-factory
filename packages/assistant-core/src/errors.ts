/** A refusal the routes turn into an HTTP answer: a code, a message for the person, a status. */
export class AssistantError extends Error {
  readonly code: string;
  readonly status: 400 | 403 | 404 | 409 | 413 | 502 | 503;
  constructor(code: string, message: string, status: AssistantError['status']) {
    super(message);
    this.name = 'AssistantError';
    this.code = code;
    this.status = status;
  }
}
