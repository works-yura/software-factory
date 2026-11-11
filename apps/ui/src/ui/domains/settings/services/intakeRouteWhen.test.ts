import { intakeSource } from '@factory/core/boards/intake-sources';
import { DEFAULT_INTAKE_ROUTES } from '@factory/store/boards/work-routes';
import { describe, expect, it } from 'vitest';

import type { CardRuleGroup } from '../../../../api/types';
import {
  chooseRouteSource,
  conditionFieldsFor,
  readRouteWhen,
  routeEventsEditable,
  writeRouteWhen,
} from './intakeRouteConditions';

const clickUpStatusRoute = {
  when: {
    operator: 'AND',
    conditions: [
      { field: 'source.list', operator: 'equals', value: '901512345' },
      { field: 'item.state', operator: 'equals', value: 'to do' },
    ],
  } as CardRuleGroup,
  on: ['work_item.created', 'work_item.state_changed'],
};

describe('route editor model', () => {
  it.each(DEFAULT_INTAKE_ROUTES.map(({ key, route }) => [key, route] as const))(
    'opens and saves the default route %s unchanged',
    (_key, route) => {
      const when = (route.when ?? null) as CardRuleGroup | null;
      const model = readRouteWhen(when, route.on ?? ['work_item.created']);
      // A route the editor can't show keeps its condition as written; every other one round-trips.
      if (model) expect(writeRouteWhen(model)).toEqual(when);
    },
  );

  it('reads the default routes as the sources they stand for', () => {
    const sourceOf = (key: string) => {
      const route = DEFAULT_INTAKE_ROUTES.find(entry => entry.key === key)!.route;
      return readRouteWhen((route.when ?? null) as CardRuleGroup | null, route.on ?? ['work_item.created'])?.source.id;
    };
    expect(sourceOf('outside-authors')).toBe('git');
    expect(sourceOf('pull-requests')).toBe('git');
    expect(sourceOf('pull-request-merged')).toBe('git');
    expect(sourceOf('closed-completed')).toBe('any');
    expect(sourceOf('everything-else')).toBe('any');
    // OR-free but with fields the editor doesn't edit: kept as written.
    expect(sourceOf('closes-issue')).toBeUndefined();
  });

  it('opens a ClickUp status route as ClickUp, with its List and status, and saves it unchanged', () => {
    const model = readRouteWhen(clickUpStatusRoute.when, clickUpStatusRoute.on)!;
    expect(model.source.id).toBe('clickup');
    expect(model.named).toBe(false);
    expect(model.conditions.map(condition => condition.field)).toEqual(['source.list', 'item.state']);
    expect(routeEventsEditable(model.source, clickUpStatusRoute.on)).toBe(true);
    expect(writeRouteWhen(model)).toEqual(clickUpStatusRoute.when);
  });

  it('keeps the close reason with the close event', () => {
    const model = readRouteWhen(
      { operator: 'AND', conditions: [{ field: 'event.reason', operator: 'equals', value: 'canceled' }] },
      ['work_item.closed'],
    )!;
    expect(model.closeReason).toBe('canceled');
    expect(model.conditions).toEqual([]);
  });

  it('offers only the fields the chosen source has, and names the source it was switched to', () => {
    expect(conditionFieldsFor(intakeSource('clickup')!)).toEqual([
      'source.list',
      'item.state',
      'item.labels',
      'item.assignees',
      'item.title',
    ]);
    expect(conditionFieldsFor(intakeSource('github')!)).toEqual(
      expect.arrayContaining(['source.repository', 'source.kind', 'author.trusted']),
    );
    expect(conditionFieldsFor(intakeSource('github')!)).not.toContain('source.list');
    expect(conditionFieldsFor(intakeSource('any')!)).toEqual(['item.title', 'item.labels']);

    const clickUp = readRouteWhen(clickUpStatusRoute.when, clickUpStatusRoute.on)!;
    const github = chooseRouteSource(clickUp, intakeSource('github')!);
    expect(github.conditions).toEqual([]);
    expect(writeRouteWhen(github)).toEqual({
      operator: 'AND',
      conditions: [{ field: 'source.integration', operator: 'equals', value: 'github' }],
    });
    expect(writeRouteWhen(chooseRouteSource(clickUp, intakeSource('manual')!))).toEqual({
      operator: 'AND',
      conditions: [{ field: 'source.integration', operator: 'not_exists' }],
    });
  });
});
