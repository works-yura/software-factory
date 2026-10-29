import { Button } from '@mastra/playground-ui/components/Button';
import { Input } from '@mastra/playground-ui/components/Input';
import { SettingsContainer, SettingsFieldsetRow, SettingsRow } from '@mastra/playground-ui/new/settings';
import { Switch } from '@mastra/playground-ui/components/Switch';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useBoardCatalog } from '../../../../hooks/useBoardCatalog';
import { useClickUpListsQuery, useClickUpStatusQuery } from '../../../../hooks/useClickUp';
import {
  useIntakeBindingsQuery,
  useIntakeLabelRoutesQuery,
  useSaveIntakeLabelRouteMutation,
} from '../../../../hooks/useIntakeConfig';
import type { ClickUpList } from '../../factory/services/clickup';
import type { IntakeConfig } from '../../factory/services/intake';
import { ClickUpStatusRules } from './ClickUpStatusRules';
import { BoardSelect } from './GithubLabelRouting';
import { SourcePicker } from './IntakeSourcePicker';
import type { SourcePickerGroup } from './IntakeSourcePicker';
import { IntakeSourceRouting } from './LinearRouting';
import { SettingsSubsection } from './SettingsSubsection';

const INTEGRATION_ID = 'clickup';

function toggleId(ids: string[] | null, id: string): string[] | null {
  const current = ids ?? [];
  const next = current.includes(id) ? current.filter(value => value !== id) : [...current, id];
  return next.length ? next : null;
}

/** Group Lists by `Space / Folder` so same-named Lists stay distinguishable. */
function groupListsByPath(lists: ClickUpList[]): SourcePickerGroup[] {
  const groups = new Map<string, SourcePickerGroup>();
  for (const list of lists) {
    const group = groups.get(list.path) ?? { id: list.path, label: list.path, items: [] };
    group.items.push({ id: list.id, label: list.name });
    groups.set(list.path, group);
  }
  return [...groups.values()].toSorted((left, right) => (left.label ?? '').localeCompare(right.label ?? ''));
}

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
  const statusQuery = useClickUpStatusQuery();
  const status = statusQuery.data;
  const connected = status?.connected === true;
  const listsQuery = useClickUpListsQuery(connected);
  const lists = listsQuery.data ?? [];
  const sourceIds = config.clickup.sourceIds ?? [];
  const showPickers = connected && config.clickup.enabled;

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

  return (
    <>
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
          {showPickers &&
            (listsQuery.isError ? (
              <Txt tone="muted" as="p" variant="caption" className="px-4 py-3">
                {t('intake.clickup.listsFailed')}
              </Txt>
            ) : (
              <SourcePicker
                label={t('intake.clickup.lists')}
                groups={groupListsByPath(lists)}
                selectedIds={config.clickup.sourceIds}
                disabled={busy || listsQuery.isPending}
                pending={busy || listsQuery.isPending}
                onToggleItem={listId =>
                  update({ ...config, clickup: { ...config.clickup, sourceIds: toggleId(config.clickup.sourceIds, listId) } })
                }
              />
            ))}
        </SettingsContainer>
      </SettingsSubsection>

      {showPickers && sourceIds.length > 0 && (
        <SettingsSubsection
          scope="org"
          title={t('intake.clickup.routingTitle')}
          description={t('intake.clickup.routingDescription')}
        >
          <SettingsContainer>
            <IntakeSourceRouting
              integrationId={INTEGRATION_ID}
              label="ClickUp"
              sourceIds={sourceIds}
              sources={lists.map(list => ({ id: list.id, name: `${list.path} / ${list.name}` }))}
              factories={factories}
            />
          </SettingsContainer>
          <ClickUpTagRoutingGroup factories={factories} />
        </SettingsSubsection>
      )}
      {showPickers && (
        <ClickUpStatusRules
          enabled
          lists={sourceIds.map(id => {
            const list = lists.find(candidate => candidate.id === id);
            return { id, name: list ? `${list.path} / ${list.name}` : id };
          })}
        />
      )}
    </>
  );
}

