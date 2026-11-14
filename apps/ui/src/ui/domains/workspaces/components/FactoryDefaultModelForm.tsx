import { Button } from '@mastra/playground-ui/components/Button';
import { Field, FieldLabel } from '@mastra/playground-ui/components/Field';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { Txt } from '@mastra/playground-ui/components/Txt';

import type { ProviderInfo } from '../../../../api/types';
import { SkeletonRows } from '../../../ui/SkeletonRows';
import { ModelCombobox } from '../../settings/components/ModelCombobox';
import { SharedCredentialNotice } from '../../settings/components/SharedCredentialNotice';
import { providerDisplayName } from '@factory/credentials/provider-display-name';
import { useTranslation } from 'react-i18next';
import type { ProviderModels } from '../hooks/useProviderModels';
import { ProviderBrandIcon } from './ProviderBrandIcon';

export interface FactoryDefaultModelFormProps {
  provider: ProviderInfo;
  models: ProviderModels;
  /** The model shown: the user's pick, else the provider's suggestion; empty while none applies. */
  modelId: string;
  /** The user's earlier pick is no longer offered by this provider. */
  previousUnavailable: boolean;
  onModelChange: (modelId: string) => void;
  onChangeProvider: () => void;
}

/** The connected provider and the Factory's default model: a pick applies at once, Create submits it. */
export function FactoryDefaultModelForm({
  provider,
  models,
  modelId,
  previousUnavailable,
  onModelChange,
  onChangeProvider,
}: FactoryDefaultModelFormProps) {
  const { t } = useTranslation('workspaces');

  if (models.isPending) return <SkeletonRows label={t('models.loading')} rows={2} rowClassName="h-9 w-full" />;
  if (models.catalogError || models.models.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3">
        <Txt as="p" variant="caption" role="alert">
          {models.catalogError?.message ?? t('models.noneForConnection')}
        </Txt>
        <div className="flex gap-2">
          <Button disabled={models.retrying} onClick={models.retry}>
            {models.retrying && <Spinner size="sm" aria-hidden="true" />}
            {t('actions.retry')}
          </Button>
          <Button onClick={onChangeProvider}>{t('models.changeProvider')}</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ProviderBrandIcon provider={provider.provider} />
          <Txt tone="ink" as="span" variant="body">
            {providerDisplayName(provider.provider)}
          </Txt>
        </div>
        <Button onClick={onChangeProvider}>{t('models.changeProvider')}</Button>
      </div>
      <Field>
        <FieldLabel>{t('models.factoryDefault')}</FieldLabel>
        <ModelCombobox
          models={models.models}
          value={modelId}
          onValueChange={onModelChange}
          placeholder={t('models.selectDefault')}
        />
      </Field>
      {previousUnavailable && (
        <Txt variant="caption" role="alert">
          {t('models.previousUnavailable')}
        </Txt>
      )}
      <SharedCredentialNotice modelId={modelId || undefined} />
    </div>
  );
}
