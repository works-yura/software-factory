import { Badge } from '@mastra/playground-ui/components/Badge';
import { DropdownMenu } from '@mastra/playground-ui/components/DropdownMenu';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { EllipsisVertical } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useFactoriesQuery } from '../../../../../hooks/useFactories';
import { useFirebaseMutations } from '../../../../../hooks/useFirebase';
import { useMcpServerMutations } from '../../../../../hooks/useMcpServers';
import type { ConnectionCapability, ConnectionRow, ConnectionSources, ConnectionState } from '../../connections/connections';
import { serverToInput } from '../../services/mcpServers';
import { RemoveAccountDialog } from '../GoogleCloudService';
import { mcpErrorText } from '../mcp-servers/McpServerInspect';
import { ConfirmDialog, RenameDialog } from './ConnectionDialogs';
import { ConnectionIcon } from './ConnectionIcon';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Desktop columns: integration · account · capabilities · status · actions. Below `md` a row stacks. */
const COLUMNS = 'md:grid md:grid-cols-[minmax(0,1.5fr)_minmax(0,1.3fr)_minmax(0,1.2fr)_minmax(0,1fr)_2.75rem] md:items-center md:gap-4';

const STATE_DOT: Record<ConnectionState, string> = {
  ok: 'bg-green-500',
  connected: 'bg-green-500',
  env: 'bg-green-500',
  configured: 'bg-green-500',
  error: 'bg-red-500',
  needs_auth: 'bg-amber-500',
  'reads-nothing': 'bg-amber-500',
  unchecked: 'bg-neutral-500',
  disabled: 'bg-neutral-500',
};

export function useCapabilityLabel() {
  const { t } = useTranslation('settings');
  return (capability: ConnectionCapability) =>
    'count' in capability
      ? t(`connections.capabilities.${capability.key}`, { count: capability.count })
      : t(`connections.capabilities.${capability.key}`);
}

/** The row's title: a project or a server name, with the integration under it. */
export function connectionTitle(row: ConnectionRow, kindLabel: string): { title: string; subtitle?: string } {
  return row.kind === 'google-cloud' || row.kind === 'mcp' ? { title: row.title, subtitle: kindLabel } : { title: row.title };
}

function StateCell({ row }: { row: ConnectionRow }) {
  const { t } = useTranslation('settings');
  const health = row.server?.health;
  const failure = (row.state === 'error' || row.state === 'needs_auth') && health ? mcpErrorText(t, health.errorKind, health.error) : undefined;
  return (
    <span className="flex min-w-0 flex-col gap-0.5" data-state={row.state}>
      <span className="flex items-center gap-2">
        <span aria-hidden className={`inline-block size-2 shrink-0 rounded-full ${STATE_DOT[row.state]}`} />
        <Txt as="span" variant="caption" tone="ink">
          {t(`connections.states.${row.state}`)}
        </Txt>
      </span>
      {failure && (
        <Txt as="span" variant="meta" tone="muted" className="line-clamp-2 break-words" title={failure}>
          {failure}
        </Txt>
      )}
    </span>
  );
}

type Pending = { kind: 'rename' | 'unlink' | 'delete' | 'delete-account'; row: ConnectionRow };

