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
import { INTAKE_SOURCES } from './intakeSources';

const clickUpStatusRoute = {
  when: {
    operator: 'AND',
    conditions: [
      { field: 'source.integration', operator: 'equals', value: 'clickup' },
      { field: 'source.list', operator: 'equals', value: '901512345' },
      { field: 'item.state', operator: 'equals', value: 'to do' },
    ],
  } as CardRuleGroup,
  on: ['work_item.created', 'work_item.state_changed'],
};

const read = (when: CardRuleGroup | null) => readRouteWhen(INTAKE_SOURCES, when);
const source = (id: string) => INTAKE_SOURCES.get(id)!;

describe('route editor model', () => {
  it.each(DEFAULT_INTAKE_ROUTES.map(({ key, route }) => [key, route] as const))(
    'opens and saves the default route %s unchanged',
    (_key, route) => {
      const when = (route.when ?? null) as CardRuleGroup | null;
      const model = read(when);
      // A route the editor can't show keeps its condition as written; every other one round-trips.
      if (model) expect(writeRouteWhen(model)).toEqual(when);
    },
  );

  it('reads a route as the source it names, and as any source when it names none', () => {
    expect(read({ operator: 'AND', conditions: [{ field: 'source.integration', operator: 'equals', value: 'github' }] })?.source.id).toBe(
      'github',
    );
    // Nothing is inferred: a route on a pull request event alone concerns a card from any source.
    const merged = DEFAULT_INTAKE_ROUTES.find(entry => entry.key === 'pull-request-merged')!.route;
    expect(read((merged.when ?? null) as CardRuleGroup | null)?.source.id).toBe('any');
    expect(read(null)?.source.id).toBe('any');
    // A set of hosts, as a project stores it before the canonical rewrite: kept as written, not edited.
    const outsiders = DEFAULT_INTAKE_ROUTES.find(entry => entry.key === 'outside-authors')!.route;
    expect(read(outsiders.when as CardRuleGroup)).toBeUndefined();
    // Fields the editor doesn't edit: kept as written.
    const closesIssue = DEFAULT_INTAKE_ROUTES.find(entry => entry.key === 'closes-issue')!.route;
    expect(read(closesIssue.when as CardRuleGroup)).toBeUndefined();
  });

  it('opens a ClickUp status route as ClickUp, with its List and status, and saves it unchanged', () => {
    const model = read(clickUpStatusRoute.when)!;
    expect(model.source.id).toBe('clickup');
    expect(model.conditions.map(condition => condition.field)).toEqual(['source.list', 'item.state']);
    expect(routeEventsEditable(model.source, clickUpStatusRoute.on)).toBe(true);
    expect(writeRouteWhen(model)).toEqual(clickUpStatusRoute.when);
  });

  it('keeps the close reason with the close event', () => {
    const model = read({ operator: 'AND', conditions: [{ field: 'event.reason', operator: 'equals', value: 'canceled' }] })!;
    expect(model.closeReason).toBe('canceled');
    expect(model.conditions).toEqual([]);
  });

  it('offers only the fields the chosen source has, and names the source it was switched to', () => {
    expect(conditionFieldsFor(source('clickup'))).toEqual(['source.list', 'item.state', 'item.labels', 'item.assignees', 'item.title']);
    expect(conditionFieldsFor(source('github'))).toEqual(expect.arrayContaining(['source.repository', 'source.kind', 'author.trusted']));
    expect(conditionFieldsFor(source('github'))).not.toContain('source.list');
    expect(conditionFieldsFor(source('any'))).toEqual(['item.title', 'item.labels']);

    const clickUp = read(clickUpStatusRoute.when)!;
    const github = chooseRouteSource(clickUp, source('github'));
    expect(github.conditions).toEqual([]);
    expect(writeRouteWhen(github)).toEqual({
      operator: 'AND',
      conditions: [{ field: 'source.integration', operator: 'equals', value: 'github' }],
    });
    expect(writeRouteWhen(chooseRouteSource(clickUp, source('manual')))).toEqual({
      operator: 'AND',
      conditions: [{ field: 'source.integration', operator: 'not_exists' }],
    });
    expect(writeRouteWhen(chooseRouteSource(clickUp, source('any')))).toBeNull();
  });
});
