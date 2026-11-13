import { intakeSourceCondition, readIntakeSource } from '@factory/core/boards/intake-sources';
import type { IntakeSourceDescriptor, IntakeSourceRegistry } from '@factory/core/boards/intake-sources';
import type { RuleCondition, RuleGroup } from '@factory/core/rules/rule-group';

import type { CardRuleGroup } from '../../../../api/types';
import { INTAKE_SOURCES } from './intakeSources';

/** The integrations an intake route can tell apart in v4. */
export const ROUTE_INTEGRATIONS = ['github', 'gitlab', 'clickup'] as const;
export type RouteIntegration = (typeof ROUTE_INTEGRATIONS)[number];

/** What kind of record a card came from (`source.kind`). A route «За розкладом» places its own cards, so it needs none. */
export const ROUTE_SOURCE_KINDS = ['issue', 'pull_request', 'task'] as const;
export type RouteSourceKind = (typeof ROUTE_SOURCE_KINDS)[number];

/**
 * One condition the settings form can edit. Every route condition is one of these, joined by AND;
 * anything else (OR, nested groups, other fields or operators) is kept as written but not edited here.
 */
export type RouteCondition =
  | { field: 'source.integration'; value: RouteIntegration[] }
  | { field: 'source.kind'; value: RouteSourceKind }
  | { field: 'author.trusted'; value: boolean }
  | { field: 'item.labels'; value: string }
  | { field: 'item.title'; value: string }
  /** The ClickUp List a task lives in (its id): a route with this condition imports the List's tasks. */
  | { field: 'source.list'; value: string }
  /** A fact the provider reports, matched whole and case-insensitively. */
  | { field: RouteTextFact; value: string };

/**
 * Provider facts matched whole: where an item lives (`acme/app`, `acme/platform/api`), its key
 * (`acme/app#42`), its state (`open`), and who it is assigned to (any one assignee).
 */
export const ROUTE_TEXT_FACTS = ['source.repository', 'item.key', 'item.state', 'item.assignees'] as const;
export type RouteTextFact = (typeof ROUTE_TEXT_FACTS)[number];
const isTextFact = (field: string): field is RouteTextFact => (ROUTE_TEXT_FACTS as readonly string[]).includes(field);

export type RouteConditionField = RouteCondition['field'];


const isIntegration = (value: unknown): value is RouteIntegration =>
  typeof value === 'string' && (ROUTE_INTEGRATIONS as readonly string[]).includes(value);
const isSourceKind = (value: unknown): value is RouteSourceKind =>
  typeof value === 'string' && (ROUTE_SOURCE_KINDS as readonly string[]).includes(value);

function readCondition(condition: CardRuleGroup['conditions'][number]): RouteCondition | undefined {
  if (!('field' in condition)) return undefined;
  const { field, operator, value } = condition;
  if (field === 'source.integration') {
    if (operator === 'equals' && isIntegration(value)) return { field, value: [value] };
    if (operator === 'in' && Array.isArray(value) && value.length > 0 && value.every(isIntegration)) {
      return { field, value: [...value] };
    }
  }
  if (field === 'source.kind' && operator === 'equals' && isSourceKind(value)) return { field, value };
  if (field === 'author.trusted' && operator === 'equals' && typeof value === 'boolean') return { field, value };
  if ((field === 'item.labels' || field === 'item.title') && operator === 'contains' && typeof value === 'string') {
    return { field, value };
  }
  if (field === 'source.list' && operator === 'equals' && typeof value === 'string') return { field, value };
  if (isTextFact(field) && operator === 'equals' && typeof value === 'string') return { field, value };
  return undefined;
}

/**
 * The form's conditions for a route's `when`: `[]` matches every card, `undefined` means the
 * condition can't be edited here and has to be kept as it is.
 */
export function readRouteConditions(when: CardRuleGroup | null): RouteCondition[] | undefined {
  if (!when) return [];
  if (when.operator !== 'AND') return undefined;
  const conditions: RouteCondition[] = [];
  for (const condition of when.conditions) {
    const read = readCondition(condition);
    if (!read) return undefined;
    conditions.push(read);
  }
  return conditions;
}

