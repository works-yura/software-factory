import { describe, expect, it, vi } from 'vitest';

import { ClickUpApiError } from './api.ts';
import { adoptDeploymentClickUpToken, ClickUpClients, ClickUpNotConnectedError, readClickUpToken } from './connection.ts';
import type { ClickUpApi, ClickUpConnectionStorage } from './connection.ts';

function memoryConnections(initial: Record<string, unknown> = {}) {
  const rows = new Map<string, { data: unknown; metadata: Record<string, unknown> }>(
    Object.entries(initial).map(([orgId, data]) => [orgId, { data, metadata: {} }]),
  );
  const storage = {
    connections: {
      get: async (orgId: string) => {
        const row = rows.get(orgId);
        return row ? ({ orgId, data: row.data, metadata: row.metadata } as never) : null;
      },
      upsert: async (orgId: string, input: { data: unknown; metadata?: Record<string, unknown> }) => {
        rows.set(orgId, { data: input.data, metadata: input.metadata ?? {} });
      },
      update: async () => null,
      delete: async (orgId: string) => rows.delete(orgId),
    },
  } as unknown as ClickUpConnectionStorage;
  return { rows, storage };
}

const client = (overrides: Partial<Record<keyof ClickUpApi, unknown>> = {}) =>
  ({
    authorizedUser: async () => ({ id: '7', username: 'factory-bot' }),
    listWorkspaces: async () => [{ id: 'w', name: 'Eclipt' }],
    ...overrides,
  }) as unknown as ClickUpApi;

describe('moving CLICKUP_API_TOKEN into the organization', () => {
  it('stores the env token for the organization once, with the account it belongs to', async () => {
    const { rows, storage } = memoryConnections();
    const line = await adoptDeploymentClickUpToken({ storage, orgId: 'factory-local-org', token: ' pk_env ', create: () => client() });
    expect(line).toContain("moved CLICKUP_API_TOKEN into organization factory-local-org's ClickUp connection");
    expect(rows.get('factory-local-org')).toEqual({
      data: { apiToken: 'pk_env' },
      metadata: { username: 'factory-bot', userId: '7', workspaces: ['Eclipt'] },
    });
    // A second run (another replica, a lost marker) changes nothing.
    const again = await adoptDeploymentClickUpToken({ storage, orgId: 'factory-local-org', token: 'pk_env', create: () => client() });
    expect(again).toContain('kept the ClickUp token');
    expect(rows.get('factory-local-org')?.data).toEqual({ apiToken: 'pk_env' });
  });

  it("never overwrites a token the organization already connected", async () => {
    const { rows, storage } = memoryConnections({ 'factory-local-org': { apiToken: 'pk_from_settings' } });
    const create = vi.fn(() => client());
    const line = await adoptDeploymentClickUpToken({ storage, orgId: 'factory-local-org', token: 'pk_env', create });
    expect(line).toContain('was not copied and is no longer read');
    expect(rows.get('factory-local-org')?.data).toEqual({ apiToken: 'pk_from_settings' });
    expect(create).not.toHaveBeenCalled();
  });

  it('does nothing without an env token', async () => {
    const { rows, storage } = memoryConnections();
    expect(await adoptDeploymentClickUpToken({ storage, orgId: 'factory-local-org', token: undefined })).toBeUndefined();
    expect(await adoptDeploymentClickUpToken({ storage, orgId: 'factory-local-org', token: '  ' })).toBeUndefined();
    expect(rows.size).toBe(0);
  });

  it('keeps a token ClickUp refuses rather than lose it, and says so', async () => {
    const { rows, storage } = memoryConnections();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refused = client({ authorizedUser: async () => Promise.reject(new ClickUpApiError('ClickUp request failed with 401.', 401)) });
    await adoptDeploymentClickUpToken({ storage, orgId: 'factory-local-org', token: 'pk_old', create: () => refused });
    expect(rows.get('factory-local-org')?.data).toEqual({ apiToken: 'pk_old' });
    expect(String(warn.mock.calls[0]?.[0])).toContain('could not be checked');
    warn.mockRestore();
  });
});

describe('ClickUpClients', () => {
  it("gives each organization a client for its own token, a new one when it changes, and none without one", async () => {
    const { rows, storage } = memoryConnections({ 'org-a': { apiToken: 'pk_a' } });
    const created: string[] = [];
    const clients = new ClickUpClients({
      storage: () => storage,
      create: token => {
        created.push(token);
        return client();
      },
    });
    const first = await clients.forOrg('org-a');
    expect(await clients.forOrg('org-a')).toBe(first);
    expect(await clients.forOrg('org-b')).toBeNull();
    await expect(clients.require('org-b')).rejects.toBeInstanceOf(ClickUpNotConnectedError);
    rows.set('org-a', { data: { apiToken: 'pk_a2' }, metadata: {} });
    expect(await clients.forOrg('org-a')).not.toBe(first);
    expect(created).toEqual(['pk_a', 'pk_a2']);
    expect(await readClickUpToken(storage, 'org-a')).toBe('pk_a2');
  });
});
