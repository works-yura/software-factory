import type { ConnectionView } from '@factory/contracts';
import { Badge } from '@mastra/playground-ui/components/Badge';
import { DropdownMenu } from '@mastra/playground-ui/components/DropdownMenu';
import { Table } from '@mastra/playground-ui/components/Table';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { useIsMobile } from '@mastra/playground-ui/hooks/use-is-mobile';
import { ArrowUpRight, Ellipsis, ExternalLink, Pencil, RefreshCw, Trash2, Unlink } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useApiConfig } from '../../../../../api/config';
import { useReconnect, useUnlinkConnection, useUpdateConnection } from '../../../../../hooks/useConnections';
import { finishAuthorize } from '../../connections/api';
import type { Step } from './AddConnectionDialog';
import { CapabilityDots, serverDots } from './CapabilityDots';
import { ConfirmDialog, RenameDialog } from './ConnectionDialogs';
import { ConnectionIcon } from './ConnectionIcon';
import { RemoveConnectionDialog } from './RemoveConnectionDialog';
import { TimeAgo } from './TimeAgo';

/** A connect step «Перепідключити» opens: a connection's reconnect method (`reconnect:<id>`). */
export type ReconnectStep = Step;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Renames a connection (its `label`), with the server's answer said back. */
export function useRenameConnection() {
  const { t } = useTranslation('settings');
  const update = useUpdateConnection();
  const rename = (view: ConnectionView, name: string, onDone?: () => void) =>
    update.mutate(
      { id: view.id, label: name },
      {
        onSuccess: () => {
          toast.success(t('connections.rename.saved'));
          onDone?.();
        },
        onError: error => toast.error(errorMessage(error)),
      },
    );
  return { rename, pending: update.isPending };
}

/** A connection's state, said only when something needs attention: a dot and the server's word. */
export function AttentionMark({ view }: { view: ConnectionView }) {
  const { tone, label, message } = view.state;
  if (tone === 'ok' || tone === 'idle') return null;
  return (
    <span className="text-meta text-muted-foreground flex shrink-0 items-center gap-1.5" title={message} data-state={tone}>
      <span aria-hidden className={`inline-block size-1.5 rounded-full ${tone === 'error' ? 'bg-red-500' : 'bg-amber-500'}`} />
      {label}
    </span>
  );
}

/** The health badge a connection's header carries: «Активне», «Помилка», «Потребує уваги», «Не перевірено». */
export function HealthBadge({ view }: { view: ConnectionView }) {
  const { t } = useTranslation('settings');
  const { tone } = view.state;
  const variant = tone === 'ok' ? 'success' : tone === 'error' ? 'destructive' : tone === 'warning' ? 'warning' : 'neutral';
  return (
    <Badge size="sm" variant={variant} emphasis="subtle">
      {t(`connections.health.${tone}`)}
    </Badge>
  );
}

type PendingAction = { kind: 'rename' | 'unlink' | 'remove'; view: ConnectionView };

/**
 * A menu item a connection cannot take here: the item stays disabled (dimmed by the kit), and the
 * server's reason is a separate line under it at normal muted contrast, read out as the item's
 * description — so it is legible, not dimmed with the item.
 */
function BlockedItem({ icon: Icon, label, reason, variant }: { icon: LucideIcon; label: string; reason: string; variant?: 'destructive' }) {
  const reasonId = useId();
  return (
    <>
      <DropdownMenu.Item disabled {...(variant ? { variant } : {})} data-blocked aria-describedby={reasonId}>
        <Icon aria-hidden />
        {label}
      </DropdownMenu.Item>
      <div id={reasonId} role="none" className="text-meta text-muted-foreground -mt-1 pr-2 pb-1.5 pl-8 whitespace-normal">
        {reason}
      </div>
    </>
  );
}

/**
 * The «⋯» menu: each action the server lists for the connection, enabled or — with the server's
 * reason under it — disabled. «Перепідключити» with fields opens its form in «Додати підключення»;
 * without, it runs at once (a check, a redirect, a provider session) and says how it went.
 */
