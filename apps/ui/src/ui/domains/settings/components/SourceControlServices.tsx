import { Button } from '@mastra/playground-ui/components/Button';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { useGitLabStatusQuery } from '../../../../hooks/useGitLabData';
import { MASTRA_PROJECTS_URL } from '../../factory/services/gitlab';
import { settingsSectionPath } from '../settingsSections';
import { ProviderConnectControl } from './PlatformProviderConnections';

/** «Which repositories this Factory works in» stays a Factory setting: a line back to Репозиторії. */
function RepositoriesLink() {
  const { t } = useTranslation('settings');
  const { factoryId } = useParams<{ factoryId: string }>();
  if (!factoryId) return null;
  return (
    <Txt as="p" variant="caption" tone="muted">
      {t('integrations.repositoriesHint')}{' '}
      <Link to={settingsSectionPath(factoryId, 'repositories')} className="underline">
        {t('integrations.openRepositories')}
      </Link>
    </Txt>
  );
}

/** Settings › Інтеграції › Сервіси › GitLab: connect, reconnect or manage the organization's GitLab connections. */
export function GitLabService() {
  const { t } = useTranslation('settings');
  const status = useGitLabStatusQuery().data;
  const connections = status?.connections ?? [];
  const reconnect =
    status?.mode === 'platform' && status.reauthRequired
      ? (connections.find(connection => connection.status === 'needs_reauth') ?? connections[0])
      : undefined;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Txt as="p" variant="caption" tone="muted">
          {status?.configured && status.mode === 'direct'
            ? t('repositories.gitlabFromEnv')
            : status?.configured
              ? t('integrations.gitlab.connected')
              : t('integrations.gitlab.notConnected')}
        </Txt>
        {status?.mode === 'platform' && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {reconnect ? (
              <ProviderConnectControl provider="gitlab" reconnectConnectionId={reconnect.id} label={t('repositories.reconnectGitlab')} size="sm" />
            ) : (
              <>
                {status.configured && (
                  <Button as="a" href={MASTRA_PROJECTS_URL} target="_blank" size="sm">
                    {t('repositories.manageGitlab')}
                  </Button>
                )}
                <ProviderConnectControl
                  provider="gitlab"
                  label={status.configured ? t('repositories.connectAnotherGitlab') : t('repositories.connectGitlab')}
                  size="sm"
                  variant={status.configured ? 'ghost' : 'default'}
                />
              </>
            )}
          </div>
        )}
      </div>
      <RepositoriesLink />
    </>
  );
}
