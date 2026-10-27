import { describe, expect, it } from 'vitest';
import { boardFilterItems, boardFilterParams, boardFilterStateFromItems, boardFiltersFromParams } from './boardFilters';
import { boardSource } from './boardSourceFilters';

describe('Board source filters', () => {
  it('preserves every filter through URL and saved view filters', () => {
    const params = new URLSearchParams(
      'source=github&source=gitlab&author=github%3Aalice&assignee=github%3Abob&label=needs%2Creview&label=p0&sort=created-newest',
    );
    const state = boardFiltersFromParams(params, 'work');
    const restored = boardFilterStateFromItems(boardFilterItems(state), 'work');
    const url = boardFilterParams(params, restored);
    expect(url.getAll('source')).toEqual(['github', 'gitlab']);
    expect(url.getAll('author')).toEqual(['github:alice']);
    expect(url.getAll('assignee')).toEqual(['github:bob']);
    expect(url.getAll('label')).toEqual(['needs,review', 'p0']);
    expect(url.get('sort')).toBe('created-newest');
  });

  it('groups issue and pull request sources under their providers', () => {
    expect(boardSource('github-issue')).toBe('github');
    expect(boardSource('github-pr')).toBe('github');
    expect(boardSource('gitlab-pr')).toBe('gitlab');
    expect(boardSource('manual')).toBe('manual');
  });
});
