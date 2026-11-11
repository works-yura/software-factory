import { intakeSource, intakeSources } from '@factory/core/boards/intake-sources';
import type { IntakeSourceDescriptor } from '@factory/core/boards/intake-sources';
import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { Switch } from '@mastra/playground-ui/components/Switch';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import type { CardRuleGroup, InstalledBoardInfo, IntakeRouteInfo } from '../../../../api/types';
import { useBoardCatalog } from '../../../../hooks/useBoardCatalog';
import { useClickUpListsQuery, useClickUpListStatusesQuery, useClickUpStatusQuery } from '../../../../hooks/useClickUp';
import { useFactoriesQuery } from '../../../../hooks/useFactories';
import {
  useCreateIntakeRouteMutation,
  useDeleteIntakeRouteMutation,
  useIntakeRouteFiresQuery,
  useIntakeRoutesCanEditQuery,
  useIntakeRoutesQuery,
  useIntakeTriggerKindsQuery,
  useReorderIntakeRoutesMutation,
  useUpdateIntakeRouteMutation,
} from '../../../../hooks/useIntakeRoutes';
import type { IntakeRouteDraft, IntakeRouteTriggeredDraft } from '../../../../hooks/useIntakeRoutes';
import type { IntakeTriggerKindsInfo } from '../../../../api/types';
import { currentLanguage } from '../../../i18n';
import '../intake-triggers/builtinForms';
import type { IntakeKindFormContext } from '../intake-triggers/formRegistry';
import { defaultTriggeredDraft, TriggerFields, triggeredReady } from '../intake-triggers/TriggerFields';
import { phaseTitle, boardTitle } from '../../../i18n/boardLabels';
import { SkeletonRows } from '../../../ui/SkeletonRows';
import {
  chooseRouteSource,
  conditionFieldsFor,
  defaultCondition,
  eventsForSource,
  isScheduleRoute,
  readRouteConditions,
  readRouteWhen,
  ROUTE_CLOSE_REASONS,
  ROUTE_SOURCE_KINDS,
  ROUTE_TEXT_FACTS,
  routeEventsEditable,
  writeRouteWhen,
} from '../services/intakeRouteConditions';
import type {
  RouteCloseReason,
  RouteCondition,
  RouteConditionField,
  RouteSourceKind,
  RouteTextFact,
  RouteWhenModel,
} from '../services/intakeRouteConditions';
import { BoardSelect } from './RoutingSelects';
import { SettingsSubsection } from './SettingsSubsection';

const FIRST_PHASE = '__first_phase__';

const failure = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

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
    available: source => sourceAvailable(source, { clickUp: clickUpConnected, hosts }),
  };
  const triggerContext: IntakeKindFormContext = {
    factoryProjectId,
    boards,
    placeholders: kindsQuery.data?.placeholders ?? [],
  };
  const [history, setHistory] = useState<string | null>(null);
  const busy = create.isPending || update.isPending || remove.isPending || reorder.isPending;

  const move = (index: number, offset: -1 | 1) => {
    const ids = routes.map(route => route.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + offset, 0, moved!);
    reorder.mutate(ids, { onError: error => toast.error(failure(error, t('intakeRoutes.saveFailed'))) });
  };

  const saveNew = (draft: IntakeRouteDraft) =>
    create.mutate(draft, {
      onSuccess: () => {
        toast.success(t('intakeRoutes.saved'));
        setEditing(null);
      },
      onError: error => toast.error(failure(error, t('intakeRoutes.saveFailed'))),
    });

  const saveEdit = (route: IntakeRouteInfo, patch: Partial<IntakeRouteDraft>, onDone?: () => void) =>
    update.mutate(
      { route, patch },
      {
        onSuccess: () => {
          toast.success(t('intakeRoutes.saved'));
          onDone?.();
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
              onSave={saveNew}
            />
          )}
        </div>
      )}
    </SettingsSubsection>
  );
}

type T = TFunction<'settings'>;

/** What a route can name from outside the project: the sources the Factory uses and the ClickUp Lists of the connected workspace. */
interface IntakeOrigins {
  /** The ClickUp Lists, for the `source.list` condition: naming one is what makes the project read it. */
  lists: { value: string; label: string }[];
  /** Whether the Factory uses a source: «Коли» offers only these (and keeps a stored route's other source, marked). */
  available: (source: IntakeSourceDescriptor) => boolean;
}

