import { Button } from '@mastra/playground-ui/components/Button';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { Switch } from '@mastra/playground-ui/components/Switch';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useClickUpListsQuery, useClickUpStatusQuery } from '../../../../hooks/useClickUp';
import type { IntakeConfig } from '../../factory/services/intake';
import { ClickUpListCard } from './ClickUpListCard';
import { ClickUpListPicker } from './ClickUpListPicker';
import { SettingsSubsection } from './SettingsSubsection';

function toggleId(ids: string[] | null, id: string): string[] | null {
  const current = ids ?? [];
  const next = current.includes(id) ? current.filter(value => value !== id) : [...current, id];
  return next.length ? next : null;
}

/**
 * Everything about ClickUp intake in one place: the import switch, the connected Lists (each a card that
 * holds its routing, status rules and tag routes) and a dialog to connect more.
 */
export function ClickUpIntakeSection({
  config,
  busy,
  update,
  factories,
}: {
  config: IntakeConfig;
  busy: boolean;
  update: (next: IntakeConfig) => void;
  factories: { id: string; name: string }[];
}) {
  const { t } = useTranslation('settings');
  const [picking, setPicking] = useState(false);
  const statusQuery = useClickUpStatusQuery();
  const status = statusQuery.data;
  const connected = status?.connected === true;
  const listsQuery = useClickUpListsQuery(connected);
  const lists = listsQuery.data ?? [];
  const sourceIds = config.clickup.sourceIds ?? [];
  const showLists = connected && config.clickup.enabled;

  const description =
    statusQuery.isPending || !status
      ? t('intake.clickup.checking')
      : !status.configured
        ? status.reason === 'not_configured'
          ? t('intake.clickup.notConfigured')
          : status.reason === 'auth_required'
            ? t('intake.clickup.authRequired')
            : status.reason === 'organization_required'
              ? t('intake.clickup.organizationRequired')
              : t('intake.clickup.statusUnavailable')
        : !status.connected
          ? t('intake.clickup.rejected')
          : t('intake.clickup.ready', { seconds: status.intervalSeconds });
  const action =
    connected && status.workspaces.length > 0 ? (
      <Txt tone="muted" as="span" variant="caption">
        {t('intake.connectedTo', { name: status.workspaces.join(', ') })}
      </Txt>
    ) : statusQuery.isError || (status && !status.configured && status.reason === 'unavailable') ? (
      <Button size="sm" variant="ghost" onClick={() => void statusQuery.refetch()}>
        {t('intake.retry')}
      </Button>
    ) : undefined;

  const toggleList = (listId: string) =>
    update({ ...config, clickup: { ...config.clickup, sourceIds: toggleId(config.clickup.sourceIds, listId) } });
  const nameOf = (listId: string) => {
    const list = lists.find(candidate => candidate.id === listId);
    return list ? `${list.path} / ${list.name}` : listId;
  };

  return (
    <SettingsSubsection scope="org" title={t('intake.clickup.title')} description={description} action={action}>
      <SettingsContainer>
        {status?.connected === false && status.error && (
          <Txt tone="muted" as="p" variant="caption" className="px-4 py-2">
            {status.error}
          </Txt>
        )}
        <SettingsRow label={t('intake.clickup.sync')}>
          <Switch
            aria-label={t('intake.clickup.sync')}
            checked={config.clickup.enabled}
            disabled={busy || !connected}
            onCheckedChange={enabled => update({ ...config, clickup: { ...config.clickup, enabled } })}
          />
        </SettingsRow>
      </SettingsContainer>

      {showLists &&
        (listsQuery.isError ? (
          <Txt tone="muted" as="p" variant="caption">
            {t('intake.clickup.listsFailed')}
          </Txt>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <Txt as="h3" variant="body" tone="ink">
                {t('intake.clickup.connectedLists')}
              </Txt>
              <Button size="sm" disabled={busy || listsQuery.isPending} onClick={() => setPicking(true)}>
                {t('intake.clickup.addLists')}
              </Button>
            </div>
            {sourceIds.length === 0 ? (
              <Txt tone="muted" as="p" variant="caption">
                {t('intake.clickup.noLists')}
              </Txt>
            ) : (
              sourceIds.map(listId => (
                <ClickUpListCard
                  key={listId}
                  listId={listId}
                  name={nameOf(listId)}
                  factories={factories}
                  busy={busy}
                  onDisconnect={() => toggleList(listId)}
                />
              ))
            )}
          </div>
        ))}

      {picking && (
        <ClickUpListPicker
          lists={lists}
          selectedIds={sourceIds}
          busy={busy}
          onToggle={toggleList}
          onClose={() => setPicking(false)}
        />
      )}
    </SettingsSubsection>
  );
}
