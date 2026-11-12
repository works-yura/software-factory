import { useAllConnections, useConnectors } from '../../../../../hooks/useConnections';
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
  errors: Array<{ kind: 'mcp' | 'connections'; error: unknown; retry: () => void }>;
} {
  const { factoryId } = useParams<{ factoryId: string }>();
  const mcp = useMcpServersQuery();
  const connections = useAllConnections(factoryId);
  const connectors = useConnectors();
  return {
    sources: {
      ...(mcp.data ? { mcp: mcp.data } : {}),
      ...(connections.data ? { connections: connections.data } : {}),
      ...(connectors.data ? { connectors: connectors.data.connectors } : {}),
    },
    pending: mcp.isPending || (Boolean(factoryId) && connections.isPending) || connectors.isPending,
    errors: [
      ...(mcp.isError ? [{ kind: 'mcp' as const, error: mcp.error, retry: () => void mcp.refetch() }] : []),
      ...(connections.isError ? [{ kind: 'connections' as const, error: connections.error, retry: () => void connections.refetch() }] : []),
    ],
  };
}
