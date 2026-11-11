import type { RuleCondition, RuleGroup } from '@factory/core';
import type {
  FactoryProjectsStorage,
  SourceControlStorage,
  StoredBoardsStorage,
  StoredIntakeRouteRecord,
} from '@factory/store';

/** The actor on the routes the canonical rewrite changes or adds. */
export const CANONICAL_ROUTES_ACTOR = 'system:canonical-routes';

const REPOSITORY_HOSTS = ['github', 'gitlab'] as const;
/** Facts only a repository host's cards have (`source.repository`, `source.kind`, `author.trusted`). */
const REPO_HOST_ONLY_FIELDS = new Set(['source.repository', 'source.kind', 'author.trusted']);
const POSITIVE = new Set(['equals', 'in']);

type RoutesStore = Pick<StoredBoardsStorage, 'listIntakeRoutes' | 'updateIntakeRoute' | 'createIntakeRoute' | 'reorderIntakeRoutes'>;

const isLeaf = (condition: RuleCondition | RuleGroup): condition is RuleCondition => 'field' in condition;

/**
 * The sources a stored route stands for, when it isn't in the one-source form: a
 * `source.integration in [...]` set of repository hosts, or no source named but a positive condition
 * on a fact only one kind of source has (a ClickUp List → ClickUp, fixed; a repository, a pull request
 * kind or an author's trust → the repository hosts). Undefined when the route already names one
 * source, or names none and stands for any source (a route on a pull request event alone: that
 * concerns a card from any source, so it stays «будь-яке джерело»).
 */
function hostsOf(
  route: StoredIntakeRouteRecord,
): { hosts: string[]; rest: (RuleCondition | RuleGroup)[]; fixed?: true } | undefined {
  const when = route.when;
  if (!when || when.operator !== 'AND') return undefined;
  const sourceConditions = when.conditions.filter(
    (condition): condition is RuleCondition => isLeaf(condition) && condition.field === 'source.integration',
  );
  const rest = when.conditions.filter(condition => !(isLeaf(condition) && condition.field === 'source.integration'));
  if (sourceConditions.length > 1) return undefined;
  const [named] = sourceConditions;
  if (named) {
    if (named.operator !== 'in' || !Array.isArray(named.value)) return undefined;
    const hosts = named.value.filter((value): value is string => typeof value === 'string');
    return hosts.length > 0 && hosts.every(host => (REPOSITORY_HOSTS as readonly string[]).includes(host))
      ? { hosts, rest }
      : undefined;
  }
  const positive = (field: string) =>
    rest.some(condition => isLeaf(condition) && condition.field === field && POSITIVE.has(condition.operator));
  if (positive('source.list')) return { hosts: ['clickup'], rest, fixed: true };
  const hostOnly = [...REPO_HOST_ONLY_FIELDS].some(positive);
  return hostOnly ? { hosts: [...REPOSITORY_HOSTS], rest } : undefined;
}

const named = (host: string, rest: (RuleCondition | RuleGroup)[]): RuleGroup => ({
  operator: 'AND',
  conditions: [{ field: 'source.integration', operator: 'equals', value: host }, ...rest],
});

/**
 * Rewrites a project's stored routes into the one-source form the route editor reads (ADR-0022):
 * a route standing for several repository hosts names the ones the Factory has linked repositories
 * from (GitHub only, for a project without GitLab); when it has both, the route is split into one per
 * host, the second right after the first, so the order — and so placement — is kept. A host-only
 * route on a Factory with no linked repository names GitHub, the first host, which changes nothing
 * it matches today. Trigger routes and routes already in that form are left alone. Idempotent.
 */
export async function canonicalizeProjectRoutes({
  boards,
  scope,
  linkedHosts,
}: {
  boards: RoutesStore;
  scope: { orgId: string; factoryProjectId: string };
  linkedHosts: ReadonlySet<string>;
}): Promise<{ rewritten: number; added: number }> {
  let rewritten = 0;
  let added = 0;
  const routes = await boards.listIntakeRoutes(scope);
  const order = routes.map(route => route.id);
  for (const route of routes) {
    if (route.trigger) continue;
    const found = hostsOf(route);
    if (!found) continue;
    const linked = found.fixed ? found.hosts : found.hosts.filter(host => linkedHosts.has(host));
    const hosts = linked.length > 0 ? linked : [found.hosts[0]!];
    await boards.updateIntakeRoute(
      scope,
      route.id,
      { when: named(hosts[0]!, found.rest) },
      { expectedRevision: route.revision, actor: CANONICAL_ROUTES_ACTOR },
    );
    rewritten += 1;
    let after = route.id;
    for (const host of hosts.slice(1)) {
      const copy = await boards.createIntakeRoute(
        scope,
        {
          name: route.name,
          enabled: route.enabled,
          when: named(host, found.rest),
          target: route.target,
          on: route.on,
          origin: route.origin,
        },
        CANONICAL_ROUTES_ACTOR,
      );
      order.splice(order.indexOf(after) + 1, 0, copy.id);
      after = copy.id;
      added += 1;
    }
  }
  if (added > 0) {
    // A route created now lands by its own rule; put each copy right after the route it was split from.
    const current = (await boards.listIntakeRoutes(scope)).map(route => route.id);
    const ids = [...order.filter(id => current.includes(id)), ...current.filter(id => !order.includes(id))];
    await boards.reorderIntakeRoutes(scope, ids, CANONICAL_ROUTES_ACTOR);
  }
  return { rewritten, added };
}

/** {@link canonicalizeProjectRoutes} for every project, with the hosts its linked repositories come from. */
export async function migrateCanonicalRoutes({
  projects,
  sourceControl,
  boards,
}: {
  projects: Pick<FactoryProjectsStorage, 'listAll'>;
  sourceControl: Pick<SourceControlStorage, 'forIntegration'>;
  boards: RoutesStore;
}): Promise<{ rewritten: number; added: number }> {
  let rewritten = 0;
  let added = 0;
  for (const project of await projects.listAll()) {
    const scope = { orgId: project.orgId, factoryProjectId: project.id };
    const linkedHosts = new Set<string>();
    for (const host of REPOSITORY_HOSTS) {
      const connections = await sourceControl.forIntegration(host).connections.list(scope);
      if (connections.some(connection => connection.integrationId === host)) linkedHosts.add(host);
    }
    const result = await canonicalizeProjectRoutes({ boards, scope, linkedHosts });
    rewritten += result.rewritten;
    added += result.added;
  }
  return { rewritten, added };
}