/** A closed issue's reason a route on «задачу закрито» can require (`event.reason`). */
export const ROUTE_CLOSE_REASONS = ['completed', 'canceled'] as const;
export type RouteCloseReason = (typeof ROUTE_CLOSE_REASONS)[number];

/**
 * What the route editor edits of a card-arrival route: its source («Коли»), the reason a close must
 * have, and the conditions on the source's own fields. The source is chosen once; it is not a
 * condition of its own.
 */
export interface RouteWhenModel {
  /** The source the route names (its `source.integration` condition), or «будь-яке джерело». */
  source: IntakeSourceDescriptor;
  closeReason: RouteCloseReason | null;
  conditions: RouteCondition[];
}

const isCloseReason = (value: unknown): value is RouteCloseReason =>
  typeof value === 'string' && (ROUTE_CLOSE_REASONS as readonly string[]).includes(value);

/**
 * A route's `when` as the editor reads it; undefined when it holds something the editor can't show
 * (OR, nested groups, other fields or operators, a source condition naming no one source) — the
 * route then keeps it exactly as written.
 */
export function readRouteWhen(sources: IntakeSourceRegistry, when: CardRuleGroup | null): RouteWhenModel | undefined {
  if (when && when.operator !== 'AND') return undefined;
  const read = readIntakeSource(sources, when as RuleGroup | null);
  if (!read) return undefined;
  let closeReason: RouteCloseReason | null = null;
  const conditions: RouteCondition[] = [];
  for (const condition of read.rest as CardRuleGroup['conditions']) {
    if (
      'field' in condition &&
      condition.field === 'event.reason' &&
      condition.operator === 'equals' &&
      isCloseReason(condition.value)
    ) {
      if (closeReason) return undefined;
      closeReason = condition.value;
      continue;
    }
    const parsed = readCondition(condition);
    if (!parsed || parsed.field === 'source.integration') return undefined;
    conditions.push(parsed);
  }
  return { source: read.source, closeReason, conditions };
}

/** A route's `when` split into the source it names («Звідки») and the conditions on that source's fields. */
interface SplitWhen {
  /** Undefined when the route names its source in a way one source can't show; its whole `when` is then the rest. */
  source: IntakeSourceDescriptor | undefined;
  rest: RuleGroup | null;
}

export function splitWhen(when: RuleGroup | null, sources: IntakeSourceRegistry = INTAKE_SOURCES): SplitWhen {
  const read = readIntakeSource(sources, when);
  if (!read) return { source: undefined, rest: when };
  // A route matching any source keeps its own top-level and/or.
  if (read.source.id === 'any') return { source: read.source, rest: when };
  if (read.rest.length === 0) return { source: read.source, rest: null };
  const only = read.rest[0];
  if (read.rest.length === 1 && only && 'conditions' in only) return { source: read.source, rest: only };
  return { source: read.source, rest: { operator: 'AND', conditions: [...read.rest] } };
}

/** The `when` a source and the conditions on its fields stand for: the source's condition goes first. */
export function joinWhen(source: IntakeSourceDescriptor | undefined, rest: RuleGroup | null): RuleGroup | null {
  const named = source && intakeSourceCondition(source);
  if (!named) return rest;
  if (!rest) return { operator: 'AND', conditions: [named] };
  if (rest.operator === 'AND') return { operator: 'AND', conditions: [named, ...rest.conditions] };
  return { operator: 'AND', conditions: [named, rest] };
}

/** `rule` without the conditions on fields outside `fields`; groups left empty drop out. */
export function pruneRule(rule: RuleGroup | null, fields: ReadonlySet<string>): RuleGroup | null {
  if (!rule) return null;
  const conditions = rule.conditions.flatMap((member): (RuleCondition | RuleGroup)[] => {
    if ('conditions' in member) {
      const kept = pruneRule(member, fields);
      return kept ? [kept] : [];
    }
    return fields.has(member.field) ? [member] : [];
  });
  return conditions.length > 0 ? { ...rule, conditions } : null;
}
