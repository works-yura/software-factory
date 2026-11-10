/**
 * A scheduled intake source's timing, as a person sets it: a preset (every day, weekdays, one
 * weekday, every N hours) or a raw cron expression. The preset is what the settings show back in
 * words; the cron is what the scheduler runs. Pure: the server validates the cron and computes
 * fire times, the UI only builds and describes the spec.
 */

export const SCHEDULE_PRESETS = ['daily', 'weekdays', 'weekly', 'hourly', 'cron'] as const;
export type SchedulePreset = (typeof SCHEDULE_PRESETS)[number];

/** Hours a `hourly` schedule may repeat on: the ones that divide a day evenly. */
export const SCHEDULE_HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12] as const;

export type ScheduleSpec =
  | { preset: 'daily'; time: string }
  | { preset: 'weekdays'; time: string }
  /** `weekday`: 0 = Sunday … 6 = Saturday, as in cron. */
  | { preset: 'weekly'; time: string; weekday: number }
  | { preset: 'hourly'; everyHours: number; minute: number }
  | { preset: 'cron'; cron: string };

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `HH:MM` (24-hour) as hour and minute, or `undefined` when it is not one. */
export function parseScheduleTime(time: string): { hour: number; minute: number } | undefined {
  const match = TIME.exec(time);
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The spec, or why it is not one. Cron syntax is the server's to check. */
export function parseScheduleSpec(value: unknown): { spec: ScheduleSpec } | { error: string } {
  if (!isRecord(value)) return { error: 'A schedule is required.' };
  const { preset } = value;
  switch (preset) {
    case 'daily':
    case 'weekdays': {
      if (typeof value.time !== 'string' || !parseScheduleTime(value.time)) {
        return { error: 'The time must be HH:MM (24-hour).' };
      }
      return { spec: { preset, time: value.time } };
    }
    case 'weekly': {
      if (typeof value.time !== 'string' || !parseScheduleTime(value.time)) {
        return { error: 'The time must be HH:MM (24-hour).' };
      }
      const weekday = value.weekday;
      if (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
        return { error: 'The weekday must be 0 (Sunday) to 6 (Saturday).' };
      }
      return { spec: { preset, time: value.time, weekday } };
    }
    case 'hourly': {
      const { everyHours, minute } = value;
      if (typeof everyHours !== 'number' || !(SCHEDULE_HOUR_STEPS as readonly number[]).includes(everyHours)) {
        return { error: `Every N hours must be one of ${SCHEDULE_HOUR_STEPS.join(', ')}.` };
      }
      if (typeof minute !== 'number' || !Number.isInteger(minute) || minute < 0 || minute > 59) {
        return { error: 'The minute must be 0 to 59.' };
      }
      return { spec: { preset, everyHours, minute } };
    }
    case 'cron': {
      const cron = typeof value.cron === 'string' ? value.cron.trim().replace(/\s+/g, ' ') : '';
      if (!cron) return { error: 'A cron expression is required.' };
      return { spec: { preset, cron } };
    }
    default:
      return { error: `Unknown schedule preset ${JSON.stringify(preset)}.` };
  }
}

/** The 5-part cron expression the scheduler runs for `spec`. */
export function scheduleCron(spec: ScheduleSpec): string {
  switch (spec.preset) {
    case 'daily': {
      const { hour, minute } = parseScheduleTime(spec.time)!;
      return `${minute} ${hour} * * *`;
    }
    case 'weekdays': {
      const { hour, minute } = parseScheduleTime(spec.time)!;
      return `${minute} ${hour} * * 1-5`;
    }
    case 'weekly': {
      const { hour, minute } = parseScheduleTime(spec.time)!;
      return `${minute} ${hour} * * ${spec.weekday}`;
    }
    case 'hourly':
      return spec.everyHours === 1 ? `${spec.minute} * * * *` : `${spec.minute} */${spec.everyHours} * * *`;
    case 'cron':
      return spec.cron;
  }
}

/** The day `at` falls on in `timeZone` (an IANA name; the host's when absent), as YYYY-MM-DD. */
export function calendarDay(at: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(at);
  const part = (type: string) => parts.find(candidate => candidate.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** The wall-clock time `at` shows in `timeZone`, as HH:MM. */
export function clockTime(at: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(at);
  const part = (type: string) => parts.find(candidate => candidate.type === type)?.value ?? '';
  return `${part('hour')}:${part('minute')}`;
}

const WEEKDAY_NAMES = {
  uk: ['неділю', 'понеділок', 'вівторок', 'середу', 'четвер', "п'ятницю", 'суботу'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
} as const;

const pad = (value: number) => String(value).padStart(2, '0');

/** A schedule spec in words, e.g. «У будні о 14:18» / "Weekdays at 14:18". */
export function describeScheduleSpec(spec: ScheduleSpec, locale: 'uk' | 'en'): string {
  const uk = locale === 'uk';
  switch (spec.preset) {
    case 'daily':
      return uk ? `Щодня о ${spec.time}` : `Every day at ${spec.time}`;
    case 'weekdays':
      return uk ? `У будні о ${spec.time}` : `Weekdays at ${spec.time}`;
    case 'weekly':
      return uk
        ? `Щотижня в ${WEEKDAY_NAMES.uk[spec.weekday]} о ${spec.time}`
        : `Every ${WEEKDAY_NAMES.en[spec.weekday]} at ${spec.time}`;
    case 'hourly':
      if (spec.everyHours === 1) return uk ? `Щогодини о :${pad(spec.minute)}` : `Every hour at :${pad(spec.minute)}`;
      return uk
        ? `Кожні ${spec.everyHours} год о :${pad(spec.minute)}`
        : `Every ${spec.everyHours} hours at :${pad(spec.minute)}`;
    case 'cron':
      return uk ? `За розкладом cron «${spec.cron}»` : `On cron "${spec.cron}"`;
  }
}
