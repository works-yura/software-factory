import { describe, expect, it } from 'vitest';

import { type DeviceHostSummary, DeviceToolUnavailableError, LOCAL_DEVICE_HOST_ID } from '../contracts.ts';
import { agentDeviceQuickStart, createDeviceAgentTools, pngDimensions, resolveHostId } from './agentTools.ts';
import type { DeviceHost, DeviceHostAgentReady } from './DeviceHost.ts';
import { makeDeviceServiceWithHosts } from './DeviceService.ts';
import { memoryDeviceSettingsStore } from './deviceSettings.ts';

const device = {
  hostId: 'local',
  id: 'ABCD-1234',
  platform: 'ios' as const,
  name: 'iPhone 17 Pro',
  version: 'iOS 27.0',
  booted: true,
  physical: false,
};

const hosts = [
  { id: 'local', label: 'This machine' },
  { id: '0dc4f37b-5e0a-4f4c-9a51-0c6b8e8a1f2d', label: 'oliverMac' },
  { id: 'mini-1', label: 'Mac mini' },
  { id: 'mini-2', label: 'Mac mini' },
].map(
  (host): DeviceHostSummary => ({
    ...host,
    kind: 'local',
    platforms: [],
    hubInstalled: true,
    agentDeviceInstalled: true,
  }),
);

const thrown = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error as DeviceToolUnavailableError;
  }
  return expect.unreachable('expected a throw');
};

describe('device tool helpers', () => {
  it('resolves a host by exact id or case-insensitive label', () => {
    const mac = '0dc4f37b-5e0a-4f4c-9a51-0c6b8e8a1f2d';
    expect(resolveHostId(hosts, undefined)).toBeUndefined();
    expect(resolveHostId([...hosts, { ...hosts[1]!, label: 'local' }], 'local')).toBe('local');
    expect(resolveHostId(hosts, mac)).toBe(mac);
    expect(resolveHostId(hosts, 'olivermac')).toBe(mac);
  });

  it('rejects an unknown or ambiguous host and lists the candidates', () => {
    const unknown = thrown(() => resolveHostId(hosts, 'studio'));
    expect(unknown).toBeInstanceOf(DeviceToolUnavailableError);
    expect(unknown.fields.reason).toContain('This machine (local)');
    expect(unknown.fields.reason).toContain('oliverMac (0dc4f37b-5e0a-4f4c-9a51-0c6b8e8a1f2d)');
    const ambiguous = thrown(() => resolveHostId(hosts, 'mac mini'));
    expect(ambiguous.fields.reason).toContain('Mac mini (mini-1), Mac mini (mini-2)');
    expect(ambiguous.fields.reason).not.toContain('oliverMac');
  });

  it('uses the absolute launcher in every quick-start command', () => {
    const text = agentDeviceQuickStart(
      device,
      ['--session', 'thread-1', '--config', '/tmp/host.json'],
      '/tmp/device tools/agent-device',
    );
    expect(text).toContain("'/tmp/device tools/agent-device' snapshot -i --session thread-1 --config /tmp/host.json");
    expect(text).not.toContain('  agent-device ');
    expect(text).not.toContain('is on PATH');
  });

  it("shows a bound launcher's commands without flags and keeps device actions off simctl and ssh", () => {
    const command = '/state/device/targets/t3-a/agent-device';
    const text = agentDeviceQuickStart(device, [], command);
    const examples = text.split('\n').filter((line) => line.trimStart().startsWith(command));
    expect(examples).toContain(`  ${command} snapshot -i  # accessibility tree with @eN refs`);
    expect(examples.find((line) => line.includes(' screenshot '))).toContain('--pixel-density <n>');
    expect(agentDeviceQuickStart({ ...device, platform: 'android' }, [], command)).not.toContain('--pixel-density');
    expect(examples.join('\n')).not.toMatch(/--(?:platform|udid|serial|config|session)\b/);
    expect(text).not.toContain('remain available');
    expect(text).toContain('Do not use simctl, idb, adb or ssh for those actions.');
    expect(text).toContain('If it is missing, call device_open again.');
  });

  it('opens the app before snapshots, CLI screenshots or input, looks with device_screenshot, and records the device screen', () => {
    const command = '/state/device/targets/t3-a/agent-device';
    const text = agentDeviceQuickStart(device, [], command);
    // device_open starts no agent-device session, and an iOS snapshot needs one with an app.
    expect(text).toContain(
      'Run open <bundle-or-package-id> (apps lists them) before snapshots, CLI screenshots or input; it starts the session they need. Use device_screenshot just to look.',
    );
    // App-scoped recording needs an app opened in the session; device scope does not.
    expect(text).toContain(`  ${command} record start --scope device /tmp/run.mp4  # then record stop`);
  });

  it('reads PNG dimensions from the IHDR chunk', () => {
    const png = new Uint8Array(24);
    new DataView(png.buffer).setUint32(0, 0x89504e47);
    new DataView(png.buffer).setUint32(4, 0x0d0a1a0a);
    new DataView(png.buffer).setUint32(12, 0x49484452);
    new DataView(png.buffer).setUint32(16, 1179);
    new DataView(png.buffer).setUint32(20, 2556);
    expect(pngDimensions(png)).toEqual({ width: 1179, height: 2556 });
    expect(pngDimensions(new Uint8Array([1, 2, 3]))).toEqual({ width: 0, height: 0 });
  });
});

