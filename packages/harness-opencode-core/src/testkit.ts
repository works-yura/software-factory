// A stand-in for `opencode serve` in tests: an HTTP server with the routes the harness uses and an
// event stream the test scripts, plus a spawn that "starts" it (prints where it listens). Each
// prompt is handed to the test's `onPrompt`, which emits the turn's events.
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { OpenCodeEvent, OpenCodePromptInput, OpenCodeProviderList } from './client.ts';
import type { OpenCodeSpawn } from './server.ts';

export interface FakePrompt {
  sessionId: string;
  input: OpenCodePromptInput;
}

export interface FakeOpenCode {
  readonly url: string;
  readonly prompts: FakePrompt[];
  readonly permissionReplies: Array<{ requestId: string; reply: string }>;
  readonly questionReplies: Array<{ requestId: string; answers?: string[][]; rejected?: true }>;
  readonly aborts: string[];
  readonly spawns: Array<{ command: string; args: string[]; env: Record<string, string> }>;
  /** Sessions the fake knows; a test deletes one to make a resume fail. */
  readonly sessions: Set<string>;
  /** Called for every prompt; emit the turn's events with `emit`. */
  onPrompt: (prompt: FakePrompt, fake: FakeOpenCode) => void;
  onPermissionReply: (reply: { requestId: string; reply: string }, fake: FakeOpenCode) => void;
  onQuestionReply: (reply: { requestId: string; answers?: string[][]; rejected?: true }, fake: FakeOpenCode) => void;
  providers: OpenCodeProviderList;
  emit(event: OpenCodeEvent): void;
  /** Emits a text part (started, streamed, ended) and returns its id. */
  say(sessionId: string, text: string, messageId?: string): void;
  idle(sessionId: string): void;
  spawn: OpenCodeSpawn;
  /** Live fake processes (one per spawn that was not stopped). */
  readonly alive: () => number;
  close(): Promise<void>;
}

let counter = 0;
const id = (prefix: string) => `${prefix}_${(counter += 1).toString().padStart(6, '0')}`;

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

export async function startFakeOpenCode(): Promise<FakeOpenCode> {
  const streams = new Set<ServerResponse>();
  const children = new Set<EventEmitter>();
  const fake: FakeOpenCode = {
    url: '',
    prompts: [],
    permissionReplies: [],
    questionReplies: [],
    aborts: [],
    spawns: [],
    sessions: new Set(),
    onPrompt: () => {},
    onPermissionReply: () => {},
    onQuestionReply: () => {},
    providers: { all: [] },
    emit(event) {
      const data = `data: ${JSON.stringify({ id: id('evt'), ...event })}\n\n`;
      for (const stream of streams) stream.write(data);
    },
    say(sessionId, text, messageId = id('msg')) {
      const partId = id('prt');
      fake.emit({ type: 'message.updated', properties: { sessionID: sessionId, info: { id: messageId, role: 'assistant', sessionID: sessionId } } });
      fake.emit({ type: 'message.part.updated', properties: { sessionID: sessionId, part: { id: partId, messageID: messageId, sessionID: sessionId, type: 'text', text: '', time: { start: 1 } } } });
      fake.emit({ type: 'message.part.delta', properties: { sessionID: sessionId, messageID: messageId, partID: partId, field: 'text', delta: text } });
      fake.emit({ type: 'message.part.updated', properties: { sessionID: sessionId, part: { id: partId, messageID: messageId, sessionID: sessionId, type: 'text', text, time: { start: 1, end: 2 } } } });
    },
    idle(sessionId) {
      fake.emit({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } });
      fake.emit({ type: 'session.idle', properties: { sessionID: sessionId } });
    },
    spawn: undefined as unknown as OpenCodeSpawn,
    alive: () => children.size,
    close: async () => {
      for (const stream of streams) stream.end();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const json = (status: number, value?: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(value === undefined ? '' : JSON.stringify(value));
    };
    if (request.method === 'GET' && path === '/global/health') return json(200, { healthy: true, version: '1.19.5' });
    if (request.method === 'GET' && path === '/provider') return json(200, fake.providers);
    if (request.method === 'GET' && path === '/event') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      streams.add(response);
      request.on('close', () => streams.delete(response));
      response.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`);
      return;
    }
    if (request.method === 'POST' && path === '/session') {
      const sessionId = id('ses');
      fake.sessions.add(sessionId);
      return json(200, { id: sessionId });
    }
    let match = /^\/session\/([^/]+)$/.exec(path);
    if (request.method === 'GET' && match) return fake.sessions.has(match[1]!) ? json(200, { id: match[1] }) : json(404, { name: 'NotFoundError' });
    match = /^\/session\/([^/]+)\/prompt_async$/.exec(path);
    if (request.method === 'POST' && match) {
      const prompt = { sessionId: match[1]!, input: (await body(request)) as OpenCodePromptInput };
      fake.prompts.push(prompt);
      json(204);
      setImmediate(() => fake.onPrompt(prompt, fake));
      return;
    }
    match = /^\/session\/([^/]+)\/abort$/.exec(path);
    if (request.method === 'POST' && match) {
      fake.aborts.push(match[1]!);
      json(200, true);
      setImmediate(() => fake.idle(match![1]!));
      return;
    }
    match = /^\/permission\/([^/]+)\/reply$/.exec(path);
    if (request.method === 'POST' && match) {
      const reply = { requestId: match[1]!, reply: ((await body(request)) as { reply: string }).reply };
      fake.permissionReplies.push(reply);
      json(200, true);
      setImmediate(() => fake.onPermissionReply(reply, fake));
      return;
    }
    match = /^\/question\/([^/]+)\/(reply|reject)$/.exec(path);
    if (request.method === 'POST' && match) {
      const reply = match[2] === 'reject' ? { requestId: match[1]!, rejected: true as const } : { requestId: match[1]!, answers: ((await body(request)) as { answers: string[][] }).answers };
      fake.questionReplies.push(reply);
      json(200, true);
      setImmediate(() => fake.onQuestionReply(reply, fake));
      return;
    }
    json(404, { error: `no route ${request.method} ${path}` });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  (fake as { url: string }).url = url;

  fake.spawn = (command, args, options) => {
    fake.spawns.push({ command, args, env: { ...(options.env as Record<string, string>) } });
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; pid: number; kill: (signal?: string) => boolean };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.pid = 0;
    children.add(child);
    let exited = false;
    child.kill = signal => {
      if (exited) return true;
      exited = true;
      children.delete(child);
      setImmediate(() => child.emit('exit', null, signal ?? 'SIGTERM'));
      return true;
    };
    setImmediate(() => child.stdout.write(`opencode server listening on ${url}\n`));
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return fake;
}
