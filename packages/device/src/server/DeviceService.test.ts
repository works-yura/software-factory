import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DeviceBootError,
  DeviceHostUnavailableError,
  DeviceOperationError,
  type DeviceServiceState,
  type DeviceSummary,
  LOCAL_DEVICE_HOST_ID,
} from '../contracts.ts';
import { agentDeviceSession, releaseAgentDeviceSession } from './AgentDeviceTarget.ts';
import {
  AgentDeviceStartError,
  type DeviceHost,
  type DeviceHostAgentReady,
  type DeviceHostError,
  type DeviceHostReady,
} from './DeviceHost.ts';
import { makeDeviceHubOperations } from './DeviceHubOperations.ts';
import {
  type AgentDeviceLaunchers,
  createDeviceService,
  type DeviceService,
  makeDeviceServiceWithHosts,
} from './DeviceService.ts';
import { memoryDeviceSettingsStore } from './deviceSettings.ts';
import { deviceErrorResponse } from './routes.ts';
import type { NodeRuntimeUnavailableError } from './runtime.ts';
import { fakeRuntime, hang, processOutput, tempDir } from './testing.ts';

afterEach(() => {
  vi.useRealTimers();
});

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/** An unbounded queue whose `take` waits for the next offer. */
const asyncQueue = () => {
  const items: number[] = [];
  const waiters: Array<() => void> = [];
  return {
    offer: () => {
      const waiter = waiters.shift();
      if (waiter) waiter();
      else items.push(1);
    },
    take: () =>
      items.length > 0 ? (items.shift(), Promise.resolve()) : new Promise<void>((resolve) => waiters.push(resolve)),
  };
};

const rejection = <T>(promise: Promise<T>) =>
  promise.then(
    () => expect.unreachable('expected a rejection'),
    (error: unknown) => error as Error & { _tag?: string; fields?: Record<string, unknown> },
  );

const settles = async (promise: Promise<unknown>) =>
  promise.then(
    () => 'success' as const,
    () => 'failure' as const,
  );

const urlOf = (input: RequestInfo | URL) => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
const bodyOf = (init: RequestInit | undefined): unknown => JSON.parse(String(init?.body));

it.each([400, 500])('retries a hub-rejected (%s) screenshot with simctl only on iOS 26 and older', async (status) => {
  const operations = makeDeviceHubOperations({
    hostId: LOCAL_DEVICE_HOST_ID,
    origin: 'http://device.test',
    fetch: async () => new Response('private hub output', { status }),
    run: async () => ({ code: 0, stdout: 'iVBORw==', stderr: '' }),
    platformAvailable: async () => false,
  });
  const screenshot = (version: string) =>
    operations.screenshot({ id: 'phone', name: 'Phone', version, platform: 'ios', booted: true, physical: false });
  const failure = await rejection(screenshot('iOS 27.0'));
  expect(failure).toMatchObject({ _tag: 'DeviceOperationError', fields: { reason: 'hub_rejected' } });
  expect(await screenshot('iOS 26.3')).toEqual(new Uint8Array([137, 80, 78, 71]));
});

type CloseOutcome = 'ok' | 'missing' | 'reject' | 'http_error' | 'malformed';

const fixture = async (
  options: {
    readonly onBoot?: () => Promise<void> | void;
    readonly bootError?: string | { error?: string; errors?: Array<{ message: string; error?: string }> };
    readonly failListAfterShutdown?: boolean;
    readonly runtimeFailure?: NodeRuntimeUnavailableError | DeviceHostError | AgentDeviceStartError;
    readonly inspectError?: boolean;
    readonly installTool?: (tool: 'hub' | 'agent') => Promise<unknown>;
    readonly endsDevices?: boolean;
    readonly routesStreams?: boolean;
    readonly onClose?: () => Promise<CloseOutcome> | CloseOutcome;
    readonly onPlatformAvailability?: () => void;
  } = {},
) => {
  const settings = memoryDeviceSettingsStore();
  const starts: string[] = [];
  const agentStarts: string[] = [];
  const agentStops: string[] = [];
  const requests: string[] = [];
  const closedSessions: unknown[] = [];
  const devices: Array<Omit<DeviceSummary, 'hostId'>> = [];
  const discoveryErrors: { value: Array<{ message: string; error?: string }> } = { value: [] };
  const androidAvailable = { value: true };
  const iosAvailable = { value: true };
  const encoderResult = { value: { code: 0, stdout: ' V....D libx264', stderr: '' } };
  const listing = { hangs: false, requested: deferred() };
  let booted = false;
  let shutDown = false;
  const connection = { online: true, remote: false, failShutdown: false };
  const http: typeof fetch = async (input, init) => {
    const url = urlOf(input);
    requests.push(url);
    if (url === 'http://agent.test/rpc') {
      closedSessions.push(bodyOf(init));
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test');
      const outcome = (await options.onClose?.()) ?? 'ok';
      return outcome === 'missing'
        ? Response.json(
            { error: { code: -32000, message: 'No active session', data: { code: 'SESSION_NOT_FOUND' } } },
            { status: 404 },
          )
        : outcome === 'http_error'
          ? new Response('Offline', { status: 503 })
          : outcome === 'malformed'
            ? new Response('not JSON')
            : Response.json(outcome === 'ok' ? { result: { ok: true } } : { error: { code: -32000, message: 'offline' } });
    }
    if (url.includes('/api/screenshot')) return new Response(new Uint8Array([137, 80, 78, 71]));
    if (url.endsWith('/shutdown')) {
      if (connection.failShutdown) return Response.json({ ok: false });
      shutDown = true;
      booted = false;
      return Response.json({ ok: true });
    }
    if (shutDown && options.failListAfterShutdown) return new Response('Discovery busy', { status: 503 });
    if (url.endsWith('/boot')) {
      await options.onBoot?.();
      booted = true;
      const { bootError } = options;
      return Response.json(
        bootError
          ? { ok: false, ...(typeof bootError === 'string' ? { error: bootError } : bootError) }
          : { ok: true, serial: 'emulator-5554' },
      );
    }
    if (url.endsWith('/grid/api/start')) return Response.json({ ok: true });
    if (listing.hangs) {
      listing.requested.resolve();
      return hang(init?.signal);
    }
    return Response.json({
      errors: discoveryErrors.value,
      simulators: devices.filter((device) => device.platform === 'ios'),
      emulators: [
        ...devices.filter((device) => device.platform === 'android'),
        ...(booted
          ? [
              {
                id: 'emulator-5554',
                name: 'Pixel_API_35',
                platform: 'android',
                version: 'Android 15',
                booted: true,
                physical: false,
              },
            ]
          : []),
      ],
    });
  };
  const run: DeviceHostReady['run'] = async (command) =>
    command === 'emulator' ? { code: 0, stdout: 'Pixel_API_35\n', stderr: '' } : encoderResult.value;
  const ready: DeviceHostReady = {
    nodePath: process.execPath,
    hub: { origin: 'http://device.test' },
    devices: {
      ...makeDeviceHubOperations({
        hostId: LOCAL_DEVICE_HOST_ID,
        origin: 'http://device.test',
        fetch: http,
        run,
        platformAvailable: async (platform) => (platform === 'ios' ? iosAvailable : androidAvailable).value,
      }),
      ...(options.endsDevices ? { endsDevices: true } : {}),
    },
    helpers: { serveSimAxSettings: null, serveSimCli: null },
    run,
    ...(options.routesStreams ? { upstream: async () => null } : {}),
  };
  const host: DeviceHost = {
    ...(options.inspectError
      ? {
          inspect: async () => {
            throw new Error('offline');
          },
        }
      : {}),
    id: LOCAL_DEVICE_HOST_ID,
    label: 'This machine',
    get remote() {
      return connection.remote;
    },
    summary: async () => ({
      id: LOCAL_DEVICE_HOST_ID,
      kind: 'local',
      label: 'Test server',
      platforms: [
        { platform: 'android', available: true },
        { platform: 'ios', available: true },
      ],
      hubInstalled: true,
      agentDeviceInstalled: false,
    }),
    platformAvailability: async (platform) => {
      options.onPlatformAvailability?.();
      return { platform, available: true };
    },
    ensureReady: async (onPhase) => {
      const failure = options.runtimeFailure;
      if (failure && failure._tag !== 'AgentDeviceStartError') throw failure;
      starts.push('start');
      await onPhase('installing', 'Updating device hub from 0.9.0 to 0.10.1…');
      return ready;
    },
    ensureAgentReady: async (onPhase) => {
      if (options.runtimeFailure) throw options.runtimeFailure;
      agentStarts.push('start');
      await onPhase('starting');
      return { ...ready, agentDevice: { baseUrl: 'http://agent.test', token: 'test', entryPath: '/agent' } };
    },
    current: async () =>
      connection.online
        ? {
            ...ready,
            ...(agentStarts.length > agentStops.length
              ? { releaseAgentSession: releaseAgentDeviceSession(http, { baseUrl: 'http://agent.test', token: 'test' }) }
              : {}),
          }
        : null,
    stopAgent: async () => {
      agentStops.push('stop');
    },
    stop: async () => {
      starts.push('stop');
    },
  };
  const service = await makeDeviceServiceWithHosts(new Map([[host.id, host]]), {
    settings,
    configureAgent: async () => '/host.json',
    ...(options.installTool ? { installTool: options.installTool } : {}),
  });
  // The host ending a device on its own, as cloud hosts do at a session's limits.
  const endDevice = () => {
    booted = false;
  };
  return {
    service,
    host,
    starts,
    agentStarts,
    agentStops,
    requests,
    settings,
    closedSessions,
    connection,
    devices,
    encoderResult,
    discoveryErrors,
    androidAvailable,
    iosAvailable,
    listing,
    endDevice,
  };
};

