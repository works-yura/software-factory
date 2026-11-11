/**
 * The seams of trigger routes (intake routes that make cards themselves): three Strategy ports, each looked up by name in its own Registry.
 *
 * - A trigger says *when* a route fires and emits `IntakeTriggerFired` to the sink it was started
 *   with. A clock (`schedule`) or a subscription to provider events (`IntakeEventSource`) drives it.
 * - A policy says *whether* a fire goes ahead (`skip-if-open`, `always`).
 * - An action says *what* a fire does: a command that returns its outcome and is idempotent per
 *   `fired.fireKey` (`create-card` now; `notify`, follow-up cards later).
 *
 * None of them knows the others; `IntakeTriggerEngine` (`@factory/runtime`) joins them, and the
 * server's composition root is the only place that names concrete kinds. A new kind is one
 * implementation of a port registered there, with its config schema and its settings form.
 */

import type { z } from 'zod';

import { IntakeConfigError } from './errors.ts';
import type {
  IntakeFireSink,
  IntakeRouteFire,
  IntakeLocale,
  IntakeTriggerRoute,
  IntakeScope,
  IntakeTriggerFired,
  LocalizedLabel,
} from './rule.ts';

interface KindBase<C> {
  readonly kind: string;
  readonly label: LocalizedLabel;
  /** The kind's config checked and typed; throws `IntakeConfigError` when it does not fit. */
  parse(config: unknown): C;
  /** The config in words, for lists and previews. */
  describe(config: C, locale: IntakeLocale): string;
}

/** A config schema as a `parse`: one place turns zod issues into the message people see. */
export function parseWith<S extends z.ZodType>(schema: S, config: unknown): z.output<S> {
  const parsed = schema.safeParse(config);
  if (parsed.success) return parsed.data;
  throw new IntakeConfigError(
    parsed.error.issues
      .map(issue => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
      .join('; '),
  );
}

/**
 * When a route fires. `start` connects the kind to the engine once; `arm` makes it fire for the
 * route from now on (idempotent: it also applies a changed config); `disarm` stops it.
 */
export interface IntakeTriggerKind<C = unknown> extends KindBase<C> {
  start(sink: IntakeFireSink): void | Promise<void>;
  arm(route: IntakeTriggerRoute, config: C): Promise<void>;
  disarm(routeId: string): Promise<void>;
  /** The next fire times after `after`, for a trigger with a clock; absent for event triggers. */
  nextFires?(config: C, after: Date, count: number): Date[];
  /** The timezone a fire's `{date}` and `{time}` are written in. */
  timeZone?(config: C): string | undefined;
}

export interface IntakeActionContext<C> {
  route: IntakeTriggerRoute;
  config: C;
  fired: IntakeTriggerFired;
  timeZone?: string;
}

/** What one fire's action did: the card it made, when it made one. */
export interface IntakeActionOutcome {
  workItemId: string | null;
  note?: string;
}

/**
 * What a fire does: a command. `run` must be idempotent for a fire that carries a `fireKey`: a
 * redelivered fire (a retried workflow step after a crash) returns what the first delivery made.
 */
export interface IntakeActionKind<C = unknown> extends KindBase<C> {
  /** Why the route cannot run as configured right now (its target board is gone); empty when it can. */
  problems?(route: IntakeScope & Pick<IntakeTriggerRoute, 'target'>, config: C): Promise<string[]>;
  run(context: IntakeActionContext<C>): Promise<IntakeActionOutcome>;
}

export interface IntakePolicyContext {
  route: IntakeTriggerRoute;
  fired: IntakeTriggerFired;
  /** The last fire whose action made a card, if any. */
  lastWork: IntakeRouteFire | null;
}

/** Whether a fire goes ahead: `{ go: false, reason }` records it as skipped. */
export type IntakePolicyDecision = { go: true } | { go: false; reason: string };

export interface IntakePolicyKind {
  readonly kind: string;
  readonly label: LocalizedLabel;
  decide(context: IntakePolicyContext): Promise<IntakePolicyDecision>;
}

/** Kinds by name. Registering a name twice is a programming error. */
export class IntakeKindRegistry<K extends { readonly kind: string }> {
  readonly #kinds = new Map<string, K>();

  constructor(kinds: readonly K[] = []) {
    for (const kind of kinds) this.register(kind);
  }

  register(kind: K): this {
    if (this.#kinds.has(kind.kind)) throw new Error(`Intake kind "${kind.kind}" is already registered.`);
    this.#kinds.set(kind.kind, kind);
    return this;
  }

  get(kind: string): K | undefined {
    return this.#kinds.get(kind);
  }

  list(): K[] {
    return [...this.#kinds.values()];
  }
}

export interface IntakeKinds {
  triggers: IntakeKindRegistry<IntakeTriggerKind<any>>;
  actions: IntakeKindRegistry<IntakeActionKind<any>>;
  policies: IntakeKindRegistry<IntakePolicyKind>;
}

/** The three registries from lists of kinds. */
export function intakeKinds(kinds: {
  triggers?: readonly IntakeTriggerKind<any>[];
  actions?: readonly IntakeActionKind<any>[];
  policies?: readonly IntakePolicyKind[];
}): IntakeKinds {
  return {
    triggers: new IntakeKindRegistry(kinds.triggers ?? []),
    actions: new IntakeKindRegistry(kinds.actions ?? []),
    policies: new IntakeKindRegistry(kinds.policies ?? []),
  };
}
