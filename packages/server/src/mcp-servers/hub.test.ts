import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_MCP_TOOL_POLICIES } from '@factory/core';
import type { McpToolPolicies } from '@factory/core';
import type { McpServerRecord } from '@factory/store';

import { McpServerHub, mcpErrorKind } from './hub.ts';
import { prepareMcpServer, McpServerLaunchError } from './launch.ts';
import { catalogEntrypoint, mcpCatalogEntryById } from './catalog.ts';

const FAKE = fileURLToPath(new URL('./__fixtures__/fake-mcp-server.mjs', import.meta.url));

function server(overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    id: 'srv-1',
    orgId: 'org-1',
    name: 'syncta-db',
    label: 'Syncta Firestore',
    launch: { transport: 'stdio', command: process.execPath, args: [FAKE], env: { FIRESTORE_PROJECT: 'syncta-57c6a' } },
    secretNames: { env: [], headers: [], files: ['GOOGLE_APPLICATION_CREDENTIALS'] },
    secrets: { env: {}, headers: {}, files: { GOOGLE_APPLICATION_CREDENTIALS: '{"type":"service_account"}' } },
    assignments: [{ factoryProjectId: 'syncts' }],
    toolPolicies: DEFAULT_MCP_TOOL_POLICIES,
    maskPersonalData: true,
    enabled: true,
    updatedAt: '2026-11-11T00:00:00.000Z',
    updatedBy: 'user-1',
    ...overrides,
  };
}

const session = { orgId: 'org-1', sessionId: 'session-1', factoryProjectId: 'syncts', kind: 'personal' as const };
const hubs: McpServerHub[] = [];

function makeHub(records: McpServerRecord[], extra: { audit?: unknown[]; tempRoot?: string } = {}) {
  const hub = new McpServerHub({
    servers: {
      listRecords: async () => records,
      getRecord: async (_org, id) => records.find(record => record.id === id) ?? null,
      // Keeps health and quarantine on the in-memory records, as the store does.
      recordHealth: async (_org, id, health, quarantine = []) => {
        const record = records.find(item => item.id === id);
        if (!record) return null;
        record.health = { ...health, ...(record.health?.lastUsedAt ? { lastUsedAt: record.health.lastUsedAt } : {}) };
        if (quarantine.length) {
          record.toolPolicies = {
            ...record.toolPolicies,
            tools: { ...record.toolPolicies.tools, ...Object.fromEntries(quarantine.map(tool => [tool, 'review' as const])) },
          };
        }
        return record;
      },
      recordUse: async (_org, id, at, failure) => {
        const record = records.find(item => item.id === id);
        if (!record) return;
        const previous = record.health ?? { state: 'ok' as const, tools: [] };
        record.health = failure ? { ...previous, lastUsedAt: at.toISOString(), state: 'error', ...failure } : { ...previous, lastUsedAt: at.toISOString() };
      },
    },
    ...(extra.audit ? { audit: { record: async (input: unknown) => void extra.audit!.push(input) } } : {}),
    ...(extra.tempRoot ? { tempRoot: extra.tempRoot } : {}),
    log: { warn: () => {} },
  });
  hubs.push(hub);
  return hub;
}

afterEach(async () => {
  await Promise.all(hubs.splice(0).map(hub => hub.dispose()));
});

/** Calls a tool and reads back the JSON its MCP result carries as text. */
async function call(tool: unknown, input: unknown) {
  const result = (await (tool as { execute: (input: unknown, context: unknown) => Promise<unknown> }).execute(input, {})) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = result.content?.find(part => part.type === 'text')?.text;
  return text === undefined ? result : JSON.parse(text);
}