describe('device setup consent', () => {
  it('exposes daemon startup diagnostics through agent readiness and host status', async () => {
    const startupError = new AgentDeviceStartError({
      hostId: LOCAL_DEVICE_HOST_ID,
      stateDir: '/test/device/agent-device',
      exitCode: 1,
      reason: 'daemon_lock_not_directory',
      cause: { stdout: 'private startup diagnostics', code: 1 },
    });
    const { service, settings } = await fixture({ runtimeFailure: startupError });
    await settings.update({ enabled: true, agentAccessEnabled: true });
    const error = await rejection(service.agentReadinessIfSupported());
    expect(error).toBeInstanceOf(DeviceHostUnavailableError);
    expect(error.fields).toMatchObject({ reason: startupError.message, cause: startupError });
    expect(error.message).toContain('daemon.lock is not a directory');
    expect(error.message).not.toContain('private startup diagnostics');
    expect(service.state().hostStatuses[LOCAL_DEVICE_HOST_ID]).toEqual({
      status: 'failed',
      detail: startupError.message,
    });
  });

  it('listing and provider startup do not start helpers before consent', async () => {
    const { service, starts, requests } = await fixture();
    expect((await service.list()).hostStatus).toBe('disabled');
    expect(await service.readinessIfSupported()).toBeNull();
    expect(await settles(service.readiness())).toBe('failure');
    expect(starts).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('explicit setup discovers never-booted AVDs; disabling stops helpers and blocks agents', async () => {
    const { service, starts, settings } = await fixture();
    const state = await service.configure({ enabled: true });
    expect(settings.value.enabled).toBe(true);
    expect(state.devices.map((device) => [device.id, device.booted])).toEqual([['Pixel_API_35', false]]);
    expect(starts).toEqual(['start']);
    const disabled = await service.configure({ enabled: false });
    expect(disabled.hostStatus).toBe('disabled');
    expect(disabled.devices).toEqual([]);
    expect(settings.value.enabled).toBe(false);
    expect(await service.readinessIfSupported()).toBeNull();
    expect(starts).toEqual(['start', 'stop']);
  });

  it('boots a stopped Android AVD and uses its emulator serial without duplicating it', async () => {
    const { service, requests } = await fixture();
    await service.configure({ enabled: true });
    const session = await service.open({ threadId: 'thread-1', deviceId: 'Pixel_API_35', platform: 'android' });
    expect(session.deviceId).toBe('emulator-5554');
    expect(requests.filter((url) => url.endsWith('/boot'))).toHaveLength(1);
    const state = service.state();
    expect(state.devices.map((device) => device.id)).toEqual(['emulator-5554']);
    expect(state.bootingDevices).toEqual([]);
  });

  it('blocks only emulator video until ffmpeg is usable, then allows retry', async () => {
    const { service, requests, devices, encoderResult } = await fixture();
    devices.push(
        { id: 'physical-android', name: 'Pixel', platform: 'android', version: 'Android 15', booted: true, physical: true },
        { id: 'ios-simulator', name: 'iPhone', platform: 'ios', version: 'iOS 18', booted: true, physical: false },
    );
    encoderResult.value = { code: 127, stdout: '', stderr: 'spawn ffmpeg ENOENT' };
    const state = await service.configure({ enabled: true });
    expect(state.devices.map((device) => device.id)).toEqual(['ios-simulator', 'physical-android', 'Pixel_API_35']);
    const threadId = 'emulator-video-readiness';
    const physical = await service.open({ threadId, deviceId: 'physical-android', platform: 'android' });
    const ios = await service.open({ threadId, deviceId: 'ios-simulator', platform: 'ios' });
    expect(physical.deviceId).toBe('physical-android');
    expect(ios.deviceId).toBe('ios-simulator');

    const openEmulator = () => service.open({ threadId, deviceId: 'Pixel_API_35', platform: 'android' });
    const missing = await rejection(openEmulator());
    expect(missing.message).toMatch(/ffmpeg/i);
    expect(missing.message).toMatch(/emulator/i);
    expect(requests.filter((url) => url.endsWith('/boot'))).toEqual([]);
    expect(service.state().sessions).toEqual([physical, ios]);
    expect(service.state().bootingDevices ?? []).toEqual([]);

    encoderResult.value = { code: 1, stdout: '', stderr: 'cannot execute ffmpeg' };
    expect((await rejection(openEmulator())).message).toMatch(/ffmpeg/i);
    encoderResult.value = { code: 0, stdout: ' V....D libx264rgb   libx264 H.264 / AVC RGB (codec h264)', stderr: '' };
    expect((await rejection(openEmulator())).message).toMatch(/libx264/i);
    expect(requests.filter((url) => url.endsWith('/boot'))).toEqual([]);
    expect(service.state().sessions).toEqual([physical, ios]);

    devices.push({
      id: 'emulator-5556',
      name: 'Already_booted',
      platform: 'android',
      version: 'Android 15',
      booted: true,
      physical: false,
    });
    expect(
      (await rejection(service.open({ threadId, deviceId: 'emulator-5556', platform: 'android' }))).message,
    ).toMatch(/libx264/i);

    encoderResult.value = { code: 0, stdout: ' V....D libx264', stderr: '' };
    const emulator = await openEmulator();
    expect(emulator.deviceId).toBe('emulator-5554');
    expect(requests.filter((url) => url.endsWith('/boot'))).toHaveLength(1);
  });

  it('opens emulators on hosts that route their own streams without ffmpeg', async () => {
    const { service, requests, encoderResult } = await fixture({ routesStreams: true });
    encoderResult.value = { code: 127, stdout: '', stderr: 'host commands unavailable' };
    await service.configure({ enabled: true });
    const session = await service.open({ threadId: 'pool-emulator', deviceId: 'Pixel_API_35', platform: 'android' });
    expect(session.deviceId).toBe('emulator-5554');
    expect(requests.filter((url) => url.endsWith('/boot'))).toHaveLength(1);
  });

  it('installs agent support only after the separate agent permission', async () => {
    const { service, agentStarts, agentStops, settings } = await fixture();
    await service.configure({ enabled: true });
    expect(agentStarts).toEqual([]);
    expect(await service.agentReadinessIfSupported()).toBeNull();

    await service.configure({ agentAccessEnabled: true });
    expect(agentStarts).toEqual(['start']);
    expect(settings.value.agentAccessEnabled).toBe(true);
    expect(service.state().agentAccessEnabled).toBe(true);

    await service.configure({ agentAccessEnabled: false, onboardingCompleted: true });
    expect(agentStops).toEqual(['stop']);
    expect(service.state().onboardingCompleted).toBe(true);
    expect(settings.value.onboardingCompleted).toBe(true);
  });
});

it('publishes boot progress and does not restore sessions after support is disabled', async () => {
  const started = deferred();
  const finish = deferred();
  const { service } = await fixture({
    onBoot: async () => {
      started.resolve();
      await finish.promise;
    },
  });
  await service.configure({ enabled: true });
  const opening = settles(service.open({ threadId: 'thread-1', deviceId: 'Pixel_API_35', platform: 'android' }));
  await started.promise;
  expect(service.state().bootingDevices?.map((device) => device.name)).toEqual(['Pixel_API_35']);
  await service.configure({ enabled: false });
  finish.resolve();
  expect(await opening).toBe('failure');
  const state = service.state();
  expect(state.hostStatus).toBe('disabled');
  expect(state.devices).toEqual([]);
  expect(state.sessions).toEqual([]);
  expect(state.bootingDevices).toEqual([]);
});

it.each([
  { case: 'drops it on a host that ends devices itself', endsDevices: true, kept: 0 },
  { case: 'keeps it on a host that can miss a device for one listing', endsDevices: false, kept: 1 },
])("when a host stops listing a session's device, $case", async ({ endsDevices, kept }) => {
  const { service, endDevice } = await fixture({ endsDevices });
  await service.configure({ enabled: true });
  const threadId = 'ended-by-host';
  await service.open({ threadId, deviceId: 'Pixel_API_35', platform: 'android' });
  expect(service.state().sessions.map((session) => session.deviceId)).toEqual(['emulator-5554']);
  endDevice();
  await service.list();
  expect(service.state().sessions).toHaveLength(kept);
});

describe('device discovery after server restart', () => {
  it('captures an explicit device before any client lists devices', async () => {
    const { service, settings, requests } = await fixture();
    await settings.update({ enabled: true });
    expect(service.state().devices).toEqual([]);
    const capture = await service.screenshot({ deviceId: 'Pixel_API_35' });
    expect(capture.device.id).toBe('Pixel_API_35');
    expect(Array.from(capture.png)).toEqual([137, 80, 78, 71]);
    expect(requests.some((url) => url.endsWith('/api/devices'))).toBe(true);
  });
});

const missingPlistMessage =
  '[apple-utils] Failed to read CoreSimulator plist at /Users/test/Library/Developer/CoreSimulator/Devices/deleted-simulator/device.plist:';

it('keeps other discovery warnings and clears them when only a deleted plist remains', async () => {
  const { service, discoveryErrors } = await fixture();
  const missing = { message: missingPlistMessage, error: 'Error: ENOENT: no such file or directory' };
  discoveryErrors.value = [missing, { message: 'Android discovery failed.' }];
  const initial = await service.configure({ enabled: true });
  expect(initial.hostStatusDetail).toBe('Android discovery failed.');
  discoveryErrors.value = [missing];
  const refreshed = await service.list();
  expect(refreshed.hostStatusDetail).toBeUndefined();
  expect(refreshed.hostStatuses.local?.detail).toBeUndefined();
});

it('hides Android discovery failures when the host has no Android SDK', async () => {
  const { service, discoveryErrors, androidAvailable } = await fixture();
  const avdmanagerFailure = { message: '[android-utils] Failed to run `avdmanager list avd`:' };
  discoveryErrors.value = [avdmanagerFailure, { message: 'iOS discovery failed.' }];
  androidAvailable.value = false;
  const withoutSdk = await service.configure({ enabled: true });
  expect(withoutSdk.hostStatusDetail).toBe('iOS discovery failed.');
  androidAvailable.value = true;
  const withSdk = await service.list();
  expect(withSdk.hostStatusDetail).toBe(`${avdmanagerFailure.message}\niOS discovery failed.`);
});

// The hub reports `error` as a util.inspect of Node's exec error.
const simctlMessage = '[apple-utils] Failed to run `xcrun simctl list devices --json`:';
const simctlCause =
  'An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=60): Unable to connect to CoreSimulatorService [xcrun shim fail mode]';
const simctlError = `Error: Command failed: xcrun simctl list devices --json
${simctlCause}

    at genericNodeError (node:internal/errors:986:15)
    at wrappedFn (node:internal/errors:540:14)
    at ChildProcess.exithandler (node:child_process:417:12)
    at ChildProcess._handle.onexit (node:internal/child_process:335:5) {
  code: 1,
  killed: false,
  signal: null,
  cmd: 'xcrun simctl list devices --json',
  stdout: '',
  stderr: '${simctlCause}\\n'
}`;
const avdmanager = '/Users/test/Library/Android/sdk/cmdline-tools/latest/bin/avdmanager';
const avdmanagerError = `Error: spawn ${avdmanager} ENOENT
    at ChildProcess._handle.onexit (node:internal/child_process:316:19)
    at onErrorNT (node:internal/child_process:524:16) {
  errno: -2,
  code: 'ENOENT',
  syscall: 'spawn ${avdmanager}',
  path: '${avdmanager}',
  spawnargs: [ 'list', 'avd' ],
  cmd: '${avdmanager} list avd',
  stdout: '',
  stderr: ''
}`;

it("keeps the cause from the hub's error in discovery warnings, without the stack", async () => {
  const { service, discoveryErrors } = await fixture();
  discoveryErrors.value = [
    { message: simctlMessage, error: simctlError },
    { message: '[android-utils] Failed to run `avdmanager list avd`:', error: avdmanagerError },
  ];
  const state = await service.configure({ enabled: true });
  expect(state.hostStatusDetail).toBe(
    [
      `${simctlMessage} Error: Command failed: xcrun simctl list devices --json ${simctlCause}`,
      `[android-utils] Failed to run \`avdmanager list avd\`: Error: spawn ${avdmanager} ENOENT`,
    ].join('\n'),
  );
  expect(state.hostStatusDetail).not.toContain('    at ');
  expect(state.hostStatusDetail).not.toContain('stderr:');
});

it('keeps the last simulators while simctl cannot list them, and drops them once it can', async () => {
  const { service, devices, discoveryErrors } = await fixture();
  const simulator = {
    id: 'iphone',
    name: 'iPhone',
    platform: 'ios',
    version: 'iOS 26',
    booted: true,
    physical: false,
  } as const;
  devices.push(simulator, { ...simulator, id: 'pixel', platform: 'android' });
  await service.configure({ enabled: true, agentAccessEnabled: true });
  await service.agentReadinessIfSupported();
  devices.length = 0;
  discoveryErrors.value = [{ message: simctlMessage }];
  const failed = await service.list();
  expect(failed.devices.map((device) => device.id)).toEqual(['iphone', 'Pixel_API_35']);
  expect(failed.hostStatuses.local).toEqual({ status: 'ready', detail: simctlMessage, incompletePlatforms: ['ios'] });
  await service.agentReadinessIfSupported();
  expect(service.state().hostStatuses.local).toEqual(failed.hostStatuses.local);
  discoveryErrors.value = [];
  const recovered = await service.list();
  expect(recovered.devices.map((device) => device.id)).toEqual(['Pixel_API_35']);
  expect(recovered.hostStatuses.local).toEqual({ status: 'ready' });
});

it.each([
  { ios: true, android: true, incompletePlatforms: ['ios', 'android'], kept: ['iphone', 'Pixel_API_35'] },
  { ios: true, android: false, incompletePlatforms: ['ios'], kept: ['iphone'] },
  { ios: false, android: true, incompletePlatforms: ['android'], kept: ['Pixel_API_35'] },
] as const)(
  'keeps the devices of listable platforms when the hub does not answer within 40 seconds (iOS: $ios, Android SDK: $android)',
  async ({ ios, android, incompletePlatforms, kept }) => {
    const { service, devices, listing, androidAvailable, iosAvailable } = await fixture();
    androidAvailable.value = android;
    iosAvailable.value = ios;
    devices.push({ id: 'iphone', name: 'iPhone', platform: 'ios', version: 'iOS 26', booted: true, physical: false });
    await service.configure({ enabled: true });
    vi.useFakeTimers();
    listing.hangs = true;
    const listed = service.list();
    await listing.requested.promise;
    await vi.advanceTimersByTimeAsync(40_000);
    const timedOut = await listed;
    expect(timedOut.devices.map((device) => device.id)).toEqual(kept);
    expect(timedOut.hostStatuses.local).toEqual({
      status: 'ready',
      detail: 'The device hub did not answer within 40 seconds.',
      incompletePlatforms,
    });
  },
);

it('does not open a retained pre-boot entry when the post-boot listing is incomplete', async () => {
  const afterBoot = { run: () => undefined as void };
  const android = await fixture({ onBoot: () => afterBoot.run() });
  afterBoot.run = () => {
    android.listing.hangs = true;
  };
  await android.service.configure({ enabled: true });
  vi.useFakeTimers();
  const opening = rejection(
    android.service.open({ threadId: 'boot-timeout', deviceId: 'Pixel_API_35', platform: 'android' }),
  );
  await android.listing.requested.promise;
  await vi.advanceTimersByTimeAsync(40_000);
  expect((await opening)._tag).toBe('DeviceNotFoundError');
  expect(android.service.state().sessions).toEqual([]);
});

it.each([
  {
    diagnostic: 'Insufficient disk space at /private/user/path',
    reason: 'disk_space',
    message: 'not enough free disk space',
  },
  {
    diagnostic: 'Timed out spawning /private/user/command',
    reason: 'timeout',
    message: 'did not become ready in time',
  },
  {
    diagnostic: 'The emulator process exited with code 1.\nTry manually: emulator -avd Pixel_API_35',
    reason: 'launch_failed',
    message: 'could not start',
  },
] as const)('normalizes boot failure: $reason', async ({ diagnostic, reason, message }) => {
  const { service } = await fixture({ bootError: diagnostic });
  await service.configure({ enabled: true });
  const error = await rejection(service.open({ threadId: 'boot-failure', deviceId: 'Pixel_API_35', platform: 'android' }));
  expect(error._tag).toBe('DeviceBootError');
  expect(error.fields?.reason).toBe(reason);
  expect(error.message).toContain(message);
  expect(error.message).toContain(diagnostic);
  expect(service.state().bootingDevices).toEqual([]);
});

// regression: #22012 report Android emulator boot failures
it('includes nested hub boot diagnostics and bounds them to 2,000 characters', async () => {
  const diagnostic = 'Error: emulator binary missing\n' + 'diagnostic output\n'.repeat(200);
  const { service } = await fixture({
    bootError: {
      error: 'Failed to spawn emulator',
      errors: [{ message: 'Failed to launch emulator binary', error: diagnostic }],
    },
  });
  await service.configure({ enabled: true });
  const error = await rejection(
    service.open({ threadId: 'nested-boot-failure', deviceId: 'Pixel_API_35', platform: 'android' }),
  );
  expect(error).toBeInstanceOf(DeviceBootError);
  const diagnostics = (error as DeviceBootError).fields.diagnostics;
  const expected = `Failed to spawn emulator\n\nFailed to launch emulator binary\n\n${diagnostic}`;
  expect(diagnostics).toBe(`${expected.slice(0, 1_999)}…`);
  expect(diagnostics).toHaveLength(2_000);
  expect(error.message).toContain(diagnostics);
  // The HTTP body carries the same message.
  expect(deviceErrorResponse(error).body).toEqual({ _tag: 'DeviceBootError', message: error.message });
  expect(service.state().bootingDevices).toEqual([]);
});

it('keeps shutdown successful when subsequent discovery fails', async () => {
  const { service } = await fixture({ failListAfterShutdown: true });
  await service.configure({ enabled: true });
  const threadId = 'shutdown-refresh';
  const session = await service.open({ threadId, deviceId: 'Pixel_API_35', platform: 'android' });
  await service.close({ threadId, deviceId: session.deviceId, shutdown: true });
  const state = service.state();
  expect(state.sessions).toEqual([]);
  expect(state.devices.find((device) => device.id === session.deviceId)?.booted).toBe(false);
});

const simulatorHost = (ready: DeviceHostReady, overrides: Partial<DeviceHost> = {}): DeviceHost => ({
  id: LOCAL_DEVICE_HOST_ID,
  label: 'This machine',
  summary: async () => ({
    id: LOCAL_DEVICE_HOST_ID,
    kind: 'local',
    label: 'Simulator host',
    platforms: [{ platform: 'ios', available: true }],
    hubInstalled: true,
    agentDeviceInstalled: false,
  }),
  platformAvailability: async (platform) => ({ platform, available: true }),
  ensureReady: async () => ready,
  ensureAgentReady: async () => {
    throw new Error('Agent access is not used in this test');
  },
  current: async () => ready,
  stopAgent: async () => undefined,
  stop: async () => undefined,
  ...overrides,
});

const quietRun: DeviceHostReady['run'] = async () => ({ code: 0, stdout: '', stderr: '' });

it.each(['shutdown', 'close'] as const)(
  "%s releases iOS capture and the session's launcher so reopening uses a fresh session",
  async (operation) => {
    const deviceId = '11111111-1111-1111-1111-111111111111';
    const threadId = 'capture-recovery';
    let booted = true;
    let capture: number | null = null;
    let generation = 0;
    const http: typeof fetch = async (input, init) => {
      const path = new URL(urlOf(input)).pathname;
      if (path === '/api/devices') {
        return Response.json({
          emulators: [],
          simulators: [{ id: deviceId, name: 'iPhone', platform: 'ios', version: '26', physical: false, booted }],
        });
      }
      if (path === '/vendor/serve-sim/grid/api/start') capture ??= ++generation;
      else if (path === '/vendor/serve-sim/grid/api/shutdown') {
        expect(bodyOf(init)).toEqual({ udid: deviceId });
        capture = null;
        booted = false;
      } else if (path === '/api/devices/shutdown') {
        // This route powers off without releasing serve-sim's cached capture.
        booted = false;
      } else if (path === '/api/devices/boot') booted = true;
      else throw new Error(`Unexpected hub path: ${path}`);
      return Response.json({ ok: true, id: deviceId });
    };
    const ready: DeviceHostReady = {
      nodePath: process.execPath,
      hub: { origin: 'http://device.test' },
      devices: makeDeviceHubOperations({
        hostId: LOCAL_DEVICE_HOST_ID,
        origin: 'http://device.test',
        fetch: http,
        run: quietRun,
        platformAvailable: async () => true,
      }),
      helpers: { serveSimAxSettings: null, serveSimCli: null },
      run: quietRun,
    };
    const host = simulatorHost(ready);
    const launchers = new Set(['t3-from-a-previous-run']);
    const released: Array<[string, boolean]> = [];
    // Whether the device was still on when each session was released.
    const releasedWhileBooted: Array<boolean> = [];
    let pauseBind: { entered: ReturnType<typeof deferred<void>>; proceed: ReturnType<typeof deferred<void>> } | null = null;
    const launcherPort: AgentDeviceLaunchers = {
      bind: async ({ session }) => {
        if (pauseBind) {
          pauseBind.entered.resolve();
          await pauseBind.proceed.promise;
        }
        launchers.add(session);
        return session;
      },
      prune: async (live) => {
        for (const session of launchers) if (!live.has(session)) launchers.delete(session);
      },
      // Records whether the launcher still existed, since its close runs through it.
      release: async (launcher) => {
        released.push([launcher, launchers.has(launcher)]);
        releasedWhileBooted.push(booted);
      },
    };
    const service = await makeDeviceServiceWithHosts(new Map([[host.id, host]]), {
      settings: memoryDeviceSettingsStore({ enabled: true }),
      launchers: launcherPort,
    });
    expect(launchers).toEqual(new Set());
    const input = { threadId, deviceId, platform: 'ios' as const };
    const other = { ...input, threadId: 'capture-recovery-other' };
    const target = (thread: string) => ({ threadId: thread, hostId: LOCAL_DEVICE_HOST_ID, deviceId });
    const bind = async (open: typeof input) => {
      await service.open(open);
      await service.agentLauncher({ ...target(open.threadId), targetArgs: [] });
      return agentDeviceSession(open.threadId, LOCAL_DEVICE_HOST_ID, deviceId);
    };
    const retire = (input: { threadId: string; deviceId: string; platform: 'ios' }) =>
      operation === 'shutdown'
        ? service.shutdown({ deviceId: input.deviceId, platform: input.platform })
        : service.close({ threadId: input.threadId, deviceId: input.deviceId, shutdown: true });
    const session = await bind(input);
    await bind(other);
    expect(capture).toBe(1);
    expect(launchers.size).toBe(2);
    await retire(input);
    expect(capture).toBeNull();
    expect(service.state().sessions).toEqual([]);
    expect(launchers).toEqual(new Set());
    // Retiring a session ends its agent-device session too, which releases the device claim.
    // Powering the device off retires the other thread's session on it as well.
    const firstOther = agentDeviceSession(other.threadId, LOCAL_DEVICE_HOST_ID, deviceId);
    expect(new Set(released.map(([launcher]) => launcher))).toEqual(new Set([session, firstOther]));
    expect(released.every(([, existed]) => existed)).toBe(true);
    // agent-device can close the session's app only while the device is on.
    expect(releasedWhileBooted).toEqual([true, true]);
    // A device_open that was still preparing when the close landed.
    expect(await service.agentLauncher({ ...target(threadId), targetArgs: [] })).toBeNull();
    expect(launchers).toEqual(new Set());
    expect(await bind(input)).toBe(session);
    // Reopening the same device ends nothing.
    expect(released).toHaveLength(2);
    expect(capture).toBe(2);
    expect(service.state().sessions).toHaveLength(1);
    const otherSession = await bind(other);
    await service.close({ threadId: other.threadId });
    expect(launchers).toEqual(new Set([session]));
    expect(released.slice(2)).toEqual([[otherSession, true]]);
    expect(otherSession).not.toBe(session);
    // A retirement that commits while a bind holds the launcher lock still prunes the bound launcher.
    pauseBind = { entered: deferred(), proceed: deferred() };
    const binding = service.agentLauncher({ ...target(threadId), targetArgs: [] });
    await pauseBind.entered.promise;
    const updates: DeviceServiceState[] = [];
    const firstUpdate = deferred();
    const unsubscribe = service.subscribe((state) => {
      updates.push(state);
      firstUpdate.resolve();
    });
    const retiring = settles(operation === 'shutdown' ? retire(input) : service.close({ threadId }));
    await firstUpdate.promise;
    expect(updates[0]?.sessions).toEqual([]);
    await service.refreshHosts();
    expect(service.state().sessions).toEqual([]);
    pauseBind.proceed.resolve();
    await binding;
    await retiring;
    unsubscribe();
    expect(launchers).toEqual(new Set());
  },
);

it('leaves a session its host leases to every thread open when one thread closes', async () => {
  const deviceId = '33333333-3333-3333-3333-333333333333';
  const http: typeof fetch = async (input) =>
    new URL(urlOf(input)).pathname === '/api/devices'
      ? Response.json({
          emulators: [],
          simulators: [{ id: deviceId, name: 'iPhone', platform: 'ios', version: '26', physical: false, booted: true }],
        })
      : Response.json({ ok: true, id: deviceId });
  const ready: DeviceHostAgentReady = {
    nodePath: process.execPath,
    hub: { origin: 'http://device.test' },
    devices: {
      ...makeDeviceHubOperations({
        hostId: LOCAL_DEVICE_HOST_ID,
        origin: 'http://device.test',
        fetch: http,
        run: quietRun,
        platformAvailable: async () => true,
      }),
      agentEndpoint: async () => ({
        baseUrl: 'http://agent.test',
        token: 'agent-token',
        agentDeviceId: null,
        session: 'lease-session',
      }),
    },
    helpers: { serveSimAxSettings: null, serveSimCli: null },
    run: quietRun,
    agentDevice: null,
  };
  const host = simulatorHost(ready, { label: 'Pool', ensureAgentReady: async () => ready });
  const released: string[] = [];
  const service = await makeDeviceServiceWithHosts(new Map([[host.id, host]]), {
    settings: memoryDeviceSettingsStore({ enabled: true, agentAccessEnabled: true }),
    configureAgent: async () => 'agent-device.json',
    launchers: {
      bind: async ({ session }) => session,
      prune: async () => undefined,
      release: async (launcher) => void released.push(launcher),
    },
  });
  const threads = ['pool-a', 'pool-b'];
  for (const threadId of threads) {
    await service.open({ threadId, deviceId, platform: 'ios' });
    const target = { threadId, hostId: LOCAL_DEVICE_HOST_ID, deviceId };
    const agent = await service.agentTarget(target);
    expect(agent.session).toBe('lease-session');
    await service.agentLauncher({ ...target, targetArgs: agent.args });
  }
  await service.close({ threadId: threads[0]! });
  expect(released).toEqual([]);
});

it.each([
  { hubReports: 'off', outcome: 'succeeds' },
  { hubReports: 'booted', outcome: 'fails' },
  { hubReports: 'missing', outcome: 'fails' },
] as const)(
  'iOS shutdown $outcome when serve-sim rejects it and the hub reports the simulator $hubReports',
  async ({ hubReports, outcome }) => {
    const deviceId = '22222222-2222-2222-2222-222222222222';
    const paths: string[] = [];
    let listed: 'booted' | 'off' | 'missing' = 'booted';
    const http: typeof fetch = async (input) => {
      const path = new URL(urlOf(input)).pathname;
      paths.push(path);
      if (path === '/api/devices') {
        return Response.json({
          emulators: [],
          simulators:
            listed === 'missing'
              ? []
              : [{ id: deviceId, name: 'iPhone', platform: 'ios', version: '26', physical: false, booted: listed === 'booted' }],
          errors: listed === 'missing' ? [{ message: 'simctl list failed' }] : [],
        });
      }
      if (path === '/vendor/serve-sim/grid/api/shutdown') {
        // serve-sim runs `simctl shutdown` bare and returns its failure as-is.
        listed = hubReports;
        return Response.json({ ok: false, error: 'Unable to shutdown device in current state: Shutdown' }, { status: 500 });
      }
      throw new Error(`Unexpected hub path: ${path}`);
    };
    const ready: DeviceHostReady = {
      nodePath: process.execPath,
      hub: { origin: 'http://device.test' },
      devices: makeDeviceHubOperations({
        hostId: LOCAL_DEVICE_HOST_ID,
        origin: 'http://device.test',
        fetch: http,
        run: quietRun,
        platformAvailable: async () => true,
      }),
      helpers: { serveSimAxSettings: null, serveSimCli: null },
      run: quietRun,
    };
    const host = simulatorHost(ready);
    const service = await makeDeviceServiceWithHosts(new Map([[host.id, host]]), {
      settings: memoryDeviceSettingsStore({ enabled: true }),
    });
    await service.list();
    const result = await settles(service.shutdown({ deviceId, platform: 'ios' }));
    expect(paths.filter((path) => path.endsWith('shutdown'))).toEqual(['/vendor/serve-sim/grid/api/shutdown']);
    if (outcome === 'succeeds') {
      expect(result).toBe('success');
      expect(service.state().devices.find((device) => device.id === deviceId)?.booted).toBe(false);
    } else {
      expect(result).toBe('failure');
      expect(service.state().devices.find((device) => device.id === deviceId)?.booted).toBe(true);
    }
  },
);

it.each([LOCAL_DEVICE_HOST_ID, 'remote-fixture'])(
  'retains hub inventory on %s when AVD enumeration fails and recovers on retry',
  async (hostId) => {
    let enumeration = { code: 1, stdout: 'private stdout', stderr: 'private stderr' };
    const run: DeviceHostReady['run'] = async () => enumeration;
    const hubDevices = [
      { id: 'iphone', name: 'iPhone', platform: 'ios', physical: false },
      { id: 'phone', name: 'Pixel', platform: 'android', physical: true },
      { id: 'emulator-5554', name: 'Running_AVD', platform: 'android', physical: false },
    ].map((device) => ({ ...device, booted: true, version: 'test' }));
    const http: typeof fetch = async () =>
      Response.json({ simulators: hubDevices.slice(0, 1), emulators: hubDevices.slice(1) });
    const ready: DeviceHostReady = {
      nodePath: process.execPath,
      hub: { origin: 'http://device.test' },
      devices: makeDeviceHubOperations({ hostId, origin: 'http://device.test', fetch: http, run, platformAvailable: async () => true }),
      helpers: { serveSimAxSettings: null, serveSimCli: null },
      run,
    };
    const host: DeviceHost = {
      id: hostId,
      label: 'Test device host',
      remote: hostId !== LOCAL_DEVICE_HOST_ID,
      summary: async () => ({
        id: hostId,
        kind: 'local',
        label: 'Test device host',
        platforms: [{ platform: 'android', available: true }],
        hubInstalled: true,
        agentDeviceInstalled: false,
      }),
      platformAvailability: async (platform) => ({ platform, available: true }),
      ensureReady: async () => ready,
      ensureAgentReady: async () => {
        throw new Error('Agent access is not used in this test');
      },
      current: async () => ready,
      stop: async () => undefined,
      stopAgent: async () => undefined,
    };
    const service = await makeDeviceServiceWithHosts(new Map([[hostId, host]]), {
      settings: memoryDeviceSettingsStore({ enabled: true }),
    });

    const incomplete = await service.list();
    expect(incomplete.devices).toEqual(hubDevices.map((device) => ({ ...device, hostId })));
    expect(incomplete.hostStatuses[hostId]).toEqual({
      status: 'ready',
      androidDiscoveryIncomplete: true,
      detail:
        'Could not list Android virtual devices (emulator -list-avds, exit code 1). Discovered devices remain available.',
    });
    if (hostId === LOCAL_DEVICE_HOST_ID) {
      expect(incomplete.hostStatusDetail).toBe(incomplete.hostStatuses[hostId]?.detail);
    }

    enumeration = { code: 0, stdout: 'Running_AVD\r\nStopped_AVD\nStopped_AVD\n', stderr: '' };
    const recovered = await service.retryHost(hostId);
    expect(recovered.devices).toEqual([
      ...hubDevices.map((device) => ({ ...device, hostId })),
      { hostId, id: 'Stopped_AVD', name: 'Stopped_AVD', platform: 'android', version: 'Android', booted: false, physical: false },
    ]);
    expect(recovered.hostStatuses[hostId]).toEqual({ status: 'ready' });
    if (hostId === LOCAL_DEVICE_HOST_ID) expect(recovered.hostStatusDetail).toBeUndefined();
  },
);

it('retry keeps device and agent consent unchanged', async () => {
  const { service, starts, agentStarts } = await fixture();
  await service.retryHost(LOCAL_DEVICE_HOST_ID);
  expect(starts).toEqual([]);
  expect(agentStarts).toEqual([]);
  await service.configure({ enabled: true });
  await service.retryHost(LOCAL_DEVICE_HOST_ID);
  expect(agentStarts).toEqual([]);
  await service.configure({ agentAccessEnabled: true });
  const before = agentStarts.length;
  await service.retryHost(LOCAL_DEVICE_HOST_ID);
  expect(agentStarts.length).toBe(before + 1);
});

it('failed read-only discovery preserves lifecycle status and installed inventory', async () => {
  const { service, starts } = await fixture({ inspectError: true });
  const state = await service.inspect();
  expect(state.supportsToolInspection).toBe(true);
  expect(state.hostStatus).toBe('disabled');
  expect(state.hosts[0]?.hubInstalled).toBe(true);
  expect(state.hosts[0]?.toolInspectionError).toContain('Reconnect the host');
  expect(starts).toEqual([]);
});

it('manual updates install only the selected tool without enabling access or starting helpers', async () => {
  const installed: string[] = [];
  const { service, starts, agentStarts, requests } = await fixture({
    installTool: async (tool) => {
      installed.push(tool);
    },
  });
  const before = service.state();
  const state = await service.updateTool('agent');
  expect(installed).toEqual(['agent']);
  expect(state.supportsToolUpdate).toBe(true);
  expect(state.hostStatus).toBe(before.hostStatus);
  expect(state.agentAccessEnabled).toBe(before.agentAccessEnabled);
  expect(state.revision).toBeGreaterThan(before.revision);
  expect(starts).toEqual([]);
  expect(agentStarts).toEqual([]);
  expect(requests).toEqual([]);
  await service.updateTool('hub');
  expect(installed).toEqual(['agent', 'hub']);
});

it('failed manual installation leaves lifecycle state unchanged and can be retried', async () => {
  let attempts = 0;
  const { service, starts, agentStarts } = await fixture({
    installTool: async () => {
      if (++attempts === 1)
        throw new DeviceOperationError({
          operation: 'update device tool',
          reason: 'command_failed',
          cause: new Error('offline'),
        });
    },
  });
  const before = service.state();
  expect(await settles(service.updateTool('agent'))).toBe('failure');
  expect(service.state()).toEqual(before);
  await service.updateTool('agent');
  expect(attempts).toBe(2);
  expect(starts).toEqual([]);
  expect(agentStarts).toEqual([]);
});

it("a failed tool update reports npm's exit code but not its output", async () => {
  const { directory, cleanup } = await tempDir('device-update-');
  try {
    const host: DeviceHost = {
      id: LOCAL_DEVICE_HOST_ID,
      label: 'This machine',
      summary: async () => ({
        id: LOCAL_DEVICE_HOST_ID,
        kind: 'local',
        label: 'Test server',
        platforms: [],
        hubInstalled: false,
        agentDeviceInstalled: false,
      }),
      platformAvailability: async (platform) => ({ platform, available: false }),
      ensureReady: async () => {
        throw new Error('Updating a tool does not start the hub');
      },
      ensureAgentReady: async () => {
        throw new Error('Updating a tool does not start the agent');
      },
      current: async () => null,
      stopAgent: async () => undefined,
      stop: async () => undefined,
    };
    const npmFailure = processOutput(
      243,
      '',
      'npm error EACCES https://private:credential@registry.example.test/expo-device-hub',
    );
    const service = await createDeviceService({
      stateDir: directory,
      hosts: [host],
      settings: memoryDeviceSettingsStore({ enabled: true }),
      runtime: fakeRuntime({ runner: { run: async () => npmFailure } }),
    });
    const error = await rejection(service.updateTool('hub'));
    expect(error).toBeInstanceOf(DeviceOperationError);
    expect(error.fields).toMatchObject({ reason: 'command_failed', exitCode: 243 });
    expect(error.message).toBe('Device update device tool failed: The device command failed (exit code 243).');
  } finally {
    await cleanup();
  }
});

describe('agent session release on close', () => {
  const openClaim = (service: DeviceService, threadId: string, deviceId = 'Pixel_API_35') =>
    service.open({ threadId, deviceId, platform: 'android' });

  it("releases only the caller's session, keeps the device booted, and is idempotent", async () => {
    const { service, closedSessions, requests } = await fixture();
    await service.configure({ enabled: true, agentAccessEnabled: true });
    const threadId = 'closing';
    const other = 'other';
    const session = await openClaim(service, threadId);
    await openClaim(service, other, session.deviceId);
    await service.close({ threadId, deviceId: session.deviceId });
    await service.close({ threadId, deviceId: session.deviceId });
    const name = agentDeviceSession(threadId, session.hostId, session.deviceId);
    expect(closedSessions).toEqual([
      {
        jsonrpc: '2.0',
        id: name,
        method: 'agent_device.command',
        params: { command: 'close', session: name, positionals: [], flags: {} },
      },
    ]);
    const state = service.state();
    expect(state.sessions.map((entry) => entry.threadId)).toEqual([other]);
    expect(state.devices.find((entry) => entry.id === session.deviceId)?.booted).toBe(true);
    expect(requests.some((url) => url.endsWith('/shutdown'))).toBe(false);
  });

  it.each(['reject', 'http_error', 'malformed'] as const)('retains retryable state on %s', async (failure) => {
    let fail = true;
    const { service, requests, closedSessions } = await fixture({ onClose: () => (fail ? failure : 'ok') });
    await service.configure({ enabled: true, agentAccessEnabled: true });
    const threadId = 'retry';
    await openClaim(service, threadId);
    expect(await settles(service.close({ threadId, shutdown: true }))).toBe('failure');
    expect(service.state().sessions).toHaveLength(1);
    expect(requests.some((url) => url.endsWith('/shutdown'))).toBe(false);
    fail = false;
    await service.close({ threadId });
    expect(service.state().sessions).toHaveLength(0);
    expect(closedSessions).toHaveLength(2);
  });

  it.each([false, true])('accepts a missing agent session, shutdown=%s', async (shutdown) => {
    const { service, requests } = await fixture({ onClose: () => 'missing' });
    await service.configure({ enabled: true, agentAccessEnabled: true });
    const threadId = 'no-claim';
    await openClaim(service, threadId);
    await service.close({ threadId, shutdown });
    expect(service.state().sessions).toHaveLength(0);
    expect(requests.some((url) => url.endsWith('/shutdown'))).toBe(shutdown);
  });

  it('retries shutdown after the first attempt already released the agent session', async () => {
    let released = false;
    const { service, connection } = await fixture({
      onClose: () => {
        const result = released ? 'missing' : 'ok';
        released = true;
        return result;
      },
    });
    await service.configure({ enabled: true, agentAccessEnabled: true });
    const threadId = 'retry-shutdown';
    await openClaim(service, threadId);
    connection.failShutdown = true;
    expect(await settles(service.close({ threadId, shutdown: true }))).toBe('failure');
    expect(service.state().sessions).toHaveLength(1);
    connection.failShutdown = false;
    await service.close({ threadId, shutdown: true });
    expect(service.state().sessions).toHaveLength(0);
  });

  it('releases the post-boot agentTarget session for a cold Android AVD', async () => {
    const { service, closedSessions } = await fixture();
    await service.configure({ enabled: true, agentAccessEnabled: true });
    const threadId = 'cold-avd';
    const before = await service.agentTarget({ threadId, hostId: 'local', deviceId: 'Pixel_API_35' });
    const session = await openClaim(service, threadId);
    const after = await service.agentTarget({ threadId, hostId: session.hostId, deviceId: session.deviceId });
    expect(session.deviceId).toBe('emulator-5554');
    expect(after.args[3]).not.toBe(before.args[3]);
    await service.close({ threadId });
    expect(closedSessions).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ session: after.args[3] }) }),
    ]);
  });

  it('retains a remote record during reconnect and releases it on retry', async () => {
    const { service, connection, closedSessions, agentStarts } = await fixture();
    connection.remote = true;
    await service.configure({ enabled: true, agentAccessEnabled: true });
    const threadId = 'remote-reconnect';
    await openClaim(service, threadId);
    const starts = agentStarts.length;
    connection.online = false;
    expect(await settles(service.close({ threadId }))).toBe('failure');
    expect(service.state().sessions).toHaveLength(1);
    expect(closedSessions).toHaveLength(0);
    expect(agentStarts).toHaveLength(starts);
    connection.online = true;
    await service.close({ threadId });
    expect(service.state().sessions).toHaveLength(0);
    expect(closedSessions).toHaveLength(1);
  });

  it('releases peer claims before a close shuts down', async () => {
    const { service, closedSessions } = await fixture();
    await service.configure({ enabled: true, agentAccessEnabled: true });
    const threadId = 'shutting-down';
    const other = 'peer';
    const session = await openClaim(service, threadId);
    await openClaim(service, other, session.deviceId);
    await service.close({ threadId, shutdown: true });
    expect(service.state().sessions).toHaveLength(0);
    await service.close({ threadId: other });
    expect(service.state().sessions).toHaveLength(0);
    const names = [threadId, other].map((thread) => agentDeviceSession(thread, session.hostId, session.deviceId));
    expect(closedSessions.map((body) => (body as { params: { session: string } }).params.session)).toEqual(names);
  });

  it('publishes a reopened session only after the old claim is released and removed', async () => {
    const entered = asyncQueue();
    const releasing = deferred();
    const finish = deferred();
    const { service } = await fixture({
      onClose: async () => {
        releasing.resolve();
        await finish.promise;
        return 'ok' as const;
      },
      onPlatformAvailability: () => entered.offer(),
    });
    await service.configure({ enabled: true, agentAccessEnabled: true });
    const threadId = 'reopen';
    const session = await openClaim(service, threadId);
    await entered.take();
    const publications: DeviceServiceState[] = [];
    service.subscribe((state) => publications.push(state));
    const closing = service.close({ threadId });
    await releasing.promise;
    const opening = openClaim(service, threadId, session.deviceId);
    await entered.take();
    finish.resolve();
    await closing;
    const reopened = await opening;
    const published = publications
      .map(({ sessions }) => (sessions.includes(session) ? 'old' : sessions.includes(reopened) ? 'reopened' : 'none'))
      .filter((label, index, labels) => label !== labels[index - 1]);
    expect(published).toEqual(['none', 'reopened']);
  });
});

