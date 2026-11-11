/**
 * Trigger routes: the intake routes that make cards themselves. A route is «Коли → куди»; most
 * routes wait for a card to arrive from a source (ClickUp, GitHub, «Нова картка») and place it. A
 * trigger route has a trigger of its own (a schedule now, events later): each fire runs its action
 * (file a card now) at the route's own target, unless its overlap policy holds the fire back. It
 * takes no part in placing arriving cards. Trigger, action and policy are each a `kind` looked up
 * in its registry (`kinds.ts`), with its config kept as opaque JSON; the kinds own the shapes.
 * Persistence implements `IntakeTriggerRouteRepository`; the engine (`@factory/runtime`) runs fires.
 */

export const INTAKE_LOCALES = ['uk', 'en'] as const;
export type IntakeLocale = (typeof INTAKE_LOCALES)[number];

/** A label in every locale the settings speak. */
export type LocalizedLabel = Readonly<Record<IntakeLocale, string>>;

export interface IntakeScope {
  orgId: string;
  factoryProjectId: string;
}

/** A kind and its config, as a route stores it. */
export interface IntakeKindConfig {
  kind: string;
  config: Record<string, unknown>;
}

/** What a trigger route is, as the engine reads it: the stored route that has a trigger. */
export interface IntakeTriggerRoute extends IntakeScope {
  /** The intake route's id. */
  id: string;
  name: string;
  enabled: boolean;
  trigger: IntakeKindConfig;
  action: IntakeKindConfig;
  /** The overlap policy's kind, e.g. `skip-if-open`. */
  policyKind: string;
  /** Where the route's cards go. `phaseKey` null: the board's first phase. */
  target: { boardKey: string; phaseKey: string | null };
  revision: number;
  /** Who set the route up: the person whose consent its cards run under. */
  createdBy: string;
}

/** The kind-and-config part of a trigger route: what validation reads. */
export type IntakeTriggerRouteKinds = Pick<IntakeTriggerRoute, 'trigger' | 'action' | 'policyKind' | 'target'>;

/** `done`: the action ran; `skipped`: the policy held it back on purpose; `failed`: it could not run. */
export const INTAKE_FIRE_OUTCOMES = ['done', 'skipped', 'failed'] as const;
export type IntakeFireOutcome = (typeof INTAKE_FIRE_OUTCOMES)[number];

export interface IntakeRouteFire extends IntakeScope {
  id: string;
  routeId: string;
  firedAt: Date;
  /** The trigger kind that fired it (`schedule`, an event kind, …). */
  triggerKind: string;
  outcome: IntakeFireOutcome;
  /** What the action made, when it made a card. */
  workItemId: string | null;
  reason: string | null;
  /**
   * The trigger's own id for this fire (a scheduler claim, an event id): the same fire delivered
   * twice carries the same key, so it is recorded and acted on once. Null for a fire without one.
   */
  fireKey: string | null;
}

/** One fire of a route's trigger, as the trigger emits it. */
export interface IntakeTriggerFired {
  routeId: string;
  firedAt: Date;
  triggerKind: string;
  /** Stable across redeliveries of this fire; see `IntakeRouteFire.fireKey`. */
  fireKey?: string;
  /** What the trigger knows about this fire (an event's fields); template placeholders may read it. */
  payload?: Record<string, unknown>;
}

/** Where a trigger sends its fires; the engine is the only one listening. */
export type IntakeFireSink = (fired: IntakeTriggerFired) => Promise<void>;

/** The persistence the engine needs (a port; the server joins the stored routes and the fire log). */
export interface IntakeTriggerRouteRepository {
  /** A trigger route by id alone (a fire carries only the id); null when gone or no longer a trigger route. */
  getTriggerRoute(id: string): Promise<IntakeTriggerRoute | null>;
  /** Every trigger route in every project, to arm their triggers at boot. */
  listTriggerRoutes(): Promise<IntakeTriggerRoute[]>;
  recordFire(input: Omit<IntakeRouteFire, 'id'>): Promise<IntakeRouteFire>;
  /** The fire recorded under `fireKey` for the route, if any. */
  findFire(routeId: string, fireKey: string): Promise<IntakeRouteFire | null>;
  listFires(scope: IntakeScope, routeId: string, options?: { limit?: number }): Promise<IntakeRouteFire[]>;
  /** The last fire whose action made a card: what an overlap policy checks. */
  lastFireWithWorkItem(routeId: string): Promise<IntakeRouteFire | null>;
}
