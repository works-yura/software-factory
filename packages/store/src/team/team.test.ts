import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LibSQLFactoryStorage } from '@mastra/libsql';
import { describe, expect, it, onTestFinished } from 'vitest';

import { LocalFileBlobStore } from '../attachments/blob-store.ts';
import { AvatarsStorage } from './avatars.ts';
import { JoinLinksStorage } from './join-links.ts';

async function joinLinks(): Promise<JoinLinksStorage> {
  // A file database, so concurrent joins really race on separate connections' transactions.
  const dir = mkdtempSync(join(tmpdir(), 'join-links-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const backend = new LibSQLFactoryStorage({ id: 'join-links-test', url: `file:${join(dir, 'db.sqlite')}` });
  const domain = backend.registerDomain(new JoinLinksStorage());
  await backend.init();
  return domain;
}

const NEW = {
  organizationId: 'org-1',
  name: 'Engineering',
  role: 'member' as const,
  allowedDomains: ['acme.com'],
  expiresAt: null,
  maxUses: null,
  createdBy: 'ada',
};

describe('JoinLinksStorage', () => {
  it('creates a link with a long random token, lists it per organization and finds it by token', async () => {
    const store = await joinLinks();
    const link = await store.create(NEW);
    await store.create({ ...NEW, organizationId: 'org-2', name: 'Other' });

    expect(link).toMatchObject({ organizationId: 'org-1', name: 'Engineering', role: 'member', allowedDomains: ['acme.com'], uses: 0 });
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await store.list('org-1')).map(row => row.id)).toEqual([link.id]);
    expect((await store.findByToken(link.token))?.id).toBe(link.id);
    expect(await store.get('org-2', link.id)).toBeNull();
  });

  it('counts uses and refuses once the limit is reached', async () => {
    const store = await joinLinks();
    const link = await store.create({ ...NEW, maxUses: 1 });

    expect(await store.takeUse(link.id, new Date())).toMatchObject({ link: { uses: 1 } });
    expect(await store.takeUse(link.id, new Date())).toEqual({ refusal: 'used_up' });
  });

  it('never goes past the limit when people join at the same moment', async () => {
    const store = await joinLinks();
    const link = await store.create({ ...NEW, maxUses: 2 });

    const results = await Promise.all(Array.from({ length: 8 }, () => store.takeUse(link.id, new Date())));

    expect(results.filter(result => 'link' in result)).toHaveLength(2);
    expect(results.filter(result => 'refusal' in result && result.refusal === 'used_up')).toHaveLength(6);
    expect((await store.get('org-1', link.id))?.uses).toBe(2);
  });

  it('refuses an expired link and a revoked one, and a link that does not exist', async () => {
    const store = await joinLinks();
    const expiring = await store.create({ ...NEW, expiresAt: new Date('2026-11-20T00:00:00Z') });
    const revoked = await store.create(NEW);
    await store.revoke('org-1', revoked.id, new Date());

    expect(await store.takeUse(expiring.id, new Date('2026-11-21T00:00:00Z'))).toEqual({ refusal: 'expired' });
    expect(await store.takeUse(expiring.id, new Date('2026-11-19T00:00:00Z'))).toMatchObject({ link: { uses: 1 } });
    expect(await store.takeUse(revoked.id, new Date())).toEqual({ refusal: 'revoked' });
    expect(await store.takeUse('00000000-0000-4000-8000-000000000000', new Date())).toEqual({ refusal: 'not_found' });
  });

  it('revokes only within its organization and keeps the first revocation time', async () => {
    const store = await joinLinks();
    const link = await store.create(NEW);
    const first = new Date('2026-11-15T00:00:00Z');

    expect(await store.revoke('org-2', link.id, first)).toBeNull();
    expect((await store.revoke('org-1', link.id, first))?.revokedAt).toEqual(first);
    expect((await store.revoke('org-1', link.id, new Date('2026-11-16T00:00:00Z')))?.revokedAt).toEqual(first);
  });
});

describe('AvatarsStorage', () => {
  it('keeps the bytes in the blob store and serves them back by id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'avatars-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const blobs = new LocalFileBlobStore({ root: join(dir, 'blobs') });
    await blobs.init();
    const backend = new LibSQLFactoryStorage({ id: 'avatars-test', url: ':memory:' });
    const avatars = backend.registerDomain(new AvatarsStorage(blobs));
    await backend.init();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

    const { id } = await avatars.put('ada', 'image/png', png);

    expect(await avatars.get(id)).toEqual({ type: 'image/png', bytes: png });
    expect(await avatars.get('00000000-0000-4000-8000-000000000000')).toBeNull();
    expect(await avatars.get('../etc/passwd')).toBeNull();
    await expect(avatars.put('ada', 'image/gif' as never, png)).rejects.toThrow(/cannot be image\/gif/);
    await expect(avatars.put('ada', 'image/png', new Uint8Array(300 * 1024))).rejects.toThrow(/at most/);
  });
});