/**
 * A source the Factory uses: ClickUp once the org's ClickUp is connected, GitHub or GitLab when a
 * linked repository comes from it; «будь-яке джерело», «Вручну» and a source added later always.
 */
export function sourceAvailable(
  source: IntakeSourceDescriptor,
  used: { clickUp: boolean; hosts: ReadonlySet<string> },
): boolean {
  if (source.id === 'clickup') return used.clickUp;
  if (source.id === 'github' || source.id === 'gitlab') return used.hosts.has(source.id);
  return true;
}

/** A stored route's other candidates beside the one shown, as a muted note («також GitLab»). */
const alsoNote = (model: RouteWhenModel, t: T) => {
  const others = model.candidates.filter(candidate => candidate.id !== model.source.id);
  return others.length > 0 ? t('intakeRoutes.alsoSources', { sources: others.map(other => sourceLabel(other, t)).join(', ') }) : undefined;
};

const originLabel = (options: IntakeOrigins['lists'], value: string) =>
  options.find(option => option.value === value)?.label ?? value;

/** The group a source's own wording is kept under: GitHub, GitLab and both share one. */
const sourceWording = (sourceId: string) => (sourceId === 'github' || sourceId === 'gitlab' ? 'git' : sourceId);

/** A source's name in the interface language; a source added later without a translation shows its id. */
const sourceLabel = (source: IntakeSourceDescriptor, t: T) =>
  t(`intakeRoutes.sources.${source.id}` as never, { defaultValue: source.id });

/** An event as the source calls it («нова задача» in ClickUp, «нова картка» for any source). */
const eventLabel = (source: IntakeSourceDescriptor | undefined, event: string, t: T) =>
  t(
    [
      ...(source ? [`intakeRoutes.sourceEvents.${sourceWording(source.id)}.${event}`] : []),
      `intakeRoutes.events.${event}`,
    ] as never,
    { defaultValue: event },
  );

/** A condition field as the source calls it («Мітка» in GitHub, «Тег» elsewhere). */
const fieldLabel = (source: IntakeSourceDescriptor | undefined, field: string, t: T) =>
  t(
    [
      ...(source ? [`intakeRoutes.sourceFields.${sourceWording(source.id)}.${field}`] : []),
      `intakeRoutes.fields.${field}`,
    ] as never,
    { defaultValue: field },
  );

function describeCondition(condition: RouteCondition, origins: IntakeOrigins, t: T, source?: IntakeSourceDescriptor): string {
  switch (condition.field) {
    case 'source.list':
      return source?.id === 'clickup'
        ? originLabel(origins.lists, condition.value)
        : t('intakeRoutes.inList', { list: originLabel(origins.lists, condition.value) });
    case 'source.integration':
      return condition.value.map(integration => t(`intakeRoutes.integrations.${integration}`)).join(t('intakeRoutes.or'));
    case 'source.kind':
      return t(`intakeRoutes.kinds.${condition.value}`);
    case 'author.trusted':
      return t(condition.value ? 'intakeRoutes.trusted' : 'intakeRoutes.untrusted');
    case 'item.labels':
      return t('intakeRoutes.hasTag', { tag: condition.value });
    case 'item.title':
      return t('intakeRoutes.titleContains', { text: condition.value });
    case 'item.state':
      return t('intakeRoutes.statusIs', { status: condition.value });
    case 'source.repository':
    case 'item.key':
    case 'item.assignees':
      return t('intakeRoutes.factIs', { field: fieldLabel(source, condition.field, t), value: condition.value });
  }
}

/** Factory's own routes keep the name it gave them; show that name in the interface language. */
const DEFAULT_ROUTE_NAMES: Readonly<Record<string, string>> = {
  'Outside authors wait in Intake': 'outsideAuthors',
  'Pull requests go to Review': 'pullRequests',
  // The name Factory gave the route before Work's PR review phase was renamed Review.
  'Pull requests go to PR review': 'pullRequests',
  'Closed issues go to Done': 'closedCompleted',
  'Issues closed as not planned go to Canceled': 'closedCanceled',
  'Reopened issues go back to Intake': 'reopened',
  'Pull requests that close a waiting issue join its card': 'closesIssue',
  'Merged pull requests go to Done': 'pullRequestMerged',
  'Pull requests closed unmerged go to Canceled': 'pullRequestClosed',
  'Issues whose pull request closed unmerged go back to Intake': 'pullRequestClosedIssue',
  'Pushes to a reviewed pull request re-review it': 'pullRequestUpdated',
  'Requested reviews go to Review': 'pullRequestReviewRequested',
  'Requested reviews go to PR review': 'pullRequestReviewRequested',
  'Everything else goes to Work › Intake': 'everythingElse',
};

