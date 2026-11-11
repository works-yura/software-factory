import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { useClickUpStatusQuery } from '../../../../hooks/useClickUp';
import { useFactoriesQuery } from '../../../../hooks/useFactories';
import { integrationsPath } from '../settingsSections';
import { IntakeRoutesSection } from './IntakeRoutesSection';

/**
 * Settings › Надходження задач: the intake routes only. «Коли» is a source and a condition (a ClickUp
 * List and status, a pull request…) or a schedule of the route's own, and the route says where the
 * card goes and what a later event does to it. Connecting a source (ClickUp, GitHub…) is in
 * Settings › Інтеграції; one line here says whether ClickUp is connected and links there.
 */
export function IntakeSection() {
  const { t } = useTranslation('settings');
  const { factoryId } = useParams<{ factoryId: string }>();
  const factoriesQuery = useFactoriesQuery();
  const clickup = useClickUpStatusQuery().data;
  // Routes belong to one Factory: the one these settings were opened from.
  const factory = factoryId ? (factoriesQuery.data ?? []).find(candidate => candidate.id === factoryId) : undefined;

  return (
    <div className="flex flex-col gap-8">
      {factory && (
        <Txt as="p" variant="caption" tone="muted">
          {clickup?.connected ? t('intake.clickupLink.connected') : t('intake.clickupLink.notConnected')}{' '}
          <Link to={integrationsPath(factory.id, { tab: 'services', service: 'clickup' })} className="underline">
            {t('intake.clickupLink.open')}
          </Link>
        </Txt>
      )}
      {factory && <IntakeRoutesSection factoryProjectId={factory.id} factoryName={factory.name} />}
    </div>
  );
}
