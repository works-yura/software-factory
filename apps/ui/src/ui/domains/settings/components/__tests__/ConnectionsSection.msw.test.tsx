import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import type { McpActivity, McpServer } from '../../services/mcpServers';
import { FACTORY_ID, firebaseState, managedServer, MCP_BASE, renderConnections, useIntegrationHandlers } from './fixtures/connections';

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
    expect(list.map(row => within(row).getByRole('link').textContent)).toEqual(['syncta-57c6a', 'ClickUp', 'yura', 'Sentry']);
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
    expect(await rowNamed('ClickUp')).toHaveTextContent('eclipt.ai');
    // GitHub is a row per connection, named by its account until the organization names it.
    expect(await rowNamed('yura')).toHaveTextContent('GitHub');
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
    await userEvent.click(await screen.findByRole('link', { name: 'ClickUp' }));
    expect(screen.getByTestId('search')).toHaveTextContent('?connection=clickup');
    await userEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(await screen.findByRole('switch', { name: 'Import ClickUp tasks' })).toBeChecked();
    await userEvent.click(screen.getByRole('link', { name: 'Connections' }));
    expect(screen.getByTestId('search')).toBeEmptyDOMElement();
    expect(await rows()).toHaveLength(4);
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

  it('renames ClickUp for the organization and deletes it after naming what stops — never «Unlink» from one Factory', async () => {
    const writes = useHandlers();
    const sent: Array<{ method: string; body: unknown }> = [];
    server.use(
      http.patch(`${TEST_BASE_URL}/web/clickup/connection/name`, async ({ request }) => {
        const body = await request.json();
        sent.push({ method: 'PATCH', body });
        return HttpResponse.json({ configured: true, connected: true, workspaces: ['eclipt.ai'], intervalSeconds: 60, canManage: true, name: 'Eclipt' });
      }),
      http.get(`${TEST_BASE_URL}/web/clickup/usage`, () =>
        HttpResponse.json({ factories: [{ id: FACTORY_ID, name: 'syncts', lists: 2 }, { id: 'f-2', name: 'book_fate', lists: 1 }] }),
      ),
      http.delete(`${TEST_BASE_URL}/web/clickup/connection`, () => {
        sent.push({ method: 'DELETE', body: null });
        return HttpResponse.json({ configured: false, connected: false, workspaces: [], intervalSeconds: 60, canManage: true });
      }),
    );
    renderConnections();
    await rows();
    await openMenu('ClickUp');
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Open', 'Rename', 'Reconnect', 'Delete connection']);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const rename = await screen.findByRole('dialog');
    await userEvent.clear(within(rename).getByRole('textbox', { name: 'Name' }));
    await userEvent.type(within(rename).getByRole('textbox', { name: 'Name' }), 'Eclipt');
    await userEvent.click(within(rename).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent).toEqual([{ method: 'PATCH', body: { name: 'Eclipt' } }]));
    // The row now carries the organization's name for it.
    expect(await screen.findByRole('link', { name: 'Eclipt' })).toBeInTheDocument();

    await openMenu('Eclipt');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete connection' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete the “Eclipt” connection?' });
    await waitFor(() =>
      expect(confirm).toHaveTextContent('“syncts” — 2 ClickUp Lists in intake routes; “book_fate” — 1 ClickUp List in intake routes'),
    );
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(sent.at(-1)).toEqual({ method: 'DELETE', body: null }));
    expect(writes).toEqual([]);
  });

  it('opens ClickUp’s connect step for «Reconnect», where the token is replaced', async () => {
    useHandlers();
    renderConnections();
    await rows();
    await openMenu('ClickUp');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Reconnect' }));
    expect(await screen.findByRole('dialog', { name: 'Connect ClickUp' })).toBeInTheDocument();
    expect(screen.getByTestId('search')).toHaveTextContent('add=1&step=clickup');
  });

  it('keeps actions a token from the server environment cannot take, disabled, saying where to change it', async () => {
    useHandlers();
    renderConnections();
    await rows();
    await openMenu('yura');
    // Its name is the organization's to give; its token is the server's.
    expect(screen.getByRole('menuitem', { name: 'Rename' })).not.toHaveAttribute('aria-disabled', 'true');
    for (const name of [/^Reconnect/, /^Delete connection/]) {
      const item = screen.getByRole('menuitem', { name });
      expect(item).toHaveAttribute('aria-disabled', 'true');
      expect(item).toHaveTextContent('Set in the server environment — change the environment variables');
    }
  });

  it('renames a GitHub App connection, and removes it once no Factory project uses its repositories', async () => {
    useHandlers();
    const calls: Array<{ method: string; id: unknown; body?: unknown }> = [];
    let inUse = 1;
    server.use(
      http.get(`${TEST_BASE_URL}/web/github/status`, () =>
        HttpResponse.json({
          enabled: true,
          appConfigured: true,
          connected: true,
          canManage: true,
          installations: [
            { id: 'inst-row-1', installationId: 42, accountLogin: 'eclipt-ai', accountType: 'Organization', kind: 'app', name: null, createdAt: '2026-11-01T10:00:00.000Z', connectedBy: 'user-1', projectConnections: inUse },
          ],
          reason: 'ready',
        }),
      ),
      http.patch(`${TEST_BASE_URL}/web/github/installations/:id`, async ({ request, params }) => {
        calls.push({ method: 'PATCH', id: params.id, body: await request.json() });
        return HttpResponse.json({ id: params.id, name: 'Eclipt GitHub' });
      }),
      http.delete(`${TEST_BASE_URL}/web/github/connections/:id`, ({ params }) => {
        calls.push({ method: 'DELETE', id: params.id });
        return HttpResponse.json({ removed: true });
      }),
    );
    renderConnections();
    const row = await rowNamed('eclipt-ai');
    expect(within(row).getByRole('link')).toHaveAttribute('href', expect.stringContaining('connection=github%3A42'));
    await openMenu('eclipt-ai');
    expect(screen.getByRole('menuitem', { name: 'Reconnect' })).not.toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.clear(within(dialog).getByRole('textbox', { name: 'Name' }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Eclipt GitHub');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls).toEqual([{ method: 'PATCH', id: 'inst-row-1', body: { name: 'Eclipt GitHub' } }]));

    // While a Factory project still uses its repositories, the confirmation says so and does not delete.
    await openMenu('eclipt-ai');
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete connection' }));
    const blocked = await screen.findByRole('dialog', { name: 'Delete the “eclipt-ai” connection?' });
    expect(blocked).toHaveTextContent('1 Factory project still uses its repositories — remove them in Repositories first.');
    expect(within(blocked).getByRole('button', { name: 'Delete' })).toBeDisabled();
    await userEvent.click(within(blocked).getByRole('button', { name: 'Cancel' }));

    inUse = 0;
    renderConnections();
    await waitFor(async () => expect(await screen.findAllByRole('button', { name: 'Actions for eclipt-ai' })).not.toHaveLength(0));
    await userEvent.click(screen.getAllByRole('button', { name: 'Actions for eclipt-ai' }).at(-1)!);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete connection' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete the “eclipt-ai” connection?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ method: 'DELETE', id: 'inst-row-1' }));
  });

  it('tells a member the organization’s connections are changed by an admin', async () => {
    useHandlers();
    server.use(
      http.get(`${TEST_BASE_URL}/web/clickup/status`, () =>
        HttpResponse.json({ configured: true, connected: true, workspaces: ['eclipt.ai'], intervalSeconds: 60, canManage: false }),
      ),
    );
    renderConnections();
    await rows();
    await openMenu('ClickUp');
    expect(screen.getByRole('menuitem', { name: /^Delete connection/ })).toHaveTextContent('Organization admins only');
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
      'Connect ClickUp',
      'Connect GitHub',
      'Connect GitHub · token',
      'Connect GitLab',
    ]);
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

  it('shows ClickUp connected in its step and goes to its settings; «Back» returns to the list', async () => {
    useHandlers();
    renderConnections();
    await userEvent.click(await screen.findByRole('button', { name: 'Add connection' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('option', { name: 'Connect ClickUp' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect ClickUp' });
    expect(await within(dialog).findByRole('status')).toHaveTextContent('Connected');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('dialog', { name: 'Add connection' })).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('option', { name: 'Connect ClickUp' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Connect ClickUp' })).getByRole('button', { name: 'Open settings' }));
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent('?connection=clickup'));
  });

  it('connects GitHub with a token in the dialog: a refused token shows why and tries again, then opens the GitHub page', async () => {
    useHandlers();
    const posted: unknown[] = [];
    server.use(
      http.post(`${TEST_BASE_URL}/web/github/token-connections`, async ({ request }) => {
        posted.push(await request.json());
        if (posted.length === 1) return HttpResponse.json({ error: 'invalid_token', message: 'GitHub rejected this token (401).' }, { status: 422 });
        return HttpResponse.json({
          connection: { id: 'inst-2', kind: 'token', tokenSource: 'stored', installationId: 9, accountLogin: 'client', accountType: 'User', repositoryCount: 3, status: 'ok' },
          replaced: false,
        });
      }),
    );
    renderConnections();
    await userEvent.click(await screen.findByRole('button', { name: 'Add connection' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('option', { name: 'Connect GitHub · token' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect GitHub with a token' });

    await userEvent.type(within(dialog).getByLabelText('GitHub access token'), 'ghp_wrong');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't connect");
    expect(alert).toHaveTextContent('GitHub rejected this token (401).');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));

    expect(await within(dialog).findByText('Connected @client')).toBeInTheDocument();
    expect(within(dialog).getByText('Repositories it can reach: 3.')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Open settings' }));
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent('?connection=github'));
    expect(posted).toEqual([{ token: 'ghp_wrong' }, { token: 'ghp_wrong' }]);
  });

  it('offers GitHub through the App only when the server has the App; the token always', async () => {
    useHandlers();
    server.use(
      http.get(`${TEST_BASE_URL}/web/github/status`, () =>
        HttpResponse.json({ enabled: true, appConfigured: false, canManage: true, connected: false, installations: [], reason: 'not_connected' }),
      ),
    );
    renderConnections();
    await userEvent.click(await screen.findByRole('button', { name: 'Add connection' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add connection' });
    await waitFor(() => expect(within(dialog).getByRole('option', { name: 'Connect GitHub · token' })).toBeInTheDocument());
    expect(within(dialog).queryByRole('option', { name: 'Connect GitHub' })).not.toBeInTheDocument();
  });

  it('tells a member that only admins connect GitHub with a token', async () => {
    useHandlers();
    server.use(
      http.get(`${TEST_BASE_URL}/web/github/status`, () =>
        HttpResponse.json({ enabled: true, appConfigured: true, canManage: false, connected: false, installations: [], reason: 'not_connected' }),
      ),
    );
    renderConnections();
    await userEvent.click(await screen.findByRole('button', { name: 'Add connection' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('option', { name: 'Connect GitHub · token' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect GitHub with a token' });
    expect(await within(dialog).findByText('Only organization admins can connect, replace or disconnect GitHub.')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('GitHub access token')).not.toBeInTheDocument();
  });

  it('picks with the keyboard: the search narrows the list, arrows move, Enter opens', async () => {
    useHandlers();
    renderConnections();
    await userEvent.click(await screen.findByRole('button', { name: 'Add connection' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add connection' });
    await userEvent.type(within(dialog).getByRole('combobox', { name: 'Search integrations and accounts' }), 'git');
    expect(within(dialog).getAllByRole('option').map(option => option.getAttribute('aria-label'))).toEqual([
      'Connect GitHub',
      'Connect GitHub · token',
      'Connect GitLab',
    ]);
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Connect GitLab' })).toBeInTheDocument();
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
