import { AssistantApiProvider, AssistantSources } from '@factory/assistant-ui';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../e2e/ui/render';

const NOW = '2026-11-15T10:00:00.000Z';
const TOKEN = 'pk_12345678_NOTAREALTOKEN';

/** The server's default tag (`DEFAULT_TAG_PATTERN`). */
const DEFAULT_PATTERN = '(?<![\\p{L}\\p{N}_])[#@](?:помічник|assistant)(?![\\p{L}\\p{N}_])';
const TAG = { pattern: null, defaultPattern: DEFAULT_PATTERN, who: 'me', contextMessages: 10 };

const disconnected = {
  connected: false,
  account: null,
  status: null,
  lastSyncAt: null,
  lastError: null,
  nextPollAt: null,
  tag: TAG,
  chats: { total: 0, inSidebar: 0 },
};

function connected(overrides: Record<string, unknown> = {}) {
  return {
    connected: true,
    account: { id: '42', name: 'ada' },
    status: 'active',
    lastSyncAt: NOW,
    lastError: null,
    nextPollAt: NOW,
    tag: TAG,
    chats: { total: 12, inSidebar: 7 },
    ...overrides,
  };
}

function renderSources() {
  return renderWithProviders(
    <AssistantApiProvider baseUrl={TEST_BASE_URL}>
      <AssistantSources />
    </AssistantApiProvider>,
  );
}

