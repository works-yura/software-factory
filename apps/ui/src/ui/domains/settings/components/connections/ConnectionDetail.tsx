import type { McpCatalogEntry } from '@factory/core';
import { Button } from '@mastra/playground-ui/components/Button';
import { CopyButton } from '@mastra/playground-ui/components/CopyButton';
import { Input } from '@mastra/playground-ui/components/Input';
import { Tab, TabContent, TabList, Tabs } from '@mastra/playground-ui/components/Tabs';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { useFactoriesQuery } from '../../../../../hooks/useFactories';
import { useFactoryAuth } from '../../../../../hooks/useFactoryAuth';
import { useFactoryMembers } from '../../../../../hooks/useFactoryMembers';
import { serverIntegration } from '../../connections/connections';
import type { ConnectionRow, ConnectionSources } from '../../connections/connections';
import type { McpServer, McpServersState } from '../../services/mcpServers';
import { ClickUpService } from '../ClickUpService';
import { AccountCard, BindingCard, draftOf, GoogleCloudService } from '../GoogleCloudService';
import { McpServerEditor } from '../mcp-servers/McpServerEditor';
import type { McpServerSection, McpServerStart } from '../mcp-servers/McpServerEditor';
import { McpServerHealthLine, mcpErrorText } from '../mcp-servers/McpServerInspect';
import { SettingsSubsection } from '../SettingsSubsection';
import { GitLabService } from '../SourceControlServices';
import { ConnectionActivity } from './ConnectionActivity';
import { ConnectorDetailSections } from './ConnectorDetail';
import { HealthBadge, useRenameConnection } from './ConnectionList';
import { TimeAgo } from './TimeAgo';

/** Where a stored server starts its form from: its catalog entry, or an own server. */
export function mcpStartOf(server: McpServer, catalog: readonly McpCatalogEntry[]): McpServerStart {
  const entry = server.launch.transport === 'catalog' ? catalog.find(candidate => candidate.id === (server.launch as { entry: string }).entry) : undefined;
  return entry ? { kind: 'catalog', entry } : { kind: 'custom' };
}

type DetailTab = 'overview' | 'activity' | 'access' | 'tools' | 'settings' | 'diagnostics';

/** «Хто»: a member's name, «вами», the integration that manages it, or nothing when unknown. */
function useWho(factoryId: string) {
  const { t } = useTranslation('settings');
  const me = useFactoryAuth().data?.user?.userId;
  const members = useFactoryMembers(factoryId).data ?? [];
  return (userId: string | undefined) => {
    if (!userId) return undefined;
    if (userId === me) return t('connections.detail.byYou');
    if (userId.startsWith('integration:')) return t('connections.kinds.google-cloud');
    return members.find(member => member.id === userId)?.name;
  };
}

/** «Назва» with «Зберегти», when the connection's name is stored; otherwise just the name. */
function NameRow({ row }: { row: ConnectionRow }) {
  const { t } = useTranslation('settings');
  const { rename, pending } = useRenameConnection();
  const [name, setName] = useState(row.title);
  const next = name.trim();
  return (
    <SettingsRow label={t('connections.detail.name')}>
      {(row.view ? row.view.actions.rename === true : row.rename && (!row.orgActions || row.orgActions.rename === true)) ? (
        <form
          className="flex w-full items-center justify-end gap-2"
          onSubmit={event => {
            event.preventDefault();
            if (next && next !== row.title) rename(row, next);
          }}
        >
          <Input aria-label={t('connections.detail.name')} value={name} onChange={event => setName(event.target.value)} className="min-w-0 flex-1 sm:w-56 sm:flex-none" />
          <Button type="submit" size="sm" variant="primary" disabled={!next || next === row.title || pending}>
            {t('connections.detail.save')}
          </Button>
        </form>
      ) : (
        <span className="text-body-sm text-foreground">{row.title}</span>
      )}
    </SettingsRow>
  );
}

