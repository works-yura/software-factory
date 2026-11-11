import { describe, expect, it } from 'vitest';

import { defineBoard } from '../boards/define-board.ts';
import { awaitsAcceptance } from '../boards/semantics.ts';
import { needsApproval } from './types.ts';

describe('needsApproval', () => {
  // Work: Intake rests and Triage sorts cards nobody accepted yet.
  const awaits = (stage: string) => stage === 'intake' || stage === 'triage';
  const labeled = { metadata: { labels: ['bug', 'Status: Needs Approval'] } };

  it('holds a labeled card while it rests in Intake or Triage', () => {
    expect(needsApproval({ ...labeled, stages: ['intake'] }, awaits)).toBe(true);
    expect(needsApproval({ ...labeled, stages: ['triage'] }, awaits)).toBe(true);
    expect(needsApproval(labeled, awaits)).toBe(true);
  });

  it('lets the card go once a person moved it on, even before the source drops the label', () => {
    expect(needsApproval({ ...labeled, stages: ['planning'] }, awaits)).toBe(false);
    expect(needsApproval({ ...labeled, stages: ['execute'] }, awaits)).toBe(false);
  });

  it("reads which phases still wait for acceptance from the card's own board, whatever they are called", () => {
    const ship = defineBoard({
      id: 'ship',
      name: 'Ship',
      initialPhase: 'inbox',
      phases: {
        inbox: { name: 'Inbox', kind: 'resting', nextPhases: ['sort', 'make'] },
        sort: { name: 'Sort', kind: 'working', runner: { context: 'triage' }, nextPhases: ['inbox', 'make'] },
        make: { name: 'Make', kind: 'working', runner: { context: 'work' }, nextPhases: ['pr'] },
        pr: {
          name: 'PR',
          kind: 'working',
          runner: { context: 'review' },
          tools: ['factory_review_source', 'factory_record_review_verdict'],
          nextPhases: ['shipped'],
        },
        shipped: { name: 'Shipped', kind: 'terminal' },
      },
    });
    const onShip = (stage: string) => awaitsAcceptance(ship, stage);
    expect(needsApproval({ ...labeled, stages: ['inbox'] }, onShip)).toBe(true);
    expect(needsApproval({ ...labeled, stages: ['sort'] }, onShip)).toBe(true);
    expect(needsApproval({ ...labeled, stages: ['make'] }, onShip)).toBe(false);
    expect(needsApproval({ ...labeled, stages: ['pr'] }, onShip)).toBe(false);
    // Work's phase names mean nothing on another board.
    expect(needsApproval({ ...labeled, stages: ['intake'] }, onShip)).toBe(false);
  });

  it('holds nothing without the label', () => {
    expect(needsApproval({ metadata: { labels: ['bug'] }, stages: ['intake'] }, awaits)).toBe(false);
    expect(needsApproval({ metadata: null, stages: ['intake'] }, awaits)).toBe(false);
  });

  it('ignores a legacy acceptance stamp: the label and the lane decide', () => {
    const legacy = { ...labeled, stages: ['intake'], acceptedAt: new Date() };
    expect(needsApproval(legacy, awaits)).toBe(true);
  });
});
