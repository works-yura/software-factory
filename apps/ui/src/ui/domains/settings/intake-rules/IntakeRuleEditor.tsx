import { Button } from '@mastra/playground-ui/components/Button';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { IntakeRuleInfo, IntakeRuleKindsInfo } from '../../../../api/types';
import { useIntakeTriggerPreview } from '../../../../hooks/useIntakeRules';
import type { IntakeKindDraft, IntakeRuleDraft } from '../../../../hooks/useIntakeRules';
import { currentLanguage } from '../../../i18n';
import { intakeActionForm, intakeTriggerForm } from './formRegistry';
import type { IntakeKindForm, IntakeKindFormContext } from './formRegistry';

type Listing = IntakeRuleKindsInfo['triggers'][number];

/** One side of a rule (trigger or action): a kind select over the kinds both the server and this UI know, and that kind's form. */
function KindSection({
  title,
  selectLabel,
  kinds,
  formFor,
  draft,
  onChange,
  disabled,
  context,
}: {
  title: string;
  selectLabel: string;
  kinds: Listing[];
  formFor: (kind: string) => IntakeKindForm | undefined;
  draft: IntakeKindDraft;
  onChange: (draft: IntakeKindDraft) => void;
  disabled: boolean;
  context: IntakeKindFormContext;
}) {
  const { t } = useTranslation('settings');
  const editable = kinds.filter(kind => formFor(kind.kind));
  const form = formFor(draft.kind);
  const label = kinds.find(kind => kind.kind === draft.kind)?.label ?? draft.kind;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Txt as="span" variant="caption" tone="muted">
          {title}
        </Txt>
        <Select
          value={draft.kind}
          disabled={disabled}
          onValueChange={next => onChange({ kind: next, config: formFor(next)!.defaultConfig(context) })}
        >
          <SelectTrigger size="sm" aria-label={selectLabel} className="w-auto">
            <Txt as="span" variant="caption">
              {label}
            </Txt>
          </SelectTrigger>
          <SelectContent>
            {editable.map(kind => (
              <SelectItem key={kind.kind} value={kind.kind}>
                {kind.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {form ? (
        <form.Form config={draft.config} onChange={config => onChange({ ...draft, config })} disabled={disabled} context={context} />
      ) : (
        <Notice variant="info">{t('intakeRules.kindNotEditable', { kind: draft.kind })}</Notice>
      )}
    </div>
  );
}

function TriggerPreview({ factoryProjectId, trigger }: { factoryProjectId: string; trigger: IntakeKindDraft }) {
  const { t } = useTranslation('settings');
  const preview = useIntakeTriggerPreview(factoryProjectId, trigger);
  const data = preview.data;
  if (!data) return null;
  if (data.problems.length > 0) {
    return (
      <Txt as="p" variant="caption" tone="muted" role="alert">
        {data.problems.join(' ')}
      </Txt>
    );
  }
  const format = new Intl.DateTimeFormat(currentLanguage(), { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <div aria-label={t('intakeRules.preview')} className="flex flex-col gap-0.5">
      <Txt as="p" variant="caption" tone="ink">
        {data.summary}
      </Txt>
      {data.nextFires.length > 0 && (
        <Txt as="p" variant="caption" tone="muted">
          {t('intakeRules.nextFires', { list: data.nextFires.map(at => format.format(new Date(at))).join(' · ') })}
        </Txt>
      )}
    </div>
  );
}

/** The generic rule editor: name, trigger, action and overlap policy, each kind's own form from the registry. */
export function IntakeRuleEditor({
  initial,
  kinds,
  context,
  busy,
  onSave,
  onCancel,
}: {
  initial?: IntakeRuleInfo;
  kinds: IntakeRuleKindsInfo;
  context: IntakeKindFormContext;
  busy: boolean;
  onSave: (draft: IntakeRuleDraft) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('settings');
  const firstTrigger = kinds.triggers.find(kind => intakeTriggerForm(kind.kind))?.kind;
  const firstAction = kinds.actions.find(kind => intakeActionForm(kind.kind))?.kind;
  const [name, setName] = useState(initial?.name ?? '');
  const [trigger, setTrigger] = useState<IntakeKindDraft>(
    initial
      ? { kind: initial.trigger.kind, config: initial.trigger.config }
      : { kind: firstTrigger ?? '', config: (firstTrigger && intakeTriggerForm(firstTrigger)?.defaultConfig(context)) || {} },
  );
  const [action, setAction] = useState<IntakeKindDraft>(
    initial
      ? { kind: initial.action.kind, config: initial.action.config }
      : { kind: firstAction ?? '', config: (firstAction && intakeActionForm(firstAction)?.defaultConfig(context)) || {} },
  );
  const [policy, setPolicy] = useState(initial?.policy.kind ?? kinds.policies[0]?.kind ?? 'skip-if-open');
  const label = initial ? t('intakeRules.editTitle', { name: initial.name }) : t('intakeRules.newTitle');
  const triggerForm = intakeTriggerForm(trigger.kind);
  const actionForm = intakeActionForm(action.kind);
  const ready = !!name.trim() && !!triggerForm?.ready(trigger.config) && !!actionForm?.ready(action.config);

  return (
    <form
      aria-label={label}
      className="flex flex-col gap-3 rounded-md border border-border1 px-3 py-3"
      onSubmit={event => {
        event.preventDefault();
        if (ready) onSave({ name: name.trim(), enabled: initial?.enabled ?? true, trigger, action, policy: { kind: policy } });
      }}
    >
      <Input
        size="sm"
        aria-label={t('intakeRules.name')}
        placeholder={t('intakeRules.namePlaceholder')}
        value={name}
        disabled={busy}
        onChange={event => setName(event.target.value)}
      />
      <KindSection
        title={t('intakeRules.when')}
        selectLabel={t('intakeRules.triggerKind')}
        kinds={kinds.triggers}
        formFor={intakeTriggerForm}
        draft={trigger}
        onChange={setTrigger}
        disabled={busy}
        context={context}
      />
      {triggerForm && <TriggerPreview factoryProjectId={context.factoryProjectId} trigger={trigger} />}
      <KindSection
        title={t('intakeRules.then')}
        selectLabel={t('intakeRules.actionKind')}
        kinds={kinds.actions}
        formFor={intakeActionForm}
        draft={action}
        onChange={setAction}
        disabled={busy}
        context={context}
      />
      <div className="flex items-center gap-2">
        <Txt as="span" variant="caption" tone="muted">
          {t('intakeRules.ifOpen')}
        </Txt>
        <Select value={policy} disabled={busy} onValueChange={setPolicy}>
          <SelectTrigger size="sm" aria-label={t('intakeRules.policy')} className="w-auto">
            <Txt as="span" variant="caption">
              {kinds.policies.find(kind => kind.kind === policy)?.label ?? policy}
            </Txt>
          </SelectTrigger>
          <SelectContent>
            {kinds.policies.map(kind => (
              <SelectItem key={kind.kind} value={kind.kind}>
                {kind.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          {t('intakeRules.cancel')}
        </Button>
        <Button type="submit" size="sm" variant="primary" disabled={busy || !ready}>
          {t('intakeRules.save')}
        </Button>
      </div>
    </form>
  );
}
