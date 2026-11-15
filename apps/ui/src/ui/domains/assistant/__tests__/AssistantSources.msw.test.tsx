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

describe('Settings › Assistant › Sources', () => {
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

describe('Settings › Assistant › Sources: the chat list as the ClickUp sidebar shows it', () => {
  /** The view the server sends for a workspace like the person's: DMs by person, location channels with equal names. */
  function sidebarChannels() {
    const row = (overrides: Record<string, unknown> & { kind: string }) => ({
      workspaceId: '9001',
      mode: 'ignore',
      lastSyncAt: null,
      lastError: null,
      visibility: 'PUBLIC',
      location: null,
      members: [],
      rule: 'analyse',
      inSidebar: true,
      ...overrides,
    });
    return [
      row({ channelId: 'dm-olena', name: 'Olena', kind: 'dm', mode: 'addressed', members: [{ id: '7', name: 'Olena', avatarUrl: null }] }),
      row({ channelId: 'dm-taras', name: 'Taras', kind: 'dm', mode: 'addressed', members: [{ id: '8', name: 'Taras', avatarUrl: null }] }),
      row({ channelId: 'dm-old', name: 'Iryna', kind: 'dm', mode: 'addressed', inSidebar: false, members: [{ id: '9', name: 'Iryna', avatarUrl: null }] }),
      row({
        channelId: 'gdm-1',
        name: 'Olena, Taras',
        kind: 'group_dm',
        mode: 'addressed',
        members: [
          { id: '7', name: 'Olena', avatarUrl: null },
          { id: '8', name: 'Taras', avatarUrl: null },
        ],
      }),
      row({ channelId: 'ch-albi', name: 'Albi', kind: 'channel', location: { kind: 'space', path: ['Albi'] } }),
      row({ channelId: 'ch-bookfate', name: 'BookFate', kind: 'channel' }),
      row({ channelId: 'ch-bugs-1', name: 'Bugs', kind: 'channel', location: { kind: 'list', path: ['Clients', 'Syncta', 'Bugs'] } }),
      row({ channelId: 'ch-bugs-2', name: 'Bugs', kind: 'channel', inSidebar: false, location: { kind: 'list', path: ['Clients', 'KidNation', 'Bugs'] } }),
      row({ channelId: 'ch-dev-1', name: 'Development', kind: 'channel', inSidebar: false, location: { kind: 'folder', path: ['Internal', 'Development'] } }),
    ];
  }

  it('groups DMs (each by its person) and channels (each with its location), sidebar first', async () => {
    server.use(http.get(`${TEST_BASE_URL}/web/assistant/sources`, () => HttpResponse.json({ clickup: connected({ channels: sidebarChannels() }) })));
    const user = userEvent.setup();
    renderSources();

    const dms = await screen.findByRole('group', { name: 'Direct messages' });
    expect(within(dms).getAllByTestId('source-channel').map(item => item.textContent)).toEqual([
      expect.stringContaining('Olena'),
      expect.stringContaining('Taras'),
      expect.stringContaining('Olena, Taras'),
    ]);
    expect(within(dms).queryByText('Iryna')).not.toBeInTheDocument();

    const rooms = screen.getByRole('group', { name: 'Channels' });
    expect(within(rooms).getByText(/List channel · Clients › Syncta › Bugs/)).toBeInTheDocument();
    expect(within(rooms).getByText(/Space channel · Albi/)).toBeInTheDocument();
    expect(within(rooms).queryByText(/KidNation/)).not.toBeInTheDocument();
    expect(within(rooms).getByRole('combobox', { name: 'What to read in #Bugs — Clients › Syncta › Bugs' })).toBeInTheDocument();

    await user.click(within(rooms).getByRole('button', { name: 'Show all (5)' }));
    expect(within(rooms).getByText(/List channel · Clients › KidNation › Bugs/)).toBeInTheDocument();
    expect(within(rooms).getByText(/Folder channel · Internal › Development/)).toBeInTheDocument();
    // Equal names, never equal rows.
    const names = within(rooms)
      .getAllByRole('combobox')
      .map(select => select.getAttribute('aria-label'));
    expect(new Set(names).size).toBe(names.length);

    await user.click(within(dms).getByRole('button', { name: 'Show all (4)' }));
    expect(within(dms).getByText('Iryna')).toBeInTheDocument();
  });

  it('searches names, people and locations across everything, saying when nothing matches', async () => {
    server.use(http.get(`${TEST_BASE_URL}/web/assistant/sources`, () => HttpResponse.json({ clickup: connected({ channels: sidebarChannels() }) })));
    const user = userEvent.setup();
    renderSources();
    const search = await screen.findByLabelText('Search chats');
    await user.type(search, 'kidnation');
    const rooms = await screen.findByRole('group', { name: 'Channels' });
    expect(within(rooms).getAllByTestId('source-channel')).toHaveLength(1);
    expect(screen.queryByRole('group', { name: 'Direct messages' })).not.toBeInTheDocument();
    await user.clear(search);
    await user.type(search, 'iryna');
    expect(await screen.findByText('Iryna')).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, 'nowhere');
    expect(await screen.findByText('Nothing found')).toBeInTheDocument();
  });

  it('sets every DM to one mode at once', async () => {
    let put: unknown;
    server.use(
      http.get(`${TEST_BASE_URL}/web/assistant/sources`, () => HttpResponse.json({ clickup: connected({ channels: sidebarChannels() }) })),
      http.put(`${TEST_BASE_URL}/web/assistant/sources/clickup/dms`, async ({ request }) => {
        put = await request.json();
        const channels = sidebarChannels().map(channel => (channel.kind === 'channel' ? channel : { ...channel, mode: 'watch' }));
        return HttpResponse.json({ changed: 4, clickup: connected({ channels }) });
      }),
    );
    const user = userEvent.setup();
    renderSources();
    await user.click(await screen.findByRole('combobox', { name: 'All DMs' }));
    await user.click(await screen.findByRole('option', { name: 'All DMs: Everything' }));
    await waitFor(() => expect(put).toEqual({ mode: 'watch' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'What to read in Olena' })).toHaveTextContent('Everything'));
  });
});
