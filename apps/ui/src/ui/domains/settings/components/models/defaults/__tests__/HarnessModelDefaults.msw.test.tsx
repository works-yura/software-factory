/**
 * Settings → Models → Default models: one component for every harness instance the server
 * describes. Mastra, Claude Code and a third harness (the Codex stub the harness contract tests
 * register) render through the same code and write through the same route. Drives the real hooks
 * and api client through MSW.
 */
import type { ModelCatalogEntry } from '@factory/api/config';
import type { ModelSelection } from '@factory/harness/models/contracts';
import type { HarnessModelInstanceInfo } from '@factory/harness/models/facet';
import { describeHarnessModels } from '@factory/harness/models/registry';
import { codexStubModels } from '@factory/harness/models/registry.testFixtures';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../../../e2e/ui/msw-server';
import { TEST_BASE_URL, renderWithProviders, waitForMutationsIdle } from '../../../../../../../../e2e/ui/render';
import { claudeCodeTestInstance, mastraTestInstance } from '../../../../../chat/components/modelPicker/__tests__/catalogInstances';
import type { FactoryProjectPayload } from '../../../../../workspaces/services/github';
import { HarnessModelDefaultsSection } from '../HarnessModelDefaultsSection';

const FACTORY_URL = `${TEST_BASE_URL}/web/factory/projects/fp-1`;

const MASTRA_MODELS: ModelCatalogEntry[] = [
  { id: 'openai/gpt-5.5', provider: 'openai', modelName: 'gpt-5.5', hasApiKey: true } as ModelCatalogEntry,
  { id: 'anthropic/claude-opus-4-6', provider: 'anthropic', modelName: 'claude-opus-4-6', hasApiKey: true } as ModelCatalogEntry,
];

type Write = { method: string; instanceId: string; body?: unknown };

/**
 * A server whose defaults live in one map, as the store keeps them: the catalog reports them per
 * instance, PUT/DELETE change them, and `/apply` moves running sessions.
 */
async function stubServer(
  options: {
    harness?: 'mastra' | 'claude-code';
    defaults?: Record<string, ModelSelection>;
    status?: number;
    mastraNeedsSetup?: boolean;
  } = {},
) {
  const defaults: Record<string, ModelSelection> = { ...options.defaults };
  const writes: Write[] = [];
  const project = (): FactoryProjectPayload => ({
    id: 'fp-1',
    name: 'Factory',
    harness: options.harness ?? 'mastra',
    harnessModelDefaults: { ...defaults },
  });
  const codexDefaults = { current: defaults };
  const instances = async (): Promise<HarnessModelInstanceInfo[]> => [
    mastraTestInstance(options.mastraNeedsSetup ? [] : MASTRA_MODELS, null, {
      catalogDefaultModelId: 'openai/gpt-5.5',
      factoryDefault: defaults.mastra ?? null,
      appliesToRunningSessions: true,
    }),
    claudeCodeTestInstance(defaults['claude-code'] ?? null),
    // The third harness exactly as its facet describes itself: nothing in the UI knows it.
    await describeHarnessModels(codexStubModels(new Set(), codexDefaults), {
      viewer: { userId: '', orgId: '' },
      factoryProjectId: 'fp-1',
    }),
  ];
  server.use(
    http.get(FACTORY_URL, () => HttpResponse.json({ project: project() })),
    http.get(`${TEST_BASE_URL}/web/config/models`, async () =>
      HttpResponse.json({ models: MASTRA_MODELS, instances: await instances() }),
    ),
    http.put(`${FACTORY_URL}/model-defaults/:instanceId`, async ({ request, params }) => {
      const instanceId = String(params.instanceId);
      const body = (await request.json()) as { model: string; options?: ModelSelection['options'] };
      writes.push({ method: 'PUT', instanceId, body });
      if (options.status) return HttpResponse.json({ error: 'forbidden' }, { status: options.status });
      defaults[instanceId] = { instanceId, model: body.model, ...(body.options ? { options: body.options } : {}) };
      return HttpResponse.json({ project: project(), selection: defaults[instanceId] });
    }),
    http.delete(`${FACTORY_URL}/model-defaults/:instanceId`, ({ params }) => {
      const instanceId = String(params.instanceId);
      writes.push({ method: 'DELETE', instanceId });
      delete defaults[instanceId];
      return HttpResponse.json({ project: project() });
    }),
    http.post(`${FACTORY_URL}/model-defaults/:instanceId/apply`, ({ params }) => {
      const instanceId = String(params.instanceId);
      writes.push({ method: 'POST', instanceId });
      return HttpResponse.json({
        selection: defaults[instanceId],
        applied: ['thread-1'],
        skipped: [{ threadId: 'thread-2', reason: 'not-running' }],
      });
    }),
  );
  return { writes, defaults };
}

function renderSection() {
  return renderWithProviders(
    <MemoryRouter initialEntries={['/factories/fp-1/settings/models']}>
      <HarnessModelDefaultsSection factoryId="fp-1" />
    </MemoryRouter>,
  );
}

const group = async (name: string) => screen.findByRole('region', { name: new RegExp(`^${name}`) });

