import { LibSQLFactoryStorage } from '@mastra/libsql';
import { describe, expect, it, onTestFinished } from 'vitest';

import { mcpServerInputSchema } from '@factory/core';

import { createFactorySecretEncryption } from '../secret-encryption.ts';
import { McpServerNameTakenError, McpServersStorage, mergeMcpSecrets } from './base.ts';

const testKey = { id: 'v1', key: new Uint8Array(32).fill(9) };
const ORG = 'org-1';

async function makeStore() {
  const backend = new LibSQLFactoryStorage({ id: 'mcp-servers-test', url: ':memory:' });
  const domain = backend.registerDomain(new McpServersStorage(createFactorySecretEncryption({ primary: testKey })));
  await backend.init();
  onTestFinished(() => backend.close());
  return { ops: backend.ops, domain };
}

const input = (overrides: Record<string, unknown> = {}) =>
  mcpServerInputSchema.parse({
    name: 'syncta-db',
    label: 'Syncta Firestore',
    launch: { transport: 'stdio', preset: 'toolbox-firestore', env: { FIRESTORE_PROJECT: 'syncta-57c6a' } },
    secrets: { files: { GOOGLE_APPLICATION_CREDENTIALS: '{"type":"service_account","private_key":"k"}' } },
    ...overrides,
  });