/**
 * A route's name in the interface language: Factory's default routes and the routes it wrote (a
 * ClickUp status, a migrated schedule) carry the name it gave them, shown translated until a person
 * renames the route.
 */
function routeName(route: IntakeRouteInfo, t: T): string {
  const key = DEFAULT_ROUTE_NAMES[route.name];
  if (key) return t(`intakeRoutes.defaults.${key}` as never);
  const origin = route.origin;
  if (origin && origin.generatedName === route.name && origin.kind === 'clickup-status') {
    return t('intakeRoutes.origins.clickupStatus', { status: origin.status });
  }
  return route.name;
}

const ROUTE_EVENTS = [
  'work_item.created',
  'work_item.closed',
  'work_item.reopened',
  'work_item.state_changed',
  'pull_request.opened',
  'pull_request.synchronized',
  'pull_request.review_requested',
  'pull_request.merged',
  'pull_request.closed',
] as const;
const CLOSE_REASONS = ['completed', 'canceled'] as const;

function describeEventCondition(condition: CardRuleGroup['conditions'][number], t: T): string | undefined {
  if (!('field' in condition) || condition.operator !== 'equals') return undefined;
  if (condition.field === 'event.reason' && CLOSE_REASONS.includes(condition.value as never))
    return t(`intakeRoutes.closeReasons.${condition.value as (typeof CLOSE_REASONS)[number]}`);
  if (condition.field === 'event.type' && ROUTE_EVENTS.includes(condition.value as never))
    return t(`intakeRoutes.events.${condition.value as (typeof ROUTE_EVENTS)[number]}`);
  return undefined;
}

/**
 * A route's «Коли» in one line: its source, its conditions, then every event it handles —
 * «ClickUp · Syncta / Bugs · статус «to do» · нова задача або статус задачі змінився».
 */
function describeWhen(route: IntakeRouteInfo, origins: IntakeOrigins, t: T): string {
  if (route.triggered) return route.triggered.trigger.summary;
  const model = readRouteWhen(route.when, route.on, origins.available);
  if (model) {
    const { source } = model;
    const onlyNewCards = route.on.length === 1 && route.on[0] === 'work_item.created';
    if (source.id === 'any' && model.conditions.length === 0 && onlyNewCards) return t('intakeRoutes.everyCard');
    const events = route.on.map(event => eventLabel(source, event, t)).join(t('intakeRoutes.or'));
    const also = alsoNote(model, t);
    const unused = origins.available(source) ? undefined : t('intakeRoutes.sourceNotConnected');
    return [
      ...(source.id === 'any'
        ? []
        : [[sourceLabel(source, t), also && `(${also})`, unused && `(${unused})`].filter(Boolean).join(' ')]),
      ...model.conditions.map(condition => describeCondition(condition, origins, t, source)),
      model.closeReason ? `${events} · ${t(`intakeRoutes.closeReasons.${model.closeReason}`)}` : events,
    ].join(' · ');
  }
  // A condition set through the API: its events, and what of it can be read.
  const events = route.on.filter(event => event !== 'work_item.created').map(event => t(`intakeRoutes.events.${event}`));
  const eventConditions: string[] = [];
  let cardConditions = route.when;
  if (events.length > 0 && route.when?.operator === 'AND') {
    const rest = route.when.conditions.filter(condition => {
      const described = describeEventCondition(condition, t);
      if (described) eventConditions.push(described);
      return !described;
    });
    cardConditions = rest.length > 0 ? { ...route.when, conditions: rest } : null;
  }
  const conditions = readRouteConditions(cardConditions);
  const card = !conditions
    ? [t('intakeRoutes.customCondition')]
    : conditions.map(condition => describeCondition(condition, origins, t));
  if (events.length === 0) return card.length > 0 ? card.join(' · ') : t('intakeRoutes.everyCard');
  return [events.join(t('intakeRoutes.or')), ...eventConditions, ...card].join(' · ');
}

