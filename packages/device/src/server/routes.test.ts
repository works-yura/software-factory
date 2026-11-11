import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { DeviceServiceState, LOCAL_DEVICE_HOST_ID } from '../contracts.ts';
import type { DeviceHost, DeviceHostReady } from './DeviceHost.ts';
import { makeDeviceServiceWithHosts } from './DeviceService.ts';
import { memoryDeviceSettingsStore } from './deviceSettings.ts';
import { createDeviceRoutes } from './routes.ts';

const setup = async () => {
  const ready: DeviceHostReady = {
    nodePath: process.execPath,
    hub: { origin: 'http://device.test' },
    devices: {
      list: async () => ({
        devices: [{ id: 'SIM-1', name: 'iPhone', platform: 'ios', version: 'iOS 26', booted: true, physical: false }],
        detail: undefined,
      }),
      boot: async (target) => target.id,
      attach: async () => undefined,
      shutdown: async () => undefined,
      screenshot: async () => new Uint8Array(),
    },
    run: async (_command, args) => ({
      code: 0,
      stdout: args.includes('appearance') ? 'dark\n' : '',
      stderr: '',
    }),
    helpers: { serveSimAxSettings: null, serveSimCli: null },
  };
  const host: DeviceHost = {
    id: LOCAL_DEVICE_HOST_ID,
    label: 'This machine',
    summary: async () => ({
      id: LOCAL_DEVICE_HOST_ID,
      kind: 'local',
      label: 'This machine',
      platforms: [{ platform: 'ios', available: true }],
      hubInstalled: true,
      agentDeviceInstalled: false,
    }),
    platformAvailability: async (platform) => ({ platform, available: true }),
    ensureReady: async () => ready,
    ensureAgentReady: async () => ({ ...ready, agentDevice: null }),
    current: async () => ready,
    stopAgent: async () => undefined,
    stop: async () => undefined,
  };
  const settings = memoryDeviceSettingsStore();
  const service = await makeDeviceServiceWithHosts(new Map([[host.id, host]]), { settings });
  const app = new Hono().route('/api/device', createDeviceRoutes(service, { basePath: '/api/device' }));
  const call = (path: string, body?: unknown) =>
    app.request(`/api/device${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    });
  return { app, service, settings, call };
};

describe('device routes', () => {
  it('serves state with the hub proxy mount as its base path', async () => {
    const { call } = await setup();
    const response = await call('/state');
    expect(response.status).toBe(200);
    const state = DeviceServiceState.parse(await response.json());
    expect(state.hubBasePath).toBe('/api/device/hub');
    expect(state.hostStatus).toBe('disabled');
  });

  it('configures, lists, opens, details, acts on and closes a device', async () => {
    const { call, settings } = await setup();
    const configured = DeviceServiceState.parse(await (await call('/configure', { enabled: true })).json());
    expect(settings.value.enabled).toBe(true);
    expect(configured.devices.map((device) => device.id)).toEqual(['SIM-1']);
    const listed = DeviceServiceState.parse(await (await call('/list', {})).json());
    expect(listed.hostStatuses.local?.status).toBe('ready');
    const session = await (await call('/open', { threadId: 'owner-1', deviceId: 'SIM-1', platform: 'ios' })).json();
    expect(session).toMatchObject({ threadId: 'owner-1', hostId: 'local', deviceId: 'SIM-1', platform: 'ios' });
    const detail = await (await call('/detail', { deviceId: 'SIM-1' })).json();
    expect(detail).toMatchObject({ hostId: 'local', deviceId: 'SIM-1', settings: { appearance: 'dark' } });
    const acted = await call('/action', { deviceId: 'SIM-1', type: 'setAppearance', value: 'dark' });
    expect(acted.status).toBe(200);
    const closed = DeviceServiceState.parse(await (await call('/close', { threadId: 'owner-1' })).json());
    expect(closed.sessions).toEqual([]);
    const shutdown = await call('/shutdown', { deviceId: 'SIM-1', platform: 'ios' });
    expect(shutdown.status).toBe(200);
  });

  it('rejects invalid bodies with 400 and reports device errors by tag', async () => {
    const { app, call } = await setup();
    const invalid = await call('/open', { threadId: '', deviceId: 'SIM-1', platform: 'windows' });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ _tag: 'InvalidRequest' });
    const malformed = await app.request('/api/device/configure', { method: 'POST', body: '{not json' });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ _tag: 'InvalidRequest' });
    const off = await call('/open', { threadId: 'owner-1', deviceId: 'SIM-1', platform: 'ios' });
    expect(off.status).toBe(503);
    expect(await off.json()).toEqual({
      _tag: 'DeviceHostUnavailableError',
      message:
        'This machine is unavailable: Device support is off. Enable it in the Device panel before installing or starting device tools.',
    });
    await call('/configure', { enabled: true });
    const unsupported = await call('/action', { deviceId: 'SIM-1', type: 'shake' });
    expect(unsupported.status).toBe(422);
    expect(await unsupported.json()).toMatchObject({ _tag: 'DeviceActionUnavailableError' });
    const missing = await call('/detail', { deviceId: 'nope' });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ _tag: 'DeviceNotFoundError' });
  });

  it('streams the state as SSE on every revision', async () => {
    const { app, service } = await setup();
    const controller = new AbortController();
    const response = await app.request('/api/device/events', { signal: controller.signal });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let text = '';
    const nextEvent = async () => {
      while (!text.includes('\n\n')) {
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        text += value;
      }
      const [event, ...rest] = text.split('\n\n');
      text = rest.join('\n\n');
      const data = event!.split('\n').find((line) => line.startsWith('data: '))!.slice('data: '.length);
      expect(event).toContain('event: state');
      return DeviceServiceState.parse(JSON.parse(data));
    };
    const initial = await nextEvent();
    expect(initial.hubBasePath).toBe('/api/device/hub');
    await service.configure({ onboardingCompleted: true });
    const updated = await nextEvent();
    expect(updated.revision).toBeGreaterThan(initial.revision);
    expect(updated.onboardingCompleted).toBe(true);
    controller.abort();
    await reader.cancel().catch(() => undefined);
  });
});
