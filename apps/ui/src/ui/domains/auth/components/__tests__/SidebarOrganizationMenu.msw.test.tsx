/**
 * The sidebar footer's organization menu against better-auth's organization endpoints: the active
 * organization by name, the others to switch to (a check on the active one), its settings, and a
 * failed list said in the menu rather than hidden.
 */
import { SidebarProvider } from '@mastra/playground-ui/components/Sidebar';
import { Sidebar } from '@mastra/playground-ui/components/Sidebar';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import { reloadIntoOrganization } from '../../services/organization';
import type * as OrganizationService from '../../services/organization';
import { SidebarOrganizationMenu } from '../SidebarOrganizationMenu';

// jsdom cannot follow a full-page navigation; the reload helper is the boundary.
vi.mock('../../services/organization', async importOriginal => {
  const actual = await importOriginal<typeof OrganizationService>();
  return { ...actual, reloadIntoOrganization: vi.fn() };
});

const ORG_API = `${TEST_BASE_URL}/auth/api/organization`;
const acme = { id: 'org-acme', name: 'Acme', slug: 'acme' };
const personal = { id: 'org-ada', name: 'Personal', slug: 'personal-ada' };

afterEach(() => vi.mocked(reloadIntoOrganization).mockClear());

function CurrentPath() {
  const { pathname } = useLocation();
  return <output aria-label="Current path">{pathname}</output>;
}

function stub({
  provider = 'better-auth',
  organizations = [acme],
  listFails = false,
  setActive = vi.fn<(body: unknown) => void>(),
}: {
  provider?: string;
  organizations?: Array<typeof acme>;
  listFails?: boolean;
  setActive?: (body: unknown) => void;
} = {}) {
  server.use(
    http.get(`${TEST_BASE_URL}/auth/me`, () =>
      HttpResponse.json({
        authEnabled: true,
        authenticated: true,
        provider,
        user: { userId: 'ada', email: 'ada@example.com', name: 'Ada', organizationId: 'org-acme' },
      }),
    ),
    http.get(`${ORG_API}/list`, () =>
      listFails
        ? HttpResponse.json({ message: 'Database is unavailable' }, { status: 500 })
        : HttpResponse.json(organizations),
    ),
    http.post(`${ORG_API}/set-active`, async ({ request }) => {
      setActive(await request.json());
      return HttpResponse.json(personal);
    }),
  );
}

function renderMenu() {
  return renderWithProviders(
    <MemoryRouter initialEntries={['/factories/fp-1/work']}>
      <SidebarProvider storageKey="sidebar-org-menu-test" mobileBreakpoint={0}>
        <Routes>
          <Route
            path="/factories/:factoryId/*"
            element={
              <>
                <Sidebar.NavList>
                  <SidebarOrganizationMenu />
                </Sidebar.NavList>
                <CurrentPath />
              </>
            }
          />
        </Routes>
      </SidebarProvider>
    </MemoryRouter>,
  );
}

describe('SidebarOrganizationMenu', () => {
  it('lists your organizations with a check on the active one and switches to another', async () => {
    const setActive = vi.fn<(body: unknown) => void>();
    stub({ organizations: [acme, personal], setActive });
    const user = userEvent.setup();
    renderMenu();

    await user.click(await screen.findByRole('button', { name: 'Organization: Acme' }));
    expect(await screen.findByText('Organizations')).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: 'Acme' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: 'Personal' })).toHaveAttribute('aria-checked', 'false');

    await user.click(screen.getByRole('menuitemradio', { name: 'Personal' }));

    await waitFor(() => expect(reloadIntoOrganization).toHaveBeenCalled());
    expect(setActive).toHaveBeenCalledWith({ organizationId: 'org-ada' });
  });

  it('with one organization offers only its settings, nothing to switch to', async () => {
    stub();
    const user = userEvent.setup();
    renderMenu();

    await user.click(await screen.findByRole('button', { name: 'Organization: Acme' }));
    const settings = await screen.findByRole('menuitem', { name: 'Organization settings' });
    expect(screen.queryByRole('menuitemradio')).not.toBeInTheDocument();
    await user.click(settings);

    expect(screen.getByRole('status', { name: 'Current path' })).toHaveTextContent('/factories/fp-1/settings/organization');
  });

  it('says when your organizations cannot be listed instead of hiding the switch', async () => {
    stub({ listFails: true });
    const user = userEvent.setup();
    renderMenu();

    await user.click(await screen.findByRole('button', { name: 'Organization: Organization' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load organizations: Database is unavailable");
    expect(screen.getByRole('menuitem', { name: 'Organization settings' })).toBeInTheDocument();
  });

  it('shows nothing without better-auth, which is what has organizations', async () => {
    stub({ provider: 'custom-sso' });
    renderMenu();

    await screen.findByRole('status', { name: 'Current path' });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(screen.queryByRole('button', { name: /^Organization:/ })).not.toBeInTheDocument();
  });
});
