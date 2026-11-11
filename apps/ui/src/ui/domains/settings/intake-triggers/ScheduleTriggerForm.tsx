import { Input } from '@mastra/playground-ui/components/Input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';

import { SCHEDULE_HOUR_STEPS, SCHEDULE_PRESETS } from '@factory/core';
import type { SchedulePreset } from '@factory/core';

import type { IntakeKindForm, IntakeKindFormProps } from './formRegistry';

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0] as const;

type Spec = Record<string, unknown> & { preset?: SchedulePreset };

function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The fields a preset keeps; switching presets keeps what still applies. */
function specFor(preset: SchedulePreset, previous: Spec): Spec {
  const time = typeof previous.time === 'string' ? previous.time : '09:00';
  switch (preset) {
    case 'daily':
    case 'weekdays':
      return { preset, time };
    case 'weekly':
      return { preset, time, weekday: typeof previous.weekday === 'number' ? previous.weekday : 1 };
    case 'hourly':
      return { preset, everyHours: 1, minute: 0 };
    case 'cron':
      return { preset, cron: typeof previous.cron === 'string' ? previous.cron : '0 9 * * 1-5' };
  }
}

function ScheduleFields({ config, onChange, disabled }: IntakeKindFormProps) {
  const { t } = useTranslation('settings');
  const spec = (config.spec ?? {}) as Spec;
  const preset = spec.preset ?? 'daily';
  const timezone = typeof config.timezone === 'string' ? config.timezone : '';
  const setSpec = (next: Spec) => onChange({ ...config, spec: next });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={preset} disabled={disabled} onValueChange={next => setSpec(specFor(next as SchedulePreset, spec))}>
        <SelectTrigger size="sm" aria-label={t('intakeTriggers.schedule.preset')} className="w-auto">
          <Txt as="span" variant="caption">
            {t(`intakeTriggers.schedule.presets.${preset}`)}
          </Txt>
        </SelectTrigger>
        <SelectContent>
          {SCHEDULE_PRESETS.map(option => (
            <SelectItem key={option} value={option}>
              {t(`intakeTriggers.schedule.presets.${option}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {preset === 'weekly' && (
        <Select
          value={String(spec.weekday ?? 1)}
          disabled={disabled}
          onValueChange={next => setSpec({ ...spec, weekday: Number(next) })}
        >
          <SelectTrigger size="sm" aria-label={t('intakeTriggers.schedule.weekday')} className="w-auto">
            <Txt as="span" variant="caption">
              {t(`intakeTriggers.schedule.weekdays.${(typeof spec.weekday === 'number' ? spec.weekday : 1) as (typeof WEEKDAYS)[number]}`)}
            </Txt>
          </SelectTrigger>
          <SelectContent>
            {WEEKDAYS.map(day => (
              <SelectItem key={day} value={String(day)}>
                {t(`intakeTriggers.schedule.weekdays.${day}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {(preset === 'daily' || preset === 'weekdays' || preset === 'weekly') && (
        <Input
          size="sm"
          type="time"
          className="w-28"
          aria-label={t('intakeTriggers.schedule.time')}
          value={typeof spec.time === 'string' ? spec.time : ''}
          disabled={disabled}
          onChange={event => setSpec({ ...spec, time: event.target.value })}
        />
      )}

      {preset === 'hourly' && (
        <>
          <Select
            value={String(spec.everyHours ?? 1)}
            disabled={disabled}
            onValueChange={next => setSpec({ ...spec, everyHours: Number(next) })}
          >
            <SelectTrigger size="sm" aria-label={t('intakeTriggers.schedule.everyHours')} className="w-auto">
              <Txt as="span" variant="caption">
                {t('intakeTriggers.schedule.hours', { count: Number(spec.everyHours ?? 1) })}
              </Txt>
            </SelectTrigger>
            <SelectContent>
              {SCHEDULE_HOUR_STEPS.map(step => (
                <SelectItem key={step} value={String(step)}>
                  {t('intakeTriggers.schedule.hours', { count: step })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            size="sm"
            type="number"
            min={0}
            max={59}
            className="w-20"
            aria-label={t('intakeTriggers.schedule.minute')}
            value={String(spec.minute ?? 0)}
            disabled={disabled}
            onChange={event => setSpec({ ...spec, minute: Number(event.target.value) })}
          />
        </>
      )}

      {preset === 'cron' && (
        <Input
          size="sm"
          className="w-48 font-mono"
          aria-label={t('intakeTriggers.schedule.cron')}
          placeholder="0 9 * * 1-5"
          value={typeof spec.cron === 'string' ? spec.cron : ''}
          disabled={disabled}
          onChange={event => setSpec({ ...spec, cron: event.target.value })}
        />
      )}

      <Input
        size="sm"
        className="w-44"
        aria-label={t('intakeTriggers.schedule.timezone')}
        placeholder="Europe/Kyiv"
        value={timezone}
        disabled={disabled}
        onChange={event => onChange({ ...config, timezone: event.target.value })}
      />
    </div>
  );
}

export const scheduleTriggerForm: IntakeKindForm = {
  kind: 'schedule',
  defaultConfig: () => ({ spec: { preset: 'weekdays', time: '09:00' }, timezone: hostTimeZone() }),
  ready: config => typeof config.timezone === 'string' && config.timezone.trim().length > 0 && !!config.spec,
  Form: ScheduleFields,
};
