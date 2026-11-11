import { describe, expect, it } from 'vitest';

import type { ManagedMcpServerSpec } from '@factory/core';

import { ManagedMcpServers } from './managed.ts';

const spec: ManagedMcpServerSpec = {
  key: 'bnd-1',
  name: 'db-syncta',
  label: 'Firestore syncta',
  launch: { transport: 'catalog', entry: 'mcp-toolbox', variant: 'firestore', inputs: {}, credentials: {} },
  assignments: [{ factoryProjectId: 'fp-1' }],
};

const noChange = { created: [], updated: [], removed: [] };

describe('ManagedMcpServers', () => {
  it('syncs each managing integration, and an organization once per boot until a change asks again', async () => {
    const calls: Array<[string, string, number]> = [];
    const managed = new ManagedMcpServers({
      servers: {
        syncOwned: async (orgId, integration, specs) => {
          calls.push([orgId, integration, specs.length]);
          return noChange;
        },
      },
      integrations: () => [{ id: 'firebase', managedMcpServers: async () => [spec] }],
    });
    await managed.ensure('org-1');
    await managed.ensure('org-1');
    expect(calls).toEqual([['org-1', 'firebase', 1]]);
    await managed.sync('org-1');
    expect(calls).toHaveLength(2);
  });

  it('logs a failed sync, rethrows it, and tries again on the next read', async () => {
    const errors: string[] = [];
    let fail = true;
    const managed = new ManagedMcpServers({
      servers: { syncOwned: async () => noChange },
      integrations: () => [
        {
          id: 'firebase',
          managedMcpServers: async () => {
            if (fail) throw new Error('settings unreadable');
            return [spec];
          },
        },
      ],
      logger: { error: message => void errors.push(message) },
    });
    await expect(managed.ensure('org-1')).rejects.toThrow('settings unreadable');
    expect(errors).toHaveLength(1);
    fail = false;
    await expect(managed.ensure('org-1')).resolves.toBeUndefined();
  });
});