describe('device agent tools', () => {
  const png = (() => {
    const bytes = new Uint8Array(24);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x89504e47);
    view.setUint32(4, 0x0d0a1a0a);
    view.setUint32(12, 0x49484452);
    view.setUint32(16, 3);
    view.setUint32(20, 4);
    return bytes;
  })();

  const setup = async (settings = { enabled: true, agentAccessEnabled: true }) => {
    const ready: DeviceHostAgentReady = {
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
        screenshot: async () => png,
      },
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
      helpers: { serveSimAxSettings: null, serveSimCli: null },
      agentDevice: { baseUrl: 'http://agent.test', token: 'token', entryPath: '/agent-device' },
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
        agentDeviceInstalled: true,
      }),
      platformAvailability: async (platform) => ({ platform, available: true }),
      ensureReady: async () => ready,
      ensureAgentReady: async () => ready,
      current: async () => ready,
      stopAgent: async () => undefined,
      stop: async () => undefined,
    };
    const service = await makeDeviceServiceWithHosts(new Map([[host.id, host]]), {
      settings: memoryDeviceSettingsStore(settings),
      configureAgent: async () => '/state/device/hosts/local.json',
      launchers: {
        bind: async ({ session }) => `/state/device/targets/${session}/agent-device`,
        prune: async () => undefined,
      },
    });
    return { service, tools: createDeviceAgentTools(service) };
  };

  it('opens the only booted device, lists it as open and returns its bound launcher', async () => {
    const { tools } = await setup();
    const context = { threadId: 'thread-1' };
    const opened = await tools.device_open(context, {});
    expect(opened.device).toMatchObject({ id: 'SIM-1', hostId: LOCAL_DEVICE_HOST_ID });
    expect(opened.agentDevice.targetArgs).toEqual([
      '--platform',
      'ios',
      '--udid',
      'SIM-1',
      '--config',
      '/state/device/hosts/local.json',
      '--session',
      opened.agentDevice.session,
    ]);
    expect(opened.agentDevice.command).toBe(`/state/device/targets/${opened.agentDevice.session}/agent-device`);
    expect(opened.quickStart).toContain(`${opened.agentDevice.command} snapshot -i`);
    const listed = await tools.device_list(context);
    expect(listed.open).toEqual([{ hostId: LOCAL_DEVICE_HOST_ID, deviceId: 'SIM-1' }]);
    expect((await tools.device_list({ threadId: 'thread-2' })).open).toEqual([]);
  });

  it('screenshots the last device opened here and closes it', async () => {
    const { service, tools } = await setup();
    const context = { threadId: 'thread-1' };
    await expect(tools.device_screenshot(context, {})).rejects.toThrow('No device is open in this thread');
    await tools.device_open(context, {});
    const shot = await tools.device_screenshot(context, {});
    expect(shot.screenshot).toEqual({
      mimeType: 'image/png',
      data: Buffer.from(png).toString('base64'),
      width: 3,
      height: 4,
    });
    expect(await tools.device_close(context, { deviceId: 'SIM-1' })).toEqual({});
    expect(service.state().sessions).toEqual([]);
  });

  it('refuses while device support or agent access is off', async () => {
    const off = await setup({ enabled: false, agentAccessEnabled: false });
    await expect(off.tools.device_list({ threadId: 'thread-1' })).rejects.toThrow('Device support is off');
    const noAgents = await setup({ enabled: true, agentAccessEnabled: false });
    await expect(noAgents.tools.device_open({ threadId: 'thread-1' }, {})).rejects.toThrow(
      'Agent device access requires enabled device support',
    );
    const denied = await setup();
    await expect(denied.tools.device_list({ threadId: 'thread-1', deviceAccess: false }, {})).rejects.toThrow(
      'Agent device access is turned off',
    );
  });
});
