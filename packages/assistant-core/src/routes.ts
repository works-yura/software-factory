/**
 * `/web/assistant/*` (ADR-0051): the person's own assistant in their current organization. The
 * owner is always the caller — `(tenant.orgId, tenant.userId)` — and never comes from the
 * request, so another person's request, note or file is simply not found (404). Every write
 * needs `self.write` (every role has it: a viewer has an assistant too).
 */
import type { RouteAccess, RouteAuth } from '@factory/http';
import { declareAccess } from '@factory/http';
import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';

import { AssistantError } from './errors.ts';
import type { FactoryAccess } from './factory-access.ts';
import { safeReturnPath } from './factory-access.ts';
import type { IncomingFile } from './files.ts';
import { ASSISTANT_MAX_FILES_PER_MESSAGE, isInlineMime } from './files.ts';
import type { AssistantModels } from './ports.ts';
import type { AssistantService } from './service.ts';
import type { AssistantFile, AssistantMessage, AssistantNote, AssistantOwner, AssistantRequest } from './types.ts';

export const ASSISTANT_ROUTE_PREFIX = '/web/assistant';

export interface AssistantRoutesDeps {
  auth: RouteAuth;
  service: AssistantService;
  access: FactoryAccess;
  models: AssistantModels;
}

export function requestWire(request: AssistantRequest) {
  return {
    id: request.id,
    topic: request.topic,
    fromName: request.fromName,
    source: request.source,
    sourceUrl: request.sourceUrl,
    status: request.status,
    factory: request.factory,
    analysing: request.analysing,
    lastError: request.lastError,
    unread: request.unread,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
    closedAt: request.closedAt?.toISOString() ?? null,
  };
}

function messageWire(message: AssistantMessage) {
  return {
    id: message.id,
    author: message.author,
    text: message.text,
    fileIds: message.fileIds,
    createdAt: message.createdAt.toISOString(),
  };
}

function fileWire(file: AssistantFile) {
  return {
    id: file.id,
    name: file.name,
    mime: file.mime,
    size: file.size,
    createdAt: file.createdAt.toISOString(),
    contentUrl: `${ASSISTANT_ROUTE_PREFIX}/files/${file.id}/content`,
  };
}

function noteWire(note: AssistantNote) {
  return {
    id: note.id,
    requestId: note.requestId,
    text: note.text,
    author: note.author,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  };
}

function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function loose(c: unknown): Context {
  return c as Context;
}

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await c.req.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // Fall through to the 400 below.
  }
  throw new AssistantError('invalid_body', 'Send a JSON object.', 400);
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new AssistantError('invalid_body', `${key} must be text.`, 400);
  return value;
}

/** A message from the panel: JSON, or multipart with `text`, `fromName`, `sourceUrl` and `files`. */
async function messageBody(c: Context, maxFileBytes: number) {
  const type = c.req.header('content-type') ?? '';
  if (!type.startsWith('multipart/form-data')) {
    const body = await jsonBody(c);
    return {
      text: optionalString(body, 'text') ?? '',
      fromName: optionalString(body, 'fromName'),
      sourceUrl: optionalString(body, 'sourceUrl'),
      files: [] as IncomingFile[],
    };
  }
  const declared = Number(c.req.header('content-length'));
  if (Number.isFinite(declared) && declared > maxFileBytes * ASSISTANT_MAX_FILES_PER_MESSAGE + 1024 * 1024) {
    throw new AssistantError('file_too_large', 'The files are larger than the limit.', 413);
  }
  const form = await c.req.parseBody({ all: true });
  const field = (key: string) => {
    const value = form[key];
    return typeof value === 'string' ? value : undefined;
  };
  const raw = form.files;
  const entries = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter(
    (entry): entry is File => typeof entry === 'object' && entry !== null && 'arrayBuffer' in entry,
  );
  if (entries.length > ASSISTANT_MAX_FILES_PER_MESSAGE) {
    throw new AssistantError('too_many_files', `Attach at most ${ASSISTANT_MAX_FILES_PER_MESSAGE} files at once.`, 400);
  }
  const files: IncomingFile[] = [];
  for (const entry of entries) {
    if (entry.size > maxFileBytes) throw new AssistantError('file_too_large', `${entry.name} is larger than the limit.`, 413);
    files.push({ name: entry.name || 'file', declaredMime: entry.type || null, bytes: new Uint8Array(await entry.arrayBuffer()) });
  }
  return { text: field('text') ?? '', fromName: field('fromName'), sourceUrl: field('sourceUrl'), files };
}

export class AssistantRoutes {
  readonly #deps: AssistantRoutesDeps;

  constructor(deps: AssistantRoutesDeps) {
    this.#deps = deps;
  }

