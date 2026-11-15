import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { File as NodeFile } from 'node:buffer';

import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { server } from '../../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../../e2e/ui/render';
import type { WorkItemComment } from '../../../services/commentsWire';
import type { CommentQuoteDraft } from '../quoteDraft';
import { CommentComposer } from '../CommentComposer';

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const PROJECT_ID = 'project-1';
const ITEM_ID = 'item-1';
const COMMENTS_URL = `${TEST_BASE_URL}/web/factory/work-items/${ITEM_ID}/comments`;

function serverComment(body: string): WorkItemComment {
  return {
    id: 'comment-server',
    workItemId: ITEM_ID,
    kind: 'comment',
    bodyFormat: 'markdown',
    body,
    author: { kind: 'user', id: 'user-1', displayName: 'Ada' },
    mentions: [],
    occurredAt: '2026-08-26T10:00:00.000Z',
    revision: 1,
  };
}

function stubRoster() {
  server.use(
    http.get(`${TEST_BASE_URL}/web/factory/projects/${PROJECT_ID}/mention-roster`, () =>
      HttpResponse.json({
        members: [
          { id: 'user-ada', name: 'Ada' },
          { id: 'user-alan', name: 'Alan' },
        ],
      }),
    ),
  );
}

function stubCreate(posts: unknown[], status = 201) {
  server.use(
    http.post(COMMENTS_URL, async ({ request }) => {
      const body = await request.json();
      posts.push(body);
      if (status !== 201) return HttpResponse.json({ error: 'boom' }, { status });
      return HttpResponse.json({ comment: serverComment('posted') }, { status });
    }),
  );
}

function Harness({ initialQuote }: { initialQuote?: CommentQuoteDraft }) {
  const [quote, setQuote] = useState(initialQuote);
  return (
    <CommentComposer
      workItemId={ITEM_ID}
      factoryProjectId={PROJECT_ID}
      variant="thread"
      quote={quote}
      onDismissQuote={() => setQuote(undefined)}
    />
  );
}

