/**
 * Trigger routes on the wire: an intake route may carry a trigger of its own (a schedule) with an
 * action and an overlap policy, each `{ kind, config }`. The bodies are generic; each kind's own
 * config shape is a domain schema (`@factory/core`) re-exported here, shared by the server's kinds
 * (which parse with it) and the UI's forms (which build it). The routes themselves are written
 * through the intake-route contracts (`contracts.ts`); this module adds what only trigger routes
 * need: the kinds on offer, a preview of a trigger's next fires, and a route's fire history.
 */

import { z } from 'zod';

import { INTAKE_FIRE_OUTCOMES, INTAKE_LOCALES, SCHEDULE_HOUR_STEPS } from '@factory/core';

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const uuidSchema = z.string().regex(UUID);
const KIND = /^[a-z][a-z0-9-]{0,47}$/;

// The built-in kinds' config shapes are domain (`@factory/core`); the wire re-exports them for the UI's forms.
export { createCardActionConfigSchema, INTAKE_LOCALES, scheduleTriggerConfigSchema } from '@factory/core';
export type { CreateCardActionConfig, IntakeLocale, ScheduleTriggerConfig } from '@factory/core';
export const SCHEDULE_TRIGGER_HOUR_STEPS = SCHEDULE_HOUR_STEPS;

export const intakeKindRefSchema = z.object({
  kind: z.string().regex(KIND, 'A kind is lower-case letters, digits and dashes.'),
  config: z.record(z.string(), z.unknown()),
});

/** The overlap policy a new trigger route gets unless it names one. */
export const DEFAULT_INTAKE_POLICY = 'skip-if-open';

/** What makes a route a trigger route: its trigger, what a fire does, and the overlap policy. */
export const intakeRouteTriggeredSchema = z
  .object({
    trigger: intakeKindRefSchema,
    action: intakeKindRefSchema,
    policy: z.object({ kind: z.string().regex(KIND) }).default({ kind: DEFAULT_INTAKE_POLICY }),
  })
  .strict();
export type IntakeRouteTriggeredBody = z.output<typeof intakeRouteTriggeredSchema>;

export const intakeRouteFireSchema = z.object({
  id: z.string(),
  firedAt: z.string(),
  triggerKind: z.string(),
  outcome: z.enum(INTAKE_FIRE_OUTCOMES),
  /** The card the fire filed, once it is on the board; null when it filed none or isn't there yet. */
  workItemId: z.string().nullable(),
  reason: z.string().nullable(),
});
export type IntakeRouteFire = z.infer<typeof intakeRouteFireSchema>;

const describedKindSchema = z.object({
  kind: z.string(),
  config: z.record(z.string(), z.unknown()),
  summary: z.string(),
});

/** A trigger route's own parts, as the route list shows them; null on routes that wait for arriving cards. */
export const intakeRouteTriggerViewSchema = z.object({
  trigger: describedKindSchema,
  action: describedKindSchema,
  policy: z.object({ kind: z.string(), summary: z.string() }),
  nextFires: z.array(z.string()),
  lastFire: intakeRouteFireSchema.nullable(),
});
export type IntakeRouteTriggerView = z.infer<typeof intakeRouteTriggerViewSchema>;

const kindListingSchema = z.object({ kind: z.string(), label: z.string() });
export const intakeTriggerKindsSchema = z.object({
  triggers: z.array(kindListingSchema),
  actions: z.array(kindListingSchema),
  policies: z.array(kindListingSchema),
  placeholders: z.array(z.string()),
});
export type IntakeTriggerKinds = z.infer<typeof intakeTriggerKindsSchema>;

export const intakeLocaleQuerySchema = z.object({ locale: z.enum(INTAKE_LOCALES).optional() });
const projectPathSchema = z.object({ id: uuidSchema });
const routePathSchema = z.object({ id: uuidSchema, routeId: uuidSchema });

export const intakeTriggerPreviewBodySchema = z.object({
  trigger: intakeKindRefSchema,
  locale: z.enum(INTAKE_LOCALES).optional(),
});
export const intakeTriggerPreviewSchema = z.object({
  summary: z.string(),
  nextFires: z.array(z.string()),
  problems: z.array(z.string()),
});
export type IntakeTriggerPreview = z.infer<typeof intakeTriggerPreviewSchema>;

export const INTAKE_TRIGGER_ROUTE_CONTRACTS = {
  intakeTriggerKinds: {
    method: 'GET',
    path: '/web/factory/projects/:id/intake-routes/kinds',
    description: 'The trigger, action and policy kinds a route with a trigger of its own can use on this server',
    pathSchema: projectPathSchema,
    querySchema: intakeLocaleQuerySchema,
    responseSchema: intakeTriggerKindsSchema,
  },
  intakeTriggerPreview: {
    method: 'POST',
    path: '/web/factory/projects/:id/intake-routes/preview',
    description: "A trigger config in words and its next fire times, before it's saved",
    pathSchema: projectPathSchema,
    bodySchema: intakeTriggerPreviewBodySchema,
    responseSchema: intakeTriggerPreviewSchema,
  },
  intakeRouteFires: {
    method: 'GET',
    path: '/web/factory/projects/:id/intake-routes/:routeId/fires',
    description: "A trigger route's latest fires: the cards it filed, and what it skipped or failed",
    pathSchema: routePathSchema,
    responseSchema: z.object({ fires: z.array(intakeRouteFireSchema) }),
  },
} as const;