/** The row's «⋮» menu: open, reconnect, rename, unlink from this Factory, delete — what the row's kind allows. */
function RowActions({
  row,
  canEditMcp,
  onOpen,
  onPending,
}: {
  row: ConnectionRow;
  canEditMcp: boolean;
  onOpen: () => void;
  onPending: (pending: Pending) => void;
}) {
  const { t } = useTranslation('settings');
  const { reconnect } = useMcpServerMutations();
  const server = row.server;
  // A server people made (not one an integration manages): theirs to rename, unlink and delete.
  const ownServer = Boolean(server && !row.managed && canEditMcp);
  const ownMcp = row.kind === 'mcp' && ownServer;
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        type="button"
        variant="ghost"
        size="sm"
        aria-label={t('connections.actions.menu', { name: row.title })}
        className="size-11 justify-center p-0 md:size-9"
      >
        <EllipsisVertical aria-hidden className="size-4" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" className="w-60">
        <DropdownMenu.Item onSelect={onOpen}>{t('connections.actions.open')}</DropdownMenu.Item>
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
        {ownMcp && <DropdownMenu.Item onSelect={() => onPending({ kind: 'rename', row })}>{t('connections.actions.rename')}</DropdownMenu.Item>}
        {row.kind === 'google-cloud' && row.accountId && (
          <DropdownMenu.Item onSelect={() => onPending({ kind: 'rename', row })}>{t('connections.actions.renameAccount')}</DropdownMenu.Item>
        )}
        {(ownServer || row.binding) && (
          <>
            <DropdownMenu.Separator />
            <DropdownMenu.Item onSelect={() => onPending({ kind: 'unlink', row })}>{t('connections.actions.unlink')}</DropdownMenu.Item>
          </>
        )}
        {ownServer && <DropdownMenu.Item onSelect={() => onPending({ kind: 'delete', row })}>{t('connections.actions.delete')}</DropdownMenu.Item>}
        {row.kind === 'google-cloud' && row.accountId && (
          <DropdownMenu.Item onSelect={() => onPending({ kind: 'delete-account', row })}>{t('connections.actions.deleteAccount')}</DropdownMenu.Item>
        )}
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

/** The dialog a menu action asked for, and the mutation it runs. */
function PendingDialog({
  pending,
  factoryId,
  sources,
  onClose,
}: {
  pending: Pending;
  factoryId: string;
  sources: ConnectionSources;
  onClose: () => void;
}) {
  const { t } = useTranslation('settings');
  const mcp = useMcpServerMutations();
  const firebase = useFirebaseMutations();
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
    const account = row.accountId ? sources.firebase?.accounts.find(candidate => candidate.id === row.accountId) : undefined;
    const name = account ? account.name : row.title;
    return (
      <RenameDialog
        name={name}
        pending={mcp.save.isPending || firebase.updateAccount.isPending}
        onClose={onClose}
        onSave={label =>
          account
            ? firebase.updateAccount.mutate({ accountId: account.id, name: label }, done(t('connections.rename.saved')))
            : row.server && mcp.save.mutate({ ...serverToInput(row.server), label, id: row.server.id }, done(t('connections.rename.saved')))
        }
      />
    );
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
        body={row.kind === 'google-cloud' ? t('connections.unlink.bindingBody') : t('connections.unlink.mcpBody')}
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

/**
 * The Factory's connections as one list. Wide: a table of integration, account, capabilities,
 * status and a «⋮» menu. Narrow (phones): each row stacks — name with the menu at its right, then
 * the account, the capabilities and the status — so nothing scrolls sideways.
 */
export function ConnectionList({
  rows,
  factoryId,
  sources,
  canEditMcp,
  onOpen,
}: {
  rows: ConnectionRow[];
  factoryId: string;
  sources: ConnectionSources;
  canEditMcp: boolean;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation('settings');
  const capabilityLabel = useCapabilityLabel();
  const [pending, setPending] = useState<Pending>();

  return (
    <div className="border-border1 rounded-lg border">
      <div aria-hidden className={`text-muted-foreground border-border1 hidden border-b px-4 py-2 text-xs ${COLUMNS}`}>
        <span>{t('connections.columns.integration')}</span>
        <span>{t('connections.columns.account')}</span>
        <span>{t('connections.columns.capabilities')}</span>
        <span>{t('connections.columns.state')}</span>
        <span className="sr-only">{t('connections.columns.actions')}</span>
      </div>
      <ul aria-label={t('connections.listLabel')} className="divide-border1 divide-y">
        {rows.map(row => {
          const { title, subtitle } = connectionTitle(row, t(`connections.kinds.${row.kind}`));
          return (
            <li key={row.id} data-testid="connection-row" className={`relative flex flex-col gap-2 px-3 py-3 md:min-h-16 md:px-4 md:py-2 ${COLUMNS}`}>
              <button
                type="button"
                onClick={() => onOpen(row.id)}
                className="flex min-h-11 min-w-0 items-center gap-3 pr-12 text-left md:pr-0"
              >
                <ConnectionIcon kind={row.kind} />
                <span className="flex min-w-0 flex-col">
                  <span className="flex min-w-0 items-center gap-2">
                    <Txt as="span" variant="body" tone="ink" className="truncate">
                      {title}
                    </Txt>
                    {row.mcp && (
                      <Badge size="xs" variant="neutral" emphasis="subtle">
                        {t('connections.mcpBadge')}
                      </Badge>
                    )}
                  </span>
                  {subtitle && (
                    <Txt as="span" variant="meta" tone="muted" className="truncate">
                      {subtitle}
                    </Txt>
                  )}
                </span>
              </button>
              <span className="flex min-w-0 flex-col pl-12 md:pl-0">
                {row.account ? (
                  <>
                    <Txt as="span" variant="caption" tone="ink" className="truncate">
                      {row.account.name}
                    </Txt>
                    {row.account.detail && (
                      <Txt as="span" variant="meta" tone="muted" className="truncate" title={row.account.detail}>
                        {row.account.detail}
                      </Txt>
                    )}
                  </>
                ) : (
                  <Txt as="span" variant="caption" tone="muted">
                    {row.scope === 'organization' ? t('connections.organizationWide') : '—'}
                  </Txt>
                )}
                {row.account && row.scope === 'organization' && (
                  <Txt as="span" variant="meta" tone="muted">
                    {t('connections.organizationWide')}
                  </Txt>
                )}
              </span>
              <span className="flex min-w-0 flex-wrap gap-1 pl-12 md:pl-0">
                {row.capabilities.map(capability => (
                  <Badge key={capability.key} size="sm" variant="neutral" emphasis="subtle">
                    {capabilityLabel(capability)}
                  </Badge>
                ))}
              </span>
              <span className="pl-12 md:pl-0">
                <StateCell row={row} />
              </span>
              <span className="absolute top-2 right-1 md:static md:flex md:justify-end">
                <RowActions row={row} canEditMcp={canEditMcp} onOpen={() => onOpen(row.id)} onPending={setPending} />
              </span>
            </li>
          );
        })}
      </ul>
      {pending && <PendingDialog pending={pending} factoryId={factoryId} sources={sources} onClose={() => setPending(undefined)} />}
    </div>
  );
}
