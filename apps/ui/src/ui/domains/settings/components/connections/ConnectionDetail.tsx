import type { McpCatalogEntry } from '@factory/core';
import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@mastra/playground-ui/components/Collapsible';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useFactoriesQuery } from '../../../../../hooks/useFactories';
import { serverIntegration } from '../../connections/connections';
import type { ConnectionKind, ConnectionRow, ConnectionSources } from '../../connections/connections';
import type { McpServer, McpServersState } from '../../services/mcpServers';
import { ClickUpService } from '../ClickUpService';
import { AccountCard, BindingCard, draftOf, GoogleCloudService } from '../GoogleCloudService';
import { localized } from '../mcp-servers/McpCatalogFields';
import { McpServerEditor } from '../mcp-servers/McpServerEditor';
import { McpServerHealthLine } from '../mcp-servers/McpServerInspect';
import type { McpServerStart } from '../mcp-servers/McpServerEditor';
import { SettingsSubsection } from '../SettingsSubsection';
import { GitHubService, GitLabService } from '../SourceControlServices';
import { ConnectionIcon } from './ConnectionIcon';

/** Where a stored server starts its form from: its catalog entry, or an own server. */
export function mcpStartOf(server: McpServer, catalog: readonly McpCatalogEntry[]): McpServerStart {
  const entry = server.launch.transport === 'catalog' ? catalog.find(candidate => candidate.id === (server.launch as { entry: string }).entry) : undefined;
  return entry ? { kind: 'catalog', entry } : { kind: 'custom' };
}

function DetailHeader({ kind, title, mcp, onBack }: { kind: ConnectionKind; title: string; mcp: boolean; onBack: () => void }) {
  const { t } = useTranslation('settings');
  return (
    <div className="flex flex-col gap-3">
      <Button size="sm" variant="ghost" className="min-h-11 self-start md:min-h-0" onClick={onBack}>
        <ChevronLeft aria-hidden className="size-4" />
        {t('connections.back')}
      </Button>
      <div className="flex min-w-0 items-center gap-3">
        <ConnectionIcon kind={kind} />
        <Txt as="h2" variant="body" tone="ink" className="min-w-0 truncate text-base font-medium">
          {title}
        </Txt>
        {mcp && (
          <Badge size="xs" variant="neutral">
            {t('connections.mcpBadge')}
          </Badge>
        )}
      </div>
    </div>
  );
}

/**
 * «Діагностика», folded: how a first-party capability runs under the hood (the MCP package and the
 * server's identifier) and its last check — for when something does not work, not for every day.
 */
