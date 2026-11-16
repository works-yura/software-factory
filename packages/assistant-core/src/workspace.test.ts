/**
 * The assistant's workspace end to end in the core (ADR-0051): a real folder per owner (Mastra's
 * local filesystem and sandbox stand in for the Factory sandbox the server uses), the agent's
 * workspace tools gated by the rules, proposals the person confirms, downloads, the thread's «Files»,
 * hand-over with workspace files, and erasing.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWorkspaceTools, WORKSPACE_TOOLS } from '@mastra/core/workspace';
import { LibSQLFactoryStorage } from '@mastra/libsql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fetchPublicFile, isPrivateAddress, publicUrlProblem } from './download.ts';
import type { AssistantSource, BrainTurn, SourceDownload } from './ports.ts';
import { AssistantService } from './service.ts';
import { AssistantStorage } from './storage.ts';
import { FakeBrain, FakeFactory, FakeMemory, fakeModels, LocalTestWorkspaceHost, MemoryBlobStore } from './testing.ts';
import type { AssistantOwner } from './types.ts';
import { describeToolCall, pathInRequest, requestFolder } from './workspace.ts';

const ADA: AssistantOwner = { orgId: 'org-a', userId: 'ada' };
const BOB: AssistantOwner = { orgId: 'org-a', userId: 'bob' };
const ADA_ELSEWHERE: AssistantOwner = { orgId: 'org-b', userId: 'ada' };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const EXEC = WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND;
const WRITE = WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE;
const READ = WORKSPACE_TOOLS.FILESYSTEM.READ_FILE;

type Runnable = { execute: (input: unknown, context: unknown) => Promise<unknown> };

/** Calls one workspace tool the way the agent does (through the turn's gated workspace). */
async function call(turn: BrainTurn, name: string, input: Record<string, unknown>): Promise<unknown> {
  const tools = (await createWorkspaceTools(turn.workspace!)) as unknown as Record<string, Runnable>;
  return tools[name]!.execute(input, {});
}

/** A source that owns `files.example-source.test` links and records which owner fetched what. */
class FilesSource implements AssistantSource {
  readonly platform = 'test';
  readonly fetched: string[] = [];
  async disconnect() {}
  async organizationsOf() {
    return [];
  }
  async download(owner: AssistantOwner, url: string): Promise<SourceDownload | null> {
    if (new URL(url).hostname !== 'files.example-source.test') return null;
    this.fetched.push(`${owner.userId}:${url}`);
    if (url.endsWith('.html')) return { bytes: new TextEncoder().encode('<html>sign in</html>'), mime: 'text/html; charset=utf-8' };
    return { bytes: PNG, mime: 'image/png' };
  }
}

let root: string;
let host: LocalTestWorkspaceHost;
let storage: AssistantStorage;
let brain: FakeBrain;
let factory: FakeFactory;
let source: FilesSource;
let pending: Array<Promise<void>>;
let fetched: string[];
let service: AssistantService;

async function settle() {
  while (pending.length) await pending.shift();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'assistant-ws-'));
  host = new LocalTestWorkspaceHost(root);
  const backend = new LibSQLFactoryStorage({ id: 'assistant-ws-test', url: ':memory:' });
  storage = backend.registerDomain(new AssistantStorage());
  await backend.init();
  brain = new FakeBrain();
  factory = new FakeFactory();
  source = new FilesSource();
  pending = [];
  fetched = [];
  service = new AssistantService({
    storage,
    blobs: new MemoryBlobStore(),
    brain,
    memory: new FakeMemory(),
    models: fakeModels,
    factory,
    grant: factory,
    sources: [source],
    workspace: host,
    audit: async () => undefined,
    blobReferencedElsewhere: async () => false,
    schedule: task => {
      pending.push(task());
    },
    limits: { answerPollTimeoutMs: 0 },
    sleep: async () => undefined,
    fetch: (async (url: string | URL | Request) => {
      fetched.push(String(url));
      if (String(url).includes('page')) return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
      if (String(url).includes('big')) return new Response(new Uint8Array(64), { headers: { 'content-type': 'application/octet-stream' } });
      if (String(url).includes('moved')) return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } });
      return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    }) as typeof fetch,
    maxFileBytes: 32,
  });
});

afterEach(async () => {
  await settle();
  await host.close();
  await rm(root, { recursive: true, force: true });
});

