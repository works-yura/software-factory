import { useState } from 'react';

import type { OAuthStartResponse, ProviderInfo } from '../../../../api/types';
import {
  useCancelProviderOAuth,
  useOrgKeyAdminQuery,
  useProvidersQuery,
  useStartProviderOAuth,
} from '../../../../hooks/use-providers';
import { useFactoryAuth } from '../../../../hooks/useFactoryAuth';
import { providerDisplayName } from '@factory/credentials/provider-display-name';
import { credentialAt } from '../../settings/components/provider-credential';
import { lazyLabels } from '../../../i18n/lazy';
import { translator } from '../../../i18n/t';

const tk = translator('workspaces');

export type ProviderCredentialScope = 'org';
export type ProviderConnectionMethod = 'api_key' | 'oauth';
export type PreviewProvider = (providerId: string | undefined, method?: ProviderConnectionMethod) => void;

export const CONNECTION_METHOD_LABEL: Readonly<Record<ProviderConnectionMethod, string>> = lazyLabels(
  ['api_key', 'oauth'],
  method => `workspaces:providers.methods.${method}`,
);

export interface ActiveProviderOAuth {
  provider: string;
  session: OAuthStartResponse;
  replaces?: ProviderConnectionMethod;
}

export interface ProviderConnection {
  isPending: boolean;
  /** The provider list (or auth) is being fetched again, e.g. after Retry. */
  retrying: boolean;
  catalogError?: Error;
  authEnabled: boolean;
  orgKeyAdmin: boolean;
  signInProviders: ProviderInfo[];
  keyProviders: ProviderInfo[];
  provider?: ProviderInfo;
  /** The selected provider id, even when it is gone from the provider list. */
  selectedProviderId?: string;
  connected: boolean;
  method?: ProviderConnectionMethod;
  hasConfiguredProvider: boolean;
  pending: boolean;
  error?: string;
  keyDialogProvider?: ProviderInfo;
  activeOAuth?: ActiveProviderOAuth;
  isConfigured: (provider: ProviderInfo, method?: ProviderConnectionMethod) => boolean;
  canConfigure: (provider: ProviderInfo, method?: ProviderConnectionMethod) => boolean;
  retry: () => void;
  clear: () => void;
  /** Drops a connect error once the user has moved on from the action that failed. */
  clearError: () => void;
  chooseSignInProvider: (provider: ProviderInfo) => void;
  chooseKeyProvider: (provider: ProviderInfo) => void;
  /** `saved` selects the provider the dialog was for; a cancel keeps the previous choice. */
  closeKeyDialog: (saved: boolean) => void;
  closeOAuth: () => void;
  completeOAuth: () => void;
}

export function providerCredentialMethod(
  provider: ProviderInfo,
  scope?: ProviderCredentialScope,
): ProviderConnectionMethod | undefined {
  if (provider.source === 'deployment') return 'api_key';
  if (scope === 'org') return credentialAt(provider, 'org');
  if (provider.source === 'none') return undefined;
  return provider.source.startsWith('oauth') ? 'oauth' : 'api_key';
}

export function isProviderConnected(
  provider: ProviderInfo,
  scope?: ProviderCredentialScope,
  method?: ProviderConnectionMethod,
): boolean {
  const saved = providerCredentialMethod(provider, scope);
  // Unscoped credentials resolve by precedence (sign-in over saved key), so any one serves both methods.
  return method && scope ? saved === method : saved !== undefined;
}

export function companyAccountNeedsAdmin(connection: ProviderConnection): boolean {
  return (
    !connection.isPending &&
    !connection.catalogError &&
    connection.authEnabled &&
    !connection.orgKeyAdmin &&
    !connection.hasConfiguredProvider
  );
}

export function matchesProviderQuery(provider: ProviderInfo, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return (
    provider.provider.toLowerCase().includes(normalized) ||
    providerDisplayName(provider.provider).toLowerCase().includes(normalized)
  );
}

function offersApiKey(provider: ProviderInfo): boolean {
  if (provider.envVar || !provider.oauth?.supported) return true;
  if (provider.userCredential === 'api_key' || provider.orgCredential === 'api_key') return true;
  // `orgKey` also represents shared OAuth. It is not an API-key capability.
  return ['stored-org', 'stored-user', 'stored'].includes(provider.source);
}

export interface ProviderSelection {
  providerId: string;
  method: ProviderConnectionMethod;
}

