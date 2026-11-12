import { Button } from '@mastra/playground-ui/components/Button';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { HarnessDescriptor } from '@factory/contracts/harnesses';

import { useAllConnections } from '../../../../../../hooks/useConnections';
import { connectorPath } from '../../../settingsSections';
import { SettingsSubsection } from '../../SettingsSubsection';

/**
 * Where a harness that runs on connections (ADR-0036) gets them: its connector in Settings ›
 * Підключення, with how many accounts it has and how many run now. Any such harness, by its
 * descriptor; the accounts themselves are managed there, not here.
 */
export function HarnessConnectionsSection({ factoryId, descriptor }: { factoryId: string; descriptor: HarnessDescriptor }) {
  const { t } = useTranslation('settings');
  const connector = descriptor.setup.accounts?.connector;
  const connections = useAllConnections(factoryId);
  if (!connector) return null;
  const own = (connections.data?.connections ?? []).filter(connection => connection.connector.id === connector);
  const running = own.filter(connection => connection.state.tone === 'ok').length;
  return (
    <SettingsSubsection scope="factory" title={t('models.agentAccounts.title')} description={t('models.agentAccounts.description', { name: descriptor.label })}>
      <SettingsContainer>
        <SettingsRow
          label={t('models.agentAccounts.label', { name: descriptor.label })}
          description={connections.data ? t('models.agentAccounts.count', { count: own.length, running }) : undefined}
        >
          <div className="flex items-center gap-2">
            {own.length === 0 && connections.data && (
              <Txt as="span" variant="caption" tone="muted">
                {t('models.agentAccounts.none')}
              </Txt>
            )}
            <Button size="sm" variant="default" render={<Link to={connectorPath(factoryId, connector, { connect: own.length === 0 })} />}>
              {own.length === 0 ? t('models.harness.connect', { name: descriptor.label }) : t('models.agentAccounts.manage')}
            </Button>
          </div>
        </SettingsRow>
      </SettingsContainer>
    </SettingsSubsection>
  );
}
