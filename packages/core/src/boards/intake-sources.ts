import type { RuleCondition, RuleGroup } from '../rules/rule-group.ts';

/**
 * Where an intake route's cards come from, as the route editor shows it: the route's «Коли» is a
 * **source** and an **event** of that source, and its conditions are only the fields that source
 * has. A source is a descriptor in a registry the composition root builds
 * (`createIntakeSourceRegistry`), so a new tracker (Jira, Linear) is one descriptor — the editor,
 * the route summary and the reading of stored routes stay as they are.
 *
 * A route names its source with one `source.integration` condition (`equals` one integration,
 * `not_exists` for Factory's own cards), or not at all («будь-яке джерело»): the card's source.
 * Stored routes were rewritten into that form once (boot migration `intake.canonicalRoutes.v1`), so
 * what a route reads as is what it does — nothing is inferred from its other conditions or events.
 * An event (a pull request merged) can concern a card from any source, so a route on it that names
 * no source is «будь-яке джерело».
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
   * When a Factory uses the source: `always`, once the org has connected `integrationId`
   * (`org-connection`, a tracker), or once a repository from it is linked (`linked-repository`).
   */
  readonly availability: IntakeSourceAvailability;
  /** Sources that word their events alike share a key (GitHub and GitLab: `git`); defaults to `id`. */
  readonly wording?: string;
}

export type IntakeSourceAvailability =
  | 'always'
  | { readonly via: 'org-connection' | 'linked-repository'; readonly integrationId: string };

/** The sources a Factory can name in its routes: built once at the composition root, never changed. */
export interface IntakeSourceRegistry {
  get(id: string): IntakeSourceDescriptor | undefined;
  /** In the order the editor lists them. */
  list(): readonly IntakeSourceDescriptor[];
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
/** GitHub's fields: a repository host's, and a Dependabot alert's (`source.kind = dependabot_alert`). */
const GITHUB_FIELDS = [...REPO_HOST_FIELDS, 'alert.severity', 'alert.ecosystem', 'alert.package'];
/** The fields only a repository host's cards have: a route testing one names its host (see the migration). */
export const REPO_HOST_ONLY_FIELDS: readonly string[] = ['source.repository', 'source.kind', 'author.trusted'];

/** The sources Factory ships, in the order the editor lists them. */
export const BUILT_IN_INTAKE_SOURCES: readonly IntakeSourceDescriptor[] = [
  // A pull request event concerns the card whose session opened it, whatever its source.
  { id: 'any', events: [...REPO_HOST_EVENTS], fields: [...GENERIC_FIELDS], availability: 'always' },
  {
    id: 'clickup',
    integrations: ['clickup'],
    events: ['work_item.created', 'work_item.state_changed', 'work_item.closed'],
    fields: ['source.list', 'item.state', 'item.labels', 'item.assignees', 'item.title'],
    availability: { via: 'org-connection', integrationId: 'clickup' },
  },
  {
    id: 'github',
    integrations: ['github'],
    events: [...REPO_HOST_EVENTS],
    fields: GITHUB_FIELDS,
    availability: { via: 'linked-repository', integrationId: 'github' },
    wording: 'git',
  },
  {
    id: 'gitlab',
    integrations: ['gitlab'],
    events: [...REPO_HOST_EVENTS],
    fields: REPO_HOST_FIELDS,
    availability: { via: 'linked-repository', integrationId: 'gitlab' },
    wording: 'git',
  },
  { id: 'manual', integrations: 'none', events: ['work_item.created'], fields: [...GENERIC_FIELDS], availability: 'always' },
];

/**
 * The registry of sources: the built-ins, then `extra` (later trackers) in order. An id already
 * taken is refused, so a built-in can't be replaced by accident.
 */
export function createIntakeSourceRegistry(extra: readonly IntakeSourceDescriptor[] = []): IntakeSourceRegistry {
  const byId = new Map<string, IntakeSourceDescriptor>();
  for (const source of [...BUILT_IN_INTAKE_SOURCES, ...extra]) {
    if (byId.has(source.id)) throw new Error(`Intake source "${source.id}" is already defined.`);
    byId.set(source.id, source);
  }
  const list = Object.freeze([...byId.values()]);
  return { get: id => byId.get(id), list: () => list };
}

/** Whether a Factory uses `source`, given what its org has connected and which hosts its repositories come from. */
export function intakeSourceAvailable(
  source: IntakeSourceDescriptor,
  used: { connected: ReadonlySet<string>; hosts: ReadonlySet<string> },
): boolean {
  if (source.availability === 'always') return true;
  return source.availability.via === 'org-connection'
    ? used.connected.has(source.availability.integrationId)
    : used.hosts.has(source.availability.integrationId);
}

/** The source a `source.integration` condition names; undefined when it names none the editor shows. */
function namedSource(sources: IntakeSourceRegistry, condition: RuleCondition): IntakeSourceDescriptor | undefined {
  if (condition.operator === 'not_exists') return sources.list().find(source => source.integrations === 'none');
  if (condition.operator !== 'equals' || typeof condition.value !== 'string') return undefined;
  const value = condition.value;
  return sources.list().find(
    source => Array.isArray(source.integrations) && source.integrations.length === 1 && source.integrations[0] === value,
  );
}

/** A route's source as the editor reads it. */
export interface ReadIntakeSource {
  readonly source: IntakeSourceDescriptor;
  /** The route's other top-level conditions, in their stored order. */
  readonly rest: readonly (RuleCondition | RuleGroup)[];
}

/**
 * The source a stored route's `when` names: its `source.integration` condition, or «будь-яке
 * джерело» without one. Undefined when that condition names something the editor can't show as one
 * source (a set of integrations, an unknown one) — the route is then kept as written.
 */
export function readIntakeSource(sources: IntakeSourceRegistry, when: RuleGroup | null): ReadIntakeSource | undefined {
  const any = sources.get('any')!;
  if (!when) return { source: any, rest: [] };
  if (when.operator !== 'AND') return { source: any, rest: when.conditions };
  const rest: (RuleCondition | RuleGroup)[] = [];
  let named: IntakeSourceDescriptor | undefined;
  for (const condition of when.conditions) {
    if (!('field' in condition) || condition.field !== 'source.integration') {
      rest.push(condition);
      continue;
    }
    if (named) return undefined;
    named = namedSource(sources, condition);
    if (!named) return undefined;
  }
  return { source: named ?? any, rest };
}

/** The `source.integration` condition naming a source, or none for «будь-яке джерело». */
export function intakeSourceCondition(source: IntakeSourceDescriptor): RuleCondition | undefined {
  if (!source.integrations) return undefined;
  if (source.integrations === 'none') return { field: 'source.integration', operator: 'not_exists' };
  return { field: 'source.integration', operator: 'equals', value: source.integrations[0]! };
}
