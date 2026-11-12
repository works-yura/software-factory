import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@mastra/playground-ui/components/Command';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@mastra/playground-ui/components/Dialog';
import { SegmentedControl, SegmentedControlItem } from '@mastra/playground-ui/components/SegmentedControl';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { ChevronRight, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiConfig } from '../../../../../api/config';
import { useMcpServerMutations } from '../../../../../hooks/useMcpServers';
import { connectGithub } from '../../../workspaces/services/github';
import { connectionCatalog, filterCatalog, GITHUB_TOKEN_ITEM, linkableAccounts } from '../../connections/connections';
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
import { CapabilityDots, useCatalogDots } from './CapabilityDots';
import { ConnectionIcon } from './ConnectionIcon';
import { GithubTokenConnect, GoogleCloudConnect, SourceConnect } from './ConnectSteps';
import type { ConnectionTarget, FirstParty } from './ConnectSteps';

export type { ConnectionTarget };

const FILTERS: CatalogFilter[] = ['all', 'tools', 'sources'];

/** A connect step the dialog opens in place: a first-party integration's, or GitHub's token. */
type Step = Exclude<FirstParty, 'github'> | typeof GITHUB_TOKEN_ITEM;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The dialog's size is the kit's `md`; below 640px the kit turns it into a bottom drawer, which this
 * makes full height and square, clear of the notch, with the list taking what is left.
 */
export const CONNECT_DIALOG_SHELL =
  'max-sm:h-[calc(100dvh+3rem)] max-sm:max-h-none max-sm:rounded-none max-sm:pt-[env(safe-area-inset-top)]';

/**
 * One row, as the kit's command item: logo, name (MCP badge only for third-party servers), then «+»
 * — shown on the selected row with a mouse, always on touch — and the capability icons.
 */
