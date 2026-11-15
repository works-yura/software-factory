import { AssistantApiProvider, AssistantPanel, AssistantSettings } from '@factory/assistant-ui';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { File as NodeFile } from 'node:buffer';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../e2e/ui/render';
import { AssistantOverlay } from '../AssistantOverlay';

const NOW = '2026-11-15T10:00:00.000Z';

/**
 * jsdom's `FormData` and `File` are not the ones Node's `fetch` (which MSW intercepts) can send, so
 * a multipart upload from the panel uses Node's here, as a browser would use its own.
 */
const NodeFormData = (
  await new Response('a=1', { headers: { 'content-type': 'application/x-www-form-urlencoded' } }).formData()
).constructor as typeof FormData;
beforeEach(() => {
  vi.stubGlobal('FormData', NodeFormData);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req-1',
    topic: 'Checkout fails for Olena’s client',
    fromName: 'Olena',
    source: 'manual',
    sourceUrl: 'https://app.clickup.com/t/123',
    status: 'waiting_me',
    factory: null,
    analysing: false,
    lastError: null,
    unread: false,
    createdAt: NOW,
    updatedAt: NOW,
    closedAt: null,
    ...overrides,
  };
}

function view(overrides: Record<string, unknown> = {}) {
  return {
    request: request(overrides),
    messages: [
      { id: 'm1', author: 'person', text: 'Checkout fails for Olena’s client', fileIds: ['f1'], createdAt: NOW },
      { id: 'm2', author: 'agent', text: 'Olena asks why the **checkout** fails.', fileIds: [], createdAt: NOW },
    ],
    files: [{ id: 'f1', name: 'shot.png', mime: 'image/png', size: 10, createdAt: NOW, contentUrl: '/web/assistant/files/f1/content' }],
  };
}

function renderPanel(props: { compact?: boolean } = {}) {
  return renderWithProviders(
    <AssistantApiProvider baseUrl={TEST_BASE_URL}>
      <AssistantPanel onClose={vi.fn()} hint={{ id: 'f-1', name: 'Shop' }} {...props} />
    </AssistantApiProvider>,
  );
}

