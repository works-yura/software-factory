import {
  AssistantAgentPreview,
  AssistantApiProvider,
  AssistantBehaviorSettings,
  AssistantModelSettings,
  AssistantPanel,
  AssistantProactivitySettings,
  AssistantSkillsSettings,
} from '@factory/assistant-ui';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { server } from '../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../e2e/ui/render';
import { AssistantModelPicker } from '../../settings/components/AssistantSettingsSection';
import { retiredSettingsTarget } from '../../settings/settingsSections';

const NOW = '2026-11-15T10:00:00.000Z';
const A = `${TEST_BASE_URL}/web/assistant`;

function renderIn(children: ReactNode) {
  return renderWithProviders(<AssistantApiProvider baseUrl={TEST_BASE_URL}>{children}</AssistantApiProvider>);
}

/** Replaces the CodeMirror editor's whole text, as typing would. */
async function replaceEditorText(editor: HTMLElement, text: string) {
  const content = await waitFor(() => {
    const found = editor.querySelector<HTMLElement>('.cm-content');
    if (!found) throw new Error('No editor content yet');
    return found;
  });
  type View = { state: { doc: { length: number } }; dispatch: (spec: unknown) => void };
  const view = (content as unknown as { cmTile?: { root?: { view?: View } } }).cmTile?.root?.view;
  if (!view) throw new Error('No CodeMirror view on the editor');
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }));
}

const DEFAULT_DOC = '# Assistant\n\nYou report to this person only.';

function behavior(overrides: Record<string, unknown> = {}) {
  return { document: DEFAULT_DOC, defaultDocument: DEFAULT_DOC, customized: false, updatedAt: null, version: 'abc123def456', ...overrides };
}

