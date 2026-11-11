import { CLAUDE_CODE_HARNESS } from '@factory/contracts/harnesses';
import { claudeCodeTestInstance, mastraTestInstance } from '../../modelPicker/__tests__/catalogInstances';
import type { HarnessDescriptor } from '@factory/contracts/harnesses';
import { Toaster } from '@mastra/playground-ui/components/Toaster';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { server } from '../../../../../../../e2e/ui/msw-server';
import { TEST_BASE_URL, renderWithProviders, waitForMutationsIdle } from '../../../../../../../e2e/ui/render';
import type { AvailableModelOption } from '../../../../../../hooks/useAvailableModels';
import { ChatConnectionContext } from '../../../context/ChatConnectionContext';
import { ChatModelsProvider } from '../../../context/ChatModelsProvider';
import { ChatSessionContext } from '../../../context/ChatSessionContext';
import type { ChatSessionContextApi } from '../../../context/ChatSessionContext';
import { ChatThinkingProvider } from '../../../context/ChatThinkingProvider';
import { AGENT_CONTROLLER_ID } from '../../../services/constants';
import { ChangeModelAction, ModelPicker } from '../ModelPicker';

if (typeof globalThis.Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const API = `${TEST_BASE_URL}/api/agent-controller/${AGENT_CONTROLLER_ID}`;
const models: AvailableModelOption[] = [
  {
    id: 'anthropic/claude-sonnet-4-6',
    provider: 'anthropic',
    modelName: 'claude-sonnet-4-6',
    hasApiKey: true,
    reasoningOptions: [
      { type: 'effort', values: ['low', 'medium', 'high', 'max'] },
      { type: 'budget_tokens', min: 1024 },
    ],
  },
  {
    id: 'openai/gpt-5',
    provider: 'openai',
    modelName: 'gpt-5',
    hasApiKey: true,
    reasoningOptions: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high'] }],
  },
];


const baseSession: ChatSessionContextApi = {
  sessionId: 'session-1',
  resourceId: 'user-1',
  sessionEnabled: true,
  resourceReady: true,
  sandboxReady: true,
  sandboxPreparing: false,
  resourceEnabled: true,
  baseUrl: TEST_BASE_URL,
  kind: 'user',
};

function renderPicker({
  kind = 'user',
  modelId = 'openai/gpt-5',
  defaultModelId = 'anthropic/claude-sonnet-4-6',
  thinkingLevel,
  settingsLoaded,
  catalogLoaded,
  modelSwitched,
  thinkingDefaultsFail = false,
  inFactory = false,
  modelScope,
  factoryDefaultModelId,
  emptyCatalog = false,
  catalogFails = false,
  sessionPolicy,
  withChangeModelAction = false,
  harness,
  claudeCodeCatalog = false,
  claudeCode,
  modelSelection,
  acceptsHandoff,
  switchResponse = { ok: true },
}: {
  kind?: ChatSessionContextApi['kind'];
  modelId?: string;
  defaultModelId?: string | null;
  thinkingLevel?: string;
  settingsLoaded?: Promise<void>;
  catalogLoaded?: Promise<void>;
  modelSwitched?: Promise<void>;
  thinkingDefaultsFail?: boolean;
  /** Mount on a Factory route, so the Factory's thinking level applies. */
  inFactory?: boolean;
  /** Mount on an authenticated Factory route, whose organization credentials serve the catalog. */
  modelScope?: 'factory';
  factoryDefaultModelId?: string;
  sessionPolicy?: { defaultModelId: string | null };
  /** The Factory's organization has no credentials, so its catalog is empty. */
  emptyCatalog?: boolean;
  /** The session catalog request fails. */
  catalogFails?: boolean;
  withChangeModelAction?: boolean;
  /** The harness the chat context reports; absent leaves it unknown, as older contexts do. */
  harness?: HarnessDescriptor;
  /** The server runs Claude Code: the catalog lists its models too. */
  claudeCodeCatalog?: boolean;
  /** The chat runs on Claude Code (the Factory's Claude model). */
  claudeCode?: ChatSessionContextApi['claudeCode'];
  /** A Claude Code session's selection, as its state reports it. */
  modelSelection?: unknown;
  /** The Claude Code instance accepts a session from another harness (a context handoff). */
  acceptsHandoff?: boolean;
  /** What `POST …/model` answers. */
  switchResponse?: Record<string, unknown>;
} = {}) {
  const modelSwitches: unknown[] = [];
  const stateUpdates: unknown[] = [];
  server.use(
    http.get(`${TEST_BASE_URL}/web/config/models`, async ({ request }) => {
      await catalogLoaded;
      if (!modelScope) {
        // The Factory's Claude Code default is the Claude model the chat context names.
        const claudeDefault = claudeCode?.model ? { instanceId: 'claude-code', model: claudeCode.model } : null;
        const instances = [
          mastraTestInstance(models as never, defaultModelId ?? null),
          ...(claudeCodeCatalog
            ? [{ ...claudeCodeTestInstance(claudeDefault), ...(acceptsHandoff !== undefined ? { acceptsHandoff } : {}) }]
            : []),
        ];
        return HttpResponse.json({ models, defaultModelId, instances });
      }
      const params = new URL(request.url).searchParams;
      if (params.has('resourceId')) {
        if (catalogFails) {
          return HttpResponse.json({ error: 'session_model_policy_unavailable' }, { status: 503 });
        }
        expect(params.get('sessionId')).toBe('session-1');
        expect(params.get('resourceId')).toBe('user-1');
        expect(params.get('threadId')).toBe('session-1');
        return HttpResponse.json({
          defaultModelId: sessionPolicy ? sessionPolicy.defaultModelId : (factoryDefaultModelId ?? null),
          models: emptyCatalog ? [] : models.filter(model => model.provider === 'openai'),
        });
      }
      if (emptyCatalog) return HttpResponse.json({ models: [] });
      // Settings requests stay independent of the session owner's catalog.
      const factoryId = params.get('factoryId');
      return HttpResponse.json({
        models: models.filter(model => (factoryId === 'fp-1') === (model.provider === 'openai')),
      });
    }),
    http.get(`${TEST_BASE_URL}/web/factory/projects/fp-1`, () =>
      thinkingDefaultsFail
        ? HttpResponse.json({ error: 'unavailable' }, { status: 500 })
        : HttpResponse.json({ project: { id: 'fp-1', name: 'Mastra', defaultThinkingLevel: 'medium' } }),
    ),
    http.get(`${API}/sessions/:resourceId`, async ({ params }) => {
      await settingsLoaded;
      return HttpResponse.json({
        controllerId: AGENT_CONTROLLER_ID,
        resourceId: params.resourceId,
        modeId: 'build',
        modelId,
        settings: { yolo: false, thinkingLevel, notifications: 'off', smartEditing: true },
      });
    }),
    http.put(`${API}/sessions/:resourceId/state`, async ({ request }) => {
      const body: unknown = await request.json();
      if (typeof body === 'object' && body !== null && 'state' in body) {
        stateUpdates.push(body.state);
        const state: unknown = body.state;
        if (typeof state === 'object' && state !== null && 'thinkingLevel' in state) {
          thinkingLevel = typeof state.thinkingLevel === 'string' ? state.thinkingLevel : undefined;
        }
      }
      return HttpResponse.json({ ok: true });
    }),
    http.post(`${API}/sessions/:resourceId/model`, async ({ request }) => {
      modelSwitches.push(await request.json());
      await modelSwitched;
      return HttpResponse.json(switchResponse);
    }),
  );
  if (modelScope) {
    window.__MASTRACODE_CONFIG__ = { authEnabled: true };
    server.use(
      http.get(`${TEST_BASE_URL}/auth/me`, () =>
        HttpResponse.json({ authenticated: true, user: { id: 'user-1', organizationId: 'org-1' } }),
      ),
      http.get(`${TEST_BASE_URL}/web/factory/projects/fp-1`, () =>
        HttpResponse.json({
          project: {
            id: 'fp-1',
            name: 'Mastra',
            defaultModelId: factoryDefaultModelId,
            defaultThinkingLevel: 'medium',
          },
        }),
      ),
    );
  }

  const picker = (
    <ChatSessionContext.Provider value={{ ...baseSession, kind, harness, claudeCode }}>
      <ChatConnectionContext.Provider
        value={{
          status: 'ready',
          state: {
            controllerId: AGENT_CONTROLLER_ID,
            sessionId: 'session-1',
            resourceId: 'user-1',
            modeId: 'build',
            modelId,
            ...(modelSelection ? { modelSelection } : {}),
          } as never,
        }}
      >
        <ChatModelsProvider>
          <ChatThinkingProvider>
            <ModelPicker />
            {withChangeModelAction ? <ChangeModelAction /> : null}
            <Toaster position="bottom-right" />
          </ChatThinkingProvider>
        </ChatModelsProvider>
      </ChatConnectionContext.Provider>
    </ChatSessionContext.Provider>
  );
  const rendered = renderWithProviders(
    modelScope || inFactory ? (
      <MemoryRouter initialEntries={['/factories/fp-1/work']}>
        <Routes>
          <Route path="/factories/:factoryId/*" element={picker} />
        </Routes>
      </MemoryRouter>
    ) : (
      <MemoryRouter>{picker}</MemoryRouter>
    ),
  );
  return { ...rendered, modelSwitches, stateUpdates };
}

afterEach(() => {
  delete window.__MASTRACODE_CONFIG__;
  localStorage.clear();
  server.events.removeAllListeners('response:mocked');
});

describe('ModelPicker', () => {
  it("follows a harness whose model is the Factory's: the Factory chat shows it and offers no switch", async () => {
    const { modelSwitches } = renderPicker({
      kind: 'factory',
      inFactory: true,
      harness: CLAUDE_CODE_HARNESS,
      withChangeModelAction: true,
    });

    expect(await screen.findByRole('link', { name: /^Claude Code · / })).toHaveAttribute(
      'href',
      '/factories/fp-1/settings/models',
    );
    expect(screen.queryByLabelText('Session model')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change model' })).not.toBeInTheDocument();
    expect(modelSwitches).toEqual([]);
  });

  it('keeps a personal-route session on the server-resolved Factory catalog and default', async () => {
    const user = userEvent.setup();
    renderPicker({
      modelScope: 'factory',
      kind: 'user',
      sessionPolicy: { defaultModelId: 'openai/gpt-5' },
    });

    await user.click(await screen.findByLabelText('Session model'));
    const factoryOption = await screen.findByRole('option', { name: /gpt-5/ });
    expect(within(factoryOption).getByText('Default')).toBeVisible();
    expect(screen.queryByRole('option', { name: /claude-sonnet-4-6/ })).not.toBeInTheDocument();
  });

  it.each(['factory'] as const)(
    'marks the Factory default in a %s work-item session',
    async modelScope => {
      const user = userEvent.setup();
      renderPicker({ kind: 'factory', modelScope, factoryDefaultModelId: 'openai/gpt-5' });

      await user.click(await screen.findByLabelText('Session model'));
      const option = await screen.findByRole('option', { name: /gpt-5/ });
      expect(within(option).getByText('Default')).toBeVisible();
      expect(screen.queryByRole('option', { name: /Reset to your default/ })).not.toBeInTheDocument();
    },
  );

  it("lists only the models the Factory's organization credentials can run", async () => {
    const user = userEvent.setup();
    renderPicker({ modelScope: 'factory' });

    await user.click(await screen.findByLabelText('Session model'));

    expect(screen.getByRole('option', { name: /gpt-5/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /claude-sonnet-4-6/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('points an organization-scoped Factory with no usable models at its credential settings', async () => {
    renderPicker({ modelScope: 'factory', emptyCatalog: true });

    expect(await screen.findByRole('link', { name: 'needs an organization credential' })).toHaveAttribute(
      'href',
      '/factories/fp-1/settings/models',
    );
    expect(screen.queryByLabelText('Session model')).not.toBeInTheDocument();
  });

  it('reports a failed session catalog instead of staying locked as loading', async () => {
    renderPicker({ modelScope: 'factory', kind: 'user', catalogFails: true });

    const unavailable = await screen.findByLabelText('GPT-5 · model list unavailable');
    expect(unavailable).toHaveTextContent('GPT-5 · model list unavailable');
    expect(screen.queryByRole('button', { name: /^Session model/ })).not.toBeInTheDocument();
  });

  it("lists each provider's models under the Mastra instance and marks the default", async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(await screen.findByRole('button', { name: /^Session model/ }));

    expect(screen.getByRole('button', { name: 'Mastra', pressed: true })).toBeInTheDocument();
    const defaultOption = screen.getByRole('option', { name: /claude-sonnet-4-6/i });
    expect(within(defaultOption).getByText('Anthropic')).toBeInTheDocument();
    expect(within(defaultOption).getByText('Default')).toBeInTheDocument();
    expect(within(screen.getByRole('option', { name: /gpt-5/i })).getByText('OpenAI')).toBeInTheDocument();
  });

  it('offers no reset to a personal default', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(await screen.findByRole('button', { name: /^Session model/ }));

    expect(screen.getByRole('option', { name: /gpt-5/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Reset to your default' })).not.toBeInTheDocument();
  });

  it('keeps the saved thinking choice when switching to a model that cannot run it', async () => {
    const user = userEvent.setup();
    const { client, modelSwitches, stateUpdates } = renderPicker({
      modelId: 'anthropic/claude-sonnet-4-6',
      thinkingLevel: 'max',
    });

    await user.click(await screen.findByRole('button', { name: 'Session model, Max' }));
    await user.click(screen.getByRole('option', { name: /gpt-5/i }));
    await waitForMutationsIdle(client);

    expect(modelSwitches).toEqual([{ modelId: 'openai/gpt-5' }]);
    expect(stateUpdates).toEqual([]);
  });

  it('shows the level the model runs when the saved choice is above what it supports', async () => {
    renderPicker({ modelId: 'openai/gpt-5', thinkingLevel: 'max' });

    expect(await screen.findByRole('button', { name: 'Session model, High' })).toBeEnabled();
  });

  it('given no session level, when the session picks one, then it leaves the Factory default and saves it', async () => {
    const user = userEvent.setup();
    // The session runs the Factory's default model, so only its level can be its own.
    const { client, stateUpdates } = renderPicker({ inFactory: true, defaultModelId: 'openai/gpt-5' });

    await user.click(await screen.findByRole('button', { name: 'Session model, Medium' }));
    expect(screen.getByText('Follows the Factory default.')).toBeInTheDocument();
    const levels = screen.getByRole('radiogroup', { name: 'Thinking' });
    expect(within(levels).queryByRole('radio', { name: 'Max' })).not.toBeInTheDocument();
    expect(within(levels).getByRole('radio', { name: 'Medium' })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(levels).getByRole('radio', { name: 'High' }));
    await waitForMutationsIdle(client);

    expect(stateUpdates).toEqual([{ thinkingLevel: 'high' }]);
    expect(await screen.findByRole('button', { name: 'Session model, High' })).toBeInTheDocument();
    expect(screen.getByText('Set for this session.')).toBeInTheDocument();
  });

  it('given a session level, when Use default is chosen, then the session follows the Factory default', async () => {
    const user = userEvent.setup();
    const { client, stateUpdates, modelSwitches } = renderPicker({
      thinkingLevel: 'high',
      inFactory: true,
      defaultModelId: 'openai/gpt-5',
    });

    await user.click(await screen.findByRole('button', { name: 'Session model, High' }));
    await user.click(screen.getByRole('button', { name: 'Use default' }));
    await waitForMutationsIdle(client);

    expect(stateUpdates).toEqual([{ thinkingLevel: null }]);
    expect(modelSwitches).toEqual([]);
    expect(await screen.findByRole('button', { name: 'Session model, Medium' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use default' })).not.toBeInTheDocument();
  });

  it('given a session model other than the Factory default, Use default moves it back onto that model', async () => {
    const user = userEvent.setup();
    const { client, stateUpdates, modelSwitches } = renderPicker({
      inFactory: true,
      modelId: 'openai/gpt-5',
      defaultModelId: 'anthropic/claude-sonnet-4-6',
    });

    await user.click(await screen.findByRole('button', { name: 'Session model, Medium' }));
    expect(screen.getByText('Set for this session.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use default' }));
    await waitForMutationsIdle(client);

    expect(modelSwitches).toEqual([{ modelId: 'anthropic/claude-sonnet-4-6' }]);
    expect(stateUpdates).toEqual([]);
  });

  it('says the thinking level failed to load instead of loading forever', async () => {
    const user = userEvent.setup();
    renderPicker({ thinkingDefaultsFail: true, inFactory: true });

    await user.click(await screen.findByRole('button', { name: 'Session model' }, { timeout: 10_000 }));
    expect(
      await screen.findByText("The thinking level couldn't be loaded.", undefined, { timeout: 10_000 }),
    ).toBeInTheDocument();
  });

  it("keeps the session's own level usable when the defaults fail to load", async () => {
    renderPicker({ thinkingLevel: 'high', thinkingDefaultsFail: true, inFactory: true });

    expect(await screen.findByRole('button', { name: 'Session model, High' })).toBeEnabled();
  });

  it('holds the effort, not the Factory default, until the session level loads', async () => {
    let loadSettings = () => {};
    const settingsLoaded = new Promise<void>(resolve => {
      loadSettings = resolve;
    });
    const user = userEvent.setup();
    renderPicker({ thinkingLevel: 'high', settingsLoaded });

    await user.click(await screen.findByRole('button', { name: 'Session model' }));
    expect(screen.getByText("The thinking level isn't loaded yet.")).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Thinking' })).not.toBeInTheDocument();

    loadSettings();
    expect(await screen.findByRole('button', { name: 'Session model, High' })).toBeEnabled();
  });

  it("holds the effort until the model's levels load, then shows the level it runs", async () => {
    let loadCatalog = () => {};
    const catalogLoaded = new Promise<void>(resolve => {
      loadCatalog = resolve;
    });
    const user = userEvent.setup();
    renderPicker({ modelId: 'openai/gpt-5', thinkingLevel: 'max', catalogLoaded });

    await user.click(await screen.findByRole('button', { name: 'Session model' }));
    expect(screen.getByText("This model's thinking levels aren't loaded yet.")).toBeInTheDocument();

    loadCatalog();
    expect(await screen.findByRole('button', { name: 'Session model, High' })).toBeEnabled();
  });

  it('locks the picker and its effort while a model switch is in flight', async () => {
    let finishSwitch = () => {};
    const modelSwitched = new Promise<void>(resolve => {
      finishSwitch = resolve;
    });
    const user = userEvent.setup();
    const { client } = renderPicker({ modelId: 'anthropic/claude-sonnet-4-6', thinkingLevel: 'high', modelSwitched });

    await user.click(await screen.findByRole('button', { name: 'Session model, High' }));
    await user.click(screen.getByRole('option', { name: /gpt-5/i }));

    expect(await screen.findByText('Switching model…')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Session model/ })).toBeDisabled());

    finishSwitch();
    await waitForMutationsIdle(client);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Session model, High' })).toBeEnabled());
  });

  it('locks the status-line picker while the error card switches the model', async () => {
    let finishSwitch = () => {};
    const modelSwitched = new Promise<void>(resolve => {
      finishSwitch = resolve;
    });
    const user = userEvent.setup();
    const { client } = renderPicker({
      modelId: 'anthropic/claude-sonnet-4-6',
      thinkingLevel: 'high',
      modelSwitched,
      withChangeModelAction: true,
    });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Change model' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Change model' }));
    await user.click(screen.getByRole('option', { name: /gpt-5/i }));

    const sessionModel = await screen.findByRole('button', { name: 'Session model' });
    await waitFor(() => expect(sessionModel).toBeDisabled());
    expect(sessionModel).toHaveTextContent(/gpt-5/i);

    finishSwitch();
    await waitForMutationsIdle(client);
    await waitFor(() => expect(screen.getByRole('button', { name: /^Session model/ })).toBeEnabled());
  });

  it('keeps favorites in this browser and lists them in their own tab', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(await screen.findByRole('button', { name: /^Session model/ }));
    const option = screen.getByRole('option', { name: /gpt-5/i });
    await user.click(within(option).getByRole('button', { name: 'Add to favorites' }));
    expect(JSON.parse(localStorage.getItem('mastracode.modelPicker.favorites') ?? '[]')).toEqual([
      { provider: 'mastra', model: 'openai/gpt-5' },
    ]);

    await user.click(screen.getByRole('button', { name: 'Favorites' }));
    expect(screen.getByRole('option', { name: /gpt-5/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /claude-sonnet-4-6/i })).not.toBeInTheDocument();
  });

  it('ranks a search across every instance, without the rail', async () => {
    const user = userEvent.setup();
    renderPicker({ claudeCodeCatalog: true });

    await user.click(await screen.findByRole('button', { name: /^Session model/ }));
    await user.keyboard('sonnet');

    expect(screen.queryByRole('toolbar', { name: 'Providers' })).not.toBeInTheDocument();
    const names = screen.getAllByRole('option').map(option => option.textContent ?? '');
    expect(names.some(name => /claude-sonnet-4-6/.test(name))).toBe(true);
    expect(names.some(name => /Sonnet 5\.5/.test(name))).toBe(true);
    expect(names.some(name => /gpt-5/.test(name))).toBe(false);
  });

  it("blocks a pick on another harness: the chat can't switch providers after it starts", async () => {
    const user = userEvent.setup();
    const { modelSwitches } = renderPicker({ claudeCodeCatalog: true });

    await user.click(await screen.findByRole('button', { name: /^Session model/ }));
    await user.click(screen.getByRole('button', { name: 'Claude Code' }));
    await user.click(await screen.findByRole('option', { name: /Sonnet 5\.5/ }));

    expect(await screen.findByText('Start a new chat to switch providers')).toBeInTheDocument();
    expect(modelSwitches).toEqual([]);
  });

  it('still blocks a pick on another harness whose instance accepts no handoff', async () => {
    const user = userEvent.setup();
    const { modelSwitches } = renderPicker({ claudeCodeCatalog: true, acceptsHandoff: false });

    await user.click(await screen.findByRole('button', { name: /^Session model/ }));
    await user.click(screen.getByRole('button', { name: 'Claude Code' }));
    await user.click(await screen.findByRole('option', { name: /Sonnet 5\.5/ }));

    expect(await screen.findByText('Start a new chat to switch providers')).toBeInTheDocument();
    expect(modelSwitches).toEqual([]);
  });

  it('moves the session to another harness that accepts a handoff, with the pick and its instance', async () => {
    const user = userEvent.setup();
    const { client, modelSwitches } = renderPicker({
      claudeCodeCatalog: true,
      acceptsHandoff: true,
      switchResponse: {
        ok: true,
        modelSelection: { instanceId: 'claude-code', model: 'claude-sonnet-5-5' },
        appliesFrom: 'next-turn',
        handoff: { id: 'h1', fromInstanceId: 'mastra', toInstanceId: 'claude-code', harnessId: 'claude-code' },
      },
    });

    await user.click(await screen.findByRole('button', { name: /^Session model/ }));
    await user.click(screen.getByRole('button', { name: 'Claude Code' }));
    await user.click(await screen.findByRole('option', { name: /Sonnet 5\.5/ }));
    await waitForMutationsIdle(client);

    expect(modelSwitches).toEqual([{ modelId: 'claude-sonnet-5-5', options: [], instanceId: 'claude-code' }]);
    expect(screen.queryByText('Start a new chat to switch providers')).not.toBeInTheDocument();
    expect(await screen.findByText('This chat moves to Claude Code')).toBeInTheDocument();
  });

  it('moves between the rail, the list and the effort column with the arrow keys', async () => {
    const user = userEvent.setup();
    renderPicker({ modelId: 'openai/gpt-5', thinkingLevel: 'low' });

    await user.click(await screen.findByRole('button', { name: /^Session model/ }));
    const search = screen.getByPlaceholderText('Search models…');
    await waitFor(() => expect(search).toHaveFocus());
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('button', { name: 'Mastra' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(search).toHaveFocus();
    // The first row (the default model) is highlighted: Right picks it, then lands on its levels.
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{ArrowRight}');
    await waitFor(() =>
      expect(within(screen.getByRole('radiogroup', { name: 'Thinking' })).getByRole('radio', { checked: true })).toHaveFocus(),
    );
    await user.keyboard('{ArrowLeft}');
    expect(search).toHaveFocus();
  });

  it('opens with mod+shift+m and goes to the effort with mod+shift+e', async () => {
    const user = userEvent.setup();
    renderPicker({ thinkingLevel: 'high' });

    await screen.findByRole('button', { name: 'Session model, High' });
    await user.keyboard('{Control>}{Shift>}m{/Shift}{/Control}');
    expect(await screen.findByPlaceholderText('Search models…')).toBeInTheDocument();
    await user.keyboard('{Control>}{Shift>}e{/Shift}{/Control}');
    await waitFor(() =>
      expect(within(screen.getByRole('radiogroup', { name: 'Thinking' })).getByRole('radio', { name: 'High' })).toHaveFocus(),
    );
    await user.keyboard('{Control>}{Shift>}m{/Shift}{/Control}');
    await waitFor(() => expect(screen.queryByPlaceholderText('Search models…')).not.toBeInTheDocument());
  });

  describe('in a Claude Code session', () => {
    const claudeSession = {
      kind: 'user' as const,
      inFactory: true,
      harness: CLAUDE_CODE_HARNESS,
      claudeCode: { model: 'opus' as const },
      claudeCodeCatalog: true,
      modelSelection: { instanceId: 'claude-code', model: 'opus', options: [{ id: 'effort', value: 'medium' }] },
    };

    it("offers the Claude catalog's models and efforts, following the Factory's until it picks", async () => {
      const user = userEvent.setup();
      renderPicker(claudeSession);

      const trigger = await screen.findByRole('button', { name: 'Session model, Medium' });
      expect(trigger).toHaveTextContent('Opus 5.5');
      await user.click(trigger);
      expect(screen.getByRole('button', { name: 'Claude Code', pressed: true })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /Sonnet 5\.5/ })).toBeInTheDocument();
      const levels = screen.getByRole('radiogroup', { name: 'Reasoning' });
      // Medium is this model's default, which its row names too.
      expect(within(levels).getByRole('radio', { name: /^Medium/ })).toHaveAttribute('aria-checked', 'true');
      // Ultrathink is a prompt keyword, not a level to pick.
      expect(within(levels).queryByRole('radio', { name: 'Ultrathink' })).not.toBeInTheDocument();
      expect(screen.getByRole('radiogroup', { name: 'Fast Mode' })).toBeInTheDocument();
      expect(screen.getByText('Follows the Factory default.')).toBeInTheDocument();
    });

    it("sends an effort with the session's model, and a model pick with its remembered options", async () => {
      const user = userEvent.setup();
      const { client, modelSwitches } = renderPicker(claudeSession);

      await user.click(await screen.findByRole('button', { name: 'Session model, Medium' }));
      await user.click(within(screen.getByRole('radiogroup', { name: 'Reasoning' })).getByRole('radio', { name: 'High' }));
      await waitForMutationsIdle(client);
      expect(modelSwitches).toHaveLength(1);
      expect(modelSwitches[0]).toMatchObject({ modelId: 'opus' });
      expect((modelSwitches[0] as { options: unknown[] }).options).toContainEqual({ id: 'effort', value: 'high' });

      await user.click(screen.getByRole('option', { name: /Sonnet 5\.5/ }));
      await waitForMutationsIdle(client);
      expect(modelSwitches[1]).toEqual({ modelId: 'claude-sonnet-5-5', options: [], instanceId: 'claude-code' });
    });

    it('sends a Mastra pick through the model route with its instance, to move the session back', async () => {
      const user = userEvent.setup();
      const { client, modelSwitches } = renderPicker({ ...claudeSession, acceptsHandoff: false, modelId: 'openai/gpt-5' });
      // Only the target's acceptsHandoff matters: Mastra's instance accepts the move here.
      server.use(
        http.get(`${TEST_BASE_URL}/web/config/models`, () =>
          HttpResponse.json({
            models,
            defaultModelId: 'anthropic/claude-sonnet-4-6',
            instances: [
              { ...mastraTestInstance(models as never, 'anthropic/claude-sonnet-4-6'), acceptsHandoff: true },
              claudeCodeTestInstance({ instanceId: 'claude-code', model: 'opus' }),
            ],
          }),
        ),
      );

      await user.click(await screen.findByRole('button', { name: 'Session model, Medium' }));
      await user.click(screen.getByRole('button', { name: 'Mastra' }));
      await user.click(await screen.findByRole('option', { name: /gpt-5/ }));
      await waitForMutationsIdle(client);

      expect(modelSwitches).toEqual([expect.objectContaining({ modelId: 'openai/gpt-5', instanceId: 'mastra' })]);
      expect(screen.queryByText('Start a new chat to switch providers')).not.toBeInTheDocument();
    });

    it("goes back to the Factory's model and effort with Use default", async () => {
      const user = userEvent.setup();
      const { client, modelSwitches } = renderPicker({
        ...claudeSession,
        modelSelection: { instanceId: 'claude-code', model: 'claude-sonnet-5-5', options: [{ id: 'effort', value: 'high' }] },
      });

      await user.click(await screen.findByRole('button', { name: 'Session model, High' }));
      expect(screen.getByText('Set for this session.')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Use default' }));
      await waitForMutationsIdle(client);
      expect(modelSwitches).toEqual([{ modelId: null }]);
    });
  });
});
