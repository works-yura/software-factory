/**
 * Intake rules on the wire: a trigger and an action, each `{ kind, config }`, plus an overlap
 * policy. The route bodies are generic; each kind's own config shape is a schema here, shared by the
 * server's registries (which validate with it) and the UI's forms (which build it). A new kind adds
 * its schema here, its descriptor on the server and its form in the UI.
 */

import { z } from 'zod';

import { MAX_BOARD_IDENTIFIER_LENGTH, parseScheduleSpec, SCHEDULE_HOUR_STEPS } from '@factory/core';
import type { ScheduleSpec } from '@factory/core';

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const uuidSchema = z.string().regex(UUID);
const KIND = /^[a-z][a-z0-9-]{0,47}$/;

export const INTAKE_RULE_LOCALES = ['uk', 'en'] as const;
export type IntakeRuleLocale = (typeof INTAKE_RULE_LOCALES)[number];

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
export const SCHEDULE_TRIGGER_HOUR_STEPS = SCHEDULE_HOUR_STEPS;

/** The `create-card` action: what card a fire files, and where. */
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

const kindRefSchema = z.object({
  kind: z.string().regex(KIND, 'A kind is lower-case letters, digits and dashes.'),
  config: z.record(z.string(), z.unknown()),
});

export const DEFAULT_INTAKE_POLICY = 'skip-if-open';

export const intakeRuleInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    trigger: kindRefSchema,
    action: kindRefSchema,
    policy: z.object({ kind: z.string().regex(KIND) }).default({ kind: DEFAULT_INTAKE_POLICY }),
    enabled: z.boolean().default(true),
  })
  .strict();
export type IntakeRuleInputBody = z.output<typeof intakeRuleInputSchema>;

export const intakeRulePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    trigger: kindRefSchema.optional(),
    action: kindRefSchema.optional(),
    policy: z.object({ kind: z.string().regex(KIND) }).optional(),
    enabled: z.boolean().optional(),
    /** Send the `revision` you read so a concurrent edit is not overwritten. */
    expectedRevision: z.number().int().min(1),
  })
  .strict();

export const intakeRuleFireSchema = z.object({
  id: z.string(),
  firedAt: z.string(),
  triggerKind: z.string(),
  outcome: z.enum(['done', 'skipped', 'failed']),
  workItemId: z.string().nullable(),
  reason: z.string().nullable(),
});
export type IntakeRuleFire = z.infer<typeof intakeRuleFireSchema>;

const describedKindSchema = z.object({
  kind: z.string(),
  config: z.record(z.string(), z.unknown()),
  /** The config in words, in the requested locale (e.g. «У будні о 14:18»). */
  summary: z.string(),
});

export const intakeRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  trigger: describedKindSchema,
  action: describedKindSchema,
  policy: z.object({ kind: z.string(), summary: z.string() }),
  enabled: z.boolean(),
  revision: z.number().int(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedBy: z.string(),
  updatedAt: z.string(),
  /** The next times the trigger fires, ISO; empty for a paused rule or a trigger with no clock. */
  nextFires: z.array(z.string()),
  lastFire: intakeRuleFireSchema.nullable(),
  /** Why the rule can't run as it stands (a deleted board, a kind this server lacks); it is skipped meanwhile. */
  problems: z.array(z.string()),
});
export type IntakeRule = z.infer<typeof intakeRuleSchema>;

const kindListingSchema = z.object({ kind: z.string(), label: z.string() });
export const intakeRuleKindsSchema = z.object({
  triggers: z.array(kindListingSchema),
  actions: z.array(kindListingSchema),
  policies: z.array(kindListingSchema),
  /** The placeholders text templates may use. */
  placeholders: z.array(z.string()),
});
export type IntakeRuleKinds = z.infer<typeof intakeRuleKindsSchema>;

const localeQuerySchema = z.object({ locale: z.enum(INTAKE_RULE_LOCALES).optional() });
const projectPathSchema = z.object({ id: uuidSchema });
const rulePathSchema = z.object({ id: uuidSchema, ruleId: uuidSchema });

export const intakeTriggerPreviewBodySchema = z.object({
  trigger: kindRefSchema,
  locale: z.enum(INTAKE_RULE_LOCALES).optional(),
});
export const intakeTriggerPreviewSchema = z.object({
  summary: z.string(),
  nextFires: z.array(z.string()),
  /** Why the config is not valid; `summary` and `nextFires` are empty then. */
  problems: z.array(z.string()),
});
export type IntakeTriggerPreview = z.infer<typeof intakeTriggerPreviewSchema>;

export const INTAKE_RULE_ROUTE_CONTRACTS = {
  intakeRuleKinds: {
    method: 'GET',
    path: '/web/factory/projects/:id/intake-rules/kinds',
    description: 'The trigger, action and policy kinds intake rules can use on this server',
    pathSchema: projectPathSchema,
    querySchema: localeQuerySchema,
    responseSchema: intakeRuleKindsSchema,
  },
  intakeTriggerPreview: {
    method: 'POST',
    path: '/web/factory/projects/:id/intake-rules/preview',
    description: "A trigger config in words and its next fire times, before it's saved",
    pathSchema: projectPathSchema,
    bodySchema: intakeTriggerPreviewBodySchema,
    responseSchema: intakeTriggerPreviewSchema,
  },
  intakeRuleList: {
    method: 'GET',
    path: '/web/factory/projects/:id/intake-rules',
    description: "List a Factory project's intake rules",
    pathSchema: projectPathSchema,
    querySchema: localeQuerySchema,
    responseSchema: z.object({ intakeRules: z.array(intakeRuleSchema) }),
  },
  intakeRuleCreate: {
    method: 'POST',
    path: '/web/factory/projects/:id/intake-rules',
    description: 'Add an intake rule to a Factory project',
    pathSchema: projectPathSchema,
    querySchema: localeQuerySchema,
    bodySchema: intakeRuleInputSchema,
    responseSchema: z.object({ intakeRule: intakeRuleSchema }),
  },
  intakeRuleUpdate: {
    method: 'PATCH',
    path: '/web/factory/projects/:id/intake-rules/:ruleId',
    description: 'Change, pause or resume an intake rule',
    pathSchema: rulePathSchema,
    querySchema: localeQuerySchema,
    bodySchema: intakeRulePatchSchema,
    responseSchema: z.object({ intakeRule: intakeRuleSchema }),
  },
  intakeRuleDelete: {
    method: 'DELETE',
    path: '/web/factory/projects/:id/intake-rules/:ruleId',
    description: 'Delete an intake rule; the cards it filed stay',
    pathSchema: rulePathSchema,
    querySchema: z.object({ expectedRevision: z.coerce.number().int().min(1) }),
    responseSchema: z.null(),
  },
  intakeRuleFires: {
    method: 'GET',
    path: '/web/factory/projects/:id/intake-rules/:ruleId/fires',
    description: "An intake rule's latest fires: the cards it filed, and what it skipped or failed",
    pathSchema: rulePathSchema,
    responseSchema: z.object({ fires: z.array(intakeRuleFireSchema) }),
  },
} as const;
