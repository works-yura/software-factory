/**
 * Settings → Models per harness: the harness switch on top, the default models of every harness,
 * and below them only what the harness the Factory runs on needs to reach its models. Drives the
 * real hooks and api client through MSW, with a fake harness the UI has never heard of (ADR-0036).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../../../e2e/ui/msw-server';
import { TEST_BASE_URL, renderWithProviders, waitForMutationsIdle } from '../../../../../../../../e2e/ui/render';
import { MASTRA_HARNESS } from '@factory/contracts/harnesses';
import type { HarnessDescriptor } from '@factory/contracts/harnesses';
import type { HarnessModelInstanceInfo } from '@factory/harness/models/facet';

import type { FactoryProjectPayload } from '../../../../../workspaces/services/github';
import { pickModel } from '../../defaults/__tests__/default-model-test-utils';
import { ModelsSettings } from '../../ModelsSettings';

const FACTORY_URL = `${TEST_BASE_URL}/web/factory/projects/fp-1`;

/**
 * A FAKE harness (Robo Agent) beside Mastra: its sessions run on connections (ADR-0036), so the page
 * must render it from the server's descriptors alone — no harness name lives in the UI.
 */
const ROBO_HARNESS: HarnessDescriptor = {
  ...MASTRA_HARNESS,
  id: 'robo',
  label: 'Robo Agent',
  icon: 'robo',
  modelScope: 'factory',
  setup: { modelProvider: false, accounts: { provider: 'robo-cloud', connector: 'robo' } },
};

const instance = (harnessId: string, displayName: string, overrides: Partial<HarnessModelInstanceInfo> = {}): HarnessModelInstanceInfo => ({
  instanceId: harnessId,
  harnessId,
  displayName,
  available: true,
  needsSetup: false,
  defaultModel: `${harnessId}-1`,
  defaultSelection: { instanceId: harnessId, model: `${harnessId}-1` },
  factoryDefaultSelection: null,
  catalogDefaultSelection: { instanceId: harnessId, model: `${harnessId}-1` },
  appliesToRunningSessions: false,
  models: [{ slug: `${harnessId}-1`, name: `${displayName} One`, isCustom: false, capabilities: null }],
  ...overrides,
});

const roboConnection = (label: string, tone: 'ok' | 'warning') => ({
  id: `robo:${label}`,
  connector: { id: 'robo', name: 'Robo Agent', icon: 'robo' },
  label,
  status: 'active',
  displayName: null,
  accountLabel: label,
  provides: [{ key: 'agent', label: 'Runs Robo Agent sessions' }],
  state: { tone, label: tone === 'ok' ? 'Connected' : 'Out of usage' },
  scope: 'organization',
  actions: {},
});

/** A stateful Factory: GET reflects every PATCH; `reject` makes the next PATCH fail. */
function stubFactory(
  initial: Partial<FactoryProjectPayload>,
  { robo = true, reject = false, roboInstalled = true }: { robo?: boolean; reject?: boolean; roboInstalled?: boolean } = {},
) {
  let project: FactoryProjectPayload = { id: 'fp-1', name: 'Mastra', ...initial };
  const patches: unknown[] = [];
  server.use(
    http.get(FACTORY_URL, () => HttpResponse.json({ project })),
    http.patch(FACTORY_URL, async ({ request }) => {
      const body = (await request.json()) as Partial<FactoryProjectPayload>;
      patches.push(body);
      if (reject) return HttpResponse.json({ error: 'invalid_project' }, { status: 400 });
      project = { ...project, ...body };
      return HttpResponse.json({ project });
    }),
    http.get(`${TEST_BASE_URL}/web/config/features`, () =>
      HttpResponse.json({ knowledge: false, mcp: false, harnesses: [MASTRA_HARNESS, ROBO_HARNESS] }),
    ),
    http.get(`${TEST_BASE_URL}/web/config/models`, () =>
      HttpResponse.json({
        models: [],
        instances: [
          instance('mastra', 'Mastra'),
          instance('robo', 'Robo Agent', {
            connector: 'robo',
            ...(robo ? {} : { available: false, needsSetup: true, reason: 'No Robo sign-in of yours.', reasonCode: 'connection_missing', models: [] }),
            ...(roboInstalled
              ? {}
              : {
                  available: false,
                  needsSetup: false,
                  reason: 'Robo Agent is not installed on this server: `robo` was not found.',
                  reasonCode: 'executable_missing',
                  models: [],
                }),
          }),
        ],
      }),
    ),
    http.get(`${TEST_BASE_URL}/web/connections`, () =>
      HttpResponse.json({
        connections: robo ? [roboConnection('main', 'ok'), roboConnection('spare', 'warning')] : [],
        failures: [],
        copy: { organizationWide: 'Whole organization' },
      }),
    ),
    http.get(`${TEST_BASE_URL}/web/config/custom-providers`, () => HttpResponse.json({ providers: [] })),
  );
  return { patches };
}

function renderModels() {
  return renderWithProviders(
    <MemoryRouter initialEntries={['/factories/fp-1/settings/models']}>
      <ModelsSettings factoryId="fp-1" />
    </MemoryRouter>,
  );
}

const harnessSwitch = () => screen.findByRole('radiogroup', { name: 'Agents run on' });