function CatalogRow({
  value,
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
  value: string;
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
  const dots = useCatalogDots();
  return (
    <CommandItem value={value} onSelect={onSelect} disabled={disabled} aria-label={label} className="group/row">
      <ConnectionIcon kind={kind} />
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="text-body-sm text-foreground truncate">{name}</span>
        {detail && <span className="text-meta text-muted-foreground truncate">{detail}</span>}
        {mcp && (
          <Badge size="sm" variant="neutral" className="shrink-0">
            {t('connections.mcpBadge')}
          </Badge>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <span
          aria-hidden
          className="pointer-coarse:translate-x-0 pointer-coarse:opacity-100 translate-x-1 opacity-0 transition duration-150 group-data-[selected=true]/row:translate-x-0 group-data-[selected=true]/row:opacity-100 motion-reduce:transition-none"
        >
          <Button type="button" tabIndex={-1} variant="ghost" size="icon-sm" onClick={onSelect}>
            {trailing === 'add' ? <Plus /> : <ChevronRight />}
          </Button>
        </span>
        <CapabilityDots dots={dots(capabilities)} />
      </span>
    </CommandItem>
  );
}

/**
 * Step one, as Mastra's «Add connection to project»: the kit's command list with search and the
 * type filter on one line, then the organization's accounts this Factory can link, the first-party
 * integrations, and «Інше» — MCP servers, third-party or own. Keyboard: arrows move, Enter picks.
 */
function PickStep({
  factoryId,
  sources,
  onConnect,
  onPick,
}: {
  factoryId: string;
  sources: ConnectionSources;
  onConnect: (step: Step) => void;
  onPick: (target: ConnectionTarget) => void;
}) {
  const { t } = useTranslation('settings');
  const { baseUrl } = useApiConfig();
  const { save } = useMcpServerMutations();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CatalogFilter>('all');
  const [linking, setLinking] = useState<string>();

  const nameOf = (item: CatalogItem) =>
    item.entry
      ? localized(item.entry.label)
      : item.id === 'mcp-custom'
        ? t('connections.addDialog.customMcp')
        : item.id === GITHUB_TOKEN_ITEM
          ? t('connections.addDialog.githubToken')
          : t(`connections.kinds.${item.kind}`);
  const shown = filterCatalog(connectionCatalog(sources), linkableAccounts(factoryId, sources), {
    query,
    filter,
    textOf: item => `${nameOf(item)} ${item.entry ? localized(item.entry.summary) : ''}`,
  });
  const integrations = shown.items.filter(item => item.section === 'integrations');
  const other = shown.items.filter(item => item.section === 'other');

  const pick = (item: CatalogItem) => {
    // GitHub through the App is the App's own install flow on GitHub; its token has a step here.
    if (item.id === GITHUB_TOKEN_ITEM) onConnect(GITHUB_TOKEN_ITEM);
    else if (item.kind === 'github') connectGithub(baseUrl);
    else if (item.kind !== 'mcp') onConnect(item.kind);
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

  const heading = (text: string) => <span className="text-column text-muted-foreground tracking-normal normal-case">{text}</span>;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('connections.addDialog.title')}</DialogTitle>
        <DialogDescription className="sr-only">{t('connections.addDialog.description')}</DialogDescription>
      </DialogHeader>
      <Command shouldFilter={false} label={t('connections.addDialog.searchLabel')} className="min-h-0 flex-1 bg-transparent">
        <CommandInput
          aria-label={t('connections.addDialog.searchLabel')}
          placeholder={t('connections.addDialog.search')}
          value={query}
          onValueChange={setQuery}
          wrapperClassName="max-sm:flex-wrap max-sm:pb-2 max-sm:[&>[data-slot=command-input-right-slot]]:ml-0"
          className="max-sm:basis-[calc(100%-1.5rem)]"
          rightSlot={
            <SegmentedControl aria-label={t('connections.addDialog.filters.label')} size="sm" value={filter} onValueChange={setFilter}>
              {FILTERS.map(option => (
                <SegmentedControlItem key={option} value={option}>
                  {t(`connections.addDialog.filters.${option}`)}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          }
        />
        <CommandList
          scrollArea
          scrollAreaClassName="h-[min(26rem,calc(100dvh-16rem))] max-sm:h-auto max-sm:flex-1"
          className="px-2 py-2"
        >
          <CommandEmpty>{t('connections.addDialog.nothing')}</CommandEmpty>
          {shown.accounts.length > 0 && (
            <CommandGroup heading={heading(t('connections.addDialog.accounts'))} aria-label={t('connections.addDialog.accounts')}>
              {shown.accounts.map(account => (
                <CatalogRow
                  key={account.id}
                  value={account.id}
                  kind={account.kind}
                  name={account.name}
                  detail={account.server ? undefined : t('connections.addDialog.googleAccount')}
                  mcp={account.kind === 'mcp'}
                  capabilities={['tools']}
                  label={t('connections.addDialog.link', { name: account.name })}
                  trailing="add"
                  disabled={linking !== undefined}
                  onSelect={() => link(account)}
                />
              ))}
            </CommandGroup>
          )}
          {integrations.length > 0 && (
            <CommandGroup heading={heading(t('connections.addDialog.integrations'))} aria-label={t('connections.addDialog.integrations')}>
              {integrations.map(item => (
                <CatalogRow
                  key={item.id}
                  value={item.id}
                  kind={item.kind}
                  name={nameOf(item)}
                  capabilities={item.capabilities}
                  label={t('connections.addDialog.add', { name: nameOf(item) })}
                  trailing={item.connected ? 'open' : 'add'}
                  onSelect={() => pick(item)}
                />
              ))}
            </CommandGroup>
          )}
          {other.length > 0 && (
            <CommandGroup heading={heading(t('connections.addDialog.other'))} aria-label={t('connections.addDialog.other')}>
              {other.map(item => (
                <CatalogRow
                  key={item.id}
                  value={item.id}
                  kind={item.kind}
                  name={nameOf(item)}
                  mcp
                  capabilities={item.capabilities}
                  label={t('connections.addDialog.add', { name: nameOf(item) })}
                  trailing="add"
                  onSelect={() => pick(item)}
                />
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </>
  );
}

/**
 * «Додати підключення»: one dialog for picking and connecting. Step one lists what can be added; a
 * first-party integration opens its connect step in the same dialog (Google Cloud: an account and
 * its key; ClickUp, GitLab: their state and controls; «GitHub · токен»: the token). «GitHub» (the
 * server's GitHub App) starts the App's install flow on GitHub; an MCP server or an organization
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
  const [step, setStep] = useState<Step>();
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
      <DialogContent size="md" className={CONNECT_DIALOG_SHELL}>
        {step === 'google-cloud' ? (
          <GoogleCloudConnect accounts={sources.firebase?.accounts ?? []} onBack={back} onPick={onPick} />
        ) : step === GITHUB_TOKEN_ITEM ? (
          <GithubTokenConnect onBack={back} onPick={onPick} />
        ) : step ? (
          <SourceConnect kind={step} onBack={back} onPick={onPick} />
        ) : (
          <PickStep factoryId={factoryId} sources={sources} onConnect={setStep} onPick={onPick} />
        )}
      </DialogContent>
    </Dialog>
  );
}
