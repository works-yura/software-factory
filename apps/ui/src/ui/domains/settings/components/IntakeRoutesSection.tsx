import { DEFAULT_BOARD_ID } from '@factory/core/boards/default-board';
import { INTAKE_ROUTE_RULE_FIELDS, routeEventsProblem } from '@factory/core/boards/board-events';
import { intakeSourceAvailable, intakeSourceCondition } from '@factory/core/boards/intake-sources';
import type { IntakeSourceDescriptor } from '@factory/core/boards/intake-sources';
import { ruleGroupSchema } from '@factory/core/rules/rule-group';
import type { RuleGroup } from '@factory/core/rules/rule-group';
import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { DropdownMenu } from '@mastra/playground-ui/components/DropdownMenu';
import type { FilterBarOption } from '@mastra/playground-ui/components/FilterBar';
import { Notice } from '@mastra/playground-ui/components/Notice';
import {
  RuleCard,
  RuleCardBody,
  RuleCardDragHandle,
  RuleCardHeader,
  RuleCardOutcome,
  RuleCardStep,
  RuleCardTitle,
  RuleCardTitleInput,
} from '@mastra/playground-ui/components/RuleCard';
import { RuleAddButton, RuleLine, RuleLineContent, RuleLineKeyword, RuleLines } from '@mastra/playground-ui/components/RuleLines';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { Switch } from '@mastra/playground-ui/components/Switch';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { cn } from '@mastra/playground-ui/utils/cn';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, MoreHorizontal, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { Fragment, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { ApiRequestError } from '../../../../api/client';
import { queryKeys } from '../../../../api/keys';
import type {
  InstalledBoardInfo,
  IntakeRouteFireInfo,
  IntakeRouteInfo,
  IntakeRouteListResponse,
} from '../../../../api/types';
import { useBoardCatalog } from '../../../../hooks/useBoardCatalog';
import { useClickUpListsQuery, useClickUpStatusQuery } from '../../../../hooks/useClickUp';
import { useFactoriesQuery } from '../../../../hooks/useFactories';
import {
  useFireIntakeRouteMutation,
  useIntakeRoutesQuery,
  useIntakeRoutesCanEditQuery,
  useIntakeRouteWrites,
  useIntakeTriggerKindsQuery,
} from '../../../../hooks/useIntakeRoutes';
import type { IntakeRouteDraft, RouteWrite } from '../../../../hooks/useIntakeRoutes';
import { translator } from '../../../i18n/t';
import { SkeletonRows } from '../../../ui/SkeletonRows';
import { factoryAttentionTargetPath } from '../../factory/services/attention';
import { BoardStageIcon, phaseIconKind } from '../../factory/components/BoardIcons';
import '../intake-triggers/builtinForms';
import type { IntakeKindFormContext } from '../intake-triggers/formRegistry';
import { joinWhen, pruneRule, splitWhen } from '../services/intakeRouteConditions';
import type { Limit } from '../services/rules';
import { INTAKE_SOURCES } from '../services/intakeSources';
import { NEW_CARD_ROUTES_ANCHOR } from '../settingsSections';
import { ConditionRows } from './ConditionRows';
import { describeConditions, factsFor, intakeRouteFacts } from './conditionFields';
import { ScheduleRouteEditor } from './IntakeRouteEditor';
import { describeTarget, describeWhen, routeName, sourceLabel } from './intakeRouteLabels';
import type { IntakeOrigins } from './intakeRouteLabels';
import { TriggerStatus } from './IntakeRouteTriggerStatus';
import {
  boardName,
  catchesEveryArrival,
  MOVE_EVENTS,
  phaseName,
  phaseOptions,
  placesNewCards,
  reorderWithin,
  sendNewCardsTo,
  triggerLabel,
} from './intakeRoutes';
import { SettingsSubsection } from './SettingsSubsection';
import { sourceSuggestions } from './sourceSuggestions';
import type { SourceOption } from './sourceSuggestions';
import { useRowDrag } from './useRowDrag';

const tk = translator('settings');

const ROUTE_WHEN_SCHEMA = ruleGroupSchema(INTAKE_ROUTE_RULE_FIELDS);
const STALE_CODES = new Set(['revision_mismatch', 'intake_route_set_mismatch', 'intake_route_not_found']);
const DROP_LINE = cn(
  'before:bg-border-focus before:pointer-events-none before:absolute before:right-0 before:left-0 before:z-20 before:hidden before:h-0.5 before:rounded-full',
  'data-[drop=before]:before:-top-2 data-[drop=before]:before:block data-[drop=after]:before:-bottom-2 data-[drop=after]:before:block',
);
/** The facts a pull request route can also test: the issue it closes. Only repository hosts send pull requests. */
const PULL_REQUEST_FIELDS = ['pullRequest.closesIssue', 'closedIssue.phase', 'closedIssue.hasPullRequest'];

const json = (rule: RuleGroup | null | undefined) => JSON.stringify(rule ?? null);

/**
 * Which routes a list shows. New-card routes are one ordered list for the whole Factory; every other route
 * only moves cards already on its own board, so each board lists its own. Routes «За розкладом» make their
 * own cards and are listed apart.
 */
type RouteScope = { kind: 'arrivals' } | { kind: 'moves'; board: InstalledBoardInfo };

type RouteFields = Partial<Pick<IntakeRouteInfo, 'name' | 'enabled' | 'when' | 'on' | 'target'>>;
type NewRouteValue = Pick<IntakeRouteInfo, 'name' | 'on' | 'when' | 'target'>;

function inScope(route: IntakeRouteInfo, scope: RouteScope): boolean {
  if (route.triggered) return false;
  if (scope.kind === 'arrivals') return placesNewCards(route);
  return !placesNewCards(route) && route.target.boardKey === scope.board.id;
}

/** The card facts a route on `source` can test: its own fields, and for a repository host the issue a pull request closes. */
function sourceFields(source: IntakeSourceDescriptor | undefined): string[] | undefined {
  // «Будь-яке джерело» can test any fact a card carries.
  if (!source || source.id === 'any') return undefined;
  return [
    ...source.fields,
    ...(source.events.includes('pull_request.opened') ? PULL_REQUEST_FIELDS : []),
  ];
}

/**
 * Phases a route may aim at. New cards can't land in a finished phase, and start in the first phase, so they can
 * only land where it can move them. A pull request joining its issue's card moves that card, so only the first rule
 * holds there.
 */
function targetPhases(board: InstalledBoardInfo | undefined, placesNew: boolean, joining: boolean) {
  const phases = board?.phases ?? [];
  if (!placesNew) return phases;
  if (joining) return phases.filter(phase => phase.kind !== 'terminal');
  const first = phases.find(phase => phase.id === board?.initialPhase);
  return phases.filter(
    phase => phase.kind !== 'terminal' && (phase.id === first?.id || first?.nextPhases?.includes(phase.id) === true),
  );
}

/** What a rule can't say on a route listening for these events, or undefined when the route can save it. */
function whenProblem(on: IntakeRouteInfo['on'], when: RuleGroup | null): string | undefined {
  if (when) {
    const parsed = ROUTE_WHEN_SCHEMA.safeParse(when);
    if (!parsed.success) return parsed.error.issues[0]?.message;
  }
  return routeEventsProblem(on, when) ?? undefined;
}

/** The values a change replaces, so Undo can put them back. */
function previousOf(route: IntakeRouteInfo, fields: RouteFields): RouteFields {
  const previous: RouteFields = {};
  if (fields.name !== undefined) previous.name = route.name;
  if (fields.enabled !== undefined) previous.enabled = route.enabled;
  if (fields.when !== undefined) previous.when = route.when;
  if (fields.on !== undefined) previous.on = route.on;
  if (fields.target !== undefined) previous.target = route.target;
  return previous;
}

function updateMessage(fields: RouteFields): string {
  if (fields.enabled !== undefined) return fields.enabled ? tk('intakeRoutes.turnedOn') : tk('intakeRoutes.turnedOff');
  if (fields.name !== undefined) return tk('intakeRoutes.renamed');
  if (fields.on !== undefined) return tk('intakeRoutes.triggerChanged');
  if (fields.target !== undefined) return tk('intakeRoutes.destinationChanged');
  return tk('intakeRoutes.conditionsSaved');
}

function saveFailureMessage(error: unknown): string {
  if (error instanceof ApiRequestError && STALE_CODES.has(error.code ?? '')) return tk('intakeRoutes.changedFirst');
  if (error instanceof ApiRequestError && error.detail) return error.detail;
  return error instanceof Error && error.message ? error.message : tk('intakeRoutes.saveFailed');
}

function stepLabel(index: number, catchAllAt: number): string {
  if (index === catchAllAt) return tk('intakeRoutes.steps.otherwise');
  return index === 0 ? tk('intakeRoutes.steps.if') : tk('intakeRoutes.steps.elseIf');
}

function destinationLabelFor(scope: RouteScope, joining: boolean): string {
  if (scope.kind === 'moves') return tk('intakeRoutes.moveTo');
  return joining ? tk('intakeRoutes.joinAndMoveTo') : tk('intakeRoutes.sendTo');
}

/**
 * Whether a route can join a pull request to the card of the issue it closes: it handles arrivals alone, and
 * every card it matches is a pull request that closes an issue.
 */
function canJoinIssueCard(on: IntakeRouteInfo['on'], when: RuleGroup | null): boolean {
  if (on.length !== 1 || on[0] !== 'work_item.created' || when?.operator !== 'AND') return false;
  const requires = (field: string, value: unknown) =>
    when.conditions.some(
      condition =>
        !('conditions' in condition) && condition.field === field && condition.operator === 'equals' && condition.value === value,
    );
  return requires('source.kind', 'pull_request') && requires('pullRequest.closesIssue', true);
}

/** The phase a route keeps when what it does with cards changes: its own if cards can still be there. */
function phaseStillOffered(board: InstalledBoardInfo | undefined, phaseKey: string, joining: boolean): string {
  if (targetPhases(board, true, joining).some(phase => phase.id === phaseKey)) return phaseKey;
  return board?.initialPhase ?? phaseKey;
}

function JoinIssueCard({ checked, onChange }: { checked: boolean; onChange: (joining: boolean) => void }) {
  return (
    <div className="flex items-start gap-2 pr-2 pl-4">
      <Switch aria-label={tk('intakeRoutes.joinIssueCard')} checked={checked} onCheckedChange={onChange} />
      <div className="flex min-w-0 flex-col">
        <Txt as="span" variant="caption">
          {tk('intakeRoutes.joinIssueCard')}
        </Txt>
        <Txt as="span" variant="caption" tone="muted">
          {tk('intakeRoutes.joinIssueCardHint')}
        </Txt>
      </div>
    </div>
  );
}

/**
 * Saves route changes one after another, each built from the routes as they are when its turn comes, so a
 * write always names the revision it last saw. Changes show at once; a failed one reloads the routes.
 */
function useRouteSaves(factoryId: string) {
  const queryClient = useQueryClient();
  const writes = useIntakeRouteWrites(factoryId);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const [failures, setFailures] = useState(0);
  const key = queryKeys.intakeRoutes(factoryId);

  const latest = () => queryClient.getQueryData<IntakeRouteListResponse>(key)?.intakeRoutes ?? [];
  const show = (change: (routes: IntakeRouteInfo[]) => IntakeRouteInfo[]) =>
    queryClient.setQueryData<IntakeRouteListResponse>(key, data =>
      data ? { ...data, intakeRoutes: change(data.intakeRoutes) } : data,
    );
  /** Queues `task` after the earlier saves; resolves to whether it went through. */
  const save = (task: (send: (changes: RouteWrite[]) => Promise<IntakeRouteInfo[]>) => Promise<void>) => {
    const done = queue.current
      .then(() => task(changes => writes.mutateAsync(changes)))
      .then(
        () => true,
        async (error: unknown) => {
          setFailures(count => count + 1);
          toast.error(saveFailureMessage(error));
          await queryClient.invalidateQueries({ queryKey: key });
          return false;
        },
      );
    queue.current = done.then(() => undefined);
    return done;
  };
  return { latest, show, save, failures, pending: writes.isPending };
}

/** The routes changed under a queued edit, so it can't be applied as shown. */
const routesChanged = () => new ApiRequestError(tk('intakeRoutes.changedFirst'), 409, 'intake_route_set_mismatch');

function announce(id: string, message: string, undo?: () => void) {
  toast(message, { id: `route-${id}`, ...(undo ? { action: { label: tk('intakeRoutes.undo'), onClick: undo } } : {}) });
}

/** What a route was created with, so a deleted one can be made again. */
function draftOf(route: IntakeRouteInfo): IntakeRouteDraft {
  return {
    name: route.name,
    enabled: route.enabled,
    when: route.when,
    target: route.target,
    ...(route.triggered
      ? {
          triggered: {
            trigger: { kind: route.triggered.trigger.kind, config: route.triggered.trigger.config },
            action: { kind: route.triggered.action.kind, config: route.triggered.action.config },
            policy: { kind: route.triggered.policy.kind },
          },
        }
      : { on: route.on }),
  };
}

/** What a route can name from outside the project, and the project's repositories for `source.repository`. */
type RouteOrigins = IntakeOrigins & { repositories: SourceOption[] };

/** What a route can name from outside the project: the sources the Factory uses and the ClickUp Lists. */
function useIntakeOrigins(factoryProjectId: string): RouteOrigins {
  const clickUpConnected = useClickUpStatusQuery().data?.connected === true;
  const clickUpLists = useClickUpListsQuery(clickUpConnected).data ?? [];
  // Repository hosts the Factory uses: those its linked repositories come from.
  const factory = (useFactoriesQuery().data ?? []).find(candidate => candidate.id === factoryProjectId);
  const hosts = new Set((factory?.repositories ?? []).map(repository => repository.provider ?? 'github'));
  return {
    repositories: sourceSuggestions(factory?.repositories),
    lists: clickUpLists.map(list => ({ value: list.id, label: list.path ? `${list.path} / ${list.name}` : list.name })),
    sources: INTAKE_SOURCES,
    available: source =>
      intakeSourceAvailable(source, { connected: new Set(clickUpConnected ? ['clickup'] : []), hosts }),
  };
}

/** Values to pick from per condition field: a board's phases, the connected workspace's ClickUp Lists. */
function conditionOptions(board: InstalledBoardInfo | undefined, origins: RouteOrigins): Record<string, FilterBarOption[]> {
  return {
    ...phaseOptions(board),
    'source.repository': origins.repositories,
    ...(origins.lists.length > 0 ? { 'source.list': origins.lists } : {}),
  };
}

/** The source a route names, as a condition every card its rows test also meets. */
function sourceLimits(source: IntakeSourceDescriptor | undefined): Limit[] {
  const named = source && intakeSourceCondition(source);
  return named ? [{ field: named.field, operator: named.operator, value: named.value }] : [];
}

/** Read-only conditions, as a member sees them. */
function ConditionChips({ rule, options, fallback }: { rule: RuleGroup | null; options: Record<string, FilterBarOption[]>; fallback: string }) {
  const conditions = describeConditions(rule, options);
  if (!conditions) {
    return (
      <Txt as="span" variant="caption" tone="muted">
        {fallback}
      </Txt>
    );
  }
  return conditions.parts.map((part, index) => (
    <Fragment key={index}>
      {index > 0 && conditions.join === 'or' && (
        <Txt as="span" variant="caption" tone="muted">
          {tk('conditions.or').trim()}
        </Txt>
      )}
      <Badge size="sm" emphasis="subtle">
        {part}
      </Badge>
    </Fragment>
  ));
}

function BoardPicker({
  value,
  boards,
  label,
  onChange,
}: {
  value: string;
  boards: InstalledBoardInfo[];
  label: string;
  onChange: (boardKey: string) => void;
}) {
  const board = boards.find(candidate => candidate.id === value);
  return (
    <Select value={value} onValueChange={key => key && key !== value && onChange(key)}>
      <SelectTrigger variant="ghost" size="sm" aria-label={label} className="w-fit">
        <Txt as="span" variant="caption">
          {board ? boardName(board) : tk('intakeRoutes.notInstalled', { board: value })}
        </Txt>
      </SelectTrigger>
      <SelectContent>
        {boards.map(candidate => (
          <SelectItem key={candidate.id} value={candidate.id}>
            {boardName(candidate)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function PhaseLabel({ board, phaseKey }: { board: InstalledBoardInfo; phaseKey: string }) {
  const phase = board.phases.find(candidate => candidate.id === phaseKey);
  return (
    <span className="flex items-center gap-1.5">
      {phase && <BoardStageIcon stage={phase.id} kind={phaseIconKind(board.id, phase.kind)} decorative />}
      <Txt as="span" variant="caption">
        {phaseName(board, phaseKey) ?? phaseKey}
      </Txt>
    </span>
  );
}

function PhasePicker({
  board,
  value,
  placesNew,
  joining = false,
  label,
  onChange,
}: {
  board: InstalledBoardInfo;
  value: string;
  placesNew: boolean;
  /** The route joins a pull request to its issue's card, which already sits on the board. */
  joining?: boolean;
  label: string;
  onChange: (phaseKey: string) => void;
}) {
  return (
    <Select value={value} onValueChange={key => key && key !== value && onChange(key)}>
      <SelectTrigger variant="ghost" size="sm" aria-label={label} className="w-fit">
        <PhaseLabel board={board} phaseKey={value} />
      </SelectTrigger>
      <SelectContent>
        {targetPhases(board, placesNew, joining).map(phase => (
          <SelectItem key={phase.id} value={phase.id}>
            <PhaseLabel board={board} phaseKey={phase.id} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The event a card move waits for, among the ones its source sends. */
function EventPicker({
  value,
  source,
  onChange,
}: {
  value: IntakeRouteInfo['on'];
  source: IntakeSourceDescriptor | undefined;
  onChange: (on: IntakeRouteInfo['on']) => void;
}) {
  const events = MOVE_EVENTS.filter(event => !source || source.events.includes(event));
  return (
    <Select
      value={value.length === 1 ? value[0] : null}
      onValueChange={event => event && !(value.length === 1 && value[0] === event) && onChange([event as IntakeRouteInfo['on'][number]])}
    >
      <SelectTrigger size="sm" aria-label={tk('intakeRoutes.whenKeyword')} className="w-fit">
        <Txt as="span" variant="caption" className="font-medium">
          {triggerLabel(value)}
        </Txt>
      </SelectTrigger>
      <SelectContent>
        {events.map(event => (
          <SelectItem key={event} value={event}>
            {triggerLabel([event])}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** «Звідки»: the source a route's cards come from. A stored route's source the Factory no longer uses stays, marked. */
function SourcePicker({
  value,
  origins,
  onChange,
}: {
  value: IntakeSourceDescriptor;
  origins: RouteOrigins;
  onChange: (source: IntakeSourceDescriptor) => void;
}) {
  const sources = origins.sources.list().filter(source => origins.available(source) || source.id === value.id);
  const describe = (source: IntakeSourceDescriptor) =>
    origins.available(source)
      ? sourceLabel(source, tk as never)
      : `${sourceLabel(source, tk as never)} (${tk('intakeRoutes.sourceNotConnected')})`;
  return (
    <Select
      value={value.id}
      onValueChange={id => {
        const next = id ? origins.sources.get(id) : undefined;
        if (next && next.id !== value.id) onChange(next);
      }}
    >
      <SelectTrigger size="sm" aria-label={tk('intakeRoutes.source')} className="w-fit">
        <Txt as="span" variant="caption" className="font-medium">
          {describe(value)}
        </Txt>
      </SelectTrigger>
      <SelectContent>
        {sources.map(source => (
          <SelectItem key={source.id} value={source.id}>
            {describe(source)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** A route's name, edited in place: Enter or leaving the field saves it, Escape puts it back. */
function RouteName({ name, onRename }: { name: string; onRename: (name: string) => void }) {
  // What is being typed, until it is saved or put back; the saved name shows otherwise.
  const [draft, setDraft] = useState<string>();
  const commit = () => {
    if (draft === undefined) return;
    setDraft(undefined);
    const next = draft.trim();
    if (next && next !== name) onRename(next);
  };
  return (
    <RuleCardTitleInput
      aria-label={tk('intakeRoutes.name')}
      value={draft ?? name}
      maxLength={120}
      onChange={event => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={event => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') setDraft(undefined);
      }}
    />
  );
}

/** A route's source and conditions, saved as soon as they are whole and valid. */
function RouteConditions({
  route,
  scope,
  options,
  origins,
  readOnly,
  needsOne,
  onSave,
}: {
  route: IntakeRouteInfo;
  scope: RouteScope;
  options: Record<string, FilterBarOption[]>;
  origins: RouteOrigins;
  readOnly: boolean;
  /** A new-card route with no conditions would take every new card, hiding the routes below it. */
  needsOne: boolean;
  onSave: (fields: Pick<RouteFields, 'when' | 'on'>) => void;
}) {
  const { source, rest } = splitWhen(route.when);
  const [problem, setProblem] = useState<string>();
  // The rows keep their own unfinished edits, so they only start over when the saved conditions change to
  // something these rows didn't write: an Undo, a source switched, or another admin's edit.
  const [seen, setSeen] = useState(() => json(route.when));
  const [written, setWritten] = useState(seen);
  const [resets, setResets] = useState(0);
  if (json(route.when) !== seen) {
    setSeen(json(route.when));
    if (json(route.when) !== written) {
      setWritten(json(route.when));
      setResets(resets + 1);
      setProblem(undefined);
    }
  }

  const sourceLine = source && (
    <RuleLine>
      <RuleLineKeyword>{tk('intakeRoutes.from')}</RuleLineKeyword>
      <RuleLineContent>
        {readOnly ? (
          <Badge size="sm">{sourceLabel(source, tk as never)}</Badge>
        ) : (
          <SourcePicker
            value={source}
            origins={origins}
            onChange={next => {
              const fields = sourceFields(next);
              const kept = fields ? pruneRule(rest, new Set(fields)) : rest;
              const when = joinWhen(next, kept);
              // A card move keeps waiting for an event its new source sends.
              const on =
                scope.kind === 'moves' && !route.on.every(event => next.events.includes(event))
                  ? [MOVE_EVENTS.find(event => next.events.includes(event)) ?? route.on[0]!]
                  : undefined;
              const problemNow = whenProblem(on ?? route.on, when);
              if (problemNow || (needsOne && when === null)) return setProblem(problemNow);
              setWritten(json(when));
              onSave({ when, ...(on ? { on } : {}) });
            }}
          />
        )}
      </RuleLineContent>
    </RuleLine>
  );

  if (readOnly) {
    return (
      <RuleLines>
        {sourceLine}
        <RuleLine>
          <RuleLineKeyword>{tk('conditions.where')}</RuleLineKeyword>
          <RuleLineContent>
            <ConditionChips rule={rest} options={options} fallback={tk('intakeRoutes.everyCard')} />
          </RuleLineContent>
        </RuleLine>
      </RuleLines>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      {sourceLine && <RuleLines>{sourceLine}</RuleLines>}
      <ConditionRows
        key={resets}
        label={tk('intakeRoutes.conditionsOf', { name: route.name })}
        rule={rest}
        facts={factsFor(intakeRouteFacts(route.on), sourceFields(source))}
        limits={sourceLimits(source)}
        options={options}
        emptyHint={needsOne && (!source || source.id === 'any') ? tk('intakeRoutes.addAtLeastOne') : tk('intakeRoutes.matchesEveryCard')}
        onChange={(next, incomplete) => {
          const when = joinWhen(source, next);
          // An empty new-card route isn't saved, and the empty rows already say why.
          if (incomplete || (needsOne && when === null)) return setProblem(undefined);
          const nextProblem = whenProblem(route.on, when);
          setProblem(nextProblem);
          if (nextProblem || json(when) === json(route.when)) return;
          setWritten(json(when));
          onSave({ when });
        }}
      />
      {problem && (
        <Txt as="p" variant="caption" className="text-destructive-foreground" role="alert">
          {problem}
        </Txt>
      )}
    </div>
  );
}

function RouteCard({
  route,
  scope,
  boards,
  origins,
  readOnly,
  isCatchAll,
  unreachable,
  step,
  grip,
  canMoveUp,
  canMoveDown,
  onUpdate,
  onRemove,
  onMove,
  onSendTo,
}: {
  route: IntakeRouteInfo;
  scope: RouteScope;
  boards: InstalledBoardInfo[];
  origins: RouteOrigins;
  readOnly: boolean;
  isCatchAll: boolean;
  unreachable: boolean;
  step?: string;
  /** The drag handle, in the header's inset just before the route's step or name. */
  grip?: ReactNode;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onUpdate: (fields: RouteFields) => void;
  onRemove: () => void;
  onMove: (offset: -1 | 1) => void;
  onSendTo: (boardKey: string) => void;
}) {
  const { t } = useTranslation('settings');
  const board = boards.find(candidate => candidate.id === route.target.boardKey);
  const phaseKey = route.target.phaseKey ?? board?.initialPhase ?? '';
  const placesNew = placesNewCards(route);
  const setTarget = (target: Partial<IntakeRouteInfo['target']>) => onUpdate({ target: { ...route.target, ...target } });
  const name = routeName(route, t);
  const { source } = splitWhen(route.when);
  const joining = route.target.joinClosedIssue === true;
  // A route already joining keeps the switch whatever its conditions say now, so it can be turned off.
  const offersJoin =
    scope.kind === 'arrivals' && !readOnly && !isCatchAll && (joining || canJoinIssueCard(route.on, route.when));

  return (
    <RuleCard inactive={!route.enabled}>
      <RuleCardHeader>
        {grip}
        {step && <RuleCardStep>{step}</RuleCardStep>}
        {readOnly ? <RuleCardTitle>{name}</RuleCardTitle> : <RouteName name={name} onRename={next => onUpdate({ name: next })} />}
        <Switch
          aria-label={tk('intakeRoutes.enabledFor', { name })}
          checked={route.enabled}
          disabled={readOnly}
          onCheckedChange={enabled => onUpdate({ enabled })}
        />
        {!readOnly && (
          <DropdownMenu>
            <DropdownMenu.Trigger
              render={
                <Button variant="ghost" size="icon-sm" aria-label={tk('intakeRoutes.actionsFor', { name })}>
                  <MoreHorizontal />
                </Button>
              }
            />
            <DropdownMenu.Content align="end">
              <DropdownMenu.Item disabled={!canMoveUp} onClick={() => onMove(-1)}>
                <ArrowUp /> {tk('intakeRoutes.moveUpItem')}
              </DropdownMenu.Item>
              <DropdownMenu.Item disabled={!canMoveDown} onClick={() => onMove(1)}>
                <ArrowDown /> {tk('intakeRoutes.moveDownItem')}
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item variant="destructive" onClick={onRemove}>
                <Trash2 /> {tk('intakeRoutes.delete')}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu>
        )}
      </RuleCardHeader>
      {(scope.kind === 'moves' || !isCatchAll) && (
        <RuleCardBody>
          {scope.kind === 'moves' && (
            <RuleLine>
              <RuleLineKeyword>{tk('intakeRoutes.whenKeyword')}</RuleLineKeyword>
              <RuleLineContent>
                {readOnly ? (
                  <Badge size="sm">{triggerLabel(route.on)}</Badge>
                ) : (
                  <EventPicker value={route.on} source={source} onChange={on => onUpdate({ on })} />
                )}
              </RuleLineContent>
            </RuleLine>
          )}
          <RouteConditions
            key={route.on.join()}
            route={route}
            scope={scope}
            options={conditionOptions(board, origins)}
            origins={origins}
            readOnly={readOnly}
            needsOne={scope.kind === 'arrivals'}
            onSave={fields => onUpdate(fields)}
          />
        </RuleCardBody>
      )}
      {offersJoin && (
        <JoinIssueCard
          checked={joining}
          onChange={next => setTarget({ joinClosedIssue: next, phaseKey: phaseStillOffered(board, phaseKey, next) })}
        />
      )}
      <RuleCardOutcome label={destinationLabelFor(scope, joining)}>
        {readOnly ? (
          <Badge size="sm">
            {scope.kind === 'moves' && board ? (phaseName(board, phaseKey) ?? phaseKey) : describeTarget(route.target, boards, t)}
          </Badge>
        ) : (
          <>
            {scope.kind === 'arrivals' && (
              <>
                <BoardPicker
                  value={route.target.boardKey}
                  boards={boards}
                  label={isCatchAll ? tk('intakeRoutes.boardForNewCards') : tk('intakeRoutes.board')}
                  onChange={boardKey => {
                    if (isCatchAll) return onSendTo(boardKey);
                    const next = boards.find(candidate => candidate.id === boardKey);
                    if (next) setTarget({ boardKey, phaseKey: next.initialPhase });
                  }}
                />
                {board && (
                  <Txt as="span" variant="caption" tone="muted" aria-hidden>
                    ›
                  </Txt>
                )}
              </>
            )}
            {board && (
              <PhasePicker
                board={board}
                value={phaseKey}
                placesNew={placesNew}
                joining={joining}
                label={scope.kind === 'moves' ? tk('intakeRoutes.moveTo') : tk('intakeRoutes.phase')}
                onChange={next => setTarget({ phaseKey: next })}
              />
            )}
          </>
        )}
      </RuleCardOutcome>
      {unreachable && (
        <Txt as="p" variant="caption" tone="muted" className="pl-4">
          {tk('intakeRoutes.unreachable')}
        </Txt>
      )}
      {route.problems.map(problem => (
        <Notice key={problem} variant="warning">
          {tk('intakeRoutes.problem', { problem })}
        </Notice>
      ))}
    </RuleCard>
  );
}

/** A route being written: nothing is saved until it has a name, a destination and finished conditions. */
function NewRoute({
  scope,
  boards,
  origins,
  initialBoard,
  onAdd,
  onCancel,
}: {
  scope: RouteScope;
  boards: InstalledBoardInfo[];
  origins: RouteOrigins;
  initialBoard: InstalledBoardInfo | undefined;
  /** Resolves to whether the route was added. */
  onAdd: (route: NewRouteValue) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [source, setSource] = useState<IntakeSourceDescriptor>(() => INTAKE_SOURCES.get('any')!);
  const [on, setOn] = useState<IntakeRouteInfo['on']>(scope.kind === 'moves' ? ['work_item.closed'] : ['work_item.created']);
  const [rest, setRest] = useState<RuleGroup | null>(null);
  const [rowsKey, setRowsKey] = useState(0);
  const [incomplete, setIncomplete] = useState(false);
  const [boardKey, setBoardKey] = useState(initialBoard?.id ?? '');
  const board = boards.find(candidate => candidate.id === boardKey);
  const [phaseKey, setPhaseKey] = useState(
    scope.kind === 'moves' ? (scope.board.flow?.completed ?? scope.board.initialPhase) : (initialBoard?.initialPhase ?? ''),
  );
  const when = joinWhen(source, rest);
  const problem = whenProblem(on, when);
  const needsCondition = scope.kind === 'arrivals' && when === null;
  const [adding, setAdding] = useState(false);
  const [wantsJoin, setWantsJoin] = useState(false);
  const offersJoin = scope.kind === 'arrivals' && canJoinIssueCard(on, when);
  const joining = offersJoin && wantsJoin;
  // Leaving joining can leave a phase new cards can't land in picked.
  const targetPhase = scope.kind === 'arrivals' ? phaseStillOffered(board, phaseKey, joining) : phaseKey;
  const ready =
    !adding && name.trim() !== '' && board !== undefined && targetPhase !== '' && !incomplete && !problem && !needsCondition;
  const label = scope.kind === 'moves' ? tk('intakeRoutes.addMove') : tk('intakeRoutes.add');

  return (
    <RuleCard>
      <RuleCardHeader>
        <RuleCardStep>{tk('intakeRoutes.steps.new')}</RuleCardStep>
        <RuleCardTitleInput
          aria-label={tk('intakeRoutes.newName')}
          placeholder={scope.kind === 'moves' ? tk('intakeRoutes.nameMove') : tk('intakeRoutes.nameRoute')}
          autoFocus
          value={name}
          maxLength={120}
          onChange={event => setName(event.target.value)}
        />
      </RuleCardHeader>
      <RuleCardBody>
        {scope.kind === 'moves' && (
          <RuleLine>
            <RuleLineKeyword>{tk('intakeRoutes.whenKeyword')}</RuleLineKeyword>
            <RuleLineContent>
              <EventPicker value={on} source={source} onChange={setOn} />
            </RuleLineContent>
          </RuleLine>
        )}
        <RuleLines>
          <RuleLine>
            <RuleLineKeyword>{tk('intakeRoutes.from')}</RuleLineKeyword>
            <RuleLineContent>
              <SourcePicker
                value={source}
                origins={origins}
                onChange={next => {
                  const fields = sourceFields(next);
                  setRest(current => (fields ? pruneRule(current, new Set(fields)) : current));
                  setRowsKey(count => count + 1);
                  setSource(next);
                  if (!on.every(event => next.events.includes(event))) {
                    setOn([MOVE_EVENTS.find(event => next.events.includes(event)) ?? 'work_item.closed']);
                  }
                }}
              />
            </RuleLineContent>
          </RuleLine>
        </RuleLines>
        <ConditionRows
          key={rowsKey}
          label={tk('intakeRoutes.newConditions')}
          rule={rest}
          facts={factsFor(intakeRouteFacts(on), sourceFields(source))}
          limits={sourceLimits(source)}
          options={conditionOptions(board, origins)}
          emptyHint={needsCondition ? tk('intakeRoutes.addAtLeastOne') : tk('intakeRoutes.matchesEveryCard')}
          onChange={(next, unfinished) => {
            setRest(next);
            setIncomplete(unfinished);
          }}
        />
        {problem && !incomplete && (
          <Txt as="p" variant="caption" className="text-destructive-foreground" role="alert">
            {problem}
          </Txt>
        )}
      </RuleCardBody>
      {offersJoin && <JoinIssueCard checked={wantsJoin} onChange={setWantsJoin} />}
      <RuleCardOutcome label={destinationLabelFor(scope, joining)}>
        {scope.kind === 'arrivals' && (
          <>
            <BoardPicker
              value={boardKey}
              boards={boards}
              label={tk('intakeRoutes.board')}
              onChange={key => {
                setBoardKey(key);
                setPhaseKey(boards.find(candidate => candidate.id === key)?.initialPhase ?? '');
              }}
            />
            <Txt as="span" variant="caption" tone="muted" aria-hidden>
              ›
            </Txt>
          </>
        )}
        {board && (
          <PhasePicker
            board={board}
            value={targetPhase}
            placesNew={scope.kind === 'arrivals'}
            joining={joining}
            label={scope.kind === 'moves' ? tk('intakeRoutes.moveTo') : tk('intakeRoutes.phase')}
            onChange={setPhaseKey}
          />
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {tk('intakeRoutes.cancel')}
          </Button>
          <Button
            size="sm"
            disabled={!ready}
            onClick={async () => {
              if (!board) return;
              setAdding(true);
              const added = await onAdd({
                name: name.trim(),
                on,
                when,
                target: { boardKey: board.id, phaseKey: targetPhase, joinClosedIssue: joining },
              });
              // An added route closes this form; a failed one leaves it to try again.
              if (!added) setAdding(false);
            }}
          >
            {label}
          </Button>
        </div>
      </RuleCardOutcome>
    </RuleCard>
  );
}

/**
 * One scope's routes in the order they are tried, edited in place. The project keeps one ordered list; this
 * shows the scope's share of it, and moving a route only trades places within that share.
 */
function RouteList({ factoryId, scope, boards }: { factoryId: string; scope: RouteScope; boards: InstalledBoardInfo[] }) {
  const query = useIntakeRoutesQuery(factoryId);
  const readOnly = useIntakeRoutesCanEditQuery(factoryId).data !== true;
  const origins = useIntakeOrigins(factoryId);
  const { latest, show, save, failures } = useRouteSaves(factoryId);
  const [adding, setAdding] = useState(false);
  const routes = (query.data ?? []).filter(route => inScope(route, scope));
  const defaultBoard = boards.find(board => board.id === DEFAULT_BOARD_ID) ?? boards[0];
  // Routes apply in order, so the first route taking every new card is the one that places them.
  const catchAll = scope.kind === 'arrivals' ? routes.find(catchesEveryArrival) : undefined;
  const catchAllAt = catchAll ? routes.indexOf(catchAll) : -1;
  // Routes after the catch-all never run, and the catch-all itself stays last.
  const lastMovable = catchAllAt >= 0 ? catchAllAt - 1 : routes.length - 1;
  // With no route taking every new card, the leftovers land on the default board's first phase.
  const fallback = scope.kind === 'arrivals' && !catchAll ? defaultBoard : undefined;

  const update = (
    route: IntakeRouteInfo,
    fields: RouteFields,
    message = updateMessage(fields),
    undoable = true,
  ) => {
    const previous = previousOf(route, fields);
    const apply = () => show(all => all.map(entry => (entry.id === route.id ? { ...entry, ...fields } : entry)));
    apply();
    save(async send => {
      const revision = latest().find(entry => entry.id === route.id)?.revision;
      if (revision === undefined) throw routesChanged();
      apply();
      await send([{ kind: 'update', id: route.id, patch: { ...fields, expectedRevision: revision } }]);
      announce(route.id, message, undoable ? () => update(route, previous, tk('intakeRoutes.undone'), false) : undefined);
    });
  };

  const reorder = (order: string[], message: string, undo?: string[]) => {
    const apply = () => show(all => order.flatMap(id => all.filter(entry => entry.id === id)));
    apply();
    save(async send => {
      const current = latest();
      if (current.length !== order.length || current.some(entry => !order.includes(entry.id))) throw routesChanged();
      apply();
      await send([{ kind: 'reorder', ids: order }]);
      announce('order', message, undo ? () => reorder(undo, tk('intakeRoutes.orderRestored')) : undefined);
    });
  };

  const move = (from: number, to: number) => {
    const route = routes[from];
    if (!route || to < 0 || to >= routes.length) return;
    const all = latest();
    const order = reorderWithin(
      all,
      routes.map(entry => entry.id),
      from,
      to,
    );
    reorder(
      order,
      tk('intakeRoutes.moved', { name: route.name, position: to + 1 }),
      all.map(entry => entry.id),
    );
  };

  const remove = (route: IntakeRouteInfo) => removeRoute(route, { latest, show, save });

  const sendTo = (boardKey: string) =>
    save(async send => {
      const before = latest().find(catchesEveryArrival);
      const created = await send(sendNewCardsTo(latest(), boards, boardKey));
      const board = boards.find(candidate => candidate.id === boardKey);
      announce('catch-all', tk('intakeRoutes.newCardsNowGoTo', { board: board ? boardName(board) : boardKey }), () =>
        unsendTo(before, created),
      );
    });

  /**
   * Points the catch-all back where it was and deletes the routes sending new cards elsewhere
   * created. Deleting a route renumbers every route below it, so the copies go last-first: removing
   * the lowest one moves nothing, and the revisions read up front stay current.
   */
  const unsendTo = (before: IntakeRouteInfo | undefined, created: IntakeRouteInfo[]) =>
    save(async send => {
      const current = latest();
      const revisionOf = (route: IntakeRouteInfo) => current.find(entry => entry.id === route.id)?.revision ?? route.revision;
      const positionOf = (route: IntakeRouteInfo) => current.findIndex(entry => entry.id === route.id);
      const lastFirst = created.toSorted((a, b) => positionOf(b) - positionOf(a));
      await send([
        ...(before
          ? [
              {
                kind: 'update' as const,
                id: before.id,
                patch: { name: before.name, target: before.target, expectedRevision: revisionOf(before) },
              },
            ]
          : []),
        ...lastFirst.map(route => ({ kind: 'delete' as const, id: route.id, expectedRevision: revisionOf(route) })),
      ]);
      announce('catch-all', tk('intakeRoutes.undone'));
    });

  const add = (route: NewRouteValue) =>
    save(async send => {
      const [created] = await send([
        {
          kind: 'create',
          route: {
            name: route.name,
            enabled: true,
            when: route.when,
            ...(scope.kind === 'moves' ? { on: route.on } : {}),
            target: {
              boardKey: route.target.boardKey,
              phaseKey: route.target.phaseKey,
              ...(route.target.joinClosedIssue ? { joinClosedIssue: true } : {}),
            },
          },
        },
      ]);
      setAdding(false);
      announce('new', tk('intakeRoutes.added', { name: route.name }), created ? () => remove(created) : undefined);
    });

  const drag = useRowDrag({ min: 0, max: Math.max(lastMovable, 0), onDrop: move });

  if (query.isPending) return <SkeletonRows label={tk('intakeRoutes.loading')} rows={2} />;
  if (query.error) {
    return (
      <Txt tone="muted" as="p" variant="caption">
        {tk('intakeRoutes.unavailable')}
      </Txt>
    );
  }

  const arrivals = scope.kind === 'arrivals';
  const noun = arrivals ? tk('intakeRoutes.listLabel') : tk('intakeRoutes.movesListLabel');

  return (
    <div className="flex flex-col gap-4">
      {readOnly && <Notice variant="info">{arrivals ? tk('intakeRoutes.readOnly') : tk('intakeRoutes.movesReadOnly')}</Notice>}
      {routes.length === 0 && scope.kind === 'moves' && !adding && (
        <Txt as="p" variant="caption" tone="muted">
          {tk('intakeRoutes.noMoves')}
        </Txt>
      )}
      {(routes.length > 0 || fallback) && (
        <ol className="flex flex-col gap-5" aria-label={noun}>
          {routes.map((route, index) => {
            const sortable = !readOnly && index <= lastMovable && lastMovable > 0;
            const dragging = drag.drag?.from === index;
            return (
              <li
                // A failed save remounts the cards so their name and condition editors drop the rejected input.
                key={`${route.id}-${failures}`}
                data-drop={drag.dropAt(index)}
                className={cn('relative', DROP_LINE, dragging && 'z-10')}
                style={dragging ? { transform: `translateY(${drag.drag?.offset ?? 0}px)` } : undefined}
                onPointerDown={sortable ? event => drag.onPointerDown(event, index) : undefined}
              >
                <RouteCard
                  route={route}
                  scope={scope}
                  boards={boards}
                  origins={origins}
                  readOnly={readOnly}
                  isCatchAll={index === catchAllAt}
                  unreachable={catchAllAt >= 0 && index > catchAllAt}
                  step={arrivals ? stepLabel(index, catchAllAt) : undefined}
                  grip={
                    sortable && (
                      <RuleCardDragHandle
                        data-grip
                        aria-label={tk('intakeRoutes.reorder', { name: route.name })}
                        onKeyDown={event => drag.onKeyDown(event, index)}
                      />
                    )
                  }
                  canMoveUp={!readOnly && index > 0 && index !== catchAllAt}
                  canMoveDown={!readOnly && index < lastMovable}
                  onUpdate={fields => update(route, fields)}
                  onRemove={() => remove(route)}
                  onMove={offset => move(index, index + offset)}
                  onSendTo={sendTo}
                />
              </li>
            );
          })}
          {fallback && (
            <li className="flex flex-wrap items-center gap-2 pl-4">
              <RuleCardStep>{tk('intakeRoutes.steps.otherwise')}</RuleCardStep>
              <Txt as="span" variant="caption" tone="muted">
                {tk('intakeRoutes.everythingElse')}
              </Txt>
              {readOnly ? (
                <Badge size="sm">
                  {boardName(fallback)} › {phaseName(fallback, fallback.initialPhase) ?? fallback.initialPhase}
                </Badge>
              ) : (
                <>
                  <BoardPicker value={fallback.id} boards={boards} label={tk('intakeRoutes.boardForNewCards')} onChange={sendTo} />
                  <Txt as="span" variant="caption" tone="muted" aria-hidden>
                    ›
                  </Txt>
                  <PhaseLabel board={fallback} phaseKey={fallback.initialPhase} />
                </>
              )}
            </li>
          )}
        </ol>
      )}
      {!readOnly &&
        (adding ? (
          <div role="group" aria-label={scope.kind === 'moves' ? tk('intakeRoutes.newMove') : tk('intakeRoutes.newTitle')}>
            <NewRoute
              scope={scope}
              boards={boards}
              origins={origins}
              initialBoard={scope.kind === 'moves' ? scope.board : defaultBoard}
              onAdd={add}
              onCancel={() => setAdding(false)}
            />
          </div>
        ) : (
          <div className="pl-4">
            <RuleAddButton icon={<Plus />} onClick={() => setAdding(true)}>
              {scope.kind === 'moves' ? tk('intakeRoutes.addMove') : tk('intakeRoutes.add')}
            </RuleAddButton>
          </div>
        ))}
    </div>
  );
}

type RouteSaves = Pick<ReturnType<typeof useRouteSaves>, 'latest' | 'show' | 'save'>;

/** Deletes a route at once; Undo makes it again where it was (the server has no restore). */
function removeRoute(route: IntakeRouteInfo, { latest, show, save }: RouteSaves) {
  const order = latest().map(entry => entry.id);
  const hide = () => show(all => all.filter(entry => entry.id !== route.id));
  hide();
  save(async send => {
    const revision = latest().find(entry => entry.id === route.id)?.revision ?? route.revision;
    hide();
    await send([{ kind: 'delete', id: route.id, expectedRevision: revision }]);
    announce(route.id, tk('intakeRoutes.deletedNamed', { name: route.name }), () =>
      save(async again => {
        const [created] = await again([{ kind: 'create', route: draftOf(route) }]);
        if (!created) return;
        const ids = latest().map(entry => entry.id);
        const back = order.map(id => (id === route.id ? created.id : id)).filter(id => ids.includes(id));
        await again([{ kind: 'reorder', ids: [...back, ...ids.filter(id => !back.includes(id))] }]);
        announce(route.id, tk('intakeRoutes.restored', { name: route.name }));
      }),
    );
  });
}

/** Why a run was refused, in the reader's language when the server said which refusal it was. */
const RUN_REFUSALS: Record<string, string> = {
  intake_route_disabled: 'intakeTriggers.run.disabled',
  intake_route_not_scheduled: 'intakeTriggers.run.notScheduled',
  organization_admin_required: 'intakeTriggers.run.adminOnly',
};

/**
 * The routes «За розкладом»: each makes its own cards on its own trigger, so it stays out of the order
 * arriving cards are tried in. Its fire history unfolds under it.
 */
function ScheduleList({ factoryId, boards }: { factoryId: string; boards: InstalledBoardInfo[] }) {
  const { t } = useTranslation('settings');
  const query = useIntakeRoutesQuery(factoryId);
  const readOnly = useIntakeRoutesCanEditQuery(factoryId).data !== true;
  const kindsQuery = useIntakeTriggerKindsQuery(factoryId);
  const origins = useIntakeOrigins(factoryId);
  const saves = useRouteSaves(factoryId);
  const fire = useFireIntakeRouteMutation(factoryId);
  const navigate = useNavigate();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const routes = (query.data ?? []).filter(route => route.triggered);
  const triggerContext: IntakeKindFormContext = {
    factoryProjectId: factoryId,
    boards,
    placeholders: kindsQuery.data?.placeholders ?? [],
  };
  const canSchedule = (kindsQuery.data?.triggers.length ?? 0) > 0;
  if (routes.length === 0 && (readOnly || !canSchedule)) return null;

  const openCard = (route: IntakeRouteInfo, workItemId: string) => ({
    label: t('intakeTriggers.run.openCard'),
    onClick: () =>
      navigate(factoryAttentionTargetPath(factoryId, { kind: 'work-item', workItemId, board: route.target.boardKey })),
  });

  /** What a run did, said once: the card it filed, the open card that held it back, or why it failed. */
  const announceFire = (route: IntakeRouteInfo, result: IntakeRouteFireInfo) => {
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
      onSuccess: data => announceFire(route, data.fire),
      onError: error => {
        const refusal = error instanceof ApiRequestError && error.code ? RUN_REFUSALS[error.code] : undefined;
        toast.error(refusal ? t(refusal as never) : saveFailureMessage(error));
      },
    });

  const saveSchedule = (route: IntakeRouteInfo | undefined, draft: IntakeRouteDraft, run: boolean) =>
    saves.save(async send => {
      let saved: IntakeRouteInfo | undefined;
      if (route) {
        const revision = saves.latest().find(entry => entry.id === route.id)?.revision ?? route.revision;
        await send([{ kind: 'update', id: route.id, patch: { ...draft, expectedRevision: revision } }]);
        saved = route;
      } else {
        [saved] = await send([{ kind: 'create', route: draft }]);
      }
      setEditing(null);
      toast.success(t('intakeRoutes.saved'));
      if (run && saved) runNow(saved);
    });

  const rename = (route: IntakeRouteInfo, fields: Pick<RouteFields, 'name' | 'enabled'>) => {
    saves.show(all => all.map(entry => (entry.id === route.id ? { ...entry, ...fields } : entry)));
    saves.save(async send => {
      const revision = saves.latest().find(entry => entry.id === route.id)?.revision ?? route.revision;
      await send([{ kind: 'update', id: route.id, patch: { ...fields, expectedRevision: revision } }]);
      announce(route.id, updateMessage(fields));
    });
  };

  return (
    <section className="flex flex-col gap-4" aria-label={t('intakeTriggers.schedulesLabel')}>
      <Txt as="h3" variant="subheading">
        {t('intakeTriggers.schedulesTitle')}
      </Txt>
      <Txt as="p" variant="caption" tone="muted">
        {t('intakeTriggers.schedulesHint')}
      </Txt>
      <ol className="flex flex-col gap-5" aria-label={t('intakeTriggers.schedulesLabel')}>
        {routes.map(route => {
          const name = routeName(route, t);
          if (editing === route.id) {
            return (
              <li key={route.id}>
                <ScheduleRouteEditor
                  initial={route}
                  boards={boards}
                  kinds={kindsQuery.data}
                  triggerContext={triggerContext}
                  busy={saves.pending}
                  onCancel={() => setEditing(null)}
                  onSave={draft => saveSchedule(route, draft, false)}
                  onSaveAndRun={draft => saveSchedule(route, draft, true)}
                />
              </li>
            );
          }
          return (
            <li key={`${route.id}-${saves.failures}`}>
              <RuleCard inactive={!route.enabled}>
                <RuleCardHeader>
                  {readOnly ? (
                    <RuleCardTitle>{name}</RuleCardTitle>
                  ) : (
                    <RouteName name={name} onRename={next => rename(route, { name: next })} />
                  )}
                  <Switch
                    aria-label={t('intakeRoutes.enabledFor', { name })}
                    checked={route.enabled}
                    disabled={readOnly}
                    onCheckedChange={enabled => rename(route, { enabled })}
                  />
                  {!readOnly && (
                    <DropdownMenu>
                      <DropdownMenu.Trigger
                        render={
                          <Button variant="ghost" size="icon-sm" aria-label={t('intakeRoutes.actionsFor', { name })}>
                            <MoreHorizontal />
                          </Button>
                        }
                      />
                      <DropdownMenu.Content align="end">
                        <DropdownMenu.Item disabled={fire.isPending} onClick={() => runNow(route)}>
                          <Play /> {t('intakeTriggers.run.runNow')}
                        </DropdownMenu.Item>
                        <DropdownMenu.Item disabled={editing !== null} onClick={() => setEditing(route.id)}>
                          <Pencil /> {t('intakeRoutes.edit')}
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator />
                        <DropdownMenu.Item variant="destructive" onClick={() => removeRoute(route, saves)}>
                          <Trash2 /> {t('intakeRoutes.delete')}
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu>
                  )}
                </RuleCardHeader>
                <RuleCardBody>
                  <RuleLine>
                    <RuleLineKeyword>{t('intakeRoutes.whenKeyword')}</RuleLineKeyword>
                    <RuleLineContent>
                      <Badge size="sm" emphasis="subtle">
                        {describeWhen(route, origins, t)}
                      </Badge>
                    </RuleLineContent>
                  </RuleLine>
                </RuleCardBody>
                <RuleCardOutcome label={t('intakeRoutes.sendTo')}>
                  <Badge size="sm">{describeTarget(route.target, boards, t)}</Badge>
                </RuleCardOutcome>
                <div className="pl-4">
                  <TriggerStatus
                    route={route}
                    factoryProjectId={factoryId}
                    open={history === route.id}
                    onToggle={() => setHistory(current => (current === route.id ? null : route.id))}
                  />
                </div>
                {route.problems.map(problem => (
                  <Notice key={problem} variant="warning">
                    {t('intakeRoutes.problem', { problem })}
                  </Notice>
                ))}
              </RuleCard>
            </li>
          );
        })}
      </ol>
      {!readOnly &&
        canSchedule &&
        (editing === 'new' ? (
          <ScheduleRouteEditor
            boards={boards}
            kinds={kindsQuery.data}
            triggerContext={triggerContext}
            busy={saves.pending}
            onCancel={() => setEditing(null)}
            onSave={draft => saveSchedule(undefined, draft, false)}
            onSaveAndRun={draft => saveSchedule(undefined, draft, true)}
          />
        ) : (
          <div className="pl-4">
            <RuleAddButton icon={<Plus />} disabled={editing !== null} onClick={() => setEditing('new')}>
              {t('intakeTriggers.addSchedule')}
            </RuleAddButton>
          </div>
        ))}
    </section>
  );
}

/**
 * Settings › Intake › where new cards go, for one Factory: one ordered list of rules, tried top to
 * bottom; the first match places the card. Then the routes «За розкладом», which make their own cards.
 */
export function IntakeRoutesSection({ factoryProjectId, factoryName }: { factoryProjectId: string; factoryName: string }) {
  const { t } = useTranslation('settings');
  const catalog = useBoardCatalog(factoryProjectId);
  const boards = catalog.data ?? [];
  return (
    <SettingsSubsection
      id={NEW_CARD_ROUTES_ANCHOR}
      scope="factory"
      title={t('intakeRoutes.title')}
      description={t('intakeRoutes.description', { name: factoryName })}
    >
      {catalog.isPending ? (
        <SkeletonRows label={t('intakeRoutes.loading')} rows={2} />
      ) : (
        <div className="flex flex-col gap-8">
          <RouteList factoryId={factoryProjectId} scope={{ kind: 'arrivals' }} boards={boards} />
          <ScheduleList factoryId={factoryProjectId} boards={boards} />
        </div>
      )}
    </SettingsSubsection>
  );
}

/** How cards already on one board move when their issue, task or pull request changes. */
export function CardMovesSection({ factoryId, boardId }: { factoryId: string; boardId: string }) {
  const catalog = useBoardCatalog(factoryId);
  const boards = catalog.data ?? [];
  const board = boards.find(candidate => candidate.id === boardId);
  if (catalog.isPending) return <SkeletonRows label={tk('intakeRoutes.movesLoading')} rows={2} />;
  if (!board) return <Notice variant="destructive">{tk('intakeRoutes.boardNotInstalled')}</Notice>;
  return <RouteList factoryId={factoryId} scope={{ kind: 'moves', board }} boards={boards} />;
}
