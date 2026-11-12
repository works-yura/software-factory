import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@mastra/playground-ui/components/Dialog';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { Switch } from '@mastra/playground-ui/components/Switch';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useClickUpConnectionMutations, useClickUpStatusQuery } from '../../../../hooks/useClickUp';
import { useIntakeConfigQuery, useSaveIntakeConfigMutation } from '../../../../hooks/useIntakeConfig';
import type { ClickUpStatus } from '../../factory/services/clickup';
import { SkeletonRows } from '../../../ui/SkeletonRows';

const errorMessage = (error: unknown): string | undefined => (error instanceof Error ? error.message : undefined);

/**
 * Settings › Підключення › ClickUp: the organization's token (connect, replace, disconnect — admins
 * only, ADR-0032) and the import switch, nothing else. Which Lists a Factory reads is said by its
 * intake routes (a route's ClickUp «List» condition subscribes it); where a task lands and what a
 * status change does are those routes too.
 */
export function ClickUpService() {
  const { t } = useTranslation('settings');
  const statusQuery = useClickUpStatusQuery();
  const configQuery = useIntakeConfigQuery();
  const saveMutation = useSaveIntakeConfigMutation();
  const status = statusQuery.data;
  const config = configQuery.data;
  const connected = status?.connected === true;
  const unread = !status || (!status.configured && status.reason !== undefined);

  const description =
    statusQuery.isPending || !status
      ? t('intake.clickup.checking')
      : unread
        ? status.reason === 'not_configured'
          ? t('intake.clickup.notConfigured')
          : status.reason === 'auth_required'
            ? t('intake.clickup.authRequired')
            : status.reason === 'organization_required'
              ? t('intake.clickup.organizationRequired')
              : t('intake.clickup.statusUnavailable')
        : !status.configured
          ? status.canManage
            ? t('intake.clickup.notConnected')
            : t('intake.clickup.notConnectedMember')
          : !status.connected
            ? t('intake.clickup.rejected')
            : t('intake.clickup.ready', { seconds: status.intervalSeconds });
  const retry =
    statusQuery.isError || (status && !status.configured && status.reason === 'unavailable') ? (
      <Button size="sm" variant="ghost" onClick={() => void statusQuery.refetch()}>
        {t('intake.retry')}
      </Button>
    ) : null;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Txt as="p" variant="caption" tone="muted">
          {description}
        </Txt>
        {retry}
      </div>
      {status && !unread && <ClickUpToken status={status} />}
      {status?.configured &&
        (configQuery.isPending ? (
          <SkeletonRows label={t('intake.loading')} rows={1} />
        ) : configQuery.isError || !config ? (
          <Txt tone="muted" as="p" variant="caption">
            {t('intake.unavailable')}
          </Txt>
        ) : (
          <SettingsContainer>
            <SettingsRow label={t('intake.clickup.sync')}>
              <Switch
                aria-label={t('intake.clickup.sync')}
                checked={config.clickup.enabled}
                disabled={saveMutation.isPending || !connected}
                onCheckedChange={enabled =>
                  saveMutation.mutate(
                    { ...config, clickup: { ...config.clickup, enabled } },
                    {
                      onSuccess: () => toast.success(t('intake.saved')),
                      onError: err => toast.error(err instanceof Error ? err.message : t('intake.saveFailed')),
                    },
                  )
                }
              />
            </SettingsRow>
          </SettingsContainer>
        ))}
    </>
  );
}

/** The organization's token: the account it belongs to, and connect / replace / disconnect for an admin. */
function ClickUpToken({ status }: { status: ClickUpStatus }) {
  const { t } = useTranslation('settings');
  const { connect, disconnect } = useClickUpConnectionMutations();
  const [editing, setEditing] = useState(!status.configured);
  const [draft, setDraft] = useState('');
  const [confirming, setConfirming] = useState(false);
  const canManage = status.canManage === true;
  const busy = connect.isPending || disconnect.isPending;
  const showForm = canManage && (editing || !status.configured);

  const save = () => {
    const token = draft.trim();
    if (!token) return;
    connect.mutate(token, {
      onSuccess: () => {
        toast.success(t('intake.clickup.token.connected'));
        setDraft('');
        setEditing(false);
      },
    });
  };

  return (
    <SettingsContainer>
      {status.configured && (
        <div className="flex flex-col gap-2 px-4 py-3 lg:flex-row lg:items-center lg:justify-between lg:gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <Txt tone="ink" variant="body">
                {status.account?.username ? t('intake.clickup.account', { username: status.account.username }) : 'ClickUp'}
              </Txt>
              <Badge size="sm" variant={status.connected ? 'success' : 'destructive'}>
                {status.connected ? t('connections.states.connected') : t('connections.states.error')}
              </Badge>
            </div>
            {status.workspaces.length > 0 && (
              <Txt tone="muted" variant="caption">
                {status.workspaces.join(', ')}
              </Txt>
            )}
            {!status.connected && status.error && (
              <Txt tone="muted" variant="caption">
                {status.error}
              </Txt>
            )}
          </div>
          {canManage && !editing && (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button size="sm" disabled={busy} onClick={() => setEditing(true)}>
                {t('intake.clickup.token.replace')}
              </Button>
              <Button size="sm" disabled={busy} onClick={() => setConfirming(true)}>
                {t('intake.clickup.token.disconnect')}
              </Button>
            </div>
          )}
        </div>
      )}
      {showForm && (
        <form
          className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center"
          onSubmit={event => {
            event.preventDefault();
            save();
          }}
        >
          <Input
            type="password"
            size="sm"
            autoComplete="off"
            aria-label={t('intake.clickup.token.label')}
            placeholder={t('intake.clickup.token.placeholder')}
            value={draft}
            onChange={event => setDraft(event.target.value)}
          />
          <div className="flex shrink-0 items-center gap-2">
            {status.configured && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  setDraft('');
                  connect.reset();
                }}
              >
                {t('intake.clickup.token.cancel')}
              </Button>
            )}
            <Button type="submit" size="sm" variant="primary" disabled={busy || !draft.trim()}>
              {connect.isPending ? t('intake.clickup.token.checking') : t('intake.clickup.token.connect')}
            </Button>
          </div>
        </form>
      )}
      {connect.isError && (
        <div className="px-4 pb-3">
          <Notice variant="destructive" title={t('intake.clickup.token.failed')} role="alert">
            <Notice.Message>{errorMessage(connect.error)}</Notice.Message>
          </Notice>
        </div>
      )}
      {!canManage && (
        <Txt tone="muted" as="p" variant="caption" className="px-4 py-2">
          {t('intake.clickup.token.adminOnly')}
        </Txt>
      )}
      {confirming && (
        <Dialog open onOpenChange={open => !open && setConfirming(false)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('intake.clickup.token.confirmTitle')}</DialogTitle>
              <DialogDescription>{t('intake.clickup.token.confirmBody')}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                {t('intake.clickup.token.cancel')}
              </Button>
              <Button
                size="sm"
                disabled={disconnect.isPending}
                onClick={() =>
                  disconnect.mutate(undefined, {
                    onSuccess: () => {
                      toast.success(t('intake.clickup.token.disconnected'));
                      setConfirming(false);
                      setEditing(true);
                    },
                    onError: error => toast.error(errorMessage(error) ?? t('intake.clickup.token.failed')),
                  })
                }
              >
                {t('intake.clickup.token.confirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </SettingsContainer>
  );
}
