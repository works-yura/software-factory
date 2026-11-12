import { Toaster } from '@mastra/playground-ui/components/Toaster';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import type { IntakeConfig } from '../../../factory/services/intake';
import { ClickUpService } from '../ClickUpService';

const CONFIG_URL = `${TEST_BASE_URL}/web/intake/config`;
const BINDINGS_URL = `${TEST_BASE_URL}/web/intake/bindings`;
const CLICKUP_STATUS_URL = `${TEST_BASE_URL}/web/clickup/status`;
const CLICKUP_LISTS_URL = `${TEST_BASE_URL}/web/clickup/lists`;
const ROUTES_URL = `${TEST_BASE_URL}/web/factory/projects/:id/intake-routes`;

type Binding = { integrationId: string; sourceId: string; factoryProjectId: string | null; board: string | null };

const readyStatus = {
  configured: true,
  connected: true,
  workspaces: ['Acme'],
  account: { username: 'factory-bot' },
  intervalSeconds: 60,
  canManage: true,
};
/** The organization has not connected ClickUp yet. */
const notConnected = { configured: false, connected: false, workspaces: [], intervalSeconds: 60, canManage: true };
const CLICKUP_CONNECTION_URL = `${TEST_BASE_URL}/web/clickup/connection`;
const lists = [
  { id: 'L1', name: 'Backlog', path: 'Eng / Mobile', workspaceId: 'w1' },
  { id: 'L2', name: 'Inbox', path: 'Support', workspaceId: 'w1' },
];
/** Routes of the Factory, as moved from a List's status rules: they name the List (`source.list`). */
const listRoutes = [
  {
    id: 'r-todo',
    name: 'ClickUp: статус «to do»',
    enabled: true,
    position: 0,
    when: {
      operator: 'AND',
      conditions: [
        { field: 'source.list', operator: 'equals', value: 'L1' },
        { field: 'item.state', operator: 'equals', value: 'to do' },
      ],
    },
    target: { boardKey: 'bug', phaseKey: null, joinClosedIssue: false },
    on: ['work_item.created'],
    revision: 1,
    problems: [],
  },
  {
    id: 'r-fixed',
    name: 'ClickUp: статус «dev fixed»',
    enabled: true,
    position: 1,
    when: {
      operator: 'AND',
      conditions: [
        { field: 'source.list', operator: 'equals', value: 'L1' },
        { field: 'item.state', operator: 'equals', value: 'dev fixed' },
      ],
    },
    target: { boardKey: 'bug', phaseKey: 'done', joinClosedIssue: false },
    on: ['work_item.state_changed'],
    revision: 1,
    problems: [],
  },
];
const bugBoard = {
  id: 'bug',
  title: 'Bug',
  initialPhase: 'intake',
  phases: [
    { id: 'intake', title: 'Intake', kind: 'resting', transitions: [] },
    { id: 'triage', title: 'Triage', kind: 'working', transitions: [] },
    { id: 'done', title: 'Done', kind: 'terminal', transitions: [] },
  ],
};

function clickUpConfig(clickup: IntakeConfig['clickup']): IntakeConfig {
  return { github: { enabled: false, sourceIds: null }, gitlab: { enabled: false, sourceIds: null }, clickup };
}

/**
 * Intake handlers for a signed-in ClickUp setup. Saved configs and bindings are returned so a test can
 * assert what the UI wrote; `bindings` seeds what is already routed.
 */
function useClickUpHandlers({
  config = clickUpConfig({ enabled: true, sourceIds: ['L1'] }),
  bindings = [],
  routes = listRoutes,
}: {
  config?: IntakeConfig;
  bindings?: Binding[];
  routes?: unknown[];
} = {}) {
  const savedConfigs: IntakeConfig[] = [];
  const savedBindings: Binding[] = [...bindings];
  server.use(
    http.get(CONFIG_URL, () => HttpResponse.json({ config })),
    http.put(CONFIG_URL, async ({ request }) => {
      const next = (await request.json()) as IntakeConfig;
      savedConfigs.push(next);
      return HttpResponse.json({ config: next });
    }),
    http.get(CLICKUP_STATUS_URL, () => HttpResponse.json(readyStatus)),
    http.get(CLICKUP_LISTS_URL, () => HttpResponse.json({ lists })),
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
      HttpResponse.json({ projects: [{ id: 'fp-1', name: 'Acme Web', repositories: [] }] }),
    ),
    http.get(BINDINGS_URL, () => HttpResponse.json({ bindings: savedBindings })),
    http.put(BINDINGS_URL, async ({ request }) => {
      const body = (await request.json()) as Binding;
      const index = savedBindings.findIndex(
        binding => binding.integrationId === body.integrationId && binding.sourceId === body.sourceId,
      );
      if (index === -1) savedBindings.push(body);
      else savedBindings[index] = body;
      return HttpResponse.json({ bindings: savedBindings });
    }),
    http.get(`${TEST_BASE_URL}/web/factory/projects/:id/boards`, () => HttpResponse.json({ boards: [bugBoard] })),
    http.get(ROUTES_URL, () => HttpResponse.json({ intakeRoutes: routes, canEdit: true })),
  );
  return { savedConfigs, savedBindings };
}

