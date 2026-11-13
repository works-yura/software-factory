/**
 * Whether a repository is public, as its host's API says (ADR-0039): a sandbox
 * never publishes uncommitted work to a public repository's hidden refs. Only
 * GitHub is asked (`private` on the repository); anything else, or any
 * failure, is `unknown`, and then only commits are published.
 */

import type { RepositoryVisibility } from '@factory/sandbox';

export interface RepositoryVisibilityAccess {
  cloneUrl: string;
  authorization?: { token: string };
}

/** `owner/repo` of a github.com clone URL, `undefined` for any other host. */
export function githubRepositorySlug(cloneUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(cloneUrl);
  } catch {
    return undefined;
  }
  if (url.hostname.toLowerCase() !== 'github.com') return undefined;
  const parts = url.pathname.replace(/\.git$/i, '').split('/').filter(Boolean);
  return parts.length === 2 ? `${parts[0]}/${parts[1]}` : undefined;
}

export async function githubRepositoryVisibility(
  access: RepositoryVisibilityAccess,
  fetchImpl: typeof fetch = fetch,
): Promise<RepositoryVisibility> {
  const slug = githubRepositorySlug(access.cloneUrl);
  const token = access.authorization?.token;
  if (!slug || !token) return 'unknown';
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${slug}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'factory' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return 'unknown';
    const body = (await response.json()) as { private?: unknown };
    return body.private === true ? 'private' : body.private === false ? 'public' : 'unknown';
  } catch {
    return 'unknown';
  }
}