describe('McpServerHub with a real stdio server', () => {
  it('runs the server with its config and secret file, masks results and audits the call', async () => {
    const audit: unknown[] = [];
    const tempRoot = mkdtempSync(join(tmpdir(), 'mcp-hub-test-'));
    process.env.FACTORY_HOST_ONLY = 'host-secret';
    const hub = makeHub([server()], { audit, tempRoot });

    const tools = await hub.toolsFor(session);
    expect(Object.keys(tools).sort()).toEqual([
      'syncta-db_delete_documents',
      'syncta-db_find_user',
      'syncta-db_launch_info',
      'syncta-db_slow_read',
    ]);

    const info = (await call(tools['syncta-db_launch_info'], {})) as Record<string, unknown>;
    expect(info).toMatchObject({ project: 'syncta-57c6a', keyFileExists: true, keyFileContent: '{"type":"service_account"}' });
    // The Factory server's own environment never reaches the MCP server.
    expect(info.hostSecret).toBeNull();

    const user = JSON.stringify(await call(tools['syncta-db_find_user'], { id: 'u1' }));
    expect(user).not.toContain('ana@example.com');
    expect(user).toContain('[email]');
    expect(audit).toContainEqual(
      expect.objectContaining({
        action: 'factory.mcp_server.tool_called',
        metadata: expect.objectContaining({ server: 'syncta-db', tool: 'find_user', outcome: 'ok' }),
      }),
    );
    expect(JSON.stringify(audit)).not.toContain('u1');

    // The key file lives only while the session's servers run.
    expect(readdirSync(tempRoot)).toHaveLength(1);
    await hub.release(session.sessionId);
    expect(readdirSync(tempRoot)).toHaveLength(0);
    delete process.env.FACTORY_HOST_ONLY;
  }, 30_000);

  it('passes results through untouched when masking is off', async () => {
    const hub = makeHub([server({ maskPersonalData: false })]);
    const tools = await hub.toolsFor(session);
    expect(JSON.stringify(await call(tools['syncta-db_find_user'], { id: 'u1' }))).toContain('ana@example.com');
  }, 30_000);

  it('applies the tool policy: deny is not offered, ask waits for a person (or is left out where nobody can be asked)', async () => {
    const policies: McpToolPolicies = { default: 'allow', tools: { delete_documents: 'deny', find_user: 'ask' } };
    const hub = makeHub([server({ toolPolicies: policies })]);

    const tools = await hub.toolsFor(session);
    expect(tools['syncta-db_delete_documents']).toBeUndefined();
    expect((tools['syncta-db_find_user'] as { requireApproval?: boolean }).requireApproval).toBe(true);
    expect((tools['syncta-db_launch_info'] as { requireApproval?: boolean }).requireApproval).toBeFalsy();
    expect(await hub.askToolNames(session)).toEqual(['syncta-db_find_user']);

    const unasked = await hub.toolsFor(session, { askSupported: false });
    expect(Object.keys(unasked).sort()).toEqual(['syncta-db_launch_info', 'syncta-db_slow_read']);
  }, 30_000);

  it('gives a session only the servers its card is assigned', async () => {
    const audits = server({ id: 'srv-2', name: 'audits-db', assignments: [{ factoryProjectId: 'syncts', boards: ['audits'] }] });
    const hub = makeHub([audits]);
    expect(await hub.toolsFor({ ...session, kind: 'card', board: 'work', phase: 'triage' })).toEqual({});
    expect(Object.keys(await hub.toolsFor({ ...session, kind: 'card', sessionId: 's-2', board: 'audits', phase: 'analysis' }))).toHaveLength(4);
    // A server limited to cards never reaches the Factory chat or a member's own session.
    expect(await hub.toolsFor({ ...session, sessionId: 's-4', kind: 'chat' })).toEqual({});
    expect(await hub.toolsFor({ ...session, sessionId: 's-5', kind: 'personal' })).toEqual({});
    expect(await hub.toolsFor({ ...session, sessionId: 's-3', factoryProjectId: 'other' })).toEqual({});
  }, 30_000);

  it('reports a server’s tools and policies, and why it cannot start', async () => {
    const policies: McpToolPolicies = { default: 'allow', tools: { delete_documents: 'deny' } };
    const broken = server({
      id: 'srv-3',
      name: 'broken',
      launch: { transport: 'catalog', entry: 'mcp-toolbox', variant: 'firestore', inputs: {}, credentials: {} },
    });
    const hub = makeHub([server({ toolPolicies: policies }), broken]);

    const status = await hub.status('org-1', 'srv-1');
    expect(status).toMatchObject({ connected: true, toolCount: 4 });
    expect(status?.tools.find(tool => tool.name === 'delete_documents')).toMatchObject({ policy: 'deny', risk: 'destructive' });
    expect(status?.tools.find(tool => tool.name === 'find_user')).toMatchObject({ risk: 'read', annotations: { readOnlyHint: true } });

    expect(await hub.status('org-1', 'srv-3')).toMatchObject({
      connected: false,
      error: expect.stringContaining('FIRESTORE_PROJECT'),
      errorKind: 'missing_input',
    });
    expect(await hub.status('org-1', 'missing')).toBeNull();
  }, 30_000);

  it('checks a config that was never saved, and removes its secret files after', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'mcp-hub-check-'));
    const hub = makeHub([], { tempRoot });
    const unsaved = server();
    const status = await hub.check('org-1', { name: unsaved.name, launch: unsaved.launch, secrets: unsaved.secrets, toolPolicies: unsaved.toolPolicies });
    expect(status).toMatchObject({ connected: true, toolCount: 4 });
    expect(readdirSync(tempRoot)).toEqual([]);
  }, 30_000);

  it('keeps what a check found with the server, and a failed check keeps the masked error', async () => {
    const good = server();
    const bad = server({
      id: 'srv-bad',
      name: 'bad',
      launch: { transport: 'stdio', command: process.execPath, args: ['/nowhere/ana@example.com/missing.mjs'], env: {} },
    });
    const hub = makeHub([good, bad]);

    await hub.status('org-1', 'srv-1');
    expect(good.health).toMatchObject({ state: 'ok', checkedAt: expect.any(String) });
    expect(good.health?.tools.map(tool => tool.name).sort()).toEqual(['delete_documents', 'find_user', 'launch_info', 'slow_read']);

    await hub.status('org-1', 'srv-bad');
    expect(bad.health).toMatchObject({ state: 'error', error: expect.any(String) });
    expect(bad.health?.error).not.toContain('ana@example.com');
  }, 30_000);

  it('puts a new writing tool under review after a later check, hidden from agents until someone decides', async () => {
    const record = server();
    const hub = makeHub([record]);
    // The first check sees the tools as they are: nothing quarantined.
    expect((await hub.status('org-1', 'srv-1'))?.quarantined).toBeUndefined();

    record.launch = { ...record.launch, env: { ...(record.launch as { env: Record<string, string> }).env, FAKE_EXTRA_TOOL: '1' } } as never;
    const second = await hub.status('org-1', 'srv-1');
    expect(second?.quarantined).toEqual(['add_documents']);
    expect(second?.tools.find(tool => tool.name === 'add_documents')).toMatchObject({ policy: 'review', risk: 'write' });
    expect(record.toolPolicies.tools.add_documents).toBe('review');

    const tools = await hub.toolsFor({ ...session, sessionId: 'quarantine' });
    expect(tools['syncta-db_add_documents']).toBeUndefined();
    expect(tools['syncta-db_find_user']).toBeDefined();
  }, 30_000);

  it('fails a call that outlives the server’s time limit and notes the failure', async () => {
    const record = server({
      callTimeoutMs: 1_000,
      launch: { transport: 'stdio', command: process.execPath, args: [FAKE], env: { FAKE_SLOW_MS: '5000' } },
    });
    const hub = makeHub([record]);
    const tools = await hub.toolsFor({ ...session, sessionId: 'slow' });
    await expect(call(tools['syncta-db_slow_read'], {})).rejects.toThrow(/timed out/);
    expect(record.health).toMatchObject({ state: 'error', errorKind: 'timeout', lastUsedAt: expect.any(String) });
  }, 30_000);

  it('tries only read-only tools, masked and audited as the person’s', async () => {
    const audit: unknown[] = [];
    const hub = makeHub([server()], { audit });

    const trial = await hub.tryTool('org-1', 'srv-1', 'find_user', { id: 'u1' }, 'user-1');
    expect(trial?.ok).toBe(true);
    expect(JSON.stringify(trial?.output)).not.toContain('ana@example.com');
    expect(audit).toContainEqual(
      expect.objectContaining({ action: 'factory.mcp_server.tool_tried', actorId: 'user-1', actorType: 'human' }),
    );

    await expect(hub.tryTool('org-1', 'srv-1', 'delete_documents', {}, 'user-1')).rejects.toMatchObject({ reason: 'not_read_only' });
    await expect(hub.tryTool('org-1', 'srv-1', 'nope', {}, 'user-1')).rejects.toMatchObject({ reason: 'unknown_tool' });
    expect(await hub.tryTool('org-1', 'missing', 'find_user', {}, 'user-1')).toBeNull();
  }, 30_000);

  it('reconnects: stops the running instances of the server, then checks it again', async () => {
    const hub = makeHub([server()]);
    const first = await hub.toolsFor({ ...session, sessionId: 'running' });
    expect(first['syncta-db_find_user']).toBeDefined();

    const status = await hub.reconnect('org-1', 'srv-1');
    expect(status).toMatchObject({ connected: true });
    // The stopped session starts the server again on its next call.
    const again = await hub.toolsFor({ ...session, sessionId: 'running' });
    expect(again['syncta-db_find_user']).not.toBe(first['syncta-db_find_user']);
  }, 30_000);
});

