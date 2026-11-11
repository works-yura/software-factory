import { Notice } from '@mastra/playground-ui/components/Notice';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';

import type { IntakeTriggerKindsInfo } from '../../../../api/types';
import { useIntakeTriggerPreview } from '../../../../hooks/useIntakeRoutes';
import type { IntakeKindDraft, IntakeRouteTriggeredDraft } from '../../../../hooks/useIntakeRoutes';
import { currentLanguage } from '../../../i18n';
import { intakeActionForm, intakeTriggerForm } from './formRegistry';
import type { IntakeKindForm, IntakeKindFormContext } from './formRegistry';

/**
 * The part of the route editor a route «За розкладом» adds: its trigger (with the next fires), what
 * each fire does, and what happens while the last card is open. Each part is the form its kind
 * registered (`formRegistry`), so a new trigger or action kind brings its own form and nothing here
 * changes. Where the card lands is the route's own target, edited with every other route's.
 */

type Listing = IntakeTriggerKindsInfo['triggers'][number];

/** A new route «За розкладом»: the first trigger and action kinds this browser has a form for. */
export function defaultTriggeredDraft(kinds: IntakeTriggerKindsInfo, context: IntakeKindFormContext): IntakeRouteTriggeredDraft {
  const trigger = kinds.triggers.find(kind => intakeTriggerForm(kind.kind))?.kind ?? 'schedule';
  const action = kinds.actions.find(kind => intakeActionForm(kind.kind))?.kind ?? 'create-card';
  return {
    trigger: { kind: trigger, config: intakeTriggerForm(trigger)?.defaultConfig(context) ?? {} },
    action: { kind: action, config: intakeActionForm(action)?.defaultConfig(context) ?? {} },
    policy: { kind: kinds.policies[0]?.kind ?? 'skip-if-open' },
  };
}

/** Whether the trigger and action are filled in enough to save. */
export function triggeredReady(draft: IntakeRouteTriggeredDraft): boolean {
  return Boolean(intakeTriggerForm(draft.trigger.kind)?.ready(draft.trigger.config)) &&
    Boolean(intakeActionForm(draft.action.kind)?.ready(draft.action.config));
}

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
          disabled={disabled || editable.length < 2}
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
        <Notice variant="info">{t('intakeTriggers.kindNotEditable', { kind: draft.kind })}</Notice>
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
    <div aria-label={t('intakeTriggers.preview')} className="flex flex-col gap-0.5">
      <Txt as="p" variant="caption" tone="ink">
        {data.summary}
      </Txt>
      {data.nextFires.length > 0 && (
        <Txt as="p" variant="caption" tone="muted">
          {t('intakeTriggers.nextFires', { list: data.nextFires.map(at => format.format(new Date(at))).join(' · ') })}
        </Txt>
      )}
    </div>
  );
}

export function TriggerFields({
  kinds,
  context,
  value,
  onChange,
  disabled,
}: {
  kinds: IntakeTriggerKindsInfo;
  context: IntakeKindFormContext;
  value: IntakeRouteTriggeredDraft;
  onChange: (next: IntakeRouteTriggeredDraft) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation('settings');
  return (
    <div className="flex flex-col gap-3">
      <KindSection
        title={t('intakeTriggers.repeats')}
        selectLabel={t('intakeTriggers.triggerKind')}
        kinds={kinds.triggers}
        formFor={intakeTriggerForm}
        draft={value.trigger}
        onChange={trigger => onChange({ ...value, trigger })}
        disabled={disabled}
        context={context}
      />
      {intakeTriggerForm(value.trigger.kind) && <TriggerPreview factoryProjectId={context.factoryProjectId} trigger={value.trigger} />}
      <KindSection
        title={t('intakeTriggers.then')}
        selectLabel={t('intakeTriggers.actionKind')}
        kinds={kinds.actions}
        formFor={intakeActionForm}
        draft={value.action}
        onChange={action => onChange({ ...value, action })}
        disabled={disabled}
        context={context}
      />
      <div className="flex items-center gap-2">
        <Txt as="span" variant="caption" tone="muted">
          {t('intakeTriggers.ifOpen')}
        </Txt>
        <Select value={value.policy.kind} disabled={disabled} onValueChange={kind => onChange({ ...value, policy: { kind } })}>
          <SelectTrigger size="sm" aria-label={t('intakeTriggers.policy')} className="w-auto">
            <Txt as="span" variant="caption">
              {kinds.policies.find(kind => kind.kind === value.policy.kind)?.label ?? value.policy.kind}
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
    </div>
  );
}
