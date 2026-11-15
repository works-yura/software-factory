import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { LOCAL_DEVICE_HOST_ID } from '../contracts.ts';
import type { DeviceHostReady } from './DeviceHost.ts';
import type { DeviceService } from './DeviceService.ts';
import { createDeviceRoutes } from './routes.ts';

const fixture = (
  options: { upstream?: DeviceHostReady['upstream']; running?: boolean; hubHeaders?: Record<string, string> } = {},
) => {
  const requests: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const screenshots: unknown[] = [];
  const http: typeof fetch = async (input, init) => {
    requests.push(String(input));
    headers.push(Object.fromEntries(new Headers(init?.headers).entries()));
    return new Response('frame', { headers: { 'set-cookie': 'upstream=1' } });
  };
  const service = {
    currentReadiness: async (hostId?: string) =>
      options.running === false
        ? null
        : {
            hostId: hostId ?? LOCAL_DEVICE_HOST_ID,
            hub: { origin: 'http://hub.test', ...(options.hubHeaders ? { headers: options.hubHeaders } : {}) },
            ...(options.upstream ? { upstream: options.upstream } : {}),
          },
    screenshot: async (input: unknown) => {
      screenshots.push(input);
      return { device: {}, png: new Uint8Array([137, 80, 78, 71]) };
    },
  } as unknown as DeviceService;
  const app = new Hono().route('/api/device', createDeviceRoutes(service, { basePath: '/api/device', fetch: http }));
  const handler = (request: Request) => app.fetch(request);
  return { handler, requests, headers, screenshots };
};

const hub = 'http://server.test/api/device/hub/local';

