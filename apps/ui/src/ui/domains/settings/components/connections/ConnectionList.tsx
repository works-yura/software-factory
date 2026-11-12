import { Badge } from '@mastra/playground-ui/components/Badge';
import { DropdownMenu } from '@mastra/playground-ui/components/DropdownMenu';
import { Table } from '@mastra/playground-ui/components/Table';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { useIsMobile } from '@mastra/playground-ui/hooks/use-is-mobile';
import { Ellipsis } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useFactoriesQuery } from '../../../../../hooks/useFactories';
import { useFirebaseMutations } from '../../../../../hooks/useFirebase';
import { useMcpServerMutations } from '../../../../../hooks/useMcpServers';
import { connectionHealth } from '../../connections/connections';
import type { ConnectionRow, ConnectionSources } from '../../connections/connections';
import type { FirebaseBinding, FirebaseBindingInput } from '../../services/firebase';
import { serverToInput } from '../../services/mcpServers';
import { RemoveAccountDialog } from '../GoogleCloudService';
import { mcpErrorText } from '../mcp-servers/McpServerInspect';
import { CapabilityDots, useConnectionDots } from './CapabilityDots';
import { ConfirmDialog, RenameDialog } from './ConnectionDialogs';
import { ConnectionIcon } from './ConnectionIcon';
import { TimeAgo } from './TimeAgo';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A binding as its save takes it: its fields without the id and what the server records. */
export function bindingInput(binding: FirebaseBinding): FirebaseBindingInput {
  const { id: _id, createdAt: _createdAt, createdBy: _createdBy, ...input } = binding;
  return input;
}

/** Renames what a row's «Перейменувати» names: a binding's own name, or a server's label. */
export function useRenameConnection() {
  const { t } = useTranslation('settings');
  const mcp = useMcpServerMutations();
  const firebase = useFirebaseMutations();
  const rename = (row: ConnectionRow, name: string, onDone?: () => void) => {
    const options = {
      onSuccess: () => {
        toast.success(t('connections.rename.saved'));
        onDone?.();
      },
      onError: (error: unknown) => toast.error(errorMessage(error)),
    };
    if (row.rename === 'binding' && row.binding) firebase.saveBinding.mutate({ ...bindingInput(row.binding), name, id: row.binding.id }, options);
    else if (row.rename === 'server' && row.server) mcp.save.mutate({ ...serverToInput(row.server), label: name, id: row.server.id }, options);
  };
  return { rename, pending: mcp.save.isPending || firebase.saveBinding.isPending };
}

/** A row's state, said only when something needs attention: a dot and a word. */
export function AttentionMark({ row }: { row: ConnectionRow }) {
  const { t } = useTranslation('settings');
  const health = connectionHealth(row.state);
  if (health === 'ok' || health === 'idle') return null;
  const failure = row.server?.health && health === 'error' ? mcpErrorText(t, row.server.health.errorKind, row.server.health.error) : undefined;
  return (
    <span className="text-meta text-muted-foreground flex shrink-0 items-center gap-1.5" title={failure} data-state={row.state}>
      <span aria-hidden className={`inline-block size-1.5 rounded-full ${health === 'error' ? 'bg-red-500' : 'bg-amber-500'}`} />
      {t(`connections.states.${row.state}`)}
    </span>
  );
}

/** The health badge a connection's header carries: «Активне», «Помилка», «Потребує уваги», «Не перевірено». */
export function HealthBadge({ row }: { row: ConnectionRow }) {
  const { t } = useTranslation('settings');
  const health = connectionHealth(row.state);
  const variant = health === 'ok' ? 'success' : health === 'error' ? 'destructive' : health === 'warning' ? 'warning' : 'neutral';
  return (
    <Badge size="sm" variant={variant} emphasis="subtle">
      {t(`connections.health.${health}`)}
    </Badge>
  );
}

export type PendingAction = { kind: 'rename' | 'unlink' | 'delete' | 'delete-account'; row: ConnectionRow };

/**
 * The «⋯» menu: rename, reconnect, unlink from this Factory, and — after a separator — delete,
 * as far as the row's kind allows. ClickUp, GitHub and GitLab are the organization's: only «Відкрити».
 */
