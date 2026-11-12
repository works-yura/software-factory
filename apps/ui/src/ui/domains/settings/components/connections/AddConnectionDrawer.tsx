import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@mastra/playground-ui/components/Drawer';
import { SearchInput } from '@mastra/playground-ui/components/SearchInput';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useIsMobile } from '@mastra/playground-ui/hooks/use-is-mobile';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useMcpServerMutations } from '../../../../../hooks/useMcpServers';
import { connectionCatalog, filterCatalog, linkableAccounts } from '../../connections/connections';
import type { CatalogFilter, CatalogItem, ConnectionSources, LinkableAccount } from '../../connections/connections';
import { serverToInput } from '../../services/mcpServers';
import { localized } from '../mcp-servers/McpCatalogFields';
import { ConnectionIcon } from './ConnectionIcon';

const FILTERS: CatalogFilter[] = ['all', 'tools', 'sources'];

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Where a pick in the drawer leads: a connection's page (`?connection=`), with an account to link. */
export type ConnectionTarget = { connection: string; account?: string };

/**
 * «Додати підключення»: one searchable catalog of integrations (Google Cloud, the MCP catalog's
 * servers, an own MCP server, ClickUp, GitHub, GitLab) and the organization's accounts this Factory
 * is not linked to yet. A side drawer on wide screens, a bottom sheet on phones. Linking an MCP
 * server gives this Factory access for every kind of session at once; a Google Cloud account opens
 * a new binding through it.
 */
