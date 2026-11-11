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

  it('groups destinations by topic: account, agent, Factory', () => {
    renderNavigation();

    const linksIn = (group: string) =>
      within(screen.getByRole('region', { name: group }))
        .getAllByRole('link')
        .map(link => link.textContent);
    expect(linksIn('Account')).toEqual(['My account', 'Preferences']);
    expect(linksIn('Agent')).toEqual(['Harness', 'Memory', 'Skills', 'Behavior']);
    expect(linksIn('Factory')).toEqual([
      'Repositories',
      'Environment',
      'Work Intake',
      'Logs and crashes',
      'Boards',
      'Manage Factory',
      'Debug',
    ]);
    expect(screen.getByRole('link', { name: 'Harness' })).toHaveAttribute('href', '/factories/fp-1/settings/models');
    expect(screen.getByRole('link', { name: 'Memory' })).toHaveAttribute('href', '/factories/fp-1/settings/memory');
  });

  it('leaves Memory out for a Factory on Claude Code', async () => {
    server.use(
      http.get(`${TEST_BASE_URL}/web/factory/projects/fp-1`, () =>
        HttpResponse.json({ project: { id: 'fp-1', name: 'Factory', harness: 'claude-code', claudeCodeModel: 'opus' } }),
      ),
    );
    renderNavigation();

    const agent = screen.getByRole('region', { name: 'Agent' });
    await waitFor(() => expect(within(agent).queryByRole('link', { name: 'Memory' })).not.toBeInTheDocument());
    expect(within(agent).getAllByRole('link').map(link => link.textContent)).toEqual(['Harness', 'Skills', 'Behavior']);
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
  ])('finds $destination by the former page name "$query"', async ({ query, destination }) => {
    const user = userEvent.setup();
    renderNavigation();

    await user.type(screen.getByRole('searchbox', { name: 'Search settings' }), query);

    expect(screen.getByRole('link', { name: destination })).toBeInTheDocument();
  });
});
