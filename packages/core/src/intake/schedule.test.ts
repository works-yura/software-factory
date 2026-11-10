import { describe, expect, it } from 'vitest';

import { calendarDay, parseScheduleSpec, scheduleCron } from './schedule.ts';
import { renderIntakeTemplate } from './template.ts';

describe('schedule spec', () => {
  it('turns each preset into the cron the scheduler runs', () => {
    expect(scheduleCron({ preset: 'daily', time: '09:05' })).toBe('5 9 * * *');
    expect(scheduleCron({ preset: 'weekdays', time: '14:18' })).toBe('18 14 * * 1-5');
    expect(scheduleCron({ preset: 'weekly', time: '08:00', weekday: 1 })).toBe('0 8 * * 1');
    expect(scheduleCron({ preset: 'hourly', everyHours: 1, minute: 30 })).toBe('30 * * * *');
    expect(scheduleCron({ preset: 'hourly', everyHours: 6, minute: 0 })).toBe('0 */6 * * *');
    expect(scheduleCron({ preset: 'cron', cron: '0 3 1 * *' })).toBe('0 3 1 * *');
  });

  it('refuses specs a person could not have meant', () => {
    expect(parseScheduleSpec({ preset: 'daily', time: '25:00' })).toEqual({ error: expect.stringMatching(/HH:MM/) });
    expect(parseScheduleSpec({ preset: 'weekly', time: '08:00', weekday: 7 })).toEqual({
      error: expect.stringMatching(/weekday/),
    });
    expect(parseScheduleSpec({ preset: 'hourly', everyHours: 5, minute: 0 })).toEqual({
      error: expect.stringMatching(/Every N hours/),
    });
    expect(parseScheduleSpec({ preset: 'cron', cron: '  ' })).toEqual({ error: expect.stringMatching(/cron/) });
    expect(parseScheduleSpec({ preset: 'yearly' })).toEqual({ error: expect.stringMatching(/Unknown/) });
    expect(parseScheduleSpec({ preset: 'cron', cron: ' 0  3 * * * ' })).toEqual({
      spec: { preset: 'cron', cron: '0 3 * * *' },
    });
  });

  it('fills a template’s fixed placeholders in the trigger’s timezone and leaves anything else as written', () => {
    const lateUtc = new Date('2026-11-10T23:30:00Z');
    expect(calendarDay(lateUtc, 'UTC')).toBe('2026-11-10');
    expect(calendarDay(lateUtc, 'Europe/Kyiv')).toBe('2026-11-11');
    const context = { firedAt: lateUtc, timeZone: 'Europe/Kyiv', ruleName: 'Security', payload: { pr: 42, obj: {} } };
    expect(renderIntakeTemplate('Аудит безпеки — {date} {time}', context)).toBe('Аудит безпеки — 2026-11-11 01:30');
    expect(renderIntakeTemplate('{rule}: PR {payload.pr} {payload.obj} {payload.none} {env.SECRET} {date', context)).toBe(
      'Security: PR 42 {payload.obj} {payload.none} {env.SECRET} {date',
    );
  });
});
