import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { TEST_BASE_URL, renderWithProviders } from '../../../../../../e2e/ui/render';
import { FactoryModelsSettings } from '../FactoryModelsSettings';

describe('FactoryModelsSettings', () => {
  it('keeps Factory defaults visible without a default-model picker when no provider is connected', async () => {
    server.use(
      http.get(`${TEST_BASE_URL}/web/config/providers`, () => HttpResponse.json({ providers: [] })),
      http.get(`${TEST_BASE_URL}/web/config/custom-providers`, () => HttpResponse.json({ providers: [] })),
      http.get(`${TEST_BASE_URL}/web/factory/projects/fp-1`, () =>
        HttpResponse.json({ project: { id: 'fp-1', name: 'Mastra' } }),
      ),
    );

    renderWithProviders(
      <MemoryRouter initialEntries={['/factories/fp-1/settings/models']}>
        <Routes>
          <Route path="/factories/:factoryId/settings/models" element={<FactoryModelsSettings models={[]} />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Factory defaults')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Model scope' })).not.toBeInTheDocument();
    expect(await screen.findByText('No providers support sign in.')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('combobox', { name: 'Factory default model' })).not.toBeInTheDocument(),
    );
  });
});
