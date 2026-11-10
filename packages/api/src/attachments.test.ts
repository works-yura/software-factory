import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LibSQLFactoryStorage } from '@mastra/libsql';
import { Hono } from 'hono';
import { describe, expect, it, onTestFinished } from 'vitest';

import { fakeRouteAuth, mountApiRoutes } from '@factory/http/testing';
import type { TestAuthUser } from '@factory/http/testing';
import { AttachmentService, AttachmentsStorage, LocalFileBlobStore } from '@factory/store';
import type { SourceControlSession } from '@factory/store';
import { AttachmentRoutes } from './attachments.ts';

const CARD = '11111111-1111-4111-8111-111111111111';
const OTHER_CARD = '22222222-2222-4222-8222-222222222222';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);

const alice: TestAuthUser = { id: 'alice', organizationId: 'org-1' };
const bob: TestAuthUser = { id: 'bob', organizationId: 'org-1' };
const mallory: TestAuthUser = { id: 'mallory', organizationId: 'org-2' };

async function makeApp(options: { maxBytes?: number; configured?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'factory-attachment-routes-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const blobs = new LocalFileBlobStore({ root });
  await blobs.init();
  const storage = new LibSQLFactoryStorage({ id: 'attachment-routes-test', url: ':memory:' });
  const records = storage.registerDomain(new AttachmentsStorage());
  await storage.init();
  onTestFinished(() => storage.close());
  const service = new AttachmentService({ records, blobs, ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}) });

  const cards = new Map([[`org-1/${CARD}`, { id: CARD, factoryProjectId: 'project-1' }]]);
  const sessions = new Map<string, Partial<SourceControlSession>>([
    ['shared-session', { orgId: 'org-1', userId: 'alice', visibility: 'shared' as never, factoryProjectId: 'project-1' }],
    ['private-session', { orgId: 'org-1', userId: 'alice', visibility: 'private', factoryProjectId: 'project-1' }],
  ]);

  let user: TestAuthUser | undefined = alice;
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (user) c.set('factoryAuthUser' as never, user as never);
    await next();
  });
  mountApiRoutes(
    app,
    new AttachmentRoutes({
      auth: fakeRouteAuth(),
      workItems: {
        ensureReady: async () => {},
        get: (async ({ orgId, id }: { orgId: string; id: string }) => cards.get(`${orgId}/${id}`) ?? null) as never,
      },
      sessions: { getBySessionId: async id => (sessions.get(id) as SourceControlSession | undefined) ?? null },
      ...(options.configured === false ? {} : { attachments: service }),
    }).routes(),
  );
  return {
    app,
    blobs,
    as: (next: TestAuthUser | undefined) => {
      user = next;
    },
  };
}

const upload = (app: Hono, path: string, body: BodyInit, query = 'name=screen.png&source=chat', type = 'image/png') =>
  app.request(`${path}?${query}`, { method: 'POST', body, headers: { 'content-type': type } });

