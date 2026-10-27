import type { ProviderInfo } from '../../../../api/types';
import { lazyLabels } from '../../../i18n/lazy';
import { translator } from '../../../i18n/t';

export type ProviderCredential = NonNullable<ProviderInfo['userCredential']>;
export type CredentialScope = 'user' | 'org';

const tk = translator('settings');

export const CREDENTIAL_LABEL: Readonly<Record<ProviderCredential, string>> = lazyLabels(
  ['oauth', 'api_key'] as const,
  id => (id === 'oauth' ? 'settings:credentials.signedIn' : 'settings:credentials.keySaved'),
);

type SharedSource = { label: string; description: string };

/** Credentials no scope owns: read from the server environment or provided by the deployment. */
export function sharedSource(source: ProviderInfo['source']): SharedSource | undefined {
  if (source === 'env') return { label: tk('credentials.fromEnv'), description: tk('credentials.fromEnvDescription') };
  if (source === 'deployment') {
    return { label: tk('credentials.fromDeployment'), description: tk('credentials.fromDeploymentDescription') };
  }
  return undefined;
}

/** The credential saved at exactly this scope. Deployment env keys belong to neither scope. */
export function credentialAt(provider: ProviderInfo, scope: CredentialScope): ProviderCredential | undefined {
  if (scope === 'org') {
    if (provider.orgCredential) return provider.orgCredential;
    if (provider.source === 'oauth-org') return 'oauth';
    if (provider.source === 'stored-org') return 'api_key';
    return undefined;
  }
  if (provider.userCredential) return provider.userCredential;
  if (provider.source === 'oauth' || provider.source === 'oauth-user') return 'oauth';
  if (provider.source === 'stored' || provider.source === 'stored-user') return 'api_key';
  return undefined;
}
