import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import { IntegrationsSection } from '../IntegrationsSection';

const FACTORY_ID = 'fp-1';

function Search() {
  return <output aria-label="search">{useLocation().search}</output>;
}

function renderIntegrations(search = '') {
  renderWithProviders(
    <MemoryRouter initialEntries={[`/factories/${FACTORY_ID}/settings/integrations${search}`]}>
      <Routes>
        <Route
          path="/factories/:factoryId/settings/integrations"
          element={
            <>
              <IntegrationsSection />
              <Search />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

function useHandlers() {
  server.use(
    http.get(`${TEST_BASE_URL}/auth/me`, () => HttpResponse.json({ authenticated: true, authEnabled: true, user: { userId: 'user-1' } })),
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
      HttpResponse.json({ projects: [{ id: FACTORY_ID, name: 'syncts', repositories: [] }] }),
    ),
    http.get(`${TEST_BASE_URL}/web/firebase/status`, () =>
      HttpResponse.json({
        accounts: [{ id: 'acc-1', name: 'Syncta', clientEmail: 'factory@syncta-57c6a.iam.gserviceaccount.com', projectId: 'syncta-57c6a', keyId: 'k', bindingIds: ['bnd-1'] }],
        bindings: [
          { id: 'bnd-1', factoryProjectId: FACTORY_ID, accountId: 'acc-1', projectId: 'syncta-57c6a', logs: true, crashes: false, apps: [], database: { enabled: true } },
        ],
      }),
    ),
    http.get(`${TEST_BASE_URL}/web/clickup/status`, () =>
      HttpResponse.json({ configured: true, connected: true, workspaces: ['eclipt.ai'], intervalSeconds: 60 }),
    ),
    http.get(`${TEST_BASE_URL}/web/intake/config`, () =>
      HttpResponse.json({ config: { github: { enabled: false, sourceIds: null }, gitlab: { enabled: false, sourceIds: null }, clickup: { enabled: true, sourceIds: null } } }),
    ),
    http.get(`${TEST_BASE_URL}/web/github/status`, () => HttpResponse.json({ enabled: true, connected: true, installations: [], reason: 'ready' })),
    http.get(`${TEST_BASE_URL}/web/gitlab/status`, () => HttpResponse.json({ enabled: false, configured: false, reason: 'missing_config' })),
    http.get(`${TEST_BASE_URL}/web/mcp-servers`, () =>
      HttpResponse.json({
        servers: [
          {
            id: 'srv-gc',
            name: 'db-syncta-57c6a',
            label: 'Firestore syncta-57c6a',
            owner: { integration: 'firebase', key: 'bnd-1' },
            launch: { transport: 'catalog', entry: 'mcp-toolbox', variant: 'firestore', inputs: {}, credentials: {} },
            secretNames: { env: [], headers: [], files: [] },
            assignments: [{ factoryProjectId: FACTORY_ID }],
            toolPolicies: { default: 'allow', tools: {} },
            maskPersonalData: true,
            enabled: true,
            updatedAt: '2026-11-12T00:00:00.000Z',
            updatedBy: 'integration:firebase',
          },
        ],
        catalog: [],
        credentials: {},
        canEdit: true,
      }),
    ),
  );
}

describe('IntegrationsSection', () => {
  it('lists the services as cards with their status, Google Cloud first', async () => {
    useHandlers();
    renderIntegrations();

    expect(await screen.findByRole('button', { name: /^Google Cloud\s*Accounts: 1 · bindings: 1$/ })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /^ClickUp\s*Connected: eclipt\.ai$/ })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /^GitHub\s*Connected$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^GitLab\s*Not connected$/ })).toBeInTheDocument();
  });

  it('opens the service the URL names, and keeps the open one in the URL', async () => {
    useHandlers();
    renderIntegrations('?tab=services&service=clickup');

    expect(await screen.findByRole('switch', { name: 'Import ClickUp tasks' })).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: /^Google Cloud/ }));
    expect(screen.getByLabelText('search')).toHaveTextContent('?tab=services&service=google-cloud');
    await userEvent.click(await screen.findByRole('button', { name: /^syncts → syncta-57c6a/ }));
    expect(screen.getByRole('switch', { name: 'Database (Firestore)' })).toBeChecked();
  });

  it('shows the MCP tab from the URL with the servers Google Cloud manages, and switches tabs into the URL', async () => {
    useHandlers();
    renderIntegrations('?tab=mcp');

    expect(await screen.findByRole('button', { name: /^Firestore syncta-57c6a.*managed by Google Cloud/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Services' }));
    expect(screen.getByLabelText('search')).toHaveTextContent('?tab=services');
    expect(await screen.findByRole('button', { name: /^ClickUp/ })).toBeInTheDocument();
  });
});
