import { calendarDay, clockTime } from './schedule.ts';

/**
 * The placeholders a trigger route's text templates (a card's title and description) may use. A
 * fixed set filled by plain substitution, never evaluated: an unknown placeholder stays as written.
 *
 * - `{date}` — the fire's day, YYYY-MM-DD, in the trigger's timezone
 * - `{time}` — the fire's time, HH:MM, in the trigger's timezone
 * - `{route}` — the route's name (`{rule}`, its name before routes made cards, still works)
 * - `{payload.<key>}` — a text or number field the trigger fired with (event triggers)
 */
export const INTAKE_TEMPLATE_PLACEHOLDERS = ['{date}', '{time}', '{route}', '{payload.<key>}'] as const;

export interface IntakeTemplateContext {
  firedAt: Date;
  /** IANA timezone the fire's date and time are written in; the host's when absent. */
  timeZone?: string;
  routeName: string;
  payload?: Record<string, unknown>;
}

const PLACEHOLDER = /\{(date|time|route|rule|payload\.([A-Za-z0-9_-]{1,64}))\}/g;

export function renderIntakeTemplate(template: string, context: IntakeTemplateContext): string {
  return template.replace(PLACEHOLDER, (whole, name: string, payloadKey: string | undefined) => {
    if (name === 'date') return calendarDay(context.firedAt, context.timeZone);
    if (name === 'time') return clockTime(context.firedAt, context.timeZone);
    if (name === 'route' || name === 'rule') return context.routeName;
    const value = payloadKey === undefined ? undefined : context.payload?.[payloadKey];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : whole;
  });
}