describe('locating a device id across hosts', () => {
  const threadId = 'thread-locate';
  const thisMachine = { id: LOCAL_DEVICE_HOST_ID, label: 'This machine' };
  const macMini = { id: 'mac-mini', label: 'Mac Mini' };
  const listingHost = (host: { readonly id: string; readonly label: string }, ids: ReadonlyArray<string>): DeviceHost => {
    const devices = ids.map((id) => ({
      id,
      name: id,
      platform: id.startsWith('Pixel') ? ('android' as const) : ('ios' as const),
      version: 'test',
      booted: true,
      physical: false,
    }));
    const ready: DeviceHostReady = {
      nodePath: process.execPath,
      hub: { origin: 'http://device.test' },
      devices: {
        list: async () => ({ devices, detail: undefined }),
        boot: async (device) => device.id,
        attach: async () => undefined,
        shutdown: async () => undefined,
        screenshot: async () => new Uint8Array(),
      },
      // Opening an emulator checks its host for ffmpeg's H.264 encoder.
      run: async () => ({ code: 0, stdout: ' V....D libx264', stderr: '' }),
      helpers: { serveSimAxSettings: null, serveSimCli: null },
    };
    return {
      ...host,
      remote: host.id !== LOCAL_DEVICE_HOST_ID,
      summary: async () => ({
        ...host,
        kind: 'local',
        platforms: [
          { platform: 'ios', available: true },
          { platform: 'android', available: true },
        ],
        hubInstalled: true,
        agentDeviceInstalled: false,
      }),
      platformAvailability: async (platform) => ({ platform, available: true }),
      ensureReady: async () => ready,
      ensureAgentReady: async () => {
        throw new Error('Agent access is not used in this test');
      },
      current: async () => ready,
      stopAgent: async () => undefined,
      stop: async () => undefined,
    };
  };
  // An Android AVD name, like Pixel_10 here, can exist on two hosts.
  const withTwoHosts = async (test: (service: DeviceService) => Promise<void>) => {
    const service = await makeDeviceServiceWithHosts(
      new Map([
        [thisMachine.id, listingHost(thisMachine, ['Pixel_10'])],
        [macMini.id, listingHost(macMini, ['MAC-UDID', 'Pixel_10'])],
      ]),
      { settings: memoryDeviceSettingsStore({ enabled: true }) },
    );
    await service.list();
    await test(service);
  };
  const open = (service: DeviceService, hostId: string, deviceId: string, thread = threadId) =>
    service.open({
      threadId: thread,
      hostId,
      deviceId,
      platform: deviceId.startsWith('Pixel') ? 'android' : 'ios',
    });

  it('finds a device id that exists only on another host', () =>
    withTwoHosts(async (service) => {
      expect(await service.locateDevice({ deviceId: 'MAC-UDID' })).toMatchObject({ hostId: 'mac-mini', id: 'MAC-UDID' });
    }));

  it('refuses a device id that exists on two hosts and names both', () =>
    withTwoHosts(async (service) => {
      const error = await rejection(service.locateDevice({ deviceId: 'Pixel_10' }));
      expect(error).toMatchObject({ _tag: 'DeviceHostAmbiguousError', deviceId: 'Pixel_10' });
      const hosts = (error as unknown as { hosts: unknown[] }).hosts;
      expect(hosts).toHaveLength(2);
      expect(hosts).toEqual(expect.arrayContaining([thisMachine, macMini]));
    }));

  it('keeps an explicit hostId and says which host has the device', () =>
    withTwoHosts(async (service) => {
      const error = await rejection(service.locateDevice({ deviceId: 'MAC-UDID', hostId: LOCAL_DEVICE_HOST_ID }));
      expect(error).toMatchObject({
        _tag: 'DeviceOnOtherHostError',
        deviceId: 'MAC-UDID',
        host: thisMachine,
        hosts: [macMini],
      });
      expect(await service.locateDevice({ deviceId: 'Pixel_10', hostId: 'mac-mini' })).toMatchObject({
        hostId: 'mac-mini',
        id: 'Pixel_10',
      });
    }));

  it('finds nothing for a device id that no host lists', () =>
    withTwoHosts(async (service) => {
      const deviceId = 'Pixel_9';
      expect(await service.locateDevice({ deviceId })).toBeUndefined();
      expect(await service.locateDevice({ deviceId, hostId: 'mac-mini' })).toBeUndefined();
      expect(await service.locateDevice({ deviceId, hostId: 'unknown-host' })).toBeUndefined();
    }));

  it('finds an open device by id on whichever host it is on', () =>
    withTwoHosts(async (service) => {
      await open(service, 'mac-mini', 'MAC-UDID');
      const deviceId = 'MAC-UDID';
      expect(await service.locateSession({ threadId, deviceId })).toMatchObject({ threadId, hostId: 'mac-mini', deviceId });
      const error = await rejection(service.locateSession({ threadId, deviceId, hostId: LOCAL_DEVICE_HOST_ID }));
      expect(error).toMatchObject({ _tag: 'DeviceOnOtherHostError', host: thisMachine, hosts: [macMini] });
    }));

  it('refuses an id open on two hosts unless the hostId picks one', () =>
    withTwoHosts(async (service) => {
      await open(service, LOCAL_DEVICE_HOST_ID, 'Pixel_10');
      await open(service, 'mac-mini', 'Pixel_10');
      const deviceId = 'Pixel_10';
      const error = await rejection(service.locateSession({ threadId, deviceId }));
      expect(error).toMatchObject({ _tag: 'DeviceHostAmbiguousError', deviceId });
      expect((error as unknown as { hosts: unknown[] }).hosts).toEqual(expect.arrayContaining([thisMachine, macMini]));
      expect(await service.locateSession({ threadId, deviceId, hostId: 'mac-mini' })).toMatchObject({
        hostId: 'mac-mini',
        deviceId,
      });
    }));

  it('finds no session for a device this thread has not opened', () =>
    withTwoHosts(async (service) => {
      const deviceId = 'MAC-UDID';
      expect(await service.locateSession({ threadId, deviceId })).toBeUndefined();
      await open(service, 'mac-mini', 'MAC-UDID', 'thread-other');
      expect(await service.locateSession({ threadId, deviceId })).toBeUndefined();
      expect(await service.locateSession({ threadId, deviceId, hostId: LOCAL_DEVICE_HOST_ID })).toBeUndefined();
    }));
});
