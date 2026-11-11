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
import { useIntakeRuleKindsQuery, useIntakeRulesQuery } from '../../../../hooks/useIntakeRules';
import {
  useCreateIntakeRouteMutation,
  useDeleteIntakeRouteMutation,
  useIntakeRoutesCanEditQuery,
  useIntakeRoutesQuery,
  useReorderIntakeRoutesMutation,
  useUpdateIntakeRouteMutation,
} from '../../../../hooks/useIntakeRoutes';
import type { IntakeRouteDraft } from '../../../../hooks/useIntakeRoutes';
import { phaseTitle, boardTitle } from '../../../i18n/boardLabels';
import { SkeletonRows } from '../../../ui/SkeletonRows';
import {
  defaultCondition,
  isBlankCondition,
  readRouteConditions,
  ROUTE_CONDITION_FIELDS,
  ROUTE_INTEGRATIONS,
  ROUTE_SOURCE_KINDS,
  ROUTE_TEXT_FACTS,
  writeRouteConditions,
} from '../services/intakeRouteConditions';
import type {
  RouteCondition,
  RouteConditionField,
  RouteSourceKind,
  RouteTextFact,
} from '../services/intakeRouteConditions';
import { BoardSelect } from './RoutingSelects';
import { SettingsSubsection } from './SettingsSubsection';

const FIRST_PHASE = '__first_phase__';

const failure = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

/**
 * Settings › Intake › Routes of one Factory: an ordered list that decides where each new card lands.
 * The first enabled route whose condition matches a new card places it; tag routes and the List's
 * board apply only when none does.
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
  const rulesQuery = useIntakeRulesQuery(factoryProjectId);
  const kindsQuery = useIntakeRuleKindsQuery(factoryProjectId);
  const origins: IntakeOrigins = {
    rules: (rulesQuery.data ?? []).map(rule => ({ value: rule.id, label: rule.name })),
    triggers: (kindsQuery.data?.triggers ?? []).map(trigger => ({ value: trigger.kind, label: trigger.label })),
  };
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
      id="intake-routes"
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
            <RouteEditor boards={boards} origins={origins} busy={busy} onCancel={() => setEditing(null)} onSave={saveNew} />
          )}
        </div>
      )}
    </SettingsSubsection>
  );
}

type T = TFunction<'settings'>;

/** What an intake-rule condition can name: the project's rules and the trigger kinds, labelled. */
interface IntakeOrigins {
  rules: { value: string; label: string }[];
  triggers: { value: string; label: string }[];
}

const originLabel = (options: IntakeOrigins['rules'], value: string) =>
  options.find(option => option.value === value)?.label ?? value;

