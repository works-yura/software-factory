import { useFirebaseStateQuery } from '../../../../../hooks/useFirebase';
import { useAllConnections, useConnectors } from '../../../../../hooks/useConnections';
import { useGitLabStatusQuery } from '../../../../../hooks/useGitLabData';
import { useMcpServersQuery } from '../../../../../hooks/useMcpServers';
import { useParams } from 'react-router';
import type { ConnectionSources } from '../../connections/connections';

/**
 * Every integration's state the Connections page is built from. Each loads on its own: a failing one
 * leaves its rows out and is named in `errors`, the others still show.
 */
export function useConnectionSources(): {
  sources: ConnectionSources;
  pending: boolean;
  errors: Array<{ kind: 'google-cloud' | 'mcp' | 'connections'; error: unknown; retry: () => void }>;
} {
  const { factoryId } = useParams<{ factoryId: string }>();
  const firebase = useFirebaseStateQuery();
  const mcp = useMcpServersQuery();
  const connections = useAllConnections(factoryId);
  const connectors = useConnectors();
  const gitlab = useGitLabStatusQuery();
  return {
    sources: {
      ...(firebase.data ? { firebase: firebase.data } : {}),
      ...(mcp.data ? { mcp: mcp.data } : {}),
      ...(connections.data ? { connections: connections.data } : {}),
      ...(connectors.data ? { connectors: connectors.data.connectors } : {}),
      ...(gitlab.data ? { gitlab: gitlab.data } : {}),
    },
    pending: firebase.isPending || mcp.isPending || (Boolean(factoryId) && connections.isPending) || connectors.isPending,
    errors: [
      ...(firebase.isError ? [{ kind: 'google-cloud' as const, error: firebase.error, retry: () => void firebase.refetch() }] : []),
      ...(mcp.isError ? [{ kind: 'mcp' as const, error: mcp.error, retry: () => void mcp.refetch() }] : []),
      ...(connections.isError ? [{ kind: 'connections' as const, error: connections.error, retry: () => void connections.refetch() }] : []),
    ],
  };
}
