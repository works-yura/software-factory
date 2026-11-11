import { Tab, TabContent, TabList, Tabs } from '@mastra/playground-ui/components/Tabs';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { useClickUpStatusQuery } from '../../../../hooks/useClickUp';
import { useFirebaseStateQuery } from '../../../../hooks/useFirebase';
import { useGithubStatusQuery } from '../../../../hooks/useGithubStatus';
import { useGitLabStatusQuery } from '../../../../hooks/useGitLabData';
import type { IntegrationsService, IntegrationsTab } from '../settingsSections';
import { ClickUpService } from './ClickUpService';
import { GoogleCloudService } from './GoogleCloudService';
import { McpServersSection } from './McpServersSection';
import { SettingsSubsection } from './SettingsSubsection';
import { GitHubService, GitLabService } from './SourceControlServices';
import { SourceItemCard } from './SourceItemCard';

const SERVICES: readonly IntegrationsService[] = ['google-cloud', 'clickup', 'github', 'gitlab'];

const isTab = (value: string | null): value is IntegrationsTab => value === 'services' || value === 'mcp';
const isService = (value: string | null): value is IntegrationsService => SERVICES.includes(value as IntegrationsService);

/** Each service's one-line status for its card: «Підключено: …» or «Не підключено». */
function useServiceStatuses(): Record<IntegrationsService, string> {
  const { t } = useTranslation('settings');
  const google = useFirebaseStateQuery().data;
  const clickup = useClickUpStatusQuery().data;
  const github = useGithubStatusQuery().data;
  const gitlab = useGitLabStatusQuery().data;
  const notConnected = t('integrations.status.notConnected');
  return {
    'google-cloud': google?.accounts.length
      ? t('integrations.status.googleCloud', { accounts: google.accounts.length, bindings: google.bindings.length })
      : notConnected,
    clickup: clickup?.connected
      ? t('integrations.status.connectedTo', { name: clickup.workspaces.join(', ') || 'ClickUp' })
      : notConnected,
    github: github?.mode === 'token' ? t('integrations.status.fromEnv') : github?.connected ? t('integrations.status.connected') : notConnected,
    gitlab: gitlab?.configured ? (gitlab.mode === 'direct' ? t('integrations.status.fromEnv') : t('integrations.status.connected')) : notConnected,
  };
}

/**
 * Settings › Інтеграції: everything the Factory connects to, in one place.
 * - **Сервіси** — our deep integrations, each a card with its status that opens its own settings:
 *   Google Cloud (accounts, bindings with logs, crashes and «База»), ClickUp, GitHub, GitLab. Some run
 *   MCP servers under the hood (Google Cloud's «База» is MCP Toolbox); a person never sets those up.
 * - **MCP** — the catalog, own servers, and every server including the ones services manage.
 * The tab and the open service live in the URL (`?tab=services&service=google-cloud`), so links land on them.
 */
export function IntegrationsSection() {
  const { t } = useTranslation('settings');
  const [params, setParams] = useSearchParams();
  const tab: IntegrationsTab = isTab(params.get('tab')) ? (params.get('tab') as IntegrationsTab) : 'services';
  const openService = params.get('service');
  const statuses = useServiceStatuses();

  const update = (next: { tab?: IntegrationsTab; service?: IntegrationsService | null }) =>
    setParams(
      current => {
        const merged = new URLSearchParams(current);
        if (next.tab) merged.set('tab', next.tab);
        if (next.service === null) merged.delete('service');
        else if (next.service) merged.set('service', next.service);
        return merged;
      },
      { replace: true },
    );

  const bodies: Record<IntegrationsService, ReactNode> = {
    'google-cloud': <GoogleCloudService />,
    clickup: <ClickUpService />,
    github: <GitHubService />,
    gitlab: <GitLabService />,
  };

  return (
    <Tabs defaultTab="services" value={tab} onValueChange={(value: IntegrationsTab) => update({ tab: value, service: null })}>
      <TabList>
        <Tab value="services">{t('integrations.tabs.services')}</Tab>
        <Tab value="mcp">{t('integrations.tabs.mcp')}</Tab>
      </TabList>
      <TabContent value="services">
        <SettingsSubsection scope="org" title={t('integrations.services.title')} description={t('integrations.services.description')}>
          <div className="flex flex-col gap-3">
            {SERVICES.map(service => (
              <SourceItemCard
                key={service}
                title={t(`integrations.services.names.${service}`)}
                summary={statuses[service]}
                open={isService(openService) && openService === service}
                onOpenChange={open => update({ service: open ? service : null })}
              >
                {bodies[service]}
              </SourceItemCard>
            ))}
          </div>
        </SettingsSubsection>
      </TabContent>
      <TabContent value="mcp">
        <McpServersSection />
      </TabContent>
    </Tabs>
  );
}
