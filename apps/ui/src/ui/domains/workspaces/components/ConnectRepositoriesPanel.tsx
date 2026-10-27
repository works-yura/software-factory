import { Button } from '@mastra/playground-ui/components/Button';
import { ListSearch } from '@mastra/playground-ui/components/ListSearch';
import { ScrollArea } from '@mastra/playground-ui/components/ScrollArea';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { GithubIcon } from '@mastra/playground-ui/icons/GithubIcon';
import { RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { useApiConfig } from '../../../../api/config';
import { useGitLabProjectsQuery, useGitLabStatusQuery } from '../../../../hooks/useGitLabData';
import { useGithubReposQuery, useRefreshGithubReposMutation } from '../../../../hooks/useGithubRepos';
import { useGithubStatusQuery } from '../../../../hooks/useGithubStatus';
import { useLinkRepositoryMutation, useUnlinkRepositoryMutation } from '../../../../hooks/useFactories';
import { gitLabProjectRepository } from '../../factory/services/gitlab';
import { FolderIcon, GitLabIcon } from '../../../ui/icons';
import { SkeletonRows } from '../../../ui/SkeletonRows';
import type { FactoryProject, GithubStatus, SourceControlRepository } from '../services/github';
import { connectGithub, isGitLabRepository } from '../services/github';

/**
 * Repository linking for a server-backed Factory. Linked repositories retain
 * their provider identity; available repositories come from every configured
 * source-control provider.
 */
export function ConnectRepositoriesPanel({ factory }: { factory: FactoryProject }) {
  const { t } = useTranslation('workspaces');
  const { baseUrl } = useApiConfig();
  const statusQuery = useGithubStatusQuery();
  const status = statusQuery.data;
  const githubConnected = status?.connected === true;
  const gitlabStatusQuery = useGitLabStatusQuery();
  const gitlabConfigured = gitlabStatusQuery.data?.enabled === true && gitlabStatusQuery.data.configured;
  const [query, setQuery] = useState('');
  const reposQuery = useGithubReposQuery(query || undefined, githubConnected);
  const refreshRepos = useRefreshGithubReposMutation(query || undefined);
  const gitlabProjectsQuery = useGitLabProjectsQuery(gitlabConfigured);
  const linkRepository = useLinkRepositoryMutation();
  const unlinkRepository = useUnlinkRepositoryMutation();

  const factoryProjectId = factory.id;
  const linked = factory.repositories;
  const linkedKeys = new Set(linked.map(repo => `${repo.provider ?? 'github'}:${repo.slug}`));
  const gitlabRepos = (gitlabProjectsQuery.data ?? []).flatMap(project => {
    const repository = gitLabProjectRepository(project);
    return repository ? [repository] : [];
  });
  const repos: SourceControlRepository[] = [...(reposQuery.data ?? []), ...gitlabRepos];
  const normalizedQuery = query.trim().toLowerCase();
  const available = repos.filter(repo => {
    const provider = isGitLabRepository(repo) ? 'gitlab' : 'github';
    return (
      !linkedKeys.has(`${provider}:${repo.fullName}`) &&
      (!normalizedQuery || repo.fullName.toLowerCase().includes(normalizedQuery))
    );
  });
  // GitHub is filtered server-side; linked and GitLab repositories are filtered here.
  const visibleLinked = normalizedQuery
    ? linked.filter(repo => repo.slug.toLowerCase().includes(normalizedQuery))
    : linked;

  const error =
    reposQuery.error ??
    refreshRepos.error ??
    gitlabProjectsQuery.error ??
    linkRepository.error ??
    unlinkRepository.error;
  const busyRepoId = linkRepository.isPending ? linkRepository.variables?.repo.id : null;
  const unlinkingId = unlinkRepository.isPending ? unlinkRepository.variables?.projectRepositoryId : null;

  if (statusQuery.isPending || gitlabStatusQuery.isPending) {
    return <SkeletonRows label={t('vcs.loadingStatus')} rows={3} rowClassName="h-10 w-full rounded-xl" />;
  }

  return (
    <div className="flex min-w-0 flex-col" aria-label={t('connectRepos.label')}>
      {status && !gitlabConfigured && (
        <StatusCallout
          status={status}
          connected={githubConnected}
          empty={githubConnected && !reposQuery.isPending && repos.length === 0}
        />
      )}

      {!githubConnected && !gitlabConfigured && linked.length === 0 ? (
        status &&
        status.reason !== 'missing_config' &&
        status.reason !== 'organization_required' && (
          <div className="px-4 py-3">
            <Button variant="primary" onClick={() => connectGithub(baseUrl)}>
              <GithubIcon className="size-4" />
              {t('vcs.connect', { host: 'GitHub' })}
            </Button>
          </div>
        )
      ) : (
        <>
          <div className="flex items-center gap-2 px-4 py-2">
            <div className="min-w-0 flex-1">
              <ListSearch
                label={t('vcs.searchLabel')}
                placeholder={t('connectRepos.searchPlaceholder')}
                size="sm"
                value={query}
                onSearch={setQuery}
              />
            </div>
            {githubConnected && (
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('vcs.refreshGithub')}
                disabled={refreshRepos.isPending}
                onClick={() => refreshRepos.mutate()}
              >
                <RefreshCw
                  className={refreshRepos.isPending ? 'size-3.5 animate-spin' : 'size-3.5'}
                  aria-hidden="true"
                />
                {t('actions.refresh')}
              </Button>
            )}
          </div>

          {error && (
            <Txt as="p" variant="caption" className="text-destructive-foreground px-4 pb-2">
              {error.message}
            </Txt>
          )}

          <ScrollArea orientation="vertical" maxHeight="20rem">
            <div className="flex min-w-0 flex-col gap-px p-2">
              {visibleLinked.length > 0 && <ListHeading>{t('connectRepos.linked')}</ListHeading>}
              {visibleLinked.map(repo => (
                <div key={repo.projectRepositoryId} className="flex w-full items-center gap-3 rounded-md px-2 py-2">
                  <span className="min-w-0 flex-1">
                    <Txt as="span" tone="ink" className="flex items-center gap-1.5">
                      {repo.provider === 'gitlab' ? (
                        <GitLabIcon className="text-foreground size-3.5 shrink-0" />
                      ) : (
                        <GithubIcon className="text-foreground size-3.5 shrink-0" />
                      )}
                      <span className="min-w-0 truncate">{repo.slug}</span>
                    </Txt>
                    {repo.gitBranch && (
                      <Txt as="span" variant="caption" tone="muted" className="block truncate">
                        {t('connectRepos.defaultBranch', { branch: repo.gitBranch })}
                      </Txt>
                    )}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={unlinkingId !== null}
                    onClick={() =>
                      unlinkRepository.mutate({ factoryProjectId, projectRepositoryId: repo.projectRepositoryId })
                    }
                  >
                    {unlinkingId === repo.projectRepositoryId ? t('connectRepos.unlinking') : t('connectRepos.unlink')}
                  </Button>
                </div>
              ))}

              {(githubConnected && reposQuery.isPending) || (gitlabConfigured && gitlabProjectsQuery.isPending) ? (
                <div className="px-2 py-2">
                  <SkeletonRows label={t('connectRepos.loading')} rows={3} rowClassName="h-8 w-full rounded-md" />
                </div>
              ) : available.length === 0 ? (
                visibleLinked.length === 0 && (
                  <Txt tone="muted" as="p" variant="caption" className="px-2 py-2">
                    {repos.length > 0 ? t('connectRepos.allLinked') : t('connectRepos.noneFound')}
                  </Txt>
                )
              ) : (
                <>
                  {visibleLinked.length > 0 && <ListHeading>{t('connectRepos.available')}</ListHeading>}
                  {available.map(repo => {
                    const gitlab = isGitLabRepository(repo);
                    return (
                      <button
                        type="button"
                        key={`${gitlab ? 'gitlab' : 'github'}:${repo.id}`}
                        className="hover:bg-surface-overlay-soft flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-left disabled:cursor-not-allowed disabled:opacity-50"
                        title={repo.fullName}
                        disabled={busyRepoId !== null}
                        onClick={() => linkRepository.mutate({ factoryProjectId, repo })}
                      >
                        <span className="min-w-0 flex-1">
                          <Txt as="span" tone="ink" className="flex items-center gap-1.5">
                            {gitlab ? (
                              <GitLabIcon className="text-muted-foreground size-3.5 shrink-0" />
                            ) : (
                              <FolderIcon size={14} className="text-muted-foreground shrink-0" />
                            )}
                            <span className="min-w-0 truncate">{repo.fullName}</span>
                          </Txt>
                          <Txt as="span" variant="caption" tone="muted" className="block truncate">
                            {t('connectRepos.repoMeta', {
                              kind: gitlab
                                ? 'GitLab'
                                : repo.private
                                  ? t('connectRepos.private')
                                  : t('connectRepos.public'),
                              branch: repo.defaultBranch,
                            })}
                          </Txt>
                        </span>
                        {busyRepoId === repo.id && (
                          <Txt as="span" variant="caption" tone="muted">
                            {t('connectRepos.linking')}
                          </Txt>
                        )}
                      </button>
                    );
                  })}
                </>
              )}
            </div>
          </ScrollArea>
        </>
      )}
    </div>
  );
}