export function RowActions({
  row,
  canEditMcp,
  onOpen,
  onPending,
}: {
  row: ConnectionRow;
  canEditMcp: boolean;
  onOpen: () => void;
  onPending: (pending: PendingAction) => void;
}) {
  const { t } = useTranslation('settings');
  const { reconnect } = useMcpServerMutations();
  const server = row.server;
  // A server people made (not one an integration manages): theirs to unlink and delete.
  const ownServer = Boolean(server && !row.managed && canEditMcp);
  const destructive = ownServer || (row.kind === 'google-cloud' && row.accountId);
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t('connections.actions.menu', { name: row.title })}
        className="relative z-10 max-sm:size-11"
        onClick={event => event.stopPropagation()}
      >
        <Ellipsis aria-hidden />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" className="w-60">
        <DropdownMenu.Item onSelect={onOpen}>{t('connections.actions.open')}</DropdownMenu.Item>
        {row.rename && (row.rename === 'binding' || canEditMcp) && (
          <DropdownMenu.Item onSelect={() => onPending({ kind: 'rename', row })}>{t('connections.actions.rename')}</DropdownMenu.Item>
        )}
        {server && canEditMcp && (
          <DropdownMenu.Item
            disabled={reconnect.isPending}
            onSelect={() =>
              reconnect.mutate(server.id, {
                onSuccess: status =>
                  status.connected
                    ? toast.success(t('connections.reconnected', { count: status.toolCount }))
                    : toast.error(t('connections.reconnectFailed', { error: mcpErrorText(t, status.errorKind, status.error) })),
                onError: error => toast.error(t('connections.reconnectFailed', { error: errorMessage(error) })),
              })
            }
          >
            {t('connections.actions.reconnect')}
          </DropdownMenu.Item>
        )}
        {(ownServer || row.binding) && (
          <DropdownMenu.Item onSelect={() => onPending({ kind: 'unlink', row })}>{t('connections.actions.unlink')}</DropdownMenu.Item>
        )}
        {destructive && <DropdownMenu.Separator />}
        {ownServer && (
          <DropdownMenu.Item variant="destructive" onSelect={() => onPending({ kind: 'delete', row })}>
            {t('connections.actions.deleteConnection')}
          </DropdownMenu.Item>
        )}
        {row.kind === 'google-cloud' && row.accountId && (
          <DropdownMenu.Item variant="destructive" onSelect={() => onPending({ kind: 'delete-account', row })}>
            {t('connections.actions.deleteAccount')}
          </DropdownMenu.Item>
        )}
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

