import { describe, expect, it } from 'vitest';

import { cardRuleFacts, evaluateRuleGroup, externallyAuthoredWorkItem } from '@factory/core';
import type { ExternalWorkItemSource, RuleGroup } from '@factory/core';
import type { Card } from '../work-items/base.ts';

import { DEFAULT_INTAKE_ROUTE } from './base.ts';
import { arrivalSourceFacts } from '../work-items/providers/index.ts';

const SOURCES: Record<string, ExternalWorkItemSource | null> = {
  manual: null,
  'github issue': { integrationId: 'github', type: 'issue', externalId: 'acme/app#1' },
  'github pull request': { integrationId: 'github', type: 'pull-request', externalId: 'acme/app#2' },
  'gitlab issue': { integrationId: 'gitlab', type: 'issue', externalId: 'acme/app#3' },
  'gitlab merge request': { integrationId: 'gitlab', type: 'pull-request', externalId: 'acme/app!4' },
  'linear issue': { integrationId: 'linear', type: 'issue', externalId: 'ENG-5' },
  'jira issue': { integrationId: 'jira', type: 'issue', externalId: 'OPS-6' },
  'incident.io follow-up': { integrationId: 'incidentio', type: 'follow-up', externalId: 'inc-7' },
  'slack thread': { integrationId: 'slack', type: 'thread', workspaceId: 'T0ABC', externalId: '1700000000.0001' },
};

const STAMPS: Record<string, Record<string, unknown> | null> = {
  'no metadata': null,
  'no stamp': { labels: ['bug'] },
  'authorTrusted true': { authorTrusted: true },
  'authorTrusted false': { authorTrusted: false },
  'factoryAuthored true': { factoryAuthored: true },
  'factoryAuthored true, authorTrusted false': { factoryAuthored: true, authorTrusted: false },
};

describe('provider facts', () => {
  it.each([false, true])('keeps native labels and authors available to rules (persisted: %s)', persisted => {
    const facts = cardRuleFacts({
      title: 'Write the guide',
      externalSource: null,
      metadata: { labels: ['docs', 42], author: 'writer', authorTrusted: true },
      ...(persisted ? { workItem: { labels: [], author: null } } : {}),
    });
    expect(facts).toMatchObject({
      'item.labels': ['docs'],
      'item.author': 'writer',
      'author.trusted': true,
    });
  });

  it.each([{ labels: [] }, { labels: ['bug'] }])(
    'uses normalized provider labels $labels while keeping placement trust authoritative',
    ({ labels }) => {
      const facts = cardRuleFacts({
        title: 'Fix',
        externalSource: SOURCES['github issue']!,
        metadata: { labels: ['stale'], author: 'stale-author', authorTrusted: false },
        workItem: { labels, author: 'provider-author' },
      });
      expect(facts).toMatchObject({
        'item.labels': labels,
        'item.author': 'provider-author',
        'author.trusted': false,
      });
    },
  );

  it('normalizes incoming source facts before the arrival has a persisted work item', () => {
    const facts = cardRuleFacts({
      title: 'Fix',
      externalSource: SOURCES['github issue']!,
      metadata: { labels: [{ name: 'bug' }], author: 'provider-author', authorTrusted: true },
    });
    expect(facts).toMatchObject({
      'item.labels': ['bug'],
      'item.author': 'provider-author',
      'author.trusted': true,
    });
  });
});

describe('where an item lives, its key, state and assignees', () => {
  const ARRIVALS = [
    {
      name: 'GitHub issue',
      source: {
        integrationId: 'github',
        type: 'issue',
        externalId: 'github:7:issue:12',
        url: 'https://github.com/Acme/App/issues/12',
      },
      metadata: { githubRepositoryId: 7, githubIssueNumber: 12, state: 'open', assignees: ['octocat'] },
      facts: {
        'source.provider': 'github',
        'source.repository': 'Acme/App',
        'item.key': 'Acme/App#12',
        'item.state': 'open',
        'item.assignees': ['octocat'],
      },
    },
    {
      name: 'GitLab merge request in a subgroup',
      source: {
        integrationId: 'gitlab',
        type: 'pull-request',
        externalId: 'gitlab:9:mr:7',
        url: 'https://gitlab.com/acme/platform/api/-/merge_requests/7',
      },
      metadata: { gitlabMergeRequestIid: 7, merged: true, assignees: [] },
      facts: {
        'source.provider': 'gitlab',
        'source.repository': 'acme/platform/api',
        'item.key': 'acme/platform/api!7',
        'item.state': 'merged',
        'item.assignees': [],
      },
    },
    {
      name: 'ClickUp task',
      source: { integrationId: 'clickup', type: 'task', externalId: '86c0' },
      metadata: { identifier: '86c0', state: 'to do', assignee: 'Ada' },
      facts: {
        'source.provider': 'clickup',
        'item.key': '86c0',
        'item.state': 'to do',
        'item.assignees': ['Ada'],
      },
    },
  ] as const;

  // An arrival is normalized the way its work item will be, and a filed card's provider facts live
  // on its work item; either way the card itself keeps only Factory's own metadata.
  it.each(ARRIVALS)('reads them off a $name, as its work item stores them', ({ source, metadata, facts }) => {
    const workItem = arrivalSourceFacts(source, metadata)!;
    expect(
      cardRuleFacts({ title: 'Fix', externalSource: source, metadata: { authorTrusted: true }, workItem }),
    ).toMatchObject(facts);
  });

  it('has no repository for a ClickUp task or a GitHub item without its URL, and none of these facts for a manual card', () => {
    const task = ARRIVALS[2];
    const clickup = cardRuleFacts({
      title: 'Fix',
      externalSource: task.source,
      metadata: {},
      workItem: arrivalSourceFacts(task.source, task.metadata)!,
    });
    expect(clickup).not.toHaveProperty('source.repository');
    const github = SOURCES['github issue']!;
    expect(
      cardRuleFacts({
        title: 'Fix',
        externalSource: github,
        metadata: {},
        workItem: arrivalSourceFacts(github, { githubIssueNumber: 1 })!,
      }),
    ).not.toHaveProperty('source.repository');
    const manual = cardRuleFacts({ title: 'Fix', externalSource: null, metadata: {} });
    expect(manual).not.toHaveProperty('source.repository');
    expect(manual).not.toHaveProperty('source.provider');
    expect(manual).not.toHaveProperty('item.key');
  });
});

