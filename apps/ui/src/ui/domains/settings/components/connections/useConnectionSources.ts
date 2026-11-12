import { useParams } from 'react-router';

import { useAllConnections, useConnectors } from '../../../../../hooks/useConnections';
import type { ConnectionsListResponse, ConnectorView } from '@factory/contracts';

/**
 * What the Connections page is built from, all of it the server's (ADR-0035): this Factory's
 * connections from every connector, and every connector with its methods.
 */
export function useConnectionSources(): {
  sources: { connections?: ConnectionsListResponse; connectors?: ConnectorView[] };
  pending: boolean;
  error: { error: unknown; retry: () => void } | undefined;
} {
  const { factoryId } = useParams<{ factoryId: string }>();
  const connections = useAllConnections(factoryId);
  const connectors = useConnectors();
  return {
    sources: {
      ...(connections.data ? { connections: connections.data } : {}),
      ...(connectors.data ? { connectors: connectors.data.connectors } : {}),
    },
    pending: (Boolean(factoryId) && connections.isPending) || connectors.isPending,
    error: connections.isError ? { error: connections.error, retry: () => void connections.refetch() } : undefined,
  };
}
