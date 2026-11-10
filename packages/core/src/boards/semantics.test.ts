import { describe, expect, it } from 'vitest';

import type { WorkItemSourceRow } from '../card.ts';
import { defineBoard } from './define-board.ts';
import { createBoardRegistry } from './registry.ts';
import {
  boardForWorkItem,
  isTerminalWorkItem,
  pullRequestSourceNumber,
  resolveBoardClosure,
  resolveBoardToolRule,
  resolvePhaseSemantics,
  reviewedPullRequest,
  workItemPhaseSemantics,
} from './semantics.ts';
import { createTestBoard } from './test-utils.ts';

describe('boardForWorkItem', () => {
  it('prefers the persisted board', () => {
    expect(boardForWorkItem({ board: 'release' })).toBe('release');
  });

  it('puts legacy rows with no board on Work, pull request cards included', () => {
    expect(boardForWorkItem({ board: null })).toBe('work');
  });
});

describe('resolvePhaseSemantics', () => {
  const boards = createBoardRegistry({ boards: [createTestBoard()] });

  it('reads kind and role from the installed board', () => {
    expect(resolvePhaseSemantics(boards, 'release', 'queued')).toEqual({ kind: 'resting' });
    expect(resolvePhaseSemantics(boards, 'release', 'shipping')).toEqual({ kind: 'working', role: 'release' });
    expect(resolvePhaseSemantics(boards, 'release', 'shipped')).toEqual({ kind: 'terminal' });
    expect(resolvePhaseSemantics(boards, 'work', 'planning')).toBeUndefined();
    expect(resolvePhaseSemantics(boards, 'work', 'done')).toBeUndefined();
  });

  it('returns undefined for uninstalled boards and undeclared phases instead of guessing by name', () => {
    expect(resolvePhaseSemantics(boards, 'missing', 'done')).toBeUndefined();
    expect(resolvePhaseSemantics(boards, 'release', 'done')).toBeUndefined();
    expect(resolvePhaseSemantics(boards, 'release', 'intake')).toBeUndefined();
    const only = createBoardRegistry({ boards: [createTestBoard()] });
    expect(resolvePhaseSemantics(only, 'work', 'done')).toBeUndefined();
  });

  it('gives a board that reuses Work phase names its own declarations', () => {
    const board = defineBoard({
      id: 'bot',
      title: 'Bot',
      initialPhase: 'intake',
      phases: {
        intake: { title: 'Intake', kind: 'resting', next: 'done' },
        done: { title: 'Done', kind: 'working', role: 'bot', next: 'intake' },
      },
    });
    const registry = createBoardRegistry({ boards: [board] });
    expect(resolvePhaseSemantics(registry, 'bot', 'done')).toEqual({ kind: 'working', role: 'bot' });
    expect(resolvePhaseSemantics(registry, 'work', 'done')).toBeUndefined();
  });
});

describe('workItemPhaseSemantics', () => {
  const boards = createBoardRegistry({ boards: [createTestBoard()] });

  it('resolves through the item board and single stage', () => {
    expect(workItemPhaseSemantics(boards, { board: 'release', externalSource: null, stages: ['shipped'] })).toEqual({
      kind: 'terminal',
    });
    expect(
      workItemPhaseSemantics(boards, {
        board: null,
        externalSource: { integrationId: 'github', type: 'pull-request', externalId: '1' },
        stages: ['pr-review'],
      }),
    ).toBeUndefined();
  });

  it('is undefined for multi-stage rows', () => {
    expect(
      workItemPhaseSemantics(boards, { board: 'work', externalSource: null, stages: ['review', 'done'] }),
    ).toBeUndefined();
  });
});

describe('resolveBoardToolRule', () => {
  it('resolves only from the installed board that declares the tool', () => {
    const onResult = () => undefined;
    const release = defineBoard({
      id: 'release',
      title: 'Release',
      initialPhase: 'queued',
      phases: {
        queued: { title: 'Queued', kind: 'resting', next: 'shipped' },
        shipped: { title: 'Shipped', kind: 'terminal' },
      },
      tools: { ship_it: { onResult } },
    });
    const boards = createBoardRegistry({ boards: [release] });
    expect(resolveBoardToolRule(boards, 'release', 'ship_it')).toBe(onResult);
    expect(resolveBoardToolRule(boards, 'work', 'submit_plan')).toBeUndefined();
    expect(resolveBoardToolRule(boards, 'review', 'submit_plan')).toBeUndefined();
    expect(resolveBoardToolRule(boards, 'release', 'submit_plan')).toBeUndefined();
    expect(resolveBoardToolRule(boards, 'work', 'ship_it')).toBeUndefined();
    expect(resolveBoardToolRule(boards, 'missing', 'ship_it')).toBeUndefined();
    expect(
      resolveBoardToolRule(createBoardRegistry({ boards: [] }), 'work', 'submit_plan'),
    ).toBeUndefined();
  });
});

