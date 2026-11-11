import { describe, expect, it } from 'vitest';

import type { InstalledBoardInfo } from '../../../api/types';
import { laneKey, pipelineLanes, stageCatalog } from './stages';

type Phase = InstalledBoardInfo['phases'][number];
const phase = (id: string, kind: Phase['kind']): Phase => ({ id, title: id.toUpperCase(), name: id.toUpperCase(), kind, transitions: [] });
const board = (id: string, phases: Phase[]): InstalledBoardInfo => ({ id, title: id, name: id, initialPhase: phases[0]!.id, phases });

const ship = board('ship', [phase('inbox', 'resting'), phase('make', 'working'), phase('review', 'working'), phase('shipped', 'terminal')]);
const ops = board('ops', [phase('queued', 'resting'), phase('review', 'working'), phase('closed', 'terminal')]);

describe('pipelineLanes', () => {
  it('lists the working phases of one board under their own names', () => {
    expect(pipelineLanes([ship])).toEqual([
      { key: 'ship/make', board: 'ship', stage: 'make', label: 'MAKE' },
      { key: 'ship/review', board: 'ship', stage: 'review', label: 'REVIEW' },
    ]);
  });

  it('names the board once several boards have working phases', () => {
    expect(pipelineLanes([ship, ops]).map(lane => [lane.key, lane.label])).toEqual([
      ['ship/make', 'ship · MAKE'],
      ['ship/review', 'ship · REVIEW'],
      ['ops/review', 'ops · REVIEW'],
    ]);
  });
});

describe('laneKey', () => {
  it('reads a card without a board as the default board', () => {
    expect(laneKey(null, 'review')).toBe('work/review');
  });
});

describe('stageCatalog', () => {
  it('orders stages by column across boards and names them by the first board holding them', () => {
    const stages = stageCatalog([ship, ops]);
    expect(stages.pipelineStages).toEqual(['make', 'review']);
    expect(stages.label('review')).toBe('REVIEW');
    expect(stages.order('make')).toBeLessThan(stages.order('review'));
    expect(stages.order('closed')).toBeGreaterThan(stages.order('shipped'));
  });

  it('keeps an unknown stage id and sorts it last', () => {
    const stages = stageCatalog([ship]);
    expect(stages.label('gone')).toBe('gone');
    expect(stages.order('gone')).toBeGreaterThan(stages.order('shipped'));
  });
});
