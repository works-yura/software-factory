import { describe, expect, it } from 'vitest';

import type { IntakeRoute } from './intake-routing.ts';
import { routedSourceScopes, routeSourceValues, routeSubscribesSource } from './intake-routing.ts';

function route(id: string, when: IntakeRoute['when'], overrides: Partial<IntakeRoute> = {}): IntakeRoute {
  return {
    id,
    name: id,
    enabled: true,
    on: ['work_item.created'],
    when,
    target: { boardKey: 'work', phaseKey: 'intake' },
    ...overrides,
  } as IntakeRoute;
}

const listIs = (operator: string, value: string | string[]) =>
  ({ operator: 'AND', conditions: [{ field: 'source.list', operator, value }] }) as IntakeRoute['when'];

describe('routes subscribe a project to source lists', () => {
  it('counts only lists a route names with equals or in', () => {
    expect(routeSourceValues(route('a', listIs('equals', 'L1')), 'source.list')).toEqual(['L1']);
    expect(routeSourceValues(route('b', listIs('in', ['L2', 'L3'])), 'source.list')).toEqual(['L2', 'L3']);
    expect(routeSourceValues(route('c', listIs('not_equals', 'L4')), 'source.list')).toEqual([]);
  });

  it('never reads a list a route only excludes', () => {
    const routes = [route('keep', listIs('equals', 'L1')), route('except', listIs('not_equals', 'L9'))];

    expect(routedSourceScopes(routes)).toEqual(['L1']);
  });

  it('reads the repositories a code host is subscribed to only from routes naming that host', () => {
    const repoRoute = (id: string, integration: string, repository: string | string[]) =>
      route(id, {
        operator: 'AND',
        conditions: [
          { field: 'source.integration', operator: 'equals', value: integration },
          { field: 'source.repository', operator: Array.isArray(repository) ? 'in' : 'equals', value: repository },
        ],
      } as IntakeRoute['when']);
    const routes = [
      repoRoute('front', 'github', 'eclipt-ai/syncta_front'),
      repoRoute('both', 'github', ['eclipt-ai/syncta_back', 'eclipt-ai/syncta_front']),
      repoRoute('lab', 'gitlab', 'acme/platform/api'),
      route('unnamed', { operator: 'AND', conditions: [{ field: 'source.repository', operator: 'equals', value: 'x/y' }] } as IntakeRoute['when']),
    ];

    expect(routedSourceScopes(routes, 'source.repository', 'github')).toEqual([
      'eclipt-ai/syncta_front',
      'eclipt-ai/syncta_back',
    ]);
    expect(routedSourceScopes(routes, 'source.repository', 'gitlab')).toEqual(['acme/platform/api']);
  });

  it('subscribes an arriving task only through an enabled route that names its list', () => {
    const routes = [route('bugs', listIs('equals', 'L1')), route('off', listIs('equals', 'L2'), { enabled: false })];

    expect(routeSubscribesSource(routes, { 'source.list': 'L1' })).toBe(true);
    expect(routeSubscribesSource(routes, { 'source.list': 'L2' })).toBe(false);
    expect(routeSubscribesSource(routes, { 'source.list': 'L3' })).toBe(false);
  });
});