describe('Models settings per harness', () => {
  it('offers the harnesses the server describes, and Mastra providers for a Mastra Factory', async () => {
    stubFactory({ harness: 'mastra' });
    renderModels();

    const control = await harnessSwitch();
    expect(within(control).getByRole('radio', { name: 'Mastra' })).toBeChecked();
    expect(await within(control).findByRole('radio', { name: 'Robo Agent' })).not.toHaveAttribute('aria-disabled', 'true');
    expect(await screen.findByText('Providers')).toBeInTheDocument();
    expect(screen.getByText('Default model')).toBeInTheDocument();
    expect(screen.queryByText('Robo Agent accounts')).not.toBeInTheDocument();
  });

  it("shows a connection harness's accounts as a link to its connector, and no Mastra providers", async () => {
    stubFactory({ harness: 'robo' });
    renderModels();

    expect(within(await harnessSwitch()).getByRole('radio', { name: 'Robo Agent' })).toBeChecked();
    expect(await screen.findByText('Robo Agent accounts')).toBeInTheDocument();
    expect(await screen.findByText('2 accounts, 1 running now')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Manage in Connections' })).toHaveAttribute(
      'href',
      '/factories/fp-1/settings/integrations?connection=robo',
    );
    expect(screen.queryByText('Providers')).not.toBeInTheDocument();
  });

  it('switches Mastra → the other harness and back; the settings below follow', async () => {
    const { patches } = stubFactory({ harness: 'mastra' });
    const user = userEvent.setup();
    const { client } = renderModels();

    await user.click(await within(await harnessSwitch()).findByRole('radio', { name: 'Robo Agent' }));
    await waitForMutationsIdle(client);
    expect(await screen.findByText('Robo Agent accounts')).toBeInTheDocument();
    expect(screen.queryByText('Providers')).not.toBeInTheDocument();

    await user.click(within(await harnessSwitch()).getByRole('radio', { name: 'Mastra' }));
    await waitForMutationsIdle(client);
    expect(patches).toEqual([{ harness: 'robo' }, { harness: 'mastra' }]);
    expect(await screen.findByText('Providers')).toBeInTheDocument();
  });

  it('puts the harness back when the server refuses the switch', async () => {
    stubFactory({ harness: 'mastra' }, { reject: true });
    const user = userEvent.setup();
    const { client } = renderModels();

    await user.click(await within(await harnessSwitch()).findByRole('radio', { name: 'Robo Agent' }));
    await waitForMutationsIdle(client);

    await waitFor(async () => expect(within(await harnessSwitch()).getByRole('radio', { name: 'Mastra' })).toBeChecked());
    expect(screen.queryByText('Robo Agent accounts')).not.toBeInTheDocument();
  });

  it('does not offer a harness without a connection of yours, and links to connect one', async () => {
    stubFactory({ harness: 'mastra' }, { robo: false });
    renderModels();

    const control = await harnessSwitch();
    expect(await screen.findByText(/Robo Agent isn’t offered/)).toBeInTheDocument();
    expect(within(control).queryByRole('radio', { name: 'Robo Agent' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect Robo Agent' })).toHaveAttribute(
      'href',
      '/factories/fp-1/settings/integrations?add=1&step=connector%3Arobo',
    );
  });

  it('does not offer a harness whose CLI is not installed on the server, and says so without a connect link', async () => {
    stubFactory({ harness: 'mastra' }, { roboInstalled: false });
    renderModels();

    const control = await harnessSwitch();
    expect(await screen.findByText('Robo Agent isn’t offered: Robo Agent isn’t installed on this server.')).toBeInTheDocument();
    expect(within(control).queryByRole('radio', { name: 'Robo Agent' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Connect Robo Agent' })).not.toBeInTheDocument();
  });

  it("keeps a Factory's own harness readable when its connection is gone, but not pickable", async () => {
    stubFactory({ harness: 'robo' }, { robo: false });
    renderModels();

    const robo = within(await harnessSwitch()).getByRole('radio', { name: 'Robo Agent' });
    expect(robo).toBeChecked();
    expect(robo).toHaveAttribute('aria-disabled', 'true');
    // The hint under the switch and the accounts section both send the person to connect one.
    const links = await screen.findAllByRole('link', { name: 'Connect Robo Agent' });
    expect(links.map(link => link.getAttribute('href'))).toEqual([
      '/factories/fp-1/settings/integrations?add=1&step=connector%3Arobo',
      '/factories/fp-1/settings/integrations?add=1&step=connector%3Arobo',
    ]);
  });
});

describe('Agent language', () => {
  it('shows the Factory’s agent language on either harness and saves a change', async () => {
    const { patches } = stubFactory({ harness: 'robo', agentLanguage: 'uk' });
    const user = userEvent.setup();
    const { client } = renderModels();

    expect(await screen.findByText('Agent language')).toBeInTheDocument();
    expect(await screen.findByRole('combobox', { name: 'Language' })).toHaveTextContent('Українська');

    await pickModel(user, 'Language', 'English');
    await waitForMutationsIdle(client);

    expect(await screen.findByRole('combobox', { name: 'Language' })).toHaveTextContent('English');
    expect(patches).toEqual([{ agentLanguage: 'en' }]);
  });

  it('puts the language back when the server refuses it', async () => {
    stubFactory({ harness: 'mastra', agentLanguage: 'uk' }, { reject: true });
    const user = userEvent.setup();
    const { client } = renderModels();

    await pickModel(user, 'Language', 'English');
    await waitForMutationsIdle(client);

    await waitFor(async () =>
      expect(await screen.findByRole('combobox', { name: 'Language' })).toHaveTextContent('Українська'),
    );
  });
});
