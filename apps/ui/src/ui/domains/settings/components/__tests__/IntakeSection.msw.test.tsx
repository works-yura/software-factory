import { Toaster } from '@mastra/playground-ui/components/Toaster';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import type { IntakeConfig } from '../../../factory/services/intake';
import { IntakeSection } from '../IntakeSection';

const CONFIG_URL = `${TEST_BASE_URL}/web/intake/config`;
const BINDINGS_URL = `${TEST_BASE_URL}/web/intake/bindings`;
const LABEL_ROUTES_URL = `${TEST_BASE_URL}/web/intake/label-routes`;
const CLICKUP_STATUS_URL = `${TEST_BASE_URL}/web/clickup/status`;
const CLICKUP_LISTS_URL = `${TEST_BASE_URL}/web/clickup/lists`;
const CLICKUP_SETTINGS_URL = `${TEST_BASE_URL}/web/clickup/settings`;
const CLICKUP_STATUSES_URL = `${TEST_BASE_URL}/web/clickup/lists/L1/statuses`;
const CLICKUP_RULES_URL = `${TEST_BASE_URL}/web/clickup/lists/L1/rules`;

type Binding = { integrationId: string; sourceId: string; factoryProjectId: string | null; board: string | null };

const readyStatus = { configured: true, connected: true, workspaces: ['Acme'], intervalSeconds: 60 };
const lists = [
  { id: 'L1', name: 'Backlog', path: 'Eng / Mobile', workspaceId: 'w1' },
  { id: 'L2', name: 'Inbox', path: 'Support', workspaceId: 'w1' },
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
  settings = {},
  statuses = [
    { name: 'TO DO', type: 'open' },
    { name: 'BACKLOG', type: 'open' },
    { name: 'DEV FIXED', type: 'closed' },
  ],
}: {
  config?: IntakeConfig;
  bindings?: Binding[];
  settings?: Record<string, unknown>;
  statuses?: { name: string; type: string }[];
} = {}) {
  const savedConfigs: IntakeConfig[] = [];
  const savedBindings: Binding[] = [...bindings];
  const savedRules: unknown[] = [];
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
    http.get(LABEL_ROUTES_URL, () => HttpResponse.json({ routes: [] })),
    http.get(CLICKUP_SETTINGS_URL, () => HttpResponse.json({ lists: settings })),
    http.get(CLICKUP_STATUSES_URL, () => HttpResponse.json({ statuses })),
    http.put(CLICKUP_RULES_URL, async ({ request }) => {
      const body = await request.json();
      savedRules.push(body);
      return HttpResponse.json({ lists: { L1: body } });
    }),
  );
  return { savedConfigs, savedBindings, savedRules };
}

const routedToBug: Binding[] = [
  { integrationId: 'clickup', sourceId: 'L1', factoryProjectId: 'fp-1', board: 'bug' },
];

function renderIntakeSection() {
  return renderWithProviders(
    <>
      <IntakeSection />
      <Toaster position="bottom-right" />
    </>,
  );
}

/** Cards start folded; open the one for a List. */
async function openCard(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(await screen.findByRole('button', { name }));
}

