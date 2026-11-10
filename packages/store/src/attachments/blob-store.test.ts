import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { describeAttachmentBlobStoreContract } from './blob-store-contract.ts';
import { AttachmentTooLargeError, LocalFileBlobStore } from './blob-store.ts';

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'factory-blobs-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}

describeAttachmentBlobStoreContract('LocalFileBlobStore', async () => {
  const store = new LocalFileBlobStore({ root: await tempRoot() });
  await store.init();
  return store;
});

describe('LocalFileBlobStore', () => {
  it('refuses a relative or empty root', () => {
    expect(() => new LocalFileBlobStore({ root: 'attachments' })).toThrow(/absolute root/);
    expect(() => new LocalFileBlobStore({ root: '' })).toThrow(/absolute root/);
  });

  it('lays blobs out by hash prefix and leaves no temp file after a rejected upload', async () => {
    const root = await tempRoot();
    const store = new LocalFileBlobStore({ root });
    await store.init();
    const { sha256 } = await store.put(new TextEncoder().encode('laid out'));
    expect(store.pathFor(sha256)).toBe(join(root, sha256.slice(0, 2), sha256));
    await expect(store.put(new Uint8Array(32), { maxBytes: 4 })).rejects.toBeInstanceOf(AttachmentTooLargeError);
    expect(await readdir(join(root, '.tmp'))).toEqual([]);
  });
});