describe('CommentComposer', () => {
  it('attaches picked files to the card and names them in the comment', async () => {
    const posts: unknown[] = [];
    const uploads: string[] = [];
    stubRoster();
    stubCreate(posts);
    server.use(
      http.post(`${TEST_BASE_URL}/web/factory/work-items/${ITEM_ID}/attachments`, ({ request }) => {
        const url = new URL(request.url);
        uploads.push(`${url.searchParams.get('name')}:${url.searchParams.get('source')}`);
        return HttpResponse.json(
          {
            attachment: {
              id: 'bbbbbbbb-0000-4000-8000-000000000000',
              workItemId: ITEM_ID,
              sessionId: null,
              name: 'logo.svg',
              mime: 'image/svg+xml',
              size: 2048,
              sha256: 'f'.repeat(64),
              source: 'comment',
              sourceUrl: null,
              addedBy: 'user-1',
              addedAt: '2026-11-10T10:00:00.000Z',
              contentUrl: '/web/factory/attachments/bbbbbbbb-0000-4000-8000-000000000000/content',
              sandboxPath: '.factory/attachments/bbbbbbbb-logo.svg',
            },
          },
          { status: 201 },
        );
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    // jsdom's File is not a body Node's fetch sends; a browser's is.
    const file = new NodeFile(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }) as unknown as File;
    await user.upload(screen.getByLabelText('Attach files', { selector: 'input' }), file);
    expect(screen.getByText('logo.svg')).toBeInTheDocument();
    await user.click(screen.getByRole('textbox', { name: 'Comment' }));
    await user.keyboard('New logo{Enter}');

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(uploads).toEqual(['logo.svg:comment']);
    expect(posts[0]).toMatchObject({
      body: 'New logo\n\nВкладення: logo.svg (2.0 KB) → .factory/attachments/bbbbbbbb-logo.svg',
    });
    expect(screen.queryByText('logo.svg')).not.toBeInTheDocument();
  });

  it('sends on Enter, and Shift+Enter inserts a newline instead', async () => {
    const posts: unknown[] = [];
    stubRoster();
    stubCreate(posts);
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    const input = screen.getByRole('textbox', { name: 'Comment' });
    await user.click(input);
    await user.keyboard('first line{Shift>}{Enter}{/Shift}second line');
    expect(posts).toEqual([]);

    await user.keyboard('{Enter}');
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ body: 'first line\nsecond line', mentions: [] });
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('mentions a member picked from the dropdown, and drops one whose name was deleted', async () => {
    const posts: unknown[] = [];
    stubRoster();
    stubCreate(posts);
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    const input = screen.getByRole('textbox', { name: 'Comment' });
    if (!(input instanceof HTMLTextAreaElement)) throw new Error('composer input is not a textarea');
    await user.click(input);
    await user.keyboard('ping @Al');
    await screen.findByRole('option', { name: 'Alan' });
    await user.keyboard('{Enter}');
    expect(input).toHaveValue('ping @Alan ');
    expect(screen.queryByRole('option', { name: 'Alan' })).not.toBeInTheDocument();
    expect(input.selectionStart).toBe('ping @Alan '.length);

    await user.keyboard('and @Ad');
    await screen.findByRole('option', { name: 'Ada' });
    await user.keyboard('{Enter}');
    expect(input).toHaveValue('ping @Alan and @Ada ');
    expect(input.selectionStart).toBe('ping @Alan and @Ada '.length);

    await user.clear(input);
    await user.keyboard('only @Alan stays');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      body: 'only @Alan stays',
      mentions: [{ kind: 'user', id: 'user-alan' }],
    });
  });

  it('closes only the dropdown on Escape', async () => {
    stubRoster();
    const outerKeyDown = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <div onKeyDown={outerKeyDown}>
        <Harness />
      </div>,
    );

    const input = screen.getByRole('textbox', { name: 'Comment' });
    await user.click(input);
    await user.keyboard('@A');
    await screen.findByRole('region', { name: 'Mentions options' });

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Mentions options' })).not.toBeInTheDocument());
    const escapes = outerKeyDown.mock.calls.filter(([event]) => event.key === 'Escape');
    expect(escapes).toEqual([]);
    expect(input).toHaveValue('@A');

    await user.keyboard('{Backspace}A');
    expect(await screen.findByRole('region', { name: 'Mentions options' })).toBeInTheDocument();
  });

  it('mints a new client token when a failed send is edited before the retry', async () => {
    const posts: unknown[] = [];
    stubRoster();
    stubCreate(posts, 500);
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    const input = screen.getByRole('textbox', { name: 'Comment' });
    await user.click(input);
    await user.keyboard('first try');
    await user.keyboard('{Enter}');
    await screen.findByRole('alert');

    stubCreate(posts);
    await user.clear(input);
    await user.keyboard('changed my mind');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(posts).toHaveLength(2));

    const tokenOf = (post: unknown) =>
      typeof post === 'object' && post !== null && 'clientToken' in post ? post.clientToken : undefined;
    expect(tokenOf(posts[1])).not.toBe(tokenOf(posts[0]));
  });

  it('keeps the draft and quote when the server rejects', async () => {
    const posts: unknown[] = [];
    stubRoster();
    stubCreate(posts, 500);
    const user = userEvent.setup();
    renderWithProviders(
      <Harness initialQuote={{ commentId: 'comment-0', quote: 'earlier words', authorName: 'Ada' }} />,
    );

    const input = screen.getByRole('textbox', { name: 'Comment' });
    await user.click(input);
    await user.keyboard('my reply');
    await user.keyboard('{Enter}');

    await screen.findByRole('alert');
    expect(input).toHaveValue('my reply');
    expect(screen.getByText('earlier words')).toBeInTheDocument();
    expect(posts).toHaveLength(1);

    stubCreate(posts);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(posts).toHaveLength(2));
    const tokenOf = (post: unknown) =>
      typeof post === 'object' && post !== null && 'clientToken' in post ? post.clientToken : undefined;
    expect(tokenOf(posts[1])).toBe(tokenOf(posts[0]));
    await waitFor(() => expect(input).toHaveValue(''));
    expect(screen.queryByText('earlier words')).not.toBeInTheDocument();
  });
});

describe('CommentComposer and permissions (ADR-0045)', () => {
  function signedInWith(permissions: string[]) {
    server.use(
      http.get(`${TEST_BASE_URL}/auth/me`, () =>
        HttpResponse.json({ authenticated: true, provider: 'better-auth', user: { userId: 'vera', organizationId: 'org-1', permissions } }),
      ),
    );
  }

  it('shows no comment box to someone without comment.write, such as a viewer', async () => {
    signedInWith(['board.read', 'self.write']);
    renderWithProviders(<CommentComposer workItemId="wi-1" factoryProjectId="fp-1" variant="panel" onDismissQuote={() => {}} />);

    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Comment' })).not.toBeInTheDocument());
  });

  it('shows it to someone with comment.write', async () => {
    signedInWith(['board.read', 'self.write', 'comment.write']);
    renderWithProviders(<CommentComposer workItemId="wi-1" factoryProjectId="fp-1" variant="panel" onDismissQuote={() => {}} />);

    expect(await screen.findByRole('textbox', { name: 'Comment' })).toBeInTheDocument();
  });
});
