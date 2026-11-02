import { Button } from '@mastra/playground-ui/components/Button';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { SettingsContainer } from '@mastra/playground-ui/new/settings';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { useApiConfig } from '../../../../api/config';
import { useFactoryQuery } from '../../../../hooks/useFactories';
import { useGithubStatusQuery } from '../../../../hooks/useGithubStatus';
import { useGitLabStatusQuery } from '../../../../hooks/useGitLabData';
import { MASTRA_PROJECTS_URL } from '../../factory/services/gitlab';
import { ConnectRepositoriesPanel } from '../../workspaces';
import { manageGithubConnection } from '../../workspaces/services/github';
import { settingsSectionPath } from '../settingsSections';
import { GithubPatBlock } from './GithubPatBlock';
import { ProviderConnectControl } from './PlatformProviderConnections';
import { SettingsSubsection } from './SettingsSubsection';
import { UserGithubConnectionRow } from './UserGithubConnectionRow';
import { Txt } from '@mastra/playground-ui/components/Txt';

export function RepositoriesSection() {
  const { t } = useTranslation('settings');
  const { factoryId } = useParams<{ factoryId: string }>();
  const { baseUrl } = useApiConfig();
  const factoryQuery = useFactoryQuery(factoryId);
  const githubStatus = useGithubStatusQuery().data;
  const githubConnected = githubStatus?.connected === true;
  // An access token is the deployment's connection: GitHub has nothing to manage per org.
  const githubFromToken = githubStatus?.mode === 'token';
  const gitlabStatus = useGitLabStatusQuery().data;
  const activeFactory = factoryQuery.data;

  if (!activeFactory) {
    return <Notice variant="info">{t('repositories.selectFactory')}</Notice>;
  }

  // The catalog marks the in-sentence link as <link>…</link>, so each language places it where its grammar needs.
  const [before = '', linkText = '', after = ''] = t('repositories.environmentHint').split(/<\/?link>/);

  const showGithubSettings = githubConnected || activeFactory.repositories.some(repo => repo.provider !== 'gitlab');

  const gitlabConnections = gitlabStatus?.connections ?? [];
  const gitlabReconnectTarget =
    gitlabStatus?.mode === 'platform' && gitlabStatus.reauthRequired
      ? (gitlabConnections.find(connection => connection.status === 'needs_reauth') ?? gitlabConnections[0])
      : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <SettingsSubsection
        scope="factory"
        title={t('repositories.title')}
        description={t('repositories.description', { name: activeFactory.name })}
        action={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {githubFromToken ? (
              <Txt as="span" variant="meta" tone="muted">
                {t('repositories.githubFromEnv')}
              </Txt>
            ) : (
              githubConnected && (
                <Button size="sm" onClick={() => manageGithubConnection(baseUrl)}>
                  {t('repositories.manageGithub')}
                </Button>
              )
            )}
            {gitlabStatus?.mode === 'platform' &&
              (gitlabReconnectTarget ? (
                <ProviderConnectControl
                  provider="gitlab"
                  reconnectConnectionId={gitlabReconnectTarget.id}
                  label={t('repositories.reconnectGitlab')}
                  size="sm"
                />
              ) : (
                <>
                  {gitlabStatus.configured && (
                    <Button as="a" href={MASTRA_PROJECTS_URL} target="_blank" size="sm">
                      {t('repositories.manageGitlab')}
                    </Button>
                  )}
                  <ProviderConnectControl
                    provider="gitlab"
                    label={gitlabStatus.configured ? t('repositories.connectAnotherGitlab') : t('repositories.connectGitlab')}
                    size="sm"
                    variant={gitlabStatus.configured ? 'ghost' : 'default'}
                  />
                </>
              ))}
            {gitlabStatus?.configured && gitlabStatus.mode === 'direct' && (
              <Txt as="span" variant="meta" tone="muted">
                {t('repositories.gitlabFromEnv')}
              </Txt>
            )}
          </div>
        }
      >
        <SettingsContainer>
          <ConnectRepositoriesPanel factory={activeFactory} />
        </SettingsContainer>
      </SettingsSubsection>

      <Txt as="p" variant="meta" tone="muted">
        {before}
        <Link to={settingsSectionPath(activeFactory.id, 'environment')} className="underline">
          {linkText}
        </Link>
        {after}
      </Txt>

      {showGithubSettings && (
        <>
          <UserGithubConnectionRow />

          <GithubPatBlock />
        </>
      )}
    </div>
  );
}
