import { CommandGroup } from '@mastra/playground-ui/components/Command';
import { CommandPaletteItem } from '@mastra/playground-ui/components/CommandPalette';

import { SkeletonRows } from '../../../../ui/SkeletonRows';
import { providerDisplayName } from '@factory/credentials/provider-display-name';
import type { ProviderConnection } from '../../hooks/useProviderConnection';
import { matchesProviderQuery } from '../../hooks/useProviderConnection';
import { ProviderBrandIcon } from '../ProviderBrandIcon';
import { CreateFactoryPaletteAlert, CreateFactoryPaletteMessage } from './CreateFactoryPalette';
import { translator } from '../../../../i18n/t';

const tk = translator('workspaces');

export interface CreateFactoryProviderRowsProps {
  connection: ProviderConnection;
  query: string;
  error?: string;
}

export function CreateFactoryProviderRows({ connection, query, error }: CreateFactoryProviderRowsProps) {
  if (connection.isPending) {
    return <SkeletonRows label={tk('providers.loading')} rows={3} rowClassName="mx-2 my-1 h-12 rounded-xl" />;
  }
  if (connection.catalogError)
    return <CreateFactoryPaletteAlert>{connection.catalogError.message}</CreateFactoryPaletteAlert>;

  const signIn = connection.signInProviders.filter(provider => matchesProviderQuery(provider, query));
  const withKey = connection.keyProviders.filter(
    provider => provider.oauth?.supported !== true && matchesProviderQuery(provider, query),
  );

  return (
    <>
      {error && <CreateFactoryPaletteAlert>{error}</CreateFactoryPaletteAlert>}
      {signIn.length === 0 && withKey.length === 0 && (
        <CreateFactoryPaletteMessage>{tk('createFactory.providers.noMatch')}</CreateFactoryPaletteMessage>
      )}
      {signIn.length > 0 && (
        <CommandGroup heading={tk('createFactory.providers.signIn')}>
          {signIn.map(provider => (
            <CommandPaletteItem
              key={provider.provider}
              icon={<ProviderBrandIcon provider={provider.provider} />}
              title={providerDisplayName(provider.provider)}
              subtitle={
                connection.isConfigured(provider)
                  ? tk('createFactory.providers.signedIn')
                  : tk('createFactory.providers.signInWithAccount')
              }
              badge={connection.isConfigured(provider) ? tk('providers.connected') : undefined}
              value={`signin-${provider.provider}`}
              disabled={connection.pending}
              onSelect={() => connection.chooseSignInProvider(provider)}
            />
          ))}
        </CommandGroup>
      )}
      {withKey.length > 0 && (
        <CommandGroup heading={tk('providers.methods.api_key')}>
          {withKey.map(provider => (
            <CommandPaletteItem
              key={provider.provider}
              icon={<ProviderBrandIcon provider={provider.provider} />}
              title={providerDisplayName(provider.provider)}
              subtitle={
                connection.isConfigured(provider)
                  ? tk('createFactory.providers.keySaved')
                  : tk('createFactory.providers.connectWithKey')
              }
              badge={connection.isConfigured(provider) ? tk('providers.connected') : undefined}
              value={`key-${provider.provider}`}
              disabled={connection.pending}
              onSelect={() => connection.chooseKeyProvider(provider)}
            />
          ))}
        </CommandGroup>
      )}
    </>
  );
}
