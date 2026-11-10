/**
 * The behaviour every `AttachmentBlobStore` must have. A new backend (S3…) runs this same suite:
 *
 *   describeAttachmentBlobStoreContract('S3BlobStore', async () => new S3BlobStore({ … }));
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { AttachmentTooLargeError, readAttachmentBlob } from './blob-store.ts';
import type { AttachmentBlobStore } from './blob-store.ts';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function webStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

export function describeAttachmentBlobStoreContract(name: string, makeStore: () => Promise<AttachmentBlobStore>) {
  describe(`${name} (AttachmentBlobStore contract)`, () => {
    it('stores bytes under their sha256 and reads them back', async () => {
      const store = await makeStore();
      const bytes = new TextEncoder().encode('hello attachments');
      const stored = await store.put(bytes);
      expect(stored).toEqual({ sha256: sha(bytes), size: bytes.byteLength });
      expect(await store.head(stored.sha256)).toEqual({ size: bytes.byteLength });
      const body = await store.get(stored.sha256);
      expect(body).not.toBeNull();
      expect((await readAttachmentBlob(body!)).toString()).toBe('hello attachments');
    });

    it('accepts a chunked web stream', async () => {
      const store = await makeStore();
      const stored = await store.put(webStream([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]));
      expect(stored).toEqual({ sha256: sha(new Uint8Array([1, 2, 3, 4, 5])), size: 5 });
      expect([...(await readAttachmentBlob((await store.get(stored.sha256))!))]).toEqual([1, 2, 3, 4, 5]);
    });

    it('stores identical content once', async () => {
      const store = await makeStore();
      const bytes = new TextEncoder().encode('same');
      const first = await store.put(bytes);
      const second = await store.put(webStream([bytes]));
      expect(second).toEqual(first);
      expect(await store.delete(first.sha256)).toBe(true);
      expect(await store.head(first.sha256)).toBeNull();
    });

    it('rejects content over the limit and keeps nothing', async () => {
      const store = await makeStore();
      const bytes = new Uint8Array(10).fill(7);
      await expect(store.put(webStream([bytes.slice(0, 6), bytes.slice(6)]), { maxBytes: 8 })).rejects.toBeInstanceOf(
        AttachmentTooLargeError,
      );
      expect(await store.head(sha(bytes))).toBeNull();
      await expect(store.put(bytes, { maxBytes: 10 })).resolves.toMatchObject({ size: 10 });
    });

    it('reports a missing key as null and deletes nothing', async () => {
      const store = await makeStore();
      const missing = sha(new TextEncoder().encode('never stored'));
      expect(await store.get(missing)).toBeNull();
      expect(await store.head(missing)).toBeNull();
      expect(await store.delete(missing)).toBe(false);
    });

    it('refuses keys that are not a sha256', async () => {
      const store = await makeStore();
      await expect(store.head('../../etc/passwd')).rejects.toThrow(/Invalid attachment blob key/);
    });
  });
}
