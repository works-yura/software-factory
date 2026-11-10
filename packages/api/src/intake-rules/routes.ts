/**
 * Mastra `apiRoutes` for a project's intake rules (Settings › Intake). Reads need a signed-in user
 * of the project's organization; writes need an organization admin in tenant mode, like intake
 * routes. The bodies are generic `{ kind, config }` pairs; the engine's registries check them.
 */

import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';
import type { z } from 'zod';

import { INTAKE_TEMPLATE_PLACEHOLDERS } from '@factory/core';
import { FACTORY_ROUTE_CONTRACTS } from '@factory/contracts';
import type { IntakeRuleLocale } from '@factory/contracts';
import type { AuditEmitter } from '@factory/feed';
import { Route } from '@factory/http';
import type { RouteDependencies } from '@factory/http';
import { IntakeRuleError } from '@factory/store';
import type { FactoryProjectsStorage, IntakeRuleRecord, IntakeRuleScope, IntakeRulesStorage } from '@factory/store';

import type { IntakeRuleEngine } from './engine.ts';
import { presentFire } from './engine.ts';
import { IntakeConfigError } from './kinds.ts';

export interface IntakeRuleRoutesDeps extends RouteDependencies {
  audit: AuditEmitter;
  projects: FactoryProjectsStorage;
  storage: Pick<IntakeRulesStorage, 'list' | 'get' | 'create' | 'update' | 'delete' | 'listFires'>;
  engine: IntakeRuleEngine;
}

type Resolved = IntakeRuleScope & { userId: string };

class Refusal {
  readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 503;
  readonly body: Record<string, unknown>;

  constructor(status: Refusal['status'], body: Record<string, unknown>) {
    this.status = status;
    this.body = body;
  }
}

function loose(context: unknown): Context {
  return context as Context;
}

