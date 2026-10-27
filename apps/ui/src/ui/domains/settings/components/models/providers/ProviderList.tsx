import { Button } from '@mastra/playground-ui/components/Button';
import type { StatusPresentation } from '@mastra/playground-ui/components/StatusIndicators';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { OAuthStartResponse, ProviderInfo } from '../../../../../../api/types';
import { useCancelProviderOAuth, useOrgKeyAdminQuery, useProvidersQuery } from '../../../../../../hooks/use-providers';
import { useFactoryAuth } from '../../../../../../hooks/useFactoryAuth';
import { translator } from '../../../../../i18n/t';
import { SkeletonRows } from '../../../../../ui/SkeletonRows';
import { AddApiKeyDialog } from '../../AddApiKeyDialog';
import { ProviderOAuthDialog } from '../../ProviderOAuthDialog';
import { CREDENTIAL_LABEL, credentialAt, sharedSource } from '../../provider-credential';
import type { CredentialScope, ProviderCredential } from '../../provider-credential';
import { AddProviderDrawer } from './AddProviderDrawer';
import { ConnectedProviderRow } from './ConnectedProviderRow';
import type { ProviderConnection } from './ConnectedProviderRow';

const tk = translator('settings');

function credentialStatus(credential: ProviderCredential): StatusPresentation {
  return credential === 'oauth'
    ? { label: CREDENTIAL_LABEL.oauth, tone: 'success', description: tk('credentials.oauthDescription') }
    : { label: CREDENTIAL_LABEL.api_key, tone: 'success', description: tk('credentials.apiKeyDescription') };
}

interface ActiveOAuthSession {
  provider: string;
  session: OAuthStartResponse;
}

/** Credentials belong to the organization; a local single-user server keeps them unscoped. */
function storedCredentialScope(requested: CredentialScope, authEnabled: boolean): CredentialScope {
  const hasSeparateOrgStore = authEnabled;
  return requested === 'org' && hasSeparateOrgStore ? 'org' : 'user';
}

function sharedSourceStatus(source: ProviderInfo['source']): StatusPresentation | undefined {
  const shared = sharedSource(source);
  return shared && { label: shared.label, tone: 'neutral', description: shared.description };
}

function providerConnection(provider: ProviderInfo, scope: CredentialScope): ProviderConnection | undefined {
  const credential = credentialAt(provider, scope);
  if (credential) return { provider, status: credentialStatus(credential), credential };
  const sharedStatus = sharedSourceStatus(provider.source);
  return sharedStatus && { provider, status: sharedStatus, credential: undefined };
}

function connectedProviders(providers: ProviderInfo[], scope: CredentialScope): ProviderConnection[] {
  return providers
    .flatMap(provider => providerConnection(provider, scope) ?? [])
    .toSorted((left, right) => left.provider.provider.localeCompare(right.provider.provider));
}

export function ProviderList({ credentialScope }: { credentialScope: CredentialScope }) {
  const { t } = useTranslation('settings');
  const providersQuery = useProvidersQuery();
  const authQuery = useFactoryAuth();
  const orgKeyAdminQuery = useOrgKeyAdminQuery();
  const cancelOAuthMutation = useCancelProviderOAuth();
  const [addOpen, setAddOpen] = useState(false);
  const [activeOAuth, setActiveOAuth] = useState<ActiveOAuthSession>();
  const [keyDialogProvider, setKeyDialogProvider] = useState<ProviderInfo>();

  const authEnabled = authQuery.data?.authEnabled === true;
  const scope = storedCredentialScope(credentialScope, authEnabled);
  const requestScope = authEnabled ? scope : undefined;
  const readOnly = scope === 'org' && orgKeyAdminQuery.data === false;
  const actionsDisabled = authQuery.isPending || readOnly;
  const providers = providersQuery.data ?? [];
  const connections = connectedProviders(providers, scope);

  const openOAuth = (provider: string, session: OAuthStartResponse) => {
    setAddOpen(false);
    setActiveOAuth({ provider, session });
  };

  const openKeyDialog = (provider: ProviderInfo) => {
    setAddOpen(false);
    setKeyDialogProvider(provider);
  };

  const closeOAuth = () => {
    const flow = activeOAuth;
    setActiveOAuth(undefined);
    if (flow) cancelOAuthMutation.mutate({ provider: flow.provider, sessionId: flow.session.sessionId });
  };

  if (providersQuery.isPending) {
    return <SkeletonRows label={t('providers.loading')} rows={2} rowClassName="h-9 w-full" />;
  }

  return (
    <div className="flex flex-col gap-2">
      <ul className="border-border divide-border divide-y overflow-hidden rounded-lg border">
        {connections.map(connection => (
          <ConnectedProviderRow
            key={connection.provider.provider}
            connection={connection}
            requestScope={requestScope}
            disabled={actionsDisabled}
            onUpdateKey={() => setKeyDialogProvider(connection.provider)}
          />
        ))}
        <li>
          <Button
            variant="ghost"
            size="sm"
            className="h-10 w-full justify-start rounded-none pl-3"
            disabled={actionsDisabled}
            onClick={() => setAddOpen(true)}
          >
            <Plus aria-hidden="true" />
            {t('providers.add')}
          </Button>
        </li>
      </ul>
      {readOnly && (
        <Txt as="p" variant="caption" tone="muted">
          {t('credentials.orgAdminsOnly')}
        </Txt>
      )}
      {requestScope === 'org' && !readOnly && (
        <Txt as="p" variant="caption" tone="muted">
          {t('providers.orgAudience')}
        </Txt>
      )}
      {providersQuery.error && (
        <Txt as="p" variant="caption" className="text-destructive-foreground" role="alert">
          {providersQuery.error.message}
        </Txt>
      )}

      <AddProviderDrawer
        open={addOpen}
        providers={providers}
        credentialScope={scope}
        requestScope={requestScope}
        onOAuthStarted={openOAuth}
        onAddKey={openKeyDialog}
        onClose={() => setAddOpen(false)}
      />
      {keyDialogProvider && (
        <AddApiKeyDialog
          provider={keyDialogProvider}
          authEnabled={authEnabled}
          onClose={() => setKeyDialogProvider(undefined)}
        />
      )}
      {activeOAuth && (
        <ProviderOAuthDialog
          provider={activeOAuth.provider}
          session={activeOAuth.session}
          onClose={closeOAuth}
          onComplete={() => setActiveOAuth(undefined)}
        />
      )}
    </div>
  );
}
