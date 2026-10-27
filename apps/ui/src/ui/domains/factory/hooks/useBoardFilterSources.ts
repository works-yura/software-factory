import { useGithubStatusQuery } from '../../../../hooks/useGithubStatus';
import { useGitLabStatusQuery } from '../../../../hooks/useGitLabData';

export function useBoardFilterSources() {
  const githubStatus = useGithubStatusQuery();
  const gitlabStatus = useGitLabStatusQuery();

  const connectedSources = new Set([
    ...(githubStatus.data?.connected ? ['github'] : []),
    ...(gitlabStatus.data?.enabled && gitlabStatus.data.configured ? ['gitlab'] : []),
  ]);

  return { connectedSources };
}
