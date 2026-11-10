import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { File as NodeFile } from 'node:buffer';

import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import { releaseSession, renderThread, SESSION_ID, stubPreparingSession } from './composer-session-test-fixture';
import type { PreparingSession } from './composer-session-test-fixture';

/**
 * A file `fetch` can send: jsdom's own `File` is not a body Node's `fetch` reads, while a browser's
 * is. The composer passes the picked file through as the request body either way.
 */
const pickedFile = (parts: string[], name: string, type: string) =>
  new NodeFile(parts, name, { type }) as unknown as File;

interface Upload {
  path: string;
  name: string | null;
  source: string | null;
  type: string | null;
  text: string;
}

function stubUploads(options: { fail?: boolean } = {}) {
  const uploads: Upload[] = [];
  server.use(
    http.post(`${TEST_BASE_URL}/web/factory/sessions/:sessionId/attachments`, async ({ request, params }) => {
      const url = new URL(request.url);
      const text = await request.text();
      uploads.push({
        path: `sessions/${String(params.sessionId)}`,
        name: url.searchParams.get('name'),
        source: url.searchParams.get('source'),
        type: request.headers.get('content-type'),
        text,
      });
      if (options.fail) return HttpResponse.json({ error: 'attachment_too_large', maxBytes: 4 }, { status: 413 });
      const name = url.searchParams.get('name') ?? 'file';
      return HttpResponse.json(
        {
          attachment: {
            id: `aaaaaaa${uploads.length}-0000-4000-8000-000000000000`,
            workItemId: null,
            sessionId: String(params.sessionId),
            name,
            mime: request.headers.get('content-type') ?? 'application/octet-stream',
            size: text.length,
            sha256: 'f'.repeat(64),
            source: 'chat',
            sourceUrl: null,
            addedBy: 'user-1',
            addedAt: '2026-11-10T10:00:00.000Z',
            contentUrl: `/web/factory/attachments/aaaaaaa${uploads.length}-0000-4000-8000-000000000000/content`,
            sandboxPath: `.factory/attachments/aaaaaaa${uploads.length}-${name}`,
          },
        },
        { status: 201 },
      );
    }),
  );
  return uploads;
}

describe('Composer: attaching files', () => {
  let user: UserEvent;
  let session: PreparingSession;

  async function render() {
    session = stubPreparingSession();
    const { client } = renderThread();
    await releaseSession(session.finishWorkspace, client);
  }

  beforeEach(() => {
    user = userEvent.setup();
  });

  it('accepts any file, stores it on the session and names it in the message', async () => {
    await render();
    // After the session fixture, so these handlers take precedence over its default upload.
    const uploads = stubUploads();
    await user.upload(
      screen.getByLabelText('Attach files', { selector: 'input' }),
      pickedFile(['%PDF-'], 'brief.pdf', 'application/pdf'),
    );
    expect(await screen.findByText('brief.pdf')).toBeInTheDocument();

    await user.click(screen.getByRole('textbox', { name: 'Message' }));
    await user.keyboard('Here is the brief');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() =>
      expect(session.delivered).toEqual([
        'Here is the brief\n\nВкладення: brief.pdf (5 B) → .factory/attachments/aaaaaaa1-brief.pdf',
      ]),
    );
    expect(uploads).toEqual([
      { path: `sessions/${SESSION_ID}`, name: 'brief.pdf', source: 'chat', type: 'application/pdf', text: '%PDF-' },
    ]);
    expect(screen.queryByText('brief.pdf')).not.toBeInTheDocument();
  });

  it('keeps the file in the composer when the upload fails, and sends nothing', async () => {
    await render();
    const uploads = stubUploads({ fail: true });
    await user.upload(
      screen.getByLabelText('Attach files', { selector: 'input' }),
      pickedFile(['too big'], 'video.mp4', 'video/mp4'),
    );
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(uploads).toHaveLength(1));
    expect(await screen.findByText('video.mp4')).toBeInTheDocument();
    expect(session.delivered).toEqual([]);
  });
});
