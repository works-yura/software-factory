import type { IntakeSourceDescriptor } from '@factory/core/boards/intake-sources';

import { Button } from '@mastra/playground-ui/components/Button';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';

import { Txt } from '@mastra/playground-ui/components/Txt';
import { X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { InstalledBoardInfo, IntakeRouteInfo } from '../../../../api/types';

import { useClickUpListStatusesQuery } from '../../../../hooks/useClickUp';

import type { IntakeRouteDraft, IntakeRouteTriggeredDraft } from '../../../../hooks/useIntakeRoutes';
import type { IntakeTriggerKindsInfo } from '../../../../api/types';

import '../intake-triggers/builtinForms';
import type { IntakeKindFormContext } from '../intake-triggers/formRegistry';
import { defaultTriggeredDraft, TriggerFields, triggeredReady } from '../intake-triggers/TriggerFields';

import {
  chooseRouteSource,
  conditionFieldsFor,
  defaultCondition,
  eventsForSource,
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

import {
  IntakeOrigins,
  eventLabel,
  fieldLabel,
  originLabel,
  sourceLabel,
} from './intakeRouteLabels';

/** «Коли» of a route: a source its cards arrive from, or a schedule of its own. */
/**
 * The editor of one intake route: «Коли» (a source and its events, or a schedule of the route's own),
 * the conditions that source offers, and where the card goes.
 */

/** The phase choice that leaves the route's board at its first phase. */
const FIRST_PHASE = '__first_phase__';

const SCHEDULE = '__schedule__';

const sameEvents = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every(event => b.includes(event));

export function RouteEditor({
  initial,
  boards,
  origins,
  kinds,
  triggerContext,
  busy,
  onSave,
  onSaveAndRun,
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
  /** «Зберегти й запустити» on a route «За розкладом»: save it, then fire it once now. */
  onSaveAndRun?: (draft: IntakeRouteDraft) => void;
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
    initial && !initial.triggered ? readRouteWhen(origins.sources, initial.when) : undefined;
  const custom = Boolean(initial && !initial.triggered && !readable);
  const [model, setModel] = useState<RouteWhenModel>(() => {
    if (readable) return readable;
    return { source: origins.sources.get('any')!, closeReason: null, conditions: [] };
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
  const sources = origins.sources.list().filter(source => origins.available(source) || source.id === model.source.id);
  const sourceUnused = !scheduled && !origins.available(model.source);
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
    const source = origins.sources.get(value);
    if (!source) return;
    setModel(current => chooseRouteSource(current, source));
    setEvents(current => eventsForSource(source, current));
  };
  const toggleEvent = (event: string) =>
    setEvents(current => {
      const next = current.includes(event) ? current.filter(value => value !== event) : [...current, event];
      return model.source.events.filter(value => next.includes(value));
    });

  const draft = (): IntakeRouteDraft => {
    if (scheduled) {
      return {
        name: name.trim(),
        enabled: initial?.enabled ?? true,
        when: null,
        target: { boardKey: boardKey!, phaseKey },
        triggered: triggeredDraft!,
      };
    }
    const closes = events.includes('work_item.closed');
    return {
      name: name.trim(),
      enabled: initial?.enabled ?? true,
      // Unchanged events are sent as stored, so saving an untouched route leaves it as it was.
      ...(eventsEditable ? { on: initial && sameEvents(events, initialOn) ? [...initialOn] : events } : {}),
      when: custom ? initial!.when : writeRouteWhen(closes ? model : { ...model, closeReason: null }),
      // The server replaces a route's target whole, so a joining route stays a joining one.
      target: { boardKey: boardKey!, phaseKey, joinClosedIssue: initial?.target.joinClosedIssue ?? false },
    };
  };
  const save = () => onSave(draft());
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
        {scheduled && onSaveAndRun && (
          <Button type="button" size="sm" variant="ghost" disabled={busy || !ready} onClick={() => onSaveAndRun(draft())}>
            {t('intakeTriggers.run.saveAndRun')}
          </Button>
        )}
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
