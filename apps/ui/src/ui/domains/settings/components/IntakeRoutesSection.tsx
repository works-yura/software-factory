import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';

import { Switch } from '@mastra/playground-ui/components/Switch';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { ApiRequestError } from '../../../../api/client';
import type { IntakeRouteFireInfo, IntakeRouteInfo } from '../../../../api/types';
import { useBoardCatalog } from '../../../../hooks/useBoardCatalog';
import { useClickUpListsQuery, useClickUpStatusQuery } from '../../../../hooks/useClickUp';
import { useFactoriesQuery } from '../../../../hooks/useFactories';
import {
  useCreateIntakeRouteMutation,
  useDeleteIntakeRouteMutation,
  useFireIntakeRouteMutation,
  useIntakeRoutesCanEditQuery,
  useIntakeRoutesQuery,
  useIntakeTriggerKindsQuery,
  useReorderIntakeRoutesMutation,
  useUpdateIntakeRouteMutation,
} from '../../../../hooks/useIntakeRoutes';
import type { IntakeRouteDraft } from '../../../../hooks/useIntakeRoutes';

import '../intake-triggers/builtinForms';
import type { IntakeKindFormContext } from '../intake-triggers/formRegistry';

import { SkeletonRows } from '../../../ui/SkeletonRows';
import { factoryAttentionTargetPath } from '../../factory/services/attention';
import { isScheduleRoute } from '../services/intakeRouteConditions';

import { SettingsSubsection } from './SettingsSubsection';

import {
  IntakeOrigins,
  describeTarget,
  describeWhen,
  routeName,
} from './intakeRouteLabels';
import { intakeSourceAvailable } from '@factory/core/boards/intake-sources';
import { INTAKE_SOURCES } from '../services/intakeSources';
import { TriggerStatus } from './IntakeRouteTriggerStatus';
import { RouteEditor } from './IntakeRouteEditor';

const failure = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

/** Why a run was refused, in the reader's language when the server said which refusal it was. */
const RUN_REFUSALS: Record<string, string> = {
  intake_route_disabled: 'intakeTriggers.run.disabled',
  intake_route_not_scheduled: 'intakeTriggers.run.notScheduled',
  organization_admin_required: 'intakeTriggers.run.adminOnly',
};

/**
 * Settings › Intake › Routes of one Factory: one ordered list. A route's «Коли» is either a card
 * arriving from a source (with conditions: a ClickUp List and status, a pull request, a tag…) — the
 * first enabled route that matches places it — or a schedule of the route's own («За розкладом»),
 * which files its card itself and stays out of that order. Its fire history unfolds in its row.
 */
