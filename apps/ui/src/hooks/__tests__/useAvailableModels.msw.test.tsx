import { waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../../e2e/ui/msw-server';
import { TEST_BASE_URL, renderHookWithProviders } from '../../../e2e/ui/render';
import { useAvailableModelsQuery } from '../useAvailableModels';

describe('scoped model catalogs', () => {
  it('caches organization and Factory catalogs separately', async () => {
    const queries: string[] = [];
    server.use(
      http.get(`${TEST_BASE_URL}/web/config/models`, ({ request }) => {
        const search = new URL(request.url).search;
        queries.push(search);
        const ids: Record<string, string> = { '': 'anthropic/claude-fable-5' };
        const id = ids[search] ?? 'deepseek/deepseek-flash';
        return HttpResponse.json({ models: [{ id, provider: id.split('/')[0], modelName: id, hasApiKey: true }] });
      }),
    );

    const { result } = renderHookWithProviders(() => ({
      factory: useAvailableModelsQuery({ factoryProjectId: 'fp-1' }),
      organization: useAvailableModelsQuery(),
    }));

    await waitFor(() => expect(result.current.factory.data?.map(m => m.id)).toEqual(['deepseek/deepseek-flash']));
    await waitFor(() => expect(result.current.organization.data?.map(m => m.id)).toEqual(['anthropic/claude-fable-5']));
    expect([...queries].sort()).toEqual(['', '?factoryId=fp-1']);
  });
});
