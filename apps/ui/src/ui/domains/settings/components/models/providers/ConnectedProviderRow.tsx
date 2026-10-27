import { Button } from '@mastra/playground-ui/components/Button';
import { DropdownMenu } from '@mastra/playground-ui/components/DropdownMenu';
import { Status } from '@mastra/playground-ui/components/StatusIndicators';
import type { StatusPresentation } from '@mastra/playground-ui/components/StatusIndicators';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { providerDisplayName } from '@factory/credentials/provider-display-name';
import { Box, MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ProviderInfo } from '../../../../../../api/types';
import { useRemoveProviderKey, useSignOutProviderOAuth } from '../../../../../../hooks/use-providers';
import { translator } from '../../../../../i18n/t';
import { ProviderBrandIcon } from '../../../../workspaces/components/ProviderBrandIcon';
import type { CredentialScope, ProviderCredential } from '../../provider-credential';

const tk = translator('settings');

export interface ProviderConnection {
  provider: ProviderInfo;
  status: StatusPresentation;
  credential: ProviderCredential | undefined;
}

function displayedStatus(saved: StatusPresentation, signingOut: boolean, removing: boolean): StatusPresentation {
  if (signingOut) {
    return { label: tk('providers.signingOut'), tone: 'progress', description: tk('providers.signingOutDescription') };
  }
  if (removing) {
    return { label: tk('providers.removing'), tone: 'progress', description: tk('providers.removingDescription') };
  }
  return saved;
}

export function ConnectedProviderRow({
  connection,
  requestScope,
  disabled,
  onUpdateKey,
}: {
  connection: ProviderConnection;
  requestScope: CredentialScope | undefined;
  disabled: boolean;
  onUpdateKey: () => void;
}) {
  const { t } = useTranslation('settings');
  const { provider, status, credential } = connection;
  const displayName = providerDisplayName(provider.provider);
  const signOutMutation = useSignOutProviderOAuth();
  const removeKeyMutation = useRemoveProviderKey();

  const signOut = () => {
    signOutMutation.mutate(
      { provider: provider.provider, scope: requestScope },
      { onError: error => toast.error(error.message || t('providers.signOutFailed')) },
    );
  };

  const removeKey = () => {
    removeKeyMutation.mutate(
      { provider: provider.provider, scope: requestScope },
      { onError: error => toast.error(error.message || t('providers.removeKeyFailed')) },
    );
  };

  return (
    <li className="flex min-h-10 items-center gap-2.5 py-1.5 pr-1.5 pl-3">
      <ProviderBrandIcon provider={provider.provider} fallback={<Box className="text-muted-foreground size-4" />} />
      <Txt as="span" variant="caption" className="min-w-0 flex-1 truncate">
        {displayName}
      </Txt>
      <Txt as="span" variant="meta" tone="muted" className="shrink-0">
        <Status presentation={displayedStatus(status, signOutMutation.isPending, removeKeyMutation.isPending)} />
      </Txt>
      {credential ? (
        <CredentialMenu
          displayName={displayName}
          credential={credential}
          disabled={disabled || signOutMutation.isPending || removeKeyMutation.isPending}
          onSignOut={signOut}
          onUpdateKey={onUpdateKey}
          onRemoveKey={removeKey}
        />
      ) : (
        <span aria-hidden="true" className="size-control-sm shrink-0" />
      )}
    </li>
  );
}

function CredentialMenu({
  displayName,
  credential,
  disabled,
  onSignOut,
  onUpdateKey,
  onRemoveKey,
}: {
  displayName: string;
  credential: ProviderCredential;
  disabled: boolean;
  onSignOut: () => void;
  onUpdateKey: () => void;
  onRemoveKey: () => void;
}) {
  const { t } = useTranslation('settings');
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('providers.actionsFor', { name: displayName })}
            disabled={disabled}
          >
            <MoreHorizontal />
          </Button>
        }
      />
      <DropdownMenu.Content align="end">
        {credential === 'oauth' ? (
          <DropdownMenu.Item onClick={onSignOut}>{t('providers.signOut')}</DropdownMenu.Item>
        ) : (
          <>
            <DropdownMenu.Item onClick={onUpdateKey}>{t('providers.updateKey')}</DropdownMenu.Item>
            <DropdownMenu.Item onClick={onRemoveKey}>{t('providers.removeKey')}</DropdownMenu.Item>
          </>
        )}
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}
