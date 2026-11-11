import { Button } from '@mastra/playground-ui/components/Button';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { Switch } from '@mastra/playground-ui/components/Switch';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';

import { useClickUpStatusQuery } from '../../../../hooks/useClickUp';
import { useIntakeConfigQuery, useSaveIntakeConfigMutation } from '../../../../hooks/useIntakeConfig';
import { SkeletonRows } from '../../../ui/SkeletonRows';

/**
 * Settings › Інтеграції › Сервіси › ClickUp: the connection and the import switch, nothing else.
 * Which Lists a Factory reads is said by its intake routes (a route's ClickUp «List» condition
 * subscribes it); where a task lands and what a status change does are those routes too.
 */
export function ClickUpService() {
  const { t } = useTranslation('settings');
  const statusQuery = useClickUpStatusQuery();
  const configQuery = useIntakeConfigQuery();
  const saveMutation = useSaveIntakeConfigMutation();
  const status = statusQuery.data;
  const config = configQuery.data;
  const connected = status?.connected === true;

  const description =
    statusQuery.isPending || !status
      ? t('intake.clickup.checking')
      : !status.configured
        ? status.reason === 'not_configured'
          ? t('intake.clickup.notConfigured')
          : status.reason === 'auth_required'
            ? t('intake.clickup.authRequired')
            : status.reason === 'organization_required'
              ? t('intake.clickup.organizationRequired')
              : t('intake.clickup.statusUnavailable')
        : !status.connected
          ? t('intake.clickup.rejected')
          : t('intake.clickup.ready', { seconds: status.intervalSeconds });
  const retry =
    statusQuery.isError || (status && !status.configured && status.reason === 'unavailable') ? (
      <Button size="sm" variant="ghost" onClick={() => void statusQuery.refetch()}>
        {t('intake.retry')}
      </Button>
    ) : null;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Txt as="p" variant="caption" tone="muted">
          {description}
        </Txt>
        {retry}
      </div>
      {configQuery.isPending ? (
        <SkeletonRows label={t('intake.loading')} rows={1} />
      ) : configQuery.isError || !config ? (
        <Txt tone="muted" as="p" variant="caption">
          {t('intake.unavailable')}
        </Txt>
      ) : (
        <SettingsContainer>
          {status?.connected === false && status.error && (
            <Txt tone="muted" as="p" variant="caption" className="px-4 py-2">
              {status.error}
            </Txt>
          )}
          <SettingsRow label={t('intake.clickup.sync')}>
            <Switch
              aria-label={t('intake.clickup.sync')}
              checked={config.clickup.enabled}
              disabled={saveMutation.isPending || !connected}
              onCheckedChange={enabled =>
                saveMutation.mutate(
                  { ...config, clickup: { ...config.clickup, enabled } },
                  {
                    onSuccess: () => toast.success(t('intake.saved')),
                    onError: err => toast.error(err instanceof Error ? err.message : t('intake.saveFailed')),
                  },
                )
              }
            />
          </SettingsRow>
        </SettingsContainer>
      )}
    </>
  );
}
