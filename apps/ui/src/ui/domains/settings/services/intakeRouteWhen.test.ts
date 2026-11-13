import { DEFAULT_INTAKE_ROUTES } from '@factory/store/boards/work-routes';
import type { RuleGroup } from '@factory/core/rules/rule-group';
import { describe, expect, it } from 'vitest';

import { joinWhen, pruneRule, readRouteWhen, splitWhen } from './intakeRouteConditions';
import { INTAKE_SOURCES } from './intakeSources';

const clickUpStatusRoute: RuleGroup = {
  operator: 'AND',
  conditions: [
    { field: 'source.integration', operator: 'equals', value: 'clickup' },
    { field: 'source.list', operator: 'equals', value: '901512345' },
    { field: 'item.state', operator: 'equals', value: 'to do' },
  ],
};

const source = (id: string) => INTAKE_SOURCES.get(id)!;

describe('a route’s source and its conditions', () => {
  it.each(DEFAULT_INTAKE_ROUTES.map(({ key, route }) => [key, route] as const))(
    'opens and saves the default route %s unchanged',
    (_key, route) => {
      const when = (route.when ?? null) as RuleGroup | null;
      const { source: named, rest } = splitWhen(when);
      expect(joinWhen(named, rest)).toEqual(when);
    },
  );

  it('reads a route as the source it names, and as any source when it names none', () => {
    expect(splitWhen(clickUpStatusRoute).source?.id).toBe('clickup');
    expect(splitWhen(clickUpStatusRoute).rest).toEqual({
      operator: 'AND',
      conditions: clickUpStatusRoute.conditions.slice(1),
    });
    expect(splitWhen(null)).toEqual({ source: source('any'), rest: null });
    // A set of hosts is no one source: the whole condition stays editable as rows.
    const outsiders = DEFAULT_INTAKE_ROUTES.find(entry => entry.key === 'outside-authors')!.route;
    expect(splitWhen(outsiders.when as RuleGroup).source).toBeUndefined();
  });

  it('keeps an or-group after the source as its own group', () => {
    const anyLabel: RuleGroup = {
      operator: 'OR',
      conditions: [
        { field: 'item.labels', operator: 'equals', value: 'bug' },
        { field: 'item.labels', operator: 'equals', value: 'crash' },
      ],
    };
    const when = joinWhen(source('github'), anyLabel);
    expect(when).toEqual({
      operator: 'AND',
      conditions: [{ field: 'source.integration', operator: 'equals', value: 'github' }, anyLabel],
    });
    expect(splitWhen(when)).toEqual({ source: source('github'), rest: anyLabel });
    expect(joinWhen(source('manual'), null)).toEqual({
      operator: 'AND',
      conditions: [{ field: 'source.integration', operator: 'not_exists' }],
    });
  });

  it('drops the conditions a newly chosen source has no field for', () => {
    const { rest } = splitWhen(clickUpStatusRoute);
    expect(pruneRule(rest, new Set(source('github').fields))).toBeNull();
    expect(pruneRule(rest, new Set(source('clickup').fields))).toEqual(rest);
  });

  it('still reads a route’s close reason for the route summary', () => {
    const model = readRouteWhen(INTAKE_SOURCES, {
      operator: 'AND',
      conditions: [{ field: 'event.reason', operator: 'equals', value: 'canceled' }],
    })!;
    expect(model.closeReason).toBe('canceled');
  });
});