  async #owner(c: Context): Promise<AssistantOwner> {
    const { auth } = this.#deps;
    await auth.ensureUser(c);
    const tenant = auth.tenant(c);
    if (!tenant) throw new AssistantError('unauthorized', 'Sign in to use the assistant.', 403);
    if (!tenant.orgId) throw new AssistantError('organization_required', 'The assistant lives in an organization.', 403);
    return { orgId: tenant.orgId, userId: tenant.userId };
  }

  /** Runs a handler as the caller; an `AssistantError` becomes its JSON answer. */
  #handle(handler: (c: Context, owner: AssistantOwner) => Promise<Response>) {
    return async (raw: unknown) => {
      const c = loose(raw);
      try {
        const owner = await this.#owner(c);
        return await handler(c, owner);
      } catch (error) {
        if (error instanceof AssistantError) {
          const status = error.code === 'unauthorized' ? 401 : error.status;
          return c.json({ error: error.code, message: error.message }, status);
        }
        throw error;
      }
    };
  }

  routes(): ApiRoute[] {
    return declareAccess(this.#routes(), ASSISTANT_ROUTE_ACCESS);
  }

  #routes(): ApiRoute[] {
    const { service, access, models } = this.#deps;
    const p = ASSISTANT_ROUTE_PREFIX;
    const handle = this.#handle.bind(this);
    return [
      registerApiRoute(`${p}/requests`, {
        method: 'GET',
        handler: handle(async (c, owner) => c.json({ requests: (await service.listRequests(owner)).map(requestWire) })),
      }),
      registerApiRoute(`${p}/requests`, {
        method: 'POST',
        handler: handle(async (c, owner) => {
          const body = await messageBody(c, service.maxFileBytes);
          const request = await service.createRequest(owner, body);
          return c.json({ request: requestWire(request) }, 201);
        }),
      }),
      registerApiRoute(`${p}/requests/:id`, {
        method: 'GET',
        handler: handle(async (c, owner) => {
          const view = await service.openRequest(owner, c.req.param('id') ?? '');
          return c.json({
            request: requestWire(view.request),
            messages: view.messages.map(messageWire),
            files: view.files.map(fileWire),
          });
        }),
      }),
      registerApiRoute(`${p}/requests/:id/messages`, {
        method: 'POST',
        handler: handle(async (c, owner) => {
          const body = await messageBody(c, service.maxFileBytes);
          const request = await service.postMessage(owner, c.req.param('id') ?? '', body);
          return c.json({ request: requestWire(request) }, 201);
        }),
      }),
      registerApiRoute(`${p}/requests/:id/close`, {
        method: 'POST',
        handler: handle(async (c, owner) => c.json({ request: requestWire(await service.close(owner, c.req.param('id') ?? '')) })),
      }),
      registerApiRoute(`${p}/requests/:id/ask`, {
        method: 'POST',
        handler: handle(async (c, owner) => {
          const body = await jsonBody(c);
          const factoryId = optionalString(body, 'factoryId');
          if (!factoryId) throw new AssistantError('invalid_body', 'Name the Factory to ask.', 400);
          const question = optionalString(body, 'question');
          const request = await service.askFactory(owner, c.req.param('id') ?? '', {
            factoryId,
            ...(question !== undefined ? { question } : {}),
          });
          return c.json({ request: requestWire(request) });
        }),
      }),
      registerApiRoute(`${p}/requests/:id/check-answer`, {
        method: 'POST',
        handler: handle(async (c, owner) => {
          const checked = await service.checkFactoryAnswer(owner, c.req.param('id') ?? '');
          return c.json({ answered: checked.answered, request: requestWire(checked.request) });
        }),
      }),
      registerApiRoute(`${p}/requests/:id/hand-over`, {
        method: 'POST',
        handler: handle(async (c, owner) => {
          const body = await jsonBody(c);
          const factoryId = optionalString(body, 'factoryId');
          if (!factoryId) throw new AssistantError('invalid_body', 'Name the Factory to hand the request to.', 400);
          const title = optionalString(body, 'title');
          const request = await service.handOver(owner, c.req.param('id') ?? '', {
            factoryId,
            ...(title !== undefined ? { title } : {}),
          });
          return c.json({ request: requestWire(request) });
        }),
      }),
      registerApiRoute(`${p}/files/:id/content`, {
        method: 'GET',
        handler: handle(async (c, owner) => {
          const { file, content } = await service.openFile(owner, c.req.param('id') ?? '');
          const inline = isInlineMime(file.mime) && c.req.query('download') === undefined;
          return new Response(content, {
            status: 200,
            headers: {
              'content-type': file.mime,
              'content-length': String(file.size),
              'content-disposition': contentDisposition(inline ? 'inline' : 'attachment', file.name),
              'x-content-type-options': 'nosniff',
              'cache-control': 'private, max-age=31536000, immutable',
            },
          });
        }),
      }),
      registerApiRoute(`${p}/notes`, {
        method: 'GET',
        handler: handle(async (c, owner) => c.json({ notes: (await service.listNotes(owner)).map(noteWire) })),
      }),
      registerApiRoute(`${p}/notes`, {
        method: 'POST',
        handler: handle(async (c, owner) => {
          const body = await jsonBody(c);
          const requestId = optionalString(body, 'requestId');
          const note = await service.createNote(owner, { text: optionalString(body, 'text') ?? '', requestId: requestId ?? null });
          return c.json({ note: noteWire(note) }, 201);
        }),
      }),
      registerApiRoute(`${p}/notes/:id`, {
        method: 'PATCH',
        handler: handle(async (c, owner) => {
          const body = await jsonBody(c);
          const note = await service.updateNote(owner, c.req.param('id') ?? '', optionalString(body, 'text') ?? '');
          return c.json({ note: noteWire(note) });
        }),
      }),
      registerApiRoute(`${p}/notes/:id`, {
        method: 'DELETE',
        handler: handle(async (c, owner) => {
          await service.deleteNote(owner, c.req.param('id') ?? '');
          return c.json({ deleted: true });
        }),
      }),
      registerApiRoute(`${p}/settings`, {
        method: 'GET',
        handler: handle(async (c, owner) => c.json({ settings: await service.getSettings(owner) })),
      }),
      registerApiRoute(`${p}/settings`, {
        method: 'PUT',
        handler: handle(async (c, owner) => {
          const body = await jsonBody(c);
          const patch: { modelId?: string | null; retentionDays?: number } = {};
          if ('modelId' in body) {
            if (body.modelId !== null && typeof body.modelId !== 'string') {
              throw new AssistantError('invalid_body', 'modelId must be a model id or null.', 400);
            }
            patch.modelId = body.modelId === '' ? null : (body.modelId as string | null);
          }
          if ('retentionDays' in body) {
            if (typeof body.retentionDays !== 'number') throw new AssistantError('invalid_body', 'retentionDays must be a number.', 400);
            patch.retentionDays = body.retentionDays;
          }
          return c.json({ settings: await service.patchSettings(owner, patch) });
        }),
      }),
      registerApiRoute(`${p}/models`, {
        method: 'GET',
        handler: handle(async (c, owner) => c.json({ models: await models.list(owner) })),
      }),
      registerApiRoute(`${p}/clear`, {
        method: 'POST',
        handler: handle(async (c, owner) => {
          const cleared = await service.clear(owner, { reason: 'cleared_by_person', actorId: owner.userId });
          return c.json({ cleared });
        }),
      }),
      registerApiRoute(`${p}/factories`, {
        method: 'GET',
        handler: handle(async (c, owner) => {
          const status = await access.status(owner);
          const listed = await service.factoriesFor(owner);
          return c.json({ connected: listed.connected, pending: status.pending, factories: listed.factories });
        }),
      }),
      registerApiRoute(`${p}/factory-access/start`, {
        method: 'POST',
        handler: handle(async (c, owner) => {
          const body = await jsonBody(c);
          return c.json(await access.start(owner, optionalString(body, 'returnTo')));
        }),
      }),
      registerApiRoute(`${p}/factory-access/callback`, {
        method: 'GET',
        handler: async raw => {
          const c = loose(raw);
          const back = (path: string, result: string) => {
            const url = new URL(safeReturnPath(path), 'http://placeholder');
            url.searchParams.set('assistantAccess', result);
            return c.redirect(`${url.pathname}${url.search}`, 302);
          };
          let owner: AssistantOwner;
          try {
            owner = await this.#owner(c);
          } catch {
            return back('/', 'signed_out');
          }
          const code = c.req.query('code');
          const state = c.req.query('state') ?? '';
          if (!code) return back('/', c.req.query('error') === 'access_denied' ? 'denied' : 'failed');
          try {
            const { returnTo } = await access.complete(owner, { code, state });
            return back(returnTo, 'connected');
          } catch (error) {
            console.error('[assistant] Allowing Factory access failed:', error instanceof Error ? error.message : String(error));
            return back('/', 'failed');
          }
        },
      }),
      registerApiRoute(`${p}/factory-access`, {
        method: 'DELETE',
        handler: handle(async (c, owner) => {
          await access.disconnect(owner);
          return c.json({ disconnected: true });
        }),
      }),
    ];
  }
}

/** Every write is the person's own (ADR-0045 `self.write`); the callback writes the grant, so it declares too. */
export const ASSISTANT_ROUTE_ACCESS: Readonly<Record<string, RouteAccess>> = {
  'POST /web/assistant/requests': 'self.write',
  'POST /web/assistant/requests/:id/messages': 'self.write',
  'POST /web/assistant/requests/:id/close': 'self.write',
  'POST /web/assistant/requests/:id/ask': 'self.write',
  'POST /web/assistant/requests/:id/check-answer': 'self.write',
  'POST /web/assistant/requests/:id/hand-over': 'self.write',
  'POST /web/assistant/notes': 'self.write',
  'PATCH /web/assistant/notes/:id': 'self.write',
  'DELETE /web/assistant/notes/:id': 'self.write',
  'PUT /web/assistant/settings': 'self.write',
  'POST /web/assistant/clear': 'self.write',
  'POST /web/assistant/factory-access/start': 'self.write',
  'GET /web/assistant/factory-access/callback': 'self.write',
  'DELETE /web/assistant/factory-access': 'self.write',
};

export function buildAssistantRoutes(deps: AssistantRoutesDeps): ApiRoute[] {
  return new AssistantRoutes(deps).routes();
}
