import { Input } from '@mastra/playground-ui/components/Input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { Textarea } from '@mastra/playground-ui/components/Textarea';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';

import { phaseTitle } from '../../../i18n/boardLabels';
import { BoardSelect } from '../components/RoutingSelects';
import type { IntakeKindForm, IntakeKindFormProps } from './formRegistry';

const FIRST_PHASE = '__first_phase__';

function CreateCardFields({ config, onChange, disabled, context }: IntakeKindFormProps) {
  const { t } = useTranslation('settings');
  const boardKey = typeof config.boardKey === 'string' ? config.boardKey : null;
  const phaseKey = typeof config.phaseKey === 'string' ? config.phaseKey : null;
  const board = context.boards.find(candidate => candidate.id === boardKey);
  // A new card can't land in a terminal phase; the server refuses it too.
  const phases = (board?.phases ?? []).filter(phase => phase.kind !== 'terminal');
  const set = (patch: Record<string, unknown>) => onChange({ ...config, ...patch });
  const phaseName = (id: string) => {
    const phase = phases.find(candidate => candidate.id === id);
    return phaseTitle(boardKey ?? '', id, phase?.name ?? phase?.title ?? id);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <BoardSelect
          ariaLabel={t('intakeRules.card.board')}
          value={boardKey}
          placeholder={t('intakeRules.card.chooseBoard')}
          boards={context.boards}
          disabled={disabled}
          onChange={next => set({ boardKey: next, phaseKey: null })}
        />
        <Select
          value={phaseKey ?? FIRST_PHASE}
          disabled={disabled || !board}
          onValueChange={next => set({ phaseKey: next === FIRST_PHASE ? null : next })}
        >
          <SelectTrigger size="sm" aria-label={t('intakeRules.card.phase')} className="w-auto">
            <Txt as="span" variant="caption">
              {phaseKey ? phaseName(phaseKey) : t('intakeRules.card.firstPhase')}
            </Txt>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={FIRST_PHASE}>{t('intakeRules.card.firstPhase')}</SelectItem>
            {phases.map(phase => (
              <SelectItem key={phase.id} value={phase.id}>
                {phaseName(phase.id)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Input
        size="sm"
        aria-label={t('intakeRules.card.title')}
        placeholder={t('intakeRules.card.titlePlaceholder')}
        value={typeof config.titleTemplate === 'string' ? config.titleTemplate : ''}
        disabled={disabled}
        onChange={event => set({ titleTemplate: event.target.value })}
      />
      <Textarea
        aria-label={t('intakeRules.card.description')}
        placeholder={t('intakeRules.card.descriptionPlaceholder')}
        rows={4}
        value={typeof config.description === 'string' ? config.description : ''}
        disabled={disabled}
        onChange={event => set({ description: event.target.value })}
      />
      <Input
        size="sm"
        aria-label={t('intakeRules.card.repository')}
        placeholder={t('intakeRules.card.repositoryPlaceholder')}
        value={typeof config.repository === 'string' ? config.repository : ''}
        disabled={disabled}
        onChange={event => set({ repository: event.target.value.trim() ? event.target.value : null })}
      />
      {context.placeholders.length > 0 && (
        <Txt as="p" variant="caption" tone="muted">
          {t('intakeRules.card.placeholders', { list: context.placeholders.join(' ') })}
        </Txt>
      )}
    </div>
  );
}

export const createCardActionForm: IntakeKindForm = {
  kind: 'create-card',
  defaultConfig: context => ({
    boardKey: context.boards.some(board => board.id === 'audits') ? 'audits' : (context.boards[0]?.id ?? null),
    phaseKey: context.boards.some(board => board.id === 'audits') ? 'analysis' : null,
    titleTemplate: '',
    description: '',
    repository: null,
  }),
  ready: config =>
    typeof config.boardKey === 'string' && typeof config.titleTemplate === 'string' && config.titleTemplate.trim().length > 0,
  Form: CreateCardFields,
};
