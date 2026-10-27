import { describe, expect, it, vi } from 'vitest';
import { defineBoard } from '../boards/define-board.ts';
import { createBoardRegistry } from '../boards/registry.ts';
import { resolveFactoryStageRules } from './resolve.ts';

describe('Factory rule resolution', () => {
  const onExit = vi.fn(() => undefined);
  const onEnter = vi.fn(() => undefined);
  const board = defineBoard({
    id: 'release',
    title: 'Release',
    initialPhase: 'queued',
    phases: {
      queued: {
        title: 'Queued',
        kind: 'resting',
        next: 'shipped',
        onExit: { issue: onExit },
        onEnter: { issue: onEnter },
      },
      shipped: { title: 'Shipped', kind: 'terminal', onEnter: { issue: onEnter } },
    },
  });
  const boards = createBoardRegistry({ boards: [board] });
  const input = { board: 'release', source: 'issue' as const, fromStage: 'queued', toStage: 'shipped' };

  it('resolves custom-only installed phases in exit-before-enter order', () => {
    expect(resolveFactoryStageRules(boards, input)).toEqual([
      { phase: 'exit', handler: onExit },
      { phase: 'enter', handler: onEnter },
    ]);
  });

  it.each(['issue', 'pullRequest', 'gitlabIssue', 'manual'] as const)('matches the %s source exactly', source => {
    expect(resolveFactoryStageRules(boards, { ...input, source })).toEqual(
      source === 'issue'
        ? [
            { phase: 'exit', handler: onExit },
            { phase: 'enter', handler: onEnter },
          ]
        : [],
    );
  });

  it('skips unchanged stages and runs only entry on reentry or initial entry', () => {
    const same = { ...input, toStage: 'queued' };
    expect(resolveFactoryStageRules(boards, same)).toEqual([]);
    expect(resolveFactoryStageRules(boards, { ...same, reenter: true })).toEqual([
      { phase: 'enter', handler: onEnter },
    ]);
    expect(resolveFactoryStageRules(boards, { ...same, initialEntry: true })).toEqual([
      { phase: 'enter', handler: onEnter },
    ]);
  });

  it('never falls back to uninstalled built-ins or another registry', () => {
    const empty = createBoardRegistry();
    for (const id of ['release', 'work', 'review', 'missing']) {
      expect(resolveFactoryStageRules(empty, { ...input, board: id, fromStage: 'intake', toStage: 'triage' })).toEqual(
        [],
      );
    }
    const other = createBoardRegistry({
      boards: [
        defineBoard({
          id: 'release',
          title: 'Other release',
          initialPhase: 'queued',
          phases: {
            queued: { title: 'Queued', kind: 'resting', next: 'shipped' },
            shipped: { title: 'Shipped', kind: 'terminal' },
          },
        }),
      ],
    });
    expect(resolveFactoryStageRules(other, input)).toEqual([]);
    expect(resolveFactoryStageRules(boards, input)).toHaveLength(2);
  });
});
