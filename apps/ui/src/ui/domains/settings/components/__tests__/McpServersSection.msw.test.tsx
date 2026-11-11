import { mcpCatalogEntry } from '@factory/core';
import { Toaster } from '@mastra/playground-ui/components/Toaster';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

// The real catalog files the server ships, so the form under test is the one people get.
import toolboxOverlay from '../../../../../../../../packages/server/src/mcp-servers/catalog/mcp-toolbox.factory.json';
import toolboxManifest from '../../../../../../../../packages/server/src/mcp-servers/catalog/mcp-toolbox.server.json';
import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import type { McpServer } from '../../services/mcpServers';
import { McpServersSection } from '../McpServersSection';

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

function useHandlers(servers: McpServer[] = [], canEdit = true) {
  const writes: Array<{ method: string; url: string; body: any }> = [];
  server.use(
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
          { id: 'work', name: 'Розробка', phases: [{ id: 'triage', name: 'Розбір', kind: 'working' }] },
          { id: 'audits', name: 'Аудити', phases: [{ id: 'analysis', name: 'Аналіз', kind: 'working' }, { id: 'done', name: 'Готово', kind: 'terminal' }] },
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

function render() {
  return renderWithProviders(
    <>
      <McpServersSection />
      <Toaster />
    </>,
  );
}

async function pick(combobox: string, option: string) {
  await userEvent.click(screen.getByRole('combobox', { name: combobox }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

describe('McpServersSection', () => {
  it('adds Firestore from the catalog: picks the Google Cloud account, takes the project from the Factory, no raw variable names', async () => {
    const writes = useHandlers();
    render();
    expect(await screen.findByText(/No servers yet/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Add server' }));
    const catalog = screen.getByRole('group', { name: 'Which server?' });
    await userEvent.type(within(catalog).getByRole('textbox', { name: 'Search servers' }), 'firestore');
    expect(within(catalog).queryByRole('button', { name: /Own server/ })).not.toBeInTheDocument();
    await userEvent.click(within(catalog).getByRole('button', { name: /Database \(MCP Toolbox\)/ }));

    await pick('What to connect', 'Firestore');
    // The form is the manifest's inputs in the person's language, never env names.
    expect(screen.queryByText('FIRESTORE_PROJECT')).not.toBeInTheDocument();
    expect(screen.queryByText('GOOGLE_APPLICATION_CREDENTIALS')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /Service account key/ })).not.toBeInTheDocument();
    await pick('Google Cloud account', 'Syncta · factory@syncta-57c6a.iam.gserviceaccount.com');

    await userEvent.click(screen.getByRole('button', { name: 'Add Factory' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Use «syncta-57c6a» from the Factory\'s binding' }));
    expect(screen.getByRole('textbox', { name: 'Google Cloud project' })).toHaveValue('syncta-57c6a');

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
        inputs: { FIRESTORE_PROJECT: 'syncta-57c6a' },
        credentials: { GOOGLE_APPLICATION_CREDENTIALS: { kind: 'google-cloud-account', id: 'acc-1' } },
      },
      assignments: [{ factoryProjectId: 'factory-1' }],
      toolPolicies: { default: 'allow', tools: {} },
      maskPersonalData: true,
      enabled: true,
    });
  });

  it('sends a secret input once, as a secret, for PostgreSQL', async () => {
    const writes = useHandlers();
    render();
    await userEvent.click(await screen.findByRole('button', { name: 'Add server' }));
    await userEvent.click(screen.getByRole('button', { name: /Database \(MCP Toolbox\)/ }));
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
    render();
    await userEvent.click(await screen.findByRole('button', { name: 'Add server' }));
    await userEvent.click(screen.getByRole('button', { name: /Own server/ }));
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

  it('assigns a stored server to a Factory board and sets one tool to forbidden after a check', async () => {
    const writes = useHandlers([stored]);
    render();
    await userEvent.click(await screen.findByRole('button', { name: /Syncta Firestore/ }));
    expect(screen.getByText(/Firestore · 1 Factory/)).toBeInTheDocument();

    const access = await screen.findByRole('group', { name: 'Access for syncts' });
    expect(within(access).getByRole('button', { name: 'Аудити', pressed: true })).toBeInTheDocument();
    await userEvent.click(within(access).getByRole('button', { name: 'Аналіз' }));

    await userEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Running: 2 tools.');
    expect(screen.getByText('changes data')).toBeInTheDocument();
    await pick('Policy for delete_documents', 'Forbidden');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({
      method: 'PUT',
      body: {
        name: 'syncta-firestore',
        launch: { credentials: { GOOGLE_APPLICATION_CREDENTIALS: { kind: 'google-cloud-account', id: 'acc-1' } } },
        assignments: [{ factoryProjectId: 'factory-1', boards: ['audits'], phases: ['analysis'] }],
        toolPolicies: { default: 'allow', tools: { delete_documents: 'deny' } },
      },
    });
    expect(writes[0]!.body.secrets).toBeUndefined();
  });

  it('shows a member the servers without letting them change anything', async () => {
    useHandlers([stored], false);
    render();
    await userEvent.click(await screen.findByRole('button', { name: /Syncta Firestore/ }));
    expect(screen.queryByRole('button', { name: 'Add server' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeDisabled();
  });
});
