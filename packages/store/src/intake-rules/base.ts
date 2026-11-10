import { FactoryStorageDomain } from '@mastra/core/storage';
import type { CollectionSchema } from '@mastra/core/storage';

/**
 * Intake rules: a Factory's own intake, next to ClickUp. A rule is a trigger (what fires it — a
 * schedule now, events later) and an action (what a fire does — file a card now, notify or file
 * follow-ups later), joined by a policy (what to do when the last fire's work is still open).
 * Each kind's config is opaque JSON here: the server's trigger, action and policy registries own
 * the shapes and check them. The fire log keeps what each fire did.
 */

export interface IntakeRuleRecord {
  id: string;
  orgId: string;
  factoryProjectId: string;
  name: string;
  triggerKind: string;
  triggerConfig: Record<string, unknown>;
  actionKind: string;
  actionConfig: Record<string, unknown>;
  /** The overlap policy's kind, e.g. `skip-if-open`. */
  policyKind: string;
  enabled: boolean;
  revision: number;
  createdBy: string;
  createdAt: Date;
  updatedBy: string;
  updatedAt: Date;
}

export interface IntakeRuleInput {
  name: string;
  triggerKind: string;
  triggerConfig: Record<string, unknown>;
  actionKind: string;
  actionConfig: Record<string, unknown>;
  policyKind: string;
  enabled: boolean;
}

export type IntakeRulePatch = Partial<IntakeRuleInput>;

/** `done`: the action ran; `skipped`: the policy held it back on purpose; `failed`: it could not run. */
export const INTAKE_RULE_FIRE_OUTCOMES = ['done', 'skipped', 'failed'] as const;
export type IntakeRuleFireOutcome = (typeof INTAKE_RULE_FIRE_OUTCOMES)[number];

export interface IntakeRuleFireRecord {
  id: string;
  orgId: string;
  factoryProjectId: string;
  ruleId: string;
  firedAt: Date;
  /** The trigger kind that fired it (`schedule`, `manual`, …). */
  triggerKind: string;
  outcome: IntakeRuleFireOutcome;
  /** What the action made, when it made a card. */
  workItemId: string | null;
  reason: string | null;
}

export interface IntakeRuleScope {
  orgId: string;
  factoryProjectId: string;
}

export class IntakeRuleError extends Error {
  readonly code: 'intake_rule_not_found' | 'intake_rule_conflict';

  constructor(code: IntakeRuleError['code'], message: string) {
    super(message);
    this.name = 'IntakeRuleError';
    this.code = code;
  }
}

export const INTAKE_RULES_SCHEMA: CollectionSchema = {
  name: 'factory_intake_rules',
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    factory_project_id: { type: 'text' },
    name: { type: 'text' },
    trigger_kind: { type: 'text' },
    trigger_config: { type: 'json' },
    action_kind: { type: 'text' },
    action_config: { type: 'json' },
    policy_kind: { type: 'text' },
    enabled: { type: 'boolean' },
    revision: { type: 'integer' },
    created_by: { type: 'text' },
    created_at: { type: 'timestamp' },
    updated_by: { type: 'text' },
    updated_at: { type: 'timestamp' },
  },
  indexes: [{ name: 'factory_intake_rules_project_idx', columns: ['org_id', 'factory_project_id'] }],
};

export const INTAKE_RULE_FIRES_SCHEMA: CollectionSchema = {
  name: 'factory_intake_rule_fires',
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    factory_project_id: { type: 'text' },
    rule_id: { type: 'text' },
    fired_at: { type: 'timestamp' },
    trigger_kind: { type: 'text' },
    outcome: { type: 'text' },
    work_item_id: { type: 'text', nullable: true },
    reason: { type: 'text', nullable: true },
  },
  indexes: [{ name: 'factory_intake_rule_fires_rule_idx', columns: ['rule_id', 'fired_at'] }],
};

type Json = Record<string, unknown>;