/** «Огляд», as Mastra's: name, account, created (when and by whom), last check, state, the connection's id. */
function Overview({ row, factoryId }: { row: ConnectionRow; factoryId: string }) {
  const { t } = useTranslation('settings');
  const who = useWho(factoryId);
  const health = row.server?.health;
  const failure = health && (row.state === 'error' || row.state === 'needs_auth') ? mcpErrorText(t, health.errorKind, health.error) : undefined;
  const connectionId = row.binding?.id ?? row.server?.id ?? row.id;
  const by = who(row.createdBy);
  const view = row.view;
  const stateMessage = view ? view.state.message : failure;
  return (
    <SettingsContainer>
      <NameRow row={row} />
      <SettingsRow label={t('connections.detail.account')}>
        <span className="text-body-sm flex min-w-0 flex-col items-end text-right max-sm:items-start max-sm:text-left">
          <span className="text-foreground truncate">{row.account?.name ?? (row.scope === 'organization' ? t('connections.organizationWide') : '—')}</span>
          {row.account?.detail && <span className="text-meta text-muted-foreground truncate">{row.account.detail}</span>}
        </span>
      </SettingsRow>
      {view?.method && (
        <SettingsRow label={t('connections.connector.method')}>
          <span className="text-body-sm text-foreground">{view.method}</span>
        </SettingsRow>
      )}
      {view?.dependents && (
        <SettingsRow label={t('connections.connector.dependents')}>
          <span className="text-body-sm text-foreground">{view.dependents}</span>
        </SettingsRow>
      )}
      <SettingsRow label={t('connections.detail.created')}>
        <span className="text-body-sm text-foreground flex items-center gap-1.5">
          {row.createdAt ? <TimeAgo value={row.createdAt} /> : <span className="text-muted-foreground">{t('connections.detail.notRecorded')}</span>}
          {row.createdAt && by && <span className="text-muted-foreground">· {by}</span>}
        </span>
      </SettingsRow>
      {health?.checkedAt && (
        <SettingsRow label={t('connections.detail.checked')}>
          <TimeAgo value={health.checkedAt} className="text-body-sm text-foreground" />
        </SettingsRow>
      )}
      <SettingsRow label={t('connections.detail.state')} {...(stateMessage ? { description: stateMessage } : {})}>
        <span className="flex items-center gap-2">
          <HealthBadge row={row} />
          {view ? (
            view.state.tone !== 'ok' && <span className="text-body-sm text-muted-foreground">{view.state.label}</span>
          ) : (
            row.state !== 'ok' && row.state !== 'connected' && <span className="text-body-sm text-muted-foreground">{t(`connections.states.${row.state}`)}</span>
          )}
        </span>
      </SettingsRow>
      <SettingsRow label={t('connections.detail.id')}>
        <span className="bg-surface-panel shadow-inset flex min-w-0 items-center gap-1 rounded-md py-0.5 pr-0.5 pl-2">
          <span className="text-meta text-muted-foreground truncate font-mono">{connectionId}</span>
          <CopyButton content={connectionId} size="icon-sm" variant="ghost" />
        </span>
      </SettingsRow>
    </SettingsContainer>
  );
}

/**
 * «Діагностика»: how a first-party capability runs under the hood (the MCP package, its version and
 * the server's identifier) and its last check — for when something does not work.
 */
function Diagnostics({ server, catalog }: { server: McpServer; catalog: readonly McpCatalogEntry[] }) {
  const { t } = useTranslation('settings');
  const entry = server.launch.transport === 'catalog' ? catalog.find(candidate => candidate.id === (server.launch as { entry: string }).entry) : undefined;
  const transport = entry ? `MCP · ${entry.package.identifier} ${entry.package.version}` : 'MCP';
  return (
    <SettingsContainer>
      <SettingsRow label={t('connections.detail.tabs.diagnostics')} description={t('connections.detail.transport', { transport, server: server.name })}>
        <Txt as="span" variant="caption" tone="muted">
          <McpServerHealthLine server={server} />
        </Txt>
      </SettingsRow>
    </SettingsContainer>
  );
}

