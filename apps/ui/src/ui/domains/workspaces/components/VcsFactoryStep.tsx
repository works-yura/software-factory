import { Button } from '@mastra/playground-ui/components/Button';
import { SearchInput } from '@mastra/playground-ui/components/SearchInput';
import { SegmentedControl, SegmentedControlItem } from '@mastra/playground-ui/components/SegmentedControl';
import { useDebouncedValue } from '@mastra/playground-ui/hooks/use-debounced-value';
import { cn } from '@mastra/playground-ui/utils/cn';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { useGitLabProjectsQuery, useGitLabStatusQuery } from '../../../../hooks/useGitLabData';
import { useGithubReposQuery, useRefreshGithubReposMutation } from '../../../../hooks/useGithubRepos';
import { useGithubStatusQuery } from '../../../../hooks/useGithubStatus';
import { SkeletonRows } from '../../../ui/SkeletonRows';
import { gitLabProjectRepository } from '../../factory/services/gitlab';
import type { SourceControlRepository } from '../services/github';
import { githubCallbackAwaitsAccess } from '../services/githubCallbackRecovery';
import { gitLabUnavailableReason, githubUnavailableReason, repositoryHost } from '../services/sourceControlHosts';
import type { SourceControlHost } from '../services/sourceControlHosts';
import { translator } from '../../../i18n/t';
import type { GitHubAppCallbackResult } from './GitHubAppCallbackHandler';
import { OnboardingGithubHostRow } from './onboarding/OnboardingGithubHostRow';
import { OnboardingGithubNotice } from './onboarding/OnboardingGithubNotice';
import { OnboardingGithubTokenDialog } from './onboarding/OnboardingGithubTokenDialog';
import { OnboardingGitlabHostRow } from './onboarding/OnboardingGitlabHostRow';
import { OnboardingInset } from './onboarding/OnboardingInset';
import { OnboardingRepositoryError } from './onboarding/OnboardingRepositoryError';
import { OnboardingRepositoryRows } from './onboarding/OnboardingRepositoryRows';
import { OnboardingSearchInset } from './onboarding/OnboardingSearchInset';
import { OnboardingStepCard } from './onboarding/OnboardingStepCard';

const tk = translator('workspaces');

export interface VcsFactoryStepProps {
  /** The section's number on the page. */
  index: number;
  initialRepository?: SourceControlRepository;
  githubRedirecting: boolean;
  githubCallback?: GitHubAppCallbackResult;
  onDismissGithubCallback: () => void;
  onConnect: () => void;
  onManageConnection: () => void;
  onSelectRepository: (repository: SourceControlRepository) => void;
  onPreviewRepository?: (repository: SourceControlRepository | undefined) => void;
}

