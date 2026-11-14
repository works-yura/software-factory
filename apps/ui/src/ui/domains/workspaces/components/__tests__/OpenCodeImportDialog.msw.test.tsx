import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { TEST_BASE_URL, renderWithProviders } from '../../../../../../e2e/ui/render';
import { OpenCodeImportButton } from '../OpenCodeImportDialog';

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="location">{location.pathname}</output>;
}

function stub({ localSessions = true }: { localSessions?: boolean } = {}) {
  const imports: Array<{ id: string; body: unknown }> = [];
  server.use(
    http.get(`${TEST_BASE_URL}/web/config/features`, () => HttpResponse.json({ knowledge: false, opencodeLocalSessions: localSessions })),
    http.get(`${TEST_BASE_URL}/web/opencode/local-sessions`, () =>
      HttpResponse.json({
        repositories: [
          { projectRepositoryId: 'repo-back', slug: 'Eclipt-AI/syncta_back' },
          { projectRepositoryId: 'repo-docs', slug: 'Eclipt-AI/syncta-docs' },
        ],
        sessions: [
          {
            id: 'ses_a',
            title: 'Fix login',
            directory: '/work/syncta_back',
            updatedAt: '2026-11-14T10:00:00.000Z',
            messages: 12,
            repositorySlug: 'Eclipt-AI/syncta_back',
            projectRepositoryId: 'repo-back',
          },
          { id: 'ses_b', title: 'Scratch idea', directory: '/tmp/idea', updatedAt: '2026-11-13T10:00:00.000Z', messages: 3 },
        ],
      }),
    ),
    http.post(`${TEST_BASE_URL}/web/opencode/local-sessions/:id/import`, async ({ params, request }) => {
      imports.push({ id: String(params.id), body: await request.json() });
      return HttpResponse.json({ session: { sessionId: 'new-session' }, imported: { turns: 6 } });
    }),
  );
  return imports;
}

function renderButton() {
  return renderWithProviders(
    <MemoryRouter initialEntries={['/factories/fp-1']}>
      <Routes>
        <Route path="/factories/:factoryId/*" element={<OpenCodeImportButton />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe('Continue an OpenCode session', () => {
  it('is offered only where the server is the person’s own machine', async () => {
    stub({ localSessions: false });
    renderButton();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Continue an OpenCode session' })).toBeNull());
  });

  it('lists the person’s sessions and continues one on the repository its folder is a clone of', async () => {
    const imports = stub();
    renderButton();
    await userEvent.click(await screen.findByRole('button', { name: 'Continue an OpenCode session' }));
    const list = await screen.findByRole('list', { name: 'Your OpenCode sessions' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Fix login')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Eclipt-AI/syncta_back')).toBeInTheDocument();
    // A folder that is not a clone of the Factory's repositories waits for a pick.
    expect(within(rows[1]!).getByText(/not a repository/)).toBeInTheDocument();
    expect(within(rows[1]!).getByRole('button', { name: 'Continue here' })).toBeDisabled();

    await userEvent.click(within(rows[0]!).getByRole('button', { name: 'Continue here' }));
    await waitFor(() => expect(imports).toEqual([{ id: 'ses_a', body: { projectRepositoryId: 'repo-back', visibility: 'private' } }]));
    await waitFor(() => expect(screen.getByLabelText('location')).toHaveTextContent('/factories/fp-1/user/threads/new-session'));
  });
});
