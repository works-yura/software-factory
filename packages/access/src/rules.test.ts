import { describe, expect, it } from 'vitest';

import { emailDomainAllowed, joinLinkStatus, joinRefusal, normalizeDomains, parseAvatarDataUrl } from './rules.ts';
import type { JoinLink } from './interfaces.ts';

const LINK: JoinLink = {
  id: 'l1',
  organizationId: 'org',
  token: 't',
  name: 'Acme',
  role: 'member',
  allowedDomains: ['acme.com'],
  expiresAt: null,
  maxUses: null,
  uses: 0,
  createdBy: 'u',
  createdAt: new Date('2026-11-01T00:00:00Z'),
  revokedAt: null,
};

describe('join link rules', () => {
  it('matches email domains exactly', () => {
    expect(emailDomainAllowed('dan@acme.com', ['acme.com'])).toBe(true);
    expect(emailDomainAllowed('dan@ACME.COM', ['acme.com'])).toBe(true);
    expect(emailDomainAllowed('dan@research.acme.com', ['acme.com'])).toBe(false);
    expect(emailDomainAllowed('dan@notacme.com', ['acme.com'])).toBe(false);
    expect(emailDomainAllowed('anyone@anywhere.io', [])).toBe(true);
  });

  it('normalizes domains and refuses malformed ones', () => {
    expect(normalizeDomains(['Acme.com', '@acme.com', ' '])).toEqual(['acme.com']);
    expect(() => normalizeDomains(['acme'])).toThrow(/Not an email domain/);
    expect(() => normalizeDomains(['acme.com/path'])).toThrow();
  });

  it('reads a status: revoked before expired before used up', () => {
    const now = new Date('2026-11-15T00:00:00Z');
    const past = new Date('2026-11-14T00:00:00Z');
    expect(joinLinkStatus({ revokedAt: past, expiresAt: past, maxUses: 1, uses: 1 }, now)).toBe('revoked');
    expect(joinLinkStatus({ revokedAt: null, expiresAt: past, maxUses: 1, uses: 1 }, now)).toBe('expired');
    expect(joinLinkStatus({ revokedAt: null, expiresAt: null, maxUses: 1, uses: 1 }, now)).toBe('used_up');
    expect(joinLinkStatus({ revokedAt: null, expiresAt: null, maxUses: null, uses: 99 }, now)).toBe('active');
  });

  it('refuses an unverified email and a foreign domain', () => {
    expect(joinRefusal(LINK, { email: 'dan@acme.com', emailVerified: true })).toBeNull();
    expect(joinRefusal(LINK, { email: 'dan@acme.com', emailVerified: false })).toBe('email_not_verified');
    expect(joinRefusal(LINK, { email: 'eve@evil.com', emailVerified: true })).toBe('domain_not_allowed');
  });
});

describe('avatars', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  it('takes a PNG, JPEG or WebP whose bytes are that image', () => {
    expect(parseAvatarDataUrl(`data:image/png;base64,${png.toString('base64')}`).type).toBe('image/png');
  });

  it('refuses other types, mismatched content and images over 256 KB', () => {
    expect(() => parseAvatarDataUrl('data:image/gif;base64,R0lGODlhAQABAAAAACw=')).toThrow(/PNG, JPEG or WebP/);
    expect(() => parseAvatarDataUrl(`data:image/png;base64,${Buffer.from('not a png').toString('base64')}`)).toThrow(/does not match/);
    const big = Buffer.concat([png, Buffer.alloc(300 * 1024)]);
    expect(() => parseAvatarDataUrl(`data:image/png;base64,${big.toString('base64')}`)).toThrow(/limit is 256 KB/);
  });
});
