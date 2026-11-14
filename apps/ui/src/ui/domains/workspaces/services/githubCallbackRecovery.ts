import type { GitHubAppCallbackResult } from '../components/GitHubAppCallbackHandler';

export interface GithubCallbackRecovery {
  /** What picks the fix up here: a status refresh, a new GitHub connect, or a token connection when this server has no GitHub App. */
  next: 'refresh' | 'connect' | 'token';
}

/** The way out of a refusal the GitHub App round trip reported. */
export function githubCallbackRecovery(code: string | undefined): GithubCallbackRecovery {
  // This server has no GitHub App: repositories connect with a personal access token instead.
  if (code === 'no_app') return { next: 'token' };
  // An already-used link usually means the install went through.
  if (code === 'github_app_link_already_used') return { next: 'refresh' };
  return { next: 'connect' };
}

/**
 * Whether the result waits on access granted elsewhere (an organization owner's approval), so new
 * repositories listing means it has landed and its notice is moot.
 */
export function githubCallbackAwaitsAccess(callback: GitHubAppCallbackResult | undefined): boolean {
  if (callback?.kind === 'requested') return true;
  return callback?.kind === 'error' && githubCallbackRecovery(callback.code).next === 'refresh';
}
