/**
 * The UI side of the connector conformance kit: renders any connector fixture — a descriptor, its
 * connections, their detail sections and removal impact — through the real page (list, detail, add,
 * remove) over MSW. A connector the UI has never heard of must work from these descriptors alone.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import type { ConnectionDetailSection, ConnectionView, ConnectorView, RemovalImpact } from '@factory/contracts';

import { server } from '../../../../../../../e2e/ui/msw-server';
import { TEST_BASE_URL } from '../../../../../../../e2e/ui/render';
import { renderConnections, useIntegrationHandlers } from './connections';

export interface ConnectorUiFixture {
  connector: ConnectorView;
  /** Its connections; the first is opened and removed. Its `remove` action must be `true`. */
  connections: [ConnectionView, ...ConnectionView[]];
  /** The first connection's detail sections, each with a `title` the page shows. */
  sections: ConnectionDetailSection[];
  impact: RemovalImpact;
}

const rows = async () => within(await screen.findByRole('table', { name: "This Factory's connections" })).getAllByTestId('connection-row');

export function describeConnectorUi(label: string, fixture: () => ConnectorUiFixture): void {
  describe(`${label}: rendered from its descriptors`, () => {
    const serve = () => {
      const current = fixture();
      useIntegrationHandlers({ connectors: [current.connector], connections: current.connections });
      const deleted: Array<{ id: unknown; confirm: string | null }> = [];
      server.use(
        http.get(`${TEST_BASE_URL}/web/connections/:id/detail`, () => HttpResponse.json({ sections: current.sections })),
        http.get(`${TEST_BASE_URL}/web/connections/:id/impact`, () => HttpResponse.json(current.impact)),
        http.delete(`${TEST_BASE_URL}/web/connections/:id`, ({ params, request }) => {
          deleted.push({ id: params.id, confirm: new URL(request.url).searchParams.get('confirm') });
          return HttpResponse.json({ removed: true, message: 'Removed by the contract.' });
        }),
      );
      return { current, deleted };
    };

    it('lists each connection with its label, state and connector name', async () => {
      const { current } = serve();
      renderConnections();
      const listed = await rows();
      for (const connection of current.connections) {
        const row = listed.find(candidate => within(candidate).queryByRole('link', { name: connection.label }));
        expect(row, connection.label).toBeDefined();
        expect(row).toHaveTextContent(current.connector.name);
      }
    });

    it("opens a connection's page with every section the server lays out", async () => {
      const { current } = serve();
      const [first] = current.connections;
      renderConnections(`?connection=${encodeURIComponent(first.id)}`);
      expect(await screen.findByRole('heading', { name: first.label, level: 1 })).toBeInTheDocument();
      for (const section of current.sections) {
        if ('title' in section && section.title) expect(await screen.findByText(section.title)).toBeInTheDocument();
      }
    });

    it('offers it in «Add connection» under its category', async () => {
      const { current } = serve();
      renderConnections();
      await userEvent.click(await screen.findByRole('button', { name: 'Add connection' }));
      const dialog = await screen.findByRole('dialog', { name: 'Add connection' });
      expect(within(dialog).getByRole('option', { name: `Connect ${current.connector.name}` })).toBeInTheDocument();
    });

    it('removes after showing the impact, confirming when it asks', async () => {
      const { current, deleted } = serve();
      const [first] = current.connections;
      renderConnections();
      await rows();
      await userEvent.click(screen.getByRole('button', { name: `Actions for ${first.label}` }));
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete connection' }));
      const removal = await screen.findByRole('dialog', { name: current.impact.title });
      for (const item of current.impact.items) expect(within(removal).getAllByText(item.label).length).toBeGreaterThan(0);
      expect(deleted).toEqual([]);
      await userEvent.click(within(removal).getByRole('button', { name: current.impact.confirmLabel }));
      await waitFor(() => expect(deleted).toEqual([{ id: first.id, confirm: current.impact.requiresConfirm ? '1' : null }]));
    });
  });
}
