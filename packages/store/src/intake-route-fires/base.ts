import { FactoryStorageDomain, UniqueViolationError } from '@mastra/core/storage';
import type { CollectionSchema } from '@mastra/core/storage';

import type { IntakeFireOutcome, IntakeRouteFire, IntakeScope } from '@factory/core';

/**
 * The fire log of trigger routes (intake routes with a schedule of their own): what each fire of a
 * route did — filed a card, was held back by the route's policy, or failed. The routes themselves
 * live with the other intake routes (`StoredBoardsStorage`).
 *
 * Before routes made cards, a separate «intake rule» did (ADR-0015/0016, replaced by ADR-0021): its
 * rows stay in `factory_intake_rules` / `factory_intake_rule_fires`, read only by the boot migration
 * that turns each rule into a trigger route with the same id and copies its fires here.
 */

export type { IntakeFireOutcome, IntakeRouteFire } from '@factory/core';
export { INTAKE_FIRE_OUTCOMES } from '@factory/core';

export const INTAKE_ROUTE_FIRES_SCHEMA: CollectionSchema = {
  name: 'factory_intake_route_fires',
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    factory_project_id: { type: 'text' },
    route_id: { type: 'text' },
    fired_at: { type: 'timestamp' },
    trigger_kind: { type: 'text' },
    outcome: { type: 'text' },
    work_item_id: { type: 'text', nullable: true },
    reason: { type: 'text', nullable: true },
    /** The trigger's id for the fire; a redelivered fire carries the same one. */
    fire_key: { type: 'text', nullable: true },
  },
  indexes: [
    { name: 'factory_intake_route_fires_route_idx', columns: ['route_id', 'fired_at'] },
    { name: 'factory_intake_route_fires_key_idx', columns: ['route_id', 'fire_key'] },
  ],
};

/** Legacy: the intake rules routes replaced. Read-only, for the boot migration. */
export const LEGACY_INTAKE_RULES_SCHEMA: CollectionSchema = {
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

/** Legacy: the intake rules' fire log. Read-only, for the boot migration. */
export const LEGACY_INTAKE_RULE_FIRES_SCHEMA: CollectionSchema = {
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
    fire_key: { type: 'text', nullable: true },
  },
  indexes: [
    { name: 'factory_intake_rule_fires_rule_idx', columns: ['rule_id', 'fired_at'] },
    { name: 'factory_intake_rule_fires_key_idx', columns: ['rule_id', 'fire_key'] },
  ],
};

type Json = Record<string, unknown>;

/** A legacy intake rule as the migration reads it. */
export interface LegacyIntakeRule extends IntakeScope {
  id: string;
  name: string;
  triggerKind: string;
  triggerConfig: Json;
  actionKind: string;
  actionConfig: Json;
  policyKind: string;
  enabled: boolean;
  createdBy: string;
}

interface FireRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  factory_project_id: string;
  route_id: string;
  fired_at: Date;
  trigger_kind: string;
  outcome: string;
  work_item_id: string | null;
  reason: string | null;
  fire_key: string | null;
}

interface LegacyFireRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  factory_project_id: string;
  rule_id: string;
  fired_at: Date;
  trigger_kind: string;
  outcome: string;
  work_item_id: string | null;
  reason: string | null;
  fire_key: string | null;
}

interface LegacyRuleRow extends Record<string, unknown> {
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
  created_by: string;
}

function json(value: Json | string | null): Json {
  if (value === null) return {};
  return typeof value === 'string' ? (JSON.parse(value) as Json) : value;
}

function toFire(row: FireRow): IntakeRouteFire {
  return {
    id: row.id,
    orgId: row.org_id,
    factoryProjectId: row.factory_project_id,
    routeId: row.route_id,
    firedAt: new Date(row.fired_at),
    triggerKind: row.trigger_kind,
    outcome: row.outcome as IntakeFireOutcome,
    workItemId: row.work_item_id,
    reason: row.reason,
    fireKey: row.fire_key ?? null,
  };
}

export class IntakeRouteFiresStorage extends FactoryStorageDomain {
  constructor() {
    super('intake-route-fires');
  }

  async init(): Promise<void> {
    await this.ensureCollections([INTAKE_ROUTE_FIRES_SCHEMA, LEGACY_INTAKE_RULES_SCHEMA, LEGACY_INTAKE_RULE_FIRES_SCHEMA]);
  }

  async dangerouslyClearAll(): Promise<void> {
    await this.ops.deleteMany(INTAKE_ROUTE_FIRES_SCHEMA.name, {});
    await this.ops.deleteMany(LEGACY_INTAKE_RULE_FIRES_SCHEMA.name, {});
    await this.ops.deleteMany(LEGACY_INTAKE_RULES_SCHEMA.name, {});
  }