function issueMessage(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map(issue => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ');
}

const contracts = FACTORY_ROUTE_CONTRACTS;

export class IntakeRuleRoutes extends Route<IntakeRuleRoutesDeps> {
  async #resolve(c: Context): Promise<Resolved> {
    const { auth, projects } = this.deps;
    await auth.ensureUser(c);
    const tenant = auth.tenant(c);
    if (!tenant) throw new Refusal(401, { error: 'unauthorized' });
    if (!tenant.orgId) {
      throw new Refusal(403, { error: 'organization_required', message: 'Intake rules belong to an organization.' });
    }
    const parsed = contracts.intakeRuleList.pathSchema.safeParse({ id: c.req.param('id') });
    if (!parsed.success) throw new Refusal(404, { error: 'Project not found' });
    await projects.ensureReady();
    if (!(await projects.get({ orgId: tenant.orgId, id: parsed.data.id }))) {
      throw new Refusal(404, { error: 'Project not found' });
    }
    return { orgId: tenant.orgId, userId: tenant.userId, factoryProjectId: parsed.data.id };
  }

  async #requireAdmin(c: Context, scope: Resolved): Promise<void> {
    const { auth } = this.deps;
    if (auth.enabled() && !(await auth.isOrganizationAdmin(c, scope.orgId))) {
      throw new Refusal(403, {
        error: 'organization_admin_required',
        message: 'Organization administrator access is required to change intake rules.',
      });
    }
  }

  #locale(c: Context): IntakeRuleLocale {
    const parsed = contracts.intakeRuleList.querySchema.safeParse({ locale: c.req.query('locale') });
    return parsed.success ? (parsed.data.locale ?? 'en') : 'en';
  }

  async #body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new Refusal(400, { error: 'invalid_request', message: 'Invalid JSON body.' });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new Refusal(422, { error: 'invalid_intake_rule', message: issueMessage(parsed.error.issues) });
    return parsed.data;
  }

  #ruleId(c: Context): string {
    const parsed = contracts.intakeRuleUpdate.pathSchema.safeParse({ id: c.req.param('id'), ruleId: c.req.param('ruleId') });
    if (!parsed.success) throw new Refusal(404, { error: 'intake_rule_not_found' });
    return parsed.data.ruleId;
  }

  /** The kinds and configs check, and the action's target can take cards now. */
  async #check(rule: Pick<IntakeRuleRecord, 'triggerKind' | 'triggerConfig' | 'actionKind' | 'actionConfig' | 'policyKind'>, scope: Resolved) {
    const { engine } = this.deps;
    let parsedAction: unknown;
    try {
      parsedAction = engine.validate(rule).action;
    } catch (error) {
      if (error instanceof IntakeConfigError) throw new Refusal(422, { error: 'invalid_intake_rule', message: error.message });
      throw error;
    }
    const action = engine.kinds.actions.get(rule.actionKind)!;
    const problems =
      (await action.problems?.({ orgId: scope.orgId, factoryProjectId: scope.factoryProjectId }, parsedAction)) ?? [];
    if (problems.length > 0) throw new Refusal(422, { error: 'invalid_intake_rule', message: problems.join(' ') });
  }

  /** Arms or disarms the rule's trigger; a trigger that can't be armed is the server's problem, said loudly. */
  async #sync(rule: IntakeRuleRecord, previousTriggerKind?: string) {
    try {
      await this.deps.engine.sync(rule, previousTriggerKind);
    } catch (error) {
      throw new Refusal(503, {
        error: 'intake_trigger_unavailable',
        message: `The rule was saved, but its trigger could not be ${rule.enabled ? 'armed' : 'stopped'}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  async #audit(c: Context, scope: Resolved, action: 'created' | 'updated' | 'deleted', rule: IntakeRuleRecord) {
    await this.deps.audit.emit({
      context: c,
      input: {
        action: `factory.intake_rule.${action}`,
        factoryProjectId: scope.factoryProjectId,
        targets: [{ type: 'intake_rule', id: rule.id, name: rule.name }],
        metadata: { trigger: rule.triggerKind, action: rule.actionKind, enabled: rule.enabled },
      },
    });
  }

  #route(contract: { path: string; method: 'GET' | 'POST' | 'PATCH' | 'DELETE' }, handle: (c: Context) => Promise<Response>): ApiRoute {
    return registerApiRoute(contract.path, {
      method: contract.method,
      requiresAuth: false,
      handler: async c => {
        const context = loose(c);
        try {
          return await handle(context);
        } catch (error) {
          if (error instanceof Refusal) return context.json(error.body, error.status);
          if (error instanceof IntakeRuleError) {
            return context.json({ error: error.code, message: error.message }, error.code === 'intake_rule_not_found' ? 404 : 409);
          }
          throw error;
        }
      },
    });
  }

  routes(): ApiRoute[] {
    const { storage, engine } = this.deps;
    return [
      this.#route(contracts.intakeRuleKinds, async c => {
        await this.#resolve(c);
        const locale = this.#locale(c);
        const listing = (kinds: readonly { kind: string; label: Record<IntakeRuleLocale, string> }[]) =>
          kinds.map(kind => ({ kind: kind.kind, label: kind.label[locale] }));
        return c.json({
          triggers: listing(engine.kinds.triggers.list()),
          actions: listing(engine.kinds.actions.list()),
          policies: listing(engine.kinds.policies.list()),
          placeholders: [...INTAKE_TEMPLATE_PLACEHOLDERS],
        });
      }),

      this.#route(contracts.intakeTriggerPreview, async c => {
        await this.#resolve(c);
        const body = await this.#body(c, contracts.intakeTriggerPreview.bodySchema);
        return c.json(engine.preview(body.trigger.kind, body.trigger.config, body.locale ?? this.#locale(c)));
      }),

      this.#route(contracts.intakeRuleList, async c => {
        const scope = await this.#resolve(c);
        const locale = this.#locale(c);
        const rules = await storage.list(scope);
        return c.json({ intakeRules: await Promise.all(rules.map(rule => engine.present(rule, locale))) });
      }),

      this.#route(contracts.intakeRuleCreate, async c => {
        const scope = await this.#resolve(c);
        await this.#requireAdmin(c, scope);
        const body = await this.#body(c, contracts.intakeRuleCreate.bodySchema);
        const input = {
          name: body.name,
          triggerKind: body.trigger.kind,
          triggerConfig: body.trigger.config,
          actionKind: body.action.kind,
          actionConfig: body.action.config,
          policyKind: body.policy.kind,
          enabled: body.enabled,
        };
        await this.#check(input, scope);
        const rule = await storage.create(scope, input, scope.userId);
        await this.#audit(c, scope, 'created', rule);
        await this.#sync(rule);
        return c.json({ intakeRule: await engine.present(rule, this.#locale(c)) }, 201);
      }),

      this.#route(contracts.intakeRuleUpdate, async c => {
        const scope = await this.#resolve(c);
        await this.#requireAdmin(c, scope);
        const id = this.#ruleId(c);
        const { expectedRevision, ...patch } = await this.#body(c, contracts.intakeRuleUpdate.bodySchema);
        const current = await storage.get(scope, id);
        if (!current) throw new Refusal(404, { error: 'intake_rule_not_found' });
        const next = {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.trigger ? { triggerKind: patch.trigger.kind, triggerConfig: patch.trigger.config } : {}),
          ...(patch.action ? { actionKind: patch.action.kind, actionConfig: patch.action.config } : {}),
          ...(patch.policy ? { policyKind: patch.policy.kind } : {}),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        };
        if (patch.trigger || patch.action || patch.policy) await this.#check({ ...current, ...next }, scope);
        const rule = await storage.update(scope, id, next, { expectedRevision, actor: scope.userId });
        await this.#audit(c, scope, 'updated', rule);
        await this.#sync(rule, current.triggerKind);
        return c.json({ intakeRule: await engine.present(rule, this.#locale(c)) });
      }),

      this.#route(contracts.intakeRuleDelete, async c => {
        const scope = await this.#resolve(c);
        await this.#requireAdmin(c, scope);
        const id = this.#ruleId(c);
        const parsed = contracts.intakeRuleDelete.querySchema.safeParse({ expectedRevision: c.req.query('expectedRevision') });
        if (!parsed.success) throw new Refusal(422, { error: 'invalid_request', message: issueMessage(parsed.error.issues) });
        const current = await storage.get(scope, id);
        if (!current) throw new Refusal(404, { error: 'intake_rule_not_found' });
        if (current.revision !== parsed.data.expectedRevision) {
          throw new Refusal(409, { error: 'intake_rule_conflict', message: 'The intake rule changed since it was read. Reload and try again.' });
        }
        // Stop the trigger first: a rule that can't be stopped is not deleted, so it never fires unseen.
        await engine.remove(current);
        const rule = await storage.delete(scope, id, { expectedRevision: parsed.data.expectedRevision });
        await this.#audit(c, scope, 'deleted', rule);
        return c.body(null, 204);
      }),

      this.#route(contracts.intakeRuleFires, async c => {
        const scope = await this.#resolve(c);
        const id = this.#ruleId(c);
        if (!(await storage.get(scope, id))) throw new Refusal(404, { error: 'intake_rule_not_found' });
        return c.json({ fires: (await storage.listFires(scope, id, { limit: 20 })).map(presentFire) });
      }),
    ];
  }
}
