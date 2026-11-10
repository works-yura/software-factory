import { randomUUID } from 'node:crypto';

import { LibSQLFactoryStorage } from '@mastra/libsql';
import { PgFactoryStorage } from '@mastra/pg';
import { describe, expect, it, onTestFinished } from 'vitest';

import { AttachmentsStorage, cleanAttachmentName } from './base.ts';
import type { CreateAttachmentInput } from './base.ts';

// Set FACTORY_TEST_POSTGRES_URL to a disposable database to also run on PostgreSQL.
const postgresUrl = process.env.FACTORY_TEST_POSTGRES_URL;

const SHA = 'a'.repeat(64);

describe.each(['libsql', ...(postgresUrl ? ['postgres'] : [])])('AttachmentsStorage on %s', backend => {
  async function makeStorage() {
    const storage =
      backend === 'postgres'
        ? new PgFactoryStorage({ id: 'attachments-test', connectionString: postgresUrl! })
        : new LibSQLFactoryStorage({ id: 'attachments-test', url: ':memory:' });
    const attachments = storage.registerDomain(new AttachmentsStorage());
    await storage.init();
    onTestFinished(() => storage.close());
    return { attachments, orgId: `org-${randomUUID()}` };
  }

  const input = (orgId: string, overrides: Partial<CreateAttachmentInput> = {}): CreateAttachmentInput => ({
    orgId,
    factoryProjectId: 'project-1',
    workItemId: 'card-1',
    sessionId: null,
    name: 'brief.pdf',
    mime: 'application/pdf',
    size: 1234,
    sha256: SHA,
    source: 'chat',
    sourceUrl: null,
    addedBy: 'user-1',
    ...overrides,
  });

  it('lists a card’s attachments oldest first and keeps other cards and orgs apart', async () => {
    const { attachments, orgId } = await makeStorage();
    const first = await attachments.create(input(orgId, { addedAt: new Date(1000) }));
    const second = await attachments.create(input(orgId, { name: 'logo.png', mime: 'image/png', addedAt: new Date(2000) }));
    await attachments.create(input(orgId, { workItemId: 'card-2' }));
    await attachments.create(input(`other-${orgId}`));

    const listed = await attachments.listForWorkItem({ orgId, workItemId: 'card-1' });
    expect(listed.map(a => a.id)).toEqual([first.id, second.id]);
    expect(listed[0]).toMatchObject({ name: 'brief.pdf', size: 1234, sha256: SHA, source: 'chat', sessionId: null });
    expect(await attachments.get({ orgId: `other-${orgId}`, id: first.id })).toBeNull();
  });

  it('holds a session’s own attachments when it works no card', async () => {
    const { attachments, orgId } = await makeStorage();
    const own = await attachments.create(input(orgId, { workItemId: null, sessionId: 'session-1' }));
    expect((await attachments.listForSession({ orgId, sessionId: 'session-1' })).map(a => a.id)).toEqual([own.id]);
    await expect(attachments.create(input(orgId, { sessionId: 'session-1' }))).rejects.toThrow(/exactly one/);
    await expect(attachments.create(input(orgId, { workItemId: null }))).rejects.toThrow(/exactly one/);
  });

  it('knows when a blob is still referenced after a delete', async () => {
    const { attachments, orgId } = await makeStorage();
    const a = await attachments.create(input(orgId));
    const b = await attachments.create(input(orgId, { workItemId: 'card-2' }));
    expect(await attachments.delete({ orgId, id: a.id })).toMatchObject({ id: a.id });
    expect(await attachments.isBlobReferenced(SHA)).toBe(true);
    await attachments.delete({ orgId, id: b.id });
    expect(await attachments.isBlobReferenced(SHA)).toBe(false);
    expect(await attachments.delete({ orgId, id: b.id })).toBeNull();
  });

  it('refuses an unknown source', async () => {
    const { attachments, orgId } = await makeStorage();
    await expect(attachments.create(input(orgId, { source: 'ftp' as never }))).rejects.toThrow(/Unknown attachment source/);
  });
});

describe('cleanAttachmentName', () => {
  it('keeps the last path segment without control characters', () => {
    expect(cleanAttachmentName('../../etc/passwd')).toBe('passwd');
    expect(cleanAttachmentName('C:\\Users\\a\\photo.png')).toBe('photo.png');
    expect(cleanAttachmentName('bad\u0000name\n.txt')).toBe('badname.txt');
    expect(cleanAttachmentName('..')).toBe('file');
    expect(cleanAttachmentName('   ')).toBe('file');
  });

  it('cuts long names keeping the extension', () => {
    const name = cleanAttachmentName(`${'x'.repeat(300)}.pdf`);
    expect(name).toHaveLength(200);
    expect(name.endsWith('.pdf')).toBe(true);
  });
});
