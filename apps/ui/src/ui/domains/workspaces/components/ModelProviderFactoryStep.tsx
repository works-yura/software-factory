import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';

import { companyAccountNeedsAdmin, useProviderConnection } from '../hooks/useProviderConnection';
import type { PreviewProvider } from '../hooks/useProviderConnection';
import type { OnboardingModelChoice } from '../services/onboardingFlow';
import { FactoryDefaultModelForm } from './FactoryDefaultModelForm';
import { ModelProviderPicker } from './ModelProviderPicker';
import { ProviderConnectionDialogs } from './ProviderConnectionDialogs';

export interface ModelProviderFactoryStepProps {
  initialChoice?: OnboardingModelChoice;
  onComplete: (choice: OnboardingModelChoice) => void;
  onPreviewProvider?: PreviewProvider;
  onPreviewModel?: (model: string | undefined) => void;
}

export function ModelProviderFactoryStep({
  initialChoice,
  onComplete,
  onPreviewModel,
  onPreviewProvider,
}: ModelProviderFactoryStepProps) {
  const { t } = useTranslation('workspaces');
  const connection = useProviderConnection({ scope: 'org', initialSelection: initialChoice });
  const needsAdmin = companyAccountNeedsAdmin(connection);
  const connectedProvider = connection.connected ? connection.provider : undefined;

  return (
    <section aria-label={t('providers.setupLabel')} className="flex max-w-xl flex-col gap-5">
      {needsAdmin && (
        <Txt variant="caption" tone="muted">
          {t('onboarding.adminNeeded')}
        </Txt>
      )}
      {!needsAdmin && connectedProvider && (
        <FactoryDefaultModelForm
          key={connectedProvider.provider}
          initialModelId={initialChoice?.providerId === connectedProvider.provider ? initialChoice.modelId : undefined}
          provider={connectedProvider}
          onContinue={modelId => {
            if (connection.method)
              onComplete({ providerId: connectedProvider.provider, modelId, method: connection.method });
          }}
          onPreviewModel={onPreviewModel}
          onChangeProvider={() => {
            connection.clear();
            onPreviewModel?.(undefined);
            onPreviewProvider?.(undefined);
          }}
        />
      )}
      {!needsAdmin && !connectedProvider && (
        <ModelProviderPicker connection={connection} onPreviewProvider={onPreviewProvider} />
      )}

      {connection.error && (
        <Txt as="p" variant="caption" className="text-destructive-foreground m-0" role="alert">
          {connection.error}
        </Txt>
      )}

      <ProviderConnectionDialogs
        keyProvider={connection.keyDialogProvider}
        oauth={connection.activeOAuth}
        authEnabled={connection.authEnabled}
        onCloseKeyDialog={connection.closeKeyDialog}
        onCloseOAuth={connection.closeOAuth}
        onCompleteOAuth={connection.completeOAuth}
      />
    </section>
  );
}
