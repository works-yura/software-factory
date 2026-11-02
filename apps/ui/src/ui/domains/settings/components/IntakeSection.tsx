import { Txt } from '@mastra/playground-ui/components/Txt';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { useTranslation } from 'react-i18next';

import { SkeletonRows } from '../../../ui/SkeletonRows';
import { useIntakeConfigQuery, useSaveIntakeConfigMutation } from '../../../../hooks/useIntakeConfig';
import type { IntakeConfig } from '../../factory/services/intake';
import { useFactoriesQuery } from '../../../../hooks/useFactories';
import { ClickUpIntakeSection } from './ClickUpIntakeSection';

/** Settings › Intake: where work comes from. ClickUp is the only intake source with settings. */
export function IntakeSection() {
  const { t } = useTranslation('settings');
  const configQuery = useIntakeConfigQuery();
  const saveMutation = useSaveIntakeConfigMutation();
  const factoriesQuery = useFactoriesQuery();
  const config = configQuery.data;

  if (configQuery.isPending) {
    return <SkeletonRows label={t('intake.loading')} rows={4} />;
  }
  if (configQuery.isError || !config) {
    return (
      <Txt tone="muted" as="p" variant="caption">
        {t('intake.unavailable')}
      </Txt>
    );
  }

  const update = (next: IntakeConfig) => {
    saveMutation.mutate(next, {
      onSuccess: () => toast.success(t('intake.saved')),
      onError: err => toast.error(err instanceof Error ? err.message : t('intake.saveFailed')),
    });
  };

  return (
    <div className="flex flex-col gap-8">
      <ClickUpIntakeSection config={config} busy={saveMutation.isPending} update={update} factories={factoriesQuery.data ?? []} />
    </div>
  );
}
