import { TenantCredentialStore } from '@factory/credentials';
import type { ModelCredentialsStorage } from '@factory/store';

/** Who a Claude Code turn runs for: the organization whose credential pays, and the session's owner. */
export interface ClaudeCodeCredentialTenant {
  orgId: string;
  userId: string;
}

/** The env a turn's `claude` process authenticates with. */
export type ClaudeCodeCredentialsHook = (tenant: ClaudeCodeCredentialTenant) => Promise<Record<string, string>>;

/** `claude setup-token` and Claude subscription OAuth tokens; the CLI takes them as `CLAUDE_CODE_OAUTH_TOKEN`. */
const OAUTH_TOKEN_PREFIX = 'sk-ant-oat';

export class ClaudeCodeCredentialMissingError extends Error {
  constructor(orgId: string) {
    super(
      `No Anthropic credential is set for organization ${orgId}. Add an Anthropic API key or a Claude setup token under Settings → Models to run Claude Code sessions.`,
    );
    this.name = 'ClaudeCodeCredentialMissingError';
  }
}

/** The env for one Anthropic credential: an API key, or an OAuth/setup token. */
export function claudeCodeCredentialEnv(credential: {
  type: 'api_key' | 'oauth';
  secret: string;
}): Record<string, string> {
  if (credential.type === 'oauth' || credential.secret.startsWith(OAUTH_TOKEN_PREFIX)) {
    return { CLAUDE_CODE_OAUTH_TOKEN: credential.secret };
  }
  return { ANTHROPIC_API_KEY: credential.secret };
}

/**
 * The credentials hook every Claude Code turn asks. Harness-agnostic on
 * purpose and a single function, so the credential pool (phase 3) replaces it
 * whole.
 *
 * - Local development passes nothing: the CLI runs on the person's own
 *   `claude` login, which is the point of running locally.
 * - Otherwise the factory's (organization-scoped) Anthropic credential is
 *   handed over: an API key as `ANTHROPIC_API_KEY`, an OAuth or setup token as
 *   `CLAUDE_CODE_OAUTH_TOKEN`. OAuth tokens are refreshed first, the same way a
 *   Mastra run's model call refreshes them.
 */
export function createClaudeCodeCredentialsHook({
  localDevelopment,
  credentials,
}: {
  localDevelopment: boolean;
  credentials: ModelCredentialsStorage | undefined;
}): ClaudeCodeCredentialsHook {
  return async ({ orgId, userId }) => {
    if (localDevelopment) return {};
    const store = new TenantCredentialStore(orgId, userId, credentials, 'factory');
    await store.ensureFresh();
    const stored = store.get('anthropic');
    const secret = stored ? await store.getApiKey('anthropic') : undefined;
    if (!stored || !secret) throw new ClaudeCodeCredentialMissingError(orgId);
    return claudeCodeCredentialEnv({ type: stored.type, secret });
  };
}
