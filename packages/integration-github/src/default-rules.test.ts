import { describe, expect, it, vi } from 'vitest';
import { withBoardClosure, withBoardFlow } from '@factory/core';
import { createDefaultBoardRegistry } from '@factory/pipelines';

import { defaultGithubRules, resolveGithubRules } from './default-rules.ts';

const workBoards = createDefaultBoardRegistry();

describe('GitHub issue re-triage', () => {
  const events = ['issueEdited', 'issueCommentCreated', 'issueCommentEdited', 'issueCommentDeleted'] as const;
  const context = (event: (typeof events)[number], stages: string[], board = 'work') =>
    ({
      event,
      board,
      ingress: { id: 'ingress-1' },
      actor: { type: 'github', login: 'someone', trusted: true, factoryAuthored: false },
      item: { source: 'github-issue', url: 'https://github.com/mastra-ai/mastra/issues/1', stages },
    }) as unknown as FactoryGithubRuleContext;

  describe.each(events)('%s', event => {
    it.each([['execute'], ['review']])('does not take over a card in %s', stage => {
      expect(defaultGithubRules[event]?.(context(event, [stage]))).toBeUndefined();
    });

    // Triage runs once, when a person moves the card into Triage or starts the run.
    it.each([['intake'], ['triage'], ['planning']])('does not re-triage a card in %s', stage => {
      expect(defaultGithubRules[event]?.(context(event, [stage]))).toBeUndefined();
    });

    it.each([['shipping'], ['plan-review'], ['queued'], ['shipped']])(
      'does not re-triage a custom-board card in %s',
      stage => {
        expect(defaultGithubRules[event]?.(context(event, [stage], 'release'))).toBeUndefined();
      },
    );
  });
});

describe('GitHub rule resolution', () => {
  it.each(Object.keys(defaultGithubRules))('preserves the default for %s', event => {
    expect(resolveGithubRules()).toHaveProperty(event, Reflect.get(defaultGithubRules, event));
  });

  it('replaces only the specified event', () => {
    const handler = vi.fn();
    const rules = resolveGithubRules({ issueOpened: handler });
    expect(rules.issueOpened).toBe(handler);
    expect(rules.issueClosed).toBe(defaultGithubRules.issueClosed);
  });

  it('disables events with null and falls back for undefined', () => {
    const rules = resolveGithubRules({ issueOpened: null, issueClosed: undefined });
    expect(rules.issueOpened).toBeNull();
    expect(rules.issueClosed).toBe(defaultGithubRules.issueClosed);
  });

  it('copies and freezes rules independently of caller mutation', () => {
    const overrides = { issueOpened: vi.fn() };
    const first = resolveGithubRules(overrides);
    overrides.issueOpened = vi.fn();
    const second = resolveGithubRules(overrides);
    expect(first.issueOpened).not.toBe(second.issueOpened);
    expect(Object.isFrozen(first)).toBe(true);
    expect(resolveGithubRules().issueOpened).toBe(defaultGithubRules.issueOpened);
  });

  it.each([
    null,
    [],
    'rules',
    { unknown: null },
    { toString: null },
    { issueOpened: false },
    { [Symbol('event')]: null },
  ])('rejects invalid configuration %j', overrides => {
    // @ts-expect-error Exercise JavaScript callers at the constructor boundary.
    expect(() => resolveGithubRules(overrides)).toThrow();
  });
});

describe('GitHub merge of a card spanning several repositories', () => {
  const merged = (metadata: Record<string, unknown>, repository = 'acme/api', number = 5) =>
    ({
      event: 'pullRequestMerged',
      board: 'work',
      ingress: { id: 'ingress-merge' },
      actor: { type: 'github', login: 'maintainer', trusted: true, factoryAuthored: false },
      repository: { id: 1, fullName: repository, installationId: 1 },
      pullRequest: { number, merged: true },
      item: { source: 'manual', stages: ['review'], metadata },
      ...withBoardClosure(workBoards, { board: 'work', externalSource: null, stages: ['review'] }),
      ...withBoardFlow(workBoards, { board: 'work' }),
    }) as unknown as Parameters<NonNullable<typeof defaultGithubRules.pullRequestMerged>>[0];

  const both = {
    openChangeRequests: [
      { repository: 'acme/api', number: 5 },
      { repository: 'acme/app', number: 5 },
    ],
    openPullRequestNumber: 5,
  };

  it('keeps the card in Review while the other repository still has its pull request out', () => {
    expect(defaultGithubRules.pullRequestMerged?.(merged(both))).toMatchObject({
      type: 'sendMessage',
      message: expect.stringContaining('acme/app#5 is still open'),
    });
  });

  it('moves the card to Done when the last pull request it has out merges', () => {
    const lastOne = { openChangeRequests: [{ repository: 'acme/app', number: 5 }], openPullRequestNumber: 5 };
    expect(defaultGithubRules.pullRequestMerged?.(merged(lastOne, 'acme/app'))).toMatchObject({
      type: 'transition',
      stage: 'done',
    });
  });

  it('reads a card recorded before repositories were named by number alone', () => {
    expect(defaultGithubRules.pullRequestMerged?.(merged({ openPullRequestNumber: 5 }))).toMatchObject({
      type: 'transition',
    });
    expect(defaultGithubRules.pullRequestMerged?.(merged({ openPullRequestNumber: 6 }))).toMatchObject({
      type: 'sendMessage',
      message: expect.stringContaining('#6 is still open'),
    });
  });
});
