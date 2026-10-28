import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { TEST_BASE_URL, renderWithProviders } from '../../../../../../e2e/ui/render';
import type { FactoryProjectPayload } from '../../../workspaces/services/github';
import { FactoryManagementSection } from '../FactoryManagementSection';

function serveFactory(project: FactoryProjectPayload) {
  server.use(
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () => HttpResponse.json({ projects: [project] })),
    http.get(`${TEST_BASE_URL}/web/factory/projects/${project.id}/source-control-connections`, () =>
      HttpResponse.json({ connections: [] }),
    ),
  );
}

function renderSection() {
  return renderWithProviders(
    <MemoryRouter initialEntries={['/factories/fp-1/settings']}>
      <Routes>
        <Route path="/factories/:factoryId/settings" element={<FactoryManagementSection />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Factory settings: harness', () => {
  it('shows a Claude Code Factory’s harness and points to Models to switch it', async () => {
    serveFactory({ id: 'fp-1', name: 'Mastra', harness: 'claude-code' });

    renderSection();

    expect(await screen.findByText('Agents run on')).toBeInTheDocument();
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('Switch it in Models; the switch applies to new sessions.')).toBeInTheDocument();
    // The switch lives in Models only: here there is a link to it, not a second control.
    expect(screen.getByRole('link', { name: 'Change in Models' })).toHaveAttribute(
      'href',
      '/factories/fp-1/settings/models',
    );
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['Delete']);
  });

  it('shows Mastra for a Factory from a server that predates harnesses', async () => {
    serveFactory({ id: 'fp-1', name: 'Mastra' });

    renderSection();

    expect(await screen.findByText('Agents run on')).toBeInTheDocument();
    expect(screen.getByText('Mastra', { selector: 'span' })).toBeInTheDocument();
    expect(screen.queryByText('Claude Code')).not.toBeInTheDocument();
  });
});
