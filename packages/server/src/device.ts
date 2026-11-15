/**
 * Device preview (`@factory/device`) mounted on Factory's server: the device routes under
 * `/web/device`, and the hub's WebSockets on the HTTP server the host runs.
 *
 * The device service drives simulators and emulators on the machine the server runs on, so a
 * host only turns it on where that machine is the person's own (local development).
 */
import type { IncomingMessage, Server } from 'node:http';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';

import { join } from 'node:path';

import type { RouteAuth } from '@factory/http';
import type { IntegrationTools } from '@factory/integrations';
import {
  attachDeviceHubUpgrade,
  createDeviceAgentTools,
  createDeviceRoutes,
  createDeviceService,
} from '@factory/device/server';
import type { DeviceServiceInternals } from '@factory/device/server';
import type { RequestContext } from '@mastra/core/request-context';
import type { ApiRoute } from '@mastra/core/server';
import { withAccess } from '@factory/http';
import { registerApiRoute } from '@mastra/core/server';
import { Hono } from 'hono';

import { createFactoryDeviceAgentTools } from './device-agent-tools.ts';

/** Where the device routes live; the hub proxy is `{DEVICE_BASE_PATH}/hub`. */
export const DEVICE_BASE_PATH = '/web/device';

export interface FactoryDeviceConfig {
  /** Device state and installed tools (`expo-device-hub`, `agent-device`). */
  stateDir: string;
}

export interface FactoryDevice {
  routes: ApiRoute[];
  /** Serves the hub's WebSocket upgrades on `server`; other upgrades still reach their listeners. */
  attach(server: Server): () => void;
  /** The session's device tools (list, open, screenshot, close), on the same device service as the panel. */
  agentTools(requestContext: RequestContext | undefined): IntegrationTools;
  dispose(): Promise<void>;
}

export async function createFactoryDevice(config: FactoryDeviceConfig, auth: RouteAuth): Promise<FactoryDevice> {
  const service: DeviceServiceInternals = await createDeviceService({
    stateDir: config.stateDir,
    hubBasePath: `${DEVICE_BASE_PATH}/hub`,
  });
  const agentTools = createDeviceAgentTools(service);
  // The device routes are relative; mounting them at the base path matches the request URLs.
  const app = new Hono().route(DEVICE_BASE_PATH, createDeviceRoutes(service, { basePath: DEVICE_BASE_PATH }));

  // Upgrades skip the Hono gate, so they are signed in the same way the gated routes are.
  const gate = new Hono().all('*', async c => {
    if (!auth.enabled()) return c.body(null, 204);
    return (await auth.ensureUser(c)) ? c.body(null, 204) : c.body(null, 401);
  });
  const authorize = async (request: IncomingMessage) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
    }
    const response = await gate.fetch(
      new Request(`http://${request.headers.host ?? '127.0.0.1'}${request.url ?? '/'}`, { headers }),
    );
    return response.status === 204;
  };

  return {
    routes: [
      // Driving a simulator or emulator is session work.
      withAccess(
        'session.write',
        registerApiRoute(`${DEVICE_BASE_PATH}/*`, {
          method: 'ALL',
          handler: c => app.fetch(c.req.raw),
        }),
      ),
    ],
    attach(server) {
      // `attachDeviceHubUpgrade` listens on an emitter of its own; this listener hands it device
      // paths only, so a listener that refuses unknown paths (Mastra's browser stream) never sees them.
      const relay = new EventEmitter();
      const detach = attachDeviceHubUpgrade(relay as unknown as Server, {
        service,
        basePath: DEVICE_BASE_PATH,
        authorize,
      });
      const others = server.listeners('upgrade') as ((...args: unknown[]) => void)[];
      server.removeAllListeners('upgrade');
      const dispatch = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        const path = (request.url ?? '/').split('?')[0]!;
        if (path.startsWith(`${DEVICE_BASE_PATH}/hub/`)) {
          relay.emit('upgrade', request, socket, head);
          return;
        }
        for (const listener of others) listener.call(server, request, socket, head);
      };
      server.on('upgrade', dispatch);
      return () => {
        detach();
        server.off('upgrade', dispatch);
        for (const listener of others) server.on('upgrade', listener);
      };
    },
    agentTools: requestContext =>
      createFactoryDeviceAgentTools({
        tools: agentTools,
        screenshotDir: join(config.stateDir, 'screenshots'),
        requestContext,
      }),
    dispose: () => service.dispose(),
  };
}

const REQUEST_START = 'http.server.request.start';

/**
 * Calls `attach` with the HTTP server once it serves its first request. For hosts whose
 * framework creates the server out of reach (Mastra's deployer): the browser loads the page and
 * its API before it opens a device socket, so the socket finds the listener in place.
 */
export function attachOnFirstRequest(attach: (server: Server) => void): void {
  const onRequest = (message: unknown) => {
    const server = (message as { server?: Server }).server;
    if (!server) return;
    unsubscribe(REQUEST_START, onRequest);
    attach(server);
  };
  subscribe(REQUEST_START, onRequest);
}
