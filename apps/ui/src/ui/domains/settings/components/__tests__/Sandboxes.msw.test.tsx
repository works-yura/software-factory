import { Toaster } from '@mastra/playground-ui/components/Toaster';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import type { FactorySandbox } from '../../../workspaces/services/sandboxes';
import { SandboxesBlock } from '../environment/SandboxesBlock';

const FACTORY_ID = '11111111-2222-4333-8444-555555555555';
const URL = `${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/sandboxes`;

const idle: FactorySandbox = {
  key: 'work-items/f/factory-item-12',
  kind: 'card',
  sessionIds: ['s-1'],
  repos: ['api', 'web'],
  sizeBytes: 3.5 * 1024 ** 3,
  lastActivityAt: '2030-01-01T10:00:00.000Z',
  state: 'idle',
  problems: [],
};
const active: FactorySandbox = { ...idle, key: 'work-items/f/factory-item-13', state: 'active', sizeBytes: 512 * 1024 ** 2 };
const asleep: FactorySandbox = {
  ...idle,
  key: 'row-9',
  kind: 'session',
  state: 'asleep',
  sizeBytes: undefined,
  sleptAt: '2030-01-01T12:00:00.000Z',
  sleepReason: 'limit',
  problems: [],
};

function render() {
  renderWithProviders(
    <>
      <SandboxesBlock factoryId={FACTORY_ID} />
      <Toaster />
    </>,
  );
}

describe('Settings › Environment › Sandboxes', () => {
  it('lists each sandbox with its state, repositories, size and activity; stops an idle one, never an active one', async () => {
    let sandboxes = [idle, active, asleep];
    const slept: string[] = [];
    server.use(
      http.get(URL, () => HttpResponse.json({ sandboxes, canManage: true })),
      http.post(`${URL}/sleep`, async ({ request }) => {
        const { key } = (await request.json()) as { key: string };
        slept.push(key);
        sandboxes = sandboxes.map(sandbox => (sandbox.key === key ? { ...sandbox, state: 'asleep', sleepReason: 'manual' } : sandbox));
        return HttpResponse.json({ outcome: 'slept' });
      }),
    );
    render();
    const rows = await screen.findAllByTestId('sandbox-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Idle');
    expect(rows[0]).toHaveTextContent('factory-item-12');
    expect(rows[0]).toHaveTextContent('api, web · 3.5 GB');
    expect(rows[1]).toHaveTextContent('Active');
    expect(within(rows[1]!).getByRole('button', { name: 'Save and stop' })).toBeDisabled();
    expect(rows[2]).toHaveTextContent('Asleep');
    expect(rows[2]).toHaveTextContent('over the limit');
    expect(within(rows[2]!).queryByRole('button')).not.toBeInTheDocument();

    await userEvent.setup().click(within(rows[0]!).getByRole('button', { name: 'Save and stop' }));
    await waitFor(() => expect(slept).toEqual(['work-items/f/factory-item-12']));
    expect(await screen.findByText('factory-item-12 saved and stopped')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByTestId('sandbox-row')[0]).toHaveTextContent('Asleep'));
  });

  it('shows why a sandbox keeps its folder, and the server’s refusal', async () => {
    server.use(
      http.get(URL, () =>
        HttpResponse.json({
          sandboxes: [{ ...idle, problems: [{ kind: 'save-failed', message: 'repo: no credentials', at: '2030-01-01T00:00:00.000Z', occurrence: '1' }] }],
          canManage: true,
        }),
      ),
      http.post(`${URL}/sleep`, () =>
        HttpResponse.json({ error: 'save_failed', message: 'repo: still no credentials' }, { status: 500 }),
      ),
    );
    render();
    expect(await screen.findByText(/could not be saved, so its folder is kept/)).toBeInTheDocument();
    expect(screen.getByText('repo: no credentials')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save and stop' }));
    expect(await screen.findByText('repo: still no credentials')).toBeInTheDocument();
  });

  it('tells a member the list is for admins', async () => {
    server.use(http.get(URL, () => HttpResponse.json({ error: 'organization_admin_required' }, { status: 403 })));
    render();
    expect(await screen.findByText('Only organization admins see and manage sandboxes.')).toBeInTheDocument();
  });
});
