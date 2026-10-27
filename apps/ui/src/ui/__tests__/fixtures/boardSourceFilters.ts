import type { GithubIssue } from '../../domains/factory/services/factory';
import type { WorkItem } from '../../domains/factory/services/workItems';

const now = '2026-10-06T12:00:00.000Z';

function card(id: string, title: string, source: WorkItem['source'], stage: string): WorkItem {
  return {
    id,
    orgId: 'org-1',
    createdBy: 'user-1',
    githubProjectId: 'fp-1',
    board: 'work',
    source,
    sourceKey: `github-issue:${id}`,
    parentWorkItemId: null,
    title,
    url: null,
    stages: [stage],
    stageHistory: [{ stage, enteredAt: now, by: 'user-1' }],
    sessions: {},
    metadata: { labels: ['feature'] },
    triageType: null,
    acceptedAt: null,
    commentCount: 0,
    feedActivityAt: null,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

export const sourceCards: WorkItem[] = [
  card('50', 'GitHub: update dependencies', 'github-issue', 'planning'),
  card('manual', 'Manual follow-up', 'manual', 'intake'),
];

export const githubIssue: GithubIssue = {
  number: 42,
  title: 'GitHub: improve error messages',
  url: 'https://github.com/acme/app/issues/42',
  author: 'alice',
  labels: ['feature'],
  comments: 0,
  createdAt: now,
  updatedAt: now,
};

function wireSourceCard({ githubProjectId, source, sourceKey, url, ...item }: WorkItem) {
  const base = { ...item, factoryProjectId: githubProjectId };
  if (source === 'manual') return { ...base, externalSource: null };
  return {
    ...base,
    externalSource: {
      integrationId: 'github',
      type: 'issue',
      externalId: sourceKey,
      url,
    },
  };
}

export const wireSourceCards = sourceCards.map(wireSourceCard);
