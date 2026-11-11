import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { CodexAppServerClient, spawnCodexAppServer } from './client.ts';
import { CodexAppServerInputStreamEndedError, CodexAppServerProtocolParseError, CodexAppServerRequestError, CodexAppServerTransportError } from './errors.ts';
import { CodexAppServerProtocol } from './protocol.ts';
import { FakeCodexAppServer, fakeCodexSpawn } from '../testkit.ts';

function pair() {
  const toClient = new PassThrough();
  const fromClient = new PassThrough();
  const sent: unknown[] = [];
  fromClient.setEncoding('utf8');
  fromClient.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) if (line.trim()) sent.push(JSON.parse(line));
  });
  return { toClient, fromClient, sent };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

describe('CodexAppServerProtocol', () => {
  it('correlates responses, errors and notifications, and answers server requests', async () => {
    const { toClient, fromClient, sent } = pair();
    const notifications: unknown[] = [];
    const protocol = new CodexAppServerProtocol({
      input: toClient,
      output: fromClient,
      onNotification: notification => notifications.push(notification),
      onRequest: async request => ({ echoed: request.params }),
    });

    const first = protocol.request('model/list', {});
    const second = protocol.request('account/read', {});
    await tick();
    expect(sent).toEqual([
      { id: 1, method: 'model/list', params: {} },
      { id: 2, method: 'account/read', params: {} },
    ]);
    toClient.write('{"id":2,"error":{"code":-32600,"message":"nope"}}\n{"id":1,"res');
    toClient.write('ult":{"data":[]}}\n{"method":"turn/started","params":{"threadId":"t"}}\n');
    toClient.write('{"id":"srv-1","method":"item/tool/requestUserInput","params":{"q":1}}\n');
    await expect(first).resolves.toEqual({ data: [] });
    const error = await second.catch(caught => caught);
    expect(error).toBeInstanceOf(CodexAppServerRequestError);
    expect(error).toMatchObject({ _tag: 'CodexAppServerRequestError', code: -32600, method: 'account/read', requestId: '2' });
    await tick();
    await tick();
    expect(notifications).toEqual([{ method: 'turn/started', params: { threadId: 't' } }]);
    expect(sent.at(-1)).toEqual({ id: 'srv-1', result: { echoed: { q: 1 } } });
  });

  it('keeps processing messages while a server request waits for its answer', async () => {
    const { toClient, fromClient, sent } = pair();
    let release!: (value: unknown) => void;
    const notifications: string[] = [];
    new CodexAppServerProtocol({
      input: toClient,
      output: fromClient,
      onNotification: notification => notifications.push(notification.method),
      onRequest: () => new Promise(resolve => (release = resolve)),
    });
    toClient.write('{"id":7,"method":"item/commandExecution/requestApproval","params":{}}\n');
    toClient.write('{"method":"item/agentMessage/delta","params":{}}\n');
    await tick();
    expect(notifications).toEqual(['item/agentMessage/delta']);
    release({ decision: 'accept' });
    await tick();
    expect(sent).toEqual([{ id: 7, result: { decision: 'accept' } }]);
  });

  it('drops the answer to a request Codex already resolved itself', async () => {
    const { toClient, fromClient, sent } = pair();
    let release!: (value: unknown) => void;
    new CodexAppServerProtocol({
      input: toClient,
      output: fromClient,
      onRequest: () => new Promise(resolve => (release = resolve)),
    });
    toClient.write('{"id":7,"method":"item/commandExecution/requestApproval","params":{}}\n');
    toClient.write('{"method":"serverRequest/resolved","params":{"threadId":"t","requestId":7}}\n');
    await tick();
    release({ decision: 'accept' });
    await tick();
    expect(sent).toEqual([]);
  });

  it('answers a request it has no handler for with method not found', async () => {
    const { toClient, fromClient, sent } = pair();
    new CodexAppServerProtocol({ input: toClient, output: fromClient });
    toClient.write('{"id":3,"method":"unknown/thing"}\n');
    await tick();
    expect(sent).toEqual([{ id: 3, error: { code: -32601, message: 'Method not found: unknown/thing' } }]);
  });

  it('fails pending requests when the input ends while the process still runs', async () => {
    const { toClient, fromClient } = pair();
    const terminated: unknown[] = [];
    const protocol = new CodexAppServerProtocol({ input: toClient, output: fromClient, onTermination: error => terminated.push(error) });
    const pending = protocol.request('model/list', {});
    toClient.end();
    await expect(pending).rejects.toBeInstanceOf(CodexAppServerInputStreamEndedError);
    expect(terminated).toHaveLength(1);
    await expect(protocol.request('model/list', {})).rejects.toBeInstanceOf(CodexAppServerInputStreamEndedError);
  });

  it('reports a malformed line and an oversized message as terminal', async () => {
    const malformed = pair();
    const parse = new CodexAppServerProtocol({ input: malformed.toClient, output: malformed.fromClient });
    const pending = parse.request('model/list', {});
    malformed.toClient.write('{not json}\n');
    await expect(pending).rejects.toBeInstanceOf(CodexAppServerProtocolParseError);

    const large = pair();
    const bounded = new CodexAppServerProtocol({ input: large.toClient, output: large.fromClient, maxIncomingMessageBytes: 8 });
    const waiting = bounded.request('model/list', {});
    large.toClient.write('{"id":1,"result":{}}');
    await expect(waiting).rejects.toBeInstanceOf(CodexAppServerTransportError);
  });

  it('rejects incoming requests beyond the active handler limit', async () => {
    const { toClient, fromClient, sent } = pair();
    new CodexAppServerProtocol({ input: toClient, output: fromClient, onRequest: () => new Promise(() => {}) });
    for (let id = 1; id <= 33; id++) toClient.write(`${JSON.stringify({ id, method: 'item/tool/requestUserInput' })}\n`);
    await tick();
    await tick();
    expect(sent).toEqual([{ id: 33, error: { code: -32001, message: 'Too many Codex requests are already active.' } }]);
  });
});