export function VcsFactoryStep({
  index,
  initialRepository,
  githubRedirecting,
  githubCallback,
  onDismissGithubCallback,
  onConnect,
  onManageConnection,
  onSelectRepository,
  onPreviewRepository,
}: VcsFactoryStepProps) {
  // Decided once on arrival: a GitHub App result is about GitHub, so it opens there even over a GitLab
  // repository or a ready GitLab, and stays there when the result is dismissed. Undefined follows the
  // connection status, so an OAuth return lands on the connected host.
  const [pinnedHost, setPinnedHost] = useState<SourceControlHost | undefined>(() => {
    if (githubCallback) return 'github';
    return initialRepository && repositoryHost(initialRepository);
  });
  const [chosenRepository, setChosenRepository] = useState(initialRepository);
  const [query, setQuery] = useState('');
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const debouncedQuery = useDebouncedValue(query, 750);
  // Clearing the box shows the full list at once; only typing waits for the debounce.
  const search = query === '' ? '' : debouncedQuery;
  const githubStatus = useGithubStatusQuery();
  const connected = githubStatus.data?.connected === true;
  // Older servers don't say; only an explicit `false` means there is no App to connect through.
  const appConfigured = githubStatus.data?.appConfigured !== false;
  const gitlabStatus = useGitLabStatusQuery();
  const gitlabConfigured = Boolean(gitlabStatus.data?.enabled && gitlabStatus.data.configured);
  const anyHostReady = connected || gitlabConfigured;
  const host = pinnedHost ?? (connected ? 'github' : 'gitlab');
  const hostReady = host === 'github' ? connected : gitlabConfigured;
  const repositoryForProvider =
    chosenRepository && repositoryHost(chosenRepository) === host ? chosenRepository : undefined;
  const repositorySearch = search || undefined;
  const repos = useGithubReposQuery(repositorySearch, connected && host === 'github');
  const refreshRepos = useRefreshGithubReposMutation(repositorySearch);
  const gitlabProjects = useGitLabProjectsQuery(gitlabConfigured && host === 'gitlab');
  const gitlabRepos = (gitlabProjects.data ?? []).flatMap(project => {
    const repository = gitLabProjectRepository(project);
    return repository ? [repository] : [];
  });
  const repositoryQuery = host === 'gitlab' ? gitlabProjects : repos;
  // A failed first load has no list; its empty-list text would wrongly blame repository access.
  const repositoriesFailed = repositoryQuery.isError && repositoryQuery.data === undefined;
  const refreshFailed = host === 'github' && refreshRepos.isError;
  const statusPending = githubStatus.isPending || gitlabStatus.isPending;
  const chooseRepository = (repository: SourceControlRepository) => {
    setChosenRepository(repository);
    onPreviewRepository?.(repository);
  };
  const resetChoice = () => {
    setChosenRepository(undefined);
    onPreviewRepository?.(undefined);
    // A refresh failure was about the list it refreshed.
    refreshRepos.reset();
  };
  const showRepositories = !statusPending && hostReady;
  // With no host ready both rows show; otherwise only the selected host's row, so it can be connected.
  const showGithubRow = !statusPending && !hostReady && (!anyHostReady || host === 'github');
  const showGitlabRow = !statusPending && !hostReady && (!anyHostReady || host === 'gitlab');
  const refreshGithub = () => {
    // The repository refresh re-syncs status itself; refetching here too cancels and repeats it.
    if (connected) {
      const before = repos.data?.length ?? 0;
      refreshRepos.mutate(undefined, {
        // New repositories mean the access an approval waited on has landed.
        onSuccess: next => {
          if (githubCallbackAwaitsAccess(githubCallback) && next.length > before) onDismissGithubCallback();
        },
      });
      return;
    }
    // A fix made elsewhere (an owner's approval, a token connection) shows up here; its notice is then moot.
    void githubStatus.refetch().then(result => {
      if (result.data?.connected) onDismissGithubCallback();
    });
  };
  const connectToken = () => {
    onDismissGithubCallback();
    setTokenDialogOpen(true);
  };

  return (
    <OnboardingStepCard
      section="vcs"
      index={index}
      headerEnd={
        !statusPending &&
        anyHostReady && (
          <SegmentedControl
            aria-label={tk('vcs.hostLabel')}
            value={host}
            onValueChange={next => {
              setPinnedHost(next);
              setQuery('');
              resetChoice();
            }}
            className="max-[899px]:w-full"
          >
            <SegmentedControlItem value="github" className="max-[899px]:min-w-0 max-[899px]:flex-1">
              GitHub
            </SegmentedControlItem>
            <SegmentedControlItem value="gitlab" className="max-[899px]:min-w-0 max-[899px]:flex-1">
              GitLab
            </SegmentedControlItem>
          </SegmentedControl>
        )
      }
      notice={
        // With no host ready both host rows show, so GitHub's notice belongs there too.
        (host === 'github' || !anyHostReady) && (
          <OnboardingGithubNotice
            callback={githubCallback}
            statusReason={githubStatus.data?.reason}
            statusChecked={githubStatus.isFetchedAfterMount}
            redirecting={githubRedirecting}
            refreshing={githubStatus.isFetching || refreshRepos.isPending}
            onConnect={onConnect}
            onConnectToken={connectToken}
            onRefresh={refreshGithub}
            onDismiss={onDismissGithubCallback}
          />
        )
      }
      actions={
        showRepositories &&
        host === 'github' && (
          <>
            {/* A token sees what its account can; only the App has an access page to manage. */}
            {appConfigured && (
              <Button variant="ghost" size="sm" onClick={onManageConnection}>
                {tk('vcs.manageAccess')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              aria-label={tk('vcs.refreshGithub')}
              disabled={refreshRepos.isPending}
              onClick={refreshGithub}
            >
              <RefreshCw className={cn('size-3.5', refreshRepos.isPending && 'animate-spin')} aria-hidden="true" />
              {tk('actions.refresh')}
            </Button>
          </>
        )
      }
      primary={
        showRepositories && (
          <Button
            variant="primary"
            disabled={!repositoryForProvider}
            onClick={() => {
              if (repositoryForProvider) onSelectRepository(repositoryForProvider);
            }}
          >
            {tk('actions.continue')}
          </Button>
        )
      }
    >
      {statusPending && (
        <OnboardingInset>
          <SkeletonRows label={tk('vcs.loadingStatus')} rows={2} rowClassName="h-15 w-full" />
        </OnboardingInset>
      )}
      {(showGithubRow || showGitlabRow) && (
        <OnboardingInset>
          {showGithubRow && (
            <OnboardingGithubHostRow
              redirecting={githubRedirecting}
              unavailableReason={githubUnavailableReason(githubStatus.data?.reason)}
              appConfigured={appConfigured}
              retrying={githubStatus.isFetching}
              onConnect={onConnect}
              onConnectToken={connectToken}
              onRetry={() => void githubStatus.refetch()}
            />
          )}
          {showGitlabRow && (
            <OnboardingGitlabHostRow
              unavailableReason={gitLabUnavailableReason(gitlabStatus.data)}
              retrying={gitlabStatus.isFetching}
              onConnected={() => {
                setPinnedHost('gitlab');
                void gitlabStatus.refetch();
              }}
              onRetry={() => void gitlabStatus.refetch()}
            />
          )}
        </OnboardingInset>
      )}
      {showRepositories && (
        <OnboardingSearchInset
          search={
            <SearchInput
              label={tk('vcs.searchLabel')}
              placeholder={tk('vcs.searchPlaceholder')}
              value={query}
              onValueChange={value => {
                setQuery(value);
                resetChoice();
              }}
            />
          }
        >
          {refreshFailed ? (
            <OnboardingRepositoryError
              message={refreshRepos.error.message}
              retrying={refreshRepos.isPending}
              onRetry={refreshGithub}
            />
          ) : (
            repositoryQuery.isError && (
              <OnboardingRepositoryError
                message={repositoryQuery.error.message}
                retrying={repositoryQuery.isFetching}
                onRetry={() => void repositoryQuery.refetch()}
              />
            )
          )}
          {!repositoriesFailed && (
            <div
              onMouseLeave={() => onPreviewRepository?.(repositoryForProvider)}
              onBlur={event => {
                if (!event.currentTarget.contains(event.relatedTarget)) onPreviewRepository?.(repositoryForProvider);
              }}
            >
              <OnboardingRepositoryRows
                repositories={host === 'github' ? (repos.data ?? []) : gitlabRepos}
                host={host}
                search={search}
                pending={repositoryQuery.isPending}
                selectedRepositoryId={repositoryForProvider?.id}
                onSelectRepository={chooseRepository}
                onPreviewRepository={onPreviewRepository}
              />
            </div>
          )}
        </OnboardingSearchInset>
      )}
      <OnboardingGithubTokenDialog
        open={tokenDialogOpen}
        onClose={() => {
          setTokenDialogOpen(false);
          void githubStatus.refetch();
        }}
      />
    </OnboardingStepCard>
  );
}
