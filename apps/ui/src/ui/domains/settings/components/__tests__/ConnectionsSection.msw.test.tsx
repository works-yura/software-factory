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

const rows = async () => within(await screen.findByRole('list', { name: "This Factory's connections" })).getAllByRole('listitem');
const rowNamed = async (name: string) => (await rows()).find(row => within(row).queryByRole('button', { name: new RegExp(`^${name}`) }))!;

async function openMenu(name: string) {
  await userEvent.click(screen.getByRole('button', { name: `Actions for ${name}` }));
}

describe('Підключення', () => {
  it("lists the Factory's connections as one list: Google Cloud with its «База», organization-wide sources, MCP servers last by badge; never another Factory's", async () => {
    useHandlers();
    renderConnections();

    const list = await rows();
    expect(list.map(row => within(row).getAllByRole('button')[0]!.textContent)).toEqual([
      'syncta-57c6aGoogle Cloud',
      'ClickUp',
      'GitHub',
      'SentryMCPMCP server',
    ]);
    const google = await rowNamed('syncta-57c6a');
    expect(google).toHaveTextContent('Syncta');
    expect(google).toHaveTextContent('factory@syncta-57c6a.iam.gserviceaccount.com');
    expect(google).toHaveTextContent('Logs');
    expect(google).toHaveTextContent('Database');
    // A first-party integration says what it gives, never how it runs.
    expect(google).not.toHaveTextContent('MCP');
    expect(google).toHaveTextContent('Working');
    // The «База» server is the binding's, not a row of its own.
    expect(screen.queryByRole('button', { name: /^Firestore syncta-57c6a/ })).not.toBeInTheDocument();
    expect(await rowNamed('Sentry')).toHaveTextContent('The account was refused access');
    expect(await rowNamed('ClickUp')).toHaveTextContent('eclipt.ai');
    expect(await rowNamed('GitHub')).toHaveTextContent('From the server environment');
    expect(screen.queryByRole('button', { name: /^Notes/ })).not.toBeInTheDocument();
  });

  it('opens a row as its own view in the URL and comes back to the list', async () => {
    useHandlers();
    renderConnections();
    await userEvent.click(await screen.findByRole('button', { name: /^ClickUp/ }));
    expect(screen.getByTestId('search')).toHaveTextContent('?connection=clickup');
    expect(await screen.findByRole('switch', { name: 'Import ClickUp tasks' })).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'All connections' }));
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
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete from organization' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(writes.at(-1)).toMatchObject({ method: 'DELETE', url: expect.stringContaining('/srv-sentry') }));
  });

  it('offers no unlink or delete for ClickUp: it is connected for the whole organization', async () => {
    useHandlers();
    renderConnections();
    await rows();
    await openMenu('ClickUp');
    expect(await screen.findByRole('menuitem', { name: 'Open' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Unlink from Factory' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Delete/ })).not.toBeInTheDocument();
  });

  it('adds from one dialog: integrations by capability, MCP only under «Other», the database Google Cloud runs never offered', async () => {
    useHandlers();
    renderConnections();
    await userEvent.click(await screen.findByRole('button', { name: 'Add connection' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add connection' });

    const integrations = within(dialog).getByRole('region', { name: 'Integrations' });
    expect(within(integrations).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual([
      'Connect Google Cloud',
      'Connect ClickUp',
      'Connect GitHub',
      'Connect GitLab',
    ]);
    expect(within(integrations).queryByText('MCP')).not.toBeInTheDocument();
    expect(within(within(dialog).getByRole('region', { name: 'Other' })).getByRole('button', { name: 'Connect Own MCP server' })).toBeInTheDocument();
    expect(within(dialog).queryByText(/Toolbox/)).not.toBeInTheDocument();

    // Sources leave out tools and the organization's accounts.
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Sources' }));
    expect(within(dialog).queryByRole('region', { name: 'Organization accounts' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Connect Google Cloud' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Connect GitLab' })).toBeInTheDocument();
  });

  it('links an organization server with access for every session kind', async () => {
    const writes = useHandlers();
    renderConnections();
    await userEvent.click(await screen.findByRole('button', { name: 'Add connection' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add connection' });
    await userEvent.type(within(dialog).getByRole('searchbox', { name: 'Search integrations and accounts' }), 'notes');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Link Notes' }));

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
    await userEvent.click(within(dialog).getByRole('button', { name: 'Link Syncta' }));

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
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Connect Google Cloud' }));
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
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Connect ClickUp' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect ClickUp' });
    expect(await within(dialog).findByRole('status')).toHaveTextContent('Connected');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('dialog', { name: 'Add connection' })).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Connect ClickUp' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Connect ClickUp' })).getByRole('button', { name: 'Open settings' }));
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent('?connection=clickup'));
  });

  it('shows the last 24 hours of agent calls with counts, newest first', async () => {
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
    renderConnections();
    expect(await screen.findByText('2 calls · errors: 1')).toBeInTheDocument();
    const calls = screen.getByRole('list', { name: 'Latest calls' });
    expect(within(calls).getAllByRole('listitem')[0]).toHaveTextContent('Firestore syncta-57c6a');
    expect(within(calls).getAllByRole('listitem')[0]).toHaveTextContent('list_collections');
    expect(within(calls).getByRole('link', { name: 'Open session' })).toHaveAttribute('href', `/factories/${FACTORY_ID}/workspaces/session-1`);
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
    await rows();
    expect(screen.getByRole('button', { name: 'Actions for Sentry' })).toHaveClass('size-11');
    await userEvent.click(screen.getByRole('button', { name: 'Add connection' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add connection' });
    expect(dialog.className).toContain('max-sm:h-[calc(100dvh+3rem)]');
    expect(dialog.className).toContain('max-sm:rounded-none');
  });
});