describe('CodexAppServerClient', () => {
  it('routes typed notifications and server requests to their handlers', async () => {
    const server = new FakeCodexAppServer();
    const client = new CodexAppServerClient({ input: server.toClient, output: server.fromClient });
    const deltas: string[] = [];
    client.handleServerNotification('item/agentMessage/delta', payload => deltas.push(payload.delta));
    client.handleServerRequest('item/commandExecution/requestApproval', async payload => ({
      decision: payload.command === 'ls' ? 'accept' : 'decline',
    }));
    const unknown: string[] = [];
    client.handleUnknownServerNotification(method => unknown.push(method));

    await expect(client.request('model/list', {})).resolves.toMatchObject({ data: [{ model: 'gpt-test-sol' }, { model: 'gpt-test-luna' }] });
    server.notify('item/agentMessage/delta', { threadId: 't', turnId: 'u', itemId: 'i', delta: 'Hello' });
    server.notify('mcpServer/startupStatus/updated', {});
    const answer = await server.request('item/commandExecution/requestApproval', { threadId: 't', turnId: 'u', itemId: 'i', command: 'ls' });
    expect(answer.result).toEqual({ decision: 'accept' });
    expect(deltas).toEqual(['Hello']);
    expect(unknown).toEqual(['mcpServer/startupStatus/updated']);
  });

  it('spawns the app-server, shakes hands and reads the CLI version', async () => {
    const spawn = fakeCodexSpawn();
    const server = await spawnCodexAppServer({ command: '/usr/local/bin/codex', args: ['-c', 'x=1'], cwd: '/work', env: { PATH: '/bin' }, spawn });
    expect(spawn.calls).toEqual([{ command: '/usr/local/bin/codex', args: ['app-server', '-c', 'x=1'], cwd: '/work', env: { PATH: '/bin' } }]);
    expect(server.version).toBe('0.166.0');
    const fake = spawn.servers[0]!;
    expect(fake.received.map(message => message.method)).toEqual(['initialize', 'initialized']);
    expect(fake.requests('initialize')[0]!.params).toMatchObject({
      clientInfo: { name: 'factory' },
      capabilities: { experimentalApi: true, optOutNotificationMethods: ['turn/diff/updated'] },
    });
    server.terminate();
    await server.exited;
    expect(server.isAlive()).toBe(false);
  });

  it('fails the handshake with the process exit when the app-server dies', async () => {
    const spawn = fakeCodexSpawn(fake => fake.handle('initialize', () => new Promise(() => fake.emit('exit', 2))));
    await expect(spawnCodexAppServer({ cwd: '/', env: {}, spawn })).rejects.toMatchObject({ _tag: 'CodexAppServerProcessExitedError', code: 2 });
  });
});