describe('IntakeSection', () => {
  describe('given the config endpoint fails', () => {
    it('shows the unavailable notice', async () => {
      server.use(
        http.get(BINDINGS_URL, () => HttpResponse.json({ bindings: [] })),
        http.get(CONFIG_URL, () => HttpResponse.json({ error: 'nope' }, { status: 500 })),
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

  describe('the page', () => {
    it('shows only ClickUp: GitHub and GitLab have no intake settings', async () => {
      useClickUpHandlers();
      renderIntakeSection();

      expect(await screen.findByRole('switch', { name: 'Import ClickUp tasks' })).toBeInTheDocument();
      expect(screen.queryByText(/GitHub/)).not.toBeInTheDocument();
      expect(screen.queryByText(/GitLab/)).not.toBeInTheDocument();
    });
  });

  describe('ClickUp connection', () => {
    it('explains that the server has no token when the status route is missing', async () => {
      useClickUpHandlers();
      server.use(http.get(CLICKUP_STATUS_URL, () => new HttpResponse(null, { status: 404 })));
      renderIntakeSection();

      expect(await screen.findByText(/Set CLICKUP_API_TOKEN and restart it/)).toBeInTheDocument();
      expect(screen.getByRole('switch', { name: 'Import ClickUp tasks' })).toBeDisabled();
    });

    it('treats the HTML app shell as "not configured", as the real server answers an unmounted route', async () => {
      useClickUpHandlers();
      server.use(http.get(CLICKUP_STATUS_URL, () => HttpResponse.html('<!doctype html><html></html>')));
      renderIntakeSection();

      expect(await screen.findByText(/Set CLICKUP_API_TOKEN and restart it/)).toBeInTheDocument();
    });

    it('reports a rejected token instead of showing an empty list', async () => {
      useClickUpHandlers();
      server.use(
        http.get(CLICKUP_STATUS_URL, () =>
          HttpResponse.json({ ...readyStatus, connected: false, workspaces: [], error: 'ClickUp request failed with 401.' }),
        ),
      );
      renderIntakeSection();

      expect(await screen.findByText(/ClickUp rejected the configured API token/)).toBeInTheDocument();
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

  describe('connected Lists', () => {
    it('shows each connected List as a card that says where it is routed', async () => {
      useClickUpHandlers({ bindings: routedToBug });
      renderIntakeSection();

      const card = await screen.findByRole('button', { name: /Eng \/ Mobile \/ Backlog/ });
      await waitFor(() => expect(card).toHaveTextContent('Acme Web · Bug'));
      // Folded: the status table is not rendered until the card opens.
      expect(screen.queryByText('TO DO')).not.toBeInTheDocument();
    });

    it('says so when no List is connected yet', async () => {
      useClickUpHandlers({ config: clickUpConfig({ enabled: true, sourceIds: null }) });
      renderIntakeSection();

      expect(await screen.findByText(/No Lists connected yet/)).toBeInTheDocument();
    });

    it('connects a List from the picker dialog and saves it', async () => {
      const { savedConfigs } = useClickUpHandlers({ config: clickUpConfig({ enabled: true, sourceIds: null }) });
      const user = userEvent.setup();
      renderIntakeSection();

      await user.click(await screen.findByRole('button', { name: 'Add Lists' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Eng / Mobile')).toBeInTheDocument();
      await user.click(within(dialog).getByRole('checkbox', { name: 'Backlog' }));

      await waitFor(() => expect(savedConfigs.at(-1)?.clickup).toEqual({ enabled: true, sourceIds: ['L1'] }));
    });

    it('lists the chosen Lists as chips in the picker and removes one from there', async () => {
      const { savedConfigs } = useClickUpHandlers();
      const user = userEvent.setup();
      renderIntakeSection();

      await user.click(await screen.findByRole('button', { name: 'Add Lists' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(await within(dialog).findByRole('button', { name: 'Remove Backlog' }));

      await waitFor(() => expect(savedConfigs.at(-1)?.clickup).toEqual({ enabled: true, sourceIds: null }));
    });

    it('disconnects a List from its card', async () => {
      const { savedConfigs } = useClickUpHandlers({ bindings: routedToBug });
      const user = userEvent.setup();
      renderIntakeSection();

      await openCard(user, /Eng \/ Mobile \/ Backlog/);
      await user.click(await screen.findByRole('button', { name: /Disconnect Eng \/ Mobile \/ Backlog/ }));

      await waitFor(() => expect(savedConfigs.at(-1)?.clickup).toEqual({ enabled: true, sourceIds: null }));
    });
  });

  describe('routing a List', () => {
    it('routes the List to a Factory and a board', async () => {
      const { savedBindings } = useClickUpHandlers();
      const user = userEvent.setup();
      renderIntakeSection();

      await openCard(user, /Eng \/ Mobile \/ Backlog/);
      await user.click(await screen.findByRole('combobox', { name: /Factory for Eng \/ Mobile \/ Backlog/ }));
      await user.click(await screen.findByRole('option', { name: 'Acme Web' }));
      await waitFor(() => expect(savedBindings).toEqual([{ integrationId: 'clickup', sourceId: 'L1', factoryProjectId: 'fp-1', board: null }]));

      await user.click(await screen.findByRole('combobox', { name: /Board for Eng \/ Mobile \/ Backlog/ }));
      await user.click(await screen.findByRole('option', { name: 'Bug' }));
      await waitFor(() => expect(savedBindings.at(-1)).toEqual({ integrationId: 'clickup', sourceId: 'L1', factoryProjectId: 'fp-1', board: 'bug' }));
    });

    it('asks for a factory before offering status rules', async () => {
      useClickUpHandlers();
      const user = userEvent.setup();
      renderIntakeSection();

      await openCard(user, /Eng \/ Mobile \/ Backlog/);

      expect(await screen.findByText(/Choose a factory for this List above/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Typical set' })).not.toBeInTheDocument();
    });
  });

  describe('status rules', () => {
    it('maps a ClickUp status to a board column and saves the rule', async () => {
      const { savedRules } = useClickUpHandlers({ bindings: routedToBug });
      const user = userEvent.setup();
      renderIntakeSection();

      await openCard(user, /Eng \/ Mobile \/ Backlog/);
      await user.click(await screen.findByRole('combobox', { name: 'Action for status TO DO' }));
      await user.click(await screen.findByRole('option', { name: 'Into "Triage"' }));

      await waitFor(() => expect(savedRules).toEqual([{ statuses: { 'to do': { action: 'phase', phase: 'triage' } } }]));
    });

    it('fills in a typical set: open statuses to Triage, finished ones close the card', async () => {
      const { savedRules } = useClickUpHandlers({ bindings: routedToBug });
      const user = userEvent.setup();
      renderIntakeSection();

      await openCard(user, /Eng \/ Mobile \/ Backlog/);
      await user.click(await screen.findByRole('button', { name: 'Typical set' }));

      await waitFor(() =>
        expect(savedRules).toEqual([
          {
            statuses: {
              'to do': { action: 'phase', phase: 'triage' },
              backlog: { action: 'phase', phase: 'triage' },
              'dev fixed': { action: 'close' },
            },
          },
        ]),
      );
    });

    it('offers only the board’s working columns, never the terminal one', async () => {
      useClickUpHandlers({ bindings: routedToBug });
      const user = userEvent.setup();
      renderIntakeSection();

      await openCard(user, /Eng \/ Mobile \/ Backlog/);
      await user.click(await screen.findByRole('combobox', { name: 'Action for status TO DO' }));

      expect(await screen.findByRole('option', { name: 'Into "Intake"' })).toBeInTheDocument();
      expect(screen.queryByRole('option', { name: 'Into "Done"' })).not.toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Close the card' })).toBeInTheDocument();
    });

    it('tells the user when the bound board is not installed', async () => {
      useClickUpHandlers({
        bindings: [{ integrationId: 'clickup', sourceId: 'L1', factoryProjectId: 'fp-1', board: 'gone' }],
      });
      const user = userEvent.setup();
      renderIntakeSection();

      await openCard(user, /Eng \/ Mobile \/ Backlog/);

      expect(await screen.findByText(/The "gone" board is not installed/)).toBeInTheDocument();
    });
  });

  describe('a List without a board', () => {
    const routedWithoutBoard = [{ integrationId: 'clickup', sourceId: 'L1', factoryProjectId: 'fp-1', board: null }];

    it('imports nothing until a board is chosen, and offers no status rules before then', async () => {
      useClickUpHandlers({ bindings: routedWithoutBoard });
      const user = userEvent.setup();
      renderIntakeSection();

      await openCard(user, /Eng \/ Mobile \/ Backlog/);
      expect(await screen.findByText(/choose a board; its tasks are not imported without one/)).toBeInTheDocument();
      expect(screen.getByText('Choose a board above: ClickUp statuses map to its columns.')).toBeInTheDocument();
      expect(screen.queryByRole('combobox', { name: 'Action for status TO DO' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Typical set' })).not.toBeInTheDocument();
    });

    it('offers no tag routes: tags pick a board through intake routes', async () => {
      useClickUpHandlers({ bindings: routedToBug });
      const user = userEvent.setup();
      renderIntakeSection();

      await openCard(user, /Eng \/ Mobile \/ Backlog/);
      expect(await screen.findByText(/add an intake route with the condition “has tag”/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Tag routes for/ })).not.toBeInTheDocument();
    });
  });
});
