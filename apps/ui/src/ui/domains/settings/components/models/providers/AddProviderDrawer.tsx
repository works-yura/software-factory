import { Button } from '@mastra/playground-ui/components/Button';
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@mastra/playground-ui/components/Drawer';
import { SearchInput } from '@mastra/playground-ui/components/SearchInput';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useIsMobile } from '@mastra/playground-ui/hooks/use-is-mobile';
import { providerDisplayName } from '@factory/credentials/provider-display-name';
import { Box } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { OAuthStartResponse, ProviderInfo } from '../../../../../../api/types';
import { useStartProviderOAuth } from '../../../../../../hooks/use-providers';
import { ProviderBrandIcon } from '../../../../workspaces/components/ProviderBrandIcon';
import { CREDENTIAL_LABEL, credentialAt, sharedSource } from '../../provider-credential';
import type { CredentialScope } from '../../provider-credential';

function matchesSearch(provider: ProviderInfo, query: string): boolean {
  return (
    provider.provider.toLowerCase().includes(query) ||
    providerDisplayName(provider.provider).toLowerCase().includes(query)
  );
}

function soleOAuthMode(provider: ProviderInfo): string | undefined {
  const modes = provider.oauth?.modes ?? [];
  return modes.length === 1 ? modes[0] : undefined;
}

function takesApiKey(provider: ProviderInfo): boolean {
  return provider.source !== 'deployment';
}

function connectionLabel(provider: ProviderInfo, scope: CredentialScope): string | undefined {
  const credential = credentialAt(provider, scope);
  if (credential) return CREDENTIAL_LABEL[credential];
  return sharedSource(provider.source)?.label;
}

export function AddProviderDrawer({
  open,
  providers,
  credentialScope,
  requestScope,
  onOAuthStarted,
  onAddKey,
  onClose,
}: {
  open: boolean;
  providers: ProviderInfo[];
  credentialScope: CredentialScope;
  requestScope: CredentialScope | undefined;
  onOAuthStarted: (provider: string, session: OAuthStartResponse) => void;
  onAddKey: (provider: ProviderInfo) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('settings');
  const isMobile = useIsMobile();
  const startOAuthMutation = useStartProviderOAuth();
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();
  const sorted = providers.toSorted((left, right) => left.provider.localeCompare(right.provider));
  const signInProviders = sorted.filter(provider => provider.oauth?.supported === true);
  const shown = query ? sorted.filter(provider => matchesSearch(provider, query)) : signInProviders;
  const keyOnlyCount = providers.filter(provider => provider.oauth?.supported !== true && takesApiKey(provider)).length;
  const startingProvider = startOAuthMutation.isPending ? startOAuthMutation.variables.provider : undefined;
  const trimmed = search.trim();

  const signIn = (provider: ProviderInfo) => {
    startOAuthMutation.mutate(
      { provider: provider.provider, mode: soleOAuthMode(provider), scope: requestScope },
      { onSuccess: session => onOAuthStarted(provider.provider, session) },
    );
  };

  const closeUnlessStarting = (nextOpen: boolean) => {
    if (!nextOpen && startingProvider === undefined) onClose();
  };

  const resetOnceHidden = (nextOpen: boolean) => {
    if (nextOpen) return;
    setSearch('');
    startOAuthMutation.reset();
  };

  return (
    <Drawer
      side={isMobile ? 'bottom' : 'right'}
      variant={isMobile ? 'default' : 'floating'}
      overlay="visible"
      open={open}
      onOpenChange={closeUnlessStarting}
      onOpenChangeComplete={resetOnceHidden}
    >
      <DrawerContent aria-busy={startingProvider !== undefined || undefined}>
        <DrawerHeader>
          <DrawerTitle>{t('providers.add')}</DrawerTitle>
          <DrawerDescription>
            {t('providers.drawer.description')} {t(`providers.drawer.audience.${credentialScope}`)}
          </DrawerDescription>
        </DrawerHeader>
        <DrawerBody className="flex min-h-0 flex-col gap-3">
          <SearchInput
            label={t('providers.search')}
            placeholder={t('providers.drawer.searchPlaceholder', { total: providers.length })}
            value={search}
            onValueChange={setSearch}
          />
          <Txt as="p" variant="caption" tone="muted">
            {query
              ? t('providers.drawer.matches', { shown: shown.length, total: providers.length })
              : t('providers.drawer.signInHeading')}
          </Txt>
          {shown.length === 0 ? (
            <Txt as="p" variant="caption" className="py-4 text-center">
              {trimmed ? t('providers.noMatch', { query: trimmed }) : t('providers.drawer.noSignIn')}
            </Txt>
          ) : (
            <ul className="border-border divide-border min-h-0 divide-y overflow-y-auto rounded-lg border">
              {shown.map(provider => (
                <AddProviderRow
                  key={provider.provider}
                  provider={provider}
                  credentialScope={credentialScope}
                  startingProvider={startingProvider}
                  onSignIn={() => signIn(provider)}
                  onAddKey={() => onAddKey(provider)}
                />
              ))}
            </ul>
          )}
          {!query && keyOnlyCount > 0 && (
            <Txt as="p" variant="caption" tone="muted">
              {t('providers.drawer.keyOnly', { count: keyOnlyCount })}
            </Txt>
          )}
          {startOAuthMutation.error && (
            <Txt as="p" variant="caption" className="text-destructive-foreground" role="alert">
              {startOAuthMutation.error.message}
            </Txt>
          )}
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}

function AddProviderRow({
  provider,
  credentialScope,
  startingProvider,
  onSignIn,
  onAddKey,
}: {
  provider: ProviderInfo;
  credentialScope: CredentialScope;
  startingProvider: string | undefined;
  onSignIn: () => void;
  onAddKey: () => void;
}) {
  const { t } = useTranslation('settings');
  const displayName = providerDisplayName(provider.provider);
  const label = connectionLabel(provider, credentialScope);
  const starting = startingProvider !== undefined;
  return (
    <li className="flex min-h-12 items-center gap-3 py-2 pr-2 pl-3">
      <ProviderBrandIcon provider={provider.provider} fallback={<Box className="text-muted-foreground size-4" />} />
      <span className="flex min-w-0 flex-1 flex-col">
        <Txt as="span" variant="caption" className="truncate">
          {displayName}
        </Txt>
        {label && (
          <Txt as="span" variant="meta" tone="muted">
            {label}
          </Txt>
        )}
      </span>
      {takesApiKey(provider) && (
        <Button
          size="sm"
          aria-label={t('providers.addKeyFor', { name: displayName })}
          disabled={starting}
          onClick={onAddKey}
        >
          {t('providers.apiKey')}
        </Button>
      )}
      {provider.oauth?.supported === true && (
        <Button
          size="sm"
          variant="primary"
          aria-label={t('providers.signInTo', { name: displayName })}
          disabled={starting}
          onClick={onSignIn}
        >
          {startingProvider === provider.provider ? t('providers.starting') : t('providers.signIn')}
        </Button>
      )}
    </li>
  );
}
