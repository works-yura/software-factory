import type { ConnectionsListResponse, ConnectorView } from '@factory/contracts';
import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@mastra/playground-ui/components/Command';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@mastra/playground-ui/components/Dialog';
import { SegmentedControl, SegmentedControlItem } from '@mastra/playground-ui/components/SegmentedControl';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { connectionCatalog, filterCatalog } from '../../connections/connections';
import type { CatalogFilter, CatalogItem } from '../../connections/connections';
import { CapabilityDots, serverDots } from './CapabilityDots';
import { ConnectionIcon } from './ConnectionIcon';
import { ConnectorConnect } from './ConnectorSteps';
import type { ConnectionTarget } from './ConnectSteps';

export type { ConnectionTarget };

const FILTERS: CatalogFilter[] = ['all', 'agents', 'tools', 'sources'];

/** A connect step the dialog opens in place: a connector's (`connector:<id>`), or reconnecting a connection (`reconnect:<id>`). */
export type Step = `connector:${string}` | `reconnect:${string}`;

/**
 * The dialog's size is the kit's `md`; below 640px the kit turns it into a bottom drawer, which this
 * makes full height and square, clear of the notch, with the list taking what is left.
 */
export const CONNECT_DIALOG_SHELL =
  'max-sm:h-[calc(100dvh+3rem)] max-sm:max-h-none max-sm:rounded-none max-sm:pt-[env(safe-area-inset-top)]';

/**
 * One row, as the kit's command item: the connector's logo and name (MCP badge for MCP servers),
 * then «+» — shown on the selected row with a mouse, always on touch — and what it gives agents.
 */
function CatalogRow({ connector, onSelect }: { connector: ConnectorView; onSelect: () => void }) {
  const { t } = useTranslation('settings');
  return (
    <CommandItem value={`connector:${connector.id}`} onSelect={onSelect} aria-label={t('connections.addDialog.add', { name: connector.name })} className="group/row">
      <ConnectionIcon kind={connector.icon} />
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="text-body-sm text-foreground truncate">{connector.name}</span>
        {connector.mcp && (
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
            <Plus />
          </Button>
        </span>
        <CapabilityDots dots={serverDots(connector.provides)} />
      </span>
    </CommandItem>
  );
}

/**
 * Step one, as Mastra's «Add connection to project»: the kit's command list with search, the type
 * filter on its own line (four labels crowd the search), then the connectors the server describes — «Інтеграції», and «Інше» for
 * MCP; section headings only under «Усі», where they tell sections apart. Keyboard: arrows move,
 * Enter picks.
 */
function PickStep({ connectors, onConnect }: { connectors: readonly ConnectorView[]; onConnect: (step: Step) => void }) {
  const { t } = useTranslation('settings');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CatalogFilter>('all');
  const shown = filterCatalog(connectionCatalog(connectors), { query, filter });
  const agents = shown.filter(item => item.section === 'agents');
  const integrations = shown.filter(item => item.section === 'integrations');
  const other = shown.filter(item => item.section === 'other');
  const heading = (text: string) => <span className="text-column text-muted-foreground tracking-normal normal-case">{text}</span>;
  const group = (items: CatalogItem[], label: string) =>
    items.length > 0 && (
      <CommandGroup heading={filter === 'all' ? heading(label) : undefined} aria-label={label}>
        {items.map(item => (
          <CatalogRow key={item.id} connector={item.connector} onSelect={() => onConnect(`connector:${item.connector.id}`)} />
        ))}
      </CommandGroup>
    );

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
          wrapperClassName="border-b-0"
        />
        <div className="border-b border-border px-3 py-2">
          <SegmentedControl aria-label={t('connections.addDialog.filters.label')} size="sm" value={filter} onValueChange={setFilter}>
            {FILTERS.map(option => (
              <SegmentedControlItem key={option} value={option}>
                {t(`connections.addDialog.filters.${option}`)}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </div>
        <CommandList scrollArea scrollAreaClassName="h-[min(26rem,calc(100dvh-16rem))] max-sm:h-auto max-sm:flex-1" className="px-2 py-2">
          <CommandEmpty>{t('connections.addDialog.nothing')}</CommandEmpty>
          {group(agents, t('connections.addDialog.agents'))}
          {group(integrations, t('connections.addDialog.integrations'))}
          {group(other, t('connections.addDialog.other'))}
        </CommandList>
      </Command>
    </>
  );
}

/**
 * «Додати підключення»: one dialog for picking and connecting. Step one lists the connectors; a
 * connector opens its methods in the same dialog (a form, a redirect, a provider session, or — the
 * one exception — its editor's page). «Перепідключити» opens here at the connection's method.
 */
export function AddConnectionDialog({
  open,
  sources,
  onPick,
  onClose,
  initialStep,
}: {
  open: boolean;
  sources: { connections?: ConnectionsListResponse; connectors?: ConnectorView[] };
  onPick: (target: ConnectionTarget) => void;
  onClose: () => void;
  /** Open straight into one connect step: a connector's, or a server connection's reconnect. */
  initialStep?: Step;
}) {
  const [chosen, setStep] = useState<Step>();
  const step = chosen ?? initialStep;
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
        {step?.startsWith('connector:') || step?.startsWith('reconnect:') ? (
          <ServerStep step={step as `connector:${string}` | `reconnect:${string}`} sources={sources} onBack={back} onPick={onPick} />
        ) : (
          <PickStep connectors={sources.connectors ?? []} onConnect={setStep} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A server connector's connect step, or a server connection's reconnect step; gone from the server: back to the list. */
function ServerStep({
  step,
  sources,
  onBack,
  onPick,
}: {
  step: `connector:${string}` | `reconnect:${string}`;
  sources: { connections?: ConnectionsListResponse; connectors?: ConnectorView[] };
  onBack: () => void;
  onPick: (target: ConnectionTarget) => void;
}) {
  const { t } = useTranslation('settings');
  if (step.startsWith('reconnect:')) {
    const id = step.slice('reconnect:'.length);
    const view = sources.connections?.connections.find(candidate => candidate.id === id);
    const action = view?.actions.reconnect;
    if (!view || !action || !('method' in action)) return null;
    const connector = sources.connectors?.find(candidate => candidate.id === view.connector.id);
    return (
      <ConnectorConnect
        key={step}
        connector={{ ...view.connector, ...(connector?.description ? { description: connector.description } : {}) }}
        methods={[action.method]}
        reconnect={id}
        title={t('connections.connector.reconnectTitle', { name: view.label })}
        onBack={onBack}
        onPick={onPick}
      />
    );
  }
  const connector = sources.connectors?.find(candidate => `connector:${candidate.id}` === step);
  if (!connector) return null;
  return <ConnectorConnect key={step} connector={connector} methods={connector.methods} onBack={onBack} onPick={onPick} />;
}
