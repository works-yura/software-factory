import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { GATE_SERVER_SCRIPT, SUBMIT_PLAN_REPLY, SUBMIT_PLAN_TOOL_NAME } from './gate.ts';

/** Drives the gate server over stdio, one JSON-RPC message per line. */
function startServer() {
  const child = spawn(process.execPath, [GATE_SERVER_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
  const received: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      received.push(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
    for (const wake of waiters.splice(0)) wake();
  });
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const response = async (id: number): Promise<Record<string, unknown>> => {
    for (;;) {
      const found = received.find(message => message.id === id);
      if (found) return found;
      await new Promise<void>(resolve => waiters.push(resolve));
    }
  };
  const request = (id: number, method: string, params?: unknown) => {
    send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    return response(id);
  };
  const exited = new Promise<number | null>(resolve => child.on('close', code => resolve(code)));
  return { child, send, request, received, exited };
}

let server: ReturnType<typeof startServer> | undefined;

afterEach(() => {
  server?.child.kill();
  server = undefined;
});

describe('gate MCP server', () => {
  it('initializes, lists submit_plan and answers a call', async () => {
    server = startServer();

    const init = await server.request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: { roots: {} },
      clientInfo: { name: 'claude-code', version: '2.1.312' },
    });
    expect(init).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'factory-gate', version: '0.1.0' },
      },
    });
    server.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const list = (await server.request(2, 'tools/list', {})) as { result: { tools: Array<Record<string, unknown>> } };
    expect(list.result.tools).toHaveLength(1);
    expect(list.result.tools[0]).toMatchObject({
      name: SUBMIT_PLAN_TOOL_NAME,
      inputSchema: { type: 'object', required: ['plan'], properties: { plan: { type: 'string' }, title: { type: 'string' } } },
    });

    expect(
      await server.request(3, 'tools/call', { name: 'submit_plan', arguments: { plan: '1. Do it', title: 'Plan' } }),
    ).toEqual({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: SUBMIT_PLAN_REPLY }] } });

    // The notification got no answer: one response per request so far.
    expect(server.received.map(message => message.id)).toEqual([1, 2, 3]);

    server.child.stdin.end();
    expect(await server.exited).toBe(0);
  });

  it('answers an unknown protocol version with the newest one it supports', async () => {
    server = startServer();
    const init = (await server.request(1, 'initialize', { protocolVersion: '2099-01-01', capabilities: {} })) as {
      result: { protocolVersion: string };
    };
    expect(init.result.protocolVersion).toBe('2025-11-25');
  });

  it('reports bad calls and unknown methods', async () => {
    server = startServer();
    await server.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });

    expect(await server.request(2, 'tools/call', { name: 'submit_plan', arguments: { plan: ' ' } })).toMatchObject({
      result: { isError: true },
    });
    expect(await server.request(3, 'tools/call', { name: 'rm_rf', arguments: {} })).toMatchObject({
      error: { code: -32602 },
    });
    expect(await server.request(4, 'resources/list', {})).toMatchObject({ error: { code: -32601 } });
    expect(await server.request(5, 'ping')).toEqual({ jsonrpc: '2.0', id: 5, result: {} });
  });
});
