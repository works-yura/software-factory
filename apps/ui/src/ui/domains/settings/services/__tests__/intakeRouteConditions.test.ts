import { describe, expect, it } from 'vitest';

import { readRouteConditions } from '../intakeRouteConditions';

describe('intake route conditions', () => {
  it("reads the default route's condition for its summary", () => {
    const when = {
      operator: 'AND' as const,
      conditions: [
        { field: 'source.integration', operator: 'in' as const, value: ['github', 'gitlab'] },
        { field: 'author.trusted', operator: 'equals' as const, value: false },
      ],
    };
    const conditions = readRouteConditions(when);
    expect(conditions).toEqual([
      { field: 'source.integration', value: ['github', 'gitlab'] },
      { field: 'author.trusted', value: false },
    ]);
  });

  it('reads no condition as every card', () => {
    expect(readRouteConditions(null)).toEqual([]);
  });

  it('leaves a condition the form cannot show unread, so it is kept as written', () => {
    expect(
      readRouteConditions({ operator: 'OR', conditions: [{ field: 'item.labels', operator: 'contains', value: 'a' }] }),
    ).toBeUndefined();
    expect(
      readRouteConditions({
        operator: 'AND',
        conditions: [{ field: 'item.author', operator: 'equals', value: 'ann' }],
      }),
    ).toBeUndefined();
    expect(
      readRouteConditions({
        operator: 'AND',
        conditions: [{ operator: 'AND', conditions: [] }],
      }),
    ).toBeUndefined();
  });
});
