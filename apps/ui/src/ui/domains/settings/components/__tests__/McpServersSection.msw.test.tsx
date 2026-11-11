import { Toaster } from '@mastra/playground-ui/components/Toaster';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import type { McpServer, McpServerPreset } from '../../services/mcpServers';
import { McpServersSection } from '../McpServersSection';

const BASE = `${TEST_BASE_URL}/web/mcp-servers`;

const firestorePreset: McpServerPreset = {
  id: 'toolbox-firestore',
  label: 'MCP Toolbox for Databases · Firestore',
  description: 'Google’s MCP Toolbox with its Firestore tools.',
  args: ['--prebuilt', 'firestore', '--stdio'],
  env: [{ name: 'FIRESTORE_PROJECT', label: 'Google Cloud project ID', required: true }],
  secretFiles: [{ name: 'GOOGLE_APPLICATION_CREDENTIALS', label: 'Service account key (JSON)', required: true }],
  writeTools: ['add_documents', 'update_document', 'delete_documents'],
  docsUrl: 'https://mcp-toolbox.dev',
};

const stored: McpServer = {
  id: 'srv-1',
  name: 'syncta-db',
  label: 'Syncta Firestore',
  launch: { transport: 'stdio', preset: 'toolbox-firestore', args: [], env: { FIRESTORE_PROJECT: 'syncta-57c6a' } },
  secretNames: { env: [], headers: [], files: ['GOOGLE_APPLICATION_CREDENTIALS'] },
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
    http.get(BASE, () => HttpResponse.json({ servers, presets: [firestorePreset], canEdit })),
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

describe('McpServersSection', () => {
  it('adds a Firestore server through the Toolbox preset; the key goes in once and nobody gets the server yet', async () => {
    const writes = useHandlers();
    render();
    expect(await screen.findByText(/No servers yet/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Add server' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Syncta Firestore');
    await userEvent.type(screen.getByRole('textbox', { name: 'Identifier' }), 'syncta-db');
    await userEvent.type(screen.getByRole('textbox', { name: 'FIRESTORE_PROJECT' }), 'syncta-57c6a');
    await userEvent.type(screen.getByRole('textbox', { name: 'Service account key (JSON)' }), 'KEY');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.body).toMatchObject({
      name: 'syncta-db',
      label: 'Syncta Firestore',
      launch: { transport: 'stdio', preset: 'toolbox-firestore', env: { FIRESTORE_PROJECT: 'syncta-57c6a' } },
      secrets: { files: { GOOGLE_APPLICATION_CREDENTIALS: 'KEY' } },
      assignments: [],
      toolPolicies: { default: 'allow', tools: {} },
      maskPersonalData: true,
    });
  });

  it('assigns a stored server to a Factory board and sets one tool to forbidden after a check; the key is kept', async () => {
    const writes = useHandlers([stored]);
    render();
    await userEvent.click(await screen.findByRole('button', { name: /Syncta Firestore/ }));
    expect(screen.getByText(/syncta-db · MCP Toolbox for Databases · Firestore · 1 Factory/)).toBeInTheDocument();

    const access = await screen.findByRole('group', { name: 'Access for syncts' });
    expect(within(access).getByRole('button', { name: 'Аудити', pressed: true })).toBeInTheDocument();
    await userEvent.click(within(access).getByRole('button', { name: 'Аналіз' }));

    await userEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Running: 2 tools.');
    expect(screen.getByText('changes data')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('combobox', { name: 'Policy for delete_documents' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Forbidden' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({
      method: 'PUT',
      body: {
        assignments: [{ factoryProjectId: 'factory-1', boards: ['audits'], phases: ['analysis'] }],
        toolPolicies: { default: 'allow', tools: { delete_documents: 'deny' } },
      },
    });
    // Nothing typed into the key field: the stored key stays.
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
