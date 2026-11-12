import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import { connectionNavigation } from '../../connections/api';
import type { McpActivity, McpServer } from '../../services/mcpServers';
import {
  acmeConnection,
  acmeConnector,
  FACTORY_ID,
  firebaseState,
  managedServer,
  MCP_BASE,
  renderConnections,
  useIntegrationHandlers,
} from './fixtures/connections';

const own: McpServer = {
  ...managedServer,
  id: 'srv-sentry',
  name: 'sentry',
  label: 'Sentry',
  owner: undefined,
  launch: { transport: 'http', url: 'https://mcp.sentry.dev/mcp', headers: {} },
  assignments: [{ factoryProjectId: FACTORY_ID, sessions: ['chat'] }, { factoryProjectId: 'other-factory' }],
  health: { state: 'error', tools: [], error: '401', errorKind: 'auth_denied' },
};
const elsewhere: McpServer = { ...own, id: 'srv-notes', name: 'notes', label: 'Notes', assignments: [{ factoryProjectId: 'other-factory' }], health: undefined };

function useHandlers(options: { activity?: McpActivity } = {}) {
  useIntegrationHandlers({ firebase: firebaseState });
  const writes: Array<{ method: string; url: string; body: unknown }> = [];
  server.use(
    http.get(MCP_BASE, () => HttpResponse.json({ servers: [managedServer, own, elsewhere], catalog: [], credentials: {}, canEdit: true })),
    http.put(`${MCP_BASE}/:id`, async ({ request }) => {
      const body = await request.json();
      writes.push({ method: 'PUT', url: request.url, body });
      return HttpResponse.json({ server: { ...own, ...(body as object) } });
    }),
    http.delete(`${MCP_BASE}/:id`, ({ request }) => {
      writes.push({ method: 'DELETE', url: request.url, body: null });
      return HttpResponse.json({ deleted: true });
    }),
    http.post(`${MCP_BASE}/:id/reconnect`, ({ request }) => {
      writes.push({ method: 'RECONNECT', url: request.url, body: null });
      return HttpResponse.json({ status: { connected: true, toolCount: 3, tools: [], checkedAt: 'now' } });
    }),
    http.delete(`${TEST_BASE_URL}/web/firebase/bindings/:id`, ({ request }) => {
      writes.push({ method: 'DELETE', url: request.url, body: null });
      return HttpResponse.json({ accounts: firebaseState.accounts, bindings: [] });
    }),
    ...(options.activity ? [http.get(`${MCP_BASE}/activity`, () => HttpResponse.json(options.activity))] : []),
  );
  return writes;
}

const rows = async () => within(await screen.findByRole('table', { name: "This Factory's connections" })).getAllByTestId('connection-row');
const rowNamed = async (name: string) => (await rows()).find(row => within(row).queryByRole('link', { name }))!;

async function openMenu(name: string) {
  await userEvent.click(screen.getByRole('button', { name: `Actions for ${name}` }));
  await screen.findByRole('menuitem', { name: 'Open' });
}