/** The dialog a menu action asked for, and the mutation it runs. */
export function PendingDialog({
  pending,
  factoryId,
  sources,
  onClose,
}: {
  pending: PendingAction;
  factoryId: string;
  sources: ConnectionSources;
  onClose: () => void;
}) {
  const { t } = useTranslation('settings');
  const mcp = useMcpServerMutations();
  const firebase = useFirebaseMutations();
  const { rename, pending: renaming } = useRenameConnection();
  const factories = useFactoriesQuery().data ?? [];
  const { row } = pending;
  const done = (message: string) => ({
    onSuccess: () => {
      toast.success(message);
      onClose();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  if (pending.kind === 'rename') {
    return <RenameDialog name={row.title} pending={renaming} onClose={onClose} onSave={name => rename(row, name, onClose)} />;
  }
  if (pending.kind === 'delete-account') {
    const account = sources.firebase?.accounts.find(candidate => candidate.id === row.accountId);
    if (!account) return null;
    return (
      <RemoveAccountDialog
        account={account}
        bindings={(sources.firebase?.bindings ?? []).filter(binding => account.bindingIds.includes(binding.id))}
        factoryName={id => factories.find(factory => factory.id === id)?.name ?? id}
        onClose={onClose}
      />
    );
  }
  if (pending.kind === 'unlink') {
    return (
      <ConfirmDialog
        title={t('connections.unlink.title', { name: row.title })}
        body={row.binding ? t('connections.unlink.bindingBody') : t('connections.unlink.mcpBody')}
        confirm={t('connections.unlink.confirm')}
        cancel={t('connections.unlink.cancel')}
        pending={mcp.save.isPending || firebase.removeBinding.isPending}
        onClose={onClose}
        onConfirm={() =>
          row.binding
            ? firebase.removeBinding.mutate(row.binding.id, done(t('connections.unlink.done')))
            : row.server &&
              mcp.save.mutate(
                {
                  ...serverToInput(row.server),
                  assignments: row.server.assignments.filter(assignment => assignment.factoryProjectId !== factoryId),
                  id: row.server.id,
                },
                done(t('connections.unlink.done')),
              )
        }
      />
    );
  }
  return (
    <ConfirmDialog
      title={t('connections.delete.title', { name: row.title })}
      body={t('connections.delete.body')}
      confirm={t('connections.delete.confirm')}
      cancel={t('connections.delete.cancel')}
      pending={mcp.remove.isPending}
      onClose={onClose}
      onConfirm={() => row.server && mcp.remove.mutate(row.server.id, done(t('connections.delete.done')))}
    />
  );
}

/** Integration: the logo in its 32px slot and the integration's name. */
function IntegrationCell({ row }: { row: ConnectionRow }) {
  const { t } = useTranslation('settings');
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <ConnectionIcon kind={row.kind} />
      <span className="text-foreground truncate">{t(`connections.kinds.${row.kind}`)}</span>
    </span>
  );
}

/**
 * The Factory's connections as Mastra's Connect page lists them: the kit's inset table —
 * Інтеграція · Підключення · Акаунт · Можливості · Створено · ⋯ — each row a link to its page;
 * the state shows only when something needs attention. On phones each row stacks: logo and name,
 * the account under it, the capability icons and the menu.
 */
export function ConnectionList({
  rows,
  factoryId,
  sources,
  canEditMcp,
  hrefOf,
  onOpen,
}: {
  rows: ConnectionRow[];
  factoryId: string;
  sources: ConnectionSources;
  canEditMcp: boolean;
  hrefOf: (id: string) => string;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation('settings');
  const dots = useConnectionDots();
  const isMobile = useIsMobile(640);
  const [pending, setPending] = useState<PendingAction>();
  const accountOf = (row: ConnectionRow) => row.account?.name ?? (row.scope === 'organization' ? t('connections.organizationWide') : '—');

  return (
    <>
      {isMobile ? (
        <ul aria-label={t('connections.listLabel')} className="bg-surface-panel shadow-raised flex flex-col gap-px rounded-xl p-1">
          {rows.map(row => (
            <li key={row.id} data-testid="connection-row" className="hover:bg-fill-subtle relative flex items-start gap-2.5 rounded-lg px-2 py-2">
              <ConnectionIcon kind={row.kind} />
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <Link to={hrefOf(row.id)} className="text-body-sm text-foreground flex min-h-8 items-center gap-2 after:absolute after:inset-0">
                  <span className="truncate">{row.title}</span>
                  {row.mcp && (
                    <Badge size="sm" variant="neutral" className="shrink-0">
                      {t('connections.mcpBadge')}
                    </Badge>
                  )}
                </Link>
                <span className="text-meta text-muted-foreground truncate">
                  {t(`connections.kinds.${row.kind}`)} · {accountOf(row)}
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <CapabilityDots dots={dots(row.capabilities)} />
                  <AttentionMark row={row} />
                </span>
              </span>
              <RowActions row={row} canEditMcp={canEditMcp} onOpen={() => onOpen(row.id)} onPending={setPending} />
            </li>
          ))}
        </ul>
      ) : (
        <Table variant="inset" aria-label={t('connections.listLabel')}>
          <Table.Header>
            <Table.Row>
              <Table.Head>{t('connections.columns.integration')}</Table.Head>
              <Table.Head>{t('connections.columns.connection')}</Table.Head>
              <Table.Head>{t('connections.columns.account')}</Table.Head>
              <Table.Head>{t('connections.columns.capabilities')}</Table.Head>
              <Table.Head className="w-full">{t('connections.columns.created')}</Table.Head>
              <Table.Head align="end">
                <span className="sr-only">{t('connections.columns.actions')}</span>
              </Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {rows.map(row => (
              <Table.Row key={row.id} data-testid="connection-row">
                <Table.Cell>
                  <IntegrationCell row={row} />
                </Table.Cell>
                <Table.Cell>
                  <span className="flex items-center gap-2">
                    <Table.RowLink render={<Link to={hrefOf(row.id)} />} className="truncate">
                      {row.title}
                    </Table.RowLink>
                    {row.mcp && (
                      <Badge size="sm" variant="neutral" className="shrink-0">
                        {t('connections.mcpBadge')}
                      </Badge>
                    )}
                    <AttentionMark row={row} />
                  </span>
                </Table.Cell>
                <Table.Cell>
                  <span title={row.account?.detail}>{accountOf(row)}</span>
                </Table.Cell>
                <Table.Cell>
                  <CapabilityDots dots={dots(row.capabilities)} />
                </Table.Cell>
                <Table.Cell>{row.createdAt ? <TimeAgo value={row.createdAt} /> : <span className="text-muted-foreground">—</span>}</Table.Cell>
                <Table.Cell align="end">
                  <RowActions row={row} canEditMcp={canEditMcp} onOpen={() => onOpen(row.id)} onPending={setPending} />
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}
      {pending && <PendingDialog pending={pending} factoryId={factoryId} sources={sources} onClose={() => setPending(undefined)} />}
    </>
  );
}
