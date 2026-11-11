import {
  IntakeConfigError,
  IntakeError,
  IntakeTargetError,
  IntakeTriggerUnavailableError,
  IntakeUnknownKindError,
} from '@factory/core';
import type {
  IntakeKinds,
  IntakeLocale,
  IntakeRouteFire,
  IntakeScope,
  IntakeTriggerFired,
  IntakeTriggerRoute,
  IntakeTriggerRouteKinds,
  IntakeTriggerRouteRepository,
} from '@factory/core';

/**
 * Runs trigger routes: the intake routes with a trigger of their own (ADR-0021). The engine arms
 * each route's trigger, and on every fire asks the route's policy whether it may go ahead, runs the
 * route's action at the route's target and records what happened. It depends only on core ports —
 * the kind registries and `IntakeTriggerRouteRepository` — so a new trigger, action or policy kind
 * is registered in the composition root and the engine stays as it is.
 *
 * A fire carrying a `fireKey` (a scheduler claim, an event id) is handled once: a redelivered fire
 * returns the fire already recorded for that key, and the action is keyed by it too.
 */

export interface IntakeTriggerEngineOptions {
  routes: IntakeTriggerRouteRepository;
  kinds: IntakeKinds;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
  now?: () => Date;
}

export interface IntakeKindListing {
  kind: string;
  label: string;
}

export interface IntakeTriggerPreview {
  summary: string;
  nextFires: Date[];
  problems: string[];
}

/** What the settings show of a trigger route: its parts in words, its next fires and its last one. */
export interface IntakeTriggerInspection {
  triggerSummary: string;
  actionSummary: string;
  policySummary: string;
  nextFires: Date[];
  lastFire: IntakeRouteFire | null;
  problems: string[];
}

