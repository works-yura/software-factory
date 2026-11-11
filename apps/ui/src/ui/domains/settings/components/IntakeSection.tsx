import { Txt } from '@mastra/playground-ui/components/Txt';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { SkeletonRows } from '../../../ui/SkeletonRows';
import { useIntakeConfigQuery, useSaveIntakeConfigMutation } from '../../../../hooks/useIntakeConfig';
import type { IntakeConfig } from '../../factory/services/intake';
import { useFactoriesQuery } from '../../../../hooks/useFactories';
import { ClickUpIntakeSection } from './ClickUpIntakeSection';
import { IntakeRoutesSection } from './IntakeRoutesSection';
import { IntakeRulesSection } from '../intake-rules/IntakeRulesSection';

/**
 * Settings › Intake: where work comes from and where it lands. The current Factory's intake routes
 * come first, since they win over ClickUp's tag routes and List boards.
 */
export function IntakeSection() {
  const { t } = useTranslation('settings');
  const { factoryId } = useParams<{ factoryId: string }>();
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

  // Routes belong to one Factory: the one these settings were opened from.
  const factory = factoryId ? (factoriesQuery.data ?? []).find(candidate => candidate.id === factoryId) : undefined;

  return (
    <div className="flex flex-col gap-8">
      {factory && <IntakeRoutesSection factoryProjectId={factory.id} factoryName={factory.name} />}
      {factory && <IntakeRulesSection factoryProjectId={factory.id} factoryName={factory.name} />}
      <ClickUpIntakeSection config={config} busy={saveMutation.isPending} update={update} factories={factoriesQuery.data ?? []} />
    </div>
  );
}
