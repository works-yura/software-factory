import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A scripted stand-in for the Anthropic Messages API, so the contract tests
 * drive the REAL `claude` CLI (its permission rules, tool aliases, MCP client,
 * `--resume`) without a model or a subscription. The CLI reaches it through
 * `ANTHROPIC_BASE_URL`; every answer comes from the test's script.
 */

export interface ModelContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export interface ModelMessage {
  /** `system` entries (environment notes, background-task notifications) sit between the turns. */
  role: 'user' | 'assistant' | 'system';
  content: string | ModelContentBlock[];
}

export interface ModelRequest {
  model: string;
  system?: string | Array<{ type: string; text: string }>;
  messages: ModelMessage[];
  tools?: Array<{ name: string }>;
  stream?: boolean;
}

/** What the scripted model answers: text, and at most one tool call. */
export type ModelReply = { text?: string; toolUse?: { name: string; input: Record<string, unknown> } };

export interface ToolResultSeen {
  toolUseId: string;
  text: string;
  isError: boolean;
}

/** Helpers over one request, for scripts and assertions. */
export class Turn {
  readonly request: ModelRequest;

  constructor(request: ModelRequest) {
    this.request = request;
  }

  get systemText(): string {
    const system = this.request.system;
    if (!system) return '';
    return typeof system === 'string' ? system : system.map(block => block.text).join('\n');
  }

  /** Every text the conversation's user messages carry, tool results left out. */
  get userText(): string {
    return this.request.messages
      .filter(message => message.role === 'user')
      .flatMap(message => blocks(message).filter(block => block.type === 'text').map(block => block.text ?? ''))
      .join('\n');
  }

  /** The conversation without the CLI's `system` entries. */
  get dialogue(): ModelMessage[] {
    return this.request.messages.filter(message => message.role !== 'system');
  }

  /** The tool results the last user message carries: the answers to the model's last calls. */
  get lastToolResults(): ToolResultSeen[] {
    const last = this.dialogue.at(-1);
    if (!last || last.role !== 'user') return [];
    return blocks(last)
      .filter(block => block.type === 'tool_result')
      .map(block => ({ toolUseId: block.tool_use_id ?? '', text: resultText(block.content), isError: block.is_error === true }));
  }

  /** Whether the last thing said was the model's (nothing new from a person or a tool since). */
  get modelSpokeLast(): boolean {
    return this.dialogue.at(-1)?.role === 'assistant';
  }

  /** The `system` entries after the model last spoke: notifications such as a background task finishing. */
  get notifications(): string[] {
    const messages = this.request.messages;
    let index = messages.length - 1;
    const notes: string[] = [];
    while (index >= 0 && messages[index]!.role === 'system') {
      notes.unshift(blocks(messages[index]!).map(block => block.text ?? '').join(''));
      index--;
    }
    return notes;
  }

  get toolNames(): string[] {
    return (this.request.tools ?? []).map(tool => tool.name);
  }

  /** The text of the last user message, when it is a message rather than tool results. */
  get lastUserText(): string {
    const last = this.dialogue.at(-1);
    if (!last || last.role !== 'user') return '';
    return blocks(last).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n');
  }

  /** The last thing a person (or the harness) wrote, however many tool calls came after it. */
  get lastPrompt(): string {
    for (const message of [...this.dialogue].reverse()) {
      if (message.role !== 'user') continue;
      const text = blocks(message).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n');
      if (text) return text;
    }
    return '';
  }

  has(marker: string): boolean {
    return this.userText.includes(marker);
  }
}

function blocks(message: ModelMessage): ModelContentBlock[] {
  return typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => (part && typeof part === 'object' && 'text' in part ? String(part.text) : '')).join('');
  }
  return '';
}

/** Requests one mock answers before it gives up: no scenario needs more. */
export const MAX_REQUESTS = 40;

export type ModelScript = (turn: Turn) => ModelReply;

export interface MockAnthropic {
  url: string;
  /** Every Messages request the CLI made, in order. */
  turns: Turn[];
  /** Swaps the script; requests made later follow the new one. */
  script(next: ModelScript): void;
  /** Answers the next requests with this HTTP status (e.g. 429) instead of the script. */
  failNext(status: number, body: Record<string, unknown>, count?: number, headers?: Record<string, string>): void;
  close(): Promise<void>;
}

export async function startMockAnthropic(initial: ModelScript): Promise<MockAnthropic> {
  let current = initial;
  const turns: Turn[] = [];
  const failures: Array<{ status: number; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  let ids = 0;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0];
      if (path === '/v1/messages/count_tokens') return json(res, 200, { input_tokens: 1 });
      if (path !== '/v1/messages') return json(res, 404, { type: 'error', error: { type: 'not_found_error', message: path } });
      const request = JSON.parse(raw || '{}') as ModelRequest;
      const failure = failures.shift();
      if (failure) {
        res.writeHead(failure.status, { 'content-type': 'application/json', ...failure.headers });
        return res.end(JSON.stringify(failure.body));
      }
      const turn = new Turn(request);
      turns.push(turn);
      let reply: ModelReply;
      try {
        // A runaway loop (the CLI retrying, a script that never ends) stops here, not at the heap limit.
        if (turns.length > MAX_REQUESTS) throw new Error(`more than ${MAX_REQUESTS} requests`);
        reply = current(turn);
      } catch (error) {
        reply = { text: `MOCK-SCRIPT-ERROR: ${(error as Error).message}` };
      }
      const toolUse = reply.toolUse ? { id: `toolu_mock${String(++ids).padStart(4, '0')}`, ...reply.toolUse } : undefined;
      const content: ModelContentBlock[] = [
        ...(reply.text ? [{ type: 'text', text: reply.text }] : []),
        ...(toolUse ? [{ type: 'tool_use', id: toolUse.id, name: toolUse.name, input: toolUse.input }] : []),
      ];
      if (!content.length) content.push({ type: 'text', text: '.' });
      const stopReason = toolUse ? 'tool_use' : 'end_turn';
      const message = { id: `msg_mock${ids}`, type: 'message', role: 'assistant', model: request.model, usage: { input_tokens: 1, output_tokens: 1 } };
      if (!request.stream) return json(res, 200, { ...message, content, stop_reason: stopReason });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const event = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      event('message_start', { message: { ...message, content: [], stop_reason: null } });
      content.forEach((block, index) => {
        if (block.type === 'text') {
          event('content_block_start', { index, content_block: { type: 'text', text: '' } });
          event('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
        } else {
          event('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
          event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
        }
        event('content_block_stop', { index });
      });
      event('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } });
      event('message_stop', {});
      res.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    turns,
    script(next) {
      current = next;
    },
    failNext(status, body, count = 1, headers = {}) {
      for (let i = 0; i < count; i++) failures.push({ status, body, headers });
    },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * The script most scenarios use: call `name` with `input`, then, once the call
 * has an answer, report it as `RESULT error=<bool>: <text>` and stop. A new
 * user message (a retry after a person's answer) calls the tool again.
 */
export function callToolThenReport(name: string, input: Record<string, unknown>): ModelScript {
  return turn => {
    const [result] = turn.lastToolResults;
    if (result) return { text: `RESULT error=${result.isError}: ${result.text}` };
    // Woken by a notification (a background task ended), not by a person: say what it was, call nothing.
    if (turn.modelSpokeLast) return { text: `NOTIFIED: ${turn.notifications.join('\n')}` };
    // A model that follows its instructions: a person's denial is final.
    if (/The person denied permission/.test(turn.lastUserText)) return { text: 'TOLD-DENIED' };
    return { toolUse: { name, input } };
  };
}
