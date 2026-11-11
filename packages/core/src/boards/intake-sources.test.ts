import { afterEach, describe, expect, it } from 'vitest';

import {
  defineIntakeSource,
  intakeSource,
  intakeSourceCondition,
  intakeSources,
  readIntakeSource,
  removeIntakeSource,
} from './intake-sources.ts';

describe('intake sources', () => {
  afterEach(() => removeIntakeSource('jira'));

  it('reads the source a route names, and keeps its other conditions in order', () => {
    const read = readIntakeSource({
      operator: 'AND',
      conditions: [
        { field: 'source.integration', operator: 'in', value: ['gitlab', 'github'] },
        { field: 'author.trusted', operator: 'equals', value: false },
      ],
    });
    expect(read?.source.id).toBe('git');
    expect(read?.named).toBe(true);
    expect(read?.rest).toEqual([{ field: 'author.trusted', operator: 'equals', value: false }]);

    expect(readIntakeSource({ operator: 'AND', conditions: [{ field: 'source.integration', operator: 'not_exists' }] })?.source.id).toBe(
      'manual',
    );
  });

  it('infers the source of a route that does not name one, without naming it', () => {
    const status = readIntakeSource(
      {
        operator: 'AND',
        conditions: [
          { field: 'source.list', operator: 'equals', value: 'list-1' },
          { field: 'item.state', operator: 'equals', value: 'to do' },
        ],
      },
      ['work_item.created', 'work_item.state_changed'],
    );
    expect(status).toMatchObject({ source: { id: 'clickup' }, named: false });
    expect(status?.rest).toHaveLength(2);

    expect(readIntakeSource(null, ['pull_request.merged'])?.source.id).toBe('git');
    expect(
      readIntakeSource({ operator: 'AND', conditions: [{ field: 'source.kind', operator: 'equals', value: 'pull_request' }] })?.source.id,
    ).toBe('git');
    expect(readIntakeSource(null)?.source.id).toBe('any');
    expect(readIntakeSource(null, ['work_item.reopened'])?.source.id).toBe('any');
  });

  it('leaves a set of integrations no source covers to be kept as written', () => {
    expect(
      readIntakeSource({
        operator: 'AND',
        conditions: [{ field: 'source.integration', operator: 'in', value: ['github', 'clickup'] }],
      }),
    ).toBeUndefined();
  });

  it('writes the condition that names a source', () => {
    expect(intakeSourceCondition(intakeSource('clickup')!)).toEqual({
      field: 'source.integration',
      operator: 'equals',
      value: 'clickup',
    });
    expect(intakeSourceCondition(intakeSource('manual')!)).toEqual({ field: 'source.integration', operator: 'not_exists' });
    expect(intakeSourceCondition(intakeSource('any')!)).toBeUndefined();
  });

  it('takes a new tracker as one descriptor', () => {
    defineIntakeSource({
      id: 'jira',
      integrations: ['jira'],
      events: ['work_item.created', 'work_item.state_changed'],
      fields: ['source.list', 'item.state'],
    });
    expect(intakeSources().map(source => source.id)).toContain('jira');
    expect(
      readIntakeSource({ operator: 'AND', conditions: [{ field: 'source.integration', operator: 'equals', value: 'jira' }] })?.source.id,
    ).toBe('jira');
    expect(() => defineIntakeSource({ id: 'clickup', events: [], fields: [] })).toThrow(/already defined/);
  });
});