/** Tag routing for every Factory that has a ClickUp List routed to it. */
function ClickUpTagRoutingGroup({ factories }: { factories: { id: string; name: string }[] }) {
  const bindingsQuery = useIntakeBindingsQuery();
  const routedIds = new Set(
    (bindingsQuery.data ?? [])
      .filter(binding => binding.integrationId === INTEGRATION_ID)
      .map(binding => binding.factoryProjectId),
  );
  const routed = factories.filter(factory => routedIds.has(factory.id));
  if (routed.length === 0) return null;
  return (
    <>
      {routed.map(factory => (
        <SettingsContainer key={factory.id}>
          <ClickUpTagRouting factoryProjectId={factory.id} name={factory.name} />
        </SettingsContainer>
      ))}
    </>
  );
}

/** Tag → board routes of one Factory: a task carrying the tag files onto that board, over the List's board. */
function ClickUpTagRouting({ factoryProjectId, name }: { factoryProjectId: string; name: string }) {
  const { t } = useTranslation('settings');
  const routesQuery = useIntakeLabelRoutesQuery(factoryProjectId);
  const catalog = useBoardCatalog(factoryProjectId);
  const save = useSaveIntakeLabelRouteMutation();
  const [draft, setDraft] = useState('');
  const [draftBoard, setDraftBoard] = useState<string | null>(null);

  const routes = (routesQuery.data ?? []).filter(route => route.integrationId === INTEGRATION_ID);
  const boards = (catalog.data ?? []).filter(board => board.id !== 'review');
  const busy = save.isPending;
  const trimmed = draft.trim();
  const duplicate = routes.some(existing => existing.label === trimmed.toLowerCase());

  const route = (label: string, board: string | null, onDone?: () => void) =>
    save.mutate(
      { factoryProjectId, integrationId: INTEGRATION_ID, label, board },
      {
        onSuccess: () => {
          toast.success(t('tagRouting.saved'));
          onDone?.();
        },
        onError: err => toast.error(err instanceof Error ? err.message : t('tagRouting.saveFailed')),
      },
    );

  if (routesQuery.isError) {
    return <SettingsRow label={name} description={t('tagRouting.unavailable')} />;
  }

  return (
    <div className="flex flex-col">
      <SettingsRow label={name} description={t('tagRouting.description')} />
      {routes.map(existing => (
        <SettingsRow key={existing.label} label={existing.label}>
          <div className="flex items-center gap-2">
            <BoardSelect
              ariaLabel={t('tagRouting.boardFor', { label: existing.label })}
              value={boards.find(board => board.id === existing.board)?.id ?? null}
              placeholder={existing.board}
              boards={boards}
              disabled={busy || !catalog.isSuccess}
              onChange={next => route(existing.label, next)}
            />
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('tagRouting.removeRoute', { label: existing.label })}
              disabled={busy}
              onClick={() => route(existing.label, null)}
            >
              {t('tagRouting.remove')}
            </Button>
          </div>
        </SettingsRow>
      ))}
      <SettingsFieldsetRow
        label={t('tagRouting.addRoute')}
        description={duplicate ? t('tagRouting.duplicate') : undefined}
      >
        <div className="flex items-center gap-2">
          <Input
            size="sm"
            aria-label={t('tagRouting.tagFor', { name })}
            placeholder={t('tagRouting.tagPlaceholder')}
            value={draft}
            disabled={busy}
            onChange={event => setDraft(event.target.value)}
          />
          <BoardSelect
            ariaLabel={t('tagRouting.boardForNew', { name })}
            value={draftBoard}
            placeholder={t('tagRouting.chooseBoard')}
            boards={boards}
            disabled={busy || !catalog.isSuccess}
            onChange={setDraftBoard}
          />
          <Button
            size="sm"
            disabled={busy || !trimmed || !draftBoard || duplicate}
            onClick={() =>
              route(trimmed, draftBoard, () => {
                setDraft('');
                setDraftBoard(null);
              })
            }
          >
            {t('tagRouting.add')}
          </Button>
        </div>
      </SettingsFieldsetRow>
    </div>
  );
}