  /**
   * Records one fire. A fire with a key that is already recorded for the route returns that
   * record: the same fire, redelivered, is recorded once.
   */
  async recordFire(input: Omit<IntakeRouteFire, 'id'>): Promise<IntakeRouteFire> {
    if (input.fireKey) {
      const earlier = await this.findFire(input.routeId, input.fireKey);
      if (earlier) return earlier;
    }
    const row = await this.ops.insertOne<FireRow>(INTAKE_ROUTE_FIRES_SCHEMA.name, {
      org_id: input.orgId,
      factory_project_id: input.factoryProjectId,
      route_id: input.routeId,
      fired_at: input.firedAt,
      trigger_kind: input.triggerKind,
      outcome: input.outcome,
      work_item_id: input.workItemId,
      reason: input.reason,
      fire_key: input.fireKey,
    });
    return toFire(row);
  }

  async findFire(routeId: string, fireKey: string): Promise<IntakeRouteFire | null> {
    const row = await this.ops.findOne<FireRow>(INTAKE_ROUTE_FIRES_SCHEMA.name, { route_id: routeId, fire_key: fireKey });
    return row ? toFire(row) : null;
  }

  /** A route's fires, newest first. */
  async listFires(scope: IntakeScope, routeId: string, options: { limit?: number } = {}): Promise<IntakeRouteFire[]> {
    const rows = await this.ops.findMany<FireRow>(
      INTAKE_ROUTE_FIRES_SCHEMA.name,
      { org_id: scope.orgId, factory_project_id: scope.factoryProjectId, route_id: routeId },
      { orderBy: [['fired_at', 'desc'], ['id', 'desc']], ...(options.limit ? { limit: options.limit } : {}) },
    );
    return rows.map(toFire);
  }

  /** The route's last fire that went ahead (`done`): what an overlap policy checks. */
  async lastDoneFire(routeId: string): Promise<IntakeRouteFire | null> {
    const rows = await this.ops.findMany<FireRow>(
      INTAKE_ROUTE_FIRES_SCHEMA.name,
      { route_id: routeId, outcome: 'done' },
      { orderBy: [['fired_at', 'desc'], ['id', 'desc']], limit: 1 },
    );
    return rows[0] ? toFire(rows[0]) : null;
  }

  /** Forgets a deleted route's fires. */
  async deleteFires(routeId: string): Promise<void> {
    await this.ops.deleteMany(INTAKE_ROUTE_FIRES_SCHEMA.name, { route_id: routeId });
  }

  /** Legacy: every intake rule left from before routes made cards (read by the boot migration). */
  async listLegacyRules(): Promise<LegacyIntakeRule[]> {
    const rows = await this.ops.findMany<LegacyRuleRow>(LEGACY_INTAKE_RULES_SCHEMA.name, {});
    return rows.map(row => ({
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
      createdBy: row.created_by,
    }));
  }

  /**
   * Legacy: copies a rule's fires into the route fire log under the route with the rule's id. Each
   * copy keeps the original row's id, so a rerun copies nothing twice. Returns how many it copied.
   */
  async copyLegacyFires(ruleId: string): Promise<number> {
    const rows = await this.ops.findMany<LegacyFireRow>(LEGACY_INTAKE_RULE_FIRES_SCHEMA.name, { rule_id: ruleId });
    let copied = 0;
    for (const row of rows) {
      if (await this.ops.findOne<FireRow>(INTAKE_ROUTE_FIRES_SCHEMA.name, { id: row.id })) continue;
      // Another replica may copy the same fire between the check and the insert: the fire's id is
      // the primary key, so the loser's insert is refused and the fire is already there.
      try {
        await this.ops.insertOne<FireRow>(INTAKE_ROUTE_FIRES_SCHEMA.name, {
          id: row.id,
          org_id: row.org_id,
          factory_project_id: row.factory_project_id,
          route_id: ruleId,
          fired_at: row.fired_at,
          trigger_kind: row.trigger_kind,
          outcome: row.outcome,
          work_item_id: row.work_item_id,
          reason: row.reason,
          fire_key: row.fire_key ?? null,
        });
      } catch (error) {
        if (error instanceof UniqueViolationError) continue;
        throw error;
      }
      copied += 1;
    }
    return copied;
  }

  /** Legacy: removes a migrated rule (its fires were copied first). */
  async deleteLegacyRule(ruleId: string): Promise<void> {
    await this.ops.deleteMany(LEGACY_INTAKE_RULE_FIRES_SCHEMA.name, { rule_id: ruleId });
    await this.ops.deleteMany(LEGACY_INTAKE_RULES_SCHEMA.name, { id: ruleId });
  }
}
