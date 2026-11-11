import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../../../e2e/ui/msw-server';
import { TEST_BASE_URL, renderWithProviders } from '../../../../../../../../e2e/ui/render';
import { ModelRoutingSection } from '../ModelRoutingSection';

const FACTORY_URL = `${TEST_BASE_URL}/web/factory/projects/fp-1`;

function stubFactory() {
  server.use(
    http.get(FACTORY_URL, () => HttpResponse.json({ project: { id: 'fp-1', name: 'Mastra' } })),
    http.get(`${TEST_BASE_URL}/web/config/models`, () =>
      HttpResponse.json({
        models: [{ id: 'openai/gpt-5', provider: 'openai', modelName: 'gpt-5', hasApiKey: true }],
        // The Factory has no Mastra default of its own: it follows the catalog's.
        fallbackModelId: 'openai/gpt-5',
      }),
    ),
  );
}

const renderRoutingSection = (entry = '/factories/fp-1/settings/models') =>
  renderWithProviders(
    <MemoryRouter initialEntries={[entry]}>
      <ModelRoutingSection factoryId="fp-1" />
    </MemoryRouter>,
  );

const region = (label: string) => screen.getByRole('region', { name: label });

describe('ModelRoutingSection', () => {
  it('routes chats and work-item runs to the Factory defaults, with no routing to pick', async () => {
    stubFactory();
    renderRoutingSection();

    expect(within(region('Chats')).getByText('Uses Factory defaults')).toBeInTheDocument();
    expect(within(region('Work-item runs')).getByText('Uses Factory defaults')).toBeInTheDocument();
    // The model is set in Default models; the card shows it and links there.
    expect(await within(region('Factory defaults')).findByText('gpt-5')).toBeInTheDocument();
    expect(within(region('Factory defaults')).getByRole('link', { name: 'Change' })).toHaveAttribute('href', '#model-defaults');
    expect(await within(region('Factory defaults')).findByRole('button', { name: 'Add provider' })).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Model routing' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Personal defaults' })).not.toBeInTheDocument();
  });

  it('shows where chats and work-item runs come from', () => {
    stubFactory();
    renderRoutingSection();

    expect(within(region('Chats')).getByText('Web app')).toBeInTheDocument();
    expect(within(region('Work-item runs')).getByText('GitHub')).toBeInTheDocument();
    expect(within(region('Work-item runs')).getByText('GitLab')).toBeInTheDocument();
  });

  it('gives the Factory defaults card the anchor links open', async () => {
    stubFactory();
    renderRoutingSection('/factories/fp-1/settings/models#factory-defaults');

    await waitFor(() => expect(region('Factory defaults')).toHaveAttribute('id', 'factory-defaults'));
  });
});
