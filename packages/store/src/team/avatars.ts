/**
 * Avatars of people and organizations (ADR-0045): the bytes in the attachment blob store, a
 * `factory_avatars` row naming them. The type and size limits are checked before anything is kept.
 */
import { AVATAR_MAX_BYTES, AVATAR_TYPES } from '@factory/access';
import type { AvatarStore, AvatarType } from '@factory/access';
import { FactoryStorageDomain } from '@mastra/core/storage';
import type { CollectionSchema } from '@mastra/core/storage';

import { readAttachmentBlob } from '../attachments/blob-store.ts';
import type { AttachmentBlobStore } from '../attachments/blob-store.ts';

export const AVATARS_SCHEMA: CollectionSchema = {
  name: 'factory_avatars',
  columns: {
    id: { type: 'uuid-pk' },
    owner_user_id: { type: 'text' },
    type: { type: 'text' },
    sha256: { type: 'text' },
    size: { type: 'integer' },
    created_at: { type: 'timestamp' },
  },
};

interface AvatarDbRow extends Record<string, unknown> {
  id: string;
  owner_user_id: string;
  type: string;
  sha256: string;
  size: number;
  created_at: Date;
}

export class AvatarsStorage extends FactoryStorageDomain implements AvatarStore {
  readonly #blobs: AttachmentBlobStore;

  constructor(blobs: AttachmentBlobStore) {
    super('avatars');
    this.#blobs = blobs;
  }

  async init(): Promise<void> {
    await this.ensureCollections([AVATARS_SCHEMA]);
  }

  async dangerouslyClearAll(): Promise<void> {
    await this.ops.deleteMany('factory_avatars', {});
  }

  async put(ownerUserId: string, type: AvatarType, bytes: Uint8Array): Promise<{ id: string }> {
    if (!(AVATAR_TYPES as readonly string[]).includes(type)) throw new Error(`Avatars cannot be ${type}.`);
    if (bytes.length > AVATAR_MAX_BYTES) throw new Error(`Avatars are at most ${AVATAR_MAX_BYTES} bytes.`);
    const blob = await this.#blobs.put(bytes, { maxBytes: AVATAR_MAX_BYTES });
    const row = await this.ops.insertOne<AvatarDbRow>('factory_avatars', {
      owner_user_id: ownerUserId,
      type,
      sha256: blob.sha256,
      size: blob.size,
      created_at: new Date(),
    });
    return { id: row.id };
  }

  async get(id: string): Promise<{ type: AvatarType; bytes: Uint8Array } | null> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    const row = await this.ops.findOne<AvatarDbRow>('factory_avatars', { id });
    if (!row) return null;
    const stream = await this.#blobs.get(row.sha256);
    if (!stream) throw new Error(`Avatar ${id} names blob ${row.sha256}, which the blob store does not have.`);
    return { type: row.type as AvatarType, bytes: new Uint8Array(await readAttachmentBlob(stream)) };
  }
}
