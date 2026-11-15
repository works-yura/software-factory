/**
 * Join links (ADR-0045): an organization's shareable link with a role, allowed email domains, an
 * expiry and a use limit. The `join_links` collection is created at boot like every Factory table;
 * nothing existing changes.
 */
import { randomBytes } from 'node:crypto';

import { joinLinkStatus } from '@factory/access';
import type { AssignableRole, JoinLink, JoinLinkStore, NewJoinLink } from '@factory/access';
import { FactoryStorageDomain } from '@mastra/core/storage';
import type { CollectionSchema } from '@mastra/core/storage';

export const JOIN_LINKS_SCHEMA: CollectionSchema = {
  name: 'join_links',
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    token: { type: 'text' },
    name: { type: 'text' },
    role: { type: 'text' },
    allowed_domains: { type: 'json' },
    expires_at: { type: 'timestamp', nullable: true },
    max_uses: { type: 'integer', nullable: true },
    uses: { type: 'integer', default: 0 },
    created_by: { type: 'text' },
    created_at: { type: 'timestamp' },
    revoked_at: { type: 'timestamp', nullable: true },
  },
  uniqueIndexes: [{ name: 'join_links_token_idx', columns: ['token'] }],
  indexes: [{ name: 'join_links_org_created_idx', columns: ['org_id', 'created_at'] }],
};

interface JoinLinkDbRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  token: string;
  name: string;
  role: string;
  allowed_domains: string[];
  expires_at: Date | null;
  max_uses: number | null;
  uses: number;
  created_by: string;
  created_at: Date;
  revoked_at: Date | null;
}

function date(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value as string | number);
}

function toLink(row: JoinLinkDbRow): JoinLink {
  return {
    id: row.id,
    organizationId: row.org_id,
    token: row.token,
    name: row.name,
    role: row.role as AssignableRole,
    allowedDomains: Array.isArray(row.allowed_domains) ? row.allowed_domains : [],
    expiresAt: date(row.expires_at),
    maxUses: row.max_uses === null || row.max_uses === undefined ? null : Number(row.max_uses),
    uses: Number(row.uses),
    createdBy: row.created_by,
    createdAt: date(row.created_at) ?? new Date(0),
    revokedAt: date(row.revoked_at),
  };
}

export class JoinLinksStorage extends FactoryStorageDomain implements JoinLinkStore {
  constructor() {
    super('join_links');
  }

  async init(): Promise<void> {
    await this.ensureCollections([JOIN_LINKS_SCHEMA]);
  }

  async dangerouslyClearAll(): Promise<void> {
    await this.ops.deleteMany('join_links', {});
  }

  async create(link: NewJoinLink): Promise<JoinLink> {
    const row = await this.ops.insertOne<JoinLinkDbRow>('join_links', {
      org_id: link.organizationId,
      // 32 random bytes: the link is the only thing that admits someone.
      token: randomBytes(32).toString('base64url'),
      name: link.name,
      role: link.role,
      allowed_domains: link.allowedDomains,
      expires_at: link.expiresAt,
      max_uses: link.maxUses,
      uses: 0,
      created_by: link.createdBy,
      created_at: new Date(),
      revoked_at: null,
    });
    return toLink(row);
  }

  async list(organizationId: string): Promise<JoinLink[]> {
    const rows = await this.ops.findMany<JoinLinkDbRow>('join_links', { org_id: organizationId }, { orderBy: [['created_at', 'desc']] });
    return rows.map(toLink);
  }

  async get(organizationId: string, id: string): Promise<JoinLink | null> {
    const row = await this.ops.findOne<JoinLinkDbRow>('join_links', { id, org_id: organizationId });
    return row ? toLink(row) : null;
  }

  async findByToken(token: string): Promise<JoinLink | null> {
    const row = await this.ops.findOne<JoinLinkDbRow>('join_links', { token });
    return row ? toLink(row) : null;
  }

  async revoke(organizationId: string, id: string, at: Date): Promise<JoinLink | null> {
    const row = await this.ops.updateAtomic<JoinLinkDbRow>('join_links', { id, org_id: organizationId }, current =>
      current.revoked_at ? null : { revoked_at: at },
    );
    return row ? toLink(row) : this.get(organizationId, id);
  }

  async takeUse(id: string, now: Date): ReturnType<JoinLinkStore['takeUse']> {
    // The row is locked while the status is read and the count raised, so concurrent joins line up
    // and the last ones find the link used up.
    let refusal: 'expired' | 'revoked' | 'used_up' | undefined;
    const row = await this.ops.updateAtomic<JoinLinkDbRow>('join_links', { id }, current => {
      const status = joinLinkStatus(toLink(current), now);
      if (status !== 'active') {
        refusal = status;
        return null;
      }
      return { uses: Number(current.uses) + 1 };
    });
    if (refusal) return { refusal };
    if (!row) return { refusal: 'not_found' };
    return { link: toLink(row) };
  }
}
