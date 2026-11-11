/**
 * The `schedule` trigger: an adapter over Mastra core `Schedules`, like the environment-build
 * schedule. One schedule row per trigger route; the scheduler owns firing, claiming and the trigger
 * log, and each fire runs the `factory-intake-route-fire` workflow, whose one step hands the fire to
 * the sink (the engine). The workflow's run id is the scheduler's claim, so it is the fire's key: a
 * step retried after a crash fires with the same key and files nothing twice.
 */

import type { AnySchedule, Schedules } from '@mastra/core/schedules';
import { computeNextFireAt, createStep, createWorkflow, validateCron } from '@mastra/core/workflows';
import { z } from 'zod';

import {
  describeScheduleSpec,
  IntakeConfigError,
  IntakeTriggerUnavailableError,
  parseWith,
  scheduleCron,
  scheduleTriggerConfigSchema,
} from '@factory/core';
import type { IntakeFireSink, IntakeTriggerKind, IntakeTriggerRoute, ScheduleTriggerConfig } from '@factory/core';

export const INTAKE_ROUTE_FIRE_WORKFLOW_ID = 'factory-intake-route-fire';
export const SCHEDULE_TRIGGER_KIND = 'schedule';

export type ScheduleRows = Pick<Schedules, 'create' | 'get' | 'update' | 'pause' | 'resume' | 'delete'>;

/** The core schedule row of a trigger route. */
export function intakeRouteScheduleId(routeId: string): string {
  return `schedule_factory-intake-route-${routeId.toLowerCase()}`;
}

/**
 * The row a migrated intake rule's schedule had (ADR-0021): the rule became the route with its id,
 * so arming the route removes it and nothing fires the retired workflow.
 */
export function legacyIntakeRuleScheduleId(routeId: string): string {
  return `schedule_factory-intake-rule-${routeId.toLowerCase()}`;
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

const inputSchema = z.object({ routeId: z.string().min(1) });
const outputSchema = z.object({ routeId: z.string() });

export interface ScheduleTriggerOptions {
  /** The host's core schedules; read late, since the Mastra that owns them exists only after `prepare()`. */
  schedules: () => ScheduleRows | undefined;
  now?: () => Date;
}

export function createScheduleTrigger(options: ScheduleTriggerOptions) {
  let sink: IntakeFireSink | undefined;
  const now = options.now ?? (() => new Date());

  const fire = createStep({
    id: 'fire',
    inputSchema,
    outputSchema,
    execute: async ({ inputData, runId }) => {
      if (!sink) throw new Error('Trigger routes are not started on this server yet.');
      await sink({
        routeId: inputData.routeId,
        firedAt: now(),
        triggerKind: SCHEDULE_TRIGGER_KIND,
        fireKey: `schedule:${runId}`,
      });
      return { routeId: inputData.routeId };
    },
  });
  const workflow = createWorkflow({ id: INTAKE_ROUTE_FIRE_WORKFLOW_ID, inputSchema, outputSchema })
    .then(fire)
    .commit();

  const rows = (): ScheduleRows => {
    const schedules = options.schedules();
    if (!schedules) {
      throw new IntakeTriggerUnavailableError(
        "Scheduled routes need Mastra schedules, which this server's storage does not provide.",
      );
    }
    return schedules;
  };

  const dropLegacy = async (schedules: ScheduleRows, routeId: string) => {
    const legacy = legacyIntakeRuleScheduleId(routeId);
    if (await schedules.get(legacy)) await schedules.delete(legacy);
  };

  const trigger: IntakeTriggerKind<ScheduleTriggerConfig> = {
    kind: SCHEDULE_TRIGGER_KIND,
    label: { uk: 'За розкладом (повторюється)', en: 'On a schedule (repeats)' },
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
    arm: async (route: IntakeTriggerRoute, config) => {
      const schedules = rows();
      await dropLegacy(schedules, route.id);
      const id = intakeRouteScheduleId(route.id);
      const cron = scheduleCron(config.spec);
      const existing: AnySchedule | null = await schedules.get(id);
      if (!existing) {
        await schedules.create({
          id,
          workflowId: INTAKE_ROUTE_FIRE_WORKFLOW_ID,
          cron,
          timezone: config.timezone,
          inputData: { routeId: route.id },
          resourceId: route.factoryProjectId,
          metadata: { intakeRouteId: route.id },
        });
        return;
      }
      if (existing.cron !== cron || (existing.timezone ?? undefined) !== config.timezone) {
        await schedules.update(id, { cron, timezone: config.timezone });
      }
      if (existing.status === 'paused') await schedules.resume(id);
    },
    disarm: async routeId => {
      const schedules = options.schedules();
      if (!schedules) return;
      await dropLegacy(schedules, routeId);
      const id = intakeRouteScheduleId(routeId);
      if (await schedules.get(id)) await schedules.delete(id);
    },
  };

  return { trigger, workflow };
}
