import { describe, expect, it } from 'vitest';

import {
  createIntakeSourceRegistry,
  intakeSourceAvailable,
  intakeSourceCondition,
  readIntakeSource,
} from './intake-sources.ts';

const sources = createIntakeSourceRegistry();

describe('intake sources', () => {
  it('reads the source a route names, and keeps its other conditions in order', () => {
    const read = readIntakeSource(sources, {
      operator: 'AND',
      conditions: [
        { field: 'author.trusted', operator: 'equals', value: false },
        { field: 'source.integration', operator: 'equals', value: 'github' },
      ],
    });
    expect(read?.source.id).toBe('github');
    expect(read?.rest).toEqual([{ field: 'author.trusted', operator: 'equals', value: false }]);

    expect(
      readIntakeSource(sources, { operator: 'AND', conditions: [{ field: 'source.integration', operator: 'not_exists' }] })
        ?.source.id,
    ).toBe('manual');
  });

  it('reads a route that names no source as any source, inferring nothing from its other conditions', () => {
    // A pull request event concerns a card from any source; a ClickUp List condition alone doesn't name ClickUp.
    expect(readIntakeSource(sources, null)?.source.id).toBe('any');
    const listOnly = readIntakeSource(sources, {
      operator: 'AND',
      conditions: [{ field: 'source.list', operator: 'equals', value: 'list-1' }],
    });
    expect(listOnly?.source.id).toBe('any');
    expect(listOnly?.rest).toHaveLength(1);
    expect(sources.get('any')!.events).toContain('pull_request.merged');
  });

  it('leaves a set of integrations, or two source conditions, to be kept as written', () => {
    expect(
      readIntakeSource(sources, {
        operator: 'AND',
        conditions: [{ field: 'source.integration', operator: 'in', value: ['github', 'gitlab'] }],
      }),
    ).toBeUndefined();
    expect(
      readIntakeSource(sources, {
        operator: 'AND',
        conditions: [
          { field: 'source.integration', operator: 'equals', value: 'github' },
          { field: 'source.integration', operator: 'equals', value: 'gitlab' },
        ],
      }),
    ).toBeUndefined();
  });

  it('offers no combined source: each repository host is its own', () => {
    expect(sources.list().map(source => source.id)).toEqual(['any', 'clickup', 'github', 'gitlab', 'manual']);
  });

  it('writes the condition that names a source', () => {
    expect(intakeSourceCondition(sources.get('clickup')!)).toEqual({
      field: 'source.integration',
      operator: 'equals',
      value: 'clickup',
    });
    expect(intakeSourceCondition(sources.get('manual')!)).toEqual({ field: 'source.integration', operator: 'not_exists' });
    expect(intakeSourceCondition(sources.get('any')!)).toBeUndefined();
  });

  it('says from the descriptor alone whether a Factory uses a source', () => {
    const used = { connected: new Set(['clickup']), hosts: new Set(['github']) };
    expect(sources.list().filter(source => intakeSourceAvailable(source, used)).map(source => source.id)).toEqual([
      'any',
      'clickup',
      'github',
      'manual',
    ]);
  });

  it('takes a new tracker as one descriptor at the composition root, refusing a taken id', () => {
    const withJira = createIntakeSourceRegistry([
      {
        id: 'jira',
        integrations: ['jira'],
        events: ['work_item.created', 'work_item.state_changed'],
        fields: ['source.list', 'item.state'],
        availability: { via: 'org-connection', integrationId: 'jira' },
      },
    ]);
    expect(withJira.list().map(source => source.id)).toContain('jira');
    expect(
      readIntakeSource(withJira, {
        operator: 'AND',
        conditions: [{ field: 'source.integration', operator: 'equals', value: 'jira' }],
      })?.source.id,
    ).toBe('jira');
    // The built-in registry is untouched.
    expect(sources.get('jira')).toBeUndefined();
    expect(() =>
      createIntakeSourceRegistry([{ id: 'clickup', events: [], fields: [], availability: 'always' }]),
    ).toThrow(/already defined/);
  });
});