describe('the workspace a turn gets', () => {
  it("has the request's files in requests/<id>, and the agent is told where", async () => {
    const created = await service.createRequest(ADA, { text: 'look', files: [{ name: 'shot.png', declaredMime: null, bytes: PNG }] });
    await settle();
    const turn = brain.turns[0]!;
    expect(turn.workspace).toBeDefined();
    expect(turn.workspaceFolder).toBe(`requests/${created.id}`);
    expect(new Uint8Array(await readFile(join(host.folder(ADA), 'requests', created.id, 'shot.png')))).toEqual(PNG);
    // Reads run without asking.
    const read = await call(turn, READ, { path: `requests/${created.id}/shot.png` });
    expect(JSON.stringify(read)).not.toContain('awaiting_approval');
  });

  it('records workspace tool calls in «Turn details»', async () => {
    brain.answer = async turn => {
      await call(turn, WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES, { path: turn.workspaceFolder });
      return 'listed';
    };
    const created = await service.createRequest(ADA, { text: 'list' });
    await settle();
    const view = await service.openRequest(ADA, created.id);
    const reply = view.messages.find(message => message.author === 'agent')!;
    expect(reply.details?.toolCalls.map(record => record.name)).toContain(WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES);
  });

  it('is the owner’s alone: another person, or the same person in another organization, has another folder', async () => {
    const mine = await service.createRequest(ADA, { text: 'a', files: [{ name: 'mine.png', declaredMime: null, bytes: PNG }] });
    await service.createRequest(BOB, { text: 'b' });
    await service.createRequest(ADA_ELSEWHERE, { text: 'c' });
    await settle();
    const bobTurn = brain.turns.find(turn => turn.owner.userId === 'bob')!;
    await expect(call(bobTurn, READ, { path: `../../ada/workspace/requests/${mine.id}/mine.png` })).rejects.toThrow();
    expect(host.folder(BOB)).not.toBe(host.folder(ADA));
    expect(host.folder(ADA_ELSEWHERE)).not.toBe(host.folder(ADA));
    await expect(service.listWorkspaceFiles(BOB, mine.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('approvals', () => {
  it('turns a call the rules ask about into a proposal, runs it exactly as proposed once confirmed, and lets the agent carry on', async () => {
    brain.answer = async turn => {
      if (turn.input.author === 'approved') return `done: ${turn.input.text.split('\n')[0]}`;
      const answer = await call(turn, EXEC, { command: 'echo hello > made.txt', description: 'make a file' });
      expect(answer).toMatchObject({ status: 'awaiting_approval' });
      // A second asking call in the same turn is told one already waits.
      expect(await call(turn, WRITE, { path: 'x.txt', content: 'x' })).toMatchObject({ error: expect.stringContaining('already waits') });
      return 'proposed';
    };
    const created = await service.createRequest(ADA, { text: 'run it' });
    await settle();
    expect(await stat(join(host.folder(ADA), 'made.txt')).catch(() => null)).toBeNull();
    const proposed = await service.openRequest(ADA, created.id);
    const action = proposed.request.pendingAction!;
    expect(action).toMatchObject({ kind: 'workspace_tool', toolName: EXEC, summary: 'make a file\n$ echo hello > made.txt' });
    expect(proposed.messages.some(message => message.text.startsWith(`proposed:workspace_tool:${EXEC}`))).toBe(true);

    await service.confirmAction(ADA, created.id, action.id);
    await settle();
    expect(await readFile(join(host.folder(ADA), 'made.txt'), 'utf8')).toBe('hello\n');
    const after = await service.openRequest(ADA, created.id);
    expect(after.request.pendingAction).toBeNull();
    expect(after.messages.some(message => message.text.startsWith(`ran:${EXEC}`))).toBe(true);
    expect(after.messages.some(message => message.text === 'confirmed:workspace_tool')).toBe(true);
    expect(brain.turns.at(-1)!.input.author).toBe('approved');
    // Confirming twice runs nothing twice.
    await expect(service.confirmAction(ADA, created.id, action.id)).rejects.toMatchObject({ code: 'no_pending_action' });
  });

  it('runs nothing when the person cancels, and refuses what the rules deny', async () => {
    host.rules = toolName => (toolName === EXEC ? 'deny' : 'ask');
    brain.answer = async turn => {
      expect(await call(turn, EXEC, { command: 'touch denied.txt' })).toMatchObject({ error: expect.stringContaining('not allowed') });
      await call(turn, WRITE, { path: 'w.txt', content: 'w' });
      return 'ok';
    };
    const created = await service.createRequest(ADA, { text: 'try' });
    await settle();
    const action = (await service.openRequest(ADA, created.id)).request.pendingAction!;
    await service.cancelAction(ADA, created.id, action.id);
    expect(await stat(join(host.folder(ADA), 'w.txt')).catch(() => null)).toBeNull();
    expect(await stat(join(host.folder(ADA), 'denied.txt')).catch(() => null)).toBeNull();
  });

  it('describes a proposal the way the person reads it', () => {
    expect(describeToolCall('execute_command', { command: 'ls -la' })).toBe('$ ls -la');
    expect(describeToolCall('write_file', { path: 'a/b.md', content: 'x' })).toBe('write_file a/b.md');
  });
});

describe('downloads', () => {
  it("fetches a link on the person's source now, with that source, into downloads/", async () => {
    const created = await service.createRequest(ADA, { text: 'see' });
    await settle();
    const saved = await service.downloadToWorkspace(ADA, created.id, { url: 'https://files.example-source.test/a/shot.png' });
    expect(saved).toMatchObject({ path: `requests/${created.id}/downloads/shot.png`, mime: 'image/png', size: PNG.length });
    expect(source.fetched).toEqual(['ada:https://files.example-source.test/a/shot.png']);
    expect(await service.listWorkspaceFiles(ADA, created.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'downloads/shot.png', type: 'file', size: PNG.length })]),
    );
    // A page instead of a file is refused.
    await expect(service.downloadToWorkspace(ADA, created.id, { url: 'https://files.example-source.test/login.html' })).rejects.toMatchObject({
      code: 'not_a_file',
    });
  });

  it('asks the person before any other host, then fetches it without credentials and lets the agent see it', async () => {
    const created = await service.createRequest(ADA, { text: 'see' });
    await settle();
    expect(await service.downloadToWorkspace(ADA, created.id, { url: 'https://example.org/pic.png', reason: 'the screenshot' })).toMatchObject({
      status: 'awaiting_approval',
    });
    expect(fetched).toEqual([]);
    const action = (await service.openRequest(ADA, created.id)).request.pendingAction!;
    expect(action).toMatchObject({ kind: 'download', url: 'https://example.org/pic.png', name: 'pic.png', reason: 'the screenshot' });
    await service.confirmAction(ADA, created.id, action.id);
    await settle();
    expect(fetched).toEqual(['https://example.org/pic.png']);
    const file = await service.readWorkspaceFile(ADA, created.id, 'downloads/pic.png');
    expect(file).toMatchObject({ name: 'pic.png', mime: 'image/png' });
    expect(brain.turns.at(-1)!.input.text).toContain(`downloaded:requests/${created.id}/downloads/pic.png`);
  });

  it('keeps to the limit, refuses pages, local addresses and redirects into them', async () => {
    const created = await service.createRequest(ADA, { text: 'see' });
    await settle();
    await expect(service.downloadToWorkspace(ADA, created.id, { url: 'http://localhost:5874/web' })).rejects.toMatchObject({ code: 'download_refused' });
    await expect(service.downloadToWorkspace(ADA, created.id, { url: 'http://192.168.1.4/x.png' })).rejects.toMatchObject({ code: 'download_refused' });
    for (const [url, code] of [
      ['https://example.org/big.bin', 'file_too_large'],
      ['https://example.org/page', 'not_a_file'],
      ['https://example.org/moved', 'download_refused'],
    ] as const) {
      await service.downloadToWorkspace(ADA, created.id, { url });
      const action = (await service.openRequest(ADA, created.id)).request.pendingAction!;
      await expect(service.confirmAction(ADA, created.id, action.id)).rejects.toMatchObject({ code });
      // A failed confirmation goes back for a retry; cancel it before the next.
      await service.cancelAction(ADA, created.id, action.id);
    }
  });

  it('knows which addresses are local', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.0.1', '169.254.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isPrivateAddress(address)).toBe(true);
    }
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
    expect(publicUrlProblem('ftp://example.org/x')).toMatch(/http/);
    expect(publicUrlProblem('https://user:pw@example.org/x')).toMatch(/credentials/);
    expect(publicUrlProblem('https://intranet/x')).toMatch(/local/);
    expect(publicUrlProblem('https://example.org/x.png')).toBeNull();
  });

  it('fetches redirects only to public hosts', async () => {
    const hops: string[] = [];
    const fake = (async (url: string | URL | Request) => {
      hops.push(String(url));
      return String(url).endsWith('/a')
        ? new Response(null, { status: 301, headers: { location: '/b.png' } })
        : new Response(PNG, { headers: { 'content-type': 'image/png' } });
    }) as typeof fetch;
    await expect(fetchPublicFile('https://example.org/a', 100, fake)).resolves.toMatchObject({ mime: 'image/png' });
    expect(hops).toEqual(['https://example.org/a', 'https://example.org/b.png']);
  });
});

