import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { TEST_BASE_URL, renderWithProviders } from '../../../../../../e2e/ui/render';
import type { OMConfigInfo, ProviderInfo } from '../../../../../api/types';
import { MemorySettings } from '../MemorySettings';

const OM_URL = `${TEST_BASE_URL}/web/config/om`;

const omConfig = (observationThreshold: number): OMConfigInfo => ({
  observer: {
    model: 'openai/gpt-5',
    effectiveModelId: 'openai/gpt-5',
    effectiveModelSource: 'explicit',
    providerStatus: 'available',
  },
  reflector: {
    model: 'openai/gpt-5',
    effectiveModelId: 'openai/gpt-5',
    effectiveModelSource: 'explicit',
    providerStatus: 'available',
  },
  observerModelId: 'openai/gpt-5',
  reflectorModelId: 'openai/gpt-5',
  observationThreshold,
  reflectionThreshold: 40_000,
  observeAttachments: 'auto',
});

function stubProviders(providers: ProviderInfo[]) {
  server.use(
    http.get(`${TEST_BASE_URL}/web/config/providers`, () => HttpResponse.json({ providers })),
    http.get(`${TEST_BASE_URL}/web/config/custom-providers`, () => HttpResponse.json({ providers: [] })),
  );
}

function renderMemory() {
  return renderWithProviders(
    <MemoryRouter>
      <MemorySettings factoryId="fp-1" />
    </MemoryRouter>,
  );
}

describe('MemorySettings', () => {
  it('edits the Factory memory config, used by chats and work-item runs', async () => {
    let factoryWrite: unknown;
    stubProviders([{ provider: 'openai', source: 'stored-org' }]);
    server.use(
      http.get(OM_URL, ({ request }) => {
        expect(new URL(request.url).searchParams.get('factoryId')).toBe('fp-1');
        return HttpResponse.json({ config: omConfig(50_000) });
      }),
      http.put(`${OM_URL}/thresholds`, async ({ request }) => {
        factoryWrite = await request.json();
        return HttpResponse.json({ ok: true, config: omConfig(60_000) });
      }),
    );
    const user = userEvent.setup();
    renderMemory();

    expect(screen.queryByRole('region', { name: 'Personal memory' })).not.toBeInTheDocument();
    const factory = screen.getByRole('region', { name: 'Factory memory' });
    expect(within(factory).getByText('Chats')).toBeInTheDocument();
    expect(within(factory).getByText('Work-item runs')).toBeInTheDocument();
    const factoryThreshold = await within(factory).findByRole('textbox', { name: 'Observe after' });
    expect(factoryThreshold).toHaveValue('50,000');

    await user.clear(factoryThreshold);
    await user.type(factoryThreshold, '60000');
    await user.tab();

    await waitFor(() => expect(factoryWrite).toEqual({ factoryId: 'fp-1', observationThreshold: 60_000 }));
  });

  it('points to Models settings while no provider is connected', async () => {
    stubProviders([{ provider: 'openai', source: 'none' }]);
    renderMemory();

    expect(await screen.findByRole('heading', { name: 'No models configured' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Models settings' })).toHaveAttribute(
      'href',
      '/factories/fp-1/settings/models',
    );
  });
});
