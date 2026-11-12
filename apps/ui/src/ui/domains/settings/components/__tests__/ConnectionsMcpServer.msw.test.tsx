import { mcpCatalogEntry } from '@factory/core';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

// The real catalog files the server ships, so the form under test is the one people get.
import toolboxOverlay from '../../../../../../../../packages/server/src/mcp-servers/catalog/mcp-toolbox.factory.json';
import toolboxManifest from '../../../../../../../../packages/server/src/mcp-servers/catalog/mcp-toolbox.server.json';
import { server } from '../../../../../../e2e/ui/msw-server';
import { TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import type { McpServer } from '../../services/mcpServers';
import { acmeConnection, managedServer, mcpConnection, renderConnections, useIntegrationHandlers } from './fixtures/connections';

const BASE = `${TEST_BASE_URL}/web/mcp-servers`;
const toolbox = mcpCatalogEntry(toolboxManifest, toolboxOverlay);

const stored: McpServer = {
  id: 'srv-1',
  name: 'syncta-firestore',
  label: 'Syncta Firestore',
  launch: {
    transport: 'catalog',
    entry: 'mcp-toolbox',
    variant: 'firestore',
    inputs: { FIRESTORE_PROJECT: 'syncta-57c6a' },
    credentials: { GOOGLE_APPLICATION_CREDENTIALS: { kind: 'google-cloud-account', id: 'acc-1' } },
  },
  secretNames: { env: [], headers: [], files: [] },
  assignments: [{ factoryProjectId: 'factory-1', boards: ['audits'] }],
  toolPolicies: { default: 'allow', tools: {} },
  maskPersonalData: true,
  enabled: true,
  updatedAt: '2026-11-11T00:00:00.000Z',
  updatedBy: 'u1',
};

const discoveries: Array<{ from: string; context: Record<string, string> }> = [];

function useHandlers(servers: McpServer[] = [], canEdit = true) {
  const writes: Array<{ method: string; url: string; body: any }> = [];
  discoveries.length = 0;
  // The server lists each server as an MCP connection whose page is the editor (the one custom section).
  useIntegrationHandlers({ connections: servers.filter(candidate => !candidate.owner).map(candidate => mcpConnection(candidate.id, candidate.label)) });
  server.use(
    http.get(`${TEST_BASE_URL}/web/connections/:id/detail`, ({ params }) =>
      HttpResponse.json({
        sections: [{ type: 'custom', component: 'mcp-server', params: { serverId: String(params.id).replace(/^mcp:/, '') } }],
      }),
    ),
    http.get(BASE, () =>
      HttpResponse.json({
        servers,
        catalog: [toolbox],
        credentials: { 'google-cloud-account': [{ id: 'acc-1', name: 'Syncta', detail: 'factory@syncta-57c6a.iam.gserviceaccount.com' }] },
        canEdit,
      }),
    ),
    http.get(`${BASE}/suggestions`, ({ request }) =>
      HttpResponse.json({
        suggestions: new URL(request.url).searchParams.get('factoryProjectId') === 'factory-1' ? { 'google-cloud-project': 'syncta-57c6a' } : {},
      }),
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
      HttpResponse.json({ projects: [{ id: 'factory-1', name: 'syncts', repositories: [] }] }),
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects/factory-1/boards`, () =>
      HttpResponse.json({
        boards: [
          { id: 'work', name: 'Work', phases: [{ id: 'triage', name: 'Triage', kind: 'working' }] },
          { id: 'audits', name: 'Audits', phases: [{ id: 'analysis', name: 'Analysis', kind: 'working' }, { id: 'done', name: 'Done', kind: 'terminal' }] },
          { id: 'custom-board', name: 'Partners', phases: [{ id: 'review', name: 'Partner review', kind: 'working' }] },
        ],
      }),
    ),
    http.post(BASE, async ({ request }) => {
      const body = await request.json();
      writes.push({ method: 'POST', url: request.url, body });
      return HttpResponse.json({ server: { ...stored, ...(body as object), id: 'srv-new' } }, { status: 201 });
    }),
    http.put(`${BASE}/:id`, async ({ request }) => {
      const body = await request.json();
      writes.push({ method: 'PUT', url: request.url, body });
      return HttpResponse.json({ server: { ...stored, ...(body as object) } });
    }),
    // What the picked account sees: the key's project first, then another; that project's databases.
    http.post(`${BASE}/discover`, async ({ request }) => {
      const body = (await request.json()) as { from: string; context: Record<string, string> };
      discoveries.push(body);
      return HttpResponse.json(
        body.from === 'google-cloud-projects'
          ? { items: [{ value: 'syncta-57c6a', label: 'Syncta' }, { value: 'bookfate-prod' }], default: 'syncta-57c6a' }
          : { items: [{ value: '(default)' }, { value: 'analytics' }], default: '(default)', denied: undefined },
      );
    }),
    http.post(`${BASE}/check`, async ({ request }) => {
      const body = await request.json();
      writes.push({ method: 'CHECK', url: request.url, body });
      return HttpResponse.json({
        status: {
          connected: true,
          toolCount: 2,
          tools: [
            { name: 'query_collection', description: '', policy: 'allow' },
            { name: 'delete_documents', description: '', policy: 'allow' },
          ],
          checkedAt: 'now',
        },
      });
    }),
    http.get(`${BASE}/:id/calls`, () => HttpResponse.json({ calls: [] })),
    http.post(`${BASE}/:id/status`, () =>
      HttpResponse.json({
        status: {
          connected: true,
          toolCount: 2,
          tools: [
            { name: 'query_collection', description: '', policy: 'allow' },
            { name: 'delete_documents', description: '', policy: 'allow' },
          ],
          checkedAt: 'now',
        },
      }),
    ),
  );
  return writes;
}

/**
 * The page at `search`: the list, a connection's tab (`?connection=mcp:srv-1&view=tools`) or a new
 * server from the catalog. Waits until the integrations have loaded.
 */
async function render(search = '') {
  renderConnections(search);
  await waitFor(() => expect(screen.queryByRole('status', { name: 'Loading connections…' })).not.toBeInTheDocument());
}
const NEW_TOOLBOX = '?connection=new:mcp:entry:mcp-toolbox';

async function pick(combobox: string, option: string) {
  await userEvent.click(screen.getByRole('combobox', { name: combobox }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

describe('Підключення: MCP servers', () => {
  it('adds Firestore from the catalog: picks the Google Cloud account, takes the project from the Factory, no raw variable names', async () => {
    const writes = useHandlers();
    await render(NEW_TOOLBOX);

    await pick('What to connect', 'Firestore');
    // The form is the manifest's inputs in the person's language, never env names.
    expect(screen.queryByText('FIRESTORE_PROJECT')).not.toBeInTheDocument();
    expect(screen.queryByText('GOOGLE_APPLICATION_CREDENTIALS')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /Service account key/ })).not.toBeInTheDocument();
    await pick('Google Cloud account', 'Syncta · factory@syncta-57c6a.iam.gserviceaccount.com');

    // The account's projects are offered, its key's project prefilled; then that project's databases.
    const project = screen.getByRole('combobox', { name: 'Google Cloud project' });
    await waitFor(() => expect(project).toHaveValue('Syncta (syncta-57c6a)'));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Firestore database' })).toHaveValue('(default)'));
    expect(discoveries).toEqual([
      expect.objectContaining({ from: 'google-cloud-projects', context: {} }),
      expect.objectContaining({ from: 'firestore-databases', context: { project: 'syncta-57c6a' } }),
    ]);
    await userEvent.click(project);
    expect(await screen.findByRole('option', { name: /^bookfate-prod/ })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    await userEvent.clear(screen.getByRole('textbox', { name: 'Name' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Syncta Firestore');
    await userEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(screen.getByLabelText('Identifier')).toHaveTextContent('syncta-firestore');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.body).toEqual({
      name: 'syncta-firestore',
      label: 'Syncta Firestore',
      launch: {
        transport: 'catalog',
        entry: 'mcp-toolbox',
        variant: 'firestore',
        inputs: { FIRESTORE_PROJECT: 'syncta-57c6a', FIRESTORE_DATABASE: '(default)' },
        credentials: { GOOGLE_APPLICATION_CREDENTIALS: { kind: 'google-cloud-account', id: 'acc-1' } },
      },
      assignments: [{ factoryProjectId: 'factory-1', sessions: ['chat', 'personal', 'cards'] }],
      toolPolicies: { default: 'allow', tools: {} },
      maskPersonalData: true,
      enabled: true,
    });
  });

  it('sends a secret input once, as a secret, for PostgreSQL', async () => {
    const writes = useHandlers();
    await render(NEW_TOOLBOX);
    await pick('What to connect', 'PostgreSQL');
    await userEvent.type(screen.getByRole('textbox', { name: 'Database' }), 'reports');
    await userEvent.type(screen.getByRole('textbox', { name: 'User' }), 'reader');
    await userEvent.type(screen.getByLabelText('Password'), 'hunter2');
    expect(screen.getByRole('textbox', { name: 'Host' })).toHaveAttribute('placeholder', 'Empty means localhost');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.body).toMatchObject({
      launch: { transport: 'catalog', variant: 'postgres', inputs: { POSTGRES_DATABASE: 'reports', POSTGRES_USER: 'reader' } },
      secrets: { env: { POSTGRES_PASSWORD: 'hunter2' } },
    });
    expect(writes[0]!.body.launch.inputs.POSTGRES_PASSWORD).toBeUndefined();
  });

  it('adds an own server as a local command, with no stdio/HTTP wording', async () => {
    const writes = useHandlers();
    await render('?connection=new:mcp:custom');
    await screen.findByRole('textbox', { name: 'Command' });
    expect(screen.queryByText(/stdio|HTTP\)/)).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Notes');
    await userEvent.type(screen.getByRole('textbox', { name: 'Command' }), '/usr/local/bin/notes-mcp');
    await userEvent.type(screen.getByRole('textbox', { name: 'Secret variables' }), 'NOTES_TOKEN=t0k');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.body).toMatchObject({
      name: 'notes',
      launch: { transport: 'stdio', command: '/usr/local/bin/notes-mcp', args: [], env: {} },
      secrets: { env: { NOTES_TOKEN: 't0k' } },
    });
  });

  it('assigns a stored server to a Factory board on «Access», and forbids one tool after a check on «Tools»', async () => {
    const writes = useHandlers([stored]);
    await render('?connection=mcp:srv-1&view=access');

    const access = await screen.findByRole('group', { name: 'Access for syncts' });
    // A row from before session kinds with a board limit meant cards only.
    expect(within(access).getByRole('button', { name: 'Cards', pressed: true })).toBeInTheDocument();
    expect(within(access).getByRole('button', { name: 'Factory chat', pressed: false })).toBeInTheDocument();
    // Built-in boards and phases by their translated titles; a custom board by its own name.
    expect(within(access).getByRole('button', { name: 'Audits', pressed: true })).toBeInTheDocument();
    expect(within(access).getByRole('button', { name: 'Partners' })).toBeInTheDocument();
    await userEvent.click(within(access).getByRole('button', { name: 'Analysis' }));
    await userEvent.click(within(screen.getByRole('tabpanel')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes.filter(write => write.method === 'PUT')).toHaveLength(1));
    expect(writes.find(write => write.method === 'PUT')).toMatchObject({
      body: { assignments: [{ factoryProjectId: 'factory-1', sessions: ['cards'], boards: ['audits'], phases: ['analysis'] }] },
    });

    await userEvent.click(screen.getByRole('tab', { name: 'Tools' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Check' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Running: 2 tools.');
    expect(within(screen.getByRole('listitem', { name: 'delete_documents' })).getByText('writes')).toBeInTheDocument();
    await pick('Policy for delete_documents', 'Forbidden');
    await userEvent.click(within(screen.getByRole('tabpanel')).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(writes.filter(write => write.method === 'PUT')).toHaveLength(2));
    expect(writes.filter(write => write.method === 'PUT')[1]).toMatchObject({
      method: 'PUT',
      body: {
        name: 'syncta-firestore',
        launch: { credentials: { GOOGLE_APPLICATION_CREDENTIALS: { kind: 'google-cloud-account', id: 'acc-1' } } },
        toolPolicies: { default: 'allow', tools: { delete_documents: 'deny' } },
      },
    });
    expect(writes.filter(write => write.method === 'PUT').every(write => write.body.secrets === undefined)).toBe(true);
  });

  it('shows a member the servers without letting them change anything', async () => {
    useHandlers([stored], false);
    await render('?connection=mcp:srv-1&view=settings');
    expect(await screen.findByRole('combobox', { name: 'What to connect' })).toBeDisabled();
    expect(within(screen.getByRole('tabpanel')).queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it("shows a server an integration manages inside that connection's page: config read-only, tool policy editable, no access or delete", async () => {
    const writes = useHandlers([{ ...managedServer, health: undefined }], true);
    server.use(
      http.get(`${TEST_BASE_URL}/web/connections`, () =>
        HttpResponse.json({ connections: [acmeConnection], failures: [], copy: { organizationWide: 'Whole organization' } }),
      ),
      http.get(`${TEST_BASE_URL}/web/connections/:id/detail`, () =>
        HttpResponse.json({
          sections: [{ type: 'custom', component: 'mcp-server', title: 'Database tools', params: { owner: 'firebase', key: 'bnd-1' } }],
        }),
      ),
    );
    await render('?connection=acme%3Amain');

    expect(await screen.findByRole('heading', { name: 'Database tools' })).toBeInTheDocument();
    expect(await screen.findByRole('combobox', { name: 'What to connect' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    // A managed server keeps the access its integration gives it.
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Settings', 'Tools']);

    await userEvent.click(screen.getByRole('tab', { name: 'Tools' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Check' }));
    await pick('Policy for delete_documents', 'Forbidden');
    await userEvent.click(within(screen.getByRole('tabpanel')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes.at(-1)?.body.toolPolicies).toEqual({ default: 'allow', tools: { delete_documents: 'deny' } }));
  });

  it('adds a Google Cloud account right from the form and picks it', async () => {
    useHandlers();
    const added = { id: 'acc-new', name: 'BookFate', clientEmail: 'factory@bookfate-prod.iam.gserviceaccount.com', projectId: 'bookfate-prod', keyId: 'k' };
    const posted: unknown[] = [];
    server.use(
      http.post(`${TEST_BASE_URL}/web/firebase/accounts`, async ({ request }) => {
        posted.push(await request.json());
        return HttpResponse.json({ account: added, accounts: [{ ...added, bindingIds: [] }], bindings: [] });
      }),
      http.get(BASE, () =>
        HttpResponse.json({
          servers: [],
          catalog: [toolbox],
          credentials: {
            'google-cloud-account': [
              { id: 'acc-1', name: 'Syncta', detail: 'factory@syncta-57c6a.iam.gserviceaccount.com' },
              ...(posted.length ? [{ id: 'acc-new', name: 'BookFate', detail: added.clientEmail }] : []),
            ],
          },
          canEdit: true,
        }),
      ),
    );
    await render(NEW_TOOLBOX);
    await pick('What to connect', 'Firestore');

    await userEvent.click(screen.getByRole('button', { name: '+ Add account' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByRole('textbox', { name: /key/i }), '{{"type":"service_account"}');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save key' }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(await screen.findByRole('combobox', { name: 'Google Cloud account' })).toHaveTextContent('BookFate');
  });

  it('opened from a Factory, starts with that Factory’s access; «Check» names what is missing, then lists tools before saving', async () => {
    const writes = useHandlers();
    await render(NEW_TOOLBOX);
    await pick('What to connect', 'Firestore');

    expect(await screen.findByRole('group', { name: 'Access for syncts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check' })).toBeDisabled();
    // The project already comes from the Factory's Google Cloud binding; only the account is missing.
    expect(await screen.findByText('To check, fill in: Google Cloud account.')).toBeInTheDocument();

    await pick('Google Cloud account', 'Syncta · factory@syncta-57c6a.iam.gserviceaccount.com');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Google Cloud project' })).toHaveValue('Syncta (syncta-57c6a)'));
    await userEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Running: 2 tools.');
    await pick('Policy for delete_documents', 'Forbidden');

    const check = writes.find(write => write.method === 'CHECK')!;
    expect(check.body.id).toBeUndefined();
    expect(check.body.server).toMatchObject({ launch: { inputs: { FIRESTORE_PROJECT: 'syncta-57c6a' } }, assignments: [{ factoryProjectId: 'factory-1' }] });
    expect(writes.filter(write => write.method !== 'CHECK')).toEqual([]);

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes.find(write => write.method === 'POST')?.body).toMatchObject({
      assignments: [{ factoryProjectId: 'factory-1' }],
      toolPolicies: { default: 'allow', tools: { delete_documents: 'deny' } },
    }));
  });

  it('inspects tools: risk from annotations, parameters, a quarantined tool highlighted, and tries a read-only one', async () => {
    const tried: unknown[] = [];
    useHandlers([
      {
        ...stored,
        toolPolicies: { default: 'allow', tools: { add_documents: 'review' } },
        health: {
          state: 'ok',
          checkedAt: new Date().toISOString(),
          tools: [
            {
              name: 'list_collections',
              description: 'Lists collections.',
              annotations: { readOnlyHint: true },
              inputSchema: { type: 'object', properties: { parent: { type: 'string' } } },
            },
            { name: 'add_documents', description: 'Adds documents.', annotations: { readOnlyHint: false } },
            { name: 'delete_documents', description: '', annotations: { destructiveHint: true } },
          ],
        },
      },
    ]);
    server.use(
      http.post(`${BASE}/:id/try`, async ({ request }) => {
        tried.push(await request.json());
        return HttpResponse.json({ trial: { ok: true, output: { collections: ['bookings'] }, durationMs: 42 } });
      }),
    );
    await render('?connection=mcp:srv-1&view=tools');

    const list = within(screen.getByRole('listitem', { name: 'list_collections' }));
    expect(list.getByText('reads')).toBeInTheDocument();
    await userEvent.click(list.getByRole('button', { name: 'Parameters' }));
    expect(list.getByLabelText('Parameters of list_collections')).toHaveTextContent('"parent"');

    const add = within(screen.getByRole('listitem', { name: 'add_documents' }));
    expect(add.getByText('needs review')).toBeInTheDocument();
    expect(add.getByRole('combobox', { name: 'Policy for add_documents' })).toHaveTextContent('Needs review');
    // Only read-only tools can be tried.
    expect(add.queryByRole('button', { name: 'Try' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('listitem', { name: 'delete_documents' })).getByText('deletes')).toBeInTheDocument();

    await userEvent.click(list.getByRole('button', { name: 'Try' }));
    const args = list.getByRole('textbox', { name: 'Arguments for list_collections (JSON)' });
    await userEvent.clear(args);
    await userEvent.type(args, '{{"parent":"x"}');
    await userEvent.click(list.getByRole('button', { name: 'Run' }));
    expect(await list.findByRole('status', { name: 'Result' })).toHaveTextContent('Done in 42 ms.');
    expect(list.getByText(/bookings/)).toBeInTheDocument();
    expect(tried).toEqual([{ tool: 'list_collections', arguments: { parent: 'x' } }]);
  });

  it('reconnects a server and explains a failed check in plain words', async () => {
    useHandlers([stored]);
    server.use(
      http.post(`${BASE}/:id/reconnect`, () =>
        HttpResponse.json({
          status: { connected: false, toolCount: 0, tools: [], error: 'find_user timed out after 60 s', errorKind: 'timeout', checkedAt: 'now' },
        }),
      ),
    );
    await render('?connection=mcp:srv-1&view=tools');
    await userEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Does not start: The server did not answer in time. (find_user timed out after 60 s)',
    );
  });

  it('gives access by session kind, keeps one row per Factory, and drops board limits with cards', async () => {
    const writes = useHandlers([{ ...stored, assignments: [] }]);
    await render('?connection=mcp:srv-1&view=access');
    await userEvent.click(await screen.findByRole('button', { name: 'Add Factory' }));
    const access = await screen.findByRole('group', { name: 'Access for syncts' });
    // A new row reaches every kind of session; with the only Factory listed, no second row can be added.
    for (const kind of ['Factory chat', 'Own sessions', 'Cards']) {
      expect(within(access).getByRole('button', { name: kind, pressed: true })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: 'Add Factory' })).not.toBeInTheDocument();

    await userEvent.click(within(access).getByRole('button', { name: 'Audits' }));
    await userEvent.click(within(access).getByRole('button', { name: 'Own sessions' }));
    await userEvent.click(within(access).getByRole('button', { name: 'Cards' }));
    expect(within(access).queryByRole('button', { name: 'Audits' })).not.toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('tabpanel')).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(writes.filter(write => write.method === 'PUT')).toHaveLength(1));
    expect(writes.find(write => write.method === 'PUT')!.body.assignments).toEqual([{ factoryProjectId: 'factory-1', sessions: ['chat'] }]);
  });
});
