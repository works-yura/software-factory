import { routeSourceValues } from '@factory/core/boards/intake-routing';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Switch } from '@mastra/playground-ui/components/Switch';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';

import { useDependabotStatusQuery } from '../../../../hooks/useDependabotStatus';
import type { DependabotRepositoryStatus } from '../../../../hooks/useDependabotStatus';
import { useIntakeConfigQuery, useSaveIntakeConfigMutation } from '../../../../hooks/useIntakeConfig';
import { useIntakeRoutesQuery } from '../../../../hooks/useIntakeRoutes';

/** The `source.kind` a route names to take Dependabot alerts (ADR-0042). */
const DEPENDABOT_SOURCE_KIND = 'dependabot_alert';

/**
 * Settings › Надходження задач: the organization's switch for GitHub Dependabot alerts, and what
 * the last sweep read per linked repository — a missing permission or alerts switched off is said
 * here, not swallowed. Which alerts become cards, and where, is the routes' call (the editor below).
 */
export function DependabotIntakeBlock({ factoryProjectId }: { factoryProjectId: string }) {
  const { t } = useTranslation('settings');
  const config = useIntakeConfigQuery();
  const save = useSaveIntakeConfigMutation();
  const routes = useIntakeRoutesQuery(factoryProjectId).data ?? [];
  const enabled = config.data?.dependabot.enabled ?? false;
  const status = useDependabotStatusQuery(enabled).data ?? [];
  const routed = routes.some(
    route =>
      route.enabled &&
      !route.triggered &&
      route.on.includes('work_item.created') &&
      routeSourceValues(route, 'source.kind').includes(DEPENDABOT_SOURCE_KIND),
  );

  const toggle = (next: boolean) => {
    if (!config.data) return;
    save.mutate(
      { ...config.data, dependabot: { ...config.data.dependabot, enabled: next } },
      {
        onSuccess: () =>
          toast.success(t('intake.dependabot.saved', { state: t(next ? 'intake.dependabot.on' : 'intake.dependabot.off') })),
        onError: () => toast.error(t('intake.dependabot.saveFailed')),
      },
    );
  };

  return (
    <section aria-labelledby="dependabot-intake-title" className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <Txt as="h3" id="dependabot-intake-title" variant="card-title">
            {t('intake.dependabot.title')}
          </Txt>
          <Txt as="p" variant="caption" tone="muted">
            {t('intake.dependabot.description')}
          </Txt>
        </div>
        <Switch
          aria-label={t('intake.dependabot.toggle')}
          checked={enabled}
          disabled={!config.data || save.isPending}
          onCheckedChange={toggle}
        />
      </div>
      {enabled && !routed && <Notice variant="warning">{t('intake.dependabot.noRoute')}</Notice>}
      {enabled && <DependabotStatusLines status={status} />}
    </section>
  );
}

function DependabotStatusLines({ status }: { status: readonly DependabotRepositoryStatus[] }) {
  const { t } = useTranslation('settings');
  if (status.length === 0) {
    return (
      <Txt as="p" variant="caption" tone="muted">
        {t('intake.dependabot.notChecked')}
      </Txt>
    );
  }
  return (
    <ul className="flex flex-col gap-1" aria-label={t('intake.dependabot.title')}>
      {status.map(line => (
        <li key={line.repository}>
          {line.problem ? (
            <Notice variant="destructive">
              {t(`intake.dependabot.problems.${line.problem}`, {
                repository: line.repository,
                message: line.message ?? '',
              })}
            </Notice>
          ) : (
            <Txt as="span" variant="caption" tone="muted">
              {t('intake.dependabot.open', { repository: line.repository, count: line.openAlerts ?? 0 })}
            </Txt>
          )}
        </li>
      ))}
    </ul>
  );
}
