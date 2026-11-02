/**
 * Settings → Models per harness: the harness switch on top, and below it only
 * the settings of the harness the Factory runs on. Drives the real hooks and
 * api client through MSW.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../../../e2e/ui/msw-server';
import { TEST_BASE_URL, renderWithProviders, waitForMutationsIdle } from '../../../../../../../../e2e/ui/render';
import type { FactoryProjectPayload } from '../../../../../workspaces/services/github';
import { pickModel } from '../../defaults/__tests__/default-model-test-utils';
import { ModelsSettings } from '../../ModelsSettings';

const FACTORY_URL = `${TEST_BASE_URL}/web/factory/projects/fp-1`;

/** A stateful Factory: GET reflects every PATCH; `reject` makes the next PATCH fail. */
function stubFactory(initial: Partial<FactoryProjectPayload>, { claudeCode = true, reject = false } = {}) {
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
      HttpResponse.json({ knowledge: false, mcp: false, claudeCode }),
    ),
    http.get(`${TEST_BASE_URL}/web/config/custom-providers`, () => HttpResponse.json({ providers: [] })),
    http.get(`${TEST_BASE_URL}/web/config/providers/anthropic/accounts`, () =>
      HttpResponse.json({ accounts: [] }),
    ),
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
  it('shows Mastra routing, thinking and custom providers for a Mastra Factory, no Claude Code', async () => {
    stubFactory({ harness: 'mastra' });
    renderModels();

    const control = await harnessSwitch();
    expect(within(control).getByRole('radio', { name: 'Mastra' })).toBeChecked();
    expect(
      screen.getByText('Applies to new sessions; cards already running finish on their harness.'),
    ).toBeInTheDocument();
    expect(await screen.findByText('Model routing')).toBeInTheDocument();
    expect(screen.getByText('Custom providers')).toBeInTheDocument();
    expect(screen.queryByText('Claude Code accounts')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Claude model' })).not.toBeInTheDocument();
  });

  it('shows the Claude model and Claude Code accounts for a Claude Code Factory, and no Mastra routing', async () => {
    stubFactory({ harness: 'claude-code', claudeCodeModel: 'sonnet' });
    renderModels();

    const control = await harnessSwitch();
    expect(within(control).getByRole('radio', { name: 'Claude Code' })).toBeChecked();
    expect(await screen.findByRole('combobox', { name: 'Claude model' })).toHaveTextContent('Sonnet');
    expect(screen.getByText('Claude Code accounts')).toBeInTheDocument();
    expect(screen.queryByText('Model routing')).not.toBeInTheDocument();
    expect(screen.queryByText('Custom providers')).not.toBeInTheDocument();
  });

  it('switches Mastra → Claude Code and the settings below follow', async () => {
    const { patches } = stubFactory({ harness: 'mastra' });
    const user = userEvent.setup();
    const { client } = renderModels();

    await user.click(within(await harnessSwitch()).getByRole('radio', { name: 'Claude Code' }));
    await waitForMutationsIdle(client);

    expect(patches).toEqual([{ harness: 'claude-code' }]);
    expect(await screen.findByRole('combobox', { name: 'Claude model' })).toHaveTextContent('Claude Code default');
    expect(screen.queryByText('Model routing')).not.toBeInTheDocument();
  });

  it('switches Claude Code → Mastra', async () => {
    const { patches } = stubFactory({ harness: 'claude-code' });
    const user = userEvent.setup();
    const { client } = renderModels();

    await user.click(within(await harnessSwitch()).getByRole('radio', { name: 'Mastra' }));
    await waitForMutationsIdle(client);

    expect(patches).toEqual([{ harness: 'mastra' }]);
    expect(await screen.findByText('Model routing')).toBeInTheDocument();
    expect(screen.queryByText('Claude Code accounts')).not.toBeInTheDocument();
  });

  it('puts the harness back when the server refuses the switch', async () => {
    stubFactory({ harness: 'mastra' }, { reject: true });
    const user = userEvent.setup();
    const { client } = renderModels();

    await user.click(within(await harnessSwitch()).getByRole('radio', { name: 'Claude Code' }));
    await waitForMutationsIdle(client);

    await waitFor(async () =>
      expect(within(await harnessSwitch()).getByRole('radio', { name: 'Mastra' })).toBeChecked(),
    );
    expect(screen.queryByRole('combobox', { name: 'Claude model' })).not.toBeInTheDocument();
  });

  it('saves the Claude model, and the CLI default as null', async () => {
    const { patches } = stubFactory({ harness: 'claude-code' });
    const user = userEvent.setup();
    const { client } = renderModels();

    await pickModel(user, 'Claude model', 'Opus');
    await waitForMutationsIdle(client);
    expect(await screen.findByRole('combobox', { name: 'Claude model' })).toHaveTextContent('Opus');

    await pickModel(user, 'Claude model', 'Claude Code default');
    await waitForMutationsIdle(client);

    expect(patches).toEqual([{ claudeCodeModel: 'opus' }, { claudeCodeModel: null }]);
  });

  it('cannot switch to Claude Code where the server does not run it', async () => {
    stubFactory({ harness: 'mastra' }, { claudeCode: false });
    renderModels();

    expect(within(await harnessSwitch()).getByRole('radio', { name: 'Claude Code' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(await screen.findByText('Claude Code isn’t configured on this server.')).toBeInTheDocument();
  });
});