describe('isTerminalWorkItem', () => {
  const custom = createBoardRegistry({ boards: [createTestBoard()] });

  it("follows the installed board's phase kind", () => {
    expect(isTerminalWorkItem(custom, { board: 'release', externalSource: null, stages: ['shipped'] })).toBe(true);
    expect(isTerminalWorkItem(custom, { board: 'release', externalSource: null, stages: ['queued'] })).toBe(false);
    expect(isTerminalWorkItem(custom, { board: 'work', externalSource: null, stages: ['done'] })).toBe(true);
    expect(isTerminalWorkItem(custom, { board: 'work', externalSource: null, stages: ['intake'] })).toBe(false);
  });

  it('falls back to the built-in names only for Work and Review rows on uninstalled boards', () => {
    const none = createBoardRegistry();
    expect(isTerminalWorkItem(none, { board: 'work', externalSource: null, stages: ['done'] })).toBe(true);
    expect(isTerminalWorkItem(none, { board: null, externalSource: null, stages: ['canceled'] })).toBe(true);
    expect(isTerminalWorkItem(none, { board: 'ghost', externalSource: null, stages: ['done'] })).toBe(false);
    expect(isTerminalWorkItem(none, { board: 'work', externalSource: null, stages: ['done', 'intake'] })).toBe(false);
  });
});

describe('resolveBoardClosure', () => {
  const release = createTestBoard();
  const closingRelease = defineBoard({
    id: 'closing',
    title: 'Closing release',
    initialPhase: 'queued',
    sourceClosed: { completed: 'shipped', canceled: 'dropped' },
    phases: {
      queued: { title: 'Queued', kind: 'resting', outcomes: { ship: 'shipped', drop: 'dropped' } },
      shipped: { title: 'Shipped', kind: 'terminal' },
      dropped: { title: 'Dropped', kind: 'terminal' },
    },
  });
  const boards = createBoardRegistry({ boards: [release, closingRelease] });

  it('does not invent a Work mapping when that pipeline is not installed', () => {
    expect(resolveBoardClosure(boards, { board: null, externalSource: null, stages: ['execute'] })).toBeUndefined();
    expect(resolveBoardClosure(boards, { board: 'work', externalSource: null, stages: ['canceled'] })).toBeUndefined();
  });

  it('reads a custom board’s mapping and judges terminal phases by kind', () => {
    expect(resolveBoardClosure(boards, { board: 'closing', externalSource: null, stages: ['queued'] })).toEqual({
      boardTitle: 'Closing release',
      completed: { phase: 'shipped', title: 'Shipped' },
      canceled: { phase: 'dropped', title: 'Dropped' },
      itemTerminal: false,
    });
    expect(
      resolveBoardClosure(boards, { board: 'closing', externalSource: null, stages: ['dropped'] })?.itemTerminal,
    ).toBe(true);
  });

  it('is undefined for boards that declare no mapping or are not installed', () => {
    expect(resolveBoardClosure(boards, { board: 'release', externalSource: null, stages: ['queued'] })).toBeUndefined();
    expect(resolveBoardClosure(boards, { board: 'gone', externalSource: null, stages: ['queued'] })).toBeUndefined();
  });
});

function sourceRow(fields: Pick<WorkItemSourceRow, 'sourceType' | 'externalId' | 'metadata'>): WorkItemSourceRow {
  const now = new Date(0);
  return {
    id: `source-${fields.externalId}`,
    workItemId: 'item-1',
    provider: 'gitlab',
    integrationId: 'gitlab',
    workspaceId: null,
    sourceKey: null,
    key: null,
    url: null,
    state: null,
    labels: [],
    author: null,
    revision: 1,
    syncedAt: null,
    createdAt: now,
    updatedAt: now,
    ...fields,
  };
}

describe('the number of an attached change request', () => {
  it("reads a GitLab merge request's iid from its facts, not from digits at the end of its key", () => {
    // GitLab keys are base64url JSON, so trailing digits are an accident of the encoding.
    const key = `gitlab-pr:${Buffer.from(JSON.stringify({ version: 1, host: 'gitlab.com', projectId: 7, mergeRequestIid: 17 })).toString('base64url')}`;
    const issue = sourceRow({ sourceType: 'issue', externalId: 'gitlab-issue:42', metadata: {} });
    const mergeRequest = sourceRow({
      sourceType: 'pull-request',
      externalId: key,
      metadata: { gitlabMergeRequestIid: 17, state: 'open' },
    });
    const attached = reviewedPullRequest({ workItem: { sources: [issue, mergeRequest] } });

    expect(attached && pullRequestSourceNumber(attached)).toBe(17);
    expect(/(\d+)$/.exec(key)?.[1]).not.toBe('17');
  });
});
