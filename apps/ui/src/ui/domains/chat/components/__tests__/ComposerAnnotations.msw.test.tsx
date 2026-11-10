import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { TEST_BASE_URL, waitForMutationsIdle } from '../../../../../../e2e/ui/render';
import { SESSION_ID, releaseSession, renderThread, stubPreparingSession } from './composer-session-test-fixture';
import { WorkspaceFileViewer } from '../../../workspace-viewer/components/WorkspaceFileViewer';
import type { WorkspaceFilePreview } from '../../../workspace-viewer/components/workspace-file-preview';
import type { PreparingSession, StubPreparingSessionOptions } from './composer-session-test-fixture';

const API = `${TEST_BASE_URL}/api/agent-controller/code`;
const REPLY = 'Open rows drop the frame and keep a subtle rounded hover.';
const SECOND = 'Soft rows add faint backgrounds with small gaps.';

function stubReply() {
  server.use(
    http.get(`${API}/sessions/:resourceId/threads/:threadId/messages`, () =>
      HttpResponse.json({
        messages: [
          {
            id: 'user-1',
            role: 'user',
            threadId: SESSION_ID,
            createdAt: '2026-07-23T10:00:00.000Z',
            content: { format: 2, parts: [{ type: 'text', text: 'Which table style should we use?' }] },
          },
          {
            id: 'assistant-1',
            role: 'assistant',
            threadId: SESSION_ID,
            createdAt: '2026-07-23T10:00:05.000Z',
            content: { format: 2, parts: [{ type: 'text', text: `${REPLY}\n\n${SECOND}` }] },
          },
        ],
      }),
    ),
  );
}

async function selectFrom(paragraphText: string, length: number) {
  const paragraph = await screen.findByText(paragraphText);
  const text = paragraph.firstChild;
  if (!(text instanceof Text)) throw new Error('The paragraph has no text node');
  fireEvent.pointerDown(paragraph);
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, length);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
  fireEvent.pointerUp(paragraph);
}

