import { Notice } from '@mastra/playground-ui/components/Notice';
import { SettingsContainer } from '@mastra/playground-ui/new/settings';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { useFactoryQuery } from '../../../../hooks/useFactories';
import { useGithubStatusQuery } from '../../../../hooks/useGithubStatus';
import { ConnectRepositoriesPanel } from '../../workspaces';
import { connectionsPath, settingsSectionPath } from '../settingsSections';
import { GithubPatBlock } from './GithubPatBlock';
import { SettingsSubsection } from './SettingsSubsection';
import { UserGithubConnectionRow } from './UserGithubConnectionRow';

/**
 * Settings › Репозиторії: which repositories this Factory works in, and how work in them is signed:
 * the person's own GitHub account and the organization's tokens for the `gh` CLI in sandboxes.
 * Connecting accounts (GitHub App, tokens, GitLab) is in Settings › Підключення.
 */
export function RepositoriesSection() {
  const { t } = useTranslation('settings');
  const { factoryId } = useParams<{ factoryId: string }>();
  const factoryQuery = useFactoryQuery(factoryId);
  const activeFactory = factoryQuery.data;
  const github = useGithubStatusQuery().data;

  if (!activeFactory) {
    return <Notice variant="info">{t('repositories.selectFactory')}</Notice>;
  }

  // The catalog marks the in-sentence link as <link>…</link>, so each language places it where its grammar needs.
  const [before = '', linkText = '', after = ''] = t('repositories.environmentHint').split(/<\/?link>/);

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <SettingsSubsection
        scope="factory"
        title={t('repositories.title')}
        description={t('repositories.description', { name: activeFactory.name })}
      >
        <SettingsContainer>
          <ConnectRepositoriesPanel factory={activeFactory} />
        </SettingsContainer>
      </SettingsSubsection>

      {github?.connected && (
        <>
          {/* The person's own GitHub account links through the App's OAuth, so only with an App. */}
          {github.appConfigured !== false && <UserGithubConnectionRow />}
          <GithubPatBlock />
        </>
      )}

      <Txt as="p" variant="meta" tone="muted">
        {t('repositories.connectionsHint')}{' '}
        <Link to={connectionsPath(activeFactory.id)} className="underline">
          {t('repositories.openIntegrations')}
        </Link>
      </Txt>

      <Txt as="p" variant="meta" tone="muted">
        {before}
        <Link to={settingsSectionPath(activeFactory.id, 'environment')} className="underline">
          {linkText}
        </Link>
        {after}
      </Txt>
    </div>
  );
}