describe('McpServersStorage', () => {
  it('keeps secrets encrypted and shows only their names', async () => {
    const { ops, domain } = await makeStore();
    const created = await domain.create(ORG, input(), 'user-1');

    expect(created.secretNames).toEqual({ env: [], headers: [], files: ['GOOGLE_APPLICATION_CREDENTIALS'] });
    expect(JSON.stringify(created)).not.toContain('private_key');
    const [row] = await ops.findMany<{ secrets: string }>('factory_mcp_servers', {});
    expect(row!.secrets).not.toContain('private_key');
    expect((await domain.list(ORG))[0]).toMatchObject({ name: 'syncta-db', assignments: [], maskPersonalData: true });

    const record = await domain.getRecord(ORG, created.id);
    expect(record?.secrets.files.GOOGLE_APPLICATION_CREDENTIALS).toContain('private_key');
  });

  it('keeps a secret not mentioned on update, removes one set to null', async () => {
    const { domain } = await makeStore();
    const created = await domain.create(ORG, input({ secrets: { env: { A: '1', B: '2' } } }), 'user-1');
    await domain.update(ORG, created.id, input({ secrets: { env: { B: null } } }), 'user-2');

    const record = await domain.getRecord(ORG, created.id);
    expect(record?.secrets.env).toEqual({ A: '1' });
    expect(record?.updatedBy).toBe('user-2');
  });

  it('refuses a second server with the same name in the organization', async () => {
    const { domain } = await makeStore();
    await domain.create(ORG, input(), 'user-1');
    await expect(domain.create(ORG, input(), 'user-1')).rejects.toBeInstanceOf(McpServerNameTakenError);
    await expect(domain.create('org-2', input(), 'user-1')).resolves.toMatchObject({ name: 'syncta-db' });
  });

  it('keeps what a check found without counting it as an edit, quarantines new tools, and notes use', async () => {
    const { domain } = await makeStore();
    const created = await domain.create(ORG, input({ callTimeoutMs: 30_000 }), 'user-1');
    expect(created.callTimeoutMs).toBe(30_000);
    expect(created.health).toBeUndefined();

    const tools = [{ name: 'list_collections', description: 'Lists.', annotations: { readOnlyHint: true } }];
    const checked = await domain.recordHealth(ORG, created.id, { state: 'ok', tools, checkedAt: '2026-11-12T10:00:00.000Z' }, ['add_documents']);
    expect(checked?.health).toMatchObject({ state: 'ok', tools, checkedAt: '2026-11-12T10:00:00.000Z' });
    expect(checked?.toolPolicies.tools).toEqual({ add_documents: 'review' });
    // A check is not an edit: running sessions keep their servers.
    expect(checked?.updatedAt).toBe(created.updatedAt);

    await domain.recordUse(ORG, created.id, new Date('2026-11-12T10:05:00.000Z'));
    expect((await domain.get(ORG, created.id))?.health).toMatchObject({ state: 'ok', lastUsedAt: '2026-11-12T10:05:00.000Z' });
    await domain.recordUse(ORG, created.id, new Date('2026-11-12T10:06:00.000Z'), { error: 'timed out', errorKind: 'timeout' });
    expect((await domain.get(ORG, created.id))?.health).toMatchObject({ state: 'error', errorKind: 'timeout', tools });

    // A later check keeps the last use.
    await domain.recordHealth(ORG, created.id, { state: 'ok', tools, checkedAt: '2026-11-12T11:00:00.000Z' });
    expect((await domain.get(ORG, created.id))?.health).toMatchObject({ state: 'ok', lastUsedAt: '2026-11-12T10:06:00.000Z' });
    expect(await domain.recordHealth(ORG, 'missing', { state: 'ok', tools: [] })).toBeNull();
  });

  it('merges secrets by kind', () => {
    expect(
      mergeMcpSecrets({ env: { A: '1' }, headers: { H: 'x' }, files: {} }, { headers: { H: null }, files: { F: 'f' } }),
    ).toEqual({ env: { A: '1' }, headers: {}, files: { F: 'f' } });
  });

  describe('servers an integration manages', () => {
    const spec = (key: string, overrides: Record<string, unknown> = {}) => ({
      key,
      name: 'db-syncta-57c6a',
      label: 'Firestore syncta-57c6a',
      launch: {
        transport: 'catalog' as const,
        entry: 'mcp-toolbox',
        variant: 'firestore',
        inputs: { FIRESTORE_PROJECT: 'syncta-57c6a' },
        credentials: { GOOGLE_APPLICATION_CREDENTIALS: { kind: 'google-cloud-account' as const, id: 'acc-1' } },
      },
      assignments: [{ factoryProjectId: 'fp-1' }],
      ...overrides,
    });

    it('creates, keeps a person\'s policy across updates, and removes what the settings no longer ask for', async () => {
      const { domain } = await makeStore();
      const first = await domain.syncOwned(ORG, 'firebase', [spec('bnd-1')], 'integration:firebase');
      expect(first.created).toHaveLength(1);
      const [created] = await domain.list(ORG);
      expect(created).toMatchObject({ name: 'db-syncta-57c6a', owner: { integration: 'firebase', key: 'bnd-1' }, maskPersonalData: true });

      // A person forbids a write tool; the integration then moves the server to another Factory.
      await domain.update(
        ORG,
        created!.id,
        { ...created!, toolPolicies: { default: 'allow', tools: { delete_documents: 'deny' } }, secrets: undefined } as never,
        'user-1',
      );
      const second = await domain.syncOwned(ORG, 'firebase', [spec('bnd-1', { assignments: [{ factoryProjectId: 'fp-2' }] })], 'integration:firebase');
      expect(second).toEqual({ created: [], updated: [created!.id], removed: [] });
      const [moved] = await domain.list(ORG);
      expect(moved).toMatchObject({ assignments: [{ factoryProjectId: 'fp-2' }], toolPolicies: { tools: { delete_documents: 'deny' } } });

      expect(await domain.syncOwned(ORG, 'firebase', [spec('bnd-1', { assignments: [{ factoryProjectId: 'fp-2' }] })], 'x')).toEqual({
        created: [],
        updated: [],
        removed: [],
      });
      expect((await domain.syncOwned(ORG, 'firebase', [], 'x')).removed).toEqual([created!.id]);
      expect(await domain.list(ORG)).toEqual([]);
    });

    it('takes a free name when a person already uses it, and leaves people\'s and other integrations\' servers alone', async () => {
      const { domain } = await makeStore();
      await domain.create(ORG, input({ name: 'db-syncta-57c6a' }), 'user-1');
      await domain.syncOwned(ORG, 'other', [spec('x-1')], 'integration:other');
      await domain.syncOwned(ORG, 'firebase', [spec('bnd-1')], 'integration:firebase');

      const names = (await domain.list(ORG)).map(server => `${server.name}:${server.owner?.integration ?? 'person'}`);
      expect(names.sort()).toEqual(['db-syncta-57c6a-2:other', 'db-syncta-57c6a-3:firebase', 'db-syncta-57c6a:person']);
      await domain.syncOwned(ORG, 'firebase', [], 'integration:firebase');
      expect((await domain.list(ORG)).map(server => server.owner?.integration ?? 'person').sort()).toEqual(['other', 'person']);
    });
  });
});
