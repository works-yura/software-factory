import { ApiRequestError } from '../../../../../../api/client';
import { translator } from '../../../../../i18n/t';
import type { HarnessAccounts } from './harnessAccounts';

const tk = translator('settings');

/** The server's `message` when it sent one; known refusals in the user's language. */
export function accountErrorMessage(error: unknown, accounts: HarnessAccounts): string {
  if (error instanceof ApiRequestError) {
    if (error.code === 'forbidden') return tk('accounts.errors.forbidden');
    if (error.code === 'accounts_need_sign_in') return tk(`accounts.harness.${accounts.i18nKey}.errors.needSignIn`);
    return error.detail ?? error.message;
  }
  return error instanceof Error ? error.message : tk('accounts.errors.failed');
}
