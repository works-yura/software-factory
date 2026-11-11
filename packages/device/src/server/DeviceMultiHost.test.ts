import { expect, it } from 'vitest';

import { releaseAgentDeviceSession } from './AgentDeviceTarget.ts';
import { type DeviceHost, type DeviceHostAgentReady, DeviceHostError, type DeviceHostReady } from './DeviceHost.ts';
import { makeDeviceServiceWithHosts } from './DeviceService.ts';
import { makeDeviceHubOperations } from './DeviceHubOperations.ts';
import { memoryDeviceSettingsStore } from './deviceSettings.ts';

it('keeps hosts independent when serials collide and another host fails', async () => {
  const http: typeof fetch = async (input) =>
    Response.json(
      String(input).endsWith('/rpc')
        ? { result: { ok: true } }
        : {
            simulators: [],
            emulators: [
              { id: 'emulator-5554', name: 'Pixel', version: '36', platform: 'android', booted: true, physical: false },
            ],
          },
    );
  const host = (id: string, failed = false): DeviceHost => {
    const run: DeviceHostReady['run'] = async (command) => ({
      stdout: command === 'emulator' ? '' : ' V....D libx264',
      stderr: '',
      code: 0,
    });
    const ready: DeviceHostAgentReady = {
      nodePath: process.execPath,
      hub: { origin: `http://${id}` },
      devices: makeDeviceHubOperations({
        hostId: id,
        origin: `http://${id}`,
        fetch: http,
        run,
        platformAvailable: async () => true,
      }),
      agentDevice: { baseUrl: `http://${id}`, token: 'test', entryPath: '/agent-device' },
      releaseAgentSession: releaseAgentDeviceSession(http, { baseUrl: `http://${id}`, token: 'test' }),
      run,
      helpers: { serveSimAxSettings: null, serveSimCli: null },
    };
    return {
      id,
      label: id,
      // A remote host with no local platforms still serves devices.
      remote: id === 'b',
      summary: async () => ({
        id,
        label: id,
        kind: 'local',
        hubInstalled: true,
        agentDeviceInstalled: true,
        platforms: id === 'b' ? [] : [{ platform: 'android', available: true }],
      }),
      platformAvailability: async (platform) => ({ platform, available: true }),
      ensureReady: async () => {
        if (failed) throw new DeviceHostError({ hostId: id, step: 'connect', cause: new Error('offline') });
        return ready;
      },
      ensureAgentReady: async () => ready,
      current: async () => ready,
      stopAgent: async () => undefined,
      stop: async () => undefined,
    };
  };
  const hosts = new Map(['a', 'b', 'offline'].map((id) => [id, host(id, id === 'offline')]));
  let markWriteStarted!: () => void;
  const writeStarted = new Promise<void>((resolve) => (markWriteStarted = resolve));
  let finishWrite!: () => void;
  const writeFinished = new Promise<void>((resolve) => (finishWrite = resolve));
  const order: string[] = [];
  const service = await makeDeviceServiceWithHosts(hosts, {
    settings: memoryDeviceSettingsStore({ enabled: true, agentAccessEnabled: true }),
    configureAgent: async () => {
      order.push('write started');
      markWriteStarted();
      await writeFinished;
      order.push('write finished');
      return '/host-config.json';
    },
  });
  expect(await service.agentReadinessIfSupported('b')).not.toBeNull();
  const listed = await service.list();
  expect(listed.devices.map((device) => device.hostId).sort()).toEqual(['a', 'b']);
  expect(listed.hostStatuses.offline?.status).toBe('failed');
  const threadId = 'thread';
  for (const hostId of ['a', 'b'])
    await service.open({ threadId, hostId, deviceId: 'emulator-5554', platform: 'android' });
  await service.close({ threadId, hostId: 'a', deviceId: 'emulator-5554' });
  const state = service.state();
  expect(state.devices).toHaveLength(2);
  expect(state.sessions.map((session) => session.hostId)).toEqual(['b']);
  expect(state.hostStatuses.a?.status).toBe('ready');
  expect(state.hostStatuses.offline?.status).toBe('failed');
  const targeting = service.agentTarget({ threadId, hostId: 'b', deviceId: 'emulator-5554' });
  await writeStarted;
  const replacing = service.withLifecycleLock(async () => {
    order.push('replace');
    hosts.set('b', host('b'));
    await service.refreshHosts();
  });
  finishWrite();
  await targeting;
  await replacing;
  expect(order).toEqual(['write started', 'write finished', 'replace']);
  const replaced = service.state();
  expect(replaced.sessions).toEqual([]);
  expect(replaced.devices.map((device) => device.hostId)).toEqual(['a']);
  expect(replaced.hostStatuses.b).toBeUndefined();
  await service.open({ threadId, hostId: 'b', deviceId: 'emulator-5554', platform: 'android' });
  hosts.delete('b');
  await service.refreshHosts();
  await service.setHostStatus('b', { status: 'ready' });
  expect(service.state().hostStatuses.b).toBeUndefined();
  expect(service.state().sessions).toEqual([]);
  await service.agentReadinessIfSupported('a');
  expect(service.state().hostStatuses.a?.status).toBe('ready');
  await service.configure({ enabled: false });
  expect(service.state().hostStatuses).toEqual({});
});
