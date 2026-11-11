// HTTP API for the Device panel. t3code served these as WebSocket RPCs plus an HTTP hub proxy;
// here they are plain JSON routes, an SSE state stream, and the same whitelisted proxy.
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';

import {
  DeviceActionInput,
  DeviceCloseInput,
  DeviceConfigureInput,
  DeviceDetailInput,
  type DeviceErrorBody,
  DeviceListInput,
  DeviceOpenInput,
  type DeviceServiceState,
  DeviceShutdownInput,
  isDeviceError,
} from '../contracts.ts';
import { parseHubPath, proxyDeviceHubRequest } from './DeviceHubProxy.ts';
import { DeviceHostAmbiguousError, DeviceOnOtherHostError, type DeviceService } from './DeviceService.ts';

export interface DeviceRoutesOptions {
  /** Where the returned app is mounted, e.g. `/api/device`. The hub proxy is `{basePath}/hub`. */
  readonly basePath: string;
  /** Used for hub requests. Defaults to the global fetch. */
  readonly fetch?: typeof fetch;
}

const STATUS_BY_TAG: Record<string, ContentfulStatusCode> = {
  DeviceHostUnavailableError: 503,
  DevicePlatformUnavailableError: 409,
  DeviceNotFoundError: 404,
  DeviceBootError: 500,
  DeviceOperationError: 502,
  DeviceActionUnavailableError: 422,
  DeviceToolUnavailableError: 503,
  DeviceHostAmbiguousError: 409,
  DeviceOnOtherHostError: 409,
};

/** The HTTP status and `{ _tag, message }` body for a failed device call. */
export const deviceErrorResponse = (error: unknown): { status: ContentfulStatusCode; body: DeviceErrorBody } => {
  if (isDeviceError(error) || error instanceof DeviceHostAmbiguousError || error instanceof DeviceOnOtherHostError) {
    const status =
      error._tag === 'DeviceOperationError' && error.fields.reason === 'settings_failed'
        ? 500
        : (STATUS_BY_TAG[error._tag] ?? 500);
    return { status, body: { _tag: error._tag, message: error.message } };
  }
  return { status: 500, body: { _tag: 'InternalError', message: 'The device request failed unexpectedly.' } };
};

/**
 * The Device panel's routes. Mount the app at `options.basePath` and call
 * `attachDeviceHubUpgrade` on the HTTP server for the hub's WebSockets.
 */
export const createDeviceRoutes = (service: DeviceService, options: DeviceRoutesOptions) => {
  const basePath = options.basePath.replace(/\/+$/, '');
  const hubBasePath = `${basePath}/hub`;
  const withHubBase = (state: DeviceServiceState): DeviceServiceState => ({ ...state, hubBasePath });
  const app = new Hono();

  app.onError((error, c) => {
    const { status, body } = deviceErrorResponse(error);
    return c.json(body, status);
  });

  const parseBody = async <S extends z.ZodType>(request: Request, schema: S) => {
    let raw: unknown;
    try {
      const text = await request.text();
      raw = text.trim() === '' ? {} : JSON.parse(text);
    } catch {
      return { ok: false as const, message: 'The request body is not valid JSON.' };
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false as const,
        message: parsed.error.issues
          .map((issue) => `${issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}${issue.message}`)
          .join('; '),
      };
    }
    return { ok: true as const, value: parsed.data as z.infer<S> };
  };

  const invalid = (message: string): DeviceErrorBody => ({ _tag: 'InvalidRequest', message });

  app.get('/state', (c) => c.json(withHubBase(service.state())));

  app.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      let lastRevision: number | null = null;
      let queue = Promise.resolve();
      const send = (state: DeviceServiceState) => {
        queue = queue
          .then(async () => {
            if (state.revision === lastRevision || stream.aborted || stream.closed) return;
            lastRevision = state.revision;
            await stream.writeSSE({ event: 'state', data: JSON.stringify(withHubBase(state)) });
          })
          .catch(() => undefined);
      };
      // Subscribe before reading so no change is lost.
      const unsubscribe = service.subscribe(send);
      try {
        send(service.state());
        await new Promise<void>((resolve) => stream.onAbort(resolve));
      } finally {
        unsubscribe();
      }
    }),
  );

  app.post('/list', async (c) => {
    const input = await parseBody(c.req.raw, DeviceListInput);
    if (!input.ok) return c.json(invalid(input.message), 400);
    const state = input.value.updateTool
      ? await service.updateTool(input.value.updateTool)
      : input.value.retryHostId
        ? await service.retryHost(input.value.retryHostId)
        : input.value.inspectOnly
          ? await service.inspect()
          : await service.list();
    return c.json(withHubBase(state));
  });

  app.post('/configure', async (c) => {
    const input = await parseBody(c.req.raw, DeviceConfigureInput);
    if (!input.ok) return c.json(invalid(input.message), 400);
    return c.json(withHubBase(await service.configure(input.value)));
  });

  app.post('/open', async (c) => {
    const input = await parseBody(c.req.raw, DeviceOpenInput);
    if (!input.ok) return c.json(invalid(input.message), 400);
    return c.json(await service.open(input.value));
  });

  app.post('/close', async (c) => {
    const input = await parseBody(c.req.raw, DeviceCloseInput);
    if (!input.ok) return c.json(invalid(input.message), 400);
    await service.close(input.value);
    return c.json(withHubBase(service.state()));
  });

  app.post('/shutdown', async (c) => {
    const input = await parseBody(c.req.raw, DeviceShutdownInput);
    if (!input.ok) return c.json(invalid(input.message), 400);
    await service.shutdown(input.value);
    return c.json(withHubBase(service.state()));
  });

  app.post('/detail', async (c) => {
    const input = await parseBody(c.req.raw, DeviceDetailInput);
    if (!input.ok) return c.json(invalid(input.message), 400);
    return c.json(await service.detail(input.value));
  });

  app.post('/action', async (c) => {
    const input = await parseBody(c.req.raw, DeviceActionInput);
    if (!input.ok) return c.json(invalid(input.message), 400);
    return c.json(await service.action(input.value));
  });

  app.all('/hub/:hostId/*', async (c) => {
    const pathname = new URL(c.req.url).pathname;
    // Mounted elsewhere than `basePath`: take the path after this app's `/hub/` segment.
    const parsed =
      parseHubPath(pathname, hubBasePath) ??
      (pathname.includes('/hub/') ? parseHubPath(pathname.slice(pathname.indexOf('/hub/')), '/hub') : null);
    if (!parsed) return c.text('Not Found', 404);
    return proxyDeviceHubRequest(service, {
      hostId: parsed.hostId,
      hubPath: parsed.hubPath,
      request: c.req.raw,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  });

  return app;
};