function RowActions({
  view,
  onOpen,
  onPending,
  onReconnect,
}: {
  view: ConnectionView;
  onOpen: () => void;
  onPending: (pending: PendingAction) => void;
  onReconnect: (step: ReconnectStep) => void;
}) {
  const { t } = useTranslation('settings');
  const { baseUrl } = useApiConfig();
  const reconnect = useReconnect();
  const { actions } = view;
  const startReconnect = () => {
    const action = actions.reconnect;
    if (!action || !('method' in action)) return;
    if ((action.method.fields ?? []).length > 0) {
      onReconnect(`reconnect:${view.id}`);
      return;
    }
    reconnect.mutate(
      { id: view.id, input: {} },
      {
        onSuccess: result => {
          if (result.type === 'connected') {
            toast.success(result.title);
            return;
          }
          finishAuthorize(baseUrl, view.connector.id, result).then(
            outcome => {
              if (outcome === 'redirected') return;
              toast.success(t(`connections.connector.authorized.${outcome}`, { name: view.connector.name }));
            },
            (error: unknown) => toast.error(errorMessage(error)),
          );
        },
        onError: error => toast.error(errorMessage(error)),
      },
    );
  };
  const item = (action: true | { reason: string } | undefined, icon: LucideIcon, label: string, onSelect: () => void, variant?: 'destructive') => {
    if (!action) return null;
    if (action !== true) return <BlockedItem icon={icon} label={label} reason={action.reason} {...(variant ? { variant } : {})} />;
    const Icon = icon;
    return (
      <DropdownMenu.Item onSelect={onSelect} {...(variant ? { variant } : {})}>
        <Icon aria-hidden />
        {label}
      </DropdownMenu.Item>
    );
  };
  const reconnectAction = actions.reconnect ? ('method' in actions.reconnect ? true : actions.reconnect) : undefined;
  const manage = actions.manageExternally;
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t('connections.actions.menu', { name: view.label })}
        className="relative z-10 max-sm:size-11"
        onClick={event => event.stopPropagation()}
      >
        <Ellipsis aria-hidden />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" className="w-72">
        <DropdownMenu.Item onSelect={onOpen}>
          <ArrowUpRight aria-hidden />
          {t('connections.actions.open')}
        </DropdownMenu.Item>
        {item(actions.rename, Pencil, t('connections.actions.rename'), () => onPending({ kind: 'rename', view }))}
        {item(reconnectAction, RefreshCw, t('connections.actions.reconnect'), startReconnect)}
        {manage &&
          ('url' in manage ? (
            <DropdownMenu.Item onSelect={() => window.open(manage.url, '_blank', 'noopener')}>
              <ExternalLink aria-hidden />
              {manage.label}
            </DropdownMenu.Item>
          ) : (
            <BlockedItem icon={ExternalLink} label={t('connections.connector.manage')} reason={manage.reason} />
          ))}
        {item(actions.unlink, Unlink, t('connections.actions.unlink'), () => onPending({ kind: 'unlink', view }))}
        {(actions.remove || actions.unlink) && <DropdownMenu.Separator />}
        {item(actions.remove, Trash2, t('connections.actions.deleteConnection'), () => onPending({ kind: 'remove', view }), 'destructive')}
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

/** The dialog a menu action asked for: rename, unlink (a yes/no with the server's answer), remove (the impact). */
function PendingDialog({ pending, onClose }: { pending: PendingAction; onClose: () => void }) {
  const { t } = useTranslation('settings');
  const { rename, pending: renaming } = useRenameConnection();
  const unlink = useUnlinkConnection();
  const { view } = pending;
  if (pending.kind === 'remove') return <RemoveConnectionDialog id={view.id} onClose={onClose} />;
  if (pending.kind === 'rename') {
    return <RenameDialog name={view.label} pending={renaming} onClose={onClose} onSave={name => rename(view, name, onClose)} />;
  }
  return (
    <ConfirmDialog
      title={t('connections.unlink.title', { name: view.label })}
      body={t('connections.unlink.bindingBody')}
      confirm={t('connections.unlink.confirm')}
      cancel={t('connections.unlink.cancel')}
      pending={unlink.isPending}
      onClose={onClose}
      onConfirm={() =>
        unlink.mutate(view.id, {
          onSuccess: result => {
            toast.success(result.message);
            onClose();
          },
          onError: error => toast.error(errorMessage(error)),
        })
      }
    />
  );
}

/** Integration: the logo in its 32px slot and the connector's name. */
function IntegrationCell({ view }: { view: ConnectionView }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <ConnectionIcon kind={view.connector.icon} />
      <span className="text-foreground truncate">{view.connector.name}</span>
    </span>
  );
}