describe('mcpErrorKind', () => {
  it('sorts common failures into kinds the page explains', () => {
    expect(mcpErrorKind('Installed @toolbox-sdk/server is 1.15.0 but the catalog expects version 1.16.0')).toBe('version_mismatch');
    expect(mcpErrorKind('Syncta Firestore: find_user timed out after 60 s')).toBe('timeout');
    expect(mcpErrorKind('7 PERMISSION_DENIED: Missing or insufficient permissions.')).toBe('auth_denied');
    expect(mcpErrorKind('FIRESTORE_PROJECT is required')).toBe('missing_input');
    expect(mcpErrorKind('spawn /usr/bin/toolbox ENOENT')).toBe('spawn_failed');
    expect(mcpErrorKind('something else')).toBe('other');
  });
});

describe('prepareMcpServer', () => {
  const toolbox = mcpCatalogEntryById('mcp-toolbox')!;

  it('runs a catalog entry from its pinned package with this Node, never npx', async () => {
    const prepared = await prepareMcpServer(
      { transport: 'catalog', entry: 'mcp-toolbox', variant: 'firestore', inputs: { FIRESTORE_PROJECT: 'p' }, credentials: {} },
      { env: {}, headers: {}, files: { GOOGLE_APPLICATION_CREDENTIALS: '{}' } },
    );
    try {
      const definition = prepared.definition as { command: string; args: string[]; env: Record<string, string> };
      expect(definition.command).toBe(process.execPath);
      expect(definition.args).toEqual([catalogEntrypoint(toolbox), '--prebuilt', 'firestore', '--stdio']);
      expect(existsSync(catalogEntrypoint(toolbox))).toBe(true);
      expect(definition.env.FIRESTORE_PROJECT).toBe('p');
      // The manifest's default fills an input left empty.
      expect(definition.env.FIRESTORE_DATABASE).toBe('');
      expect(existsSync(definition.env.GOOGLE_APPLICATION_CREDENTIALS!)).toBe(true);
    } finally {
      await prepared.cleanup();
    }
  });

  it('fills a credential input from the organization’s account, written to a private file and removed after', async () => {
    const reads: unknown[] = [];
    const prepared = await prepareMcpServer(
      {
        transport: 'catalog',
        entry: 'mcp-toolbox',
        variant: 'firestore',
        inputs: { FIRESTORE_PROJECT: 'syncta-57c6a' },
        credentials: { GOOGLE_APPLICATION_CREDENTIALS: { kind: 'google-cloud-account', id: 'acc-1' } },
      },
      { env: {}, headers: {}, files: {} },
      {
        credentials: async ref => {
          reads.push(ref);
          return '{"type":"service_account","project_id":"syncta-57c6a"}';
        },
      },
    );
    const keyPath = (prepared.definition as { env: Record<string, string> }).env.GOOGLE_APPLICATION_CREDENTIALS!;
    expect(reads).toEqual([{ kind: 'google-cloud-account', id: 'acc-1' }]);
    expect(readFileSync(keyPath, 'utf8')).toContain('syncta-57c6a');
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    await prepared.cleanup();
    expect(existsSync(keyPath)).toBe(false);

    await expect(
      prepareMcpServer(
        {
          transport: 'catalog',
          entry: 'mcp-toolbox',
          variant: 'firestore',
          inputs: { FIRESTORE_PROJECT: 'p' },
          credentials: { GOOGLE_APPLICATION_CREDENTIALS: { kind: 'google-cloud-account', id: 'gone' } },
        },
        { env: {}, headers: {}, files: {} },
        { credentials: async () => null },
      ),
    ).rejects.toThrow(/no longer exists/);
  });

  it('refuses a missing required input and an unknown variant, naming them', async () => {
    await expect(
      prepareMcpServer(
        { transport: 'catalog', entry: 'mcp-toolbox', variant: 'postgres', inputs: { POSTGRES_DATABASE: 'db' }, credentials: {} },
        { env: {}, headers: {}, files: {} },
      ),
    ).rejects.toThrow(/POSTGRES_USER/);
    await expect(
      prepareMcpServer(
        { transport: 'catalog', entry: 'mcp-toolbox', variant: 'mysql', inputs: {}, credentials: {} },
        { env: {}, headers: {}, files: {} },
      ),
    ).rejects.toBeInstanceOf(McpServerLaunchError);
  });

  it('gives a secret input as a variable and an argument value only to the arguments', async () => {
    const postgres = await prepareMcpServer(
      {
        transport: 'catalog',
        entry: 'mcp-toolbox',
        variant: 'postgres',
        inputs: { POSTGRES_DATABASE: 'db', POSTGRES_USER: 'reader' },
        credentials: {},
      },
      { env: { POSTGRES_PASSWORD: 'secret' }, headers: {}, files: {} },
    );
    expect((postgres.definition as { env: Record<string, string> }).env).toMatchObject({
      POSTGRES_HOST: 'localhost',
      POSTGRES_PORT: '5432',
      POSTGRES_PASSWORD: 'secret',
    });
    await postgres.cleanup();

    const toolsFile = await prepareMcpServer(
      { transport: 'catalog', entry: 'mcp-toolbox', variant: 'tools-file', inputs: {}, credentials: {} },
      { env: {}, headers: {}, files: { tools_file: 'sources: {}' } },
    );
    const definition = toolsFile.definition as { args: string[]; env: Record<string, string> };
    expect(definition.args[1]).toBe('--tools-file');
    expect(readFileSync(definition.args[2]!, 'utf8')).toBe('sources: {}');
    expect(definition.env.tools_file).toBeUndefined();
    await toolsFile.cleanup();
  });

  it('fills ${VAR} in a local command’s arguments from its own variables and refuses an unset one', async () => {
    await expect(
      prepareMcpServer({ transport: 'stdio', command: 'x', args: ['${MISSING}'], env: {} }, { env: {}, headers: {}, files: {} }),
    ).rejects.toBeInstanceOf(McpServerLaunchError);
    const prepared = await prepareMcpServer(
      { transport: 'stdio', command: 'x', args: ['--key', '${KEY_FILE}'], env: {} },
      { env: {}, headers: {}, files: { KEY_FILE: 'k' } },
    );
    const definition = prepared.definition as { args: string[]; env: Record<string, string> };
    expect(definition.args).toEqual(['--key', definition.env.KEY_FILE]);
    await prepared.cleanup();
  });

  it('refuses a row still on a retired preset (the boot migration moves it)', async () => {
    await expect(
      prepareMcpServer({ transport: 'stdio', preset: 'toolbox-firestore', args: [], env: {} }, { env: {}, headers: {}, files: {} }),
    ).rejects.toThrow(/retired preset/);
  });

  it('sends secret headers to an http server', async () => {
    const prepared = await prepareMcpServer(
      { transport: 'http', url: 'https://mcp.example.test/mcp', headers: { 'X-Team': 'eclipt' } },
      { env: {}, headers: { Authorization: 'Bearer secret' }, files: {} },
    );
    expect(prepared.definition).toMatchObject({ requestInit: { headers: { 'X-Team': 'eclipt', Authorization: 'Bearer secret' } } });
  });
});