export function useProviderConnection({
  scope,
  initialSelection,
  onSelectionChange,
}: {
  scope?: ProviderCredentialScope;
  initialSelection?: ProviderSelection;
  /** Called whenever the user picks or clears a provider. A provider that needs a key or a sign-in is only
   *  picked once that succeeds, so cancelling keeps the working choice. */
  onSelectionChange?: (selection: ProviderSelection | undefined) => void;
} = {}): ProviderConnection {
  const providersQuery = useProvidersQuery();
  const authQuery = useFactoryAuth();
  const orgKeyAdminQuery = useOrgKeyAdminQuery();
  const startOAuthMutation = useStartProviderOAuth();
  const cancelOAuthMutation = useCancelProviderOAuth();
  const [selection, setSelection] = useState<ProviderSelection | undefined>(initialSelection);
  const [keyDialogProvider, setKeyDialogProvider] = useState<ProviderInfo>();
  const [activeOAuth, setActiveOAuth] = useState<ActiveProviderOAuth>();
  const [error, setError] = useState<string>();

  const authEnabled = authQuery.data?.authEnabled === true;
  const orgKeyAdmin = !authEnabled || (orgKeyAdminQuery.data ?? true);
  const credentialScope = authEnabled ? scope : undefined;
  const isConfigured = (provider: ProviderInfo, method?: ProviderConnectionMethod) =>
    isProviderConnected(provider, credentialScope, method);
  const byConfiguredThenName = (left: ProviderInfo, right: ProviderInfo): number => {
    if (isConfigured(left) !== isConfigured(right)) return isConfigured(left) ? -1 : 1;
    return providerDisplayName(left.provider).localeCompare(providerDisplayName(right.provider));
  };
  const providers = (providersQuery.data ?? []).toSorted(byConfiguredThenName);
  const provider = providers.find(candidate => candidate.provider === selection?.providerId);

  const select = (nextSelection: ProviderSelection | undefined) => {
    setSelection(nextSelection);
    setError(undefined);
    onSelectionChange?.(nextSelection);
  };

  const startOAuth = async (chosen: ProviderInfo) => {
    setError(undefined);
    try {
      const modes = chosen.oauth?.modes ?? [];
      const session = await startOAuthMutation.mutateAsync({
        provider: chosen.provider,
        mode: modes.length === 1 ? modes[0] : undefined,
        ...(authEnabled && scope ? { scope } : {}),
      });
      setActiveOAuth({
        provider: chosen.provider,
        session,
        replaces: providerCredentialMethod(chosen, credentialScope),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tk('providers.signInFailed'));
    }
  };

  const canConfigure = (chosen: ProviderInfo, method?: ProviderConnectionMethod) =>
    scope !== 'org' || !authEnabled || orgKeyAdmin || isConfigured(chosen, method);

  return {
    isPending:
      providersQuery.isPending ||
      (scope !== undefined && authQuery.isPending) ||
      (scope === 'org' && authEnabled && orgKeyAdminQuery.isPending),
    catalogError: providersQuery.error ?? (scope !== undefined ? authQuery.error : undefined) ?? undefined,
    retrying: providersQuery.isFetching || (scope !== undefined && authQuery.isFetching),
    authEnabled,
    orgKeyAdmin,
    signInProviders: providers.filter(candidate => candidate.oauth?.supported === true),
    keyProviders: providers.filter(candidate => offersApiKey(candidate)),
    provider,
    selectedProviderId: selection?.providerId,
    connected: provider ? isConfigured(provider, selection?.method) : false,
    method: selection?.method,
    hasConfiguredProvider: providers.some(candidate => isConfigured(candidate)),
    pending: startOAuthMutation.isPending,
    error,
    keyDialogProvider,
    activeOAuth,
    isConfigured,
    canConfigure,
    retry: () => {
      void providersQuery.refetch();
      if (scope !== undefined) void authQuery.refetch();
    },
    clear: () => select(undefined),
    clearError: () => setError(undefined),
    chooseSignInProvider: chosen => {
      if (!canConfigure(chosen, 'oauth')) return;
      if (isConfigured(chosen, 'oauth')) select({ providerId: chosen.provider, method: 'oauth' });
      else void startOAuth(chosen);
    },
    chooseKeyProvider: chosen => {
      if (!canConfigure(chosen, 'api_key')) return;
      if (isConfigured(chosen, 'api_key')) {
        select({ providerId: chosen.provider, method: 'api_key' });
        return;
      }
      // An earlier failure belongs to another attempt; the dialog shows its own.
      setError(undefined);
      setKeyDialogProvider(chosen);
    },
    closeKeyDialog: saved => {
      setKeyDialogProvider(undefined);
      if (saved && keyDialogProvider) select({ providerId: keyDialogProvider.provider, method: 'api_key' });
    },
    closeOAuth: () => {
      const flow = activeOAuth;
      setActiveOAuth(undefined);
      if (flow) cancelOAuthMutation.mutate({ provider: flow.provider, sessionId: flow.session.sessionId });
    },
    completeOAuth: () => {
      setActiveOAuth(undefined);
      if (activeOAuth) select({ providerId: activeOAuth.provider, method: 'oauth' });
    },
  };
}
