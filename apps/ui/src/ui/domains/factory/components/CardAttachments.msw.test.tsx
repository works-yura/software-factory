import { File as NodeFile } from 'node:buffer';

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../e2e/ui/render';
import type { Attachment } from '../services/attachments';
import { CardAttachments } from './CardAttachments';

const ITEM_ID = '11111111-1111-4111-8111-111111111111';
const LIST_URL = `${TEST_BASE_URL}/web/factory/work-items/${ITEM_ID}/attachments`;

function attachment(id: string, name: string, overrides: Partial<Attachment> = {}): Attachment {
  return {
    id,
    workItemId: ITEM_ID,
    sessionId: null,
    name,
    mime: 'application/pdf',
    size: 1536,
    sha256: 'f'.repeat(64),
    source: 'chat',
    sourceUrl: null,
    addedBy: 'user-1',
    addedAt: '2026-11-10T10:00:00.000Z',
    contentUrl: `/web/factory/attachments/${id}/content`,
    sandboxPath: `.factory/attachments/${id.slice(0, 8)}-${name}`,
    ...overrides,
  };
}

function stubFiles(initial: Attachment[]) {
  let files = [...initial];
  const deleted: string[] = [];
  const uploaded: string[] = [];
  server.use(
    http.get(LIST_URL, () => HttpResponse.json({ attachments: files })),
    http.post(LIST_URL, ({ request }) => {
      const url = new URL(request.url);
      const name = url.searchParams.get('name') ?? 'file';
      uploaded.push(`${name}:${url.searchParams.get('source')}`);
      const created = attachment('cccccccc-0000-4000-8000-000000000000', name, { source: 'upload', size: 3 });
      files = [...files, created];
      return HttpResponse.json({ attachment: created }, { status: 201 });
    }),
    http.delete(`${TEST_BASE_URL}/web/factory/attachments/:id`, ({ params }) => {
      deleted.push(String(params.id));
      files = files.filter(file => file.id !== params.id);
      return HttpResponse.json({ deleted: true });
    }),
  );
  return { deleted, uploaded };
}

describe('CardAttachments', () => {
  it('lists the card’s files with their source and size, and links each to its content', async () => {
    stubFiles([
      attachment('aaaaaaaa-0000-4000-8000-000000000000', 'brief.pdf'),
      attachment('dddddddd-0000-4000-8000-000000000000', 'logo.png', { mime: 'image/png', source: 'comment', size: 20 }),
    ]);
    renderWithProviders(<CardAttachments workItemId={ITEM_ID} enabled />);

    const section = await screen.findByRole('region', { name: 'Files' });
    const brief = await within(section).findByRole('link', { name: /^brief\.pdf/ });
    expect(brief).toHaveAttribute('href', `${TEST_BASE_URL}/web/factory/attachments/aaaaaaaa-0000-4000-8000-000000000000/content`);
    expect(within(brief).getByText('1.5 KB')).toBeInTheDocument();
    expect(within(brief).getByText('From chat')).toBeInTheDocument();
    expect(within(section).getByText('From a comment')).toBeInTheDocument();
    expect(within(section).getByRole('link', { name: 'Download brief.pdf' })).toHaveAttribute(
      'href',
      `${TEST_BASE_URL}/web/factory/attachments/aaaaaaaa-0000-4000-8000-000000000000/content?download`,
    );
  });

  it('uploads picked files and deletes one', async () => {
    const calls = stubFiles([attachment('aaaaaaaa-0000-4000-8000-000000000000', 'brief.pdf')]);
    const user = userEvent.setup();
    renderWithProviders(<CardAttachments workItemId={ITEM_ID} enabled />);
    await screen.findByText('brief.pdf');

    const file = new NodeFile(['abc'], 'notes.txt', { type: 'text/plain' }) as unknown as File;
    await user.upload(screen.getByLabelText('Attach files', { selector: 'input' }), file);
    expect(await screen.findByText('notes.txt')).toBeInTheDocument();
    expect(calls.uploaded).toEqual(['notes.txt:upload']);

    await user.click(screen.getByRole('button', { name: 'Delete brief.pdf' }));
    await waitFor(() => expect(screen.queryByText('brief.pdf')).not.toBeInTheDocument());
    expect(calls.deleted).toEqual(['aaaaaaaa-0000-4000-8000-000000000000']);
  });

  it('says when there are no files', async () => {
    stubFiles([]);
    renderWithProviders(<CardAttachments workItemId={ITEM_ID} enabled />);
    expect(await screen.findByText('No files yet')).toBeInTheDocument();
  });
});
