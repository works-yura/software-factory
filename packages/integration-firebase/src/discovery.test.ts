import { describe, expect, it } from 'vitest';

import { googleCloudAccountProvider } from './credentials.ts';
import { listFirestoreDatabases, listGoogleCloudProjects } from './discovery.ts';
import { GOOGLE_TOKEN_URI } from './service-account.ts';
import type { FetchLike } from './service-account.ts';
import { saveAccount } from './settings.ts';
import { fakeServiceAccountKey, memoryIntegrationStorage } from './testing.ts';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const DENIED = { error: { code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } };

/** Google for the two lookups: projects:search (paged) and a project's databases. */
function google(options: { projects?: number; databases?: number; pages?: unknown[]; dbs?: unknown } = {}) {
  const urls: string[] = [];
  const scopes: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    urls.push(url);
    if (url === GOOGLE_TOKEN_URI) {
      const assertion = new URLSearchParams(String(init?.body)).get('assertion') ?? '';
      const claims = JSON.parse(Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString()) as { scope?: string };
      scopes.push(claims.scope ?? '');
      return json(200, { access_token: 'ya29.fake', expires_in: 3600, token_type: 'Bearer' });
    }
    if (url.startsWith('https://cloudresourcemanager.googleapis.com/v3/projects:search')) {
      if (options.projects) return json(options.projects, DENIED);
      const token = new URL(url).searchParams.get('pageToken');
      const pages = options.pages ?? [];
      return json(200, pages[token ? Number(token) : 0] ?? {});
    }
    if (url.startsWith('https://firestore.googleapis.com/v1/projects/')) {
      if (options.databases) return json(options.databases, DENIED);
      return json(200, options.dbs ?? {});
    }
    return json(404, { error: { code: 404, message: `No fake for ${url}` } });
  };
  return { fetch, urls, scopes };
}

const key = fakeServiceAccountKey({ project_id: 'syncta-57c6a' });

describe('listGoogleCloudProjects', () => {
  it('lists the active projects the account sees across pages, its own project first', async () => {
    const fake = google({
      pages: [
        { projects: [{ projectId: 'bookfate-prod', displayName: 'BookFate Prod', state: 'ACTIVE' }, { projectId: 'old', state: 'DELETE_REQUESTED' }], nextPageToken: '1' },
        { projects: [{ projectId: 'syncta-57c6a', displayName: 'Syncta', state: 'ACTIVE' }] },
      ],
    });
    const result = await listGoogleCloudProjects(key, { fetch: fake.fetch });
    expect(result).toEqual({
      items: [{ value: 'syncta-57c6a', label: 'Syncta' }, { value: 'bookfate-prod', label: 'BookFate Prod' }],
      default: 'syncta-57c6a',
    });
    expect(fake.scopes).toEqual(['https://www.googleapis.com/auth/cloud-platform.read-only']);
    expect(fake.urls.filter(url => url.includes('projects:search'))).toHaveLength(2);
  });

  it('still offers the key’s own project when the search is refused, naming what to grant', async () => {
    const result = await listGoogleCloudProjects(key, { fetch: google({ projects: 403 }).fetch });
    expect(result.items).toEqual([{ value: 'syncta-57c6a' }]);
    expect(result.default).toBe('syncta-57c6a');
    expect(result.denied).toMatchObject({ role: 'roles/datastore.viewer' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE KEY');
  });
});

describe('listFirestoreDatabases', () => {
  it('lists a project’s databases by id, (default) first', async () => {
    const fake = google({
      dbs: {
        databases: [
          { name: 'projects/syncta-57c6a/databases/analytics', type: 'FIRESTORE_NATIVE', locationId: 'eur3' },
          { name: 'projects/syncta-57c6a/databases/(default)', type: 'FIRESTORE_NATIVE', locationId: 'eur3' },
        ],
      },
    });
    const result = await listFirestoreDatabases(key, 'syncta-57c6a', { fetch: fake.fetch });
    expect(result).toEqual({
      items: [{ value: '(default)', detail: 'eur3' }, { value: 'analytics', detail: 'eur3' }],
      default: '(default)',
    });
    expect(fake.urls).toContain('https://firestore.googleapis.com/v1/projects/syncta-57c6a/databases');
    expect(fake.scopes).toEqual(['https://www.googleapis.com/auth/datastore']);
  });

  it('offers (default) with a hint naming Cloud Datastore Viewer when listing is refused', async () => {
    const result = await listFirestoreDatabases(key, 'syncta-57c6a', { fetch: google({ databases: 403 }).fetch });
    expect(result).toMatchObject({ items: [{ value: '(default)' }], default: '(default)', denied: { role: 'roles/datastore.viewer' } });
  });
});

describe('googleCloudAccountProvider.discover', () => {
  it('looks up with the chosen account, defaults the database project to the key’s, and answers for a missing account', async () => {
    const storage = memoryIntegrationStorage();
    const account = await saveAccount(storage as never, 'org-1', 'u1', { name: 'Syncta', key });
    const fake = google({ dbs: { databases: [{ name: 'projects/syncta-57c6a/databases/(default)' }] } });
    const provider = googleCloudAccountProvider(storage as never, { fetch: fake.fetch });

    expect(await provider.discover!('org-1', account.id, 'firestore-databases', {})).toEqual({ items: [{ value: '(default)' }], default: '(default)' });
    expect(fake.urls).toContain('https://firestore.googleapis.com/v1/projects/syncta-57c6a/databases');
    expect(await provider.discover!('org-1', 'acc-missing', 'google-cloud-projects', {})).toMatchObject({ items: [], denied: {} });
  });
});
