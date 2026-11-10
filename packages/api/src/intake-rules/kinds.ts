/**
 * The seams of intake rules. A rule is a trigger, an overlap policy and an action; each is a kind
 * looked up in its own registry by the `kind` stored on the rule. Triggers only say *when* (and
 * emit a fire); actions only say *what* a fire does; policies only decide *whether* a fire goes
 * ahead. None of them knows the others: `IntakeRuleEngine` joins them.
 *
 * Adding a kind is one descriptor registered here, its config schema in `@factory/contracts`, and
 * its form in the UI — the engine, the routes and the storage stay as they are.
 */

import type { z } from 'zod';

import type { IntakeRuleLocale } from '@factory/contracts';
import type { IntakeRuleFireRecord, IntakeRuleRecord, IntakeRuleScope } from '@factory/store';

export type { IntakeRuleLocale };

/** One fire of a rule's trigger, as the trigger emits it. */
export interface IntakeTriggerFired {
  ruleId: string;
  firedAt: Date;
  triggerKind: string;
  /** What the trigger knows about this fire (an event's fields); template placeholders may read it. */
  payload?: Record<string, unknown>;
}

/** Where a trigger sends its fires; the engine is the only one listening. */
export type IntakeFireSink = (fired: IntakeTriggerFired) => Promise<void>;

/** A config that does not fit its kind; the routes answer 422 with `message`. */
export class IntakeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntakeConfigError';
  }
}

export type LocalizedLabel = Readonly<Record<IntakeRuleLocale, string>>;

interface KindBase<C> {
  readonly kind: string;
  readonly label: LocalizedLabel;
  /** The kind's config checked and typed; throws `IntakeConfigError` when it does not fit. */
  parse(config: unknown): C;
  /** The config in words, for lists and previews. */
  describe(config: C, locale: IntakeRuleLocale): string;
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
 * When a rule fires. `arm` makes the trigger fire for the rule from now on (idempotent: it also
 * applies a changed config), `disarm` stops it. A trigger reports fires through the sink it was
 * started with, carrying only the rule's id.
 */
export interface IntakeTriggerKind<C = unknown> extends KindBase<C> {
  start(sink: IntakeFireSink): void | Promise<void>;
  arm(rule: IntakeRuleRecord, config: C): Promise<void>;
  disarm(ruleId: string): Promise<void>;
  /** The next fire times after `after`, for a trigger with a clock; absent for event triggers. */
  nextFires?(config: C, after: Date, count: number): Date[];
  /** The timezone a fire's `{date}` and `{time}` are written in. */
  timeZone?(config: C): string | undefined;
}

export interface IntakeActionContext<C> {
  rule: IntakeRuleRecord;
  config: C;
  fired: IntakeTriggerFired;
  timeZone?: string;
}

/** What one fire's action did: the card it made, when it made one. */
export interface IntakeActionOutcome {
  workItemId: string | null;
  note?: string;
}

/** What a fire does. */
export interface IntakeActionKind<C = unknown> extends KindBase<C> {
  /** Why the rule cannot run as configured right now (a board that is gone); empty when it can. */
  problems?(scope: IntakeRuleScope, config: C): Promise<string[]>;
  run(context: IntakeActionContext<C>): Promise<IntakeActionOutcome>;
}

export interface IntakePolicyContext {
  rule: IntakeRuleRecord;
  fired: IntakeTriggerFired;
  /** The last fire whose action made a card, if any. */
  lastWork: IntakeRuleFireRecord | null;
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
