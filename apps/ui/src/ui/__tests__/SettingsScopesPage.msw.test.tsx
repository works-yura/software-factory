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

function renderSettings(section: string, { hash = '', search = '' } = {}) {
  const router = createMemoryRouter(createAppRoutes(), {
    initialEntries: [
      {
        pathname: `/factories/fp-1/settings/${section}`,
        hash,
        search,
        state: { settingsReturnTo: '/factories/fp-1/work' },
      },
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
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
      HttpResponse.json({ projects: [{ ...settingsFactory, repositories: [] }] }),
    ),
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
  it('writes organization credentials from Providers', async () => {
    let keyBody: unknown;
    server.use(
      http.put(`${PROVIDERS_URL}/openai/key`, async ({ request }) => {
        keyBody = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );
    const user = userEvent.setup();
    renderSettings('models');

    const factoryDefaults = await screen.findByRole('region', { name: 'Providers' });
    expect(screen.queryByRole('region', { name: 'Personal defaults' })).not.toBeInTheDocument();
    await user.click(await within(factoryDefaults).findByRole('button', { name: 'OpenAI actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Update key' }));
    await user.type(screen.getByPlaceholderText('Paste API key'), 'sk-shared');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(keyBody).toEqual({ key: 'sk-shared', scope: 'org' }));
  });

  it('lets members inspect shared provider settings and explains why edits require an admin', async () => {
    server.use(http.get(PROVIDERS_URL, () => HttpResponse.json({ ...settingsProviders, orgKeyAdmin: false })));
    renderSettings('models');

    const factoryDefaults = await screen.findByRole('region', { name: 'Providers' });
    expect(
      await within(factoryDefaults).findByText('Only organization admins can manage org-wide credentials.'),
    ).toBeInTheDocument();
    expect(within(factoryDefaults).getByText('Key saved')).toBeInTheDocument();
    expect(within(factoryDefaults).getByRole('button', { name: 'OpenAI actions' })).toBeDisabled();
    expect(within(factoryDefaults).getByRole('button', { name: 'Add provider' })).toBeDisabled();
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
    renderSettings('memory');
    const card = await screen.findByRole('region', { name: 'Factory memory' });
    const input = await within(card).findByRole('textbox', { name: 'Observe after' });
    await waitFor(() => expect(requestedFactoryIds).toContain('fp-1'));
    expect(screen.queryByRole('region', { name: 'Personal memory' })).not.toBeInTheDocument();
    await user.clear(input);
    await user.type(input, '4000');
    await user.tab();
    await waitFor(() => expect(body).toEqual({ factoryId: 'fp-1', observationThreshold: 4000 }));
  });

  it.each([
    { section: 'personal-models', hash: '' },
    { section: 'models', hash: '#model-packs' },
  ])('sends $section$hash to Models #factory-defaults, keeping search and return state', async ({ section, hash }) => {
    const router = renderSettings(section, { hash, search: '?from=chat' });

    expect(await screen.findByRole('region', { name: 'Providers' })).toBeInTheDocument();
    expect(router.state.location).toMatchObject({
      pathname: '/factories/fp-1/settings/models',
      hash: '#factory-defaults',
      search: '?from=chat',
      state: { settingsReturnTo: '/factories/fp-1/work' },
    });
    expect(screen.getByRole('link', { name: 'Harness' })).toHaveAttribute('aria-current', 'page');
  });

  it('sends retired Factory memory links to Memory', async () => {
    const router = renderSettings('factory-memory');

    expect(await screen.findByRole('region', { name: 'Factory memory' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/factories/fp-1/settings/memory');
    expect(screen.getByRole('link', { name: 'Memory' })).toHaveAttribute('aria-current', 'page');
  });

  it('sends retired Connections links to Repositories', async () => {
    const router = renderSettings('connections');

    await waitFor(() => expect(router.state.location.pathname).toBe('/factories/fp-1/settings/repositories'));
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Repositories' })).toHaveAttribute('aria-current', 'page'),
    );
  });
});
