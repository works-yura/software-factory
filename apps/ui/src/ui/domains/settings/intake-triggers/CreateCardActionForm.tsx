import { Input } from '@mastra/playground-ui/components/Input';
import { Textarea } from '@mastra/playground-ui/components/Textarea';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';

import type { IntakeKindForm, IntakeKindFormProps } from './formRegistry';

function CreateCardFields({ config, onChange, disabled, context }: IntakeKindFormProps) {
  const { t } = useTranslation('settings');
  const set = (patch: Record<string, unknown>) => onChange({ ...config, ...patch });

  return (
    <div className="flex flex-col gap-2">
      <Input
        size="sm"
        aria-label={t('intakeTriggers.card.title')}
        placeholder={t('intakeTriggers.card.titlePlaceholder')}
        value={typeof config.titleTemplate === 'string' ? config.titleTemplate : ''}
        disabled={disabled}
        onChange={event => set({ titleTemplate: event.target.value })}
      />
      <Textarea
        aria-label={t('intakeTriggers.card.description')}
        placeholder={t('intakeTriggers.card.descriptionPlaceholder')}
        rows={4}
        value={typeof config.description === 'string' ? config.description : ''}
        disabled={disabled}
        onChange={event => set({ description: event.target.value })}
      />
      <Input
        size="sm"
        aria-label={t('intakeTriggers.card.repository')}
        placeholder={t('intakeTriggers.card.repositoryPlaceholder')}
        value={typeof config.repository === 'string' ? config.repository : ''}
        disabled={disabled}
        onChange={event => set({ repository: event.target.value.trim() ? event.target.value : null })}
      />
      {context.placeholders.length > 0 && (
        <Txt as="p" variant="caption" tone="muted">
          {t('intakeTriggers.card.placeholders', { list: context.placeholders.join(' ') })}
        </Txt>
      )}
    </div>
  );
}

/** The card each fire files; where it lands is the route's own target. */
export const createCardActionForm: IntakeKindForm = {
  kind: 'create-card',
  defaultConfig: () => ({ titleTemplate: '', description: '', repository: null }),
  ready: config => typeof config.titleTemplate === 'string' && config.titleTemplate.trim().length > 0,
  Form: CreateCardFields,
};
