/**
 * The `schedule` trigger: a cron, kept in Mastra core `Schedules` (one row per rule) like the
 * environment-build schedule. The scheduler owns firing, claims across replicas and its trigger
 * log; the row fires the `factory-intake-rule-fire` workflow, whose one step hands the fire to the
 * sink (the engine). Factory only creates, updates, pauses, resumes and deletes the row.
 */

import type { AnySchedule, Schedules } from '@mastra/core/schedules';
import { computeNextFireAt, createStep, createWorkflow, validateCron } from '@mastra/core/workflows';
import { z } from 'zod';

import { scheduleCron } from '@factory/core';
import type { ScheduleSpec } from '@factory/core';
import { scheduleTriggerConfigSchema } from '@factory/contracts';
import type { ScheduleTriggerConfig } from '@factory/contracts';
import type { IntakeRuleRecord } from '@factory/store';

import { IntakeConfigError, parseWith } from './kinds.ts';
import type { IntakeFireSink, IntakeRuleLocale, IntakeTriggerKind } from './kinds.ts';

export const INTAKE_RULE_FIRE_WORKFLOW_ID = 'factory-intake-rule-fire';
export const SCHEDULE_TRIGGER_KIND = 'schedule';

export type ScheduleRows = Pick<Schedules, 'create' | 'get' | 'update' | 'pause' | 'resume' | 'delete'>;

/** The rule's row id as core stores it (`schedule_<slug>`; a rule id is a lower-case uuid). */
export function intakeRuleScheduleId(ruleId: string): string {
  return `schedule_factory-intake-rule-${ruleId.toLowerCase()}`;
}

const WEEKDAYS: Record<IntakeRuleLocale, readonly string[]> = {
  uk: ['неділю', 'понеділок', 'вівторок', 'середу', 'четвер', "п'ятницю", 'суботу'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
};

const pad = (value: number) => String(value).padStart(2, '0');

/** A schedule spec in words, e.g. «У будні о 14:18» / "Weekdays at 14:18". */
export function describeScheduleSpec(spec: ScheduleSpec, locale: IntakeRuleLocale): string {
  const uk = locale === 'uk';
  switch (spec.preset) {
    case 'daily':
      return uk ? `Щодня о ${spec.time}` : `Every day at ${spec.time}`;
    case 'weekdays':
      return uk ? `У будні о ${spec.time}` : `Weekdays at ${spec.time}`;
    case 'weekly':
      return uk
        ? `Щотижня в ${WEEKDAYS.uk[spec.weekday]} о ${spec.time}`
        : `Every ${WEEKDAYS.en[spec.weekday]} at ${spec.time}`;
    case 'hourly':
      if (spec.everyHours === 1) return uk ? `Щогодини о :${pad(spec.minute)}` : `Every hour at :${pad(spec.minute)}`;
      return uk
        ? `Кожні ${spec.everyHours} год о :${pad(spec.minute)}`
        : `Every ${spec.everyHours} hours at :${pad(spec.minute)}`;
    case 'cron':
      return uk ? `За розкладом cron «${spec.cron}»` : `On cron "${spec.cron}"`;
  }
}

function parseScheduleConfig(config: unknown): ScheduleTriggerConfig {
  const parsed = parseWith(scheduleTriggerConfigSchema, config);
  try {
    validateCron(scheduleCron(parsed.spec), parsed.timezone);
  } catch (error) {
    throw new IntakeConfigError(error instanceof Error ? error.message : String(error));
  }
  return parsed;
}

const inputSchema = z.object({ ruleId: z.string().min(1) });
const outputSchema = z.object({ ruleId: z.string() });

export interface ScheduleTriggerOptions {
  /** Core schedules of the booted Mastra; `undefined` until it exists or when storage has no schedules domain. */
  schedules: () => ScheduleRows | undefined;
  now?: () => Date;
}

/**
 * Built once per server: `workflow` is registered on the host's Mastra at prepare time, and
 * `start` connects its fires to the engine once the engine exists.
 */
export function createScheduleTrigger(options: ScheduleTriggerOptions) {
  let sink: IntakeFireSink | undefined;
  const now = options.now ?? (() => new Date());

  const fire = createStep({
    id: 'fire',
    inputSchema,
    outputSchema,
    execute: async ({ inputData }) => {
      if (!sink) throw new Error('Intake rules are not started on this server yet.');
      await sink({ ruleId: inputData.ruleId, firedAt: now(), triggerKind: SCHEDULE_TRIGGER_KIND });
      return { ruleId: inputData.ruleId };
    },
  });
  const workflow = createWorkflow({ id: INTAKE_RULE_FIRE_WORKFLOW_ID, inputSchema, outputSchema })
    .then(fire)
    .commit();

  const rows = (): ScheduleRows => {
    const schedules = options.schedules();
    if (!schedules) {
      throw new Error("Scheduled intake needs Mastra schedules, which this server's storage does not provide.");
    }
    return schedules;
  };

  const trigger: IntakeTriggerKind<ScheduleTriggerConfig> = {
    kind: SCHEDULE_TRIGGER_KIND,
    label: { uk: 'За розкладом', en: 'On a schedule' },
    parse: parseScheduleConfig,
    describe: (config, locale) => `${describeScheduleSpec(config.spec, locale)} (${config.timezone})`,
    timeZone: config => config.timezone,
    nextFires: (config, after, count) => {
      const cron = scheduleCron(config.spec);
      const fires: Date[] = [];
      let cursor = after.getTime();
      for (let index = 0; index < count; index += 1) {
        try {
          cursor = computeNextFireAt(cron, { timezone: config.timezone, after: cursor });
        } catch {
          break;
        }
        fires.push(new Date(cursor));
      }
      return fires;
    },
    start: next => {
      sink = next;
    },
    arm: async (rule: IntakeRuleRecord, config) => {
      const schedules = rows();
      const id = intakeRuleScheduleId(rule.id);
      const cron = scheduleCron(config.spec);
      const existing: AnySchedule | null = await schedules.get(id);
      if (!existing) {
        await schedules.create({
          id,
          workflowId: INTAKE_RULE_FIRE_WORKFLOW_ID,
          cron,
          timezone: config.timezone,
          inputData: { ruleId: rule.id },
          resourceId: rule.factoryProjectId,
          metadata: { intakeRuleId: rule.id },
        });
        return;
      }
      if (existing.cron !== cron || (existing.timezone ?? undefined) !== config.timezone) {
        await schedules.update(id, { cron, timezone: config.timezone });
      }
      if (existing.status === 'paused') await schedules.resume(id);
    },
    disarm: async ruleId => {
      const schedules = options.schedules();
      if (!schedules) return;
      const id = intakeRuleScheduleId(ruleId);
      if (await schedules.get(id)) await schedules.delete(id);
    },
  };

  return { trigger, workflow };
}
