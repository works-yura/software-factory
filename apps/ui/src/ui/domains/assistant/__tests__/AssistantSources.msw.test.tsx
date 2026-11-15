import { AssistantApiProvider, AssistantSources } from '@factory/assistant-ui';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../e2e/ui/render';

const NOW = '2026-11-15T10:00:00.000Z';
const TOKEN = 'pk_12345678_NOTAREALTOKEN';

const disconnected = { connected: false, account: null, status: null, lastSyncAt: null, lastError: null, nextPollAt: null, channels: [] };

function connected(overrides: Record<string, unknown> = {}) {
  return {
    connected: true,
    account: { id: '42', name: 'ada' },
    status: 'active',
    lastSyncAt: NOW,
    lastError: null,
    nextPollAt: NOW,
    channels: [
      { workspaceId: '9001', channelId: 'dm-olena', name: 'Olena', kind: 'dm', mode: 'addressed', lastSyncAt: NOW, lastError: null },
      { workspaceId: '9001', channelId: 'ch-general', name: 'general', kind: 'channel', mode: 'ignore', lastSyncAt: null, lastError: null },
    ],
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

describe('Account › Assistant › Sources', () => {
  it('connects ClickUp with a personal token and lists its chats with their modes', async () => {
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
    const chats = screen.getByRole('group', { name: 'ClickUp chats' });
    expect(within(chats).getByText('Olena')).toBeInTheDocument();
    expect(within(chats).getByText('#general')).toBeInTheDocument();
    expect(within(chats).getByRole('combobox', { name: 'What to read in Olena' })).toHaveTextContent('When addressed');
    expect(within(chats).getByRole('combobox', { name: 'What to read in #general' })).toHaveTextContent('Off');
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

  it('turns a channel on with the mode select', async () => {
    let put: { path: string; body: unknown } | undefined;
    server.use(
      http.get(`${TEST_BASE_URL}/web/assistant/sources`, () => HttpResponse.json({ clickup: connected() })),
      http.put(`${TEST_BASE_URL}/web/assistant/sources/clickup/channels/:ws/:channel`, async ({ request, params }) => {
        put = { path: `${String(params.ws)}/${String(params.channel)}`, body: await request.json() };
        const next = connected();
        next.channels[1] = { ...next.channels[1]!, mode: 'watch' };
        return HttpResponse.json({ clickup: next });
      }),
    );
    const user = userEvent.setup();
    renderSources();
    await user.click(await screen.findByRole('combobox', { name: 'What to read in #general' }));
    await user.click(await screen.findByRole('option', { name: 'Everything' }));
    await waitFor(() => expect(put).toEqual({ path: '9001/ch-general', body: { mode: 'watch' } }));
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'What to read in #general' })).toHaveTextContent('Everything'),
    );
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

  it('shows an empty state when ClickUp lists no chats', async () => {
    server.use(http.get(`${TEST_BASE_URL}/web/assistant/sources`, () => HttpResponse.json({ clickup: connected({ channels: [] }) })));
    renderSources();
    expect(await screen.findByText('No chats yet')).toBeInTheDocument();
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
