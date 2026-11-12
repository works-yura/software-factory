import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';

import { useMcpServersQuery } from '../../../../../hooks/useMcpServers';
import { SkeletonRows } from '../../../../ui/SkeletonRows';
import { McpServerEditor } from '../mcp-servers/McpServerEditor';
import { mcpStartOf } from './mcpStart';

/**
 * The one custom section of Підключення (ADR-0035): the MCP server editor — transport, access by
 * Factory and session kind, per-tool policy — too rich for descriptors. The server names the server
 * (`serverId`, or `owner` + `key` for one an integration manages, e.g. Google Cloud's «База»); a
 * managed one shows only what may change here (its tools and masking), embedded.
 */
export function McpServerSection({ params }: { params: Record<string, string> }) {
  const { t } = useTranslation('settings');
  const query = useMcpServersQuery();
  const state = query.data;
  if (query.isPending) return <SkeletonRows label={t('connections.loading')} rows={2} />;
  const server = state?.servers.find(candidate =>
    params.serverId ? candidate.id === params.serverId : candidate.owner?.integration === params.owner && candidate.owner?.key === params.key,
  );
  if (!state || !server) {
    return (
      <Txt as="p" variant="caption" tone="muted">
        {t('connections.connector.mcpPending')}
      </Txt>
    );
  }
  const managed = Boolean(server.owner);
  const start = mcpStartOf(server, state.catalog);
  const sections = managed ? (['config', 'tools'] as const) : (['config', 'access', 'tools'] as const);
  return (
    <div className="flex min-w-0 flex-col gap-5">
      {sections.map(section => (
        <McpServerEditor
          key={`${server.id}:${server.updatedAt}:${section}`}
          server={server}
          start={start}
          state={state}
          onSaved={() => {}}
          embedded={managed}
          section={section}
        />
      ))}
    </div>
  );
}
