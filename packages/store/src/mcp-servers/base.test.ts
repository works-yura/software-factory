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

  it('merges secrets by kind', () => {
    expect(
      mergeMcpSecrets({ env: { A: '1' }, headers: { H: 'x' }, files: {} }, { headers: { H: null }, files: { F: 'f' } }),
    ).toEqual({ env: { A: '1' }, headers: {}, files: { F: 'f' } });
  });
});
