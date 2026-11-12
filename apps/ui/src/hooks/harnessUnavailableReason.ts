import type { HarnessUnavailableCode } from '@factory/harness/models/facet';

import { translator } from '../ui/i18n/t';

const tk = translator('common');

/**
 * Why a harness cannot run, in the viewer's language when the server named the cause
 * (`reasonCode`: its CLI is not installed here, or the viewer has no connection for it), otherwise
 * in the server's own words. Undefined when the server gave neither.
 */
export function harnessUnavailableReason(
  instance: { readonly reasonCode?: HarnessUnavailableCode; readonly reason?: string },
  name: string,
): string | undefined {
  switch (instance.reasonCode) {
    case 'executable_missing':
      return tk('harnessUnavailable.executableMissing', { name });
    case 'connection_missing':
      return tk('harnessUnavailable.connectionMissing', { name });
    default:
      return instance.reason;
  }
}
