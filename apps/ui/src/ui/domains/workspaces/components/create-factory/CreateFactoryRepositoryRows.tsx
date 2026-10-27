import { CommandGroup } from '@mastra/playground-ui/components/Command';
import { CommandPaletteItem } from '@mastra/playground-ui/components/CommandPalette';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { useDebouncedValue } from '@mastra/playground-ui/hooks/use-debounced-value';
import { GithubIcon } from '@mastra/playground-ui/icons/GithubIcon';
import { Settings2 } from 'lucide-react';

import { toast } from '@mastra/playground-ui/components/Toaster';

import { useGitLabProjectsQuery, useGitLabStatusQuery } from '../../../../../hooks/useGitLabData';
import { useGithubReposQuery } from '../../../../../hooks/useGithubRepos';
import { useGithubStatusQuery } from '../../../../../hooks/useGithubStatus';
import { useConnectPlatformProviderMutation } from '../../../../../hooks/usePlatformConnections';
import { SkeletonRows } from '../../../../ui/SkeletonRows';
import { GitLabIcon } from '../../../../ui/icons';
import { gitLabProjectRepository } from '../../../factory/services/gitlab';
import type { GitLabRepository } from '../../../factory/services/gitlab';
import type { GithubRepo, GithubStatus, SourceControlRepository } from '../../services/github';
import { CreateFactoryPaletteAlert, CreateFactoryPaletteMessage } from './CreateFactoryPalette';
import { translator } from '../../../../i18n/t';

const tk = translator('workspaces');

export interface CreateFactoryRepositoryRowsProps {
  query: string;
  githubRedirecting: boolean;
  onConnect: () => void;
  onManageConnection: () => void;
  onSelectRepository: (repository: SourceControlRepository) => void;
}

function connectionMessage(status: GithubStatus | undefined): string {
  switch (status?.reason) {
    case 'missing_config':
      return tk('createFactory.repos.githubNotConfigured');
    case 'organization_required':
      return tk('createFactory.repos.githubOrganizationRequired');
    case 'auth_required':
      return tk('createFactory.repos.githubAuthRequired');
    default:
      return tk('createFactory.repos.githubInstall');
  }
}