const NEXT_FIRES = 3;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class IntakeTriggerEngine {
  readonly #kinds: IntakeKinds;
  readonly #routes: IntakeTriggerRouteRepository;
  readonly #logger: NonNullable<IntakeTriggerEngineOptions['logger']>;
  readonly #now: () => Date;
  #started = false;

  constructor(options: IntakeTriggerEngineOptions) {
    this.#kinds = options.kinds;
    this.#routes = options.routes;
    this.#logger = options.logger ?? {
      warn: (message, meta) => console.warn(`[intake-triggers] ${message}`, meta ?? {}),
    };
    this.#now = options.now ?? (() => new Date());
  }

  /** Connects every trigger kind to the engine, once. */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    for (const trigger of this.#kinds.triggers.list()) await trigger.start(fired => this.fire(fired).then(() => undefined));
  }

  /** Arms every stored trigger route at boot. One route that can't be armed doesn't stop the rest. */
  async armAll(): Promise<void> {
    for (const route of await this.#routes.listTriggerRoutes()) {
      try {
        await this.sync(route);
      } catch (error) {
        this.#logger.warn('could not arm a trigger route', { routeId: route.id, error: errorMessage(error) });
      }
    }
  }

  listKinds(locale: IntakeLocale): { triggers: IntakeKindListing[]; actions: IntakeKindListing[]; policies: IntakeKindListing[] } {
    const listing = (kinds: readonly { kind: string; label: Record<IntakeLocale, string> }[]) =>
      kinds.map(kind => ({ kind: kind.kind, label: kind.label[locale] }));
    return {
      triggers: listing(this.#kinds.triggers.list()),
      actions: listing(this.#kinds.actions.list()),
      policies: listing(this.#kinds.policies.list()),
    };
  }

  /** Checks a trigger route's kinds and configs before it is written; throws an `IntakeError`. */
  async validate(route: IntakeTriggerRouteKinds, scope: IntakeScope): Promise<void> {
    const trigger = this.#kinds.triggers.get(route.trigger.kind);
    if (!trigger) throw new IntakeUnknownKindError('trigger', route.trigger.kind);
    const action = this.#kinds.actions.get(route.action.kind);
    if (!action) throw new IntakeUnknownKindError('action', route.action.kind);
    if (!this.#kinds.policies.get(route.policyKind)) throw new IntakeUnknownKindError('policy', route.policyKind);
    trigger.parse(route.trigger.config);
    const problems = (await action.problems?.({ ...scope, target: route.target }, action.parse(route.action.config))) ?? [];
    if (problems.length > 0) throw new IntakeTargetError(problems.join(' '));
  }

  /**
   * Makes the route's trigger match the stored route: armed while it is enabled, stopped when it is
   * paused. `previousTriggerKind` stops the old trigger when an edit changed the kind.
   */
  async sync(route: IntakeTriggerRoute, previousTriggerKind?: string): Promise<void> {
    const trigger = this.#kinds.triggers.get(route.trigger.kind);
    if (!trigger) throw new IntakeUnknownKindError('trigger', route.trigger.kind);
    const config = trigger.parse(route.trigger.config);
    await this.#triggerCall(route.enabled ? 'armed' : 'stopped', async () => {
      if (previousTriggerKind && previousTriggerKind !== route.trigger.kind) {
        await this.#kinds.triggers.get(previousTriggerKind)?.disarm(route.id);
      }
      if (route.enabled) await trigger.arm(route, config);
      else await trigger.disarm(route.id);
    });
  }

  /** Stops a deleted route's trigger (or one that is no longer a trigger route). */
  async remove(routeId: string, triggerKind: string): Promise<void> {
    await this.#triggerCall('stopped', async () => {
      await this.#kinds.triggers.get(triggerKind)?.disarm(routeId);
    });
  }

  async #triggerCall(what: 'armed' | 'stopped', call: () => Promise<void>): Promise<void> {
    try {
      await call();
    } catch (error) {
      if (error instanceof IntakeError) throw error;
      throw new IntakeTriggerUnavailableError(`The route's trigger could not be ${what}: ${errorMessage(error)}`);
    }
  }

  /**
   * One fire: policy, then action, then the record. The route's own errors are recorded as a
   * `failed` fire, never thrown: a trigger keeps firing the next time. Returns null when the route
   * is gone (its trigger is stopped then).
   */
  async fire(fired: IntakeTriggerFired): Promise<IntakeRouteFire | null> {
    if (fired.fireKey) {
      const recorded = await this.#routes.findFire(fired.routeId, fired.fireKey);
      if (recorded) return recorded;
    }
    const route = await this.#routes.getTriggerRoute(fired.routeId);
    if (!route) {
      // The route was deleted, or lost its trigger, under a trigger that had not heard yet: stop it.
      await this.#kinds.triggers.get(fired.triggerKind)?.disarm(fired.routeId);
      return null;
    }
    const record = (outcome: IntakeRouteFire['outcome'], workItemId: string | null, reason: string | null) =>
      this.#routes.recordFire({
        orgId: route.orgId,
        factoryProjectId: route.factoryProjectId,
        routeId: route.id,
        firedAt: fired.firedAt,
        triggerKind: fired.triggerKind,
        outcome,
        workItemId,
        reason,
        fireKey: fired.fireKey ?? null,
      });

    if (!route.enabled) return record('skipped', null, 'The route is switched off.');
    try {
      const action = this.#kinds.actions.get(route.action.kind);
      if (!action) throw new IntakeUnknownKindError('action', route.action.kind);
      const policy = this.#kinds.policies.get(route.policyKind);
      if (!policy) throw new IntakeUnknownKindError('policy', route.policyKind);
      const decision = await policy.decide({ route, fired, lastWork: await this.#routes.lastDoneFire(route.id) });
      if (!decision.go) return record('skipped', null, decision.reason);
      const trigger = this.#kinds.triggers.get(route.trigger.kind);
      const timeZone = trigger?.timeZone?.(trigger.parse(route.trigger.config));
      const outcome = await action.run({
        route,
        config: action.parse(route.action.config),
        fired,
        ...(timeZone ? { timeZone } : {}),
      });
      return record('done', outcome.workItemId, outcome.note ?? null);
    } catch (error) {
      this.#logger.warn('a trigger route fire failed', { routeId: route.id, error: errorMessage(error) });
      return record('failed', null, errorMessage(error));
    }
  }

  /** A trigger config in words, with its next fires, for the editor before anything is saved. */
  preview(kind: string, config: unknown, locale: IntakeLocale): IntakeTriggerPreview {
    const trigger = this.#kinds.triggers.get(kind);
    if (!trigger) return { summary: '', nextFires: [], problems: [new IntakeUnknownKindError('trigger', kind).message] };
    try {
      const parsed = trigger.parse(config);
      return {
        summary: trigger.describe(parsed, locale),
        nextFires: trigger.nextFires?.(parsed, this.#now(), NEXT_FIRES) ?? [],
        problems: [],
      };
    } catch (error) {
      if (!(error instanceof IntakeConfigError)) throw error;
      return { summary: '', nextFires: [], problems: [error.message] };
    }
  }

  /** A stored trigger route in words: what the list shows, with its problems instead of an error. */
  async inspect(route: IntakeTriggerRoute, locale: IntakeLocale): Promise<IntakeTriggerInspection> {
    const problems: string[] = [];
    const describe = <C>(
      side: 'trigger' | 'action',
      kind: { parse(config: unknown): C; describe(config: C, locale: IntakeLocale): string } | undefined,
      kindName: string,
      config: Record<string, unknown>,
    ): { summary: string; parsed?: C } => {
      if (!kind) {
        problems.push(new IntakeUnknownKindError(side, kindName).message);
        return { summary: kindName };
      }
      try {
        const parsed = kind.parse(config);
        return { summary: kind.describe(parsed, locale), parsed };
      } catch (error) {
        problems.push(errorMessage(error));
        return { summary: kindName };
      }
    };
    const trigger = this.#kinds.triggers.get(route.trigger.kind);
    const action = this.#kinds.actions.get(route.action.kind);
    const policy = this.#kinds.policies.get(route.policyKind);
    const triggerView = describe('trigger', trigger, route.trigger.kind, route.trigger.config);
    const actionView = describe('action', action, route.action.kind, route.action.config);
    if (!policy) problems.push(new IntakeUnknownKindError('policy', route.policyKind).message);
    if (action?.problems && actionView.parsed !== undefined) problems.push(...(await action.problems(route, actionView.parsed)));
    const nextFires =
      route.enabled && trigger?.nextFires && triggerView.parsed !== undefined
        ? trigger.nextFires(triggerView.parsed, this.#now(), NEXT_FIRES)
        : [];
    const [lastFire] = await this.#routes.listFires(route, route.id, { limit: 1 });
    return {
      triggerSummary: triggerView.summary,
      actionSummary: actionView.summary,
      policySummary: policy?.label[locale] ?? route.policyKind,
      nextFires,
      lastFire: lastFire ?? null,
      problems,
    };
  }
}
