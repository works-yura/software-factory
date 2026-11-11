import type { RuleCondition, RuleGroup } from '../rules/rule-group.ts';

/**
 * Where an intake route's cards come from, as the route editor shows it: the route's «Коли» is a
 * **source** and an **event** of that source, and its conditions are only the fields that source
 * has. A source is a descriptor in a registry, so a new tracker (Jira, Linear) is one descriptor —
 * the editor, the route summary and the reading of stored routes stay as they are.
 *
 * Storage does not change: a route names its source with a `source.integration` condition
 * (`equals` one integration, `in` several, `not_exists` for Factory's own cards), or not at all
 * («будь-яке джерело»). A stored route without that condition still reads as the source its other
 * conditions or events imply (a `source.list` → ClickUp, a pull request event → GitHub or GitLab),
 * and is written back without one, so opening and saving a route leaves it as it was.
 *
 * A route may stand for several sources at once (`in ['github', 'gitlab']`, or a pull request event
 * with no source named): it reads as all of them, `candidates`, and the editor shows the one the
 * Factory uses — there is no combined «GitHub або GitLab» source to choose.
 */
export interface IntakeSourceDescriptor {
  /** Stable id: `any`, `clickup`, `github`, `gitlab`, `manual`, or a later tracker's. */
  readonly id: string;
  /**
   * How a route names the source: the `source.integration` values it covers, `'none'` for cards
   * made in Factory (no integration), or absent for every source.
   */
  readonly integrations?: readonly string[] | 'none';
  /** The events the source emits, in the order the editor offers them; `work_item.created` places new cards. */
  readonly events: readonly string[];
  /** The card facts a condition on this source may test, in the order the editor offers them. */
  readonly fields: readonly string[];
  /**
   * Facts or events only this source has: a stored route without a `source.integration`
   * condition but with one of these reads as this source. Sources sharing the same hint object
   * (GitHub and GitLab) are all candidates for such a route, in registration order.
   */
  readonly impliedBy?: { readonly fields?: readonly string[]; readonly events?: readonly string[] };
}

const GENERIC_FIELDS = ['item.title', 'item.labels'] as const;
const REPO_HOST_EVENTS = [
  'work_item.created',
  'work_item.closed',
  'work_item.reopened',
  'pull_request.opened',
  'pull_request.synchronized',
  'pull_request.review_requested',
  'pull_request.merged',
  'pull_request.closed',
] as const;
const REPO_HOST_FIELDS = ['source.repository', 'source.kind', 'author.trusted', 'item.labels', 'item.title', 'item.assignees'];
/** What only a repository host has: a route with one of these and no source named stands for GitHub or GitLab. */
const REPO_HOST_IMPLIED = {
  fields: ['source.repository', 'source.kind', 'author.trusted'],
  events: REPO_HOST_EVENTS.filter(event => event.startsWith('pull_request.')),
};

/** The sources Factory ships, in the order the editor lists them. */
export const BUILT_IN_INTAKE_SOURCES: readonly IntakeSourceDescriptor[] = [
  { id: 'any', events: ['work_item.created', 'work_item.closed', 'work_item.reopened'], fields: [...GENERIC_FIELDS] },
  {
    id: 'clickup',
    integrations: ['clickup'],
    events: ['work_item.created', 'work_item.state_changed', 'work_item.closed'],
    fields: ['source.list', 'item.state', 'item.labels', 'item.assignees', 'item.title'],
    impliedBy: { fields: ['source.list'], events: ['work_item.state_changed'] },
  },
  {
    id: 'github',
    integrations: ['github'],
    events: [...REPO_HOST_EVENTS],
    fields: REPO_HOST_FIELDS,
    impliedBy: REPO_HOST_IMPLIED,
  },
  {
    id: 'gitlab',
    integrations: ['gitlab'],
    events: [...REPO_HOST_EVENTS],
    fields: REPO_HOST_FIELDS,
    impliedBy: REPO_HOST_IMPLIED,
  },
  { id: 'manual', integrations: 'none', events: ['work_item.created'], fields: [...GENERIC_FIELDS] },
];

const registry = new Map<string, IntakeSourceDescriptor>();
for (const source of BUILT_IN_INTAKE_SOURCES) registry.set(source.id, source);

/** Adds a source (a later tracker); an id already taken is refused, so a built-in can't be replaced by accident. */
export function defineIntakeSource(source: IntakeSourceDescriptor): IntakeSourceDescriptor {
  if (registry.has(source.id)) throw new Error(`Intake source "${source.id}" is already defined.`);
  registry.set(source.id, source);
  return source;
}

/** Removes a source added with `defineIntakeSource` (tests). Built-ins stay. */
export function removeIntakeSource(id: string): void {
  if (BUILT_IN_INTAKE_SOURCES.some(source => source.id === id)) return;
  registry.delete(id);
}

export function intakeSource(id: string): IntakeSourceDescriptor | undefined {
  return registry.get(id);
}

