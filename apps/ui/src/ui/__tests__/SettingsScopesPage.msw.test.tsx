import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';

import { server } from '../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../e2e/ui/render';
import { createAppRoutes } from '../router';
import {
  settingsFactory,
  settingsMemory,
  settingsProviders,
  settingsSession,
} from './fixtures/settingsScopes';

const PROVIDERS_URL = `${TEST_BASE_URL}/web/config/providers`;
const OM_URL = `${TEST_BASE_URL}/web/config/om`;

function renderSettings(section: string) {
  const router = createMemoryRouter(createAppRoutes(), {
    initialEntries: [
      { pathname: `/factories/fp-1/settings/${section}`, state: { settingsReturnTo: '/factories/fp-1/work' } },
    ],
  });
  renderWithProviders(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  server.use(
    http.get(`${TEST_BASE_URL}/auth/me`, () =>
      HttpResponse.json({ authenticated: true, authEnabled: true, user: { userId: 'user-1' } }),
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () => HttpResponse.json({ projects: [settingsFactory] })),
    http.get(`${TEST_BASE_URL}/web/factory/projects/fp-1`, () => HttpResponse.json({ project: settingsFactory })),
    http.post(`${TEST_BASE_URL}/api/agent-controller/code/sessions`, () => HttpResponse.json(settingsSession)),
    http.get(`${TEST_BASE_URL}/api/agent-controller/code/sessions/fp-1`, () => HttpResponse.json(settingsSession)),
    http.get(`${TEST_BASE_URL}/api/agent-controller/code/sessions/fp-1/permissions`, () =>
      HttpResponse.json({ categories: {}, tools: {} }),
    ),
    http.get(PROVIDERS_URL, () => HttpResponse.json(settingsProviders)),
    http.get(`${TEST_BASE_URL}/web/config/custom-providers`, () => HttpResponse.json({ providers: [] })),
    http.get(OM_URL, () => HttpResponse.json({ config: settingsMemory })),
  );
});

describe('Settings ownership', () => {
  it.each(['personal-models', 'memory'])('has no personal %s page: an old link opens preferences', async section => {
    const router = renderSettings(section);

    await waitFor(() => expect(router.state.location.pathname).toBe('/factories/fp-1/settings/preferences'));
    const personal = await screen.findByRole('region', { name: 'Your settings' });
    expect(within(personal).queryByRole('link', { name: 'Your models' })).not.toBeInTheDocument();
    expect(within(personal).queryByRole('link', { name: 'Your memory' })).not.toBeInTheDocument();
  });

  it('keeps shared defaults in Factory models and writes organization credentials', async () => {
    let keyBody: unknown;
    server.use(
      http.put(`${PROVIDERS_URL}/openai/key`, async ({ request }) => {
        keyBody = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );
    const user = userEvent.setup();
    renderSettings('models');

    expect(await screen.findByText('Factory defaults')).toBeInTheDocument();
    expect(await screen.findByRole('group', { name: 'Model and thinking' })).toBeInTheDocument();
    expect(screen.queryByText('Chat defaults')).not.toBeInTheDocument();
    expect(screen.queryByText('Thinking defaults')).not.toBeInTheDocument();
    expect(screen.queryByText('Your defaults')).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Connect with API key' }));
    await user.click(await screen.findByRole('button', { name: 'Update key for OpenAI' }));
    await user.type(screen.getByPlaceholderText('Paste API key'), 'sk-shared');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(keyBody).toEqual({ key: 'sk-shared', scope: 'org' }));
  });

  it('lets members inspect shared provider settings and explains why edits require an admin', async () => {
    server.use(http.get(PROVIDERS_URL, () => HttpResponse.json({ ...settingsProviders, orgKeyAdmin: false })));
    const user = userEvent.setup();
    renderSettings('models');

    expect(await screen.findByText('Only organization admins can manage org-wide credentials.')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Connect with API key' }));
    expect(await screen.findByText('Key saved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update key for OpenAI' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove key for OpenAI' })).toBeDisabled();
  });

  it('edits Factory memory under the Factory id', async () => {
    let body: unknown;
    const requestedFactoryIds: Array<string | null> = [];
    server.use(
      http.get(OM_URL, ({ request }) => {
        requestedFactoryIds.push(new URL(request.url).searchParams.get('factoryId'));
        return HttpResponse.json({ config: settingsMemory });
      }),
      http.put(`${OM_URL}/thresholds`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ok: true, config: { ...settingsMemory, observationThreshold: 4000 } });
      }),
    );
    const user = userEvent.setup();
    renderSettings('factory-memory');
    const input = await screen.findByDisplayValue('1,000');
    await waitFor(() => expect(requestedFactoryIds).toContain('fp-1'));
    expect(screen.queryByRole('group', { name: 'Who these settings apply to' })).not.toBeInTheDocument();
    await user.clear(input);
    await user.type(input, '4000');
    await user.tab();
    await waitFor(() => expect(body).toEqual({ factoryId: 'fp-1', observationThreshold: 4000 }));
  });

  it('keeps legacy model settings deep links on Factory models with the return location', async () => {
    const router = createMemoryRouter(createAppRoutes(), {
      initialEntries: [
        {
          pathname: '/factories/fp-1/settings/models',
          hash: '#model-packs',
          search: '?from=chat',
          state: { settingsReturnTo: '/factories/fp-1/work' },
        },
      ],
    });
    renderWithProviders(<RouterProvider router={router} />);
    expect(await screen.findByText('Factory defaults')).toBeInTheDocument();
    expect(router.state.location).toMatchObject({
      pathname: '/factories/fp-1/settings/models',
      search: '?from=chat',
      state: { settingsReturnTo: '/factories/fp-1/work' },
    });
    const factory = screen.getByRole('region', { name: 'Factory settings' });
    expect(within(factory).getByRole('link', { name: 'Factory models' })).toHaveAttribute('aria-current', 'page');
  });
});