describe('Default models for every harness', () => {
  it('renders every instance the server describes with the same rows, the harness in use first', async () => {
    await stubServer({
      harness: 'claude-code',
      defaults: { 'claude-code': { instanceId: 'claude-code', model: 'claude-opus-4-6', options: [{ id: 'effort', value: 'max' }] } },
    });
    renderSection();

    const claude = await group('Claude Code');
    const groups = screen.getAllByRole('region').filter(region => region.hasAttribute('data-instance-id'));
    expect(groups.map(region => region.getAttribute('data-instance-id'))).toEqual(['claude-code', 'mastra', 'codex-stub']);
    expect(within(claude).getByText('In use')).toBeInTheDocument();
    expect(within(claude).getByText('Set for this Factory.')).toBeInTheDocument();
    expect(within(claude).getByRole('button', { name: /^Claude Code default model/ })).toHaveTextContent(/Opus 4\.6/);
    // The reasoning select comes from the model's `role: 'reasoning'` descriptor, whatever its id.
    expect(within(within(claude).getByRole('radiogroup', { name: 'Reasoning' })).getByRole('radio', { name: 'Max' })).toBeChecked();

    const codex = await group('Codex');
    expect(within(codex).queryByText('In use')).not.toBeInTheDocument();
    expect(within(codex).getByText('Follows the catalog default: GPT-5.3 Codex.')).toBeInTheDocument();
    expect(within(codex).getByRole('button', { name: 'Use catalog default' })).toBeDisabled();
    expect(within(within(codex).getByRole('radiogroup', { name: 'Reasoning' })).getByRole('radio', { name: 'Medium' })).toBeChecked();
    // Every other descriptor gets its control: a toggle is a switch.
    expect(within(codex).getByRole('switch', { name: 'Fast' })).not.toBeChecked();

    const mastra = await group('Mastra');
    expect(within(mastra).getByText('Follows the catalog default: gpt-5.5.')).toBeInTheDocument();
  });

  it("writes a third harness's options and model through the generic route", async () => {
    const { writes } = await stubServer();
    const user = userEvent.setup();
    const { client } = renderSection();

    const codex = await group('Codex');
    await user.click(within(within(codex).getByRole('radiogroup', { name: 'Reasoning' })).getByRole('radio', { name: 'High' }));
    await waitForMutationsIdle(client);
    await user.click(within(await group('Codex')).getByRole('switch', { name: 'Fast' }));
    await waitForMutationsIdle(client);

    expect(writes).toEqual([
      { method: 'PUT', instanceId: 'codex-stub', body: { model: 'gpt-5.3-codex', options: [{ id: 'reasoningEffort', value: 'high' }] } },
      {
        method: 'PUT',
        instanceId: 'codex-stub',
        body: {
          model: 'gpt-5.3-codex',
          options: [
            { id: 'reasoningEffort', value: 'high' },
            { id: 'fastMode', value: true },
          ],
        },
      },
    ]);
    const saved = await group('Codex');
    await waitFor(() => expect(within(saved).getByText('Set for this Factory.')).toBeInTheDocument());
    expect(within(saved).getByRole('switch', { name: 'Fast' })).toBeChecked();

    // A model without those options drops them.
    await user.click(within(saved).getByRole('button', { name: /^Codex default model/ }));
    const option = await screen.findByRole('option', { name: /GPT-5 mini/ });
    fireEvent.click(option);
    await waitForMutationsIdle(client);
    expect(writes.at(-1)).toEqual({ method: 'PUT', instanceId: 'codex-stub', body: { model: 'gpt-5-mini' } });
    await waitFor(async () => expect(within(await group('Codex')).queryByRole('radiogroup', { name: 'Reasoning' })).not.toBeInTheDocument());
  });

  it('goes back to the catalog default', async () => {
    const { writes } = await stubServer({
      defaults: { 'claude-code': { instanceId: 'claude-code', model: 'haiku' } },
    });
    const user = userEvent.setup();
    const { client } = renderSection();

    await user.click(within(await group('Claude Code')).getByRole('button', { name: 'Use catalog default' }));
    await waitForMutationsIdle(client);

    expect(writes).toEqual([{ method: 'DELETE', instanceId: 'claude-code' }]);
    await waitFor(async () =>
      expect(within(await group('Claude Code')).getByText(/^Follows the catalog default: Claude Opus 5\.5/)).toBeInTheDocument(),
    );
  });

  it('offers to switch running sessions where the harness can, and reports what it switched', async () => {
    const { writes } = await stubServer();
    const user = userEvent.setup();
    const { client } = renderSection();

    const mastra = await group('Mastra');
    await user.click(within(mastra).getByRole('button', { name: /^Mastra default model/ }));
    fireEvent.click(await screen.findByRole('option', { name: /claude-opus-4-6/ }));
    await waitForMutationsIdle(client);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Also switch running sessions to claude-opus-4-6?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Switch running sessions' }));
    await waitForMutationsIdle(client);

    expect(writes).toEqual([
      { method: 'PUT', instanceId: 'mastra', body: { model: 'anthropic/claude-opus-4-6' } },
      { method: 'POST', instanceId: 'mastra' },
    ]);
    expect(await within(await group('Mastra')).findByText(/Switched 1 session/)).toBeInTheDocument();

    // A harness whose sessions pick a new default up themselves asks nothing.
    await user.click(within(await group('Codex')).getByRole('switch', { name: 'Fast' }));
    await waitForMutationsIdle(client);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('says why a write was refused, and why a harness has nothing to pick', async () => {
    await stubServer({ status: 403, mastraNeedsSetup: true });
    const user = userEvent.setup();
    const { client } = renderSection();

    const codex = await group('Codex');
    await user.click(within(within(codex).getByRole('radiogroup', { name: 'Reasoning' })).getByRole('radio', { name: 'Low' }));
    await waitForMutationsIdle(client);
    expect(await within(await group('Codex')).findByRole('alert')).toHaveTextContent(
      'Only organization admins can change the default model',
    );

    expect(within(await group('Mastra')).getByText('Connect a model provider below to choose a default model.')).toBeInTheDocument();
  });
});
