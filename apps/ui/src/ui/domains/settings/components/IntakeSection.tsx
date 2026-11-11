import { Button } from '@mastra/playground-ui/components/Button';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { SkeletonRows } from '../../../ui/SkeletonRows';
import { useIntakeConfigQuery, useSaveIntakeConfigMutation } from '../../../../hooks/useIntakeConfig';
import type { IntakeConfig } from '../../factory/services/intake';
import { useFactoriesQuery } from '../../../../hooks/useFactories';
import { settingsSectionPath } from '../settingsSections';
import { ClickUpIntakeSection } from './ClickUpIntakeSection';
import { IntakeRoutesSection } from './IntakeRoutesSection';

/**
 * Settings › Intake in two parts. **Sources** are connections only: ClickUp, the Factory's
 * repositories and the board's «New card». **Intake routes** are one ordered list: «Коли» is a source
 * and a condition (a ClickUp List and status, a pull request…) or a schedule of the route's own, and
 * the route says where the card goes and what a later event does to it.
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
      <section aria-labelledby="intake-sources" className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <Txt as="h2" id="intake-sources" variant="body" tone="ink">
            {t('intake.sources.title')}
          </Txt>
          <Txt as="p" variant="caption" tone="muted">
            {t('intake.sources.description')}
          </Txt>
        </div>
        <ClickUpIntakeSection
          config={config}
          busy={saveMutation.isPending}
          update={update}
        />
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Txt as="p" variant="caption" tone="muted">
              {t('intake.sources.repositories')}
            </Txt>
            {factory && (
              <Button size="sm" variant="ghost" as={Link} to={settingsSectionPath(factory.id, 'repositories')}>
                {t('intake.sources.repositoriesLink')}
              </Button>
            )}
          </div>
          <Txt as="p" variant="caption" tone="muted">
            {t('intake.sources.manual')}
          </Txt>
        </div>
      </section>
      {factory && <IntakeRoutesSection factoryProjectId={factory.id} factoryName={factory.name} />}
    </div>
  );
}
