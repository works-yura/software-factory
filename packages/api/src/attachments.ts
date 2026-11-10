/**
 * Card (and session) attachments: upload, list, download, delete.
 *
 * An upload is the raw file as the request body (streamed into the blob store, never buffered whole),
 * named by the `name` query parameter, typed by its `Content-Type` and checked against its signature.
 * A card's attachments are the card's organization's; a session's own (for a session that works no
 * card) are visible to whoever may view the session.
 */

import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';

import { attachmentQuerySchema } from '@factory/contracts';
import type { RouteDependencies } from '@factory/http';
import { Route } from '@factory/http';
import { canViewSourceControlSession } from '@factory/session';
import {
  attachmentSandboxPath,
  AttachmentTooLargeError,
  isInlineAttachmentMime,
} from '@factory/store';
import type { AttachmentOwner, AttachmentRecord, AttachmentService, SourceControlSession, WorkItemsStorage } from '@factory/store';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SESSION_ID_LENGTH = 512;

export interface AttachmentRoutesDeps extends RouteDependencies {
  /** Absent when the deployment configured no attachment store: every route answers 503. */
  attachments?: AttachmentService;
  workItems: Pick<WorkItemsStorage, 'ensureReady' | 'get'>;
  /** The session's row, to check the caller may see it; `null` for a session with none. */
  sessions: { getBySessionId(sessionId: string): Promise<SourceControlSession | null> };
}

interface Tenant {
  orgId: string;
  userId: string;
}

/** An attachment as the browser and the agent tools see it. */
export function toWireAttachment(record: AttachmentRecord) {
  return {
    id: record.id,
    workItemId: record.workItemId,
    sessionId: record.sessionId,
    name: record.name,
    mime: record.mime,
    size: record.size,
    sha256: record.sha256,
    source: record.source,
    sourceUrl: record.sourceUrl,
    addedBy: record.addedBy,
    addedAt: record.addedAt.toISOString(),
    contentUrl: `/web/factory/attachments/${record.id}/content`,
    sandboxPath: attachmentSandboxPath(record),
  };
}

function loose(c: unknown): Context {
  return c as Context;
}

