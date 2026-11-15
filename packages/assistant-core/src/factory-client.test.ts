/**
 * The MCP {@link FactoryClient} against a stand-in Factory: the discovery document, a real MCP
 * server (Streamable HTTP, stateless, as Factory serves it) with the three tools the assistant
 * calls, and the attachment upload route. Every call must carry the person's bearer token and
 * name their organization.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { answerFromThread, McpFactoryClient } from './factory-client.ts';
import type { AssistantOwner } from './types.ts';

const ORIGIN = 'http://factory.test';
const ADA: AssistantOwner = { orgId: 'org-a', userId: 'ada' };

let seen: Array<{ path: string; authorization: string | undefined; org: string | undefined }>;
let uploads: Array<{ workItemId: string; name: string; type: string | undefined; size: number }>;
let started: Array<{ prompt: string; title?: string }>;
let threadItems: Array<Record<string, unknown>>;
let client: McpFactoryClient;

function mcpServer() {
  const server = new McpServer({ name: 'Factory', version: '1.0.0' });
  server.registerTool(
    'factory_start_session',
    { inputSchema: { prompt: z.string(), title: z.string().optional() } },
    async input => {
      started.push(input);
      return { content: [{ type: 'text', text: JSON.stringify({ mode: 'side', sessionId: 'side-1', threadId: 'side-1' }) }] };
    },
  );
  server.registerTool(
    'factory_thread_read',
    { inputSchema: { threadId: z.string(), view: z.string().optional(), limit: z.number().optional(), afterPosition: z.number().optional() } },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify({ thread: { threadId: 'side-1', title: 't', itemCount: threadItems.length }, items: threadItems, nextPosition: null, hasMore: false }) }],
    }),
  );
  server.registerTool(
    'factory_create_work_item',
    { inputSchema: { title: z.string(), description: z.string() } },
    async input => {
      if (input.title === 'viewer') return { isError: true, content: [{ type: 'text', text: 'Your role cannot file work items.' }] };
      return { content: [{ type: 'text', text: JSON.stringify({ id: 'card-1', number: 7, title: input.title, stage: 'triage' }) }] };
    },
  );
  return server;
}

beforeEach(() => {
  seen = [];
  uploads = [];
  started = [];
  threadItems = [];
  const app = new Hono();
  app.use('*', async (c, next) => {
    seen.push({ path: c.req.path, authorization: c.req.header('authorization'), org: c.req.header('x-mastra-organization-id') });
    if (c.req.header('authorization') !== 'Bearer token-ada') return c.json({ error: 'unauthorized' }, 401);
    return next();
  });
  app.get('/web/factory/mcp', c =>
    c.json({ factories: [{ id: 'f-1', name: 'Shop', mcpUrl: `${ORIGIN}/web/factory/projects/f-1/mcp` }] }),
  );
  app.all('/web/factory/projects/:id/mcp', async c => {
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await mcpServer().connect(transport);
    return transport.handleRequest(c.req.raw);
  });
  app.post('/web/factory/work-items/:id/attachments', async c => {
    const body = new Uint8Array(await c.req.arrayBuffer());
    uploads.push({ workItemId: c.req.param('id'), name: c.req.query('name')!, type: c.req.header('content-type'), size: body.length });
    return c.json({ attachment: { id: 'att-1' } }, 201);
  });
  client = new McpFactoryClient({
    publicOrigin: ORIGIN,
    accessToken: async () => 'token-ada',
    connected: async () => true,
    fetch: ((input: string | URL | Request, init?: RequestInit) => app.request(input instanceof Request ? input : String(input), init)) as typeof fetch,
  });
});

describe('Factory over MCP, as the person', () => {
  it('lists the person’s Factories from the discovery document', async () => {
    expect(await client.listFactories(ADA)).toEqual([{ id: 'f-1', name: 'Shop' }]);
    expect(seen[0]).toEqual({ path: '/web/factory/mcp', authorization: 'Bearer token-ada', org: 'org-a' });
  });

  it('asks in a side session and reads its answer once its agent is done', async () => {
    expect(await client.ask(ADA, { factoryId: 'f-1', question: 'Why?', title: 'Checkout' })).toEqual({
      sessionId: 'side-1',
      url: '/factories/f-1/workspaces/side-1',
    });
    expect(started).toEqual([{ prompt: 'Why?', title: 'Checkout' }]);
    expect(seen.every(call => call.authorization === 'Bearer token-ada' && call.org === 'org-a')).toBe(true);

    threadItems = [{ type: 'user_message', status: 'completed', text: 'Why?' }, { type: 'assistant_message', status: 'running', text: 'Look' }];
    expect(await client.readAnswer(ADA, { factoryId: 'f-1', sessionId: 'side-1' })).toEqual({ text: null });
    threadItems = [
      { type: 'user_message', status: 'completed', text: 'Why?' },
      { type: 'assistant_message', status: 'completed', text: 'The key expired.' },
    ];
    expect(await client.readAnswer(ADA, { factoryId: 'f-1', sessionId: 'side-1' })).toEqual({ text: 'The key expired.' });
  });

  it('hands over: a card, then each file to its attachments with the same token', async () => {
    const handed = await client.handOver(ADA, {
      factoryId: 'f-1',
      title: 'Banner',
      description: 'Fix it',
      files: [{ name: 'shot.png', mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) }],
    });
    expect(handed).toEqual({ workItemId: 'card-1', url: '/factories/f-1/work?item=card-1', failedFiles: [] });
    expect(uploads).toEqual([{ workItemId: 'card-1', name: 'shot.png', type: 'image/png', size: 3 }]);
  });

  it('passes on what Factory refused, in its words', async () => {
    await expect(client.handOver(ADA, { factoryId: 'f-1', title: 'viewer', description: 'x', files: [] })).rejects.toThrow(
      'Your role cannot file work items.',
    );
    await expect(client.ask(ADA, { factoryId: 'missing', question: 'x', title: 'x' })).rejects.toThrow(/not one you can reach/);
  });
});

describe('answerFromThread', () => {
  it('takes the last agent message after the last question, once nothing runs', () => {
    expect(answerFromThread([])).toBeNull();
    expect(
      answerFromThread([
        { type: 'user_message', text: 'q1' },
        { type: 'assistant_message', status: 'completed', text: 'a1' },
        { type: 'user_message', text: 'q2' },
      ]),
    ).toBeNull();
    expect(
      answerFromThread([
        { type: 'user_message', text: 'q' },
        { type: 'assistant_message', status: 'completed', text: 'part' },
        { type: 'dynamic_tool', status: 'completed', text: null },
        { type: 'assistant_message', status: 'completed', text: 'final' },
      ]),
    ).toBe('final');
  });
});