interface RuleRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  factory_project_id: string;
  name: string;
  trigger_kind: string;
  trigger_config: Json | string | null;
  action_kind: string;
  action_config: Json | string | null;
  policy_kind: string;
  enabled: boolean | number;
  revision: number;
  created_by: string;
  created_at: Date;
  updated_by: string;
  updated_at: Date;
}

interface FireRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  factory_project_id: string;
  rule_id: string;
  fired_at: Date;
  trigger_kind: string;
  outcome: string;
  work_item_id: string | null;
  reason: string | null;
}

function json(value: Json | string | null): Json {
  if (value === null) return {};
  return typeof value === 'string' ? (JSON.parse(value) as Json) : value;
}

function toRule(row: RuleRow): IntakeRuleRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    factoryProjectId: row.factory_project_id,
    name: row.name,
    triggerKind: row.trigger_kind,
    triggerConfig: json(row.trigger_config),
    actionKind: row.action_kind,
    actionConfig: json(row.action_config),
    policyKind: row.policy_kind,
    enabled: Boolean(row.enabled),
    revision: Number(row.revision),
    createdBy: row.created_by,
    createdAt: new Date(row.created_at),
    updatedBy: row.updated_by,
    updatedAt: new Date(row.updated_at),
  };
}

function toFire(row: FireRow): IntakeRuleFireRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    factoryProjectId: row.factory_project_id,
    ruleId: row.rule_id,
    firedAt: new Date(row.fired_at),
    triggerKind: row.trigger_kind,
    outcome: row.outcome as IntakeRuleFireOutcome,
    workItemId: row.work_item_id,
    reason: row.reason,
  };
}

function ruleColumns(input: IntakeRulePatch): Partial<RuleRow> {
  return {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.triggerKind !== undefined ? { trigger_kind: input.triggerKind } : {}),
    ...(input.triggerConfig !== undefined ? { trigger_config: input.triggerConfig } : {}),
    ...(input.actionKind !== undefined ? { action_kind: input.actionKind } : {}),
    ...(input.actionConfig !== undefined ? { action_config: input.actionConfig } : {}),
    ...(input.policyKind !== undefined ? { policy_kind: input.policyKind } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
  };
}

const notFound = () => new IntakeRuleError('intake_rule_not_found', 'Intake rule not found.');
const conflict = () =>
  new IntakeRuleError('intake_rule_conflict', 'The intake rule changed since it was read. Reload and try again.');

export class IntakeRulesStorage extends FactoryStorageDomain {
  constructor() {
    super('intake-rules');
  }

  async init(): Promise<void> {
    await this.ensureCollections([INTAKE_RULES_SCHEMA, INTAKE_RULE_FIRES_SCHEMA]);
  }

  async dangerouslyClearAll(): Promise<void> {
    await this.ops.deleteMany(INTAKE_RULE_FIRES_SCHEMA.name, {});
    await this.ops.deleteMany(INTAKE_RULES_SCHEMA.name, {});
  }

  /** A project's rules, oldest first. */
  async list(scope: IntakeRuleScope): Promise<IntakeRuleRecord[]> {
    const rows = await this.ops.findMany<RuleRow>(
      INTAKE_RULES_SCHEMA.name,
      { org_id: scope.orgId, factory_project_id: scope.factoryProjectId },
      { orderBy: [['created_at', 'asc'], ['id', 'asc']] },
    );
    return rows.map(toRule);
  }

  /** Every rule in every project, to re-arm triggers at boot. */
  async listAll(): Promise<IntakeRuleRecord[]> {
    return (await this.ops.findMany<RuleRow>(INTAKE_RULES_SCHEMA.name, {})).map(toRule);
  }

  async get(scope: IntakeRuleScope, id: string): Promise<IntakeRuleRecord | null> {
    const row = await this.ops.findOne<RuleRow>(INTAKE_RULES_SCHEMA.name, {
      id,
      org_id: scope.orgId,
      factory_project_id: scope.factoryProjectId,
    });
    return row ? toRule(row) : null;
  }

  /** By id alone: a fired trigger carries only the rule's id. */
  async getById(id: string): Promise<IntakeRuleRecord | null> {
    const row = await this.ops.findOne<RuleRow>(INTAKE_RULES_SCHEMA.name, { id });
    return row ? toRule(row) : null;
  }