async function annotate(user: UserEvent, paragraphText: string, length: number) {
  await selectFrom(paragraphText, length);
  await user.click(await screen.findByRole('button', { name: 'Add note' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Add note' })).not.toBeInTheDocument());
}

async function renderSessionWithReply(options: StubPreparingSessionOptions = {}): Promise<PreparingSession> {
  const session = stubPreparingSession(options);
  stubReply();
  const { client } = renderThread();
  await releaseSession(session.finishWorkspace, client);
  return session;
}

const markers = () =>
  Array.from(document.querySelectorAll('[data-slot="annotation-marker"]')).map(marker => marker.textContent);

afterEach(() => {
  document.getSelection()?.removeAllRanges();
});

describe('Composer annotations', () => {
  describe('when part of a reply is added to the chat', () => {
    let user: UserEvent;
    let session: PreparingSession;

    beforeEach(async () => {
      user = userEvent.setup();
      session = await renderSessionWithReply();
      await annotate(user, REPLY, 'Open rows'.length);
    });

    it('numbers the passage in the transcript', () => {
      expect(markers()).toEqual(['1']);
    });

    it('counts the annotation in the composer', () => {
      expect(screen.getByRole('button', { name: '1 annotation' })).toBeInTheDocument();
    });

    it('focuses the message box', () => {
      expect(screen.getByRole('textbox', { name: 'Message' })).toHaveFocus();
    });

    describe('when the person types a message and sends it', () => {
      beforeEach(async () => {
        await user.keyboard('Why this one?');
        await user.click(screen.getByRole('button', { name: 'Send message' }));
      });

      it('reaches the agent as a blockquote ahead of the typed message', async () => {
        await waitFor(() => expect(session.delivered).toEqual(['1. > Open rows\n\nWhy this one?']));
      });

      it('clears the annotation from the composer', async () => {
        await waitFor(() => expect(screen.queryByRole('button', { name: /annotation/ })).not.toBeInTheDocument());
      });

      it('removes the number from the transcript', async () => {
        await waitFor(() => expect(markers()).toEqual([]));
      });
    });
  });

  describe('when the person sends an annotation without typing', () => {
    let session: PreparingSession;

    beforeEach(async () => {
      const user = userEvent.setup();
      session = await renderSessionWithReply();
      await annotate(user, REPLY, 'Open rows'.length);
      await user.click(screen.getByRole('button', { name: 'Send message' }));
    });

    it('sends the quoted passage on its own', async () => {
      await waitFor(() => expect(session.delivered).toEqual(['1. > Open rows']));
    });

    it('removes the number from the transcript', async () => {
      await waitFor(() => expect(markers()).toEqual([]));
    });
  });

  describe('when two passages are added', () => {
    let user: UserEvent;
    let session: PreparingSession;

    beforeEach(async () => {
      user = userEvent.setup();
      session = await renderSessionWithReply();
      await annotate(user, SECOND, 'Soft rows'.length);
      await annotate(user, REPLY, 'Open rows'.length);
    });

    it('numbers both passages in the transcript', () => {
      expect(markers()).toEqual(['1', '2']);
    });

    describe('when the person opens the annotation list', () => {
      let list: HTMLElement;

      beforeEach(async () => {
        await user.click(screen.getByRole('button', { name: '2 annotations' }));
        list = await screen.findByRole('list', { name: 'Annotations' });
      });

      it('lists the passages by number', () => {
        expect(
          within(list)
            .getAllByRole('listitem')
            .map(item => item.textContent),
        ).toEqual(['1Soft rows', '2Open rows']);
      });

      describe('when the first passage is removed', () => {
        beforeEach(async () => {
          await user.click(within(list).getByRole('button', { name: 'Remove annotation 1' }));
        });

        it('renumbers the remaining passage in the transcript', () => {
          expect(markers()).toEqual(['1']);
        });

        describe('when the person types a message and sends it', () => {
          beforeEach(async () => {
            await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Only this one');
            await user.click(screen.getByRole('button', { name: 'Send message' }));
          });

          it('sends only the passage that is left', async () => {
            await waitFor(() => expect(session.delivered).toEqual(['1. > Open rows\n\nOnly this one']));
          });
        });
      });
    });
  });

  describe('when the message with the annotation fails to send', () => {
    beforeEach(async () => {
      const user = userEvent.setup();
      const session = await renderSessionWithReply({ failDispatch: true });
      await annotate(user, REPLY, 'Open rows'.length);
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Why this one?');
      await user.click(screen.getByRole('button', { name: 'Send message' }));
      await waitFor(() => expect(session.posted).toEqual(['1. > Open rows\n\nWhy this one?']));
    });

    it('puts the annotation back in the composer', async () => {
      expect(await screen.findByRole('button', { name: '1 annotation' })).toBeInTheDocument();
    });

    it('puts the annotation back on the transcript', async () => {
      await waitFor(() => expect(markers()).toEqual(['1']));
    });
  });

  describe('when the person answers a plan with feedback that starts with a slash', () => {
    let resumed: unknown[];

    beforeEach(async () => {
      resumed = [];
      server.use(
        http.post(`${API}/sessions/:resourceId/tool-suspension`, async ({ request }) => {
          resumed.push(await request.json());
          return HttpResponse.json({ ok: true });
        }),
      );
      const user = userEvent.setup();
      const session = await renderSessionWithReply({ materialized: true, autoAgentEnd: false });
      await session.emit({
        type: 'tool_suspended',
        toolCallId: 'plan-call-1',
        toolName: 'submit_plan',
        args: { path: '.artifacts/plans/ship.md' },
        suspendPayload: { toolId: 'submit_plan', path: '.artifacts/plans/ship.md', title: 'Ship it', plan: 'Add it.' },
      });
      const composer = await screen.findByRole('textbox', { name: 'Message' });
      await waitFor(() => expect(composer).toHaveAttribute('placeholder', 'Give feedback on this plan…'));

      await annotate(user, REPLY, 'Open rows'.length);
      await user.type(composer, '/tmp is the wrong place{enter}');
    });

    it('sends the annotation with the feedback instead of keeping it for a command', async () => {
      await waitFor(() =>
        expect(resumed).toEqual([
          expect.objectContaining({
            resumeData: expect.objectContaining({ feedback: '1. > Open rows\n\n/tmp is the wrong place' }),
          }),
        ]),
      );
    });

    it('clears the annotation from the composer', async () => {
      await waitFor(() => expect(screen.queryByRole('button', { name: /annotation/ })).not.toBeInTheDocument());
    });
  });

  describe('when the person writes a note on the selected passage', () => {
    it('sends the passage with the note under it', async () => {
      const user = userEvent.setup();
      const session = await renderSessionWithReply();
      await selectFrom(REPLY, 'Open rows'.length);
      await user.click(await screen.findByRole('textbox', { name: 'Note for the agent' }));
      await user.keyboard('Too dense{Enter}');
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Add note' })).not.toBeInTheDocument());
      expect(markers()).toEqual(['1']);

      await user.click(screen.getByRole('button', { name: 'Send message' }));

      await waitFor(() => expect(session.delivered).toEqual(['1. > Open rows\n\n   Too dense']));
    });
  });

  describe('when the person reviews a document full screen', () => {
    const DOC = 'The owner gets a push for every new booking.';
    const file = {
      name: 'requirements.md',
      path: 'docs/changes/2026-11-10-notifications/requirements.md',
      language: 'markdown',
      contentType: 'text',
      content: `# Brief\n\n${DOC}`,
      size: 48,
      updatedAt: '2026-11-10T10:00:00.000Z',
    } as unknown as WorkspaceFilePreview;

    // jsdom runs the dialog's and the note card's open animations on fake frames; under a loaded run the
    // card can still be settling when the click lands, so this one interaction-heavy test may retry.
    it('notes passages in the dialog and sends them all from its header, closing it', { retry: 2 }, async () => {
      // The dialog and the note card animate in; their entry styles briefly disable pointer events.
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      const session = stubPreparingSession();
      stubReply();
      const { client } = renderThread(
        <WorkspaceFileViewer
          filePath={file.path}
          file={file}
          isLoading={false}
          isRefreshing={false}
          onRefresh={() => {}}
          onBack={() => {}}
        />,
      );
      await releaseSession(session.finishWorkspace, client);
      // The thread remounts its chat once its messages arrive; open the document only after every fetch settled.
      await screen.findByText(REPLY);
      await waitFor(() => expect(client.isFetching()).toBe(0));
      await waitForMutationsIdle(client);

      await user.click(screen.getByRole('button', { name: 'Open full screen' }));
      const dialog = await screen.findByRole('dialog', { name: 'requirements.md' });
      const send = within(dialog).getByRole('button', { name: 'Send all (0)' });
      expect(send).toBeDisabled();

      const inDialog = Array.from(dialog.querySelectorAll('p')).find(p => p.textContent === DOC);
      if (!inDialog) throw new Error('No paragraph in the dialog');
      const text = inDialog.firstChild as Text;
      fireEvent.pointerDown(inDialog);
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 'The owner'.length);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
      fireEvent.pointerUp(inDialog);

      const note = await screen.findByRole('textbox', { name: 'Note for the agent' });
      await user.click(note);
      await user.keyboard('Which owner');
      expect(note).toHaveValue('Which owner');
      await user.keyboard('{Enter}');
      await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Note for the agent' })).not.toBeInTheDocument());
      await user.click(await within(dialog).findByRole('button', { name: 'Send all (1)' }));

      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'requirements.md' })).not.toBeInTheDocument());
      await waitFor(() =>
        expect(session.delivered).toEqual([`1. > \`${file.path}\`\n   > The owner\n\n   Which owner`]),
      );
    });
  });
});