export function AddConnectionDrawer({
  open,
  factoryId,
  sources,
  onPick,
  onClose,
}: {
  open: boolean;
  factoryId: string;
  sources: ConnectionSources;
  onPick: (target: ConnectionTarget) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('settings');
  const isMobile = useIsMobile();
  const { save } = useMcpServerMutations();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CatalogFilter>('all');

  const titleOf = (item: CatalogItem) =>
    item.entry ? localized(item.entry.label) : item.id === 'mcp-custom' ? t('mcpServers.catalog.custom') : t(`connections.kinds.${item.kind}`);
  const summaryOf = (item: CatalogItem) =>
    item.entry ? localized(item.entry.summary) : t(`connections.summaries.${item.id as 'google-cloud' | 'mcp-custom' | 'clickup' | 'github' | 'gitlab'}`);
  const shown = filterCatalog(connectionCatalog(sources), linkableAccounts(factoryId, sources), {
    query,
    filter,
    textOf: item => `${titleOf(item)} ${summaryOf(item)} ${item.entry?.variants.map(variant => localized(variant.label)).join(' ') ?? ''}`,
  });

  const pick = (item: CatalogItem) =>
    onPick({ connection: item.entry ? `mcp-new:${item.entry.id}` : item.id === 'mcp-custom' ? 'mcp-new:custom' : item.id });

  const link = (account: LinkableAccount) => {
    if (account.kind === 'google-cloud') {
      onPick({ connection: 'google-cloud', account: account.targetId });
      return;
    }
    const server = sources.mcp?.servers.find(candidate => candidate.id === account.targetId);
    if (!server) return;
    save.mutate(
      {
        ...serverToInput(server),
        assignments: [...server.assignments, { factoryProjectId: factoryId, sessions: ['chat', 'personal', 'cards'] }],
        id: server.id,
      },
      {
        onSuccess: () => {
          toast.success(t('connections.drawer.linked', { name: server.label }));
          onPick({ connection: `mcp:${server.id}` });
        },
        onError: error => toast.error(errorMessage(error)),
      },
    );
  };

  return (
    <Drawer
      side={isMobile ? 'bottom' : 'right'}
      variant={isMobile ? 'default' : 'floating'}
      overlay="visible"
      open={open}
      onOpenChange={next => !next && onClose()}
      onOpenChangeComplete={next => {
        if (next) return;
        setQuery('');
        setFilter('all');
      }}
    >
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('connections.drawer.title')}</DrawerTitle>
          <DrawerDescription>{t('connections.drawer.description')}</DrawerDescription>
        </DrawerHeader>
        <DrawerBody className="flex min-h-0 flex-col gap-3">
          <SearchInput label={t('connections.drawer.search')} placeholder={t('connections.drawer.search')} value={query} onValueChange={setQuery} />
          <div role="group" aria-label={t('connections.drawer.filters.label')} className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
            {FILTERS.map(option => (
              <Button
                key={option}
                size="sm"
                variant={filter === option ? 'default' : 'ghost'}
                aria-pressed={filter === option}
                className="min-h-11 shrink-0 md:min-h-0"
                onClick={() => setFilter(option)}
              >
                {t(`connections.drawer.filters.${option}`)}
              </Button>
            ))}
          </div>
          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
            {shown.accounts.length > 0 && (
              <section aria-label={t('connections.drawer.accounts')} className="flex flex-col gap-2">
                <Txt as="h3" variant="meta" tone="muted">
                  {t('connections.drawer.accounts')}
                </Txt>
                <ul className="border-border1 divide-border1 divide-y rounded-lg border">
                  {shown.accounts.map(account => (
                    <li key={account.id} className="flex min-h-14 items-center gap-3 py-2 pr-2 pl-3">
                      <ConnectionIcon kind={account.kind} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex min-w-0 items-center gap-2">
                          <Txt as="span" variant="caption" tone="ink" className="truncate">
                            {account.name}
                          </Txt>
                          {account.kind === 'mcp' && (
                            <Badge size="xs" variant="neutral">
                              {t('connections.mcpBadge')}
                            </Badge>
                          )}
                        </span>
                        <Txt as="span" variant="meta" tone="muted" className="truncate">
                          {account.kind === 'google-cloud' ? t('connections.drawer.accountHint') : account.detail}
                        </Txt>
                      </span>
                      <Button
                        size="sm"
                        className="min-h-11 shrink-0 md:min-h-0"
                        aria-label={`${t('connections.drawer.link')}: ${account.name}`}
                        disabled={save.isPending}
                        onClick={() => link(account)}
                      >
                        {t('connections.drawer.link')}
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {shown.items.length > 0 && (
              <section aria-label={t('connections.drawer.catalog')} className="flex flex-col gap-2">
                <Txt as="h3" variant="meta" tone="muted">
                  {t('connections.drawer.catalog')}
                </Txt>
                <ul className="border-border1 divide-border1 divide-y rounded-lg border">
                  {shown.items.map(item => (
                    <li key={item.id} className="flex min-h-14 items-center gap-3 py-2 pr-2 pl-3">
                      <ConnectionIcon kind={item.kind} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex min-w-0 flex-wrap items-center gap-2">
                          <Txt as="span" variant="caption" tone="ink">
                            {titleOf(item)}
                          </Txt>
                          {item.mcp && (
                            <Badge size="xs" variant="neutral">
                              {t('connections.mcpBadge')}
                            </Badge>
                          )}
                          {item.connected && (
                            <Badge size="xs" variant="success">
                              {t('connections.drawer.connected')}
                            </Badge>
                          )}
                        </span>
                        <Txt as="span" variant="meta" tone="muted" className="line-clamp-2">
                          {summaryOf(item)}
                        </Txt>
                      </span>
                      <Button
                        size="sm"
                        variant={item.connected ? 'ghost' : 'default'}
                        className="min-h-11 shrink-0 md:min-h-0"
                        aria-label={`${item.connected ? t('connections.drawer.open') : t('connections.drawer.connect')}: ${titleOf(item)}`}
                        onClick={() => pick(item)}
                      >
                        {item.connected ? t('connections.drawer.open') : t('connections.drawer.connect')}
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {shown.items.length === 0 && shown.accounts.length === 0 && (
              <Txt as="p" variant="caption" tone="muted" className="py-4 text-center">
                {t('connections.drawer.nothing')}
              </Txt>
            )}
          </div>
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}
