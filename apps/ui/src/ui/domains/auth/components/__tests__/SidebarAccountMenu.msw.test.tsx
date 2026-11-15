/**
 * The sidebar footer's one row and one menu, against /auth/me and better-auth's organization
 * endpoints: the organization you work in on the row, the menu in order (email, theme, organization,
 * organization and profile settings, settings, log out), switching from the submenu, a single
 * organization without one, a failed list said in the submenu, and settings without an account.
 */
import { Sidebar, SidebarProvider } from '@mastra/playground-ui/components/Sidebar';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import { SettingsNavigation } from '../../../settings/components/SettingsNavigation';
import { redirectToLogout } from '../../services/auth';
import type * as AuthService from '../../services/auth';
import { reloadIntoOrganization } from '../../services/organization';
import type * as OrganizationService from '../../services/organization';
import { SidebarAccountMenu } from '../SidebarAccountMenu';
import { signedIn } from './fixtures/auth';

// jsdom cannot follow a full-page navigation; the reload and logout helpers are the boundary.
vi.mock('../../services/organization', async importOriginal => {
  const actual = await importOriginal<typeof OrganizationService>();
  return { ...actual, reloadIntoOrganization: vi.fn() };
});
vi.mock('../../services/auth', async importOriginal => {
  const actual = await importOriginal<typeof AuthService>();
  return { ...actual, redirectToLogout: vi.fn() };
});

const ORG_API = `${TEST_BASE_URL}/auth/api/organization`;
const acme = { id: 'org-acme', name: 'Acme', slug: 'acme' };
const personal = { id: 'org-ada', name: 'Personal', slug: 'personal-ada' };
const avatarUrl = 'https://avatars.example/ada.png';

afterEach(() => {
  vi.mocked(reloadIntoOrganization).mockClear();
  vi.mocked(redirectToLogout).mockClear();
});

function CurrentPath() {
  const { pathname, search, hash } = useLocation();
  return <output aria-label="Current path">{pathname + search + hash}</output>;
}

function currentPath() {
  return screen.getByRole('status', { name: 'Current path' });
}