function describeCondition(condition: RouteCondition, origins: IntakeOrigins, t: T): string {
  switch (condition.field) {
    case 'intake.rule':
      return t('intakeRoutes.fromRule', { rule: originLabel(origins.rules, condition.value) });
    case 'intake.trigger':
      return t('intakeRoutes.fromTrigger', { trigger: originLabel(origins.triggers, condition.value) });
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
    case 'source.repository':
    case 'item.key':
    case 'item.state':
    case 'item.assignees':
      return t('intakeRoutes.factIs', { field: t(`intakeRoutes.fields.${condition.field}`), value: condition.value });
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

function routeName(route: IntakeRouteInfo, t: T): string {
  const key = DEFAULT_ROUTE_NAMES[route.name];
  return key ? t(`intakeRoutes.defaults.${key}` as never) : route.name;
}

const ROUTE_EVENTS = [
  'work_item.created',
  'work_item.closed',
  'work_item.reopened',
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

function describeWhen(route: IntakeRouteInfo, origins: IntakeOrigins, t: T): string {
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

function RouteEditor({
  initial,
  boards,
  origins,
  busy,
  onSave,
  onCancel,
}: {
  initial?: IntakeRouteInfo;
  boards: InstalledBoardInfo[];
  origins: IntakeOrigins;
  busy: boolean;
  onSave: (draft: IntakeRouteDraft) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('settings');
  const [name, setName] = useState(initial?.name ?? '');
  const readable = readRouteConditions(initial?.when ?? null);
  const [conditions, setConditions] = useState<RouteCondition[]>(readable ?? []);
  const [boardKey, setBoardKey] = useState<string | null>(initial?.target.boardKey ?? null);
  const [phaseKey, setPhaseKey] = useState<string | null>(initial?.target.phaseKey ?? null);

  const board = boards.find(candidate => candidate.id === boardKey);
  // A new card can't land in a terminal phase; the server refuses it too.
  const phases = (board?.phases ?? []).filter(phase => phase.kind !== 'terminal');
  const unused = ROUTE_CONDITION_FIELDS.filter(field => !conditions.some(condition => condition.field === field));
  const label = initial ? t('intakeRoutes.editTitle', { name: initial.name }) : t('intakeRoutes.newTitle');

  const setCondition = (index: number, next: RouteCondition) =>
    setConditions(current => current.map((condition, at) => (at === index ? next : condition)));

  const save = () =>
    onSave({
      name: name.trim(),
      enabled: initial?.enabled ?? true,
      // A condition this form can't show is kept exactly as it was.
      when: readable ? writeRouteConditions(conditions.filter(condition => !isBlankCondition(condition))) : initial!.when,
      // The server replaces a route's target whole, so a joining route stays a joining one.
      target: { boardKey: boardKey!, phaseKey, joinClosedIssue: initial?.target.joinClosedIssue ?? false },
    });

  return (
    <form
      aria-label={label}
      className="flex flex-col gap-3 rounded-md border border-border1 px-3 py-3"
      onSubmit={event => {
        event.preventDefault();
        if (name.trim() && boardKey) save();
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

      <div className="flex flex-col gap-2">
        <Txt as="span" variant="caption" tone="muted">
          {t('intakeRoutes.when')}
        </Txt>
        {!readable ? (
          <Notice variant="info">{t('intakeRoutes.customConditionKept')}</Notice>
        ) : (
          <>
            {conditions.length === 0 && (
              <Txt as="p" variant="caption" tone="muted">
                {t('intakeRoutes.everyCardHint')}
              </Txt>
            )}
            {conditions.map((condition, index) => (
              <ConditionRow
                key={condition.field}
                condition={condition}
                origins={origins}
                busy={busy}
                onChange={next => setCondition(index, next)}
                onRemove={() => setConditions(current => current.filter((_, at) => at !== index))}
              />
            ))}
            {unused.length > 0 && (
              <FieldPicker
                fields={unused}
                busy={busy}
                onPick={field => setConditions(current => [...current, defaultCondition(field)])}
              />
            )}
          </>
        )}
      </div>

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
        <Button type="submit" size="sm" variant="primary" disabled={busy || !name.trim() || !boardKey}>
          {t('intakeRoutes.save')}
        </Button>
      </div>
    </form>
  );
}

const isTextFactCondition = (condition: RouteCondition): condition is Extract<RouteCondition, { field: RouteTextFact }> =>
  (ROUTE_TEXT_FACTS as readonly string[]).includes(condition.field);

function FieldPicker({
  fields,
  busy,
  onPick,
}: {
  fields: readonly RouteConditionField[];
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
            {t(`intakeRoutes.fields.${field}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ConditionRow({
  condition,
  origins,
  busy,
  onChange,
  onRemove,
}: {
  condition: RouteCondition;
  origins: IntakeOrigins;
  busy: boolean;
  onChange: (next: RouteCondition) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation('settings');
  const fieldLabel = t(`intakeRoutes.fields.${condition.field}`);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Txt as="span" variant="caption" className="min-w-32">
        {fieldLabel}
      </Txt>
      {condition.field === 'source.integration' && (
        <div className="flex items-center gap-1" role="group" aria-label={fieldLabel}>
          {ROUTE_INTEGRATIONS.map(integration => {
            const on = condition.value.includes(integration);
            return (
              <Button
                key={integration}
                type="button"
                size="sm"
                variant={on ? 'primary' : 'ghost'}
                aria-pressed={on}
                disabled={busy}
                onClick={() =>
                  onChange({
                    field: condition.field,
                    value: on
                      ? condition.value.filter(value => value !== integration)
                      : ROUTE_INTEGRATIONS.filter(value => value === integration || condition.value.includes(value)),
                  })
                }
              >
                {t(`intakeRoutes.integrations.${integration}`)}
              </Button>
            );
          })}
        </div>
      )}
      {condition.field === 'source.kind' && (
        <Select
          value={condition.value}
          disabled={busy}
          onValueChange={next => onChange({ field: condition.field, value: next as RouteSourceKind })}
        >
          <SelectTrigger size="sm" aria-label={fieldLabel} className="w-auto">
            <Txt as="span" variant="caption">
              {t(`intakeRoutes.kinds.${condition.value}`)}
            </Txt>
          </SelectTrigger>
          <SelectContent>
            {ROUTE_SOURCE_KINDS.map(kind => (
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
          <SelectTrigger size="sm" aria-label={fieldLabel} className="w-auto">
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
      {(condition.field === 'intake.rule' || condition.field === 'intake.trigger') && (
        <Select
          value={condition.value}
          disabled={busy}
          onValueChange={next => onChange({ field: condition.field, value: next })}
        >
          <SelectTrigger size="sm" aria-label={fieldLabel} className="w-auto">
            <Txt as="span" variant="caption">
              {condition.value
                ? originLabel(condition.field === 'intake.rule' ? origins.rules : origins.triggers, condition.value)
                : t('intakeRoutes.choose')}
            </Txt>
          </SelectTrigger>
          <SelectContent>
            {(condition.field === 'intake.rule' ? origins.rules : origins.triggers).map(option => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {isTextFactCondition(condition) && (
        <Input
          size="sm"
          aria-label={fieldLabel}
          placeholder={t(`intakeRoutes.placeholders.${condition.field}`)}
          value={condition.value}
          disabled={busy}
          onChange={event => onChange({ field: condition.field, value: event.target.value })}
        />
      )}
      {(condition.field === 'item.labels' || condition.field === 'item.title') && (
        <Input
          size="sm"
          aria-label={fieldLabel}
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
        aria-label={t('intakeRoutes.removeCondition', { field: fieldLabel })}
        disabled={busy}
        onClick={onRemove}
      >
        <X aria-hidden />
      </Button>
    </div>
  );
}
