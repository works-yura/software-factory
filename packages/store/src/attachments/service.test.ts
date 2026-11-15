import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LibSQLFactoryStorage } from '@mastra/libsql';
import { describe, expect, it, onTestFinished } from 'vitest';

import { AttachmentsStorage } from './base.ts';
import { AttachmentTooLargeError, LocalFileBlobStore, readAttachmentBlob } from './blob-store.ts';
import { isInlineAttachmentMime, resolveAttachmentMime } from './mime.ts';
import { attachmentSandboxPath, AttachmentService } from './service.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function makeService(maxBytes?: number, otherReferences?: ReadonlyArray<(sha256: string) => Promise<boolean>>) {
  const root = await mkdtemp(join(tmpdir(), 'factory-attachments-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const blobs = new LocalFileBlobStore({ root });
  await blobs.init();
  const storage = new LibSQLFactoryStorage({ id: 'attachments-service-test', url: ':memory:' });
  const records = storage.registerDomain(new AttachmentsStorage());
  await storage.init();
  onTestFinished(() => storage.close());
  return {
    service: new AttachmentService({ records, blobs, ...(maxBytes ? { maxBytes } : {}), ...(otherReferences ? { otherReferences } : {}) }),
    blobs,
    records,
  };
}

const card = { workItemId: 'card-1', factoryProjectId: 'project-1' };

describe('AttachmentService', () => {
  it('ingests a file once per content, sniffs its type and serves it back', async () => {
    const { service, blobs } = await makeService();
    const first = await service.ingest({
      orgId: 'org-1',
      owner: card,
      name: 'screen.bin',
      declaredMime: 'application/octet-stream',
      body: PNG,
      source: 'chat',
      addedBy: 'user-1',
    });
    const second = await service.ingest({
      orgId: 'org-1',
      owner: { sessionId: 'session-1', factoryProjectId: null },
      name: 'again.png',
      body: PNG,
      source: 'comment',
      addedBy: 'user-1',
    });
    expect(first).toMatchObject({ mime: 'image/png', size: PNG.length, workItemId: 'card-1', source: 'chat' });
    expect(second.sha256).toBe(first.sha256);

    const opened = await service.open({ orgId: 'org-1', id: first.id });
    expect([...(await readAttachmentBlob(opened!.content))]).toEqual([...PNG]);

    await service.remove({ orgId: 'org-1', id: first.id });
    expect(await blobs.head(first.sha256)).not.toBeNull();
    await service.remove({ orgId: 'org-1', id: second.id });
    expect(await blobs.head(first.sha256)).toBeNull();
  });

  it('keeps bytes another owner of the blob store still names (the assistant’s files)', async () => {
    const named = new Set<string>();
    const { service, blobs } = await makeService(undefined, [async sha256 => named.has(sha256)]);
    const record = await service.ingest({ orgId: 'org-1', owner: card, name: 'a.png', body: PNG, source: 'upload', addedBy: 'u' });
    named.add(record.sha256);
    await service.remove({ orgId: 'org-1', id: record.id });
    expect(await blobs.head(record.sha256)).not.toBeNull();

    const again = await service.ingest({ orgId: 'org-1', owner: card, name: 'a.png', body: PNG, source: 'upload', addedBy: 'u' });
    named.clear();
    await service.remove({ orgId: 'org-1', id: again.id });
    expect(await blobs.head(record.sha256)).toBeNull();
  });

  it('keeps nothing when a file is over the limit', async () => {
    const { service, records } = await makeService(4);
    await expect(
      service.ingest({ orgId: 'org-1', owner: card, name: 'big.png', body: PNG, source: 'chat', addedBy: 'user-1' }),
    ).rejects.toBeInstanceOf(AttachmentTooLargeError);
    expect(await records.listForWorkItem({ orgId: 'org-1', workItemId: 'card-1' })).toEqual([]);
  });

  it('refuses a nonsensical limit', async () => {
    const { records, blobs } = await makeService();
    expect(() => new AttachmentService({ records, blobs, maxBytes: 0 })).toThrow(/positive integer/);
  });

  it('places attachments under .factory/attachments with a short id prefix', () => {
    expect(attachmentSandboxPath({ id: '12345678-aaaa-4bbb-8ccc-000000000000', name: '../brief.pdf' })).toBe(
      '.factory/attachments/12345678-brief.pdf',
    );
  });
});

describe('resolveAttachmentMime', () => {
  it('prefers the signature, then the declared type, then the extension', () => {
    expect(resolveAttachmentMime({ head: PNG, declared: 'text/html', name: 'x.html' })).toBe('image/png');
    expect(resolveAttachmentMime({ head: new Uint8Array([1]), declared: 'text/csv', name: 'x.bin' })).toBe('text/csv');
    expect(resolveAttachmentMime({ head: new Uint8Array([1]), declared: null, name: 'notes.md' })).toBe('text/markdown');
    expect(resolveAttachmentMime({ head: new Uint8Array([1]), declared: 'bogus', name: 'x' })).toBe(
      'application/octet-stream',
    );
  });

  it('keeps an Office type for zip-signed content', () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]);
    expect(resolveAttachmentMime({ head: zip, declared: null, name: 'spec.docx' })).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(resolveAttachmentMime({ head: zip, declared: null, name: 'bundle' })).toBe('application/zip');
  });

  it('renders only safe types inline', () => {
    expect(isInlineAttachmentMime('image/png')).toBe(true);
    expect(isInlineAttachmentMime('image/svg+xml')).toBe(false);
    expect(isInlineAttachmentMime('text/html')).toBe(false);
  });
});
