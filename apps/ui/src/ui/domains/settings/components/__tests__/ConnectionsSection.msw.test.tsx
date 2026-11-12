import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import { connectionNavigation } from '../../connections/api';
import type { McpActivity } from '../../services/mcpServers';
import {
  acmeConnection,
  acmeConnector,
  FACTORY_ID,
  MCP_BASE,
  mcpConnection,
  renderConnections,
  sentryConnection,
  useIntegrationHandlers,
} from './fixtures/connections';

/** The page's own handlers around the shared ones; writes to the connections API are recorded. */
function useHandlers(options: { activity?: McpActivity } = {}) {
  useIntegrationHandlers();
  const writes: Array<{ method: string; url: string; body: unknown }> = [];
  const record = async (method: string, request: Request) =>
    void writes.push({ method, url: request.url, body: await request.json().catch(() => null) });
  server.use(
    http.post(`${TEST_BASE_URL}/web/connections/:id/unlink`, async ({ request }) => {
      await record('UNLINK', request);
      return HttpResponse.json({ message: 'Unlinked from this Factory. The organization’s server stays.' });
    }),
    http.post(`${TEST_BASE_URL}/web/connections/:id/reconnect`, async ({ request }) => {
      await record('RECONNECT', request);
      return HttpResponse.json({ type: 'connected', connection: sentryConnection, title: 'Reconnected: 3 tools' });
    }),
    http.post(`${TEST_BASE_URL}/web/connections`, async ({ request }) => {
      await record('CONNECT', request);
      return HttpResponse.json({ type: 'connected', connection: mcpConnection('srv-notes', 'Notes'), title: 'Notes is linked to this Factory' });
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
  it("lists the Factory's connections in one table, as the server describes them: MCP servers by badge, a failure in the server's words", async () => {
    useHandlers();
    renderConnections();

    expect(screen.getByRole('heading', { name: 'Connections', level: 1 })).toBeInTheDocument();
    const list = await rows();
    expect(list.map(row => within(row).getByRole('link').textContent)).toEqual(['Acme main', 'Sentry']);
    const sentry = await rowNamed('Sentry');
    expect(sentry).toHaveTextContent('MCP');
    expect(within(sentry).getByText('Error').closest('[data-state]')).toHaveAttribute('title', expect.stringContaining('The account was refused access'));
    // A server connector's row is all the server's: its name, account and what it provides.
    const acme = await rowNamed('Acme main');
    expect(acme).toHaveTextContent('Acme Cloud');
    expect(acme).toHaveTextContent('acme-team');
    expect(within(acme).getByRole('img', { name: 'Tickets' })).toBeInTheDocument();
    // A working connection says nothing about its state; it is not an MCP server.
    expect(acme).not.toHaveTextContent('MCP');
    expect(acme).not.toHaveTextContent('Live');
  });

  it("names a server connection's creation and lets it be renamed on «Overview»", async () => {
    useHandlers();
    const saved: unknown[] = [];
    server.use(
      http.patch(`${TEST_BASE_URL}/web/connections/:id`, async ({ request }) => {
        saved.push(await request.json());
        return HttpResponse.json({ name: 'Acme prod' });
      }),
    );
    renderConnections('?connection=acme%3Amain');
    expect(await screen.findByRole('heading', { name: 'Acme main', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connections' })).toHaveAttribute('href', `/factories/${FACTORY_ID}/settings/integrations`);
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
    const name = screen.getByRole('textbox', { name: 'Name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Acme prod');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toEqual([{ name: 'Acme prod' }]));
  });

  it('opens a row as its own view in the URL and comes back to the list', async () => {
    useHandlers();
    renderConnections();
    await userEvent.click(await screen.findByRole('link', { name: 'Acme main' }));
    expect(screen.getByTestId('search')).toHaveTextContent('?connection=acme%3Amain');
    expect(await screen.findByRole('heading', { name: 'Acme main', level: 1 })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Connections' }));
    expect(screen.getByTestId('search')).toBeEmptyDOMElement();
    expect(await rows()).toHaveLength(2);
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

  it('lands links from before the one list on the same thing, by a connector’s id or an older name of it', async () => {
    useHandlers();
    server.use(
      http.get(`${TEST_BASE_URL}/web/connections/methods`, () => HttpResponse.json({ connectors: [{ ...acmeConnector, aliases: ['acme-legacy'] }] })),
    );
    renderConnections('?tab=services&service=acme-legacy');
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent('?connection=acme%3Amain'));
    expect(await screen.findByRole('heading', { name: 'Acme main', level: 1 })).toBeInTheDocument();
  });

  it("unlinks a Factory-scoped connection from this Factory, in the server's words", async () => {
    const writes = useHandlers();
    renderConnections();
    await rows();
    await openMenu('Sentry');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Unlink from Factory' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unlink “Sentry” from this Factory?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(writes).toEqual([expect.objectContaining({ method: 'UNLINK', url: expect.stringContaining('mcp%3Asrv-sentry') })]));
    expect(await screen.findByText('Unlinked from this Factory. The organization’s server stays.')).toBeInTheDocument();
  });

  it('reconnects at once when the method asks for nothing, and says how it went', async () => {
    const writes = useHandlers();
    renderConnections();
    await rows();
    await openMenu('Sentry');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Reconnect' }));
    await waitFor(() => expect(writes).toEqual([expect.objectContaining({ method: 'RECONNECT', body: { input: {} } })]));
    expect(await screen.findByText('Reconnected: 3 tools')).toBeInTheDocument();
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

  it('adds from one dialog: integrations by capability, MCP only under «Other»', async () => {
    useHandlers();
    renderConnections();
    await userEvent.click(await screen.findByRole('button', { name: 'Add connection' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add connection' });

    const integrations = within(dialog).getByRole('group', { name: 'Integrations' });
    expect(within(integrations).getAllByRole('option').map(option => option.getAttribute('aria-label'))).toEqual([
      'Connect Acme Cloud',
    ]);
    expect(within(integrations).getByRole('option', { name: 'Connect Acme Cloud' })).toContainElement(within(integrations).getByRole('img', { name: 'Tickets' }));
    expect(within(integrations).queryByText('MCP')).not.toBeInTheDocument();
    const other = within(dialog).getByRole('group', { name: 'Other' });
    expect(within(other).getByRole('option', { name: 'Connect MCP servers' })).toHaveTextContent('MCP');

    // Sources leave out tools and the organization's accounts.
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Sources' }));
    expect(within(dialog).queryByRole('group', { name: 'Organization accounts' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('option', { name: 'Connect Acme Cloud' })).toBeInTheDocument();
  });

  it("links an organization's MCP server through the connector's select, and opens an editor method on its own page", async () => {
    const writes = useHandlers();
    renderConnections();
    await userEvent.click(await screen.findByRole('button', { name: 'Add connection' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('option', { name: 'Connect MCP servers' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect MCP servers' });
    await userEvent.click(within(dialog).getByRole('button', { name: /A server of the organization/ }));
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Server' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Notes' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(writes).toEqual([expect.objectContaining({ method: 'CONNECT', body: { connector: 'mcp', method: 'link', input: { serverId: 'srv-notes' } } })]));
    expect(await within(dialog).findByText('Notes is linked to this Factory')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Back' }));

    // Back on the catalog: an editor method opens its page instead of a form.
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Add connection' })).getByRole('option', { name: 'Connect MCP servers' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Connect MCP servers' })).getByRole('button', { name: /Own MCP server/ }));
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent('?connection=new%3Amcp%3Acustom'));
  });

  it('picks with the keyboard: the search narrows the list, arrows move, Enter opens', async () => {
    useHandlers();
    renderConnections();
    await userEvent.click(await screen.findByRole('button', { name: 'Add connection' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add connection' });
    await userEvent.type(within(dialog).getByRole('combobox', { name: 'Search integrations and accounts' }), 'cloud');
    expect(within(dialog).getAllByRole('option').map(option => option.getAttribute('aria-label'))).toEqual(['Connect Acme Cloud']);
    await userEvent.keyboard('{Enter}');
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