describe("the thread's files and hand-over", () => {
  it('lists and reads only inside the request folder', async () => {
    const created = await service.createRequest(ADA, { text: 'x', files: [{ name: 'a.png', declaredMime: null, bytes: PNG }] });
    await settle();
    await writeFile(join(host.folder(ADA), 'outside.txt'), 'secret');
    await expect(service.readWorkspaceFile(ADA, created.id, '../../outside.txt')).rejects.toMatchObject({ code: 'invalid_path' });
    await expect(service.readWorkspaceFile(ADA, created.id, 'missing.txt')).rejects.toMatchObject({ code: 'not_found' });
    expect(() => pathInRequest(created.id, 'a/../../b')).toThrow();
    expect(() => requestFolder('../x')).toThrow();
    expect(pathInRequest(created.id, './downloads/a.png')).toBe(`requests/${created.id}/downloads/a.png`);
  });

  it('hands the picked workspace files over with the request’s own', async () => {
    factory.connect(ADA);
    brain.answer = async turn => {
      if (turn.workspace) await turn.workspace.filesystem!.writeFile(`${turn.workspaceFolder}/report.md`, '# Report');
      return 'wrote a report';
    };
    const created = await service.createRequest(ADA, { text: 'x', files: [{ name: 'a.png', declaredMime: null, bytes: PNG }] });
    await settle();
    await service.handOver(ADA, created.id, { factoryId: 'f-1', workspaceFiles: ['report.md'] });
    expect(factory.handed[0]!.files).toEqual(['a.png', 'report.md']);
    await expect(service.handOver(ADA, created.id, { factoryId: 'f-1', workspaceFiles: ['../x'] })).rejects.toBeTruthy();
  });

  it('erases a request’s folder with the request (retention), and the whole workspace with the assistant', async () => {
    const created = await service.createRequest(ADA, { text: 'x', files: [{ name: 'a.png', declaredMime: null, bytes: PNG }] });
    await settle();
    await service.close(ADA, created.id);
    await storage.updateRequest(ADA, created.id, { closedAt: new Date('2020-01-01T00:00:00Z') });
    await service.sweepRetention();
    expect(await stat(join(host.folder(ADA), 'requests', created.id)).catch(() => null)).toBeNull();
    await service.clear(ADA, { reason: 'cleared_by_person', actorId: 'ada' });
    expect(host.erased).toEqual(['org-a/ada']);
    expect(await stat(host.folder(ADA)).catch(() => null)).toBeNull();
  });
});

