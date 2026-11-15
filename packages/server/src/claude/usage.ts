/**
 * Claude Code's usage facet: how much of a Claude sign-in's allowance is used now, as the CLI's own
 * `/usage` reads it, with the sign-in's own access token.
 */
import { claudeOAuthUsageToLimits } from '@factory/harness-claude-code';
import type { HarnessUsage } from '@factory/harness/usage';

import { failed, getJson, probe } from '../usage/probes.ts';
import type { UsageProbeOptions } from '../usage/probes.ts';

/** The Claude usage endpoint the CLI's `/usage` reads with its sign-in. */
export const CLAUDE_OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

/** Claude Code's accounts: Claude sign-ins, whose 5-hour, weekly and model windows the usage endpoint reports. */
export function createClaudeHarnessUsage(options: UsageProbeOptions): HarnessUsage {
  return {
    harnessId: 'claude-code',
    displayName: 'Claude Code',
    accountProvider: 'anthropic',
    readAccountLimits: account =>
      probe(options, account, async (oauth, checkedAt, fetchImpl) => {
        const answer = await getJson(fetchImpl, CLAUDE_OAUTH_USAGE_URL, {
          authorization: `Bearer ${oauth.accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          accept: 'application/json',
        });
        return answer.ok ? claudeOAuthUsageToLimits(answer.body, checkedAt) : failed(checkedAt, answer.message);
      }),
  };
}