function Diagnostics({ server, catalog }: { server: McpServer; catalog: readonly McpCatalogEntry[] }) {
  const { t } = useTranslation('settings');
  const entry = server.launch.transport === 'catalog' ? catalog.find(candidate => candidate.id === (server.launch as { entry: string }).entry) : undefined;
  const transport = entry ? `MCP · ${entry.package.identifier} ${entry.package.version}` : 'MCP';
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-border1 rounded-lg border">
      <CollapsibleTrigger className="flex min-h-11 w-full items-center gap-2 px-4 py-2 text-left">
        <ChevronRight aria-hidden className={`size-4 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <Txt as="span" variant="body" tone="ink">
          {t('connections.detail.diagnostics')}
        </Txt>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-border1 flex flex-col gap-2 border-t px-4 py-3">
          <Txt as="p" variant="caption" tone="muted" className="break-words">
            {t('connections.detail.transport', { transport, server: server.name })}
          </Txt>
          <Txt as="span" variant="caption" tone="muted">
            <McpServerHealthLine server={server} />
          </Txt>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function Frame({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      {header}
      <div className="flex min-w-0 flex-col gap-5">{children}</div>
    </div>
  );
}

/**
 * One connection's own view, reached by `?connection=` (so a phone's back button returns to the
 * list): the integration's existing settings, unchanged — a Google Cloud binding with its account
 * and its «База» server's tool policy, an MCP server's form (access, tools, check, calls, masking),
 * or ClickUp / GitHub / GitLab.
 */
export function ConnectionDetail({
  id,
  linkAccountId,
  factoryId,
  rows,
  sources,
  onBack,
}: {
  id: string;
  linkAccountId?: string;
  factoryId: string;
  rows: readonly ConnectionRow[];
  sources: ConnectionSources;
  onBack: () => void;
}) {
  const { t } = useTranslation('settings');
  const factories = (useFactoriesQuery().data ?? []).map(factory => ({ id: factory.id, name: factory.name }));
  const factoryName = (factoryProjectId: string) => factories.find(factory => factory.id === factoryProjectId)?.name ?? factoryProjectId;
  const mcp: McpServersState | undefined = sources.mcp;
  const header = (kind: ConnectionKind, title: string, isMcp = false) => <DetailHeader kind={kind} title={title} mcp={isMcp} onBack={onBack} />;

  if (id === 'google-cloud') {
    return (
      <Frame header={header('google-cloud', t('connections.kinds.google-cloud'))}>
        <GoogleCloudService factoryId={factoryId} {...(linkAccountId ? { linkAccountId } : {})} />
      </Frame>
    );
  }
  if (id === 'clickup' || id === 'github' || id === 'gitlab') {
    return (
      <Frame header={header(id, t(`connections.kinds.${id}`))}>
        {id === 'clickup' ? <ClickUpService /> : id === 'github' ? <GitHubService /> : <GitLabService />}
      </Frame>
    );
  }
  if (id.startsWith('mcp-new:') && mcp) {
    const entryId = id.slice('mcp-new:'.length);
    const entry = mcp.catalog.find(candidate => candidate.id === entryId);
    const start: McpServerStart = entry ? { kind: 'catalog', entry } : { kind: 'custom' };
    return (
      <Frame header={header('mcp', entry ? localized(entry.label) : t('connections.detail.newMcp'), true)}>
        <McpServerEditor start={start} state={mcp} onSaved={onBack} />
      </Frame>
    );
  }

  const row = rows.find(candidate => candidate.id === id);
  // An MCP server of the organization, linked to this Factory or not (just unlinked, or linked from
  // «Додати підключення» before the list caught up): its form says which Factories have access.
  const server = id.startsWith('mcp:') ? mcp?.servers.find(candidate => `mcp:${candidate.id}` === id && (!candidate.owner || row !== undefined)) : undefined;
  if (server && mcp) {
    const integration = serverIntegration(server, mcp.catalog);
    if (integration) {
      // A database a first-party integration runs: that integration's «База», its transport only under «Діагностика».
      return (
        <Frame header={header(integration, row?.title ?? t(`connections.kinds.${integration}`))}>
          <SettingsSubsection title={t('connections.detail.database')} description={t('connections.detail.databaseHint')}>
            <McpServerEditor key={server.id} server={server} start={mcpStartOf(server, mcp.catalog)} state={mcp} onSaved={() => {}} embedded />
          </SettingsSubsection>
          <Diagnostics server={server} catalog={mcp.catalog} />
        </Frame>
      );
    }
    return (
      <Frame header={header('mcp', server.label, true)}>
        <McpServerEditor key={server.id} server={server} start={mcpStartOf(server, mcp.catalog)} state={mcp} onSaved={() => {}} />
      </Frame>
    );
  }
  if (row?.kind === 'google-cloud' && row.binding && sources.firebase) {
    const account = sources.firebase.accounts.find(candidate => candidate.id === row.accountId);
    return (
      <Frame header={header('google-cloud', row.title)}>
        <BindingCard stored={row.binding} draft={draftOf(row.binding)} accounts={sources.firebase.accounts} factories={factories} defaultOpen />
        {account && (
          <SettingsSubsection title={t('connections.detail.account')}>
            <AccountCard account={account} bindings={sources.firebase.bindings} factoryName={factoryName} />
          </SettingsSubsection>
        )}
        {row.server && mcp && (
          <SettingsSubsection title={t('connections.detail.database')} description={t('connections.detail.databaseHint')}>
            <McpServerEditor key={row.server.id} server={row.server} start={mcpStartOf(row.server, mcp.catalog)} state={mcp} onSaved={() => {}} embedded />
          </SettingsSubsection>
        )}
        {row.server && mcp && <Diagnostics server={row.server} catalog={mcp.catalog} />}
      </Frame>
    );
  }
  return (
    <Frame header={<DetailHeader kind="mcp" title={t('connections.title')} mcp={false} onBack={onBack} />}>
      <Txt as="p" variant="caption" tone="muted">
        {t('connections.detail.notFound')}
      </Txt>
    </Frame>
  );
}