describe('device hub proxy', () => {
  it("sends the hub's session token itself and drops the caller's authorization", async () => {
    const { handler, headers } = fixture({ hubHeaders: { authorization: 'Bearer hub-token' } });
    const response = await handler(
      new Request(`${hub}/api/devices`, { headers: { authorization: 'Bearer factory-session', cookie: 'a=1' } }),
    );
    expect(response.status).toBe(200);
    expect(headers[0]?.authorization).toBe('Bearer hub-token');
    expect(headers[0]?.cookie).toBeUndefined();
  });

  it('forwards the upstream body, strips tickets and never passes upstream cookies on', async () => {
    const { handler, requests } = fixture();
    const response = await handler(new Request(`${hub}/api/devices?wsTicket=secret`));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store, no-transform');
    expect(await response.text()).toBe('frame');
    expect(requests).toEqual(['http://hub.test/api/devices']);
  });

  it.each(['/vendor/serve-sim/helper/ws', '/vendor/serve-emu/ws'])(
    'sends WebSocket upgrades for %s to the upgrade handler instead of proxying them over HTTP',
    async (path) => {
      const { handler, requests } = fixture();
      const response = await handler(new Request(`${hub}${path}`, { headers: { upgrade: 'websocket' } }));
      expect(response.status).toBe(426);
      expect(requests).toEqual([]);
    },
  );

  it('refuses upgrades to paths that are not hub sockets', async () => {
    const { handler, requests } = fixture();
    const response = await handler(new Request(`${hub}/api/devices`, { headers: { upgrade: 'websocket' } }));
    expect(response.status).toBe(404);
    expect(requests).toEqual([]);
  });

  it('forwards stream tuning', async () => {
    const { handler, requests } = fixture();
    const response = await handler(new Request(`${hub}/vendor/serve-emu/api/stream-settings`, { method: 'POST' }));
    expect(response.status).toBe(200);
    await response.text();
    expect(requests).toEqual(['http://hub.test/vendor/serve-emu/api/stream-settings']);
  });

  it('reads and changes Android fold state', async () => {
    const path = `${hub}/vendor/serve-emu/api/fold?device=emulator-5554`;
    const { handler, requests } = fixture();
    const read = await handler(new Request(path));
    expect(read.status).toBe(200);
    await read.text();
    const changed = await handler(new Request(path, { method: 'POST', body: '{"posture":"closed"}' }));
    expect(changed.status).toBe(200);
    await changed.text();
    expect(requests).toEqual([
      'http://hub.test/vendor/serve-emu/api/fold?device=emulator-5554',
      'http://hub.test/vendor/serve-emu/api/fold?device=emulator-5554',
    ]);
  });

  it('presents fold changes from an HTTPS client as same-origin hub requests', async () => {
    const { handler, headers } = fixture();
    const response = await handler(
      new Request('https://relay.test/api/device/hub/local/vendor/serve-emu/api/fold?device=emulator-5554', {
        method: 'POST',
        headers: {
          origin: 'https://relay.test',
          'x-forwarded-proto': 'https',
          cookie: 'session=private',
          authorization: 'Bearer private',
        },
        body: '{"posture":"opened"}',
      }),
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(headers).toHaveLength(1);
    expect(headers[0]?.origin).toBe('http://hub.test');
    expect(headers[0]).not.toHaveProperty('x-forwarded-proto');
    expect(headers[0]).not.toHaveProperty('cookie');
    expect(headers[0]).not.toHaveProperty('authorization');
  });

  it('lets a viewer negotiate a WebRTC stream', async () => {
    const { handler, requests, headers } = fixture();
    const offer = await handler(
      new Request(`${hub}/vendor/serve-sim/helper/udid-1/webrtc/offer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"type":"offer"}',
      }),
    );
    expect(offer.status).toBe(200);
    await offer.text();
    expect(requests).toEqual(['http://hub.test/vendor/serve-sim/helper/udid-1/webrtc/offer']);
    expect(headers[0]?.['content-type']).toBe('application/json');
  });

  it('lets a viewer read Android stream capabilities and signal WebRTC', async () => {
    const { handler, requests } = fixture();
    const emu = `${hub}/vendor/serve-emu`;
    const api = await handler(new Request(`${emu}/api?device=session-1`));
    expect(api.status).toBe(200);
    await api.text();
    for (const action of ['offer', 'close']) {
      const signal = await handler(
        new Request(`${emu}/webrtc/${action}?device=session-1`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"sessionId":"viewer"}',
        }),
      );
      expect(signal.status).toBe(200);
      await signal.text();
    }
    expect(requests).toEqual([
      'http://hub.test/vendor/serve-emu/api?device=session-1',
      'http://hub.test/vendor/serve-emu/webrtc/offer?device=session-1',
      'http://hub.test/vendor/serve-emu/webrtc/close?device=session-1',
    ]);
    expect((await handler(new Request(`${emu}/api`, { method: 'POST' }))).status).toBe(405);
    expect((await handler(new Request(`${emu}/webrtc/offer`))).status).toBe(405);
  });

  it('sends requests a host routes itself to its upstream with its credentials', async () => {
    const { handler, requests, headers } = fixture({
      upstream: async (hubPath, search) =>
        hubPath === '/vendor/serve-sim/api'
          ? {
              url: `https://session.test${hubPath.slice('/vendor/serve-sim'.length)}?${search}`,
              headers: { authorization: 'Bearer session-token' },
              protocols: [],
            }
          : null,
    });
    const routed = await handler(
      new Request(`http://server.test/api/device/hub/cloud/vendor/serve-sim/api?device=udid-1&hostId=cloud`, {
        headers: { authorization: 'Bearer environment-token' },
      }),
    );
    expect(routed.status).toBe(200);
    expect(routed.headers.get('set-cookie')).toBeNull();
    await routed.text();
    expect(requests).toEqual(['https://session.test/api?device=udid-1']);
    expect(headers[0]?.authorization).toBe('Bearer session-token');
    const unrouted = await handler(
      new Request('http://server.test/api/device/hub/cloud/vendor/serve-sim/helper/udid-2/stream.mjpeg'),
    );
    expect(unrouted.status).toBe(404);
    expect(requests).toHaveLength(1);
  });

  it('never forwards the vendor shell endpoint', async () => {
    const { handler, requests } = fixture();
    for (const method of ['GET', 'POST']) {
      expect((await handler(new Request(`${hub}/vendor/serve-sim/exec`, { method }))).status).toBe(404);
    }
    // Dot segments resolve before matching, so they cannot reach it either.
    expect((await handler(new Request(`${hub}/vendor/serve-sim/api/../exec`, { method: 'POST' }))).status).toBe(404);
    expect(requests).toEqual([]);
  });

  it('answers 503 while the host has no running hub', async () => {
    const { handler, requests } = fixture({ running: false });
    expect((await handler(new Request(`${hub}/api/devices`))).status).toBe(503);
    expect(requests).toEqual([]);
  });

  it('captures simulator screenshots through the service instead of the hub', async () => {
    const { handler, requests, screenshots } = fixture();
    const response = await handler(new Request(`${hub}/vendor/serve-sim/api/screenshot?device=udid-1`));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([137, 80, 78, 71]);
    expect(screenshots).toEqual([{ hostId: LOCAL_DEVICE_HOST_ID, deviceId: 'udid-1' }]);
    expect(requests).toEqual([]);
  });
});

it('rejects unsupported Duo routes', async () => {
  const { handler, requests } = fixture();
  const response = await handler(new Request(`${hub}/vendor/serve-sim/helper/duo/panel/1/webrtc/offer`));
  expect(response.status).toBe(404);
  expect(requests).toEqual([]);
});