function describeTarget(
  target: { boardKey: string; phaseKey: string | null; joinClosedIssue?: boolean },
  boards: InstalledBoardInfo[],
  t: T,
): string {
  const board = boards.find(candidate => candidate.id === target.boardKey);
  const boardName = boardTitle(target.boardKey, board?.name ?? board?.title ?? target.boardKey);
  if (!target.phaseKey) {
    return target.joinClosedIssue
      ? t('intakeRoutes.targetJoinStays', { board: boardName })
      : t('intakeRoutes.targetFirstPhase', { board: boardName });
  }
  const phase = board?.phases.find(candidate => candidate.id === target.phaseKey);
  return t(target.joinClosedIssue ? 'intakeRoutes.targetJoin' : 'intakeRoutes.target', {
    board: boardName,
    phase: phaseTitle(target.boardKey, target.phaseKey, phase?.name ?? phase?.title ?? target.phaseKey),
  });
}

/** A route «За розкладом»'s next fire, its last one, and its fire history on demand. */
function TriggerStatus({
  route,
  factoryProjectId,
  open,
  onToggle,
}: {
  route: IntakeRouteInfo;
  factoryProjectId: string;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation('settings');
  const fires = useIntakeRouteFiresQuery(factoryProjectId, route.id, open);
  const triggered = route.triggered!;
  const format = new Intl.DateTimeFormat(currentLanguage(), { dateStyle: 'medium', timeStyle: 'short' });
  const outcome = (value: string) => t(`intakeTriggers.outcomes.${value}` as never);
  const next = !route.enabled
    ? t('intakeTriggers.paused')
    : triggered.nextFires?.[0]
      ? t('intakeTriggers.nextRun', { at: format.format(new Date(triggered.nextFires[0])) })
      : t('intakeTriggers.noClock');
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Txt as="span" variant="caption" tone="muted">
          {next}
        </Txt>
        {triggered.lastFire?.firedAt && (
          <Txt as="span" variant="caption" tone="muted">
            {t('intakeTriggers.lastRun', {
              outcome: outcome(triggered.lastFire.outcome),
              at: format.format(new Date(triggered.lastFire.firedAt)),
            })}
          </Txt>
        )}
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={onToggle}>
          {t('intakeTriggers.history')}
        </Button>
      </div>
      {open && (
        <ul aria-label={t('intakeTriggers.historyFor', { name: route.name })} className="flex flex-col gap-0.5">
          {fires.isPending && (
            <li>
              <Txt as="span" variant="caption" tone="muted">
                {t('intakeTriggers.loadingHistory')}
              </Txt>
            </li>
          )}
          {fires.data?.length === 0 && (
            <li>
              <Txt as="span" variant="caption" tone="muted">
                {t('intakeTriggers.noFires')}
              </Txt>
            </li>
          )}
          {fires.data?.map(fire => (
            <li key={fire.id}>
              <Txt as="span" variant="caption" tone="muted">
                {format.format(new Date(fire.firedAt))} · {outcome(fire.outcome)}
                {fire.reason ? ` · ${fire.reason}` : ''}
                {fire.workItemId ? ` · ${t('intakeTriggers.openCard')}` : ''}
              </Txt>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** «Коли» of a route: a source its cards arrive from, or a schedule of its own. */
const SCHEDULE = '__schedule__';

const sameEvents = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every(event => b.includes(event));

function RouteEditor({
  initial,
  boards,
  origins,
  kinds,
  triggerContext,
  busy,
  onSave,
  onCancel,
}: {
  initial?: IntakeRouteInfo;
  boards: InstalledBoardInfo[];
  origins: IntakeOrigins;
  /** The kinds a route «За розкладом» can use; unset while they load (or on a server without them). */
  kinds: IntakeTriggerKindsInfo | undefined;
  triggerContext: IntakeKindFormContext;
  busy: boolean;
  onSave: (draft: IntakeRouteDraft) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('settings');
  const [scheduled, setScheduled] = useState(Boolean(initial?.triggered));
  const [triggered, setTriggered] = useState<IntakeRouteTriggeredDraft | undefined>(() =>
    initial?.triggered
      ? {
          trigger: { kind: initial.triggered.trigger.kind, config: initial.triggered.trigger.config },
          action: { kind: initial.triggered.action.kind, config: initial.triggered.action.config },
          policy: { kind: initial.triggered.policy.kind },
        }
      : undefined,
  );
  const triggeredDraft = triggered ?? (kinds ? defaultTriggeredDraft(kinds, triggerContext) : undefined);
  const [name, setName] = useState(initial?.name ?? '');
  const initialOn = initial?.on ?? ['work_item.created'];
  // Undefined: the route's condition is one this form can't show, and is kept exactly as written.
  const readable =
    initial && !initial.triggered ? readRouteWhen(initial.when, initialOn, origins.available) : undefined;
  const custom = Boolean(initial && !initial.triggered && !readable);
  const [model, setModel] = useState<RouteWhenModel>(() => {
    if (readable) return readable;
    const any = intakeSource('any')!;
    return { source: any, candidates: [any], named: false, closeReason: null, conditions: [] };
  });
  // A route whose events this form can't offer for its source keeps them as they are.
  const eventsEditable = !custom && routeEventsEditable(model.source, initialOn);
  const [events, setEvents] = useState<string[]>(() => [...initialOn]);
  const [boardKey, setBoardKey] = useState<string | null>(initial?.target.boardKey ?? null);
  const [phaseKey, setPhaseKey] = useState<string | null>(initial?.target.phaseKey ?? null);

  const board = boards.find(candidate => candidate.id === boardKey);
  // A new card can't land in a terminal phase; the server refuses it too.
  const phases = (board?.phases ?? []).filter(phase => phase.kind !== 'terminal');
  const offered = conditionFieldsFor(model.source).filter(field => !model.conditions.some(condition => condition.field === field));
  const label = initial ? t('intakeRoutes.editTitle', { name: initial.name }) : t('intakeRoutes.newTitle');
  // Only the sources the Factory uses; a stored route's source it no longer uses stays, marked.
  const sources = intakeSources().filter(source => origins.available(source) || source.id === model.source.id);
  const sourceUnused = !scheduled && !origins.available(model.source);
  const also = scheduled ? undefined : alsoNote(model, t);
  // A new route chooses between arriving cards and a schedule; an existing one keeps the kind it is.
  const canSchedule = !initial && Boolean(kinds && kinds.triggers.length > 0);
  const listId = model.conditions.find(condition => condition.field === 'source.list')?.value as string | undefined;

  const setCondition = (index: number, next: RouteCondition) =>
    setModel(current => ({
      ...current,
      conditions: current.conditions.map((condition, at) => (at === index ? next : condition)),
    }));
  const chooseSource = (value: string) => {
    if (value === SCHEDULE) {
      setScheduled(true);
      return;
    }
    setScheduled(false);
    const source = intakeSource(value);
    if (!source) return;
    setModel(current => chooseRouteSource(current, source));
    setEvents(current => eventsForSource(source, current));
  };
  const toggleEvent = (event: string) =>
    setEvents(current => {
      const next = current.includes(event) ? current.filter(value => value !== event) : [...current, event];
      return model.source.events.filter(value => next.includes(value));
    });

  const save = () => {
    if (scheduled) {
      onSave({
        name: name.trim(),
        enabled: initial?.enabled ?? true,
        when: null,
        target: { boardKey: boardKey!, phaseKey },
        triggered: triggeredDraft!,
      });
      return;
    }
    const closes = events.includes('work_item.closed');
    onSave({
      name: name.trim(),
      enabled: initial?.enabled ?? true,
      // Unchanged events are sent as stored, so saving an untouched route leaves it as it was.
      ...(eventsEditable ? { on: initial && sameEvents(events, initialOn) ? [...initialOn] : events } : {}),
      when: custom ? initial!.when : writeRouteWhen(closes ? model : { ...model, closeReason: null }),
      // The server replaces a route's target whole, so a joining route stays a joining one.
      target: { boardKey: boardKey!, phaseKey, joinClosedIssue: initial?.target.joinClosedIssue ?? false },
    });
  };
  const ready =
    name.trim() &&
    boardKey &&
    (scheduled ? Boolean(triggeredDraft && triggeredReady(triggeredDraft)) : !eventsEditable || events.length > 0);

  return (
    <form
      aria-label={label}
      className="flex flex-col gap-3 rounded-md border border-border1 px-3 py-3"
      onSubmit={event => {
        event.preventDefault();
        if (ready) save();
      }}
    >
      <Input
        size="sm"
        aria-label={t('intakeRoutes.name')}
        placeholder={t('intakeRoutes.namePlaceholder')}
        value={name}
        disabled={busy}
        onChange={event => setName(event.target.value)}
      />

      {!(initial?.triggered) && !custom && (
        <div className="flex flex-wrap items-center gap-2">
          <Txt as="span" variant="caption" tone="muted" className="min-w-16">
            {t('intakeTriggers.mode')}
          </Txt>
          <Select value={scheduled ? SCHEDULE : model.source.id} disabled={busy} onValueChange={chooseSource}>
            <SelectTrigger size="sm" aria-label={t('intakeTriggers.mode')} className="w-auto">
              <Txt as="span" variant="caption">
                {scheduled ? t('intakeTriggers.modeSchedule') : sourceLabel(model.source, t)}
              </Txt>
            </SelectTrigger>
            <SelectContent>
              {sources.map(source => (
                <SelectItem key={source.id} value={source.id}>
                  {origins.available(source)
                    ? sourceLabel(source, t)
                    : `${sourceLabel(source, t)} (${t('intakeRoutes.sourceNotConnected')})`}
                </SelectItem>
              ))}
              {canSchedule && <SelectItem value={SCHEDULE}>{t('intakeTriggers.modeSchedule')}</SelectItem>}
            </SelectContent>
          </Select>
          {also && (
            <Txt as="span" variant="caption" tone="muted">
              {also}
            </Txt>
          )}
          {sourceUnused && (
            <Txt as="span" variant="caption" tone="muted">
              {t('intakeRoutes.sourceNotConnected')}
            </Txt>
          )}
        </div>
      )}
      {scheduled && !initial && (
        <Txt as="p" variant="caption" tone="muted">
          {t('intakeTriggers.modeHint')}
        </Txt>
      )}

      {scheduled && kinds && triggeredDraft && (
        <TriggerFields kinds={kinds} context={triggerContext} value={triggeredDraft} onChange={setTriggered} disabled={busy} />
      )}

      {!scheduled && (
        <div className="flex flex-col gap-2">
          <Txt as="span" variant="caption" tone="muted">
            {t('intakeRoutes.event')}
          </Txt>
          {eventsEditable ? (
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t('intakeRoutes.event')}>
              {model.source.events.map(event => {
                const on = events.includes(event);
                return (
                  <Button
                    key={event}
                    type="button"
                    size="sm"
                    variant={on ? 'primary' : 'ghost'}
                    aria-pressed={on}
                    disabled={busy}
                    onClick={() => toggleEvent(event)}
                  >
                    {eventLabel(model.source, event, t)}
                  </Button>
                );
              })}
            </div>
          ) : (
            <Txt as="p" variant="caption" tone="muted">
              {initialOn.map(event => eventLabel(custom ? undefined : model.source, event, t)).join(t('intakeRoutes.or'))}
              {' · '}
              {t('intakeRoutes.eventsKept')}
            </Txt>
          )}
          {eventsEditable && events.includes('work_item.closed') && (
            <div className="flex flex-wrap items-center gap-2">
              <Txt as="span" variant="caption" className="min-w-32">
                {t('intakeRoutes.closeReason')}
              </Txt>
              <Select
                value={model.closeReason ?? ANY_REASON}
                disabled={busy}
                onValueChange={next =>
                  setModel(current => ({ ...current, closeReason: next === ANY_REASON ? null : (next as RouteCloseReason) }))
                }
              >
                <SelectTrigger size="sm" aria-label={t('intakeRoutes.closeReason')} className="w-auto">
                  <Txt as="span" variant="caption">
                    {model.closeReason
                      ? t(`intakeRoutes.closeReasons.${model.closeReason}`)
                      : t('intakeRoutes.anyCloseReason')}
                  </Txt>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY_REASON}>{t('intakeRoutes.anyCloseReason')}</SelectItem>
                  {ROUTE_CLOSE_REASONS.map(reason => (
                    <SelectItem key={reason} value={reason}>
                      {t(`intakeRoutes.closeReasons.${reason}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      )}

      {!scheduled && (
        <div className="flex flex-col gap-2">
          <Txt as="span" variant="caption" tone="muted">
            {t('intakeRoutes.when')}
          </Txt>
          {custom ? (
            <Notice variant="info">{t('intakeRoutes.customConditionKept')}</Notice>
          ) : (
            <>
              {model.conditions.length === 0 && (
                <Txt as="p" variant="caption" tone="muted">
                  {t('intakeRoutes.everyCardHint')}
                </Txt>
              )}
              {model.conditions.map((condition, index) => (
                <ConditionRow
                  key={condition.field}
                  condition={condition}
                  source={model.source}
                  origins={origins}
                  listId={listId}
                  busy={busy}
                  onChange={next => setCondition(index, next)}
                  onRemove={() =>
                    setModel(current => ({ ...current, conditions: current.conditions.filter((_, at) => at !== index) }))
                  }
                />
              ))}
              {offered.length > 0 && (
                <FieldPicker
                  fields={offered}
                  source={model.source}
                  busy={busy}
                  onPick={field => setModel(current => ({ ...current, conditions: [...current.conditions, defaultCondition(field)] }))}
                />
              )}
            </>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Txt as="span" variant="caption" tone="muted">
          {t('intakeRoutes.landsOn')}
        </Txt>
        <BoardSelect
          ariaLabel={t('intakeRoutes.board')}
          value={boardKey}
          placeholder={t('intakeRoutes.chooseBoard')}
          boards={boards}
          disabled={busy}
          onChange={next => {
            setBoardKey(next);
            setPhaseKey(null);
          }}
        />
        <Select
          value={phaseKey ?? FIRST_PHASE}
          disabled={busy || !board}
          onValueChange={next => setPhaseKey(next === FIRST_PHASE ? null : next)}
        >
          <SelectTrigger size="sm" aria-label={t('intakeRoutes.phase')} className="w-auto">
            <Txt as="span" variant="caption">
              {phaseKey
                ? (phases.find(phase => phase.id === phaseKey)?.name ??
                  phases.find(phase => phase.id === phaseKey)?.title ??
                  phaseKey)
                : t('intakeRoutes.firstPhase')}
            </Txt>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={FIRST_PHASE}>{t('intakeRoutes.firstPhase')}</SelectItem>
            {phases.map(phase => (
              <SelectItem key={phase.id} value={phase.id}>
                {phase.name ?? phase.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          {t('intakeRoutes.cancel')}
        </Button>
        <Button type="submit" size="sm" variant="primary" disabled={busy || !ready}>
          {t('intakeRoutes.save')}
        </Button>
      </div>
    </form>
  );
}

const ANY_REASON = '__any__';

const isTextFactCondition = (condition: RouteCondition): condition is Extract<RouteCondition, { field: RouteTextFact }> =>
  (ROUTE_TEXT_FACTS as readonly string[]).includes(condition.field);

function FieldPicker({
  fields,
  source,
  busy,
  onPick,
}: {
  fields: readonly RouteConditionField[];
  source: IntakeSourceDescriptor;
  busy: boolean;
  onPick: (field: RouteConditionField) => void;
}) {
  const { t } = useTranslation('settings');
  return (
    <Select
      value=""
      disabled={busy}
      // The picker resets to empty after each pick, and reports that too: only a field adds a condition.
      onValueChange={next => {
        const field = fields.find(candidate => candidate === next);
        if (field) onPick(field);
      }}
    >
      <SelectTrigger size="sm" aria-label={t('intakeRoutes.addCondition')} className="w-auto self-start">
        <Txt as="span" variant="caption">
          {t('intakeRoutes.addCondition')}
        </Txt>
      </SelectTrigger>
      <SelectContent>
        {fields.map(field => (
          <SelectItem key={field} value={field}>
            {fieldLabel(source, field, t)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The kinds a condition on «Тип» can name for a source: GitHub and GitLab have issues and pull requests. */
const kindsFor = (source: IntakeSourceDescriptor): readonly RouteSourceKind[] =>
  source.id === 'any' ? ROUTE_SOURCE_KINDS : ROUTE_SOURCE_KINDS.filter(kind => kind !== 'task');

function ConditionRow({
  condition,
  source,
  origins,
  listId,
  busy,
  onChange,
  onRemove,
}: {
  condition: RouteCondition;
  source: IntakeSourceDescriptor;
  origins: IntakeOrigins;
  /** The ClickUp List the route names, whose statuses «Статус» offers. */
  listId: string | undefined;
  busy: boolean;
  onChange: (next: RouteCondition) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation('settings');
  const label = fieldLabel(source, condition.field, t);
  const statuses = useClickUpListStatusesQuery(
    condition.field === 'item.state' && source.id === 'clickup' ? listId : undefined,
  ).data;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Txt as="span" variant="caption" className="min-w-32">
        {label}
      </Txt>
      {condition.field === 'source.kind' && (
        <Select
          value={condition.value}
          disabled={busy}
          onValueChange={next => onChange({ field: condition.field, value: next as RouteSourceKind })}
        >
          <SelectTrigger size="sm" aria-label={label} className="w-auto">
            <Txt as="span" variant="caption">
              {t(`intakeRoutes.kinds.${condition.value}`)}
            </Txt>
          </SelectTrigger>
          <SelectContent>
            {kindsFor(source).map(kind => (
              <SelectItem key={kind} value={kind}>
                {t(`intakeRoutes.kinds.${kind}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {condition.field === 'author.trusted' && (
        <Select
          value={condition.value ? 'yes' : 'no'}
          disabled={busy}
          onValueChange={next => onChange({ field: condition.field, value: next === 'yes' })}
        >
          <SelectTrigger size="sm" aria-label={label} className="w-auto">
            <Txt as="span" variant="caption">
              {t(condition.value ? 'intakeRoutes.trusted' : 'intakeRoutes.untrusted')}
            </Txt>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="yes">{t('intakeRoutes.trusted')}</SelectItem>
            <SelectItem value="no">{t('intakeRoutes.untrusted')}</SelectItem>
          </SelectContent>
        </Select>
      )}
      {condition.field === 'source.list' && (
        <Select value={condition.value} disabled={busy} onValueChange={next => onChange({ field: condition.field, value: next })}>
          <SelectTrigger size="sm" aria-label={label} className="w-auto">
            <Txt as="span" variant="caption">
              {condition.value ? originLabel(origins.lists, condition.value) : t('intakeRoutes.choose')}
            </Txt>
          </SelectTrigger>
          <SelectContent>
            {origins.lists.map(option => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {condition.field === 'item.state' && statuses && statuses.length > 0 ? (
        <Select value={condition.value} disabled={busy} onValueChange={next => onChange({ field: condition.field, value: next })}>
          <SelectTrigger size="sm" aria-label={label} className="w-auto">
            <Txt as="span" variant="caption">
              {condition.value || t('intakeRoutes.choose')}
            </Txt>
          </SelectTrigger>
          <SelectContent>
            {/* A status the route names that the List no longer has stays choosable. */}
            {[...new Set([...statuses.map(status => status.name), ...(condition.value ? [condition.value] : [])])].map(
              status => (
                <SelectItem key={status} value={status}>
                  {status}
                </SelectItem>
              ),
            )}
          </SelectContent>
        </Select>
      ) : (
        isTextFactCondition(condition) && (
          <Input
            size="sm"
            aria-label={label}
            placeholder={t(`intakeRoutes.placeholders.${condition.field}`)}
            value={condition.value}
            disabled={busy}
            onChange={event => onChange({ field: condition.field, value: event.target.value })}
          />
        )
      )}
      {(condition.field === 'item.labels' || condition.field === 'item.title') && (
        <Input
          size="sm"
          aria-label={label}
          placeholder={t(condition.field === 'item.labels' ? 'intakeRoutes.tagPlaceholder' : 'intakeRoutes.titlePlaceholder')}
          value={condition.value}
          disabled={busy}
          onChange={event => onChange({ field: condition.field, value: event.target.value })}
        />
      )}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-label={t('intakeRoutes.removeCondition', { field: label })}
        disabled={busy}
        onClick={onRemove}
      >
        <X aria-hidden />
      </Button>
    </div>
  );
}