describe('the assistant panel', () => {
  it('takes a new request the person pastes, with a screenshot, and opens its thread', async () => {
    let sent: FormData | undefined;
    let created = false;
    server.use(
      http.get(`${TEST_BASE_URL}/web/assistant/requests`, () =>
        HttpResponse.json({ requests: created ? [request({ status: 'new', analysing: true })] : [] }),
      ),
      http.post(`${TEST_BASE_URL}/web/assistant/requests`, async ({ request: incoming }) => {
        sent = await incoming.formData();
        created = true;
        return HttpResponse.json({ request: request({ status: 'new', analysing: true }) }, { status: 201 });
      }),
      http.get(`${TEST_BASE_URL}/web/assistant/requests/req-1`, () => HttpResponse.json(view({ status: 'new', analysing: true }))),
    );
    const user = userEvent.setup();
    renderPanel();

    expect(await screen.findByText(/No requests here/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New request' }));
    const form = screen.getByRole('form', { name: 'New request' });
    await user.type(within(form).getByLabelText('What they wrote'), 'Checkout fails for Olena’s client');
    await user.type(within(form).getByLabelText('From'), 'Olena');
    await user.upload(within(form).getByLabelText('Choose files'), new NodeFile([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' }) as unknown as File);
    expect(within(form).getByText('shot.png')).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Give to the assistant' }));

    await waitFor(() => expect(sent).toBeDefined());
    expect(sent!.get('text')).toBe('Checkout fails for Olena’s client');
    expect(sent!.get('fromName')).toBe('Olena');
    expect((sent!.get('files') as File).name).toBe('shot.png');

    const thread = await screen.findByTestId('assistant-thread');
    expect(within(screen.getByTestId('assistant-topic-line')).getByRole('combobox', { name: 'Status' })).toHaveTextContent('New');
    expect(within(thread).getByText('The assistant is looking at it…')).toBeInTheDocument();
    expect(await screen.findByTestId('assistant-new-count')).toHaveTextContent('1 new');
  });

  it('shows a thread with its header — topic, who and when, status, target Factory — the report and the screenshot', async () => {
    server.use(
      http.get(`${TEST_BASE_URL}/web/assistant/requests`, () => HttpResponse.json({ requests: [request({ unread: true })] })),
      http.get(`${TEST_BASE_URL}/web/assistant/requests/req-1`, () => HttpResponse.json(view())),
      http.get(`${TEST_BASE_URL}/web/assistant/factories`, () =>
        HttpResponse.json({ connected: true, pending: false, factories: [{ id: 'f-0', name: 'Ops' }, { id: 'f-1', name: 'Shop' }] }),
      ),
    );
    const user = userEvent.setup();
    renderPanel();

    const row = await screen.findByRole('button', { name: /Checkout fails/ });
    expect(row).toHaveTextContent('unread');
    await user.click(row);
    const header = await screen.findByTestId('assistant-topic-line');
    expect(within(header).getByRole('heading', { name: 'Checkout fails for Olena’s client' })).toBeInTheDocument();
    expect(within(header).getByText('From Olena')).toBeInTheDocument();
    expect(within(header).getByRole('link', { name: /Original/ })).toHaveAttribute('href', 'https://app.clickup.com/t/123');
    expect(within(header).getByRole('combobox', { name: 'Status' })).toHaveTextContent('Waiting for me');
    // The page's Factory is the default target, by name.
    await waitFor(() => expect(within(header).getByRole('combobox', { name: 'Factory' })).toHaveTextContent('Shop'));
    expect(within(header).getByRole('button', { name: 'Close' })).toHaveAttribute('aria-keyshortcuts', 'E');
    expect(await screen.findByText('checkout')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'shot.png' })).toHaveAttribute('src', `${TEST_BASE_URL}/web/assistant/files/f1/content`);
  });

  it('sets the status from the header and renames the topic in place', async () => {
    const patches: unknown[] = [];
    server.use(
      http.get(`${TEST_BASE_URL}/web/assistant/requests`, () => HttpResponse.json({ requests: [request()] })),
      http.get(`${TEST_BASE_URL}/web/assistant/requests/req-1`, () => HttpResponse.json(view())),
      http.patch(`${TEST_BASE_URL}/web/assistant/requests/req-1`, async ({ request: incoming }) => {
        const patch = (await incoming.json()) as Record<string, unknown>;
        patches.push(patch);
        return HttpResponse.json({ request: request(patch) });
      }),
    );
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: /Checkout fails/ }));
    const header = await screen.findByTestId('assistant-topic-line');

    await user.click(within(header).getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'Answered' }));
    await waitFor(() => expect(patches).toContainEqual({ status: 'answered' }));

    await user.click(within(header).getByRole('button', { name: 'Rename' }));
    const topic = within(header).getByRole('textbox', { name: 'Topic' });
    await user.clear(topic);
    await user.type(topic, 'Checkout for Olena{Enter}');
    await waitFor(() => expect(patches).toContainEqual({ topic: 'Checkout for Olena' }));
  });

  it('asks the chosen Factory from the composer, with what is typed as the question', async () => {
    let asked: unknown;
    server.use(
      http.get(`${TEST_BASE_URL}/web/assistant/requests`, () => HttpResponse.json({ requests: [request()] })),
      http.get(`${TEST_BASE_URL}/web/assistant/requests/req-1`, () => HttpResponse.json(view())),
      http.get(`${TEST_BASE_URL}/web/assistant/factories`, () =>
        HttpResponse.json({ connected: true, pending: false, factories: [{ id: 'f-0', name: 'Ops' }, { id: 'f-1', name: 'Shop' }] }),
      ),
      http.post(`${TEST_BASE_URL}/web/assistant/requests/req-1/ask`, async ({ request: incoming }) => {
        asked = await incoming.json();
        return HttpResponse.json({ request: request({ status: 'waiting_factory' }) });
      }),
    );
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: /Checkout fails/ }));
    await screen.findByTestId('assistant-topic-line');

    await user.click(screen.getByRole('radio', { name: /Ask Factory/ }));
    const input = await screen.findByRole('textbox', { name: /Question for Shop/ });
    await user.type(input, 'Why does checkout fail?');
    await user.click(screen.getByRole('button', { name: 'Ask Shop' }));
    await waitFor(() => expect(asked).toEqual({ factoryId: 'f-1', question: 'Why does checkout fail?' }));
    // Sent: the composer is back to writing to the assistant.
    expect(await screen.findByRole('textbox', { name: 'Write to the assistant…' })).toHaveValue('');
  });

  it('hands the request to another Factory picked in the header, with a note', async () => {
    let handed: unknown;
    server.use(
      http.get(`${TEST_BASE_URL}/web/assistant/requests`, () => HttpResponse.json({ requests: [request()] })),
      http.get(`${TEST_BASE_URL}/web/assistant/requests/req-1`, () => HttpResponse.json(view())),
      http.get(`${TEST_BASE_URL}/web/assistant/factories`, () =>
        HttpResponse.json({ connected: true, pending: false, factories: [{ id: 'f-0', name: 'Ops' }, { id: 'f-1', name: 'Shop' }] }),
      ),
      http.post(`${TEST_BASE_URL}/web/assistant/requests/req-1/hand-over`, async ({ request: incoming }) => {
        handed = await incoming.json();
        return HttpResponse.json({ request: request({ status: 'waiting_factory' }) });
      }),
    );
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: /Checkout fails/ }));
    const header = await screen.findByTestId('assistant-topic-line');

    const picker = within(header).getByRole('combobox', { name: 'Factory' });
    await waitFor(() => expect(picker).toHaveTextContent('Shop'));
    await user.click(picker);
    await user.click(await screen.findByRole('option', { name: 'Ops' }));
    await waitFor(() => expect(picker).toHaveTextContent('Ops'));

    await user.click(screen.getByRole('radio', { name: /Hand to Factory/ }));
    await user.type(await screen.findByRole('textbox', { name: /card in Ops/ }), 'Only on mobile{Enter}');
    await waitFor(() => expect(handed).toEqual({ factoryId: 'f-0', note: 'Only on mobile' }));
  });

  it('closes with E from the list and opens the next request', async () => {
    const patches: Array<{ id: string; body: unknown }> = [];
    let requests = [request(), request({ id: 'req-2', topic: 'Invoice is wrong' })];
    server.use(
      http.get(`${TEST_BASE_URL}/web/assistant/requests`, () => HttpResponse.json({ requests })),
      http.get(`${TEST_BASE_URL}/web/assistant/requests/:id`, ({ params }) =>
        HttpResponse.json({ ...view(), request: requests.find(item => item.id === params.id) }),
      ),
      http.patch(`${TEST_BASE_URL}/web/assistant/requests/:id`, async ({ params, request: incoming }) => {
        const body = (await incoming.json()) as Record<string, unknown>;
        patches.push({ id: String(params.id), body });
        requests = requests.map(item => (item.id === params.id ? { ...item, ...body } : item));
        return HttpResponse.json({ request: requests.find(item => item.id === params.id) });
      }),
    );
    const user = userEvent.setup();
    renderPanel();

    // j opens the first request and keeps focus on its row.
    (await screen.findByRole('button', { name: /Checkout fails/ })).focus();
    await user.keyboard('j');
    expect(within(await screen.findByTestId('assistant-topic-line')).getByRole('heading')).toHaveTextContent('Checkout fails');
    await user.keyboard('e');
    await waitFor(() => expect(patches).toEqual([{ id: 'req-1', body: { status: 'closed' } }]));
    // Inbox zero: the closed one leaves the open list and the next one is open.
    await waitFor(() => expect(within(screen.getByTestId('assistant-topic-line')).getByRole('heading')).toHaveTextContent('Invoice is wrong'));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Checkout fails/ })).not.toBeInTheDocument());
  });

  it('says to allow Factory access first when the person has not', async () => {
    server.use(
      http.get(`${TEST_BASE_URL}/web/assistant/requests`, () => HttpResponse.json({ requests: [request()] })),
      http.get(`${TEST_BASE_URL}/web/assistant/requests/req-1`, () => HttpResponse.json(view())),
    );
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: /Checkout fails/ }));
    await user.click(await screen.findByRole('radio', { name: /Hand to Factory/ }));
    expect(await screen.findByText(/Allow the assistant to reach Factory first/)).toBeInTheDocument();
  });

  it('shows why the agent failed', async () => {
    server.use(
      http.get(`${TEST_BASE_URL}/web/assistant/requests`, () => HttpResponse.json({ requests: [request({ status: 'new' })] })),
      http.get(`${TEST_BASE_URL}/web/assistant/requests/req-1`, () =>
        HttpResponse.json(view({ status: 'new', lastError: 'Your organization has no model connected.' })),
      ),
    );
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: /Checkout fails/ }));
    expect(await screen.findByText(/Your organization has no model connected/)).toBeInTheDocument();
  });

  it('on a phone shows the list first and the thread over it, with a way back', async () => {
    server.use(
      http.get(`${TEST_BASE_URL}/web/assistant/requests`, () => HttpResponse.json({ requests: [request()] })),
      http.get(`${TEST_BASE_URL}/web/assistant/requests/req-1`, () => HttpResponse.json(view())),
    );
    const user = userEvent.setup();
    renderPanel({ compact: true });
    await user.click(await screen.findByRole('button', { name: /Checkout fails/ }));
    expect(await screen.findByTestId('assistant-thread')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Requests' })).not.toBeInTheDocument();
    // A compact header: the status and the Factory move into «More».
    const header = screen.getByTestId('assistant-topic-line');
    expect(within(header).queryByRole('combobox', { name: 'Status' })).not.toBeInTheDocument();
    await user.click(within(header).getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: /Status/ })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Back to requests' }));
    expect(await screen.findByRole('button', { name: /Checkout fails/ })).toBeInTheDocument();
  });

  it('keeps notes in their own tab', async () => {
    let created: unknown;
    server.use(
      http.post(`${TEST_BASE_URL}/web/assistant/notes`, async ({ request: incoming }) => {
        created = await incoming.json();
        return HttpResponse.json({ note: { id: 'n1', requestId: null, text: 'Call Olena', author: 'person', createdAt: NOW, updatedAt: NOW } }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('tab', { name: 'Notes' }));
    await user.type(await screen.findByLabelText('A note for yourself…'), 'Call Olena');
    await user.click(screen.getByRole('button', { name: 'Add note' }));
    await waitFor(() => expect(created).toEqual({ text: 'Call Olena' }));
  });
});

describe('the floating button', () => {
  it('is not there without sign-in', async () => {
    renderWithProviders(<AssistantOverlay />);
    await act(() => new Promise(resolve => setTimeout(resolve, 50)));
    expect(screen.queryByTestId('assistant-launcher')).not.toBeInTheDocument();
  });

  it('is there for a signed-in person, counting new answers, and opens the panel', async () => {
    server.use(
      http.get(`${TEST_BASE_URL}/auth/me`, () =>
        HttpResponse.json({ authEnabled: true, authenticated: true, user: { userId: 'ada', organizationId: 'org-1' } }),
      ),
      http.get(`${TEST_BASE_URL}/web/assistant/requests`, () => HttpResponse.json({ requests: [request({ unread: true })] })),
    );
    const user = userEvent.setup();
    renderWithProviders(<AssistantOverlay factory={{ id: 'f-1', name: 'Shop' }} />);
    const launcher = await screen.findByTestId('assistant-launcher');
    await waitFor(() => expect(launcher).toHaveAccessibleName('Open the assistant (1 new answer)'));
    await user.click(launcher);
    expect(await screen.findByRole('dialog', { name: 'Assistant' })).toBeInTheDocument();
  });
});

describe('Account › Assistant', () => {
  it('saves the retention, offers only the organization’s models, and clears after confirming', async () => {
    let saved: unknown;
    let cleared = false;
    server.use(
      http.get(`${TEST_BASE_URL}/web/assistant/models`, () =>
        HttpResponse.json({ models: [{ id: 'anthropic/claude-sonnet-4-5', provider: 'anthropic', modelName: 'claude-sonnet-4-5' }] }),
      ),
      http.put(`${TEST_BASE_URL}/web/assistant/settings`, async ({ request: incoming }) => {
        saved = await incoming.json();
        return HttpResponse.json({ settings: { modelId: null, retentionDays: 7 } });
      }),
      http.post(`${TEST_BASE_URL}/web/assistant/clear`, () => {
        cleared = true;
        return HttpResponse.json({ cleared: { requests: 2, files: 1 } });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(
      <AssistantApiProvider baseUrl={TEST_BASE_URL}>
        <AssistantSettings location={{ pathname: '/factories/f-1/settings/account', search: '', assign: vi.fn() }} />
      </AssistantApiProvider>,
    );

    const model = await screen.findByRole('combobox', { name: 'Model' });
    await waitFor(() => expect(model).toHaveTextContent("The organization's default"));
    await waitFor(() => expect(model).toBeEnabled());
    await user.click(model);
    await waitFor(() =>
      expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual([
        "The organization's default",
        'anthropic/claude-sonnet-4-5',
      ]),
    );
    await user.keyboard('{Escape}');
    const retention = screen.getByRole('spinbutton', { name: 'Keep closed requests' });
    await waitFor(() => expect(retention).toHaveValue(30));
    await user.clear(retention);
    await user.type(retention, '7');
    await user.click(screen.getByRole('button', { name: 'Save how long to keep' }));
    await waitFor(() => expect(saved).toEqual({ retentionDays: 7 }));

    await user.click(screen.getByRole('button', { name: 'Clear the assistant' }));
    const confirm = await screen.findByRole('alertdialog');
    await user.click(within(confirm).getByRole('button', { name: 'Clear the assistant' }));
    await waitFor(() => expect(cleared).toBe(true));
    expect(await screen.findByText('The assistant was cleared.')).toBeInTheDocument();
  });

  it('starts the Factory consent and comes back saying how it went', async () => {
    const assign = vi.fn();
    server.use(
      http.post(`${TEST_BASE_URL}/web/assistant/factory-access/start`, async ({ request: incoming }) => {
        expect(await incoming.json()).toEqual({ returnTo: '/factories/f-1/settings/account' });
        return HttpResponse.json({ url: 'http://localhost:4111/auth/api/oauth2/authorize?client_id=c' });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(
      <AssistantApiProvider baseUrl={TEST_BASE_URL}>
        <AssistantSettings location={{ pathname: '/factories/f-1/settings/account', search: '?assistantAccess=connected', assign }} />
      </AssistantApiProvider>,
    );
    expect(await screen.findByText('The assistant can now reach Factory as you.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('http://localhost:4111/auth/api/oauth2/authorize?client_id=c'));
  });
});