export function IntakeRoutesSection({ factoryProjectId, factoryName }: { factoryProjectId: string; factoryName: string }) {
  const { t } = useTranslation('settings');
  const routesQuery = useIntakeRoutesQuery(factoryProjectId);
  // Everyone sees the routes; only an organization admin changes them.
  const canEdit = useIntakeRoutesCanEditQuery(factoryProjectId).data === true;
  const catalog = useBoardCatalog(factoryProjectId);
  const create = useCreateIntakeRouteMutation(factoryProjectId);
  const update = useUpdateIntakeRouteMutation(factoryProjectId);
  const remove = useDeleteIntakeRouteMutation(factoryProjectId);
  const reorder = useReorderIntakeRoutesMutation(factoryProjectId);
  const fire = useFireIntakeRouteMutation(factoryProjectId);
  const navigate = useNavigate();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  const routes = routesQuery.data ?? [];
  const boards = catalog.data ?? [];
  const kindsQuery = useIntakeTriggerKindsQuery(factoryProjectId);
  const clickUpConnected = useClickUpStatusQuery().data?.connected === true;
  const clickUpLists = useClickUpListsQuery(clickUpConnected).data ?? [];
  // Repository hosts the Factory uses: those its linked repositories come from.
  const factory = (useFactoriesQuery().data ?? []).find(candidate => candidate.id === factoryProjectId);
  const hosts = new Set((factory?.repositories ?? []).map(repository => repository.provider ?? 'github'));
  const origins: IntakeOrigins = {
    lists: clickUpLists.map(list => ({ value: list.id, label: list.path ? `${list.path} / ${list.name}` : list.name })),
    sources: INTAKE_SOURCES,
    available: source =>
      intakeSourceAvailable(source, { connected: new Set(clickUpConnected ? ['clickup'] : []), hosts }),
  };
  const triggerContext: IntakeKindFormContext = {
    factoryProjectId,
    boards,
    placeholders: kindsQuery.data?.placeholders ?? [],
  };
  const [history, setHistory] = useState<string | null>(null);
  const busy = create.isPending || update.isPending || remove.isPending || reorder.isPending || fire.isPending;

  const move = (index: number, offset: -1 | 1) => {
    const ids = routes.map(route => route.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + offset, 0, moved!);
    reorder.mutate(ids, { onError: error => toast.error(failure(error, t('intakeRoutes.saveFailed'))) });
  };

  const openCard = (route: IntakeRouteInfo, workItemId: string) => ({
    label: t('intakeTriggers.run.openCard'),
    onClick: () =>
      navigate(factoryAttentionTargetPath(factoryProjectId, { kind: 'work-item', workItemId, board: route.target.boardKey })),
  });

  /** What a run did, said once: the card it filed, the open card that held it back, or why it failed. */
  const announce = (route: IntakeRouteInfo, result: IntakeRouteFireInfo) => {
    const name = routeName(route, t);
    if (result.outcome === 'done') {
      if (result.workItemId) toast.success(t('intakeTriggers.run.done', { name }), { action: openCard(route, result.workItemId) });
      else toast.success(t('intakeTriggers.run.doneFiling', { name }));
    } else if (result.outcome === 'skipped') {
      if (result.workItemId) {
        toast.warning(t('intakeTriggers.run.skippedOpen', { name }), { action: openCard(route, result.workItemId) });
      } else toast.warning(t('intakeTriggers.run.skipped', { name, reason: result.reason ?? '' }));
    } else toast.error(t('intakeTriggers.run.failed', { name, reason: result.reason ?? '' }));
  };

  const runNow = (route: IntakeRouteInfo) =>
    fire.mutate(route.id, {
      onSuccess: data => announce(route, data.fire),
      onError: error => {
        const refusal = error instanceof ApiRequestError && error.code ? RUN_REFUSALS[error.code] : undefined;
        toast.error(
          refusal
            ? t(refusal as never)
            : error instanceof ApiRequestError && error.detail
              ? error.detail
              : failure(error, t('intakeTriggers.run.requestFailed')),
        );
      },
    });

  const saveNew = (draft: IntakeRouteDraft, run = false) =>
    create.mutate(draft, {
      onSuccess: data => {
        toast.success(t('intakeRoutes.saved'));
        setEditing(null);
        if (run) runNow(data.intakeRoute);
      },
      onError: error => toast.error(failure(error, t('intakeRoutes.saveFailed'))),
    });

  const saveEdit = (route: IntakeRouteInfo, patch: Partial<IntakeRouteDraft>, onDone?: (saved: IntakeRouteInfo) => void) =>
    update.mutate(
      { route, patch },
      {
        onSuccess: data => {
          toast.success(t('intakeRoutes.saved'));
          onDone?.(data.intakeRoute);
        },
        onError: error => toast.error(failure(error, t('intakeRoutes.saveFailed'))),
      },
    );

  const deleteRoute = (route: IntakeRouteInfo) =>
    remove.mutate(route, {
      onSuccess: () => {
        toast.success(t('intakeRoutes.deleted'));
        setConfirmingDelete(null);
      },
      onError: error => toast.error(failure(error, t('intakeRoutes.saveFailed'))),
    });

  return (
    <SettingsSubsection
      id="new-cards"
      scope="factory"
      title={t('intakeRoutes.title')}
      description={t('intakeRoutes.description', { name: factoryName })}
      action={
        editing === null && routesQuery.isSuccess && canEdit ? (
          <Button size="sm" disabled={busy || !catalog.isSuccess} onClick={() => setEditing('new')}>
            {t('intakeRoutes.add')}
          </Button>
        ) : undefined
      }
    >
      {routesQuery.isPending ? (
        <SkeletonRows label={t('intakeRoutes.loading')} rows={2} />
      ) : routesQuery.isError ? (
        <Txt tone="muted" as="p" variant="caption">
          {t('intakeRoutes.unavailable')}
        </Txt>
      ) : (
        <div className="flex flex-col gap-3">
          {!canEdit && (
            <Txt tone="muted" as="p" variant="caption">
              {t('intakeRoutes.readOnly')}
            </Txt>
          )}
          {routes.length === 0 && editing !== 'new' && (
            <Txt tone="muted" as="p" variant="caption">
              {t('intakeRoutes.empty')}
            </Txt>
          )}
          <ol className="flex flex-col gap-2" aria-label={t('intakeRoutes.listLabel')}>
            {routes.map((route, index) =>
              editing === route.id ? (
                <li key={route.id}>
                  <RouteEditor
                    initial={route}
                    boards={boards}
                    origins={origins}
                    kinds={kindsQuery.data}
                    triggerContext={triggerContext}
                    busy={busy}
                    onCancel={() => setEditing(null)}
                    onSave={draft => saveEdit(route, draft, () => setEditing(null))}
                    onSaveAndRun={draft =>
                      saveEdit(route, draft, saved => {
                        setEditing(null);
                        runNow(saved);
                      })
                    }
                  />
                </li>
              ) : (
                <li
                  key={route.id}
                  className="flex flex-col gap-1 rounded-md border border-border1 px-3 py-2"
                  aria-label={routeName(route, t)}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <Txt as="span" variant="caption" tone="muted">
                        {index + 1}.
                      </Txt>
                      <Txt as="span" variant="body" tone="ink" className="truncate">
                        {routeName(route, t)}
                      </Txt>
                      {isScheduleRoute(route) && (
                        <Badge size="xs" variant="neutral">
                          {t('intakeRoutes.scheduleTag')}
                        </Badge>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1" hidden={!canEdit}>
                      <Switch
                        aria-label={t('intakeRoutes.enabledFor', { name: routeName(route, t) })}
                        checked={route.enabled}
                        disabled={busy}
                        onCheckedChange={enabled => saveEdit(route, { enabled })}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t('intakeRoutes.moveUp', { name: routeName(route, t) })}
                        disabled={busy || index === 0}
                        onClick={() => move(index, -1)}
                      >
                        <ArrowUp aria-hidden />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t('intakeRoutes.moveDown', { name: routeName(route, t) })}
                        disabled={busy || index === routes.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <ArrowDown aria-hidden />
                      </Button>
                      {route.triggered && (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={t('intakeTriggers.run.runNowFor', { name: routeName(route, t) })}
                          disabled={busy}
                          onClick={() => runNow(route)}
                        >
                          {t('intakeTriggers.run.runNow')}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy || editing !== null || !catalog.isSuccess}
                        onClick={() => setEditing(route.id)}
                      >
                        {t('intakeRoutes.edit')}
                      </Button>
                      {confirmingDelete === route.id ? (
                        <Button size="sm" variant="destructive" disabled={busy} onClick={() => deleteRoute(route)}>
                          {t('intakeRoutes.confirmDelete')}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={t('intakeRoutes.deleteRoute', { name: routeName(route, t) })}
                          disabled={busy}
                          onClick={() => setConfirmingDelete(route.id)}
                        >
                          {t('intakeRoutes.delete')}
                        </Button>
                      )}
                    </div>
                  </div>
                  <Txt as="p" variant="caption" tone="muted">
                    {t('intakeRoutes.summary', {
                      when: describeWhen(route, origins, t),
                      target: describeTarget(route.target, boards, t),
                    })}
                  </Txt>
                  {route.triggered && (
                    <TriggerStatus
                      route={route}
                      factoryProjectId={factoryProjectId}
                      open={history === route.id}
                      onToggle={() => setHistory(current => (current === route.id ? null : route.id))}
                    />
                  )}
                  {route.problems.map(problem => (
                    <Txt key={problem} as="p" variant="caption" tone="muted" role="alert">
                      {t('intakeRoutes.problem', { problem })}
                    </Txt>
                  ))}
                </li>
              ),
            )}
          </ol>
          {editing === 'new' && (
            <RouteEditor
              boards={boards}
              origins={origins}
              kinds={kindsQuery.data}
              triggerContext={triggerContext}
              busy={busy}
              onCancel={() => setEditing(null)}
              onSave={draft => saveNew(draft)}
              onSaveAndRun={draft => saveNew(draft, true)}
            />
          )}
        </div>
      )}
    </SettingsSubsection>
  );
}
