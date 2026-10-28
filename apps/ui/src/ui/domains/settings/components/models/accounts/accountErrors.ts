import { ApiRequestError } from '../../../../../../api/client';
import { translator } from '../../../../../i18n/t';

const tk = translator('settings');

/** Claude Code turns rotate through the `anthropic` provider's accounts. */
export const CLAUDE_ACCOUNTS_PROVIDER = 'anthropic';

/** The server's `message` when it sent one; known refusals in the user's language. */
export function accountErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === 'organization_admin_required') return tk('claudeAccounts.errors.adminRequired');
    if (error.code === 'forbidden') return tk('claudeAccounts.errors.forbidden');
    if (error.code === 'accounts_need_sign_in') return tk('claudeAccounts.errors.needSignIn');
    return error.detail ?? error.message;
  }
  return error instanceof Error ? error.message : tk('claudeAccounts.errors.failed');
}
