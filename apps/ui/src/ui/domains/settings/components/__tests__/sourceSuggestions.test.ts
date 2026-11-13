import type { FilterBarField } from '@mastra/playground-ui/components/FilterBar';
import { describe, expect, it } from 'vitest';

import { narrowSuggestions, sourceSuggestions } from '../sourceSuggestions';

describe('sourceSuggestions', () => {
  it('lists the linked repositories with their host, each once whatever its case', () => {
    expect(
      sourceSuggestions([
        { projectRepositoryId: 'a', slug: 'acme/app' },
        { projectRepositoryId: 'b', slug: 'acme/platform/api', provider: 'gitlab' },
        { projectRepositoryId: 'c', slug: 'Acme/App', provider: 'github' },
      ]),
    ).toEqual([
      { value: 'acme/app', provider: 'github' },
      { value: 'acme/platform/api', provider: 'gitlab' },
    ]);
    expect(sourceSuggestions(undefined)).toEqual([]);
  });

  it('narrows to the providers the conditions beside it allow', () => {
    const field: FilterBarField = {
      id: 'source.repository',
      label: 'Repository',
      suggestions: sourceSuggestions([
        { projectRepositoryId: 'a', slug: 'acme/app' },
        { projectRepositoryId: 'b', slug: 'acme/platform/api', provider: 'gitlab' },
      ]),
    };
    const gitlab = narrowSuggestions(field, [{ field: 'source.integration', operator: 'equals', value: 'gitlab' }]);
    expect(gitlab.suggestions).toEqual([{ value: 'acme/platform/api', provider: 'gitlab' }]);
    expect(narrowSuggestions(field, []).suggestions).toHaveLength(2);
  });
});
