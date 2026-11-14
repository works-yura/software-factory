import { Notice } from '@mastra/playground-ui/components/Notice';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';

import { companyAccountNeedsAdmin } from '../hooks/useProviderConnection';
import type { PreviewProvider } from '../hooks/useProviderConnection';
import type { OnboardingModel } from '../hooks/useOnboardingModel';
import { FactoryDefaultModelForm } from './FactoryDefaultModelForm';
import { ModelProviderPicker } from './ModelProviderPicker';
import { ProviderConnectionDialogs } from './ProviderConnectionDialogs';
import { OnboardingInset } from './onboarding/OnboardingInset';

export interface ModelProviderFactoryStepProps {
  model: OnboardingModel;
  onModelChange: (modelId: string) => void;
  onPreviewProvider?: PreviewProvider;
  onPreviewModel?: (model: string | undefined) => void;
}

/** The company account's provider, then the Factory's default model; both apply as they are picked. */
export function ModelProviderFactoryStep({
  model,
  onModelChange,
  onPreviewModel,
  onPreviewProvider,
}: ModelProviderFactoryStepProps) {
  const { t } = useTranslation('workspaces');
  const { connection, connectedProvider } = model;
  const needsAdmin = companyAccountNeedsAdmin(connection);

  return (
    <section aria-label={t('providers.setupLabel')} className="flex flex-col gap-3">
      {model.savedProblem && (
        <Notice variant="warning" role="status">
          {model.savedProblem === 'gone' ? t('setup.providerGoneCompany') : t('setup.connectionChangedCompany')}
        </Notice>
      )}
      <OnboardingInset className="p-3">
        {needsAdmin && (
          <Txt variant="caption" tone="muted">
            {t('onboarding.adminNeeded')}
          </Txt>
        )}
        {!needsAdmin && connectedProvider && (
          <FactoryDefaultModelForm
            key={connectedProvider.provider}
            provider={connectedProvider}
            models={model.models}
            modelId={model.modelId}
            previousUnavailable={model.previousUnavailable}
            onModelChange={modelId => {
              onModelChange(modelId);
              onPreviewModel?.(modelId);
            }}
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
      </OnboardingInset>

      {connection.error && (
        <Txt as="p" variant="caption" className="text-destructive-foreground m-0 px-3" role="alert">
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
