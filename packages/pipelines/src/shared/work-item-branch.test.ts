import { describe, expect, it } from 'vitest';

import { workItemSource } from '@factory/core';

import {
  mergeRequestNumberFromBranch,
  pullRequestNumberFromBranch,
  workItemBranch,
  workItemNumber,
} from './work-item-branch.ts';

describe('workItemBranch', () => {
  const id = '9f1c3b2a-0000-4000-8000-000000000001';

  it('names github issue and pull request branches from their metadata number', () => {
    expect(workItemBranch({ id, source: 'github-issue', metadata: { githubIssueNumber: 49 } })).toBe(
      'factory/issue-49',
    );
    expect(workItemBranch({ id, source: 'github-pr', metadata: { githubPullRequestNumber: 7 } })).toBe('factory/pr-7');
  });

  it('accepts the intake fallback `number` key for github cards', () => {
    expect(workItemBranch({ id, source: 'github-issue', metadata: { number: 12 } })).toBe('factory/issue-12');
  });

  it('rejects numbers that are not positive integers', () => {
    expect(workItemBranch({ id, source: 'github-issue', metadata: { githubIssueNumber: 0 } })).toBe(
      `factory/item-${id}`,
    );
    expect(workItemBranch({ id, source: 'github-issue', metadata: { githubIssueNumber: '49' } })).toBe(
      `factory/item-${id}`,
    );
  });

  it('sanitizes the GitLab identifier into a bounded branch name', () => {
    expect(workItemBranch({ id, source: 'gitlab-issue', metadata: { identifier: 'Acme/App #42' } })).toBe(
      'factory/gitlab-acme-app-42-000000000001',
    );
    expect(workItemBranch({ id, source: 'gitlab-issue', metadata: { identifier: '  ' } })).toBe(`factory/item-${id}`);
    const longPrefix = 'group/'.repeat(30);
    expect(
      workItemBranch({
        id: 'aaaaaaaa-0000-4000-8000-000000000002',
        source: 'gitlab-issue',
        metadata: { identifier: longPrefix + '#42' },
      }),
    ).not.toBe(
      workItemBranch({
        id: 'aaaaaaaa-0000-4000-8000-000000000003',
        source: 'gitlab-issue',
        metadata: { identifier: longPrefix + '#43' },
      }),
    );
  });

  it('names a stored card from an unsupported integration by its id', () => {
    const legacy = workItemSource({ integrationId: 'linear', type: 'issue', externalId: 'linear:ENG-42' });
    expect(legacy).toBe('manual');
    expect(workItemBranch({ id, source: legacy, metadata: { identifier: 'ENG-42' } })).toBe(`factory/item-${id}`);
  });

  it('falls back to an id-derived branch when no provider identity applies', () => {
    expect(workItemBranch({ id, source: 'manual', metadata: null })).toBe(`factory/item-${id}`);
    const slack = workItemSource({ integrationId: 'slack', type: 'slack-thread', externalId: '5' });
    expect(workItemBranch({ id, source: slack })).toBe(`factory/item-${id}`);
    expect(workItemBranch({ id, source: 'github-issue', metadata: {} })).toBe(`factory/item-${id}`);
  });
});

describe('workItemNumber', () => {
  it('reads provider numbers for GitHub and GitLab cards only', () => {
    expect(workItemNumber({ source: 'gitlab-pr', metadata: { gitlabMergeRequestIid: 6 } })).toBe(6);
    expect(workItemNumber({ source: 'gitlab-issue', metadata: { gitlabIssueIid: 3 } })).toBe(3);
    expect(workItemNumber({ source: 'manual', metadata: { number: 9 } })).toBeUndefined();
    expect(workItemNumber({ source: 'github-pr', metadata: null })).toBeUndefined();
  });
});

describe('pullRequestNumberFromBranch', () => {
  it('reads the number back from a pull request branch only', () => {
    expect(pullRequestNumberFromBranch('factory/pr-7')).toBe(7);
    expect(pullRequestNumberFromBranch('factory/issue-7')).toBeUndefined();
    expect(pullRequestNumberFromBranch('factory/pr-0')).toBeUndefined();
    expect(pullRequestNumberFromBranch('factory/pr-7x')).toBeUndefined();
    expect(pullRequestNumberFromBranch('feat/pr-7')).toBeUndefined();
  });
});

describe('mergeRequestNumberFromBranch', () => {
  it('accepts only Factory GitLab MR review branches with safe numeric IIDs', () => {
    expect(mergeRequestNumberFromBranch('factory/gitlab-mr-6-2c3b494988ac')).toBe(6);
    expect(mergeRequestNumberFromBranch('factory/gitlab-mr-0-2c3b494988ac')).toBeUndefined();
    expect(mergeRequestNumberFromBranch('factory/gitlab-mr-6')).toBeUndefined();
    expect(mergeRequestNumberFromBranch('factory/gitlab-mr-6-unsafe!')).toBeUndefined();
    expect(mergeRequestNumberFromBranch('factory/pr-6')).toBeUndefined();
  });
});
