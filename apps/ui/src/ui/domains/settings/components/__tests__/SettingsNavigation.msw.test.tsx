import { SidebarProvider } from '@mastra/playground-ui/components/Sidebar';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';

import { SettingsNavigation } from '../SettingsNavigation';
import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';

const STORAGE_KEY = 'settings-navigation-test';

function renderNavigation() {
  return renderWithProviders(
    <MemoryRouter initialEntries={['/factories/fp-1/settings/preferences']}>
      <SidebarProvider storageKey={STORAGE_KEY} mobileBreakpoint={0}>
        <Routes>
          <Route path="/factories/:factoryId/settings/:section" element={<SettingsNavigation />} />
        </Routes>
      </SidebarProvider>
    </MemoryRouter>,
  );
}

afterEach(() => window.localStorage.removeItem(STORAGE_KEY));

describe('SettingsNavigation', () => {
  it('links to My account settings', () => {
    renderNavigation();

    expect(screen.getByRole('link', { name: 'My account' })).toHaveAttribute(
      'href',
      '/factories/fp-1/settings/account',
    );
  });

  it("groups destinations by where they live: the person's, the organization's, this Factory's, the server's", async () => {
    server.use(
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
        HttpResponse.json({ projects: [{ id: 'fp-1', name: 'bookfate', repositories: [] }] }),
      ),
    );
    renderNavigation();

    const linksIn = (group: string) =>
      within(screen.getByRole('region', { name: group }))
        .getAllByRole('link')
        .map(link => link.textContent);
    expect(linksIn('Account')).toEqual(['My account', 'Preferences']);
    expect(linksIn('Organization')).toEqual(['Organization', 'Team', 'Connections']);
    // The Factory group: the Factory you are in, never its name (the sidebar already says which).
    await screen.findByRole('region', { name: 'Factory' });
    expect(linksIn('Factory')).toEqual([
      'Harness',
      'Memory',
      'Behavior',
      'Repositories',
      'Environment',
      'Work Intake',
      'Analytics',
      'Manage',
    ]);
    expect(linksIn('Server')).toEqual(['Debug']);
    expect(screen.queryByRole('region', { name: 'Agent' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Organization' })).toHaveAttribute('href', '/factories/fp-1/settings/organization');
    expect(screen.getByRole('link', { name: 'Harness' })).toHaveAttribute('href', '/factories/fp-1/settings/models');
    expect(screen.getByRole('link', { name: 'Connections' })).toHaveAttribute('href', '/factories/fp-1/settings/integrations');
  });

  it('leaves Memory out for a Factory on Claude Code', async () => {
    server.use(
      http.get(`${TEST_BASE_URL}/web/factory/projects/fp-1`, () =>
        HttpResponse.json({ project: { id: 'fp-1', name: 'Factory', harness: 'claude-code', claudeCodeModel: 'opus' } }),
      ),
    );
    renderNavigation();

    const factory = () => screen.getAllByRole('region').find(region => region.getAttribute('aria-labelledby') === 'settings-factory')!;
    await waitFor(() => expect(within(factory()).queryByRole('link', { name: 'Memory' })).not.toBeInTheDocument());
    expect(within(factory()).getAllByRole('link').map(link => link.textContent)).toEqual([
      'Harness',
      'Behavior',
      'Repositories',
      'Environment',
      'Work Intake',
      'Analytics',
      'Manage',
    ]);
  });

  it('keeps legacy terms searchable while showing the clearer destination label', async () => {
    const user = userEvent.setup();
    renderNavigation();

    await user.type(screen.getByRole('searchbox', { name: 'Search settings' }), 'source control');

    expect(screen.getByRole('link', { name: 'Repositories' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Work Intake' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Account' })).not.toBeInTheDocument();
  });

  it.each([
    { query: 'default model', destination: 'Harness' },
    { query: 'factory models', destination: 'Harness' },
    { query: 'factory memory', destination: 'Memory' },
    { query: 'shared memory', destination: 'Memory' },
    { query: 'usage', destination: 'Analytics' },
    { query: 'mcp', destination: 'Connections' },
    { query: 'crashlytics', destination: 'Connections' },
    { query: 'clickup', destination: 'Connections' },
    { query: 'metrics', destination: 'Analytics' },
  ])('finds $destination by the former page name "$query"', async ({ query, destination }) => {
    const user = userEvent.setup();
    renderNavigation();

    await user.type(screen.getByRole('searchbox', { name: 'Search settings' }), query);

    expect(screen.getByRole('link', { name: destination })).toBeInTheDocument();
  });
});
