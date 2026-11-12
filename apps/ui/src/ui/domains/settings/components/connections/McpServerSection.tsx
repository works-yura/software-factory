import { Tab, TabContent, TabList, Tabs } from '@mastra/playground-ui/components/Tabs';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { useMcpServersQuery } from '../../../../../hooks/useMcpServers';
import { SkeletonRows } from '../../../../ui/SkeletonRows';
import { McpServerEditor } from '../mcp-servers/McpServerEditor';
import type { McpServerSection as EditorPart, McpServerStart } from '../mcp-servers/McpServerEditor';

/** The editor's parts as tabs, kept in the URL (`&view=`): «Налаштування», «Доступ», «Інструменти». */
type Part = Exclude<EditorPart, 'all'>;
const TAB_OF: Record<Part, 'settings' | 'access' | 'tools'> = { config: 'settings', access: 'access', tools: 'tools' };

/**
 * The one custom section of Підключення (ADR-0035): the MCP server editor — transport, access by
 * Factory and session kind, per-tool policy — too rich for descriptors. The server names what it
 * edits: a stored server (`serverId`), one an integration manages (`owner` + `key`, e.g. Google
 * Cloud's «База»: embedded, only its tools and masking change), or a new one (`entry` from the
 * catalog, or `custom`).
 */
export function McpServerSection({ params, onSaved }: { params: Record<string, string>; onSaved?: () => void }) {
  const { t } = useTranslation('settings');
  const [search, setSearch] = useSearchParams();
  const query = useMcpServersQuery();
  const state = query.data;
  if (query.isPending) return <SkeletonRows label={t('connections.loading')} rows={2} />;
  if (!state) return null;
  const startOf = (entryId: string | undefined): McpServerStart => {
    const entry = entryId ? state.catalog.find(candidate => candidate.id === entryId) : undefined;
    return entry ? { kind: 'catalog', entry } : { kind: 'custom' };
  };
  if (params.entry || params.custom) {
    return <McpServerEditor start={startOf(params.entry)} state={state} onSaved={onSaved ?? (() => {})} />;
  }
  const server = state.servers.find(candidate =>
    params.serverId ? candidate.id === params.serverId : candidate.owner?.integration === params.owner && candidate.owner?.key === params.key,
  );
  if (!server) {
    return (
      <Txt as="p" variant="caption" tone="muted">
        {t('connections.connector.mcpPending')}
      </Txt>
    );
  }
  const managed = Boolean(server.owner);
  const start = startOf(server.launch.transport === 'catalog' ? server.launch.entry : undefined);
  // A server an integration manages keeps the access its integration gives it.
  const parts: Part[] = managed ? ['config', 'tools'] : ['config', 'access', 'tools'];
  const requested = parts.find(part => TAB_OF[part] === search.get('view'));
  const current = requested ?? 'config';
  return (
    <Tabs<Part>
      defaultTab="config"
      value={current}
      onValueChange={value =>
        setSearch(
          previous => {
            const next = new URLSearchParams(previous);
            next.set('view', TAB_OF[value]);
            return next;
          },
          { replace: true },
        )
      }
    >
      <TabList aria-label={t('connections.detail.tabs.label')} size="sm">
        {parts.map(part => (
          <Tab key={part} value={part}>
            {t(`connections.detail.tabs.${TAB_OF[part]}`)}
          </Tab>
        ))}
      </TabList>
      {parts.map(part => (
        <TabContent key={part} value={part} className="flex min-w-0 flex-col gap-5 pt-4">
          <McpServerEditor
            key={`${server.id}:${server.updatedAt}:${part}`}
            server={server}
            start={start}
            state={state}
            onSaved={onSaved ?? (() => {})}
            embedded={managed}
            section={part}
          />
        </TabContent>
      ))}
    </Tabs>
  );
}
