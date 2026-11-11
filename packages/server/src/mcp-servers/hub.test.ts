import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_MCP_TOOL_POLICIES } from '@factory/core';
import type { McpToolPolicies } from '@factory/core';
import type { McpServerRecord } from '@factory/store';

import { McpServerHub } from './hub.ts';
import { prepareMcpServer, McpServerLaunchError } from './launch.ts';
import { mcpServerPreset, presetEntrypoint } from './presets.ts';

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

const session = { orgId: 'org-1', sessionId: 'session-1', factoryProjectId: 'syncts' };
const hubs: McpServerHub[] = [];

function makeHub(records: McpServerRecord[], extra: { audit?: unknown[]; tempRoot?: string } = {}) {
  const hub = new McpServerHub({
    servers: {
      listRecords: async () => records,
      getRecord: async (_org, id) => records.find(record => record.id === id) ?? null,
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
    expect(Object.keys(tools).sort()).toEqual(['syncta-db_delete_documents', 'syncta-db_find_user', 'syncta-db_launch_info']);

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
    expect(Object.keys(unasked)).toEqual(['syncta-db_launch_info']);
  }, 30_000);

  it('gives a session only the servers its card is assigned', async () => {
    const audits = server({ id: 'srv-2', name: 'audits-db', assignments: [{ factoryProjectId: 'syncts', boards: ['audits'] }] });
    const hub = makeHub([audits]);
    expect(await hub.toolsFor({ ...session, board: 'work', phase: 'triage' })).toEqual({});
    expect(Object.keys(await hub.toolsFor({ ...session, sessionId: 's-2', board: 'audits', phase: 'analysis' }))).toHaveLength(3);
    expect(await hub.toolsFor({ ...session, sessionId: 's-3', factoryProjectId: 'other' })).toEqual({});
  }, 30_000);

  it('reports a server’s tools and policies, and why it cannot start', async () => {
    const policies: McpToolPolicies = { default: 'allow', tools: { delete_documents: 'deny' } };
    const broken = server({ id: 'srv-3', name: 'broken', launch: { transport: 'stdio', preset: 'toolbox-firestore', args: [], env: {} } });
    const hub = makeHub([server({ toolPolicies: policies }), broken]);

    const status = await hub.status('org-1', 'srv-1');
    expect(status).toMatchObject({ connected: true, toolCount: 3 });
    expect(status?.tools.find(tool => tool.name === 'delete_documents')?.policy).toBe('deny');

    expect(await hub.status('org-1', 'srv-3')).toMatchObject({ connected: false, error: expect.stringContaining('FIRESTORE_PROJECT') });
    expect(await hub.status('org-1', 'missing')).toBeNull();
  }, 30_000);
});

describe('prepareMcpServer', () => {
  it('runs a preset from the pinned package with this Node, never npx', async () => {
    const preset = mcpServerPreset('toolbox-firestore')!;
    const prepared = await prepareMcpServer(
      { transport: 'stdio', preset: 'toolbox-firestore', args: [], env: { FIRESTORE_PROJECT: 'p' } },
      { env: {}, headers: {}, files: { GOOGLE_APPLICATION_CREDENTIALS: '{}' } },
    );
    try {
      const definition = prepared.definition as { command: string; args: string[]; env: Record<string, string> };
      expect(definition.command).toBe(process.execPath);
      expect(definition.args).toEqual([presetEntrypoint(preset), '--prebuilt', 'firestore', '--stdio']);
      expect(existsSync(presetEntrypoint(preset))).toBe(true);
      expect(existsSync(definition.env.GOOGLE_APPLICATION_CREDENTIALS!)).toBe(true);
    } finally {
      await prepared.cleanup();
    }
  });

  it('fills ${VAR} in arguments from the server’s own variables and refuses an unset one', async () => {
    const prepared = await prepareMcpServer(
      { transport: 'stdio', preset: 'toolbox', args: [], env: {} },
      { env: {}, headers: {}, files: { TOOLBOX_TOOLS_FILE: 'sources: {}' } },
    );
    const definition = prepared.definition as { args: string[]; env: Record<string, string> };
    expect(definition.args.slice(1)).toEqual(['--tools-file', definition.env.TOOLBOX_TOOLS_FILE, '--stdio']);
    await prepared.cleanup();

    await expect(
      prepareMcpServer({ transport: 'stdio', command: 'x', args: ['${MISSING}'], env: {} }, { env: {}, headers: {}, files: {} }),
    ).rejects.toBeInstanceOf(McpServerLaunchError);
  });

  it('sends secret headers to an http server', async () => {
    const prepared = await prepareMcpServer(
      { transport: 'http', url: 'https://mcp.example.test/mcp', headers: { 'X-Team': 'eclipt' } },
      { env: {}, headers: { Authorization: 'Bearer secret' }, files: {} },
    );
    expect(prepared.definition).toMatchObject({ requestInit: { headers: { 'X-Team': 'eclipt', Authorization: 'Bearer secret' } } });
  });
});
