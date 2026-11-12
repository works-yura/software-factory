/**
 * Settings › Підключення: one list of what a Factory's agents connect to, whatever runs underneath.
 *
 * Every connection — the organization's accounts and this Factory's links alike — arrives as a
 * {@link ConnectionView} from `/web/connections`, and every connector with its connect methods from
 * `/web/connections/methods` (ADR-0035): names, logo keys, states, actions and every string are the
 * server's. This module only filters what the server sent; it knows no provider.
 */

import type { ConnectorView } from '@factory/contracts';

/** The add catalog's filter: tools agents call, sources that bring work and code, and the agents' own accounts. */
export type ConnectionCategory = 'tools' | 'sources' | 'agents';

export type CatalogFilter = 'all' | ConnectionCategory;

/** One entry of «Додати підключення»: a connector the server describes, in «Агенти», «Інтеграції» or «Інше» (MCP). */
export interface CatalogItem {
  /** `connector:<id>`. */
  id: string;
  connector: ConnectorView;
  category: ConnectionCategory;
  section: 'agents' | 'integrations' | 'other';
}

/** «Додати підключення»: every connector; the agents' accounts under «Агенти», MCP ones under «Інше». */
export function connectionCatalog(connectors: readonly ConnectorView[]): CatalogItem[] {
  return connectors.map(connector => ({
    id: `connector:${connector.id}`,
    connector,
    category: connector.category,
    section: connector.category === 'agents' ? 'agents' : connector.mcp ? 'other' : 'integrations',
  }));
}

/** The text a catalog search matches: the connector's name and line, and its methods' names and lines. */
export function catalogText(item: CatalogItem): string {
  const { connector } = item;
  return [connector.name, connector.description, ...connector.methods.flatMap(method => [method.label, method.description])]
    .filter(Boolean)
    .join(' ');
}

/** The catalog after the person's search and filter. */
export function filterCatalog(items: readonly CatalogItem[], options: { query: string; filter: CatalogFilter }): CatalogItem[] {
  const needle = options.query.trim().toLowerCase();
  return items.filter(
    item => (options.filter === 'all' || options.filter === item.category) && (!needle || catalogText(item).toLowerCase().includes(needle)),
  );
}

export interface ActivityFilter {
  fieldId: 'connection' | 'tool' | 'outcome';
  operatorId: 'is' | 'is-not' | 'contains';
  value: string | string[] | number | boolean | Array<string | number | boolean>;
}

/** Calls kept by «Фільтр запитів»: every filter must match (`is`, `is-not`, `contains`; `is` with several values matches any). */
export function filterActivity<Call extends { serverLabel: string; tool: string; outcome: 'ok' | 'error' }>(
  calls: readonly Call[],
  filters: readonly ActivityFilter[],
): Call[] {
  const field = (call: Call, fieldId: ActivityFilter['fieldId']) =>
    fieldId === 'connection' ? call.serverLabel : fieldId === 'tool' ? call.tool : call.outcome;
  return calls.filter(call =>
    filters.every(filter => {
      const actual = field(call, filter.fieldId).toLowerCase();
      const values = (Array.isArray(filter.value) ? filter.value : [filter.value]).map(value => String(value).toLowerCase());
      if (filter.operatorId === 'contains') return values.some(value => actual.includes(value));
      const hit = values.includes(actual);
      return filter.operatorId === 'is-not' ? !hit : hit;
    }),
  );
}
