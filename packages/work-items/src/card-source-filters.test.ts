import { describe, expect, it } from 'vitest';

import { hasEveryLabel, metadataLabels } from './card-labels.ts';
import { boardSource, matchesSourceFilters, PULL_REQUEST_SOURCE_FILTER } from './card-source-filters.ts';
import type { SourceFacts } from './card-source-filters.ts';

function filters(source: string[] = []) {
  return { source: new Set(source) };
}

function card(source: SourceFacts['source'], more: { hasPullRequest?: boolean } = {}) {
  return { source, metadata: {}, hasPullRequest: more.hasPullRequest ?? false };
}

describe('boardSource', () => {
  it.each([
    ['github-issue', 'github'],
    ['github-pr', 'github'],
    ['gitlab-pr', 'gitlab'],
    ['clickup-task', 'clickup'],
    ['manual', 'manual'],
  ] as const)('files a %s card under %s', (source, filedUnder) => {
    expect(boardSource(source)).toBe(filedUnder);
  });
});

describe('matchesSourceFilters', () => {
  it('keeps every card when nothing is picked', () => {
    expect(matchesSourceFilters(card('manual'), filters())).toBe(true);
    expect(matchesSourceFilters(card('clickup-task'), filters())).toBe(true);
  });

  it('keeps the cards of any picked source', () => {
    const picked = filters(['github', 'manual']);

    expect(matchesSourceFilters(card('github-pr'), picked)).toBe(true);
    expect(matchesSourceFilters(card('manual'), picked)).toBe(true);
    expect(matchesSourceFilters(card('clickup-task'), picked)).toBe(false);
  });

  it('keeps every card that has a pull request when pull requests are picked, whatever filed it', () => {
    const picked = filters([PULL_REQUEST_SOURCE_FILTER]);

    expect(matchesSourceFilters(card('clickup-task', { hasPullRequest: true }), picked)).toBe(true);
    expect(matchesSourceFilters(card('manual', { hasPullRequest: true }), picked)).toBe(true);
    expect(matchesSourceFilters(card('github-issue'), picked)).toBe(false);
  });
});

describe('card labels', () => {
  it('reads the text labels a source put on an item', () => {
    expect(metadataLabels({ labels: ['bug', 7, null, 'Memory'] })).toEqual(['bug', 'Memory']);
    expect(metadataLabels({ labels: 'bug' })).toEqual([]);
    expect(metadataLabels({})).toEqual([]);
  });

  it('needs every picked label on the item', () => {
    const labels = new Set(['bug', 'Memory']);

    expect(hasEveryLabel(labels, [])).toBe(true);
    expect(hasEveryLabel(labels, ['bug', 'Memory'])).toBe(true);
    expect(hasEveryLabel(labels, ['bug', 'docs'])).toBe(false);
    expect(hasEveryLabel(labels, ['memory'])).toBe(false);
  });
});
