/** Credential accounts over a real backend (libsql `:memory:`). */

import { LibSQLFactoryStorage } from '@mastra/libsql';
import { describe, expect, it, onTestFinished } from 'vitest';

import { createFactorySecretEncryption } from '../secret-encryption.ts';
import type { FactorySecretEncryption } from '../secret-encryption.ts';
import { ModelCredentialsStorage } from './base.ts';

async function makeStore(encryption?: FactorySecretEncryption) {
  const backend = new LibSQLFactoryStorage({ id: 'credential-accounts-test', url: ':memory:' });
  const domain = backend.registerDomain(new ModelCredentialsStorage(encryption));
  await backend.init();
  onTestFinished(() => backend.close());
  return { domain, backend };
}

const apiKey = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaa1111';
const setupToken = 'sk-ant-oat01-bbbbbbbbbbbbbbbbbbbb2222';

describe('ModelCredentialsStorage accounts', () => {
  it('adds accounts and lists them by priority, then age, without secrets', async () => {
    const { domain } = await makeStore();
    const second = await domain.addAccount({
      orgId: 'org1',
      provider: 'anthropic',
      label: 'Team key',
      kind: 'api_key',
      secret: apiKey,
      createdBy: 'admin',
      priority: 5,
    });
    const first = await domain.addAccount({
      orgId: 'org1',
      provider: 'anthropic',
      label: 'Alice Max',
      kind: 'subscription',
      ownerUserId: 'alice',
      secret: setupToken,
      createdBy: 'alice',
    });
    await domain.addAccount({
      orgId: 'org2',
      provider: 'anthropic',
      label: 'Other org',
      kind: 'api_key',
      secret: apiKey,
      createdBy: 'x',
    });

    const listed = await domain.listAccounts('org1', 'anthropic');
    expect(listed.map(account => account.id)).toEqual([first.id, second.id]);
    expect(listed[0]).toMatchObject({ kind: 'subscription', ownerUserId: 'alice', hint: '2222', disabled: false, priority: 0 });
    expect(listed[1]).toMatchObject({ kind: 'api_key', hint: '1111', priority: 5 });
    expect(listed[1]).not.toHaveProperty('ownerUserId');
    expect(JSON.stringify(listed)).not.toContain(apiKey);
    expect(await domain.listAccounts('org1', 'openai')).toEqual([]);
    expect(await domain.getAccountSecret('org1', first.id)).toBe(setupToken);
    // Another organization cannot read it.
    expect(await domain.getAccountSecret('org2', first.id)).toBeUndefined();
  });

  it('refuses a subscription without its owner, and never records an owner on an API key', async () => {
    const { domain } = await makeStore();
    await expect(
      domain.addAccount({ orgId: 'org1', provider: 'anthropic', label: 'x', kind: 'subscription', secret: setupToken, createdBy: 'a' }),
    ).rejects.toThrow(/person it belongs to/);
    const key = await domain.addAccount({
      orgId: 'org1',
      provider: 'anthropic',
      label: 'k',
      kind: 'api_key',
      ownerUserId: 'alice',
      secret: apiKey,
      createdBy: 'a',
    });
    expect(key.ownerUserId).toBeUndefined();
  });

  it('marks limits and failures, and a new secret or turning it on clears them', async () => {
    const { domain } = await makeStore();
    const account = await domain.addAccount({
      orgId: 'org1',
      provider: 'anthropic',
      label: 'k',
      kind: 'api_key',
      secret: apiKey,
      createdBy: 'a',
    });
    const until = new Date('2026-10-28T18:00:00Z');

    await domain.markAccountLimited('org1', account.id, { until, error: 'x'.repeat(2000) });
    let stored = await domain.getAccount('org1', account.id);
    expect(stored?.limitedUntil).toEqual(until);
    expect(stored?.lastError?.length).toBeLessThanOrEqual(501);

    await domain.markAccountFailed('org1', account.id, 'Invalid API key');
    stored = await domain.getAccount('org1', account.id);
    expect(stored).toMatchObject({ disabled: true, lastError: 'Invalid API key' });

    await domain.updateAccount('org1', account.id, { disabled: false });
    stored = await domain.getAccount('org1', account.id);
    expect(stored).toMatchObject({ disabled: false });
    expect(stored?.limitedUntil).toBeUndefined();
    expect(stored?.lastError).toBeUndefined();

    await domain.markAccountFailed('org1', account.id, 'Invalid API key');
    const replaced = await domain.updateAccount('org1', account.id, { secret: 'sk-ant-api03-cccccccccccccccccccc3333' });
    expect(replaced).toMatchObject({ disabled: false, hint: '3333' });
    expect(await domain.getAccountSecret('org1', account.id)).toBe('sk-ant-api03-cccccccccccccccccccc3333');

    const used = new Date('2026-10-28T12:00:00Z');
    await domain.markAccountUsed('org1', account.id, used);
    expect((await domain.getAccount('org1', account.id))?.lastUsedAt).toEqual(used);
  });

  it('updates and removes only within the organization', async () => {
    const { domain } = await makeStore();
    const account = await domain.addAccount({
      orgId: 'org1',
      provider: 'anthropic',
      label: 'k',
      kind: 'api_key',
      secret: apiKey,
      createdBy: 'a',
    });
    expect(await domain.updateAccount('org2', account.id, { label: 'stolen' })).toBeUndefined();
    expect(await domain.removeAccount('org2', account.id)).toBe(false);
    expect(await domain.updateAccount('org1', account.id, { label: 'Renamed', priority: -1 })).toMatchObject({
      label: 'Renamed',
      priority: -1,
    });
    expect(await domain.removeAccount('org1', account.id)).toBe(true);
    expect(await domain.listAccounts('org1')).toEqual([]);
  });

  it('encrypts secrets at rest', async () => {
    const encryption = createFactorySecretEncryption({ primary: { id: 'v1', key: new Uint8Array(32).fill(7) } });
    const { domain, backend } = await makeStore(encryption);
    await domain.addAccount({ orgId: 'org1', provider: 'anthropic', label: 'k', kind: 'api_key', secret: apiKey, createdBy: 'a' });
    const row = await backend.ops.findOne<{ data: unknown }>('model_credential_accounts', { org_id: 'org1' });
    expect(JSON.stringify(row?.data)).not.toContain(apiKey);
    const [account] = await domain.listAccounts('org1');
    expect(await domain.getAccountSecret('org1', account!.id)).toBe(apiKey);
  });
});
