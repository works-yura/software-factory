import type { CardRuleGroup } from '../../../../api/types';

/** The integrations an intake route can tell apart in v4. */
export const ROUTE_INTEGRATIONS = ['github', 'gitlab', 'clickup'] as const;
export type RouteIntegration = (typeof ROUTE_INTEGRATIONS)[number];

/** What kind of record a card came from (`source.kind`). */
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
  | { field: 'item.title'; value: string };

export type RouteConditionField = RouteCondition['field'];

export const ROUTE_CONDITION_FIELDS: readonly RouteConditionField[] = [
  'source.integration',
  'source.kind',
  'author.trusted',
  'item.labels',
  'item.title',
];

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

/** The `when` the form's conditions stand for; no conditions match every card. */
export function writeRouteConditions(conditions: readonly RouteCondition[]): CardRuleGroup | null {
  const written = conditions.flatMap((condition): CardRuleGroup['conditions'] => {
    switch (condition.field) {
      case 'source.integration':
        if (condition.value.length === 0) return [];
        return condition.value.length === 1
          ? [{ field: condition.field, operator: 'equals', value: condition.value[0]! }]
          : [{ field: condition.field, operator: 'in', value: [...condition.value] }];
      case 'item.labels':
      case 'item.title': {
        const value = condition.value.trim();
        return value ? [{ field: condition.field, operator: 'contains', value }] : [];
      }
      default:
        return [{ field: condition.field, operator: 'equals', value: condition.value }];
    }
  });
  return written.length > 0 ? { operator: 'AND', conditions: written } : null;
}

/** A fresh condition for a field the form adds. */
export function defaultCondition(field: RouteConditionField): RouteCondition {
  switch (field) {
    case 'source.integration':
      return { field, value: ['clickup'] };
    case 'source.kind':
      return { field, value: 'issue' };
    case 'author.trusted':
      return { field, value: true };
    default:
      return { field, value: '' };
  }
}

/** A condition the form would drop on save: an empty tag or title, or no integration chosen. */
export function isBlankCondition(condition: RouteCondition): boolean {
  if (condition.field === 'source.integration') return condition.value.length === 0;
  if (condition.field === 'item.labels' || condition.field === 'item.title') return !condition.value.trim();
  return false;
}