describe('Підключення', () => {
  it("lists the Factory's connections in one table: Google Cloud with its «База», organization-wide sources, MCP servers last by badge; never another Factory's", async () => {
    useHandlers();
    renderConnections();

    expect(screen.getByRole('heading', { name: 'Connections', level: 1 })).toBeInTheDocument();
    const list = await rows();
    expect(list.map(row => within(row).getByRole('link').textContent)).toEqual(['syncta-57c6a', 'Acme main', 'Sentry']);
    const google = await rowNamed('syncta-57c6a');
    expect(google).toHaveTextContent('Google Cloud');
    expect(google).toHaveTextContent('Syncta');
    // Capabilities are icons, each named.
    expect(within(google).getByRole('img', { name: 'Logs' })).toBeInTheDocument();
    expect(within(google).getByRole('img', { name: 'Database' })).toBeInTheDocument();
    // A first-party integration says what it gives, never how it runs; a working one says nothing about its state.
    expect(google).not.toHaveTextContent('MCP');
    expect(google).not.toHaveTextContent('Working');
    // The «База» server is the binding's, not a row of its own.
    expect(screen.queryByRole('link', { name: /^Firestore syncta-57c6a/ })).not.toBeInTheDocument();
    const sentry = await rowNamed('Sentry');
    expect(sentry).toHaveTextContent('MCP');
    expect(within(sentry).getByText('Error').closest('[data-state]')).toHaveAttribute('title', expect.stringContaining('The account was refused access'));
    // A server connector's row is all the server's: its name, account and what it provides.
    const acme = await rowNamed('Acme main');
    expect(acme).toHaveTextContent('Acme Cloud');
    expect(acme).toHaveTextContent('acme-team');
    expect(within(acme).getByRole('img', { name: 'Tickets' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Notes/ })).not.toBeInTheDocument();
  });

  it("names the binding's creation and lets it be renamed on «Overview», keeping its settings", async () => {
    useHandlers();
    const saved: unknown[] = [];
    server.use(
      http.put(`${TEST_BASE_URL}/web/firebase/bindings/:id`, async ({ request }) => {
        saved.push(await request.json());
        return HttpResponse.json(firebaseState);
      }),
    );
    renderConnections('?connection=google-cloud:bnd-1');
    expect(await screen.findByRole('heading', { name: 'syncta-57c6a', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connections' })).toHaveAttribute('href', `/factories/${FACTORY_ID}/settings/integrations`);
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Overview', 'Activity', 'Tools', 'Settings', 'Diagnostics']);
    const name = screen.getByRole('textbox', { name: 'Name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Syncta prod');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toEqual([expect.objectContaining({ name: 'Syncta prod', projectId: 'syncta-57c6a', logs: true, database: { enabled: true } })]));
  });

  it('opens a row as its own view in the URL and comes back to the list', async () => {
    useHandlers();
    renderConnections();
    await userEvent.click(await screen.findByRole('link', { name: 'Acme main' }));
    expect(screen.getByTestId('search')).toHaveTextContent('?connection=acme%3Amain');
    expect(await screen.findByRole('heading', { name: 'Acme main', level: 1 })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Connections' }));
    expect(screen.getByTestId('search')).toBeEmptyDOMElement();
    expect(await rows()).toHaveLength(3);
  });

  it("saves a server connection's setting the moment its switch changes", async () => {
    useHandlers();
    const saved: unknown[] = [];
    server.use(
      http.get(`${TEST_BASE_URL}/web/connections/:id/detail`, () =>
        HttpResponse.json({
          sections: [
            {
              type: 'settings',
              id: 'sync',
              title: 'Import',
              fields: [
                { name: 'enabled', displayName: 'Import Acme tickets', type: 'boolean', required: false, value: true },
                { name: 'paused', displayName: 'Pause', type: 'boolean', required: false, value: false, disabled: { reason: 'Only admins pause.' } },
              ],
            },
          ],
        }),
      ),
      http.patch(`${TEST_BASE_URL}/web/connections/:id/settings`, async ({ request, params }) => {
        saved.push({ id: params.id, body: await request.json() });
        return HttpResponse.json({ message: 'Import is off' });
      }),
    );
    renderConnections('?connection=acme%3Amain');
    const toggle = await screen.findByRole('switch', { name: 'Import Acme tickets' });
    expect(toggle).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Pause' })).toBeDisabled();
    expect(screen.getByText('Only admins pause.')).toBeInTheDocument();
    await userEvent.click(toggle);
    await waitFor(() => expect(saved).toEqual([{ id: 'acme:main', body: { section: 'sync', values: { enabled: false } } }]));
    expect(await screen.findByText('Import is off')).toBeInTheDocument();
  });

  it('opens a connector link (`?connection=<connector>`) on its only connection', async () => {
    useHandlers();
    renderConnections('?connection=acme');
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent('?connection=acme%3Amain'));
    expect(await screen.findByRole('heading', { name: 'Acme main', level: 1 })).toBeInTheDocument();
  });

  it('lands links from before the one list on the same thing', async () => {
    useHandlers();
    renderConnections('?tab=services&service=google-cloud');
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent('?connection=google-cloud'));
    expect(await screen.findByRole('button', { name: 'Add account' })).toBeInTheDocument();
  });

  it("unlinks an MCP server from this Factory only, keeping the others' access", async () => {
    const writes = useHandlers();
    renderConnections();
    await rows();
    await openMenu('Sentry');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Unlink from Factory' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unlink “Sentry” from this Factory?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Unlink' }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ method: 'PUT', url: expect.stringContaining('/srv-sentry'), body: { assignments: [{ factoryProjectId: 'other-factory' }] } });
  });

  it("unlinks a Google Cloud project by removing the binding, not the account", async () => {
    const writes = useHandlers();
    renderConnections();
    await rows();
    await openMenu('syncta-57c6a');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Unlink from Factory' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(writes).toEqual([expect.objectContaining({ method: 'DELETE', url: expect.stringContaining('/web/firebase/bindings/bnd-1') })]));
  });

  it('renames, reconnects and deletes an own MCP server from its menu', async () => {
    const writes = useHandlers();
    renderConnections();
    await rows();

    await openMenu('Sentry');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const rename = await screen.findByRole('dialog');
    await userEvent.clear(within(rename).getByRole('textbox', { name: 'Name' }));
    await userEvent.type(within(rename).getByRole('textbox', { name: 'Name' }), 'Sentry prod');
    await userEvent.click(within(rename).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes.at(-1)).toMatchObject({ method: 'PUT', body: { label: 'Sentry prod', name: 'sentry' } }));

    await openMenu('Sentry');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Reconnect' }));
    await waitFor(() => expect(writes.at(-1)).toMatchObject({ method: 'RECONNECT' }));
    expect(await screen.findByText('Reconnected: 3 tools')).toBeInTheDocument();

    await openMenu('Sentry');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete connection' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(writes.at(-1)).toMatchObject({ method: 'DELETE', url: expect.stringContaining('/srv-sentry') }));
  });

  it("offers a server connector's actions as the server decides them, a blocked one with the server's reason", async () => {
    useHandlers();
    renderConnections();
    await rows();
    await openMenu('Acme main');
    for (const name of ['Rename', 'Reconnect', 'Delete connection']) {
      expect(screen.getByRole('menuitem', { name })).not.toHaveAttribute('aria-disabled', 'true');
    }
    expect(screen.getByRole('menuitem', { name: 'Manage elsewhere' })).toHaveAccessibleDescription('Acme has no console for keys.');
  });

  it("renames a server connection, and shows the server's own words for what deleting it does before it deletes", async () => {
    useHandlers();
    const calls: Array<{ method: string; id: unknown; body?: unknown; confirm?: string | null }> = [];
    server.use(
      http.patch(`${TEST_BASE_URL}/web/connections/:id`, async ({ request, params }) => {
        calls.push({ method: 'PATCH', id: params.id, body: await request.json() });
        return HttpResponse.json({ name: 'Acme prod' });
      }),
      http.get(`${TEST_BASE_URL}/web/connections/:id/impact`, () =>
        HttpResponse.json({
          title: 'Delete «Acme main»?',
          body: 'Its key is erased for the whole organization.',
          dependents: [{ label: 'Factory «post-airborne»' }],
          itemsLabel: 'Projects',
          items: [
            { label: 'ACME-web', outcome: 'moves', outcomeLabel: 'Moves to Acme backup' },
            { label: 'ACME-ops', outcome: 'unlinks', outcomeLabel: 'Unlinked' },
          ],
          confirmLabel: 'Delete and unlink',
          cancelLabel: 'Keep it',
          requiresConfirm: true,
        }),
      ),
      http.delete(`${TEST_BASE_URL}/web/connections/:id`, ({ params, request }) => {
        calls.push({ method: 'DELETE', id: params.id, confirm: new URL(request.url).searchParams.get('confirm') });
        return HttpResponse.json({ removed: true, message: 'Deleted. Moved: 1, unlinked: 1.' });
      }),
    );
    renderConnections();
    const row = await rowNamed('Acme main');
    expect(within(row).getByRole('link')).toHaveAttribute('href', expect.stringContaining('connection=acme%3Amain'));
    await openMenu('Acme main');
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.clear(within(dialog).getByRole('textbox', { name: 'Name' }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Acme prod');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls).toEqual([{ method: 'PATCH', id: 'acme:main', body: { name: 'Acme prod' } }]));

    await openMenu('Acme main');
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete connection' }));
    const removal = await screen.findByRole('dialog', { name: 'Delete «Acme main»?' });
    await within(removal).findByText('Factory «post-airborne»');
    const items = within(removal).getByRole('list', { name: 'Projects' });
    expect(within(items).getAllByRole('listitem').map(item => item.textContent)).toEqual(['ACME-webMoves to Acme backup', 'ACME-opsUnlinked']);
    expect(within(removal).getByRole('button', { name: 'Keep it' })).toBeInTheDocument();
    expect(calls.filter(call => call.method === 'DELETE')).toEqual([]);
    await userEvent.click(within(removal).getByRole('button', { name: 'Delete and unlink' }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ method: 'DELETE', id: 'acme:main', confirm: '1' }));
    expect(await screen.findByText('Deleted. Moved: 1, unlinked: 1.')).toBeInTheDocument();
  });

  it("reconnects through the form the connection's reconnect method describes", async () => {
    useHandlers();
    const posted: unknown[] = [];
    server.use(
      http.post(`${TEST_BASE_URL}/web/connections/:id/reconnect`, async ({ request, params }) => {
        posted.push({ id: params.id, body: await request.json() });
        return HttpResponse.json({ type: 'connected', connection: acmeConnection, title: 'Key replaced' });
      }),
    );
    renderConnections();
    await rows();
    await openMenu('Acme main');
    await userEvent.click(screen.getByRole('menuitem', { name: 'Reconnect' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reconnect “Acme main”' });
    expect(screen.getByTestId('search')).toHaveTextContent('step=reconnect%3Aacme%3Amain');
    await userEvent.type(within(dialog).getByLabelText('Acme API key'), 'acme_new');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Replace key' }));
    expect(await within(dialog).findByText('Key replaced')).toBeInTheDocument();
    expect(posted).toEqual([{ id: 'acme:main', body: { input: { key: 'acme_new' } } }]);
  });

  it("opens a server connection's page: its facts and the sections the server lays out", async () => {
    useHandlers();
    server.use(
      http.get(`${TEST_BASE_URL}/web/connections/:id/detail`, () =>
        HttpResponse.json({
          sections: [
            { type: 'table', title: 'Projects', columns: ['Project', 'Visibility'], rows: [{ cells: ['ACME-web', 'Private'], href: 'https://acme.test/web' }] },
          ],
        }),
      ),
    );
    renderConnections('?connection=acme%3Amain');
    expect(await screen.findByRole('heading', { name: 'Acme main', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Used by 2 Factories')).toBeInTheDocument();
    expect(screen.getByText('API key')).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Projects' });
    expect(within(table).getByRole('link', { name: 'ACME-web' })).toHaveAttribute('href', 'https://acme.test/web');
  });

  it('tells a member the organization’s connections are changed by an admin, in the server’s words', async () => {
    const reason = { reason: 'Only organization admins change connections.' };
    useHandlers();
    server.use(
      http.get(`${TEST_BASE_URL}/web/connections`, () =>
        HttpResponse.json({
          connections: [{ ...acmeConnection, actions: { rename: reason, reconnect: reason, remove: reason } }],
          failures: [],
          copy: { organizationWide: 'Whole organization' },
        }),
      ),
    );
    renderConnections();
    await rows();
    await openMenu('Acme main');
    expect(screen.getByRole('menuitem', { name: 'Delete connection' })).toHaveAccessibleDescription('Only organization admins change connections.');
    expect(screen.getByRole('menuitem', { name: /^Rename/ })).toHaveAttribute('aria-disabled', 'true');
  });

  it('adds from one dialog: integrations by capability, MCP only under «Other», the database Google Cloud runs never offered', async () => {
    useHandlers();
    renderConnections();
    await userEvent.click(await screen.findByRole('button', { name: 'Add connection' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add connection' });

    const integrations = within(dialog).getByRole('group', { name: 'Integrations' });
    expect(within(integrations).getAllByRole('option').map(option => option.getAttribute('aria-label'))).toEqual([
      'Connect Google Cloud',
      'Connect GitLab',
      'Connect Acme Cloud',
    ]);
    expect(within(integrations).getByRole('option', { name: 'Connect Acme Cloud' })).toContainElement(within(integrations).getByRole('img', { name: 'Tickets' }));
    expect(within(integrations).queryByText('MCP')).not.toBeInTheDocument();
    expect(within(within(dialog).getByRole('group', { name: 'Other' })).getByRole('option', { name: 'Connect Own MCP server' })).toBeInTheDocument();
    expect(within(dialog).queryByText(/Toolbox/)).not.toBeInTheDocument();

    // Sources leave out tools and the organization's accounts.
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Sources' }));
    expect(within(dialog).queryByRole('group', { name: 'Organization accounts' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Connect Google Cloud' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('option', { name: 'Connect GitLab' })).toBeInTheDocument();
  });

  it('links an organization server with access for every session kind', async () => {
    const writes = useHandlers();
    renderConnections();
    await userEvent.click(await screen.findByRole('button', { name: 'Add connection' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add connection' });
    await userEvent.type(within(dialog).getByRole('combobox', { name: 'Search integrations and accounts' }), 'notes');
    await userEvent.click(within(dialog).getByRole('option', { name: 'Link Notes' }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.body).toMatchObject({
      assignments: [{ factoryProjectId: 'other-factory' }, { factoryProjectId: FACTORY_ID, sessions: ['chat', 'personal', 'cards'] }],
    });
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent('?connection=mcp%3Asrv-notes'));
  });

  it('links a Google Cloud account by opening a new binding through it for this Factory', async () => {
    useHandlers();
    renderConnections();
    await userEvent.click(await screen.findByRole('button', { name: 'Add connection' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add connection' });
    await userEvent.click(within(dialog).getByRole('option', { name: 'Link Syncta' }));

    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent('?connection=google-cloud&account=acc-1'));
    expect(await screen.findByRole('combobox', { name: 'Google Cloud account' })).toHaveTextContent('Syncta');
    expect(screen.getByRole('combobox', { name: 'Factory' })).toHaveTextContent('syncts');
  });

  it('connects Google Cloud in the dialog: a refused key shows why and tries again, then goes on to pick the project', async () => {
    useHandlers();
    const posted: unknown[] = [];
    server.use(
      http.post(`${TEST_BASE_URL}/web/firebase/accounts`, async ({ request }) => {
        posted.push(await request.json());
        if (posted.length === 1) return HttpResponse.json({ error: 'invalid_key', message: 'The key has no client_email.' }, { status: 422 });
        return HttpResponse.json({
          account: { id: 'acc-2', name: 'BookFate', clientEmail: 'f@bookfate.iam.gserviceaccount.com', projectId: 'bookfate', keyId: 'k', bindingIds: [] },
          ...firebaseState,
        });
      }),
    );
    renderConnections();
    await userEvent.click(await screen.findByRole('button', { name: 'Add connection' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('option', { name: 'Connect Google Cloud' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect Google Cloud' });

    // The organization already has an account: pick it, or add a new key.
    await userEvent.click(within(dialog).getByRole('button', { name: /New service account key/ }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Key (JSON)' }), '{{"type":"service_account"}');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't connect");
    expect(alert).toHaveTextContent('The key has no client_email.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));

    expect(await within(dialog).findByText('Account “BookFate” added')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Pick a project' }));
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent('?connection=google-cloud&account=acc-2'));
    expect(posted).toHaveLength(2);
  });

  it("connects through a server connector's form: asks which way first, says why one is unavailable, shows a refusal on its field", async () => {
    useHandlers();
    const posted: unknown[] = [];
    server.use(
      http.post(`${TEST_BASE_URL}/web/connections`, async ({ request }) => {
        posted.push(await request.json());
        if (posted.length === 1) {
          return HttpResponse.json({ error: 'invalid_key', message: 'Acme refused the key.', fields: { key: 'Acme refused the key.' } }, { status: 422 });
        }
        return HttpResponse.json({
          type: 'connected',
          connection: { ...acmeConnection, id: 'acme:new', label: 'Acme new' },
          title: 'Acme new is connected',
          message: 'It reaches 3 projects.',
        });
      }),
    );
    renderConnections();
    await userEvent.click(await screen.findByRole('button', { name: 'Add connection' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('option', { name: 'Connect Acme Cloud' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect Acme Cloud' });
    expect(within(dialog).getByText('Tickets from Acme projects.')).toBeInTheDocument();
    const methods = within(dialog).getByRole('list', { name: 'How do you connect?' });
    expect(within(methods).getByRole('button', { name: /Sign in with Acme/ })).toBeDisabled();
    expect(within(methods).getByRole('button', { name: /Sign in with Acme/ })).toHaveAccessibleDescription('Acme sign-in is off on this server.');
    await userEvent.click(within(methods).getByRole('button', { name: /API key/ }));

    await userEvent.type(within(dialog).getByLabelText('Acme API key'), 'acme_bad');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Connect Acme' }));
    expect(await within(dialog).findByText('Acme refused the key.')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Acme API key')).toHaveAttribute('aria-invalid', 'true');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));

    expect(await within(dialog).findByText('Acme new is connected')).toBeInTheDocument();
    expect(within(dialog).getByText('It reaches 3 projects.')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Open the connection' }));
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent('?connection=acme%3Anew'));
    expect(posted).toEqual([
      { connector: 'acme', method: 'key', input: { key: 'acme_bad' } },
      { connector: 'acme', method: 'key', input: { key: 'acme_bad' } },
    ]);
  });

  it('opens the URL an authorize method returns', async () => {
    useHandlers();
    server.use(
      http.get(`${TEST_BASE_URL}/web/connections/methods`, () =>
        HttpResponse.json({ connectors: [{ ...acmeConnector, methods: [{ id: 'sso', label: 'Sign in with Acme', authKind: 'oauth', available: true }] }] }),
      ),
      http.post(`${TEST_BASE_URL}/web/connections`, () => HttpResponse.json({ type: 'authorize', url: '/auth/acme/start', authId: 'flow-1' })),
    );
    const assign = vi.spyOn(connectionNavigation, 'assign').mockImplementation(() => {});
    renderConnections();
    await userEvent.click(await screen.findByRole('button', { name: 'Add connection' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('option', { name: 'Connect Acme Cloud' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect Acme Cloud' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`${TEST_BASE_URL}/auth/acme/start`));
    assign.mockRestore();
  });

  it('picks with the keyboard: the search narrows the list, arrows move, Enter opens', async () => {
    useHandlers();
    renderConnections();
    await userEvent.click(await screen.findByRole('button', { name: 'Add connection' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add connection' });
    await userEvent.type(within(dialog).getByRole('combobox', { name: 'Search integrations and accounts' }), 'cl');
    expect(within(dialog).getAllByRole('option').map(option => option.getAttribute('aria-label'))).toEqual(['Connect Google Cloud', 'Connect Acme Cloud']);
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Connect Acme Cloud' })).toBeInTheDocument();
  });

  it('shows the agents’ calls of the chosen period in a table, filters them, and asks the server for another period', async () => {
    const periods: string[] = [];
    useHandlers({
      activity: {
        since: new Date(Date.now() - 86_400_000).toISOString(),
        total: 2,
        errors: 1,
        truncated: false,
        calls: [
          { at: new Date().toISOString(), serverId: 'srv-gc', serverLabel: 'Firestore syncta-57c6a', tool: 'list_collections', outcome: 'ok', durationMs: 120, sessionId: 'session-1', tried: false },
          { at: new Date().toISOString(), serverId: 'srv-sentry', serverLabel: 'Sentry', tool: 'search_issues', outcome: 'error', tried: false },
        ],
      },
    });
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/activity')) periods.push(url.searchParams.get('hours') ?? '');
    });
    renderConnections();
    const calls = await screen.findByRole('table', { name: 'Requests' });
    const [first] = within(calls).getAllByRole('row').slice(1);
    expect(first).toHaveTextContent('Firestore syncta-57c6a');
    expect(first).toHaveTextContent('list_collections');
    expect(within(calls).getByRole('link', { name: 'Open session' })).toHaveAttribute('href', `/factories/${FACTORY_ID}/workspaces/session-1`);

    await userEvent.click(screen.getByRole('button', { name: 'Period' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Last 7 days' }));
    await waitFor(() => expect(periods).toContain('168'));
    server.events.removeAllListeners();
  });

  it('says so when there are no requests yet', async () => {
    useHandlers();
    renderConnections();
    expect(await screen.findByRole('heading', { name: 'No requests yet' })).toBeInTheDocument();
  });
});

describe('Підключення on a phone', () => {
  const original = window.matchMedia;
  afterEach(() => {
    window.matchMedia = original;
  });

  it('opens «Add connection» full screen and keeps row actions in a 44px menu button', async () => {
    window.matchMedia = (query: string) =>
      ({
        matches: query.includes('max-width'),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList;
    useHandlers();
    renderConnections();
    // Rows stack into a list instead of the table.
    const list = await screen.findByRole('list', { name: "This Factory's connections" });
    expect(within(list).getByRole('link', { name: /^Sentry/ })).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: "This Factory's connections" })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actions for Sentry' })).toHaveClass('max-sm:size-11');
    await userEvent.click(screen.getByRole('button', { name: 'Add connection' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add connection' });
    expect(dialog.className).toContain('max-sm:h-[calc(100dvh+3rem)]');
    expect(dialog.className).toContain('max-sm:rounded-none');
  });
});