  async create(
    scope: IntakeRuleScope,
    input: IntakeRuleInput,
    actor: string,
    now: Date = new Date(),
  ): Promise<IntakeRuleRecord> {
    const row = await this.ops.insertOne<RuleRow>(INTAKE_RULES_SCHEMA.name, {
      org_id: scope.orgId,
      factory_project_id: scope.factoryProjectId,
      ...ruleColumns(input),
      revision: 1,
      created_by: actor,
      created_at: now,
      updated_by: actor,
      updated_at: now,
    });
    return toRule(row);
  }

  /** Applies `patch` when the rule is still at `expectedRevision`; refuses a stale edit. */
  async update(
    scope: IntakeRuleScope,
    id: string,
    patch: IntakeRulePatch,
    options: { expectedRevision: number; actor: string; now?: Date },
  ): Promise<IntakeRuleRecord> {
    let stale = false;
    const row = await this.ops.updateAtomic<RuleRow>(
      INTAKE_RULES_SCHEMA.name,
      { id, org_id: scope.orgId, factory_project_id: scope.factoryProjectId },
      current => {
        if (Number(current.revision) !== options.expectedRevision) {
          stale = true;
          return null;
        }
        return {
          ...ruleColumns(patch),
          revision: Number(current.revision) + 1,
          updated_by: options.actor,
          updated_at: options.now ?? new Date(),
        };
      },
    );
    if (!row) throw notFound();
    if (stale) throw conflict();
    return toRule(row);
  }

  /** Removes the rule and its fire log; what it filed stays. */
  async delete(scope: IntakeRuleScope, id: string, options: { expectedRevision: number }): Promise<IntakeRuleRecord> {
    const current = await this.get(scope, id);
    if (!current) throw notFound();
    if (current.revision !== options.expectedRevision) throw conflict();
    await this.ops.deleteMany(INTAKE_RULE_FIRES_SCHEMA.name, { rule_id: id });
    await this.ops.deleteMany(INTAKE_RULES_SCHEMA.name, {
      id,
      org_id: scope.orgId,
      factory_project_id: scope.factoryProjectId,
    });
    return current;
  }

  async recordFire(input: Omit<IntakeRuleFireRecord, 'id'>): Promise<IntakeRuleFireRecord> {
    const row = await this.ops.insertOne<FireRow>(INTAKE_RULE_FIRES_SCHEMA.name, {
      org_id: input.orgId,
      factory_project_id: input.factoryProjectId,
      rule_id: input.ruleId,
      fired_at: input.firedAt,
      trigger_kind: input.triggerKind,
      outcome: input.outcome,
      work_item_id: input.workItemId,
      reason: input.reason,
    });
    return toFire(row);
  }

  /** A rule's fires, newest first. */
  async listFires(scope: IntakeRuleScope, ruleId: string, options: { limit?: number } = {}): Promise<IntakeRuleFireRecord[]> {
    const rows = await this.ops.findMany<FireRow>(
      INTAKE_RULE_FIRES_SCHEMA.name,
      { org_id: scope.orgId, factory_project_id: scope.factoryProjectId, rule_id: ruleId },
      { orderBy: [['fired_at', 'desc'], ['id', 'desc']], limit: options.limit ?? 20 },
    );
    return rows.map(toFire);
  }

  /** The last fire whose action made a card: what an overlap policy checks. */
  async lastFireWithWorkItem(ruleId: string): Promise<IntakeRuleFireRecord | null> {
    // Actions that made no card (a future `notify`) leave `work_item_id` empty; look past a few of those.
    const rows = await this.ops.findMany<FireRow>(
      INTAKE_RULE_FIRES_SCHEMA.name,
      { rule_id: ruleId, outcome: 'done' },
      { orderBy: [['fired_at', 'desc'], ['id', 'desc']], limit: 20 },
    );
    const withCard = rows.find(candidate => candidate.work_item_id !== null);
    return withCard ? toFire(withCard) : null;
  }
}
