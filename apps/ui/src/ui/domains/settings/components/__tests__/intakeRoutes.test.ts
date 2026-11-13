import { describe, expect, it } from 'vitest';

import { shipBoard, workBoardInfo } from '../../../../../../e2e/ui/board-catalog';
import type { IntakeRouteInfo } from '../../../../../api/types';
import { describeRule } from '../conditionFields';
import { catchesEveryArrival, phaseOptions, reorderWithin, sendNewCardsTo, triggerLabel } from '../intakeRoutes';

function route(overrides: Partial<IntakeRouteInfo> & Pick<IntakeRouteInfo, 'id' | 'name'>): IntakeRouteInfo {
  return {
    enabled: true,
    position: 0,
    when: null,
    target: { boardKey: 'work', phaseKey: 'intake', joinClosedIssue: false },
    on: ['work_item.created'],
    revision: 1,
    createdBy: 'factory',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedBy: 'factory',
    updatedAt: '2026-11-01T00:00:00.000Z',
    problems: [],
    triggered: null,
    origin: null,
    ...overrides,
  };
}

const outsideAuthors = route({
  id: 'outside-authors',
  name: 'Outside authors wait in Intake',
  when: {
    operator: 'AND',
    conditions: [
      { field: 'source.integration', operator: 'equals', value: 'github' },
      { field: 'author.trusted', operator: 'equals', value: false },
    ],
  },
});
const closedDone = route({
  id: 'closed-done',
  name: 'Closed issues go to Done',
  on: ['work_item.closed'],
  when: { operator: 'AND', conditions: [{ field: 'event.reason', operator: 'equals', value: 'completed' }] },
  target: { boardKey: 'work', phaseKey: 'done', joinClosedIssue: false },
});
const everythingElse = route({ id: 'everything-else', name: 'Everything else goes to Work › Intake', revision: 3 });

describe('sendNewCardsTo', () => {
  it('repoints the catch-all and copies the old board’s card moves onto the new one', () => {
    const writes = sendNewCardsTo([outsideAuthors, closedDone, everythingElse], [workBoardInfo, shipBoard], 'ship');

    expect(writes[0]).toEqual({
      kind: 'update',
      id: 'everything-else',
      patch: {
        name: `Everything else goes to Ship › ${shipBoard.phases.find(phase => phase.id === shipBoard.initialPhase)?.name}`,
        target: { boardKey: 'ship', phaseKey: shipBoard.initialPhase },
        expectedRevision: 3,
      },
    });
    // A card move goes along only where the new board has a phase playing the same part.
    const copies = writes.filter(write => write.kind === 'create');
    expect(copies.every(write => write.kind === 'create' && write.route.target.boardKey === 'ship')).toBe(true);
  });

  it('adds a catch-all when no route takes every new card', () => {
    expect(sendNewCardsTo([outsideAuthors], [workBoardInfo, shipBoard], 'ship')[0]).toMatchObject({
      kind: 'create',
      route: { when: null, target: { boardKey: 'ship', phaseKey: shipBoard.initialPhase } },
    });
  });

  it('never counts a route «За розкладом» as the catch-all', () => {
    const schedule = route({ id: 'schedule', name: 'Nightly', on: [], triggered: {} as IntakeRouteInfo['triggered'] });
    expect(catchesEveryArrival(schedule)).toBe(false);
    expect(catchesEveryArrival(everythingElse)).toBe(true);
  });
});

describe('reorderWithin', () => {
  it('moves a route only among the routes shown, leaving the others in their slots', () => {
    const all = [{ id: 'a' }, { id: 'move' }, { id: 'b' }, { id: 'c' }];
    expect(reorderWithin(all, ['a', 'b', 'c'], 2, 0)).toEqual(['c', 'move', 'a', 'b']);
  });
});

describe('route words', () => {
  it('names conditions with the editor’s field names and readable values', () => {
    expect(describeRule(outsideAuthors.when, phaseOptions(workBoardInfo))).toBe(
      'Integration is GitHub and author is not trusted',
    );
    expect(describeRule(closedDone.when)).toBe('Close reason is completed');
    expect(describeRule(null)).toBe('Every card.');
  });

  it('reads events as a choice', () => {
    expect(triggerLabel(['work_item.closed', 'work_item.reopened'])).toBe('A card is closed or a card is reopened');
  });
});
