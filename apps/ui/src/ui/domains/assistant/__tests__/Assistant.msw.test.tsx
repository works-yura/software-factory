import {
  AssistantApiProvider,
  AssistantFactoryAccessSettings,
  AssistantModelSettings,
  AssistantPanel,
  AssistantStorageSettings,
} from '@factory/assistant-ui';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { File as NodeFile } from 'node:buffer';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../e2e/ui/render';
import { i18n } from '../../../i18n';
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

/** Types at the end of the note's Markdown editor (CodeMirror reads what lands in its content). */
async function typeInEditor(editor: HTMLElement, text: string) {
  const content = await waitFor(() => {
    const found = editor.querySelector<HTMLElement>('.cm-content');
    if (!found) throw new Error('The note editor is not in edit mode');
    return found;
  });
  type View = { state: { doc: { length: number } }; dispatch: (spec: unknown) => void };
  const view = (content as unknown as { cmTile?: { root?: { view?: View } } }).cmTile?.root?.view;
  if (!view) throw new Error('No CodeMirror view on the editor');
  act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: text } }));
}

/** Selects the start of a passage in the thread and adds it, as a person drags over it and presses Add note. */
async function annotatePassage(user: ReturnType<typeof userEvent.setup>, passage: string, length: number) {
  const paragraph = await screen.findByText(passage);
  const text = paragraph.firstChild;
  if (!(text instanceof Text)) throw new Error('The paragraph has no text node');
  fireEvent.pointerDown(paragraph);
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, length);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
  fireEvent.pointerUp(paragraph);
  await user.click(await screen.findByRole('button', { name: 'Add note' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Add note' })).not.toBeInTheDocument());
}

function renderPanel(props: { compact?: boolean } = {}, settingsHref?: string) {
  return renderWithProviders(
    <AssistantApiProvider baseUrl={TEST_BASE_URL} {...(settingsHref ? { settingsHref } : {})}>
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

  it('says which model failed and why, with the raw words under Details, a way to pick another model, and Retry', async () => {
    const failure = {
      kind: 'rate_limit',
      modelId: 'xai/grok-4.5',
      status: 429,
      detail: 'Too Many Requests\n{"code":"Some resource has been exhausted"}',
    };
    let failed = true;
    let retried = 0;
    server.use(
      http.get(`${TEST_BASE_URL}/web/assistant/requests`, () => HttpResponse.json({ requests: [request({ status: 'new' })] })),
      http.get(`${TEST_BASE_URL}/web/assistant/requests/req-1`, () =>
        HttpResponse.json({
          ...view({ status: failed ? 'new' : 'waiting_me', lastError: failed ? failure : null }),
          messages: failed ? [view().messages[0]] : view().messages,
        }),
      ),
      http.post(`${TEST_BASE_URL}/web/assistant/requests/req-1/retry`, () => {
        retried += 1;
        failed = false;
        return HttpResponse.json({ request: request({ status: 'new', analysing: true }) });
      }),
    );
    const user = userEvent.setup();
    renderPanel({}, '/factories/f-1/settings/assistant');
    await user.click(await screen.findByRole('button', { name: /Checkout fails/ }));

    const notice = await screen.findByTestId('assistant-turn-failure');
    // The headline names the provider and model and says what happened, not the raw words.
    expect(within(notice).getByText('xAI · grok-4.5: limit reached or no credits')).toBeInTheDocument();
    expect(within(notice).queryByText(/^Too Many Requests/)).not.toBeInTheDocument();
    expect(within(notice).getByRole('link', { name: 'Choose another model' })).toHaveAttribute('href', '/factories/f-1/settings/assistant');
    await user.click(within(notice).getByRole('button', { name: 'Details' }));
    expect(await within(notice).findByTestId('assistant-failure-detail')).toHaveTextContent(/HTTP 429\s*Too Many Requests/);

    await user.click(within(notice).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(retried).toBe(1));
    await waitFor(() => expect(screen.queryByTestId('assistant-turn-failure')).not.toBeInTheDocument());
    expect(await screen.findByText('checkout')).toBeInTheDocument();
  });

  it('names an invalid key and a missing model each with its own fix', async () => {
    let failure: Record<string, unknown> = { kind: 'auth', modelId: 'openai/gpt-5', status: 401, detail: 'Incorrect API key provided' };
    server.use(
      http.get(`${TEST_BASE_URL}/web/assistant/requests`, () => HttpResponse.json({ requests: [request({ status: 'new' })] })),
      http.get(`${TEST_BASE_URL}/web/assistant/requests/req-1`, () => HttpResponse.json(view({ status: 'new', lastError: failure }))),
    );
    const user = userEvent.setup();
    const { unmount } = renderPanel();
    await user.click(await screen.findByRole('button', { name: /Checkout fails/ }));
    expect(await screen.findByText('OpenAI · gpt-5: the API key was refused')).toBeInTheDocument();
    // Without a settings page to link to, the fix still says where to go.
    expect(screen.queryByRole('link', { name: 'Choose another model' })).not.toBeInTheDocument();
    expect(screen.getByText(/Settings › Assistant/)).toBeInTheDocument();
    unmount();

    failure = { kind: 'no_model', modelId: null, status: null, detail: 'Your organization has no model connected.' };
    renderPanel();
    await user.click(await screen.findByRole('button', { name: /Checkout fails/ }));
    expect(await screen.findByText('The organization has no model connected')).toBeInTheDocument();
  });

  it('keeps the list toolbar on one line: the filter, the new count as a badge, the new-request button icon-only', async () => {
    server.use(
      http.get(`${TEST_BASE_URL}/web/assistant/requests`, () =>
        HttpResponse.json({ requests: [request({ status: 'new' }), request({ id: 'req-2', topic: 'Invoice is wrong' })] }),
      ),
    );
    renderPanel();
    const count = await screen.findByTestId('assistant-new-count');
    expect(count).toHaveTextContent('1 new');
    expect(count.className).toMatch(/whitespace-nowrap/);
    const toolbar = count.closest('header')!;
    expect(within(toolbar).getByRole('combobox', { name: 'Show' })).toHaveTextContent('Open');
    const create = within(toolbar).getByRole('button', { name: 'New request' });
    // Icon-only: the name and its key are in the tooltip, not in a label that would overflow the column.
    expect(create).toHaveTextContent('');
    expect(create).toHaveAttribute('aria-keyshortcuts', 'C');
  });

  it('says how long ago in the app language, the same way in the list and the thread', async () => {
    const createdAt = new Date(Date.now() - 7_000).toISOString();
    server.use(
      http.get(`${TEST_BASE_URL}/web/assistant/requests`, () => HttpResponse.json({ requests: [request({ createdAt, updatedAt: createdAt })] })),
      http.get(`${TEST_BASE_URL}/web/assistant/requests/req-1`, () => HttpResponse.json(view({ createdAt, updatedAt: createdAt }))),
    );
    await i18n.changeLanguage('uk');
    try {
      const user = userEvent.setup();
      renderPanel();
      const row = await screen.findByRole('button', { name: /Checkout fails/ });
      expect(row).toHaveTextContent('щойно');
      await user.click(row);
      const meta = await screen.findByTestId('assistant-meta-line');
      expect(meta).toHaveTextContent('щойно');
      expect(meta).not.toHaveTextContent(/ago|\d+s\b/);
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('shows a source thread: the colleague’s messages as incoming, the earlier request it continues, and Analyse after the hourly limit', async () => {
    let analysed = 0;
    const clickup = request({
      id: 'req-3',
      topic: 'Deploy is stuck',
      source: 'clickup',
      fromName: 'Olena Koval',
      sourceUrl: 'https://app.clickup.com/c/1',
      previousRequestId: 'req-old',
      status: 'waiting_me',
    });
    server.use(
      http.get(`${TEST_BASE_URL}/web/assistant/requests`, () =>
        HttpResponse.json({ requests: [clickup, request({ id: 'req-old', topic: 'Deploy question', status: 'closed' })] }),
      ),
      http.get(`${TEST_BASE_URL}/web/assistant/requests/req-3`, () =>
        HttpResponse.json({
          request: clickup,
          messages: [
            { id: 'e1', author: 'event', fromName: null, text: 'continues:req-old', fileIds: [], createdAt: NOW },
            { id: 's1', author: 'source', fromName: 'Olena Koval', text: 'The deploy is stuck again', fileIds: [], createdAt: NOW },
            { id: 'e2', author: 'event', fromName: null, text: 'not_analysed:limit', fileIds: [], createdAt: NOW },
          ],
          files: [],
        }),
      ),
      http.get(`${TEST_BASE_URL}/web/assistant/requests/req-old`, () =>
        HttpResponse.json({ ...view(), request: request({ id: 'req-old', topic: 'Deploy question', status: 'closed' }) }),
      ),
      http.post(`${TEST_BASE_URL}/web/assistant/requests/req-3/retry`, () => {
        analysed += 1;
        return HttpResponse.json({ request: { ...clickup, analysing: true } });
      }),
    );
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: /Deploy is stuck/ }));
    const thread = await screen.findByTestId('assistant-thread');

    const incoming = await within(thread).findByLabelText('Message from Olena Koval');
    expect(incoming).toHaveAttribute('data-from', 'assistant');
    expect(incoming).toHaveAttribute('data-author', 'source');
    expect(within(incoming).getByText('Olena Koval')).toBeInTheDocument();
    expect(within(incoming).getByText('O')).toBeInTheDocument();
    expect(within(incoming).getByText('The deploy is stuck again')).toBeInTheDocument();

    expect(await within(thread).findByText('Continues “Deploy question”')).toBeInTheDocument();
    expect(within(thread).getByText('Not analysed: hourly analysis limit reached')).toBeInTheDocument();
    await user.click(within(thread).getByRole('button', { name: 'Analyse' }));
    await waitFor(() => expect(analysed).toBe(1));

    await user.click(within(thread).getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(within(screen.getByTestId('assistant-topic-line')).getByRole('heading')).toHaveTextContent('Deploy question'));
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

  it('notes: an empty state, «+» starts one in the Markdown editor, it saves itself, then edits and deletes after confirming', async () => {
    let notes: Array<Record<string, unknown>> = [];
    const created: unknown[] = [];
    const patched: unknown[] = [];
    let deleted = '';
    server.use(
      http.get(`${TEST_BASE_URL}/web/assistant/notes`, () => HttpResponse.json({ notes })),
      http.post(`${TEST_BASE_URL}/web/assistant/notes`, async ({ request: incoming }) => {
        const body = (await incoming.json()) as { text: string };
        created.push(body);
        const at = new Date().toISOString();
        const note = { id: 'n1', requestId: null, text: body.text, author: 'person', createdAt: at, updatedAt: at };
        notes = [note];
        return HttpResponse.json({ note }, { status: 201 });
      }),
      http.patch(`${TEST_BASE_URL}/web/assistant/notes/n1`, async ({ request: incoming }) => {
        const body = (await incoming.json()) as { text: string };
        patched.push(body);
        notes = [{ ...notes[0]!, text: body.text }];
        return HttpResponse.json({ note: notes[0] });
      }),
      http.delete(`${TEST_BASE_URL}/web/assistant/notes/n1`, () => {
        deleted = 'n1';
        notes = [];
        return HttpResponse.json({ deleted: true });
      }),
    );
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('tab', { name: 'Notes' }));
    const view = await screen.findByTestId('assistant-notes');
    expect(await within(view).findByText('No notes yet')).toBeInTheDocument();

    await user.click(within(view).getAllByRole('button', { name: 'New note' })[0]!);
    const editor = await within(view).findByTestId('assistant-note-editor');
    await typeInEditor(editor, 'Call Olena\nabout the **invoice**');
    // Saved a moment after typing stops, with no button to press.
    await waitFor(() => expect(created).toEqual([{ text: 'Call Olena\nabout the **invoice**' }]), { timeout: 3000 });
    await waitFor(() => expect(within(editor).getByRole('status')).toHaveTextContent('Saved'));
    // The list: the first line as the title, the rest as the preview, how long ago.
    const row = await within(view).findByRole('button', { name: /Call Olena/ });
    expect(row).toHaveTextContent('about the **invoice**');
    expect(row).toHaveTextContent('now');

    await typeInEditor(editor, ' today');
    await waitFor(() => expect(patched).toEqual([{ text: 'Call Olena\nabout the **invoice** today' }]), { timeout: 3000 });
    expect(created).toHaveLength(1);

    // Preview renders the Markdown.
    await user.click(within(editor).getByRole('radio', { name: 'Preview' }));
    expect(within(within(editor).getByTestId('assistant-note-preview')).getByText('invoice').tagName).toBe('STRONG');

    await user.click(within(editor).getByRole('button', { name: 'Delete note' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(deleted).toBe('');
    await user.click(within(confirm).getByRole('button', { name: 'Delete note' }));
    await waitFor(() => expect(deleted).toBe('n1'));
    expect(await within(view).findByText('No notes yet')).toBeInTheDocument();
  });

  it('starts a note about a request from its thread, and the note opens that request', async () => {
    let created: unknown;
    let notes: Array<Record<string, unknown>> = [];
    server.use(
      http.get(`${TEST_BASE_URL}/web/assistant/requests`, () => HttpResponse.json({ requests: [request()] })),
      http.get(`${TEST_BASE_URL}/web/assistant/requests/req-1`, () => HttpResponse.json(view())),
      http.get(`${TEST_BASE_URL}/web/assistant/notes`, () => HttpResponse.json({ notes })),
      http.post(`${TEST_BASE_URL}/web/assistant/notes`, async ({ request: incoming }) => {
        created = await incoming.json();
        const note = { id: 'n2', requestId: 'req-1', text: 'Reply tomorrow', author: 'person', createdAt: NOW, updatedAt: NOW };
        notes = [note];
        return HttpResponse.json({ note }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: /Checkout fails/ }));
    const header = await screen.findByTestId('assistant-topic-line');
    await user.click(within(header).getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Note about this request' }));

    const editor = await screen.findByTestId('assistant-note-editor');
    expect(within(editor).getByText('About')).toBeInTheDocument();
    await typeInEditor(editor, 'Reply tomorrow');
    await waitFor(() => expect(created).toEqual({ text: 'Reply tomorrow', requestId: 'req-1' }), { timeout: 3000 });

    await user.click(within(editor).getByRole('button', { name: 'Checkout fails for Olena’s client' }));
    expect(await screen.findByTestId('assistant-thread')).toBeInTheDocument();
  });

  it('takes passages marked in the thread — the assistant’s report and a colleague’s message — to the next message, as in a Factory chat', async () => {
    let sent: { text?: string } | undefined;
    const clickup = request({ source: 'clickup', fromName: 'Olena' });
    server.use(
      http.get(`${TEST_BASE_URL}/web/assistant/requests`, () => HttpResponse.json({ requests: [clickup] })),
      http.get(`${TEST_BASE_URL}/web/assistant/requests/req-1`, () =>
        HttpResponse.json({
          request: clickup,
          messages: [
            { id: 's1', author: 'source', fromName: 'Olena', text: 'Checkout fails on mobile only', fileIds: [], createdAt: NOW },
            { id: 'm2', author: 'agent', fromName: null, text: 'Olena says payment never finishes.', fileIds: [], createdAt: NOW },
          ],
          files: [],
        }),
      ),
      http.post(`${TEST_BASE_URL}/web/assistant/requests/req-1/messages`, async ({ request: incoming }) => {
        sent = (await incoming.json()) as { text?: string };
        return HttpResponse.json({ request: clickup }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: /Checkout fails/ }));
    await annotatePassage(user, 'Checkout fails on mobile only', 'Checkout fails'.length);
    await annotatePassage(user, 'Olena says payment never finishes.', 'Olena says payment'.length);
    expect(await screen.findByRole('button', { name: '2 annotations' })).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Write to the assistant…' }), 'Which one is it?{Enter}');
    await waitFor(() => expect(sent).toBeDefined());
    expect(sent!.text).toBe('1. > Checkout fails\n\n2. > Olena says payment\n\nWhich one is it?');
    await waitFor(() => expect(screen.queryByRole('button', { name: /annotation/ })).not.toBeInTheDocument());
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

  it('stays open when the first click right after opening lands inside it, and when focus leaves it', async () => {
    server.use(
      http.get(`${TEST_BASE_URL}/auth/me`, () =>
        HttpResponse.json({ authEnabled: true, authenticated: true, user: { userId: 'ada', organizationId: 'org-1' } }),
      ),
      http.get(`${TEST_BASE_URL}/web/assistant/requests`, () => HttpResponse.json({ requests: [request()] })),
    );
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <button type="button">On the board</button>
        <AssistantOverlay factory={{ id: 'f-1', name: 'Shop' }} />
      </>,
    );
    await user.click(await screen.findByTestId('assistant-launcher'));
    const panel = await screen.findByRole('dialog', { name: 'Assistant' });
    await user.click(within(panel).getByRole('button', { name: 'New request' }));
    expect(await within(panel).findByRole('form', { name: 'New request' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Assistant' })).toBeInTheDocument();

    // Working on the page beside it — a click, focus moving there — keeps it open.
    await user.click(screen.getByRole('button', { name: 'On the board' }));
    act(() => screen.getByRole('button', { name: 'On the board' }).focus());
    await act(() => new Promise(resolve => setTimeout(resolve, 20)));
    expect(screen.getByRole('dialog', { name: 'Assistant' })).toBeInTheDocument();

    // Its button closes it.
    await user.click(screen.getByTestId('assistant-launcher'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Assistant' })).not.toBeInTheDocument());
  });
});

describe('Settings › Assistant: model, storage, Factory access', () => {
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
        <AssistantModelSettings />
        <AssistantStorageSettings />
      </AssistantApiProvider>,
    );

    const model = await screen.findByRole('combobox', { name: 'Model' });
    expect(model).toHaveAttribute('placeholder', "The organization's default model");
    await waitFor(() => expect(model).toBeEnabled());
    await user.click(model);
    await waitFor(() => expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual([expect.stringContaining('Anthropic · claude-sonnet-4-5')]));
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
        <AssistantFactoryAccessSettings location={{ pathname: '/factories/f-1/settings/account', search: '?assistantAccess=connected', assign }} />
      </AssistantApiProvider>,
    );
    expect(await screen.findByText('The assistant can now reach Factory as you.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('http://localhost:4111/auth/api/oauth2/authorize?client_id=c'));
  });
});
