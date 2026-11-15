/** Join-link and avatar rules shared by the store, the routes and their tests. */
import { AVATAR_MAX_BYTES, AVATAR_TYPES } from './interfaces.ts';
import type { AvatarType, JoinLink, JoinLinkStatus } from './interfaces.ts';

const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const JOIN_LINK_NAME_MAX = 80;
export const JOIN_LINK_DOMAINS_MAX = 20;
export const JOIN_LINK_MAX_USES_LIMIT = 10_000;

/** A rule a request broke, with a stable code the UI explains. */
export class AccessRuleError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'AccessRuleError';
  }
}

export function joinLinkStatus(
  link: Pick<JoinLink, 'revokedAt' | 'expiresAt' | 'maxUses' | 'uses'>,
  now: Date = new Date(),
): JoinLinkStatus {
  if (link.revokedAt) return 'revoked';
  if (link.expiresAt && link.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (link.maxUses !== null && link.uses >= link.maxUses) return 'used_up';
  return 'active';
}

/** Lowercase, trimmed, deduplicated; a malformed domain is refused, never dropped. */
export function normalizeDomains(domains: readonly string[]): string[] {
  const normalized = [...new Set(domains.map(domain => domain.trim().toLowerCase().replace(/^@/, '')).filter(Boolean))];
  const invalid = normalized.filter(domain => !DOMAIN_PATTERN.test(domain));
  if (invalid.length > 0) throw new AccessRuleError('invalid_email_domain', `Not an email domain: ${invalid.join(', ')}`);
  if (normalized.length > JOIN_LINK_DOMAINS_MAX) {
    throw new AccessRuleError('too_many_email_domains', `A join link allows at most ${JOIN_LINK_DOMAINS_MAX} domains.`);
  }
  return normalized;
}

/** Whether the email's domain is one the link allows: an exact match; an empty list allows any. */
export function emailDomainAllowed(email: string, allowedDomains: readonly string[]): boolean {
  if (allowedDomains.length === 0) return true;
  const domain = email.trim().toLowerCase().split('@').pop() ?? '';
  return allowedDomains.includes(domain);
}

/** Why a person cannot join with a link right now, or `null`. */
export type JoinRefusal = Exclude<JoinLinkStatus, 'active'> | 'domain_not_allowed' | 'email_not_verified';

export function joinRefusal(
  link: JoinLink,
  person: { email: string; emailVerified: boolean },
  now: Date = new Date(),
): JoinRefusal | null {
  const status = joinLinkStatus(link, now);
  if (status !== 'active') return status;
  if (!person.emailVerified) return 'email_not_verified';
  if (!emailDomainAllowed(person.email, link.allowedDomains)) return 'domain_not_allowed';
  return null;
}

/** A `data:` URL of a png, jpeg or webp image within the size limit whose bytes are that image. */
export function parseAvatarDataUrl(dataUrl: string): { type: AvatarType; bytes: Uint8Array } {
  const match = /^data:([a-z/+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new AccessRuleError('invalid_avatar', 'The avatar must be a base64 data URL.');
  const type = match[1] as AvatarType;
  if (!(AVATAR_TYPES as readonly string[]).includes(type)) {
    throw new AccessRuleError('avatar_type', 'The avatar must be a PNG, JPEG or WebP image.');
  }
  const bytes = new Uint8Array(Buffer.from(match[2] ?? '', 'base64'));
  if (bytes.length === 0) throw new AccessRuleError('invalid_avatar', 'The avatar is empty.');
  if (bytes.length > AVATAR_MAX_BYTES) {
    throw new AccessRuleError(
      'avatar_too_large',
      `The avatar is ${Math.ceil(bytes.length / 1024)} KB; the limit is ${AVATAR_MAX_BYTES / 1024} KB.`,
    );
  }
  if (!imageMagicMatches(type, bytes)) {
    throw new AccessRuleError('avatar_type', 'The avatar content does not match its image type.');
  }
  return { type, bytes };
}

function imageMagicMatches(type: AvatarType, bytes: Uint8Array): boolean {
  const head = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (type === 'image/png') return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte);
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return head(0, 4) === 'RIFF' && head(8, 12) === 'WEBP';
}
