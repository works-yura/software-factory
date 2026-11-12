import { useClickUpStatusQuery } from '../../../../../hooks/useClickUp';
import { useFirebaseStateQuery } from '../../../../../hooks/useFirebase';
import { useGithubStatusQuery } from '../../../../../hooks/useGithubStatus';
import { useGitLabStatusQuery } from '../../../../../hooks/useGitLabData';
import { useMcpServersQuery } from '../../../../../hooks/useMcpServers';
import type { ConnectionSources } from '../../connections/connections';

/**
 * Every integration's state the Connections page is built from. Each loads on its own: a failing one
 * leaves its rows out and is named in `errors`, the others still show.
 */
export function useConnectionSources(): {
  sources: ConnectionSources;
  pending: boolean;
  errors: Array<{ kind: 'google-cloud' | 'mcp'; error: unknown; retry: () => void }>;
} {
  const firebase = useFirebaseStateQuery();
  const mcp = useMcpServersQuery();
  const clickup = useClickUpStatusQuery();
  const github = useGithubStatusQuery();
  const gitlab = useGitLabStatusQuery();
  return {
    sources: {
      ...(firebase.data ? { firebase: firebase.data } : {}),
      ...(mcp.data ? { mcp: mcp.data } : {}),
      ...(clickup.data ? { clickup: clickup.data } : {}),
      ...(github.data ? { github: github.data } : {}),
      ...(gitlab.data ? { gitlab: gitlab.data } : {}),
    },
    pending: firebase.isPending || mcp.isPending,
    errors: [
      ...(firebase.isError ? [{ kind: 'google-cloud' as const, error: firebase.error, retry: () => void firebase.refetch() }] : []),
      ...(mcp.isError ? [{ kind: 'mcp' as const, error: mcp.error, retry: () => void mcp.refetch() }] : []),
    ],
  };
}
