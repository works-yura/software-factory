import { Badge } from '@mastra/playground-ui/components/Badge';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@mastra/playground-ui/components/Dialog';
import { SearchInput } from '@mastra/playground-ui/components/SearchInput';
import { SegmentedControl, SegmentedControlItem } from '@mastra/playground-ui/components/SegmentedControl';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Tooltip, TooltipContent, TooltipTrigger } from '@mastra/playground-ui/components/Tooltip';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { ChevronRight, GitBranch, Inbox, Plus, Wrench } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useMcpServerMutations } from '../../../../../hooks/useMcpServers';
import { connectionCatalog, filterCatalog, linkableAccounts } from '../../connections/connections';
import type {
  CatalogCapability,
  CatalogFilter,
  CatalogItem,
  ConnectionKind,
  ConnectionSources,
  LinkableAccount,
} from '../../connections/connections';
import { serverToInput } from '../../services/mcpServers';
import { localized } from '../mcp-servers/McpCatalogFields';
import { ConnectionIcon } from './ConnectionIcon';
import { GoogleCloudConnect, SourceConnect } from './ConnectSteps';
import type { ConnectionTarget, FirstParty } from './ConnectSteps';

const FILTERS: CatalogFilter[] = ['all', 'tools', 'sources'];

const CAPABILITY_ICON: Record<CatalogCapability, typeof Wrench> = { tools: Wrench, tasks: Inbox, code: GitBranch };

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));


export type { ConnectionTarget };

/**
 * Phones get the whole screen (the dialog turns into a bottom drawer below 640px; this makes it full
 * height, square and clear of the notch); wider screens a centred 560px modal of fixed height, so
 * filtering does not make it jump.
 */
const SHELL =
  'gap-0 sm:max-w-[35rem] sm:h-[min(40rem,calc(100dvh-4rem))] max-sm:h-[calc(100dvh+3rem)] max-sm:max-h-none max-sm:rounded-none max-sm:pt-[env(safe-area-inset-top)]';

