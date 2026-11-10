/**
 * Where attachment bytes live. Content-addressed by sha256: the same file uploaded twice is stored
 * once, and the hash is the key. Records (name, card, source…) live in `AttachmentsStorage`; this
 * seam only moves bytes, so an S3 (or any object-store) implementation drops in without touching
 * callers. Mastra's `BlobStore` is not reused: it keeps text content in the database and has no
 * streams, while attachments are arbitrary binaries of many megabytes.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, constants, mkdir, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

/** What `put` accepts: bytes in memory, a web `ReadableStream` (e.g. `File.stream()`), or any byte iterable. */
export type AttachmentBlobBody = Uint8Array | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

export interface StoredAttachmentBlob {
  /** Lowercase hex sha256 of the content; the blob's key. */
  sha256: string;
  size: number;
}

export interface AttachmentBlobPutOptions {
  /** Reject (and keep nothing) once the content passes this many bytes. */
  maxBytes?: number;
}

export interface AttachmentBlobStore {
  /** Short name for logs, e.g. `local` or `s3`. */
  readonly kind: string;
  /** Prepare the backend; throws when it is misconfigured or unreachable. */
  init(): Promise<void>;
  /** Store the content (once per distinct content) and return its key. */
  put(body: AttachmentBlobBody, options?: AttachmentBlobPutOptions): Promise<StoredAttachmentBlob>;
  /** The content, or `null` when no blob has this key. */
  get(sha256: string): Promise<ReadableStream<Uint8Array> | null>;
  head(sha256: string): Promise<{ size: number } | null>;
  /** False when there was nothing to delete. Callers delete only once no record references the key. */
  delete(sha256: string): Promise<boolean>;
}

export class AttachmentTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`Attachment exceeds the ${maxBytes}-byte limit.`);
    this.name = 'AttachmentTooLargeError';
    this.maxBytes = maxBytes;
  }
}

const SHA256_RE = /^[0-9a-f]{64}$/;

export function assertAttachmentBlobKey(sha256: string): void {
  if (!SHA256_RE.test(sha256)) throw new Error(`Invalid attachment blob key: ${JSON.stringify(sha256)}`);
}

async function* chunksOf(body: AttachmentBlobBody): AsyncIterable<Uint8Array> {
  if (body instanceof Uint8Array) {
    yield body;
    return;
  }
  yield* body as AsyncIterable<Uint8Array>;
}

/**
 * Blobs as files under one directory: `<root>/<sha[0:2]>/<sha>`. Writes go to `<root>/.tmp` first
 * and are renamed into place once hashed, so a reader never sees a partial file and a failed or
 * oversized upload leaves nothing behind.
 */
export class LocalFileBlobStore implements AttachmentBlobStore {
  readonly kind = 'local';
  readonly root: string;

  constructor(options: { root: string }) {
    if (!options.root || !isAbsolute(options.root)) {
      throw new Error(`LocalFileBlobStore needs an absolute root directory, got ${JSON.stringify(options.root)}.`);
    }
    this.root = options.root;
  }

  async init(): Promise<void> {
    await mkdir(join(this.root, '.tmp'), { recursive: true });
    await access(this.root, constants.R_OK | constants.W_OK);
  }

  /** Where the blob's file is (or would be); for same-host consumers that can copy it directly. */
  pathFor(sha256: string): string {
    assertAttachmentBlobKey(sha256);
    return join(this.root, sha256.slice(0, 2), sha256);
  }

  async put(body: AttachmentBlobBody, options: AttachmentBlobPutOptions = {}): Promise<StoredAttachmentBlob> {
    const tmp = join(this.root, '.tmp', randomUUID());
    const hash = createHash('sha256');
    let size = 0;
    const out = createWriteStream(tmp, { flags: 'wx' });
    try {
      for await (const chunk of chunksOf(body)) {
        size += chunk.byteLength;
        if (options.maxBytes !== undefined && size > options.maxBytes) {
          throw new AttachmentTooLargeError(options.maxBytes);
        }
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise<void>(resolve => out.once('drain', resolve));
      }
      out.end();
      await finished(out);
      const sha256 = hash.digest('hex');
      await mkdir(join(this.root, sha256.slice(0, 2)), { recursive: true });
      // Same content already stored: the rename replaces identical bytes atomically.
      await rename(tmp, this.pathFor(sha256));
      return { sha256, size };
    } catch (error) {
      out.destroy();
      await rm(tmp, { force: true });
      throw error;
    }
  }

  async get(sha256: string): Promise<ReadableStream<Uint8Array> | null> {
    if (!(await this.head(sha256))) return null;
    return Readable.toWeb(createReadStream(this.pathFor(sha256))) as ReadableStream<Uint8Array>;
  }

  async head(sha256: string): Promise<{ size: number } | null> {
    try {
      const info = await stat(this.pathFor(sha256));
      return info.isFile() ? { size: info.size } : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(sha256: string): Promise<boolean> {
    if (!(await this.head(sha256))) return false;
    await rm(this.pathFor(sha256), { force: true });
    return true;
  }
}

/** Read a whole blob stream into memory (tests, small files). */
export async function readAttachmentBlob(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) parts.push(chunk);
  return Buffer.concat(parts);
}