describe('without a workspace', () => {
  it('offers no workspace and says why a download cannot run', async () => {
    const bare = new AssistantService({
      storage,
      brain,
      memory: new FakeMemory(),
      models: fakeModels,
      factory,
      grant: factory,
      audit: async () => undefined,
      blobReferencedElsewhere: async () => false,
      schedule: task => {
        pending.push(task());
      },
    });
    const created = await bare.createRequest(ADA, { text: 'x' });
    await settle();
    expect(brain.turns.at(-1)!.workspace).toBeUndefined();
    expect(bare.hasWorkspace).toBe(false);
    await expect(bare.downloadToWorkspace(ADA, created.id, { url: 'https://example.org/a.png' })).rejects.toMatchObject({ code: 'workspace_unavailable' });
    const preview = await bare.agentPreview(ADA);
    expect(preview.tools.map(tool => tool.name)).not.toContain('assistant_download_to_workspace');
  });

  it('lists the workspace tools with what each needs in «What the agent sees»', async () => {
    const preview = await service.agentPreview(ADA);
    expect(preview.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'assistant_download_to_workspace', kind: 'workspace' }),
        expect.objectContaining({ name: READ, kind: 'workspace' }),
        expect.objectContaining({ name: EXEC, kind: 'asks' }),
      ]),
    );
  });
});
