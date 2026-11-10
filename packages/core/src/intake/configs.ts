/**
 * The config shapes of the built-in kinds. They are domain: the kinds parse with them, the wire
 * contracts (`@factory/contracts`) re-export them for the UI's forms. A new kind adds its schema
 * here, or next to its adapter when the shape is that adapter's alone.
 */

import { z } from 'zod';

import { MAX_BOARD_IDENTIFIER_LENGTH } from '../rules/validation.ts';
import { parseScheduleSpec } from './schedule.ts';
import type { ScheduleSpec } from './schedule.ts';

/** The `schedule` trigger: when to fire, in which timezone. */
export const scheduleTriggerConfigSchema = z.object({
  spec: z.unknown().transform((value, ctx): ScheduleSpec => {
    const parsed = parseScheduleSpec(value);
    if ('error' in parsed) {
      ctx.addIssue({ code: 'custom', message: parsed.error });
      return z.NEVER;
    }
    return parsed.spec;
  }),
  /** An IANA timezone, e.g. `Europe/Kyiv`. */
  timezone: z.string().trim().min(1).max(64),
});
export type ScheduleTriggerConfig = z.output<typeof scheduleTriggerConfigSchema>;

/**
 * The `create-card` action: what card a fire files. Where it lands is the project's intake routes'
 * call, like any new card; `boardKey`/`phaseKey` are the default target used when no route takes it.
 */
export const createCardActionConfigSchema = z.object({
  boardKey: z.string().min(1).max(MAX_BOARD_IDENTIFIER_LENGTH),
  /** `null`: the board's first phase. */
  phaseKey: z.string().min(1).max(MAX_BOARD_IDENTIFIER_LENGTH).nullable(),
  /** May use the intake template placeholders (`{date}`, `{time}`, `{rule}`, `{payload.<key>}`). */
  titleTemplate: z.string().trim().min(1).max(200),
  /** The card's description: what the board's agent is asked to do. Same placeholders. */
  description: z.string().max(8_000),
  /** A repository slug linked to the Factory; `null` runs in the whole environment. */
  repository: z.string().trim().min(1).max(200).nullable(),
});
export type CreateCardActionConfig = z.output<typeof createCardActionConfigSchema>;