function stubBetterAuth({
  organizations = [acme, personal],
  listFails = false,
  setActive = vi.fn<(body: unknown) => void>(),
}: {
  organizations?: Array<typeof acme>;
  listFails?: boolean;
  setActive?: (body: unknown) => void;
} = {}) {
  server.use(
    http.get(`${TEST_BASE_URL}/auth/me`, () =>
      HttpResponse.json({
        authEnabled: true,
        authenticated: true,
        provider: 'better-auth',
        user: { userId: 'ada', email: 'ada@example.com', name: 'Ada', avatarUrl, organizationId: 'org-acme' },
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

function renderFooter(initialEntry = '/factories/fp-1/work?status=active#sessions', collapsed = false) {
  return renderWithProviders(
    <MemoryRouter initialEntries={[initialEntry]}>
      <SidebarProvider
        storageKey="sidebar-account-menu-test"
        mobileBreakpoint={0}
        defaultState={collapsed ? 'collapsed' : 'default'}
      >
        <Routes>
          <Route
            path="/factories/:factoryId/*"
            element={
              <>
                <Sidebar.Footer aria-label="Footer">
                  <Sidebar.NavList>
                    <SidebarAccountMenu />
                  </Sidebar.NavList>
                </Sidebar.Footer>
                <Routes>
                  <Route path="settings/:section" element={<SettingsNavigation />} />
                  <Route path="*" element={<></>} />
                </Routes>
                <CurrentPath />
              </>
            }
          />
        </Routes>
      </SidebarProvider>
    </MemoryRouter>,
  );
}

async function openMenu(user: ReturnType<typeof userEvent.setup>, name = 'Account menu: Acme') {
  await user.click(await screen.findByRole('button', { name }));
  return screen.findByRole('menu');
}

describe('SidebarAccountMenu', () => {
  it('is one row naming the organization you work in', async () => {
    stubBetterAuth();
    renderFooter();

    const footer = await screen.findByLabelText('Footer');
    const trigger = await screen.findByRole('button', { name: 'Account menu: Acme' });
    expect(trigger).toHaveTextContent('Acme');
    expect(trigger).toHaveTextContent('Organization');
    expect(within(footer).getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('lists email, theme, organization, organization and profile settings, settings and log out, in that order', async () => {
    const user = userEvent.setup();
    stubBetterAuth();
    renderFooter();

    const menu = await openMenu(user);
    expect(within(menu).getByText('ada@example.com')).toBeInTheDocument();
    expect(within(menu).getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
    const items = within(menu).getAllByRole('menuitem').map(item => item.getAttribute('aria-label') ?? item.textContent);
    expect(items).toEqual([
      'Switch organization from Acme',
      'Organization settings',
      'Profile settings',
      'Settings',
      'Log out',
    ]);
  });

  it('switches organization from the submenu, with a check on the active one', async () => {
    const user = userEvent.setup();
    const setActive = vi.fn<(body: unknown) => void>();
    stubBetterAuth({ setActive });
    renderFooter();

    const menu = await openMenu(user);
    within(menu).getByRole('menuitem', { name: 'Switch organization from Acme' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(await screen.findByRole('menuitem', { name: /Acme/, current: true })).toBeInTheDocument();
    const other = screen.getByRole('menuitem', { name: /Personal/ });
    expect(other).not.toHaveAttribute('aria-current');
    other.focus();
    await user.keyboard('{Enter}');

    await waitFor(() => expect(setActive).toHaveBeenCalledWith({ organizationId: 'org-ada' }));
    await waitFor(() => expect(reloadIntoOrganization).toHaveBeenCalled());
  });

  it('shows a single organization as a row, without a submenu', async () => {
    const user = userEvent.setup();
    stubBetterAuth({ organizations: [acme] });
    renderFooter();

    const menu = await openMenu(user);
    await waitFor(() => expect(within(menu).getByLabelText('Current organization: Acme')).toBeInTheDocument());
    expect(within(menu).queryByRole('menuitem', { name: /Switch organization/ })).not.toBeInTheDocument();
  });

  it('says in the submenu when the organization list fails to load', async () => {
    const user = userEvent.setup();
    stubBetterAuth({ listFails: true });
    renderFooter();

    const menu = await openMenu(user, 'Account menu: Organization');
    await user.click(await within(menu).findByRole('menuitem', { name: /Switch organization/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load organizations");
  });

  it('opens organization settings, profile settings and settings, and returns to the page you were on', async () => {
    const user = userEvent.setup();
    stubBetterAuth();
    renderFooter();

    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Organization settings' }));
    expect(currentPath()).toHaveTextContent('/factories/fp-1/settings/organization');
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Profile settings' }));
    expect(currentPath()).toHaveTextContent('/factories/fp-1/settings/account');
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Settings' }));
    expect(currentPath()).toHaveTextContent('/factories/fp-1/settings/preferences');

    await user.click(screen.getByRole('button', { name: 'Back to app' }));
    expect(currentPath()).toHaveTextContent('/factories/fp-1/work?status=active#sessions');
  });

  it('logs out', async () => {
    const user = userEvent.setup();
    stubBetterAuth();
    renderFooter();

    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Log out' }));

    expect(redirectToLogout).toHaveBeenCalledWith(TEST_BASE_URL);
  });

  it('names you on the row when the sign-in has no organizations', async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${TEST_BASE_URL}/auth/me`, () =>
        HttpResponse.json({ ...signedIn, user: { ...signedIn.user, avatarUrl } }),
      ),
    );
    renderFooter();

    const trigger = await screen.findByRole('button', { name: 'Account menu: Dev' });
    expect(within(trigger).getByRole('img', { name: 'Dev' })).toHaveAttribute('src', avatarUrl);
    const menu = await openMenu(user, 'Account menu: Dev');
    expect(within(menu).queryByRole('menuitem', { name: 'Organization settings' })).not.toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Profile settings' })).toBeInTheDocument();
  });

  it('opens the menu from the keyboard when the sidebar is collapsed', async () => {
    const user = userEvent.setup();
    stubBetterAuth();
    renderFooter(undefined, true);

    const trigger = await screen.findByRole('button', { name: 'Account menu: Acme' });
    trigger.focus();
    await user.keyboard('{Enter}');

    expect(await screen.findByRole('menu')).toBeInTheDocument();
  });

  it.each([404, 401, 500])('keeps a settings link without a signed-in account (HTTP %s)', async status => {
    const user = userEvent.setup();
    server.use(http.get(`${TEST_BASE_URL}/auth/me`, () => new HttpResponse(null, { status })));
    renderFooter();

    await user.click(await screen.findByRole('link', { name: 'Settings' }));

    expect(currentPath()).toHaveTextContent('/factories/fp-1/settings/preferences');
  });
});