/** A row of the list: logo, name, capability icons, and «+» (on touch always; with a mouse on hover or focus). */
function CatalogRow({
  kind,
  name,
  detail,
  mcp,
  capabilities,
  label,
  trailing,
  onSelect,
  disabled,
}: {
  kind: ConnectionKind;
  name: string;
  detail?: string;
  mcp?: boolean;
  capabilities: CatalogCapability[];
  label: string;
  trailing: 'add' | 'open';
  onSelect: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation('settings');
  return (
    <li>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onSelect}
        className="group hover:bg-fill-subtle focus-visible:bg-fill-subtle focus-visible:ring-accent1 flex min-h-14 w-full items-center gap-3 rounded-lg px-2 text-left outline-none focus-visible:ring-2 disabled:opacity-60"
      >
        <ConnectionIcon kind={kind} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <Txt as="span" variant="body" tone="ink" className="truncate">
              {name}
            </Txt>
            {mcp && (
              <Badge size="xs" variant="neutral" emphasis="subtle" className="shrink-0">
                {t('connections.mcpBadge')}
              </Badge>
            )}
          </span>
          {detail && (
            <Txt as="span" variant="meta" tone="muted" className="truncate">
              {detail}
            </Txt>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {capabilities.map(capability => {
            const Icon = CAPABILITY_ICON[capability];
            return (
              <Tooltip key={capability}>
                <TooltipTrigger
                  render={
                    <span
                      aria-label={t(`connections.addDialog.capability.${capability}`)}
                      className="border-border1 text-icon3 flex size-7 items-center justify-center rounded-full border"
                    />
                  }
                >
                  <Icon aria-hidden className="size-3.5" />
                </TooltipTrigger>
                <TooltipContent>{t(`connections.addDialog.capability.${capability}`)}</TooltipContent>
              </Tooltip>
            );
          })}
        </span>
        <span
          aria-hidden
          className="bg-fill text-icon5 flex size-8 shrink-0 items-center justify-center rounded-full transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:hover)]:opacity-0"
        >
          {trailing === 'add' ? <Plus className="size-4" /> : <ChevronRight className="size-4" />}
        </span>
      </button>
    </li>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <Txt as="h3" variant="meta" tone="muted" className="px-2 pt-3 pb-1">
        {title}
      </Txt>
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}

/**
 * Step one: search, the type filter, then the organization's accounts this Factory can link, the
 * first-party integrations, and «Інше» — MCP servers, third-party or own. First-party rows name what
 * they give agents (icons with tooltips), never how they run.
 */
function PickStep({
  factoryId,
  sources,
  onConnect,
  onPick,
}: {
  factoryId: string;
  sources: ConnectionSources;
  onConnect: (kind: FirstParty) => void;
  onPick: (target: ConnectionTarget) => void;
}) {
  const { t } = useTranslation('settings');
  const { save } = useMcpServerMutations();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CatalogFilter>('all');
  const [linking, setLinking] = useState<string>();

  const nameOf = (item: CatalogItem) =>
    item.entry ? localized(item.entry.label) : item.id === 'mcp-custom' ? t('connections.addDialog.customMcp') : t(`connections.kinds.${item.kind}`);
  const shown = filterCatalog(connectionCatalog(sources), linkableAccounts(factoryId, sources), {
    query,
    filter,
    textOf: item => `${nameOf(item)} ${item.entry ? localized(item.entry.summary) : ''}`,
  });
  const integrations = shown.items.filter(item => item.section === 'integrations');
  const other = shown.items.filter(item => item.section === 'other');

  const pick = (item: CatalogItem) => {
    if (item.kind !== 'mcp') onConnect(item.kind);
    else onPick({ connection: item.entry ? `mcp-new:${item.entry.id}` : 'mcp-new:custom' });
  };

  const link = (account: LinkableAccount) => {
    if (!account.server) {
      onPick({ connection: 'google-cloud', account: account.targetId });
      return;
    }
    const server = sources.mcp?.servers.find(candidate => candidate.id === account.targetId);
    if (!server) return;
    setLinking(account.id);
    save.mutate(
      {
        ...serverToInput(server),
        assignments: [...server.assignments, { factoryProjectId: factoryId, sessions: ['chat', 'personal', 'cards'] }],
        id: server.id,
      },
      {
        onSuccess: () => {
          toast.success(t('connections.addDialog.linked', { name: server.label }));
          onPick({ connection: `mcp:${server.id}` });
        },
        onError: error => toast.error(errorMessage(error)),
        onSettled: () => setLinking(undefined),
      },
    );
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('connections.addDialog.title')}</DialogTitle>
        <DialogDescription className="sr-only">{t('connections.addDialog.description')}</DialogDescription>
      </DialogHeader>
      <div className="border-border1 flex shrink-0 flex-col gap-2 border-b px-5 pt-1 pb-3 sm:flex-row sm:items-center">
        <SearchInput
          className="min-w-0 sm:flex-1"
          label={t('connections.addDialog.searchLabel')}
          placeholder={t('connections.addDialog.search')}
          value={query}
          onValueChange={setQuery}
        />
        <div className="-mx-1 shrink-0 overflow-x-auto px-1">
          <SegmentedControl aria-label={t('connections.addDialog.filters.label')} size="sm" value={filter} onValueChange={setFilter}>
            {FILTERS.map(option => (
              <SegmentedControlItem key={option} value={option}>
                {t(`connections.addDialog.filters.${option}`)}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </div>
      </div>
      <DialogBody flush className="gap-2 px-3 pb-4">
        {shown.accounts.length > 0 && (
          <Section title={t('connections.addDialog.accounts')}>
            {shown.accounts.map(account => (
              <CatalogRow
                key={account.id}
                kind={account.kind}
                name={account.name}
                detail={account.server ? undefined : t('connections.addDialog.googleAccount')}
                mcp={account.kind === 'mcp'}
                capabilities={account.kind === 'mcp' || account.kind === 'google-cloud' ? ['tools'] : []}
                label={t('connections.addDialog.link', { name: account.name })}
                trailing="add"
                disabled={linking !== undefined}
                onSelect={() => link(account)}
              />
            ))}
          </Section>
        )}
        {integrations.length > 0 && (
          <Section title={t('connections.addDialog.integrations')}>
            {integrations.map(item => (
              <CatalogRow
                key={item.id}
                kind={item.kind}
                name={nameOf(item)}
                capabilities={item.capabilities}
                label={t('connections.addDialog.add', { name: nameOf(item) })}
                trailing={item.connected ? 'open' : 'add'}
                onSelect={() => pick(item)}
              />
            ))}
          </Section>
        )}
        {other.length > 0 && (
          <Section title={t('connections.addDialog.other')}>
            {other.map(item => (
              <CatalogRow
                key={item.id}
                kind={item.kind}
                name={nameOf(item)}
                mcp
                capabilities={item.capabilities}
                label={t('connections.addDialog.add', { name: nameOf(item) })}
                trailing="add"
                onSelect={() => pick(item)}
              />
            ))}
          </Section>
        )}
        {shown.items.length === 0 && shown.accounts.length === 0 && (
          <Txt as="p" variant="caption" tone="muted" className="py-8 text-center">
            {t('connections.addDialog.nothing')}
          </Txt>
        )}
      </DialogBody>
    </>
  );
}

/**
 * «Додати підключення»: one modal for picking and connecting. Step one lists what can be added;
 * a first-party integration opens its connect step in the same modal (Google Cloud: an account and
 * its key; ClickUp, GitHub, GitLab: their state and controls); an MCP server or an organization
 * account goes straight to its page.
 */
export function AddConnectionDialog({
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
  const [step, setStep] = useState<FirstParty>();
  const back = () => setStep(undefined);
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (next) return;
        setStep(undefined);
        onClose();
      }}
    >
      <DialogContent size="md" className={SHELL}>
        {step === 'google-cloud' ? (
          <GoogleCloudConnect accounts={sources.firebase?.accounts ?? []} onBack={back} onPick={onPick} />
        ) : step ? (
          <SourceConnect kind={step} onBack={back} onPick={onPick} />
        ) : (
          <PickStep factoryId={factoryId} sources={sources} onConnect={setStep} onPick={onPick} />
        )}
      </DialogContent>
    </Dialog>
  );
}
