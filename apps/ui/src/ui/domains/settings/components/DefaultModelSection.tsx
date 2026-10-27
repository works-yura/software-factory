import { Button } from '@mastra/playground-ui/components/Button';
import { Field, FieldLabel } from '@mastra/playground-ui/components/Field';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  useApplyDefaultModel,
  useClearDefaultModel,
  useDefaultModelQuery,
  useSetDefaultModel,
} from '../../../../hooks/use-default-model';
import type { AvailableModelOption } from '../../../../hooks/useAvailableModels';
import { SkeletonRows } from '../../../ui/SkeletonRows';
import { ModelCombobox } from './ModelCombobox';

export function DefaultModelSection({
  models,
  modelsLoaded,
}: {
  models: AvailableModelOption[];
  modelsLoaded: boolean;
}) {
  const defaultModelQuery = useDefaultModelQuery();
  const { t } = useTranslation('settings');

  if (defaultModelQuery.isPending) {
    return <SkeletonRows label={t('models.default.loading')} rows={1} rowClassName="h-9 w-full" />;
  }

  if (defaultModelQuery.error) {
    return (
      <Txt as="p" variant="caption" className="text-destructive-foreground">
        {defaultModelQuery.error.message}
      </Txt>
    );
  }

  return (
    <DefaultModelEditor
      key={defaultModelQuery.data.modelId ?? 'no-default'}
      models={models}
      modelsLoaded={modelsLoaded}
      defaultModelId={defaultModelQuery.data.modelId ?? undefined}
    />
  );
}

function DefaultModelEditor({
  models,
  modelsLoaded,
  defaultModelId,
}: {
  models: AvailableModelOption[];
  modelsLoaded: boolean;
  defaultModelId: string | undefined;
}) {
  const { t } = useTranslation('settings');
  const setDefaultModel = useSetDefaultModel();
  const clearDefaultModel = useClearDefaultModel();
  const applyDefaultModel = useApplyDefaultModel();
  const [modelId, setModelId] = useState(defaultModelId ?? '');
  const [error, setError] = useState<string>();
  const busy = setDefaultModel.isPending || clearDefaultModel.isPending || applyDefaultModel.isPending;
  const defaultUnavailable =
    Boolean(defaultModelId) && modelsLoaded && !models.some(model => model.id === defaultModelId);

  const save = async () => {
    if (!modelId) return;
    setError(undefined);
    try {
      await setDefaultModel.mutateAsync(modelId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const clear = async () => {
    setError(undefined);
    try {
      await clearDefaultModel.mutateAsync();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const apply = async () => {
    setError(undefined);
    try {
      await applyDefaultModel.mutateAsync();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Field className="gap-1">
        <FieldLabel>{t('models.default.label')}</FieldLabel>
        <ModelCombobox models={models} value={modelId} onValueChange={setModelId} disabled={busy} />
      </Field>
      {defaultUnavailable ? (
        <Txt as="p" variant="caption" className="text-destructive-foreground">
          {t('models.default.unavailable', { model: defaultModelId })}
        </Txt>
      ) : null}
      {error ? (
        <Txt as="p" variant="caption" className="text-destructive-foreground">
          {error}
        </Txt>
      ) : null}
      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={busy || !modelId || modelId === defaultModelId}
          onClick={() => void save()}
        >
          {t('models.default.save')}
        </Button>
        <Button size="sm" disabled={busy || !defaultModelId} onClick={() => void clear()}>
          {t('models.default.clear')}
        </Button>
        <Button size="sm" disabled={busy || !defaultModelId || modelId !== defaultModelId} onClick={() => void apply()}>
          {t('models.default.apply')}
        </Button>
      </div>
      {applyDefaultModel.data ? (
        <Txt as="p" variant="caption">
          {t('models.default.applied', {
            count: applyDefaultModel.data.applied.length,
            skipped: applyDefaultModel.data.skipped.length,
          })}
        </Txt>
      ) : null}
    </div>
  );
}