/** Pages without tabs: the organization's Google Cloud accounts, a new MCP server, an organization-wide source opened by link. */
function Plain({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-5">{children}</div>;
}

/**
 * One connection's page (`?connection=`), as Mastra's: the page header names it (`ConnectionsPageHeader`),
 * then tabs — «Огляд», «Активність», and ours: «Доступ», «Інструменти», «Налаштування»,
 * «Діагностика» — each only where the connection has it. The tab is kept in the URL (`&view=`).
 */
export function ConnectionDetail({
  id,
  linkAccountId,
  factoryId,
  rows,
  sources,
}: {
  id: string;
  linkAccountId?: string;
  factoryId: string;
  rows: readonly ConnectionRow[];
  sources: ConnectionSources;
  onBack: () => void;
}) {
  const { t } = useTranslation('settings');
  const [params, setParams] = useSearchParams();
  const factories = (useFactoriesQuery().data ?? []).map(factory => ({ id: factory.id, name: factory.name }));
  const factoryName = (factoryProjectId: string) => factories.find(factory => factory.id === factoryProjectId)?.name ?? factoryProjectId;
  const mcp: McpServersState | undefined = sources.mcp;

  if (id === 'google-cloud') {
    return (
      <Plain>
        <GoogleCloudService factoryId={factoryId} {...(linkAccountId ? { linkAccountId } : {})} />
      </Plain>
    );
  }
  if (id.startsWith('mcp-new:') && mcp) {
    const entryId = id.slice('mcp-new:'.length);
    const entry = mcp.catalog.find(candidate => candidate.id === entryId);
    const start: McpServerStart = entry ? { kind: 'catalog', entry } : { kind: 'custom' };
    return (
      <Plain>
        <McpServerEditor start={start} state={mcp} onSaved={() => setParams(new URLSearchParams())} />
      </Plain>
    );
  }

  const listed = rows.find(candidate => candidate.id === id);
  // An MCP server of the organization this Factory is not linked to (just unlinked, or linked from
  // «Додати підключення» before the list caught up): its page, with its form saying who has access.
  const orphan = !listed && id.startsWith('mcp:') ? mcp?.servers.find(candidate => `mcp:${candidate.id}` === id && !candidate.owner) : undefined;
  const row: ConnectionRow | undefined =
    listed ??
    (orphan && mcp
      ? {
          id,
          kind: serverIntegration(orphan, mcp.catalog) ?? 'mcp',
          title: orphan.label,
          mcp: !serverIntegration(orphan, mcp.catalog),
          capabilities: [],
          state: orphan.enabled ? (orphan.health?.state ?? 'unchecked') : 'disabled',
          scope: 'factory',
          server: orphan,
          rename: 'server',
        }
      : undefined);
  const sourceKind =
    listed && (listed.kind === 'clickup' || listed.kind === 'gitlab') ? listed.kind : id === 'clickup' || id === 'gitlab' ? id : undefined;

  if (!row && sourceKind) {
    // An organization-wide source not connected yet (from its connect step or an old link): its own controls.
    return <Plain>{sourceKind === 'clickup' ? <ClickUpService /> : <GitLabService />}</Plain>;
  }
  if (!row) {
    return (
      <Txt as="p" variant="caption" tone="muted">
        {t('connections.detail.notFound')}
      </Txt>
    );
  }

  const server = row.server;
  const internal = server && mcp ? serverIntegration(server, mcp.catalog) : undefined;
  const editor = (section: McpServerSection) =>
    server && mcp ? (
      <McpServerEditor key={`${server.id}:${server.updatedAt}:${section}`} server={server} start={mcpStartOf(server, mcp.catalog)} state={mcp} onSaved={() => {}} embedded={Boolean(internal)} section={section} />
    ) : null;
  const account = row.binding ? sources.firebase?.accounts.find(candidate => candidate.id === row.accountId) : undefined;

  const settings: ReactNode = row.binding ? (
    <>
      <BindingCard stored={row.binding} draft={draftOf(row.binding)} accounts={sources.firebase?.accounts ?? []} factories={factories} defaultOpen />
      {account && (
        <SettingsSubsection title={t('connections.detail.account')}>
          <AccountCard account={account} bindings={sources.firebase?.bindings ?? []} factoryName={factoryName} />
        </SettingsSubsection>
      )}
      {server && (
        <SettingsSubsection title={t('connections.detail.database')} description={t('connections.detail.databaseHint')}>
          {editor('config')}
        </SettingsSubsection>
      )}
    </>
  ) : server ? (
    editor('config')
  ) : sourceKind === 'clickup' ? (
    <ClickUpService />
  ) : sourceKind === 'gitlab' ? (
    <GitLabService />
  ) : null;

  const tabs: Array<{ value: DetailTab; content: ReactNode }> = [
    {
      value: 'overview',
      content: (
        <>
          <Overview row={row} factoryId={factoryId} />
          {row.view && <ConnectorDetailSections id={row.view.id} />}
        </>
      ),
    },
    ...(server ? [{ value: 'activity' as const, content: <ConnectionActivity factoryId={factoryId} serverId={server.id} heading={false} /> }] : []),
    ...(server && !row.managed ? [{ value: 'access' as const, content: editor('access') }] : []),
    ...(server ? [{ value: 'tools' as const, content: editor('tools') }] : []),
    ...(settings ? [{ value: 'settings' as const, content: settings }] : []),
    ...(server && internal && mcp ? [{ value: 'diagnostics' as const, content: <Diagnostics server={server} catalog={mcp.catalog} /> }] : []),
  ];
  const requested = params.get('view') as DetailTab | null;
  const current = tabs.some(tab => tab.value === requested) ? (requested as DetailTab) : 'overview';

  return (
    <Tabs<DetailTab>
      defaultTab="overview"
      value={current}
      onValueChange={value =>
        setParams(
          previous => {
            const next = new URLSearchParams(previous);
            if (value === 'overview') next.delete('view');
            else next.set('view', value);
            return next;
          },
          { replace: true },
        )
      }
    >
      <TabList aria-label={t('connections.detail.tabs.label')} size="sm">
        {tabs.map(tab => (
          <Tab key={tab.value} value={tab.value}>
            {t(`connections.detail.tabs.${tab.value}`)}
          </Tab>
        ))}
      </TabList>
      {tabs.map(tab => (
        <TabContent key={tab.value} value={tab.value} className="flex min-w-0 flex-col gap-5 pt-4">
          {tab.content}
        </TabContent>
      ))}
    </Tabs>
  );
}