function McpBadge({ view }: { view: ConnectionView }) {
  const { t } = useTranslation('settings');
  if (!view.mcp) return null;
  return (
    <Badge size="sm" variant="neutral" className="shrink-0">
      {t('connections.mcpBadge')}
    </Badge>
  );
}

/**
 * The Factory's connections as Mastra's Connect page lists them: the kit's inset table —
 * Інтеграція · Підключення · Акаунт · Можливості · Створено · ⋯ — each row a link to its page;
 * the state shows only when something needs attention. On phones each row stacks: logo and name,
 * the account under it, the capability icons and the menu. Everything shown is the server's.
 */
export function ConnectionList({
  views,
  organizationWide,
  hrefOf,
  onOpen,
  onReconnect,
}: {
  views: readonly ConnectionView[];
  /** What the account column says for an organization-wide connection without an account (the server's word). */
  organizationWide: string;
  hrefOf: (id: string) => string;
  onOpen: (id: string) => void;
  /** «Перепідключити» with a form: the connect step in «Додати підключення». */
  onReconnect: (step: ReconnectStep) => void;
}) {
  const { t } = useTranslation('settings');
  const isMobile = useIsMobile(640);
  const [pending, setPending] = useState<PendingAction>();
  const accountOf = (view: ConnectionView) => view.accountLabel ?? (view.scope === 'organization' ? organizationWide : '—');

  return (
    <>
      {isMobile ? (
        <ul aria-label={t('connections.listLabel')} className="bg-surface-panel shadow-raised flex flex-col gap-px rounded-xl p-1">
          {views.map(view => (
            <li key={view.id} data-testid="connection-row" className="hover:bg-fill-subtle relative flex items-start gap-2.5 rounded-lg px-2 py-2">
              <ConnectionIcon kind={view.connector.icon} />
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <Link to={hrefOf(view.id)} className="text-body-sm text-foreground flex min-h-8 items-center gap-2 after:absolute after:inset-0">
                  <span className="truncate">{view.label}</span>
                  <McpBadge view={view} />
                </Link>
                <span className="text-meta text-muted-foreground truncate">
                  {view.connector.name} · {accountOf(view)}
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <CapabilityDots dots={serverDots(view.provides)} />
                  <AttentionMark view={view} />
                </span>
              </span>
              <RowActions view={view} onOpen={() => onOpen(view.id)} onPending={setPending} onReconnect={onReconnect} />
            </li>
          ))}
        </ul>
      ) : (
        <Table variant="inset" aria-label={t('connections.listLabel')}>
          <Table.Header>
            <Table.Row>
              <Table.Head>{t('connections.columns.integration')}</Table.Head>
              {/* The one column that gives way: the settings pane is narrow at every width. */}
              <Table.Head className="w-full">{t('connections.columns.connection')}</Table.Head>
              <Table.Head>{t('connections.columns.capabilities')}</Table.Head>
              <Table.Head>{t('connections.columns.created')}</Table.Head>
              <Table.Head align="end">
                <span className="sr-only">{t('connections.columns.actions')}</span>
              </Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {views.map(view => (
              <Table.Row key={view.id} data-testid="connection-row">
                <Table.Cell>
                  <IntegrationCell view={view} />
                </Table.Cell>
                <Table.Cell className="max-w-0">
                  <span className="flex min-w-0 items-center gap-2">
                    <Table.RowLink render={<Link to={hrefOf(view.id)} />} className="truncate" title={view.label}>
                      {view.label}
                    </Table.RowLink>
                    <McpBadge view={view} />
                    <AttentionMark view={view} />
                  </span>
                  <span className="text-meta text-muted-foreground block truncate" title={view.accountDetail ?? accountOf(view)}>
                    {t('connections.accountLine', { account: accountOf(view) })}
                  </span>
                </Table.Cell>
                <Table.Cell>
                  <CapabilityDots dots={serverDots(view.provides)} />
                </Table.Cell>
                <Table.Cell>{view.createdAt ? <TimeAgo value={view.createdAt} /> : <span className="text-muted-foreground">—</span>}</Table.Cell>
                <Table.Cell align="end">
                  <RowActions view={view} onOpen={() => onOpen(view.id)} onPending={setPending} onReconnect={onReconnect} />
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}
      {pending && <PendingDialog pending={pending} onClose={() => setPending(undefined)} />}
    </>
  );
}