const routedToBug: Binding[] = [
  { integrationId: 'clickup', sourceId: 'L1', factoryProjectId: 'fp-1', board: 'bug' },
];

function renderIntakeSection() {
  return renderWithProviders(
    <>
      <ClickUpService />
      <Toaster position="bottom-right" />
    </>,
  );
}

/** Cards start folded; open the one for a List. */
async function openCard(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(await screen.findByRole('button', { name }));
}

describe('Integrations › ClickUp', () => {
  describe('given the config endpoint fails', () => {
    it('shows the unavailable notice', async () => {
      server.use(
        http.get(BINDINGS_URL, () => HttpResponse.json({ bindings: [] })),
        http.get(CONFIG_URL, () => HttpResponse.json({ error: 'nope' }, { status: 500 })),
        http.get(CLICKUP_STATUS_URL, () => HttpResponse.json(readyStatus)),
      );
      renderIntakeSection();

      expect(await screen.findByText(/Intake settings are unavailable/)).toBeInTheDocument();
    });
  });

  describe('given the server omits unregistered integrations', () => {
    // The server returns a dynamic map keyed by integration id and drops keys
    // for integrations that aren't registered, so the config can arrive as `{}`.
    it('renders ClickUp with its switch off instead of crashing', async () => {
      server.use(
        http.get(CONFIG_URL, () => HttpResponse.json({ config: {} })),
        http.get(BINDINGS_URL, () => HttpResponse.json({ bindings: [] })),
        http.get(CLICKUP_STATUS_URL, () => HttpResponse.json(readyStatus)),
      );
      renderIntakeSection();

      expect(await screen.findByRole('switch', { name: 'Import ClickUp tasks' })).not.toBeChecked();
    });
  });

  describe('ClickUp connection', () => {
    it('says ClickUp is not installed when the status route is missing, with nothing to connect', async () => {
      useClickUpHandlers();
      server.use(http.get(CLICKUP_STATUS_URL, () => new HttpResponse(null, { status: 404 })));
      renderIntakeSection();

      expect(await screen.findByText('ClickUp is not installed on this server.')).toBeInTheDocument();
      expect(screen.queryByRole('switch', { name: 'Import ClickUp tasks' })).not.toBeInTheDocument();
      expect(screen.queryByLabelText('ClickUp API token')).not.toBeInTheDocument();
      expect(screen.queryByText(/CLICKUP_API_TOKEN/)).not.toBeInTheDocument();
    });

    it('treats the HTML app shell as "not installed", as the real server answers an unmounted route', async () => {
      useClickUpHandlers();
      server.use(http.get(CLICKUP_STATUS_URL, () => HttpResponse.html('<!doctype html><html></html>')));
      renderIntakeSection();

      expect(await screen.findByText('ClickUp is not installed on this server.')).toBeInTheDocument();
    });

    it('reports a rejected token instead of showing an empty list', async () => {
      useClickUpHandlers();
      server.use(
        http.get(CLICKUP_STATUS_URL, () =>
          HttpResponse.json({ ...readyStatus, connected: false, workspaces: [], error: 'ClickUp request failed with 401.' }),
        ),
      );
      renderIntakeSection();

      expect(await screen.findByText(/ClickUp rejected the organization's token/)).toBeInTheDocument();
      expect(screen.getByText('ClickUp request failed with 401.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Add Lists' })).not.toBeInTheDocument();
    });

    it('turns import on and off', async () => {
      const { savedConfigs } = useClickUpHandlers({ config: clickUpConfig({ enabled: false, sourceIds: null }) });
      const user = userEvent.setup();
      renderIntakeSection();

      await user.click(await screen.findByRole('switch', { name: 'Import ClickUp tasks' }));

      await waitFor(() => expect(savedConfigs.at(-1)?.clickup).toEqual({ enabled: true, sourceIds: null }));
    });
  });

  describe("the organization's token", () => {
    it('lets an admin connect a token: ClickUp checks it, and the page then names the account', async () => {
      useClickUpHandlers();
      let status: object = notConnected;
      const sent: unknown[] = [];
      server.use(
        http.get(CLICKUP_STATUS_URL, () => HttpResponse.json(status)),
        http.put(CLICKUP_CONNECTION_URL, async ({ request }) => {
          sent.push(await request.json());
          status = readyStatus;
          return HttpResponse.json(readyStatus);
        }),
      );
      const user = userEvent.setup();
      renderIntakeSection();

      expect(await screen.findByText(/ClickUp is not connected for this organization yet. Paste a ClickUp personal API token/)).toBeInTheDocument();
      expect(screen.queryByRole('switch', { name: 'Import ClickUp tasks' })).not.toBeInTheDocument();
      const input = screen.getByLabelText('ClickUp API token');
      expect(input).toHaveAttribute('type', 'password');
      expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
      await user.type(input, 'pk_123');
      await user.click(screen.getByRole('button', { name: 'Connect' }));

      expect(await screen.findByText('ClickUp account: factory-bot')).toBeInTheDocument();
      expect(sent).toEqual([{ token: 'pk_123' }]);
      expect(await screen.findByText('ClickUp connected')).toBeInTheDocument();
      expect(screen.queryByLabelText('ClickUp API token')).not.toBeInTheDocument();
      expect(screen.getByRole('switch', { name: 'Import ClickUp tasks' })).toBeEnabled();
    });

    it("shows ClickUp's refusal of a token and keeps the form to try another", async () => {
      useClickUpHandlers();
      server.use(
        http.get(CLICKUP_STATUS_URL, () => HttpResponse.json(notConnected)),
        http.put(CLICKUP_CONNECTION_URL, () =>
          HttpResponse.json(
            { error: 'invalid_token', message: 'ClickUp rejected this token (401). Paste a personal API token (pk_…).' },
            { status: 422 },
          ),
        ),
      );
      const user = userEvent.setup();
      renderIntakeSection();

      await user.type(await screen.findByLabelText('ClickUp API token'), 'pk_wrong');
      await user.click(screen.getByRole('button', { name: 'Connect' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('ClickUp could not be connected');
      expect(alert).toHaveTextContent('ClickUp rejected this token (401). Paste a personal API token (pk_…).');
      expect(screen.getByLabelText('ClickUp API token')).toBeInTheDocument();
    });

    it('lets an admin replace the token', async () => {
      useClickUpHandlers();
      const sent: unknown[] = [];
      server.use(
        http.put(CLICKUP_CONNECTION_URL, async ({ request }) => {
          sent.push(await request.json());
          return HttpResponse.json({ ...readyStatus, account: { username: 'new-bot' }, workspaces: ['Beta'] });
        }),
      );
      const user = userEvent.setup();
      renderIntakeSection();

      await user.click(await screen.findByRole('button', { name: 'Replace token' }));
      await user.type(screen.getByLabelText('ClickUp API token'), 'pk_new');
      await user.click(screen.getByRole('button', { name: 'Connect' }));

      expect(await screen.findByText('ClickUp account: new-bot')).toBeInTheDocument();
      expect(sent).toEqual([{ token: 'pk_new' }]);
    });

    it('lets an admin disconnect after confirming what stops', async () => {
      useClickUpHandlers();
      let deleted = 0;
      server.use(
        http.delete(CLICKUP_CONNECTION_URL, () => {
          deleted += 1;
          return HttpResponse.json(notConnected);
        }),
      );
      const user = userEvent.setup();
      renderIntakeSection();

      await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/stops importing ClickUp tasks and answering in comments/)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));

      expect(await screen.findByText('ClickUp disconnected')).toBeInTheDocument();
      expect(deleted).toBe(1);
      expect(await screen.findByLabelText('ClickUp API token')).toBeInTheDocument();
    });

    it('shows a member the connection but no way to change it', async () => {
      useClickUpHandlers();
      server.use(http.get(CLICKUP_STATUS_URL, () => HttpResponse.json({ ...readyStatus, canManage: false })));
      renderIntakeSection();

      expect(await screen.findByText('ClickUp account: factory-bot')).toBeInTheDocument();
      expect(screen.getByText('Only an organization admin connects, replaces or disconnects the token.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Replace token' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
    });

    it('tells a member of an organization without a token to ask an admin', async () => {
      useClickUpHandlers();
      server.use(http.get(CLICKUP_STATUS_URL, () => HttpResponse.json({ ...notConnected, canManage: false })));
      renderIntakeSection();

      expect(await screen.findByText(/An organization admin can connect it/)).toBeInTheDocument();
      expect(screen.queryByLabelText('ClickUp API token')).not.toBeInTheDocument();
    });
  });

  describe('no separate list of ClickUp Lists', () => {
    it('shows only the connection and the import switch: Lists are named by intake routes', async () => {
      useClickUpHandlers();
      renderIntakeSection();

      expect(await screen.findByRole('switch', { name: 'Import ClickUp tasks' })).toBeInTheDocument();
      expect(await screen.findByText(/in the Lists that intake routes name/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Add Lists' })).not.toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Connected Lists' })).not.toBeInTheDocument();
      // Schedules are routes now: no separate rules section among the sources.
      expect(screen.queryByRole('button', { name: 'Add rule' })).not.toBeInTheDocument();
    });
  });
});
