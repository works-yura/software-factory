import { Button } from '@mastra/playground-ui/components/Button';
import { Input } from '@mastra/playground-ui/components/Input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { InstalledBoardInfo, IntakeRouteInfo, IntakeTriggerKindsInfo } from '../../../../api/types';
import type { IntakeRouteDraft, IntakeRouteTriggeredDraft } from '../../../../hooks/useIntakeRoutes';

import '../intake-triggers/builtinForms';
import type { IntakeKindFormContext } from '../intake-triggers/formRegistry';
import { defaultTriggeredDraft, TriggerFields, triggeredReady } from '../intake-triggers/TriggerFields';

import { BoardSelect } from './RoutingSelects';

/** The phase choice that leaves the route's board at its first phase. */
const FIRST_PHASE = '__first_phase__';

/**
 * The editor of one route «За розкладом»: its name, its own trigger, what each fire does and the
 * overlap policy, and where its cards go. Routes that place arriving cards are edited in place in the
 * route list instead; a route made by its schedule tests nothing that arrives, so it has no conditions.
 */
export function ScheduleRouteEditor({
  initial,
  boards,
  kinds,
  triggerContext,
  busy,
  onSave,
  onSaveAndRun,
  onCancel,
}: {
  initial?: IntakeRouteInfo;
  boards: InstalledBoardInfo[];
  /** The kinds a route «За розкладом» can use; unset while they load. */
  kinds: IntakeTriggerKindsInfo | undefined;
  triggerContext: IntakeKindFormContext;
  busy: boolean;
  onSave: (draft: IntakeRouteDraft) => void;
  /** «Зберегти й запустити»: save it, then fire it once now. */
  onSaveAndRun: (draft: IntakeRouteDraft) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('settings');
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
  const [boardKey, setBoardKey] = useState<string | null>(initial?.target.boardKey ?? null);
  const [phaseKey, setPhaseKey] = useState<string | null>(initial?.target.phaseKey ?? null);

  const board = boards.find(candidate => candidate.id === boardKey);
  // A card can't be filed into a terminal phase; the server refuses it too.
  const phases = (board?.phases ?? []).filter(phase => phase.kind !== 'terminal');
  const label = initial ? t('intakeRoutes.editTitle', { name: initial.name }) : t('intakeTriggers.newSchedule');
  const ready = Boolean(name.trim() && boardKey && triggeredDraft && triggeredReady(triggeredDraft));

  const draft = (): IntakeRouteDraft => ({
    name: name.trim(),
    enabled: initial?.enabled ?? true,
    when: null,
    target: { boardKey: boardKey!, phaseKey },
    triggered: triggeredDraft!,
  });

  return (
    <form
      aria-label={label}
      className="flex flex-col gap-3 rounded-md border border-border1 px-3 py-3"
      onSubmit={event => {
        event.preventDefault();
        if (ready) onSave(draft());
      }}
    >
      <Input
        size="sm"
        aria-label={t('intakeRoutes.name')}
        placeholder={t('intakeTriggers.namePlaceholder')}
        value={name}
        disabled={busy}
        onChange={event => setName(event.target.value)}
      />
      {!initial && (
        <Txt as="p" variant="caption" tone="muted">
          {t('intakeTriggers.modeHint')}
        </Txt>
      )}
      {kinds && triggeredDraft && (
        <TriggerFields kinds={kinds} context={triggerContext} value={triggeredDraft} onChange={setTriggered} disabled={busy} />
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
        <Button type="button" size="sm" variant="ghost" disabled={busy || !ready} onClick={() => onSaveAndRun(draft())}>
          {t('intakeTriggers.run.saveAndRun')}
        </Button>
        <Button type="submit" size="sm" variant="primary" disabled={busy || !ready}>
          {t('intakeRoutes.save')}
        </Button>
      </div>
    </form>
  );
}
