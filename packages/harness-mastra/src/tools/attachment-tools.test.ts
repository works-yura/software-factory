import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { AttachmentService, LocalFileBlobStore, readAttachmentBlob } from '@factory/store';
import { createFactoryStorageForTests } from '@factory/testing';
import type { SourceControlSession } from '@factory/store';
import { createAttachmentTools } from './attachment-tools.ts';
import type { AttachmentToolDependencies } from './attachment-tools.ts';

async function makeService() {
  const root = await mkdtemp(join(tmpdir(), 'factory-attachment-tools-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const blobs = new LocalFileBlobStore({ root });
  await blobs.init();
  const { attachments: records } = await createFactoryStorageForTests();
  return new AttachmentService({ records, blobs });
}

function context(user?: { id: string; organizationId?: string }) {
  const requestContext = new RequestContext();
  if (user) requestContext.set('user', user);
  requestContext.set('controller', {
    sessionId: 'session-1',
    resourceId: 'session-1',
    threadId: 'thread-1',
    getState: () => ({ factoryProjectId: 'project-1' }),
  });
  return requestContext;
}

async function tools(deps: Partial<AttachmentToolDependencies> & { attachments: AttachmentService }, cards: string[] = ['card-1']) {
  const created = await createAttachmentTools({
    requestContext: context({ id: 'user-1', organizationId: 'org-1' }),
    deps: {
      workItems: { listWorkItemIdsForSession: async () => cards },
      sessions: { getBySessionId: async () => ({ id: 'row-1' }) as SourceControlSession },
      ...deps,
    },
  });
  const tool = created.factory_list_attachments as { execute: (input: unknown, context: unknown) => Promise<any> };
  return (input = {}) => tool.execute(input, {});
}

const ingest = (service: AttachmentService, owner: Parameters<AttachmentService['ingest']>[0]['owner'], name: string, text: string) =>
  service.ingest({
    orgId: 'org-1',
    owner,
    name,
    body: new TextEncoder().encode(text),
    source: 'chat',
    addedBy: 'user-1',
  });

describe('factory_list_attachments', () => {
  it('lists the card’s and the session’s own files and places them in the sandbox', async () => {
    const attachments = await makeService();
    const brief = await ingest(attachments, { workItemId: 'card-1', factoryProjectId: 'project-1' }, 'brief.md', '# Brief');
    await ingest(attachments, { workItemId: 'card-2', factoryProjectId: 'project-1' }, 'other.md', 'not mine');
    await ingest(attachments, { sessionId: 'session-1', factoryProjectId: 'project-1' }, 'note.txt', 'session note');
    const placed: Array<{ path: string; text: string }> = [];
    const materialize = vi.fn(async (input: Parameters<NonNullable<AttachmentToolDependencies['materialize']>>[0]) => {
      for (const file of input.attachments) {
        placed.push({ path: file.sandboxPath, text: (await readAttachmentBlob(await file.open())).toString() });
      }
      return { root: '/work/card', written: [] };
    });

    const result = await (await tools({ attachments, materialize }))();

    expect(materialize).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'row-1' }));
    expect(result).toEqual({
      folder: '/work/card',
      placed: true,
      attachments: [
        expect.objectContaining({
          name: 'brief.md',
          path: `.factory/attachments/${brief.id.slice(0, 8)}-brief.md`,
          mime: 'text/markdown',
          size: 7,
          source: 'chat',
          attachedTo: 'card',
        }),
        expect.objectContaining({ name: 'note.txt', attachedTo: 'session' }),
      ],
    });
    expect(placed.map(file => file.text)).toEqual(['# Brief', 'session note']);
  });

  it('says so when the files could not be placed', async () => {
    const attachments = await makeService();
    await ingest(attachments, { workItemId: 'card-1', factoryProjectId: 'project-1' }, 'brief.md', '# Brief');
    const failing = await tools({
      attachments,
      materialize: async () => {
        throw new Error('Session row-1 has no sandbox in this process yet');
      },
    });
    expect(await failing()).toMatchObject({ placed: false, reason: expect.stringMatching(/no sandbox/) });

    const rowless = await tools({ attachments, sessions: { getBySessionId: async () => null } });
    expect(await rowless()).toMatchObject({ placed: false, attachments: [expect.objectContaining({ name: 'brief.md' })] });
  });

  it('refuses a session bound to several cards, and is absent without an organization', async () => {
    const attachments = await makeService();
    await expect((await tools({ attachments }, ['card-1', 'card-2']))()).rejects.toThrow(/several cards/);
    const none = await createAttachmentTools({
      requestContext: context({ id: 'user-1' }),
      deps: {
        attachments,
        workItems: { listWorkItemIdsForSession: async () => [] },
        sessions: { getBySessionId: async () => null },
      },
    });
    expect(none).toEqual({});
  });
});