export function CreateFactoryRepositoryRows({
  query,
  githubRedirecting,
  onConnect,
  onManageConnection,
  onSelectRepository,
}: CreateFactoryRepositoryRowsProps) {
  const githubStatus = useGithubStatusQuery();
  const connected = githubStatus.data?.connected === true;
  const gitlabStatus = useGitLabStatusQuery();
  const gitlabConfigured = Boolean(gitlabStatus.data?.enabled && gitlabStatus.data.configured);
  const gitlabProjects = useGitLabProjectsQuery(gitlabConfigured);
  const gitlabConnect = useConnectPlatformProviderMutation('gitlab');
  const gitlabConnecting = gitlabConnect.isPending;
  const startGitlabConnect = async () => {
    try {
      await gitlabConnect.mutateAsync({});
      toast.success(tk('vcs.hostConnected', { host: 'GitLab' }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tk('createFactory.repos.gitlabConnectFailed'));
    }
  };

  if (githubStatus.isPending || gitlabStatus.isPending) {
    return <SkeletonRows label={tk('connectRepos.loading')} rows={3} rowClassName="mx-2 my-1 h-12 rounded-xl" />;
  }

  const githubRows = !connected ? (
    (() => {
      const unavailable =
        githubStatus.data?.reason === 'organization_required' || githubStatus.data?.reason === 'missing_config';

      return (
        <CommandGroup heading="GitHub">
          <CommandPaletteItem
            icon={githubRedirecting ? <Spinner size="sm" aria-label={tk('vcs.connectingGithub')} /> : <GithubIcon />}
            title={unavailable ? tk('createFactory.repos.unavailable', { host: 'GitHub' }) : tk('vcs.connect', { host: 'GitHub' })}
            subtitle={connectionMessage(githubStatus.data)}
            value="connect-github"
            disabled={unavailable || githubRedirecting}
            onSelect={onConnect}
          />
        </CommandGroup>
      );
    })()
  ) : (
    <>
      <GithubRepositoryResults query={query} onSelectRepository={onSelectRepository} />
      <CommandGroup heading="GitHub">
        <CommandPaletteItem
          icon={<Settings2 />}
          title={tk('createFactory.repos.manageGithub')}
          subtitle={tk('createFactory.repos.manageGithubHint')}
          value="manage-github"
          onSelect={onManageConnection}
        />
      </CommandGroup>
    </>
  );

  return (
    <>
      {githubRows}
      {gitlabConfigured ? (
        <GitLabRepositoryResults
          query={query}
          projects={gitlabProjects.data?.flatMap(project => {
            const repository = gitLabProjectRepository(project);
            return repository ? [repository] : [];
          })}
          pending={gitlabProjects.isPending}
          error={gitlabProjects.error}
          onSelectRepository={onSelectRepository}
        />
      ) : (
        (() => {
          // Personal GitLab accounts see `enabled: true` from the status endpoint but the
          // connect-session request answers 403 with `organization_required`, so gate the
          // button here to keep it from starting a doomed Nango session.
          const gitlabUnavailable = !gitlabStatus.data?.enabled || gitlabStatus.data.reason === 'organization_required';
          const gitlabSubtitle = !gitlabStatus.data?.enabled
            ? tk('createFactory.repos.gitlabNotAvailable')
            : gitlabStatus.data.reason === 'organization_required'
              ? tk('createFactory.repos.gitlabOrganizationRequired')
              : tk('createFactory.repos.gitlabSignIn');
          return (
            <CommandGroup heading="GitLab">
              <CommandPaletteItem
                icon={
                  gitlabConnecting ? (
                    <Spinner size="sm" aria-label={tk('createFactory.repos.connectingGitlab')} />
                  ) : (
                    <GitLabIcon />
                  )
                }
                title={
                  gitlabUnavailable
                    ? tk('createFactory.repos.unavailable', { host: 'GitLab' })
                    : tk('vcs.connect', { host: 'GitLab' })
                }
                subtitle={gitlabSubtitle}
                value="connect-gitlab"
                disabled={gitlabUnavailable || gitlabConnecting}
                onSelect={() => void startGitlabConnect()}
              />
            </CommandGroup>
          );
        })()
      )}
    </>
  );
}

function GithubRepositoryResults({
  query,
  onSelectRepository,
}: Pick<CreateFactoryRepositoryRowsProps, 'query' | 'onSelectRepository'>) {
  const debouncedQuery = useDebouncedValue(query, 750);
  const repos = useGithubReposQuery(debouncedQuery || undefined, true);

  if (repos.isPending) {
    return <SkeletonRows label={tk('connectRepos.loading')} rows={3} rowClassName="mx-2 my-1 h-12 rounded-xl" />;
  }
  if (repos.isError) return <CreateFactoryPaletteAlert>{repos.error.message}</CreateFactoryPaletteAlert>;
  if (repos.data.length === 0)
    return <CreateFactoryPaletteMessage>{tk('connectRepos.noneFound')}</CreateFactoryPaletteMessage>;

  return (
    <CommandGroup heading={tk('createFactory.repos.repositories')}>
      {repos.data.map(repo => (
        <CommandPaletteItem
          key={repo.id}
          icon={<GithubIcon />}
          title={repo.fullName}
          subtitle={`${repo.private ? tk('vcs.private') : tk('createFactory.repos.public')} · ${repo.defaultBranch}`}
          value={`repo-${repo.id}`}
          onSelect={() => onSelectRepository(repo)}
        />
      ))}
    </CommandGroup>
  );
}

function GitLabRepositoryResults({
  query,
  projects,
  pending,
  error,
  onSelectRepository,
}: {
  query: string;
  projects: GitLabRepository[] | undefined;
  pending: boolean;
  error: Error | null;
  onSelectRepository: (repository: SourceControlRepository) => void;
}) {
  const normalizedQuery = query.trim().toLowerCase();
  const matches = (projects ?? []).filter(project => project.fullName.toLowerCase().includes(normalizedQuery));
  if (pending) {
    return (
      <SkeletonRows
        label={tk('vcs.loadingRepositories', { provider: 'GitLab' })}
        rows={3}
        rowClassName="mx-2 my-1 h-12 rounded-xl"
      />
    );
  }
  if (error) return <CreateFactoryPaletteAlert>{error.message}</CreateFactoryPaletteAlert>;
  return (
    <CommandGroup heading={tk('createFactory.repos.gitlabRepositories')}>
      {matches.length === 0 ? (
        <CreateFactoryPaletteMessage>{tk('vcs.noRepositories', { host: 'GitLab' })}</CreateFactoryPaletteMessage>
      ) : (
        matches.map(repo => (
          <CommandPaletteItem
            key={repo.id}
            icon={<GitLabIcon />}
            title={repo.fullName}
            subtitle={`GitLab · ${repo.defaultBranch}`}
            value={`gitlab-repo-${repo.id}`}
            onSelect={() => onSelectRepository(repo)}
          />
        ))
      )}
    </CommandGroup>
  );
}