describe('item.pullRequest', () => {
  const pullRequest = (number: number, state: string) =>
    ({
      sourceType: 'pull-request',
      state,
      metadata: { githubPullRequestNumber: number },
    }) as unknown as Card['workItem']['sources'][number];
  const issueCard = (sources: Card['workItem']['sources'], metadata: Record<string, unknown> = {}) => ({
    title: 'Fix',
    externalSource: SOURCES['github issue']!,
    metadata,
    workItem: { labels: [], author: null, sources },
  });
  const noPullRequest: RuleGroup = {
    operator: 'AND',
    conditions: [{ field: 'item.pullRequest', operator: 'not_exists' }],
  };

  it('is absent while the card has no open change request', () => {
    for (const card of [issueCard([]), issueCard([pullRequest(12, 'closed'), pullRequest(13, 'merged')])]) {
      const facts = cardRuleFacts(card);
      expect(facts).not.toHaveProperty('item.pullRequest');
      expect(evaluateRuleGroup(noPullRequest, facts)).toBe(true);
    }
  });

  it('is the open change request attached to the card, or the one Factory opened', () => {
    const attached = cardRuleFacts(issueCard([pullRequest(12, 'closed'), pullRequest(14, 'open')]));
    expect(attached['item.pullRequest']).toBe(14);
    expect(evaluateRuleGroup(noPullRequest, attached)).toBe(false);

    expect(cardRuleFacts(issueCard([], { openPullRequestNumber: 21 }))['item.pullRequest']).toBe(21);
  });
});

describe('author.trusted', () => {
  it.each([
    ['authorTrusted true', true],
    ['factoryAuthored true', true],
    ['factoryAuthored true, authorTrusted false', true],
    ['authorTrusted false', false],
    ['no stamp', false],
    ['no metadata', false],
  ])('is %s → %s', (stamps, trusted) => {
    const facts = cardRuleFacts({ title: 'Fix', metadata: STAMPS[stamps]!, externalSource: SOURCES['github issue']! });
    expect(facts['author.trusted']).toBe(trusted);
  });

  it('only counts a literal true stamp, not a truthy one', () => {
    const facts = cardRuleFacts({
      title: 'Fix',
      metadata: { authorTrusted: 'true', factoryAuthored: 1 },
      externalSource: SOURCES['github issue']!,
    });
    expect(facts['author.trusted']).toBe(false);
  });
});

describe("the default intake route's condition", () => {
  const OUTSIDE_AUTHOR = DEFAULT_INTAKE_ROUTE.when!;
  const cases = Object.keys(SOURCES).flatMap(source => Object.keys(STAMPS).map(stamps => [source, stamps] as const));

  it.each(cases)('matches exactly the cards from outside the write-access circle: %s, %s', (source, stamps) => {
    const card = { title: 'Fix', metadata: STAMPS[stamps]!, externalSource: SOURCES[source]! };
    expect(evaluateRuleGroup(OUTSIDE_AUTHOR, cardRuleFacts(card))).toBe(externallyAuthoredWorkItem(card));
  });

  it('matches only GitHub and GitLab cards without a trust stamp', () => {
    const matched = cases
      .filter(([source, stamps]) =>
        evaluateRuleGroup(
          OUTSIDE_AUTHOR,
          cardRuleFacts({ title: 'Fix', metadata: STAMPS[stamps]!, externalSource: SOURCES[source]! }),
        ),
      )
      .map(([source, stamps]) => `${source}: ${stamps}`);
    expect(matched).toEqual(
      ['github issue', 'github pull request', 'gitlab issue', 'gitlab merge request'].flatMap(source =>
        ['no metadata', 'no stamp', 'authorTrusted false'].map(stamps => `${source}: ${stamps}`),
      ),
    );
  });
});