describe('Settings › Assistant › Behaviour', () => {
  it('edits the base document, shows the changes against the default, and restores the default', async () => {
    let saved: unknown;
    let reset = false;
    server.use(
      http.get(`${A}/behavior`, () => HttpResponse.json({ behavior: behavior() })),
      http.put(`${A}/behavior`, async ({ request }) => {
        saved = await request.json();
        return HttpResponse.json({ behavior: behavior({ document: `${DEFAULT_DOC}\n\n- Answer in Ukrainian.`, customized: true, updatedAt: NOW, version: 'fff000fff000' }) });
      }),
      http.delete(`${A}/behavior`, () => {
        reset = true;
        return HttpResponse.json({ behavior: behavior() });
      }),
    );
    const user = userEvent.setup();
    renderIn(<AssistantBehaviorSettings />);

    expect(await screen.findByText('Default')).toBeInTheDocument();
    expect(screen.getByText('version abc123def456')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore default' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    await replaceEditorText(screen.getByTestId('assistant-document-editor'), `${DEFAULT_DOC}\n\n- Answer in Ukrainian.`);
    await user.click(screen.getByRole('tab', { name: 'Changes' }));
    // The diff (the kit's CodeDiff) draws in its own shadow root.
    await waitFor(() => expect(document.querySelector('diffs-container')).not.toBeNull());
    expect(screen.queryByText('Same as the default.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Preview' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toEqual({ document: `${DEFAULT_DOC}\n\n- Answer in Ukrainian.` }));

    expect(await screen.findByText('Your version')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Restore default' }));
    await waitFor(() => expect(reset).toBe(true));
    expect(await screen.findByText('Default')).toBeInTheDocument();
  });
});

describe('Settings › Assistant › Skills', () => {
  const catalogue = (overrides: Record<string, unknown> = {}) => [
    { name: 'factory-triage', description: 'Sort an incoming issue.', origin: 'factory', overridden: false, enabled: true, ...overrides },
    { name: 'reply-style', description: 'How I reply.', origin: 'personal', overridden: false, enabled: false },
  ];

  it('lists skills with switches and badges; picking one saves the settings', async () => {
    let saved: unknown;
    server.use(
      http.get(`${A}/skills`, () => HttpResponse.json({ skills: catalogue({ overridden: true }) })),
      http.get(`${A}/settings`, () => HttpResponse.json({ settings: { modelId: null, retentionDays: 30, skills: ['factory-triage'] } })),
      http.put(`${A}/settings`, async ({ request }) => {
        saved = await request.json();
        return HttpResponse.json({ settings: { modelId: null, retentionDays: 30, skills: ['factory-triage', 'reply-style'] } });
      }),
    );
    const user = userEvent.setup();
    renderIn(<AssistantSkillsSettings />);

    const triage = await screen.findByTestId('assistant-skill-factory-triage');
    expect(within(triage).getByText('changed')).toBeInTheDocument();
    expect(within(triage).getByText('Factory')).toBeInTheDocument();
    expect(within(screen.getByTestId('assistant-skill-reply-style')).getByText('mine')).toBeInTheDocument();
    expect(screen.getByText('1 of 10 on')).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Give reply-style to the assistant' }));
    await waitFor(() => expect(saved).toEqual({ skills: ['factory-triage', 'reply-style'] }));
  });

  it('opens a catalogue skill in the skill editor, saves an assistant-only override, and restores the original', async () => {
    let put: unknown;
    let deleted = false;
    server.use(
      http.get(`${A}/skills`, () => HttpResponse.json({ skills: catalogue({ overridden: true }) })),
      http.get(`${A}/skills/factory-triage`, () =>
        HttpResponse.json({
          skill: {
            ...catalogue({ overridden: true })[0],
            description: 'Sort it my way.',
            instructions: 'Step 1: ask Olena.',
            original: { description: 'Sort an incoming issue.', instructions: 'Step 1: read it.' },
            updatedAt: NOW,
          },
        }),
      ),
      http.put(`${A}/skills/factory-triage`, async ({ request }) => {
        put = await request.json();
        return HttpResponse.json({ skill: {} });
      }),
      http.delete(`${A}/skills/factory-triage`, () => {
        deleted = true;
        return HttpResponse.json({ reverted: true, deleted: false });
      }),
    );
    const user = userEvent.setup();
    renderIn(<AssistantSkillsSettings />);

    await user.click(within(await screen.findByTestId('assistant-skill-factory-triage')).getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog', { name: 'Skill factory-triage' });
    expect(within(dialog).getByText(/You changed this skill for your assistant/)).toBeInTheDocument();
    const description = await within(dialog).findByDisplayValue('Sort it my way.');
    await user.clear(description);
    await user.type(description, 'Sort it, then ask Olena.');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(put).toEqual({ description: 'Sort it, then ask Olena.', instructions: 'Step 1: ask Olena.' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(within(screen.getByTestId('assistant-skill-factory-triage')).getByRole('button', { name: 'Open' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Restore original' }));
    await waitFor(() => expect(deleted).toBe(true));
  });

  it('creates a skill of the person’s own', async () => {
    let created: unknown;
    server.use(
      http.post(`${A}/skills`, async ({ request }) => {
        created = await request.json();
        return HttpResponse.json({ skill: {} }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderIn(<AssistantSkillsSettings />);
    await user.click(await screen.findByRole('button', { name: 'New skill' }));
    const dialog = await screen.findByRole('dialog', { name: 'New skill' });
    await user.type(within(dialog).getByPlaceholderText('Skill name'), 'reply-style');
    await user.type(within(dialog).getByPlaceholderText('Brief description of the skill'), 'How I reply.');
    await replaceEditorText(within(dialog).getByTestId('skill-instructions-input'), 'Short and warm.');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(created).toEqual({ name: 'reply-style', description: 'How I reply.', instructions: 'Short and warm.' }));
  });
});

describe('Settings › Assistant › What the agent sees', () => {
  it('shows the whole system prompt and every tool with what it may do', async () => {
    server.use(
      http.get(`${A}/agent-preview`, () =>
        HttpResponse.json({
          preview: {
            systemPrompt: '# Assistant\n\nWhatever the instructions above say: report to this person only.',
            version: 'abc123def456',
            modelId: null,
            skills: [],
            tools: [
              { name: 'assistant_search_requests', description: 'Search the person’s own requests.', kind: 'read' },
              { name: 'assistant_create_note', description: 'Keep a note for the person.', kind: 'write_own' },
              { name: 'factory_propose_ask', description: 'Propose asking a Factory.', kind: 'proposal' },
            ],
          },
        }),
      ),
    );
    renderIn(<AssistantAgentPreview />);
    expect(await screen.findByText(/version abc123def456/)).toBeInTheDocument();
    expect(screen.getByText('3 tools')).toBeInTheDocument();
    expect(within(screen.getByTestId('assistant-tool-assistant_search_requests')).getByText('reads')).toBeInTheDocument();
    expect(within(screen.getByTestId('assistant-tool-assistant_create_note')).getByText('writes your notes')).toBeInTheDocument();
    expect(within(screen.getByTestId('assistant-tool-factory_propose_ask')).getByText('proposal only')).toBeInTheDocument();
  });
});

describe('Settings › Assistant › Model', () => {
  it('says what runs and why, that only free models work, how providers fared, and checks the model', async () => {
    let checked: unknown;
    server.use(
      http.get(`${A}/models`, () =>
        HttpResponse.json({
          models: [
            { id: 'opencode/beam-free', provider: 'opencode', modelName: 'beam-free', free: true },
            { id: 'xai/grok-4.5', provider: 'xai', modelName: 'grok-4.5', available: false, unavailableReason: 'No credits' },
          ],
          default: { modelId: 'opencode/beam-free', reason: 'The first connected provider’s default.' },
        }),
      ),
      http.get(`${A}/model-status`, () =>
        HttpResponse.json({ providers: [{ provider: 'xai', modelId: 'xai/grok-4.5', state: 'rate_limit', detail: '429', at: NOW }] }),
      ),
      http.post(`${A}/model-test`, async ({ request }) => {
        checked = await request.json();
        return HttpResponse.json({ check: { ok: true, modelId: 'opencode/beam-free', reply: 'OK', failure: null, durationMs: 420 } });
      }),
    );
    const user = userEvent.setup();
    renderIn(<AssistantModelSettings />);

    await waitFor(() => expect(screen.getByTestId('assistant-effective-model')).toHaveTextContent("opencode · beam-free — the organization's default"));
    expect(screen.getByText('The first connected provider’s default.')).toBeInTheDocument();
    expect(screen.getByText(/only models that work in this organization now are free ones/)).toBeInTheDocument();
    expect(await screen.findByText('limit / no credits')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check the model' }));
    await waitFor(() => expect(checked).toEqual({}));
    expect(await screen.findByText('opencode · beam-free answered in 420 ms: «OK»')).toBeInTheDocument();
  });
});

describe('Settings › Assistant › Proactivity', () => {
  it('sets a chat’s rule (a reachable Factory included) and saves the digest schedule', async () => {
    let rule: unknown;
    let digest: unknown;
    const clickup = (channelRule = 'analyse') => ({
      connected: true,
      account: { id: 'u1', name: 'Ada' },
      status: 'active',
      lastSyncAt: null,
      lastError: null,
      nextPollAt: null,
      channels: [
        { workspaceId: 'w1', channelId: 'c1', name: 'support', kind: 'channel', mode: 'watch', rule: channelRule, lastSyncAt: null, lastError: null },
        { workspaceId: 'w1', channelId: 'c2', name: 'random', kind: 'channel', mode: 'ignore', lastSyncAt: null, lastError: null },
      ],
    });
    server.use(
      http.get(`${A}/sources`, () => HttpResponse.json({ clickup: clickup() })),
      http.get(`${A}/factories`, () => HttpResponse.json({ connected: true, pending: false, factories: [{ id: 'f-1', name: 'Shop' }] })),
      http.put(`${A}/sources/clickup/channels/w1/c1`, async ({ request }) => {
        rule = await request.json();
        return HttpResponse.json({ clickup: clickup('analyse_and_ask:f-1') });
      }),
      http.get(`${A}/settings`, () =>
        HttpResponse.json({ settings: { modelId: null, retentionDays: 30, skills: [], digest: { frequency: 'off', hour: 9, timeZone: 'Europe/Kyiv' } }, digestSchedule: { lastAt: null, nextAt: null } }),
      ),
      http.put(`${A}/settings`, async ({ request }) => {
        digest = await request.json();
        return HttpResponse.json({ settings: { modelId: null, retentionDays: 30, skills: [], digest: { frequency: 'daily', hour: 9, timeZone: 'Europe/Kyiv' } } });
      }),
    );
    const user = userEvent.setup();
    renderIn(<AssistantProactivitySettings />);

    // Only the chats turned on have a rule.
    const select = await screen.findByRole('combobox', { name: 'What to do with new requests from support' });
    expect(screen.queryByRole('combobox', { name: 'What to do with new requests from random' })).not.toBeInTheDocument();
    await user.click(select);
    await user.click(await screen.findByRole('option', { name: 'Analyse and ask Shop' }));
    await waitFor(() => expect(rule).toEqual({ rule: 'analyse_and_ask:f-1' }));

    await user.click(screen.getByRole('combobox', { name: 'Digest' }));
    await user.click(await screen.findByRole('option', { name: 'Daily' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(digest).toEqual({ digest: { frequency: 'daily', hour: 9, timeZone: 'Europe/Kyiv' } }));
  });
});

describe('the thread: what drove a reply, proposed actions, events', () => {
  const thread = (pendingAction: unknown) => ({
    request: {
      id: 'req-1',
      topic: 'Checkout fails',
      fromName: 'Olena',
      source: 'manual',
      sourceUrl: null,
      status: 'waiting_me',
      factory: null,
      analysing: false,
      lastError: null,
      unread: false,
      pendingAction,
      createdAt: NOW,
      updatedAt: NOW,
      closedAt: null,
    },
    messages: [
      { id: 'm1', author: 'person', text: 'Checkout fails', fileIds: [], createdAt: NOW },
      {
        id: 'm2',
        author: 'agent',
        text: 'Olena asks about checkout; I propose asking Shop.',
        fileIds: [],
        details: {
          modelId: 'opencode/beam-free',
          instructionsVersion: 'abc123def456',
          skills: ['factory-triage'],
          durationMs: 1200,
          toolCalls: [
            { name: 'assistant_search_requests', args: '{"query":"checkout"}', result: '{"requests":[]}', durationMs: 12 },
            { name: 'factory_list_attention', args: '{"factoryId":"f-1"}', error: 'Allow the assistant to reach Factory first', durationMs: 3 },
          ],
        },
        createdAt: NOW,
      },
      { id: 'm3', author: 'event', text: 'proposed:ask:Shop\nWhy does checkout fail?', fileIds: [], createdAt: NOW },
      { id: 'm4', author: 'event', text: 'answer_timeout', fileIds: [], createdAt: NOW },
    ],
    files: [],
  });

  it('shows the turn details, the proposed action with Confirm / Cancel, and the event lines', async () => {
    let confirmed = false;
    let pending: unknown = {
      id: 'act-1',
      kind: 'ask',
      factoryId: 'f-1',
      factoryName: 'Shop',
      question: 'Why does checkout fail?',
      reason: 'Shop owns checkout.',
      proposedBy: 'agent',
      proposedAt: NOW,
    };
    server.use(
      http.get(`${A}/requests`, () => HttpResponse.json({ requests: [thread(pending).request] })),
      http.get(`${A}/requests/req-1`, () => HttpResponse.json(thread(pending))),
      http.post(`${A}/requests/req-1/actions/act-1/confirm`, () => {
        confirmed = true;
        pending = null;
        return HttpResponse.json({ request: thread(null).request });
      }),
    );
    const user = userEvent.setup();
    renderIn(<AssistantPanel onClose={vi.fn()} />);
    await user.click(await screen.findByText('Checkout fails'));

    const details = await screen.findByTestId('assistant-turn-details');
    await user.click(within(details).getByText(/Turn details · 2 tool calls/));
    expect(within(details).getByText(/model opencode · beam-free · instructions abc123def456 · skills: factory-triage/)).toBeInTheDocument();
    expect(within(details).getAllByTestId('assistant-tool-call')).toHaveLength(2);

    expect(screen.getByText('Proposed asking Shop')).toBeInTheDocument();
    expect(screen.getByText(/No answer from the Factory in 15 minutes/)).toBeInTheDocument();
    const card = screen.getByTestId('assistant-pending-action');
    expect(within(card).getByText('Proposed: ask Shop')).toBeInTheDocument();
    expect(within(card).getByText('Shop owns checkout.')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(confirmed).toBe(true));
    await waitFor(() => expect(screen.queryByTestId('assistant-pending-action')).not.toBeInTheDocument());
  });

  it('cancels a proposed hand-over', async () => {
    let cancelled = false;
    const action = { id: 'act-2', kind: 'hand_over', factoryId: 'f-1', factoryName: 'Shop', title: 'Fix checkout', proposedBy: 'rule', proposedAt: NOW };
    server.use(
      http.get(`${A}/requests`, () => HttpResponse.json({ requests: [thread(action).request] })),
      http.get(`${A}/requests/req-1`, () => HttpResponse.json(thread(cancelled ? null : action))),
      http.post(`${A}/requests/req-1/actions/act-2/cancel`, () => {
        cancelled = true;
        return HttpResponse.json({ request: thread(null).request });
      }),
    );
    const user = userEvent.setup();
    renderIn(<AssistantPanel onClose={vi.fn()} />);
    await user.click(await screen.findByText('Checkout fails'));
    const card = await screen.findByTestId('assistant-pending-action');
    expect(within(card).getByText(/the chat's rule/)).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(cancelled).toBe(true));
  });
});

describe('the panel links to its settings page', () => {
  it('has a gear to Settings › Assistant; old Account links land there', async () => {
    renderWithProviders(
      <AssistantApiProvider baseUrl={TEST_BASE_URL} settingsHref="/factories/f-1/settings/assistant">
        <AssistantPanel onClose={vi.fn()} />
      </AssistantApiProvider>,
    );
    expect(await screen.findByRole('link', { name: 'Assistant settings' })).toHaveAttribute('href', '/factories/f-1/settings/assistant');
    expect(retiredSettingsTarget('account', '#assistant')).toEqual({ section: 'assistant', anchor: '' });
    expect(retiredSettingsTarget('account', '#assistant-sources')).toEqual({ section: 'assistant', anchor: '#sources' });
    expect(retiredSettingsTarget('account', '')).toBeUndefined();
  });
});

describe('the assistant’s model in Factory’s own model picker', () => {
  const groups = [
    {
      id: 'opencode',
      harness: 'opencode',
      label: 'OpenCode · OpenCode account',
      credential: 'opencode_account',
      availability: { state: 'ready' },
      models: [{ id: 'opencode:opencode/beam-free', label: 'Beam (free)', free: true, selectable: true, availability: { state: 'ready' } }],
    },
    {
      id: 'mastra/xai',
      harness: 'mastra',
      label: 'xAI · API key',
      credential: 'api_key',
      availability: { state: 'unavailable', reason: 'No credits on the team' },
      models: [{ id: 'xai/grok-4.5', label: 'Grok 4.5', selectable: false, availability: { state: 'unavailable', reason: 'No credits on the team' } }],
    },
  ];

  it('builds the picker from the catalog’s groups: the default and free models marked, a model that cannot run greyed with why', async () => {
    const onChange = vi.fn();
    const { catalogInstances } = await import('../../settings/components/AssistantSettingsSection');
    const t = (key: string) => key;
    const { entries, disabled } = catalogInstances(
      { models: [], groups: groups as never, default: { modelId: 'opencode:opencode/beam-free', reason: 'The organization prefers it.' }, raw: {} },
      t,
    );
    expect(entries.map(entry => [entry.instanceId, entry.displayName, entry.isAvailable])).toEqual([
      ['opencode', 'OpenCode · OpenCode account', true],
      ['mastra/xai', 'xAI · API key', false],
    ]);
    expect(entries[0]!.models[0]).toMatchObject({ slug: 'opencode:opencode/beam-free', isDefault: true, badge: 'free' });
    expect(disabled.get('xai/grok-4.5')).toBe('No credits on the team');

    const user = userEvent.setup();
    renderWithProviders(
      <MemoryRouter>
      <AssistantModelPicker
        catalog={{ models: [], groups: groups as never, default: { modelId: 'opencode:opencode/beam-free' }, raw: {} }}
        value={null}
        disabled={false}
        onChange={onChange}
      />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: /Model/ }));
    expect((await screen.findAllByText('Free')).length).toBeGreaterThan(0);
    await user.click(await screen.findByRole('option', { name: /Beam/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('opencode:opencode/beam-free'));
  });
});
