import type { McpCatalogEntry } from '@factory/core';
import { Button } from '@mastra/playground-ui/components/Button';
import { Input } from '@mastra/playground-ui/components/Input';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useMcpServersQuery } from '../../../../hooks/useMcpServers';
import type { McpServer, McpServersState } from '../services/mcpServers';
import { localized } from './mcp-servers/McpCatalogFields';
import { McpServerEditor } from './mcp-servers/McpServerEditor';
import type { McpServerStart } from './mcp-servers/McpServerEditor';
import { SettingsSubsection } from './SettingsSubsection';
import { SourceItemCard } from './SourceItemCard';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Where a stored server starts its form from: its catalog entry, or an own server. */
function startOf(server: McpServer, catalog: McpCatalogEntry[]): McpServerStart {
  const entry = server.launch.transport === 'catalog' ? catalog.find(candidate => candidate.id === (server.launch as { entry: string }).entry) : undefined;
  return entry ? { kind: 'catalog', entry } : { kind: 'custom' };
}

/** «Додати сервер»: the catalog as cards with a search, and «Власний сервер» last. */
function CatalogPicker({ catalog, onPick }: { catalog: McpCatalogEntry[]; onPick: (start: McpServerStart) => void }) {
  const { t } = useTranslation('settings');
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const matches = catalog.filter(entry =>
    !needle ||
    [entry.label.uk, entry.label.en, entry.summary.uk, entry.summary.en, ...entry.variants.flatMap(variant => [variant.label.uk, variant.label.en])]
      .join(' ')
      .toLowerCase()
      .includes(needle),
  );
  const custom = { title: t('mcpServers.catalog.custom'), summary: t('mcpServers.catalog.customSummary') };
  const showCustom = !needle || `${custom.title} ${custom.summary}`.toLowerCase().includes(needle);

  return (
    <div className="flex flex-col gap-3" role="group" aria-label={t('mcpServers.catalog.title')}>
      <Txt as="h3" variant="body" tone="ink">
        {t('mcpServers.catalog.title')}
      </Txt>
      <Input aria-label={t('mcpServers.catalog.search')} placeholder={t('mcpServers.catalog.search')} value={query} onChange={event => setQuery(event.target.value)} />
      <div className="grid gap-2 sm:grid-cols-2">
        {matches.map(entry => (
          <Button
            key={entry.id}
            variant="ghost"
            className="border-border1 h-auto flex-col items-start gap-1 rounded-md border p-3 text-left whitespace-normal"
            onClick={() => onPick({ kind: 'catalog', entry })}
          >
            <Txt as="span" variant="body" tone="ink">
              {localized(entry.label)}
            </Txt>
            <Txt as="span" variant="caption" tone="muted">
              {localized(entry.summary)}
            </Txt>
          </Button>
        ))}
        {showCustom && (
          <Button
            variant="ghost"
            className="border-border1 h-auto flex-col items-start gap-1 rounded-md border border-dashed p-3 text-left whitespace-normal"
            onClick={() => onPick({ kind: 'custom' })}
          >
            <Txt as="span" variant="body" tone="ink">
              {custom.title}
            </Txt>
            <Txt as="span" variant="caption" tone="muted">
              {custom.summary}
            </Txt>
          </Button>
        )}
      </div>
      {!matches.length && !showCustom && (
        <Txt as="p" variant="caption" tone="muted">
          {t('mcpServers.catalog.nothing')}
        </Txt>
      )}
    </div>
  );
}

function ServerCard({ server, state }: { server: McpServer; state: McpServersState }) {
  const { t } = useTranslation('settings');
  const [open, setOpen] = useState(false);
  const start = startOf(server, state.catalog);
  const kind =
    start.kind === 'catalog'
      ? localized(start.entry.variants.find(variant => server.launch.transport === 'catalog' && variant.id === server.launch.variant)?.label ?? start.entry.label)
      : server.launch.transport === 'http'
        ? t('mcpServers.summary.address')
        : t('mcpServers.summary.local');
  const summary = [
    kind,
    server.assignments.length ? t('mcpServers.summary.factories', { count: server.assignments.length }) : t('mcpServers.summary.unassigned'),
    ...(server.enabled ? [] : [t('mcpServers.summary.off')]),
  ].join(' · ');
  return (
    <SourceItemCard title={server.label} summary={summary} open={open} onOpenChange={setOpen}>
      <McpServerEditor server={server} start={start} state={state} onSaved={() => {}} />
    </SourceItemCard>
  );
}

/**
 * Settings › MCP-сервери — the MCP manager. «Додати сервер» opens the catalog (MCP Registry
 * `server.json` entries, in the person's language) and «Власний сервер»; the form is built from the
 * entry's declared inputs, an account input picks one of the organization's accounts. Each server
 * says which cards get it (Factory, boards, phases), what each of its tools may do, and whether
 * personal data in results is masked.
 */
export function McpServersSection() {
  const { t } = useTranslation('settings');
  const query = useMcpServersQuery();
  const [adding, setAdding] = useState<'catalog' | McpServerStart | undefined>();
  const state = query.data;

  return (
    <div className="flex flex-col gap-8">
      <SettingsSubsection
        title={t('mcpServers.title')}
        description={t('mcpServers.description')}
        scope="org"
        action={
          state?.canEdit && !adding ? (
            <Button size="sm" variant="ghost" onClick={() => setAdding('catalog')}>
              {t('mcpServers.add')}
            </Button>
          ) : undefined
        }
      >
        {query.isPending && (
          <Txt as="p" variant="caption" tone="muted">
            {t('mcpServers.loading')}
          </Txt>
        )}
        {query.isError && (
          <Txt as="p" variant="caption" className="text-destructive-foreground">
            {errorMessage(query.error)}
          </Txt>
        )}
        {state && state.servers.length === 0 && !adding && (
          <Txt as="p" variant="caption" tone="muted">
            {t('mcpServers.empty')}
          </Txt>
        )}
        {adding === 'catalog' && state && (
          <div className="flex flex-col gap-2">
            <CatalogPicker catalog={state.catalog} onPick={setAdding} />
            <Button size="sm" variant="ghost" className="self-start" onClick={() => setAdding(undefined)}>
              {t('mcpServers.cancel')}
            </Button>
          </div>
        )}
        {adding && adding !== 'catalog' && state && (
          <SourceItemCard
            title={adding.kind === 'catalog' ? localized(adding.entry.label) : t('mcpServers.catalog.custom')}
            summary=""
            open
            onOpenChange={open => !open && setAdding(undefined)}
          >
            <div className="flex flex-col gap-2">
              <Button size="sm" variant="ghost" className="self-start" onClick={() => setAdding('catalog')}>
                {t('mcpServers.catalog.back')}
              </Button>
              <McpServerEditor start={adding} state={state} onSaved={() => setAdding(undefined)} />
            </div>
          </SourceItemCard>
        )}
        <div className="flex flex-col gap-3">
          {state?.servers.map(server => (
            <ServerCard key={server.id} server={server} state={state} />
          ))}
        </div>
      </SettingsSubsection>
    </div>
  );
}