function ListHeading({ children }: { children: ReactNode }) {
  return (
    <Txt tone="muted" as="p" variant="meta" className="px-2 pt-3 pb-1 first:pt-0">
      {children}
    </Txt>
  );
}

/**
 * Actionable diagnostic callout explaining why GitHub is unavailable (or why
 * the repo list is empty). Never shows secret values — only env var names,
 * booleans, and public URLs.
 */
function StatusCallout({ status, connected, empty }: { status: GithubStatus; connected: boolean; empty: boolean }) {
  const { t } = useTranslation('workspaces');
  const calloutClass = 'px-4 py-3';
  const markup = { code: <code />, strong: <strong /> };

  // Auth required: the session expired or was never established.
  if (status.authRequired) {
    return (
      <Txt as="p" variant="caption" tone="muted" className={calloutClass}>
        {t('connectRepos.callout.authRequired')}
      </Txt>
    );
  }

  // Feature disabled: missing env config on the server.
  if (status.reason === 'missing_config' && status.diagnostics) {
    const missing = status.diagnostics.missingGithubAppEnvVars;
    return (
      <div className={calloutClass}>
        <Txt as="p" variant="caption" tone="muted" className="m-0 mb-1">
          {t('connectRepos.callout.disabled')}
        </Txt>
        {missing.length > 0 && (
          <Txt as="p" variant="caption" tone="muted" className="m-0 mb-1">
            <Trans
              t={t}
              i18nKey="connectRepos.callout.missingEnv"
              values={{ vars: missing.join(', ') }}
              components={markup}
            />
          </Txt>
        )}
        <Txt as="p" variant="caption" tone="muted" className="m-0">
          <Trans t={t} i18nKey="connectRepos.callout.configure" components={markup} />
        </Txt>
      </div>
    );
  }

  // Organization required: signed in but no WorkOS org.
  if (status.organizationRequired || status.reason === 'organization_required') {
    return (
      <Txt as="p" variant="caption" tone="muted" className={calloutClass}>
        {t('connectRepos.callout.organizationRequired')}
      </Txt>
    );
  }

  // Not connected: app installed but no installation persisted (callback didn't complete).
  if (!connected && status.reason === 'not_connected') {
    return (
      <Txt as="p" variant="caption" tone="muted" className={calloutClass}>
        <Trans t={t} i18nKey="connectRepos.callout.notConnected" components={markup} />
      </Txt>
    );
  }

  // Connected but no repos: installation may have no repo access.
  if (connected && empty) {
    return (
      <Txt as="p" variant="caption" tone="muted" className={calloutClass}>
        <Trans t={t} i18nKey="connectRepos.callout.noAccess" components={markup} />
      </Txt>
    );
  }

  return null;
}