describe('Settings › Assistant › Sources', () => {
  it('connects ClickUp with a personal token, says the tag is the trigger, and offers no per-chat setting', async () => {
    let sent: unknown;
    let state: Record<string, unknown> = disconnected;
    server.use(
      http.get(`${TEST_BASE_URL}/web/assistant/sources`, () => HttpResponse.json({ clickup: state })),
      http.post(`${TEST_BASE_URL}/web/assistant/sources/clickup`, async ({ request }) => {
        sent = await request.json();
        state = connected();
        return HttpResponse.json({ clickup: state });
      }),
    );
    const user = userEvent.setup();
    renderSources();

    const form = await screen.findByRole('form', { name: 'Connect ClickUp' });
    expect(within(form).getByRole('button', { name: 'Connect' })).toBeDisabled();
    await user.type(within(form).getByLabelText('Personal API token'), TOKEN);
    await user.click(within(form).getByRole('button', { name: 'Connect' }));

    expect(await screen.findByText('Connected as ada')).toBeInTheDocument();
    expect(sent).toEqual({ token: TOKEN });
    expect(screen.getByText('Looking for the tag in 12 chats')).toBeInTheDocument();
    expect(screen.getByText(/Nothing else in your chats ever becomes a request/)).toBeInTheDocument();
    expect(screen.getByLabelText('Tag pattern (regular expression, case-insensitive)')).toHaveValue(DEFAULT_PATTERN);
    // No chat list, no modes, no rules.
    expect(screen.queryByText(/When addressed|Everything|What to read in/)).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'ClickUp chats' })).not.toBeInTheDocument();
    // The token never comes back on the page.
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it('shows ClickUp’s refusal of a token', async () => {
    server.use(
      http.get(`${TEST_BASE_URL}/web/assistant/sources`, () => HttpResponse.json({ clickup: disconnected })),
      http.post(`${TEST_BASE_URL}/web/assistant/sources/clickup`, () =>
        HttpResponse.json({ error: 'token_rejected', message: 'ClickUp did not accept this token.' }, { status: 400 }),
      ),
    );
    const user = userEvent.setup();
    renderSources();
    await user.type(await screen.findByLabelText('Personal API token'), 'pk_00000000_WRONG');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('ClickUp did not accept this token.')).toBeInTheDocument();
  });

  it('tries the tag live, refuses a pattern that would match every message, and saves a custom one', async () => {
    let put: unknown;
    server.use(
      http.get(`${TEST_BASE_URL}/web/assistant/sources`, () => HttpResponse.json({ clickup: connected() })),
      http.put(`${TEST_BASE_URL}/web/assistant/sources/clickup/tag`, async ({ request }) => {
        put = await request.json();
        return HttpResponse.json({ clickup: connected({ tag: { ...TAG, pattern: '!!ai\\b' } }) });
      }),
    );
    const user = userEvent.setup();
    renderSources();
    const result = await screen.findByTestId('tag-test-result');
    expect(result).toHaveTextContent('Tag found. Instruction: «оціни це»');
    const sample = screen.getByLabelText('Test message');
    await user.clear(sample);
    await user.type(sample, 'да');
    expect(result).toHaveTextContent('No tag: this message would not make a request.');
    await user.clear(sample);
    await user.type(sample, 'look @Assistant');
    expect(result).toHaveTextContent('Tag found. Instruction: «look»');

    const pattern = screen.getByLabelText('Tag pattern (regular expression, case-insensitive)');
    const save = screen.getByRole('button', { name: 'Save the tag pattern' });
    await user.clear(pattern);
    await user.type(pattern, '.*');
    expect(screen.getByRole('alert')).toHaveTextContent('every message would become a request');
    expect(save).toBeDisabled();
    await user.clear(pattern);
    await user.type(pattern, '[[');
    expect(screen.getByRole('alert')).toHaveTextContent('not a valid regular expression');
    expect(result).toHaveTextContent('Fix the pattern to try it.');

    await user.clear(pattern);
    await user.type(pattern, '!!ai\\b');
    await user.clear(sample);
    await user.type(sample, '!!AI summarise');
    expect(result).toHaveTextContent('Tag found. Instruction: «summarise»');
    await user.click(save);
    await waitFor(() => expect(put).toEqual({ pattern: '!!ai\\b' }));
    expect(await screen.findByRole('button', { name: 'Default tag' })).toBeInTheDocument();
  });

  it('sets who may tag and how many earlier messages come along', async () => {
    const puts: unknown[] = [];
    let state = connected();
    server.use(
      http.get(`${TEST_BASE_URL}/web/assistant/sources`, () => HttpResponse.json({ clickup: state })),
      http.put(`${TEST_BASE_URL}/web/assistant/sources/clickup/tag`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        puts.push(body);
        state = connected({ tag: { ...(state.tag as typeof TAG), ...body } });
        return HttpResponse.json({ clickup: state });
      }),
    );
    const user = userEvent.setup();
    renderSources();
    const who = await screen.findByRole('combobox', { name: 'Who can tag' });
    expect(who).toHaveTextContent('Only me');
    await user.click(who);
    await user.click(await screen.findByRole('option', { name: 'Anyone in the chat' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Who can tag' })).toHaveTextContent('Anyone in the chat'));

    const count = screen.getByLabelText('Earlier messages');
    expect(count).toHaveValue(10);
    await user.clear(count);
    await user.type(count, '5');
    await user.click(screen.getByRole('button', { name: 'Save the number of earlier messages' }));
    await waitFor(() => expect(puts).toEqual([{ who: 'anyone' }, { contextMessages: 5 }]));
  });

  it('says when ClickUp stopped accepting the token and offers to connect again', async () => {
    server.use(
      http.get(`${TEST_BASE_URL}/web/assistant/sources`, () =>
        HttpResponse.json({ clickup: connected({ status: 'rejected', lastError: 'ClickUp no longer accepts this token.' }) }),
      ),
    );
    renderSources();
    expect(await screen.findByText(/no longer accepts this token, so reading stopped/)).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Connect ClickUp' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Read now' })).toBeDisabled();
  });

  it('offers the organization’s ClickUp connection to the person whose account it is, instead of a second token', async () => {
    let usedOrg = false;
    let state: Record<string, unknown> = { ...disconnected, orgOffer: { accountName: 'Yura', workspaces: ['eclipt.ai'] } };
    server.use(
      http.get(`${TEST_BASE_URL}/web/assistant/sources`, () => HttpResponse.json({ clickup: state })),
      http.post(`${TEST_BASE_URL}/web/assistant/sources/clickup/org`, () => {
        usedOrg = true;
        state = connected({ via: 'org', orgOffer: null, account: { id: '42', name: 'Yura' } });
        return HttpResponse.json({ clickup: state });
      }),
    );
    const user = userEvent.setup();
    renderSources();
    await user.click(await screen.findByRole('button', { name: "Use the organization's connection (ClickUp: Yura)" }));
    await waitFor(() => expect(usedOrg).toBe(true));
    expect(await screen.findByText('Connected as Yura')).toBeInTheDocument();
    expect(screen.getByText("Through the organization's ClickUp connection")).toBeInTheDocument();
  });

  it('does not offer it to anyone else: they paste their own token', async () => {
    server.use(http.get(`${TEST_BASE_URL}/web/assistant/sources`, () => HttpResponse.json({ clickup: { ...disconnected, orgOffer: null } })));
    renderSources();
    expect(await screen.findByRole('form', { name: 'Connect ClickUp' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /organization's connection/ })).not.toBeInTheDocument();
  });

  it('says reading stopped when the organization’s connection was removed, and offers a personal token', async () => {
    server.use(
      http.get(`${TEST_BASE_URL}/web/assistant/sources`, () =>
        HttpResponse.json({ clickup: connected({ via: 'org', orgOffer: null, status: 'rejected', lastError: 'gone', nextPollAt: null }) }),
      ),
    );
    renderSources();
    expect(await screen.findByText(/organization's ClickUp connection was removed/)).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Connect ClickUp' })).toBeInTheDocument();
  });
});