export function intakeSources(): IntakeSourceDescriptor[] {
  return [...registry.values()];
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every(value => b.includes(value));
const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, at) => b[at] === value);

/**
 * The sources a leaf naming integrations stands for, in registration order: one for one
 * integration, several for a set whose sources all offer the same events and fields (GitHub and
 * GitLab). Null when the condition doesn't name a source; undefined when it names a set the editor
 * can't show as one source (it is then kept as written).
 */
function sourceLeaf(condition: RuleCondition): IntakeSourceDescriptor[] | undefined | null {
  if (condition.field !== 'source.integration') return null;
  if (condition.operator === 'not_exists') {
    const manual = intakeSources().find(source => source.integrations === 'none');
    return manual ? [manual] : undefined;
  }
  const values =
    condition.operator === 'equals' && typeof condition.value === 'string'
      ? [condition.value]
      : condition.operator === 'in' && Array.isArray(condition.value)
        ? condition.value.filter((value): value is string => typeof value === 'string')
        : undefined;
  if (!values || values.length === 0) return undefined;
  const exact = intakeSources().find(source => Array.isArray(source.integrations) && sameSet(source.integrations, values));
  if (exact) return [exact];
  const covering = intakeSources().filter(
    source =>
      Array.isArray(source.integrations) && source.integrations.length === 1 && values.includes(source.integrations[0]!),
  );
  if (covering.length !== new Set(values).size) return undefined;
  const first = covering[0]!;
  return covering.every(source => sameList(source.events, first.events) && sameList(source.fields, first.fields))
    ? covering
    : undefined;
}

/** A route's source as the editor reads it. */
export interface ReadIntakeSource {
  /** The first of `candidates`; the editor may show another candidate (the one the Factory uses). */
  readonly source: IntakeSourceDescriptor;
  /**
   * Every source the route stands for: one, or several offering the same events and fields when the
   * route names a set of them (`in ['github', 'gitlab']`) or implies them without naming one.
   */
  readonly candidates: readonly IntakeSourceDescriptor[];
  /** Whether the route names the source with its own `source.integration` condition (written back if so). */
  readonly named: boolean;
  /** That condition as stored, so an unchanged source is written back exactly as it was. */
  readonly leaf?: RuleCondition;
  /** The route's other top-level conditions, in their stored order. */
  readonly rest: readonly (RuleCondition | RuleGroup)[];
}

/**
 * The source a stored route's `when` and `on` stand for; undefined when its `source.integration`
 * condition names a set no source covers (it is then kept as written, not edited).
 */
export function readIntakeSource(
  when: RuleGroup | null,
  on: readonly string[] = ['work_item.created'],
): ReadIntakeSource | undefined {
  const any = registry.get('any')!;
  const inferred = (fields: readonly string[]): IntakeSourceDescriptor[] => {
    const candidates = inferSources(fields, on);
    return candidates.length > 0 ? candidates : [any];
  };
  if (!when) {
    const candidates = inferred([]);
    return { source: candidates[0]!, candidates, named: false, rest: [] };
  }
  if (when.operator !== 'AND') return { source: any, candidates: [any], named: false, rest: when.conditions };
  const rest: (RuleCondition | RuleGroup)[] = [];
  let named: IntakeSourceDescriptor[] | undefined;
  let namedLeaf: RuleCondition | undefined;
  for (const condition of when.conditions) {
    const leaf = 'field' in condition ? sourceLeaf(condition) : null;
    if (leaf === null || named) {
      rest.push(condition);
      continue;
    }
    if (leaf === undefined) return undefined;
    named = leaf;
    namedLeaf = condition as RuleCondition;
  }
  if (named) return { source: named[0]!, candidates: named, named: true, leaf: namedLeaf, rest };
  const candidates = inferred(rest.flatMap(condition => ('field' in condition ? [condition.field] : [])));
  return { source: candidates[0]!, candidates, named: false, rest };
}

/**
 * The sources a route's fields or events imply, in registration order: the first source whose hint
 * matches, and every other source sharing that same hint (GitHub and GitLab).
 */
function inferSources(fields: readonly string[], on: readonly string[]): IntakeSourceDescriptor[] {
  const implies = (source: IntakeSourceDescriptor) =>
    Boolean(
      source.impliedBy?.fields?.some(field => fields.includes(field)) ||
        source.impliedBy?.events?.some(event => on.includes(event)),
    );
  const first = intakeSources().find(implies);
  if (!first) return [];
  return intakeSources().filter(source => source === first || source.impliedBy === first.impliedBy);
}

/** The `source.integration` condition naming a source, or none for «будь-яке джерело». */
export function intakeSourceCondition(source: IntakeSourceDescriptor): RuleCondition | undefined {
  if (!source.integrations) return undefined;
  if (source.integrations === 'none') return { field: 'source.integration', operator: 'not_exists' };
  return source.integrations.length === 1
    ? { field: 'source.integration', operator: 'equals', value: source.integrations[0]! }
    : { field: 'source.integration', operator: 'in', value: [...source.integrations] };
}
