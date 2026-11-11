import { Button } from '@mastra/playground-ui/components/Button';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { Switch } from '@mastra/playground-ui/components/Switch';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';

import { useClickUpStatusQuery } from '../../../../hooks/useClickUp';
import type { IntakeConfig } from '../../factory/services/intake';
import { SettingsSubsection } from './SettingsSubsection';

/**
 * ClickUp as a source: the connection and the import switch, nothing else. Which Lists a Factory reads
 * is said by its intake routes (a route's «ClickUp List» condition subscribes it to the List); where a
 * task lands and what a status change does are those routes too.
 */
export function ClickUpIntakeSection({
  config,
  busy,
  update,
}: {
  config: IntakeConfig;
  busy: boolean;
  update: (next: IntakeConfig) => void;
}) {
  const { t } = useTranslation('settings');
  const statusQuery = useClickUpStatusQuery();
  const status = statusQuery.data;
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
  const action =
    connected && status.workspaces.length > 0 ? (
      <Txt tone="muted" as="span" variant="caption">
        {t('intake.connectedTo', { name: status.workspaces.join(', ') })}
      </Txt>
    ) : statusQuery.isError || (status && !status.configured && status.reason === 'unavailable') ? (
      <Button size="sm" variant="ghost" onClick={() => void statusQuery.refetch()}>
        {t('intake.retry')}
      </Button>
    ) : undefined;

  return (
    <SettingsSubsection scope="org" title={t('intake.clickup.title')} description={description} action={action}>
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
            disabled={busy || !connected}
            onCheckedChange={enabled => update({ ...config, clickup: { ...config.clickup, enabled } })}
          />
        </SettingsRow>
      </SettingsContainer>

    </SettingsSubsection>
  );
}
