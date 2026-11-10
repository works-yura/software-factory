import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import { SESSION_ID, releaseSession, renderThread, stubPreparingSession } from './composer-session-test-fixture';
import type { PreparingSession } from './composer-session-test-fixture';
import { FACTORY_REF_MIME, addFactoryRef, serializeRefs } from '../../services/factoryRefs';
import type { FactoryRef } from '../../services/factoryRefs';
import { defineRefKind, removeRefKind } from '../../services/refKinds';

const API = `${TEST_BASE_URL}/api/agent-controller/code`;

const SESSION_REF: FactoryRef = {
  kind: 'session',
  title: 'Inbox sorting',
  fields: { sessionId: 'session-inbox', threadId: 'thread-inbox' },
};
const CARD_REF: FactoryRef = {
  kind: 'card',
  title: 'Loyalty points',
  fields: { sessionId: 'session-loyalty', threadId: 'session-loyalty', workItemId: 'card-loyalty', board: 'product' },
};

function stubTranscript(refs: readonly FactoryRef[] = [CARD_REF]) {
  server.use(
    http.get(`${API}/sessions/:resourceId/threads/:threadId/messages`, () =>
      HttpResponse.json({
        messages: [
          {
            id: 'user-1',
            role: 'user',
            threadId: SESSION_ID,
            createdAt: '2026-11-10T10:00:00.000Z',
            content: {
              format: 2,
              parts: [{ type: 'text', text: serializeRefs('Build on what we agreed there.', refs) }],
            },
          },
        ],
      }),
    ),
  );
}

async function renderSession(refs?: readonly FactoryRef[]): Promise<PreparingSession> {
  const session = stubPreparingSession();
  stubTranscript(refs);
  const { client } = renderThread();
  await releaseSession(session.finishWorkspace, client);
  return session;
}

function composerForm() {
  const form = screen.getByRole('textbox', { name: 'Message' }).closest('form');
  if (!form) throw new Error('The composer has no form');
  return form;
}

/** A sidebar row dropped on the composer: the typed payload, and its title as text. */
function dropRef(ref: FactoryRef) {
  const payload = JSON.stringify({ kind: ref.kind, title: ref.title, ...ref.fields });
  const data: Record<string, string> = { [FACTORY_REF_MIME]: payload, 'text/plain': ref.title };
  const dataTransfer = {
    types: Object.keys(data),
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    dropEffect: 'none',
    getData: (type: string) => data[type] ?? '',
  };
  fireEvent.dragOver(composerForm(), { dataTransfer });
  fireEvent.drop(composerForm(), { dataTransfer });
}

const attached = () => screen.queryByRole('region', { name: 'Referenced sessions' });

describe('Composer: referenced sessions and cards', () => {
  let user: UserEvent;
  let session: PreparingSession;

  beforeEach(async () => {
    user = userEvent.setup();
    session = await renderSession();
  });

  it('shows the references a sent message carried beside its sent files, not as the raw block', async () => {
    const message = await screen.findByText('Build on what we agreed there.');
    const bubble = message.closest('[data-slot="message"]') ?? document.body;
    const sent = within(bubble as HTMLElement).getByRole('group', { name: 'Referenced in this message' });
    expect(within(sent).getByRole('button', { name: 'Open Loyalty points' })).toHaveTextContent('Card · Product');
    expect(screen.queryByText(/factory-refs/)).not.toBeInTheDocument();
  });

  describe('when a session row is dropped on the composer', () => {
    beforeEach(() => {
      dropRef(SESSION_REF);
    });

    it('shows it like an attached file, with what it is under its title', () => {
      expect(within(attached()!).getByText('Inbox sorting')).toBeInTheDocument();
      expect(within(attached()!).getByText('Session')).toBeInTheDocument();
    });

    it('takes the same row once', () => {
      dropRef(SESSION_REF);
      expect(within(attached()!).getAllByRole('button', { name: /^Remove reference to / })).toHaveLength(1);
    });

    it('can be removed', async () => {
      await user.click(screen.getByRole('button', { name: 'Remove reference to Inbox sorting' }));
      expect(attached()).not.toBeInTheDocument();
    });

    describe('when the message is sent', () => {
      beforeEach(async () => {
        await user.click(screen.getByRole('textbox', { name: 'Message' }));
        await user.keyboard('What did we decide?');
        await user.click(screen.getByRole('button', { name: 'Send message' }));
      });

      it('reaches the agent with the reference as a factory-refs block after the text', async () => {
        await waitFor(() =>
          expect(session.delivered).toEqual([
            'What did we decide?\n\n```factory-refs\n' +
              '{"kind":"session","title":"Inbox sorting","sessionId":"session-inbox","threadId":"thread-inbox"}\n```',
          ]),
        );
      });

      it('clears the chip from the composer', async () => {
        await waitFor(() => expect(attached()).not.toBeInTheDocument());
      });
    });
  });

  describe("when a card is added from a row's menu (the keyboard path)", () => {
    let taken = false;

    beforeEach(() => {
      act(() => {
        taken = addFactoryRef(CARD_REF);
      });
    });

    it('is taken by the open composer, which focuses the message box', () => {
      expect(taken).toBe(true);
      expect(within(attached()!).getByText('Loyalty points')).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Message' })).toHaveFocus();
    });

    it('can be sent on its own', async () => {
      await user.click(screen.getByRole('button', { name: 'Send message' }));
      await waitFor(() =>
        expect(session.delivered).toEqual([
          '```factory-refs\n' +
            '{"kind":"card","title":"Loyalty points","sessionId":"session-loyalty","threadId":"session-loyalty","workItemId":"card-loyalty","board":"product"}\n```',
        ]),
      );
    });
  });
});

describe('Composer: a reference kind added later', () => {
  const DOC_REF: FactoryRef = { kind: 'doc', title: 'Brief', fields: { path: 'docs/brief.md' } };
  const UNKNOWN_REF: FactoryRef = { kind: 'pull-request', title: 'PR #42', fields: { number: '42' } };

  beforeEach(async () => {
    defineRefKind({
      kind: 'doc',
      required: ['path'],
      icon: () => null,
      subtitle: ref => `Document · ${ref.fields.path}`,
      href: () => '/away',
    });
    await renderSession([DOC_REF, UNKNOWN_REF]);
  });

  afterEach(() => removeRefKind('doc'));

  it('renders and opens through the same path as the built-in kinds', async () => {
    const open = await screen.findByRole('button', { name: 'Open Brief' });
    expect(open).toHaveTextContent('Document · docs/brief.md');
    await userEvent.click(open);
    expect(await screen.findByText('go-thread')).toBeInTheDocument();
  });

  it('shows a kind this app does not know by its title and kind, and opens nothing', async () => {
    const sent = await screen.findByRole('group', { name: 'Referenced in this message' });
    expect(within(sent).getByText('PR #42')).toBeInTheDocument();
    expect(within(sent).getByText('pull-request')).toBeInTheDocument();
    expect(within(sent).queryByRole('button', { name: 'Open PR #42' })).not.toBeInTheDocument();
  });

  it('can be dropped on the composer and sent with its own fields', async () => {
    dropRef(DOC_REF);
    expect(within(attached()!).getByText('Document · docs/brief.md')).toBeInTheDocument();
  });
});
