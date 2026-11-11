import { describe, expect, it } from 'vitest';

import { googleCloudAccountProvider } from './credentials.ts';
import { newBindingId, saveAccount, saveBinding } from './settings.ts';
import { fakeServiceAccountKey, memoryIntegrationStorage } from './testing.ts';

describe('googleCloudAccountProvider', () => {
  it('lists the organization’s accounts without keys, lends a key only through readSecret, and suggests the Factory’s project', async () => {
    const storage = memoryIntegrationStorage();
    const key = fakeServiceAccountKey({ project_id: 'syncta-57c6a', client_email: 'factory@syncta-57c6a.iam.gserviceaccount.com' });
    const account = await saveAccount(storage as never, 'org-1', 'u1', { name: 'Syncta', key });
    await saveBinding(storage as never, 'org-1', {
      id: newBindingId(),
      factoryProjectId: 'syncts',
      accountId: account.id,
      projectId: 'syncta-57c6a',
      logs: true,
      crashes: false,
      apps: [],
    });
    const provider = googleCloudAccountProvider(storage as never);

    const options = await provider.list('org-1');
    expect(options).toEqual([{ id: account.id, name: 'Syncta', detail: 'factory@syncta-57c6a.iam.gserviceaccount.com' }]);
    expect(JSON.stringify(options)).not.toContain('PRIVATE KEY');

    expect(JSON.parse((await provider.readSecret('org-1', account.id))!)).toMatchObject({ client_email: key.client_email });
    expect(await provider.readSecret('org-1', 'acc-missing')).toBeNull();

    expect(await provider.suggest!('org-1', 'syncts')).toEqual({ 'google-cloud-project': 'syncta-57c6a' });
    expect(await provider.suggest!('org-1', 'post-airborne')).toEqual({});
  });
});
