import { useTranslation } from 'react-i18next';

import type { ProviderInfo } from '../../../../api/types';
import { AddApiKeyDialog } from '../../settings/components/AddApiKeyDialog';
import { ProviderOAuthDialog } from '../../settings/components/ProviderOAuthDialog';
import type { ActiveProviderOAuth } from '../hooks/useProviderConnection';

export interface ProviderConnectionDialogsProps {
  keyProvider?: ProviderInfo;
  oauth?: ActiveProviderOAuth;
  authEnabled: boolean;
  onCloseKeyDialog: (saved: boolean) => void;
  onCloseOAuth: () => void;
  onCompleteOAuth: () => void;
}

/** The two ways a provider gets connected during Factory setup. */
export function ProviderConnectionDialogs({
  keyProvider,
  oauth,
  authEnabled,
  onCloseKeyDialog,
  onCloseOAuth,
  onCompleteOAuth,
}: ProviderConnectionDialogsProps) {
  const { t } = useTranslation('workspaces');
  const replacementNotice = oauth?.replaces ? ` ${t('providers.replacesNotice')}` : '';
  return (
    <>
      {keyProvider && (
        <AddApiKeyDialog
          provider={keyProvider}
          authEnabled={authEnabled}
          onClose={onCloseKeyDialog}
        />
      )}
      {oauth && (
        <ProviderOAuthDialog
          provider={oauth.provider}
          session={oauth.session}
          scopeNotice={authEnabled ? t('providers.scopeNotice.org') + replacementNotice : undefined}
          onClose={onCloseOAuth}
          onComplete={onCompleteOAuth}
        />
      )}
    </>
  );
}
