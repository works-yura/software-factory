/**
 * Downloads into the request's folder (ADR-0051). A link on one of the person's sources' hosts is
 * fetched by that source with the person's own connection (ClickUp's file hosts with the person's
 * token, or the organization's while provably theirs). Any other link is fetched only after the
 * person confirms it, without credentials, and never from this machine or its network.
 *
 * Every download keeps to the file limit and must be a file: an HTML page (a sign-in or an error
 * page) is refused, so a login wall never lands in the workspace as if it were the attachment.
 */
import { isIP } from 'node:net';

import { AssistantError } from './errors.ts';
import { cleanFileName } from './files.ts';

/** Why a URL cannot be fetched without credentials, or `null` when it can be asked about. */
export function publicUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'That is not a URL.';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Only http and https links can be downloaded.';
  if (url.username || url.password) return 'Links with credentials in them are not downloaded.';
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') && !isIP(host)) {
    return 'Links to this machine or its local network are not downloaded.';
  }
  if (isIP(host) && isPrivateAddress(host)) return 'Links to this machine or its local network are not downloaded.';
  return null;
}

/** Loopback, private, link-local, unique-local and unspecified addresses. */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const lower = address.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
  return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
}

/** A file name for what a URL points at: the last path segment, or `download`. */
export function nameFromUrl(raw: string): string {
  try {
    const last = new URL(raw).pathname.split('/').filter(Boolean).pop();
    return cleanFileName(last ? decodeURIComponent(last) : 'download');
  } catch {
    return 'download';
  }
}

/** Refuses a response that is a web page rather than a file. */
export function assertFileResponse(mime: string | null): void {
  const base = mime?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base === 'text/html' || base === 'application/xhtml+xml') {
    throw new AssistantError('not_a_file', 'The link answered with a web page, not a file (a sign-in or an error page?).', 400);
  }
}

/**
 * Fetches a public URL the person approved: no cookies or tokens, redirects followed only to public
 * hosts, at most `maxBytes`, and a file rather than a page.
 */
export async function fetchPublicFile(
  raw: string,
  maxBytes: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ bytes: Uint8Array; mime: string | null }> {
  let url = raw;
  for (let hop = 0; hop < 5; hop += 1) {
    const problem = publicUrlProblem(url);
    if (problem) throw new AssistantError('download_refused', problem, 400);
    const response = await fetchImpl(url, { redirect: 'manual', headers: { Accept: '*/*' } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new AssistantError('download_failed', `The link redirected (${response.status}) without saying where.`, 502);
      url = new URL(location, url).toString();
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new AssistantError('download_failed', `The link answered ${response.status}.`, 502);
    }
    const mime = response.headers.get('content-type');
    assertFileResponse(mime);
    return { bytes: await readLimited(response, maxBytes), mime };
  }
  throw new AssistantError('download_failed', 'The link redirected too many times.', 502);
}

/** The body, refused as soon as it passes `maxBytes` (declared or read). */
export async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new AssistantError('file_too_large', 'The file is larger than the limit.', 413);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new AssistantError('file_too_large', 'The file is larger than the limit.', 413);
      chunks.push(chunk);
    }
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