/** RFC 6266 `filename*` so any name (Cyrillic included) survives, with an ASCII fallback. */
function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export class AttachmentRoutes extends Route<AttachmentRoutesDeps> {
  async #tenant(c: Context): Promise<Tenant | { response: Response }> {
    const { auth } = this.deps;
    await auth.ensureUser(c);
    const tenant = auth.tenant(c);
    if (!tenant) return { response: c.json({ error: 'unauthorized' }, 401) };
    if (!tenant.orgId) {
      return { response: c.json({ error: 'organization_required', message: 'Attachments require an organization.' }, 403) };
    }
    return { orgId: tenant.orgId, userId: tenant.userId };
  }

  #service(c: Context): AttachmentService | { response: Response } {
    const { attachments } = this.deps;
    if (!attachments) {
      return {
        response: c.json(
          { error: 'attachments_unconfigured', message: 'This Factory has no attachment store configured.' },
          503,
        ),
      };
    }
    return attachments;
  }

  async #cardOwner(c: Context, tenant: Tenant): Promise<AttachmentOwner | { response: Response }> {
    const workItemId = c.req.param('workItemId');
    if (!workItemId || !UUID_RE.test(workItemId)) return { response: c.json({ error: 'Work item not found' }, 404) };
    await this.deps.workItems.ensureReady();
    const item = await this.deps.workItems.get({ orgId: tenant.orgId, id: workItemId });
    if (!item) return { response: c.json({ error: 'Work item not found' }, 404) };
    return { workItemId: item.id, factoryProjectId: item.factoryProjectId };
  }

  async #sessionOwner(c: Context, tenant: Tenant): Promise<AttachmentOwner | { response: Response }> {
    const sessionId = c.req.param('sessionId');
    const notFound = { response: c.json({ error: 'Session not found' }, 404) };
    if (!sessionId || sessionId.length > MAX_SESSION_ID_LENGTH) return notFound;
    const row = await this.deps.sessions.getBySessionId(sessionId);
    if (row) {
      if (!canViewSourceControlSession(row, tenant)) return notFound;
      return { sessionId, factoryProjectId: row.factoryProjectId };
    }
    // A personal session is addressed by its person's own id and has no row.
    if (sessionId === tenant.userId) return { sessionId, factoryProjectId: null };
    return notFound;
  }

  async #list(c: Context, owner: 'card' | 'session') {
    const tenant = await this.#tenant(c);
    if ('response' in tenant) return tenant.response;
    const service = this.#service(c);
    if ('response' in service) return service.response;
    const resolved = owner === 'card' ? await this.#cardOwner(c, tenant) : await this.#sessionOwner(c, tenant);
    if ('response' in resolved) return resolved.response;
    await service.records.ensureReady();
    const records = resolved.workItemId
      ? await service.records.listForWorkItem({ orgId: tenant.orgId, workItemId: resolved.workItemId })
      : await service.records.listForSession({ orgId: tenant.orgId, sessionId: resolved.sessionId! });
    return c.json({ attachments: records.map(toWireAttachment) });
  }

  async #upload(c: Context, owner: 'card' | 'session') {
    const tenant = await this.#tenant(c);
    if ('response' in tenant) return tenant.response;
    const service = this.#service(c);
    if ('response' in service) return service.response;
    const query = attachmentQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ error: 'invalid_request', message: query.error.issues[0]?.message ?? 'Invalid upload.' }, 400);
    }
    const declaredLength = Number(c.req.header('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > service.maxBytes) {
      return c.json({ error: 'attachment_too_large', maxBytes: service.maxBytes }, 413);
    }
    const body = c.req.raw.body;
    if (!body) return c.json({ error: 'invalid_request', message: 'The file is the request body.' }, 400);
    const resolved = owner === 'card' ? await this.#cardOwner(c, tenant) : await this.#sessionOwner(c, tenant);
    if ('response' in resolved) return resolved.response;
    try {
      const record = await service.ingest({
        orgId: tenant.orgId,
        owner: resolved,
        name: query.data.name,
        declaredMime: c.req.header('content-type') ?? null,
        body,
        source: query.data.source,
        sourceUrl: query.data.sourceUrl ?? null,
        addedBy: tenant.userId,
      });
      return c.json({ attachment: toWireAttachment(record) }, 201);
    } catch (error) {
      if (error instanceof AttachmentTooLargeError) {
        return c.json({ error: 'attachment_too_large', maxBytes: error.maxBytes }, 413);
      }
      throw error;
    }
  }

  routes(): ApiRoute[] {
    return [
      registerApiRoute('/web/factory/work-items/:workItemId/attachments', {
        method: 'GET',
        handler: async c => this.#list(loose(c), 'card'),
      }),
      registerApiRoute('/web/factory/work-items/:workItemId/attachments', {
        method: 'POST',
        handler: async c => this.#upload(loose(c), 'card'),
      }),
      registerApiRoute('/web/factory/sessions/:sessionId/attachments', {
        method: 'GET',
        handler: async c => this.#list(loose(c), 'session'),
      }),
      registerApiRoute('/web/factory/sessions/:sessionId/attachments', {
        method: 'POST',
        handler: async c => this.#upload(loose(c), 'session'),
      }),
      registerApiRoute('/web/factory/attachments/:id/content', {
        method: 'GET',
        handler: async cc => {
          const c = loose(cc);
          const tenant = await this.#tenant(c);
          if ('response' in tenant) return tenant.response;
          const service = this.#service(c);
          if ('response' in service) return service.response;
          const id = c.req.param('id');
          if (!id || !UUID_RE.test(id)) return c.json({ error: 'Attachment not found' }, 404);
          const opened = await service.open({ orgId: tenant.orgId, id });
          if (!opened || !(await this.#canSee(tenant, opened.record))) {
            await opened?.content.cancel();
            return c.json({ error: 'Attachment not found' }, 404);
          }
          const { record, content } = opened;
          const inline = isInlineAttachmentMime(record.mime) && c.req.query('download') === undefined;
          return new Response(content, {
            status: 200,
            headers: {
              'content-type': record.mime,
              'content-length': String(record.size),
              'content-disposition': contentDisposition(inline ? 'inline' : 'attachment', record.name),
              'x-content-type-options': 'nosniff',
              'cache-control': 'private, max-age=31536000, immutable',
              etag: `"${record.sha256}"`,
            },
          });
        },
      }),
      registerApiRoute('/web/factory/attachments/:id', {
        method: 'DELETE',
        handler: async cc => {
          const c = loose(cc);
          const tenant = await this.#tenant(c);
          if ('response' in tenant) return tenant.response;
          const service = this.#service(c);
          if ('response' in service) return service.response;
          const id = c.req.param('id');
          if (!id || !UUID_RE.test(id)) return c.json({ error: 'Attachment not found' }, 404);
          await service.records.ensureReady();
          const record = await service.records.get({ orgId: tenant.orgId, id });
          if (!record || !(await this.#canSee(tenant, record))) return c.json({ error: 'Attachment not found' }, 404);
          await service.remove({ orgId: tenant.orgId, id });
          return c.json({ deleted: true });
        },
      }),
    ];
  }

  /** A card's attachment is its organization's; a session's own follows the session's visibility. */
  async #canSee(tenant: Tenant, record: AttachmentRecord): Promise<boolean> {
    if (record.orgId !== tenant.orgId) return false;
    if (!record.sessionId) return true;
    const row = await this.deps.sessions.getBySessionId(record.sessionId);
    if (row) return canViewSourceControlSession(row, tenant);
    return record.sessionId === tenant.userId;
  }
}
