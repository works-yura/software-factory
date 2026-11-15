/**
 * Join links and avatars (ADR-0045: Factory's `/web/org/join-links`, `/web/join/:token`,
 * `/web/avatars`), the person's profile and sessions (better-auth's own account endpoints). Every call is
 * checked on the server; the UI only hides what a role cannot do.
 */
import { translator } from '../../../i18n/t';
import { authApiRequest, OrganizationRequestError } from './organization';
import type { AssignableRole } from './organization';

export type JoinLinkStatus = 'active' | 'expired' | 'revoked' | 'used_up';

export interface JoinLink {
  id: string;
  organizationId: string;
  token: string;
  name: string;
  role: AssignableRole;
  allowedDomains: string[];
  expiresAt: string | null;
  maxUses: number | null;
  uses: number;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
  status: JoinLinkStatus;
}

export interface CreateJoinLinkInput {
  name: string;
  role: AssignableRole;
  allowedDomains: string[];
  expiresAt: string | null;
  maxUses: number | null;
}

export type JoinRefusal = 'expired' | 'revoked' | 'used_up' | 'domain_not_allowed' | 'email_not_verified';

const tk = translator('auth');

export interface JoinLinkPreview {
  organization: { id: string; name: string; logo: string | null };
  role: AssignableRole;
  name: string;
  alreadyMember: boolean;
  refusal: JoinRefusal | null;
}

/** A Factory `/web` call: JSON both ways; a refusal carries the server's `error` code. */
async function webRequest<T>(baseUrl: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Accept: 'application/json', ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    credentials: 'include',
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new OrganizationRequestError(tk('organization.requestFailed', { status: res.status }), res.status);
  }
  if (!res.ok) {
    const error = (data ?? {}) as { message?: string; error?: string };
    throw new OrganizationRequestError(error.message || error.error || tk('organization.requestFailed', { status: res.status }), res.status, error.error);
  }
  return data as T;
}

export function createJoinLink(baseUrl: string, input: CreateJoinLinkInput): Promise<JoinLink> {
  return webRequest(baseUrl, '/web/org/join-links', { body: input });
}

export async function listJoinLinks(baseUrl: string): Promise<JoinLink[]> {
  return (await webRequest<{ joinLinks: JoinLink[] }>(baseUrl, '/web/org/join-links')).joinLinks;
}

export function revokeJoinLink(baseUrl: string, id: string): Promise<JoinLink> {
  return webRequest(baseUrl, `/web/org/join-links/${encodeURIComponent(id)}/revoke`, { body: {} });
}

export function previewJoinLink(baseUrl: string, token: string): Promise<JoinLinkPreview> {
  return webRequest(baseUrl, `/web/join/${encodeURIComponent(token)}`);
}

export function acceptJoinLink(
  baseUrl: string,
  token: string,
): Promise<{ organizationId: string; role: string; alreadyMember: boolean }> {
  return webRequest(baseUrl, `/web/join/${encodeURIComponent(token)}/accept`, { body: {} });
}

/** The link the admin shares: the SPA's own origin, like invitation links. */
export function joinLinkUrl(token: string): string {
  return `${window.location.origin}/join/${encodeURIComponent(token)}`;
}

/** "Never", a number of days, or a date the admin picks; resolved to an ISO time when the link is made. */
export type JoinLinkExpiry = 'never' | '1' | '7' | '30' | 'custom';

export function expiryToIso(expiry: JoinLinkExpiry, customDate: string, now = Date.now()): string | null {
  if (expiry === 'never') return null;
  if (expiry === 'custom') {
    if (!customDate) return null;
    // A date (YYYY-MM-DD) means the end of that day where the admin is.
    return new Date(`${customDate}T23:59:59`).toISOString();
  }
  return new Date(now + Number(expiry) * 24 * 60 * 60 * 1000).toISOString();
}

/** Comma- or space-separated domains as the admin typed them. */
export function parseDomainList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map(domain => domain.trim())
    .filter(Boolean);
}

// ============================================
// Avatars
// ============================================

/** Side of the square an avatar is scaled down to before upload. */
export const AVATAR_SIZE = 256;
export const AVATAR_ACCEPT = 'image/png,image/jpeg,image/webp';

export function uploadAvatar(baseUrl: string, dataUrl: string): Promise<{ id: string; url: string }> {
  return webRequest(baseUrl, '/web/avatars', { body: { dataUrl } });
}

/**
 * The picked image, center-cropped to a square and scaled to {@link AVATAR_SIZE} px, as a WebP (or
 * PNG where the browser cannot encode WebP) data URL.
 */
export async function avatarDataUrl(file: File): Promise<string> {
  if (!AVATAR_ACCEPT.split(',').includes(file.type)) throw new Error('unsupported_type');
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no_canvas');
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      AVATAR_SIZE,
      AVATAR_SIZE,
    );
    const webp = canvas.toDataURL('image/webp', 0.9);
    return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
  } finally {
    bitmap.close();
  }
}

// ============================================
// Profile and sessions (better-auth's own endpoints)
// ============================================

export function updateProfile(baseUrl: string, data: { name?: string; image?: string | null }): Promise<unknown> {
  return authApiRequest(baseUrl, 'update-user', data);
}

export interface SignInSession {
  id: string;
  token: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export function listSessions(baseUrl: string): Promise<SignInSession[]> {
  return authApiRequest(baseUrl, 'list-sessions');
}

export function revokeSession(baseUrl: string, token: string): Promise<unknown> {
  return authApiRequest(baseUrl, 'revoke-session', { token });
}

export function revokeOtherSessions(baseUrl: string): Promise<unknown> {
  return authApiRequest(baseUrl, 'revoke-other-sessions', {});
}

export function currentSession(baseUrl: string): Promise<{ session: { id: string; token: string } } | null> {
  return authApiRequest(baseUrl, 'get-session');
}

/** A readable device from a User-Agent: browser on system, or null when it says nothing usable. */
export function describeUserAgent(userAgent: string | null | undefined): { browser?: string; os?: string; mobile: boolean } | null {
  if (!userAgent) return null;
  const ua = userAgent;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : undefined;
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : undefined;
  if (!browser && !os) return null;
  return { browser, os, mobile: /Mobile|iPhone|Android/.test(ua) };
}

/** An avatar URL as stored (`/web/avatars/<id>` or a provider's absolute URL), ready for `<img>`. */
export function avatarSrc(baseUrl: string, url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  return url.startsWith('/') ? `${baseUrl}${url}` : url;
}