describe('AttachmentRoutes', () => {
  it('uploads, lists, downloads and deletes a card attachment', async () => {
    const { app, blobs } = await makeApp();
    const created = await upload(app, `/web/factory/work-items/${CARD}/attachments`, PNG);
    expect(created.status).toBe(201);
    const { attachment } = (await created.json()) as { attachment: Record<string, string> };
    expect(attachment).toMatchObject({ workItemId: CARD, name: 'screen.png', mime: 'image/png', size: PNG.length, source: 'chat' });
    expect(attachment.sandboxPath).toBe(`.factory/attachments/${attachment.id!.slice(0, 8)}-screen.png`);

    const listed = await (await app.request(`/web/factory/work-items/${CARD}/attachments`)).json();
    expect((listed as { attachments: unknown[] }).attachments).toHaveLength(1);

    const content = await app.request(attachment.contentUrl!);
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toBe('image/png');
    expect(content.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(content.headers.get('x-content-type-options')).toBe('nosniff');
    expect([...new Uint8Array(await content.arrayBuffer())]).toEqual([...PNG]);
    const download = await app.request(`${attachment.contentUrl}?download`);
    expect(download.headers.get('content-disposition')).toMatch(/^attachment;/);

    expect((await app.request(`/web/factory/attachments/${attachment.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await blobs.head(attachment.sha256!)).toBeNull();
    expect((await app.request(attachment.contentUrl!)).status).toBe(404);
  });

  it('downloads anything but safe types, with a UTF-8 file name', async () => {
    const { app } = await makeApp();
    const created = await upload(
      app,
      `/web/factory/work-items/${CARD}/attachments`,
      '<svg onload="alert(1)"/>',
      `name=${encodeURIComponent('Бриф клієнта.svg')}`,
      'image/svg+xml',
    );
    const { attachment } = (await created.json()) as { attachment: { contentUrl: string; source: string } };
    expect(attachment.source).toBe('upload');
    const content = await app.request(attachment.contentUrl);
    expect(content.headers.get('content-disposition')).toBe(
      `attachment; filename="____ _______.svg"; filename*=UTF-8''${encodeURIComponent('Бриф клієнта.svg')}`,
    );
  });

  it('refuses files over the limit, by header and by streamed size', async () => {
    const { app } = await makeApp({ maxBytes: 4 });
    const response = await upload(app, `/web/factory/work-items/${CARD}/attachments`, PNG);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'attachment_too_large', maxBytes: 4 });
    const streamed = await app.request(`/web/factory/work-items/${CARD}/attachments?name=x.png`, {
      method: 'POST',
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(PNG);
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);
    expect(streamed.status).toBe(413);
    const listed = await (await app.request(`/web/factory/work-items/${CARD}/attachments`)).json();
    expect(listed).toEqual({ attachments: [] });
  });

  it('keeps cards and attachments to their organization', async () => {
    const { app, as } = await makeApp();
    const created = await upload(app, `/web/factory/work-items/${CARD}/attachments`, PNG);
    const { attachment } = (await created.json()) as { attachment: { id: string; contentUrl: string } };

    expect((await upload(app, `/web/factory/work-items/${OTHER_CARD}/attachments`, PNG)).status).toBe(404);
    as(mallory);
    expect((await app.request(`/web/factory/work-items/${CARD}/attachments`)).status).toBe(404);
    expect((await app.request(attachment.contentUrl)).status).toBe(404);
    expect((await app.request(`/web/factory/attachments/${attachment.id}`, { method: 'DELETE' })).status).toBe(404);
    as(undefined);
    expect((await app.request(`/web/factory/work-items/${CARD}/attachments`)).status).toBe(401);
    as({ id: 'loner' });
    expect((await app.request(`/web/factory/work-items/${CARD}/attachments`)).status).toBe(403);
  });

  it('holds a session’s own attachments, visible as the session is', async () => {
    const { app, as } = await makeApp();
    const created = await upload(app, '/web/factory/sessions/private-session/attachments', PNG);
    expect(created.status).toBe(201);
    const { attachment } = (await created.json()) as { attachment: { contentUrl: string; sessionId: string } };
    expect(attachment.sessionId).toBe('private-session');
    expect((await upload(app, '/web/factory/sessions/alice/attachments', PNG)).status).toBe(201);

    as(bob);
    expect((await app.request('/web/factory/sessions/private-session/attachments')).status).toBe(404);
    expect((await app.request(attachment.contentUrl)).status).toBe(404);
    expect((await upload(app, '/web/factory/sessions/shared-session/attachments', PNG)).status).toBe(201);
    expect((await upload(app, '/web/factory/sessions/alice/attachments', PNG)).status).toBe(404);
  });

  it('validates the upload query and answers 503 without a store', async () => {
    const { app } = await makeApp();
    expect((await upload(app, `/web/factory/work-items/${CARD}/attachments`, PNG, 'name=')).status).toBe(400);
    expect((await upload(app, `/web/factory/work-items/${CARD}/attachments`, PNG, 'name=a&source=ftp')).status).toBe(400);
    const unconfigured = await makeApp({ configured: false });
    const response = await unconfigured.app.request(`/web/factory/work-items/${CARD}/attachments`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'attachments_unconfigured' });
  });
});
