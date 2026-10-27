import { Button } from '@mastra/playground-ui/components/Button';
import { Field, FieldLabel } from '@mastra/playground-ui/components/Field';
import { Txt } from '@mastra/playground-ui/components/Txt';

import type { ProviderInfo } from '../../../../api/types';
import { SkeletonRows } from '../../../ui/SkeletonRows';
import { ModelCombobox } from '../../settings/components/ModelCombobox';
import { SharedCredentialNotice } from '../../settings/components/SharedCredentialNotice';
import { providerDisplayName } from '@factory/credentials/provider-display-name';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProviderModels } from '../hooks/useProviderModels';
import { ProviderBrandIcon } from './ProviderBrandIcon';

export interface FactoryDefaultModelFormProps {
  scope?: 'org' | 'user';
  initialModelId?: string;
  provider: ProviderInfo;
  onContinue: (modelId: string) => void;
  onChangeProvider: () => void;
  onPreviewModel?: (model: string) => void;
  submitLabel?: string;
}

export function FactoryDefaultModelForm({
  scope = 'org',
  initialModelId,
  provider,
  onContinue,
  onChangeProvider,
  onPreviewModel,
  submitLabel,
}: FactoryDefaultModelFormProps) {
  const { t } = useTranslation('workspaces');
  const choice = useProviderModels(provider.provider, scope);
  const [selectedModelId, setModelId] = useState(initialModelId);
  const modelId = selectedModelId
    ? (choice.models.find(model => model.id === selectedModelId)?.id ?? '')
    : (choice.suggestedModelId ?? '');

  if (choice.isPending) return <SkeletonRows label={t('models.loading')} rows={2} rowClassName="h-9 w-full" />;
  if (choice.catalogError || choice.models.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3">
        <Txt as="p" variant="caption" role="alert">
          {choice.catalogError?.message ?? t('models.noneForConnection')}
        </Txt>
        <div className="flex gap-2">
          <Button onClick={choice.retry}>{t('actions.retry')}</Button>
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
        <FieldLabel>{scope === 'user' ? t('models.yourDefault') : t('models.factoryDefault')}</FieldLabel>
        <ModelCombobox
          models={choice.models}
          value={modelId}
          onValueChange={modelId => {
            setModelId(modelId);
            onPreviewModel?.(modelId);
          }}
          placeholder={t('models.selectDefault')}
        />
      </Field>
      {selectedModelId && !modelId && (
        <Txt variant="caption" role="alert">
          {t('models.previousUnavailable')}
        </Txt>
      )}
      {scope === 'user' && (
        <Txt variant="meta" tone="muted">
          {t('models.updatesPersonalDefault')}
        </Txt>
      )}
      {scope === 'org' && <SharedCredentialNotice modelId={modelId || undefined} />}
      <Button variant="primary" className="w-full" disabled={!modelId} onClick={() => onContinue(modelId)}>
        {submitLabel ?? t('actions.continue')}
      </Button>
    </div>
  );
}
