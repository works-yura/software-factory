import * as NodeFSP from 'node:fs/promises';
import * as NodePath from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DeviceHostUnavailableError } from '../contracts.ts';
import type { DeviceHost } from './DeviceHost.ts';
import { AGENT_DEVICE_VERSION, agentDeviceStateDir, DEVICE_HUB_VERSION } from './DeviceToolchain.ts';
import { __testing, createLocalDeviceHost } from './LocalDeviceHost.ts';
import {
  type ChildHandle,
  type DeviceFs,
  fileExists,
  ProcessReadError,
  type ProcessRunInput,
  type ProcessRunOutput,
  ProcessSpawnError,
} from './runtime.ts';
import { fakeRuntime, processOutput, tempDir } from './testing.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const noopPhase = () => undefined;

const rejection = <T>(promise: Promise<T>) =>
  promise.then(
    () => expect.unreachable('expected a rejection'),
    (error: unknown) => error as Error & Record<string, unknown>,
  );

const agentFixture = async (
  startup: (stateDir: string) => Promise<ProcessRunOutput>,
  avdOutput: ProcessRunOutput = processOutput(0),
  previousDaemon?: { httpPort: number; token: string; pid?: number; version?: string },
) => {
  const { directory: baseDir, cleanup } = await tempDir('device-agent-start-');
  cleanups.push(cleanup);
  const hub = { running: true, spawnFails: false };
  const stateDir = agentDeviceStateDir(NodePath.join(baseDir, 'userdata'));
  const daemonHealthy = { value: true };
  const runs: Array<ProcessRunInput> = [];
  for (const [name, version, entry] of [
    ['expo-device-hub', DEVICE_HUB_VERSION, 'dist/server/cli.mjs'],
    ['agent-device', AGENT_DEVICE_VERSION, 'bin/agent-device.mjs'],
  ] as const) {
    const installDir = NodePath.join(baseDir, 'tools', name, version);
    const entryPath = NodePath.join(installDir, 'node_modules', name, entry);
    await NodeFSP.mkdir(NodePath.dirname(entryPath), { recursive: true });
    await NodeFSP.writeFile(entryPath, '');
    await NodeFSP.writeFile(NodePath.join(installDir, '.install-complete'), version);
  }
  if (previousDaemon) {
    await NodeFSP.mkdir(stateDir, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(stateDir, 'daemon.json'), JSON.stringify(previousDaemon));
  }
  const host = await createLocalDeviceHost({
    baseDir,
    stateDir: NodePath.join(baseDir, 'userdata'),
    runtime: fakeRuntime({
      env: { HOME: baseDir, PATH: '' },
      isExecutable: false,
      platform: 'darwin',
      spawn: async (command, args) => {
        if (hub.spawnFails) {
          throw new ProcessSpawnError({
            command,
            argumentCount: args.length,
            cause: Object.assign(new Error('Hub entry missing'), { code: 'ENOENT' }),
          });
        }
        return {
          pid: 123,
          isRunning: () => hub.running,
          exited: new Promise<void>(() => undefined),
          kill: () => undefined,
          onOutputLine: () => undefined,
        } satisfies ChildHandle;
      },
      runner: {
        run: async (input) => {
          runs.push(input);
          return input.args.includes('devices')
            ? startup(stateDir)
            : input.args.includes('-list-avds')
              ? avdOutput
              : processOutput(0);
        },
      },
      fetch: async (input) =>
        new Response('ok', { status: String(input).endsWith('/health') && !daemonHealthy.value ? 503 : 200 }),
    }),
  });
  cleanups.push(() => host.stop());
  await host.ensureReady(noopPhase);
  return { host, baseDir, stateDir, hub, daemonHealthy, runs };
};

const mustNotStart = async (): Promise<ProcessRunOutput> => {
  throw new Error('A session that never readies agent tools must not start the daemon');
};

describe('AgentDevice startup', () => {
  it('restarts a cached daemon that no longer answers its health check', async () => {
    let attempts = 0;
    const { host, daemonHealthy } = await agentFixture(async (stateDir) => {
      attempts++;
      await NodeFSP.writeFile(
        `${stateDir}/daemon.json`,
        JSON.stringify({ httpPort: 12345 + attempts, token: `token-${attempts}` }),
      );
      return processOutput(0);
    });
    const first = await host.ensureAgentReady(noopPhase);
    expect((await host.ensureAgentReady(noopPhase)).agentDevice).toEqual(first.agentDevice);
    expect(attempts).toBe(1);

    daemonHealthy.value = false;
    const restarted = await host.ensureAgentReady(noopPhase);
    expect(attempts).toBe(2);
    expect(restarted.agentDevice).toMatchObject({ baseUrl: 'http://127.0.0.1:12347', token: 'token-2' });
  });

  it('reports an incompatible lock immediately and retains it for manual repair', async () => {
    const result = processOutput(
      1,
      JSON.stringify({
        success: false,
        error: {
          message: 'private command output',
          details: {
            reason: 'daemon_registration_unproven',
            inspection: { state: 'unproven', reason: 'non-directory' },
          },
        },
      }),
    );
    const { host, stateDir } = await agentFixture(async () => result);
    const lock = `${stateDir}/daemon.lock`;
    const legacyOwner = JSON.stringify({ pid: 85669, processStartTime: 'old start time' });
    await NodeFSP.writeFile(lock, legacyOwner);
    const error = await rejection(host.ensureAgentReady(noopPhase));
    expect(error).toMatchObject({ _tag: 'AgentDeviceStartError', reason: 'daemon_lock_not_directory', exitCode: 1 });
    expect(error.cause).toBe(result);
    expect(error.message).toContain('Daemon registration ownership could not be verified');
    expect(error.message).toContain('daemon.lock is not a directory');
    expect(error.message).toContain(stateDir);
    expect(error.message).toContain('original CLI');
    expect(error.message).not.toContain('private command output');
    expect(await NodeFSP.readFile(lock, 'utf8')).toBe(legacyOwner);
    expect(await host.current()).not.toBeNull();
  });

  it('reports unknown nonzero exits without exposing arbitrary command output', async () => {
    const result = processOutput(2, 'invalid JSON', 'private credentials');
    const { host, stateDir } = await agentFixture(async () => result);
    const error = await rejection(host.ensureAgentReady(noopPhase));
    expect(error).toMatchObject({ _tag: 'AgentDeviceStartError', reason: 'command_failed', exitCode: 2 });
    expect(error.cause).toBe(result);
    expect(error.message).toContain('exit code 2');
    expect(error.message).toContain(stateDir);
    expect(error.message).not.toContain('private credentials');
  });

  it('preserves process execution failures instead of waiting for a daemon file', async () => {
    const cause = new ProcessSpawnError({ command: '/missing/node', argumentCount: 3, cause: new Error('missing executable') });
    const { host } = await agentFixture(async () => {
      throw cause;
    });
    const error = await rejection(host.ensureAgentReady(noopPhase));
    expect(error).toMatchObject({ _tag: 'DeviceHostError', step: 'starting agent tools' });
    expect(error.cause).toBe(cause);
  });

  it('uses a registered daemon when reading startup command output fails', async () => {
    const cause = new ProcessReadError({
      command: process.execPath,
      stream: 'stdout',
      cause: new Error('output read failed after registration'),
    });
    let attempts = 0;
    const { host } = await agentFixture(async (stateDir) => {
      attempts++;
      await NodeFSP.writeFile(`${stateDir}/daemon.json`, JSON.stringify({ httpPort: 12345, token: 'test-token' }));
      throw cause;
    });
    const ready = await host.ensureAgentReady(noopPhase);
    expect(ready.agentDevice).toMatchObject({ baseUrl: 'http://127.0.0.1:12345', token: 'test-token' });
    expect((await host.ensureAgentReady(noopPhase)).agentDevice).toEqual(ready.agentDevice);
    expect((await host.current())?.releaseAgentSession).toBeTypeOf('function');
    expect(attempts).toBe(1);
  });

  it('keeps releasing agent sessions while a dead hub fails to restart and after', async () => {
    const { host, hub } = await agentFixture(async (stateDir) => {
      await NodeFSP.writeFile(`${stateDir}/daemon.json`, JSON.stringify({ httpPort: 12345, token: 'test-token' }));
      return processOutput(0);
    });
    await host.ensureAgentReady(noopPhase);
    hub.running = false;
    hub.spawnFails = true;
    await expect(host.ensureReady(noopPhase)).rejects.toMatchObject({ _tag: 'DeviceHostError' });
    expect((await host.current())?.releaseAgentSession).toBeTypeOf('function');
    hub.spawnFails = false;
    await host.ensureReady(noopPhase);
    expect((await host.current())?.releaseAgentSession).toBeTypeOf('function');
  });

  it("stops a previous server's daemon with the agent-device version it recorded", async () => {
    const { host, baseDir, runs } = await agentFixture(mustNotStart, processOutput(0), {
      httpPort: 12345,
      token: 'previous-token',
      pid: process.pid,
      version: '0.0.1',
    });
    const olderInstall = NodePath.join(baseDir, 'tools', 'agent-device', '0.0.1');
    const olderEntry = NodePath.join(olderInstall, 'node_modules', 'agent-device', 'bin', 'agent-device.mjs');
    await NodeFSP.mkdir(NodePath.dirname(olderEntry), { recursive: true });
    await NodeFSP.writeFile(olderEntry, '');
    await NodeFSP.writeFile(NodePath.join(olderInstall, '.install-complete'), '0.0.1');
    await host.stop();
    expect(runs.find((run) => run.args.includes('daemon'))?.args[0]).toBe(olderEntry);
  });

  // regression: #33552 a daemon left by a previous server survived every later graceful quit
  it("stops a previous server's daemon with the current pin when its version is gone", async () => {
    const { host, baseDir, stateDir, runs } = await agentFixture(mustNotStart, processOutput(0), {
      httpPort: 12345,
      token: 'previous-token',
      pid: process.pid,
      version: '0.0.1',
    });
    await host.stop();
    expect(runs.find((run) => run.args.includes('daemon'))?.args).toEqual([
      NodePath.join(baseDir, 'tools', 'agent-device', AGENT_DEVICE_VERSION, 'node_modules', 'agent-device', 'bin', 'agent-device.mjs'),
      'daemon',
      'stop',
      '--state-dir',
      stateDir,
    ]);
  });

  it("drops a dead daemon's record without running agent-device when the host stops", async () => {
    // Above the Linux and macOS PID limits, so never a live process.
    const deadPid = 4_194_305;
    const { host, stateDir, runs } = await agentFixture(mustNotStart, processOutput(0), {
      httpPort: 12345,
      token: 'previous-token',
      pid: deadPid,
      version: AGENT_DEVICE_VERSION,
    });
    await host.stop();
    expect(runs.filter((run) => run.args.includes('daemon'))).toEqual([]);
    expect(await fileExists(NodeFSP, NodePath.join(stateDir, 'daemon.json'))).toBe(false);
  });
});

/** A file system where only `files` exist. */
const fakeFs = (
  exists: (file: string) => boolean,
  overrides: Partial<Record<keyof DeviceFs, (...args: never[]) => unknown>> = {},
): DeviceFs =>
  ({
    access: async (file: string) => {
      if (!exists(file)) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
    },
    realpath: async () => {
      throw new Error('Unexpected realpath');
    },
    stat: async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    ...overrides,
  }) as unknown as DeviceFs;

const diagnose = (files: ReadonlyArray<string>, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = 'darwin') =>
  __testing.platformReason('android', { fs: fakeFs((file) => files.includes(file)), env, platform });

describe('Android SDK availability', () => {
  it('uses the standard Windows SDK without probing PATH', async () => {
    const root = 'C:\\Users\\test\\AppData\\Local\\Android\\Sdk';
    const probes: string[] = [];
    const sdk = await __testing.androidSdk({
      env: {
        USERPROFILE: 'C:\\Users\\test',
        LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
        PATH: '\\\\slow-share\\tools;C:\\other-tools',
      },
      platform: 'win32',
      fs: fakeFs((file) => {
        probes.push(file);
        return file === `${root}\\platform-tools\\adb.exe`;
      }, {
        realpath: () => {
          throw new Error('Standard SDK must not resolve PATH executables');
        },
      }),
    });
    expect(sdk).toMatchObject({ root, adb: true });
    expect(probes.filter((file) => !file.startsWith('C:\\Users\\test\\'))).toEqual([]);
  });

  it('falls back to adb on the Windows Path without resolving missing entries', async () => {
    const root = 'D:\\Android\\Sdk';
    const resolved: string[] = [];
    const sdk = await __testing.androidSdk({
      env: { USERPROFILE: 'C:\\Users\\test', Path: 'C:\\missing;C:\\shims' },
      platform: 'win32',
      fs: fakeFs((file) => file === 'C:\\shims\\adb.exe' || file === `${root}\\platform-tools\\adb.exe`, {
        realpath: async (file: string) => {
          resolved.push(file);
          return `${root}\\platform-tools\\adb.exe`;
        },
      }),
    });
    expect(sdk).toMatchObject({ root, adb: true });
    expect(resolved).toEqual(['C:\\shims\\adb.exe']);
  });

  // regression: #12017 detect unsupported legacy Android command-line tools
  it('explains how to upgrade legacy command-line tools in the standard macOS SDK', async () => {
    const root = '/test/home/Library/Android/sdk';
    const reason = await diagnose(
      [`${root}/platform-tools/adb`, `${root}/emulator/emulator`, `${root}/tools/bin/avdmanager`],
      { HOME: '/test/home' },
    );
    expect(reason).toContain('older, unsupported version');
    expect(reason).toContain(root);
    expect(reason).toContain(
      "Install Android SDK Command-line Tools (latest) in Android Studio's SDK Manager under SDK Tools.",
    );
  });

  it('accepts the latest command-line tools when legacy tools are also installed', async () => {
    const reason = await diagnose(
      ['/sdk/platform-tools/adb', '/sdk/emulator/emulator', '/sdk/tools/bin/avdmanager', '/sdk/cmdline-tools/latest/bin/avdmanager'],
      { ANDROID_HOME: '/sdk' },
    );
    expect(reason).toBeNull();
  });

  it('discovers the standard macOS SDK without ANDROID_HOME', async () => {
    const root = '/test/home/Library/Android/sdk';
    const reason = await diagnose(
      [`${root}/platform-tools/adb`, `${root}/emulator/emulator`, `${root}/cmdline-tools/latest/bin/avdmanager`],
      { HOME: '/test/home' },
    );
    expect(reason).toBeNull();
  });
});

const unusedRunner = {
  run: async (): Promise<ProcessRunOutput> => {
    throw new Error('Unexpected process run');
  },
};

it('recovers an owned Linux runtime directory without overriding explicit environments', async () => {
  for (const [platform, uid, runtimeDir, type, owner, expected] of [
    ['linux', 1000, undefined, 'Directory', 1000, '/run/user/1000'],
    ['linux', 1000, '/custom/runtime', 'Directory', 1000, '/custom/runtime'],
    ['linux', 1000, '', 'Directory', 1000, ''],
    ['linux', 1000, undefined, 'Directory', 1001, undefined],
    ['linux', 1000, undefined, 'File', 1000, undefined],
    ['linux', undefined, undefined, 'Directory', 1000, undefined],
    ['darwin', 1000, undefined, 'Directory', 1000, undefined],
    ['win32', 1000, undefined, 'Directory', 1000, undefined],
  ] as const) {
    const environment = { PATH: '/usr/bin', XDG_RUNTIME_DIR: runtimeDir };
    const result = await __testing.hubEnvironment(environment, {
      platform,
      uid,
      runner: unusedRunner,
      fs: fakeFs(() => false, {
        stat: async (path: string) => {
          expect(path).toBe('/run/user/1000');
          return { isDirectory: () => type === 'Directory', uid: owner };
        },
      }),
    });
    expect(result.XDG_RUNTIME_DIR).toBe(expected);
    expect(result.PATH).toBe('/usr/bin');
    expect(result.FORCE_COLOR).toBe('0');
    expect(result.NO_COLOR).toBe('1');
    expect(environment.XDG_RUNTIME_DIR).toBe(runtimeDir);
  }
  const missing = await __testing.hubEnvironment({}, { platform: 'linux', uid: 1000, runner: unusedRunner, fs: fakeFs(() => false) });
  expect(missing.XDG_RUNTIME_DIR).toBeUndefined();
});

it.each([
  {
    name: 'old SDK',
    front: 'emulated webcam<N> none',
    back: 'emulated virtualscene none',
    code: 0,
    extra: undefined,
    expected: '-camera-front emulated -camera-back emulated',
  },
  {
    name: 'imagefile-capable SDK',
    front: 'emulated imagefile:<path> none',
    back: 'emulated imagefile:<path> none',
    code: 0,
    extra: undefined,
    expected: undefined,
  },
  {
    name: 'user overrides',
    front: 'emulated none',
    back: 'emulated none',
    code: 0,
    extra: '-memory 4096 -camera-front none',
    expected: '-camera-front emulated -camera-back emulated -memory 4096 -camera-front none',
  },
  {
    name: 'different camera capabilities',
    front: 'emulated none',
    back: 'emulated imagefile:<path> none',
    code: 0,
    extra: undefined,
    expected: '-camera-front emulated',
  },
  {
    name: 'failed help probe',
    front: 'emulated none',
    back: 'emulated none',
    code: 1,
    extra: undefined,
    expected: undefined,
  },
])('configures supported emulator cameras for $name', async ({ front, back, code, extra, expected }) => {
  const result = await __testing.hubEnvironment(
    { ANDROID_HOME: '/sdk', EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS: extra },
    {
      platform: 'darwin',
      uid: 1000,
      fs: fakeFs(() => false),
      runner: {
        run: async (input) => {
          expect(input.command).toBe('/sdk/emulator/emulator');
          expect(input.args[0]).toMatch(/^-help-camera-(front|back)$/);
          return processOutput(code, input.args[0] === '-help-camera-front' ? front : back);
        },
      },
    },
  );
  expect(result.EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS).toBe(expected);
});

it('keeps local Android and iOS available without ffmpeg', async () => {
  const { directory: baseDir, cleanup } = await tempDir('device-ffmpeg-');
  cleanups.push(cleanup);
  await NodeFSP.mkdir(`${baseDir}/bin`);
  await NodeFSP.writeFile(`${baseDir}/bin/xcrun`, '#!/bin/sh\nexit 0\n');
  await NodeFSP.chmod(`${baseDir}/bin/xcrun`, 0o755);
  for (const [directory, tool] of [
    ['platform-tools', 'adb'],
    ['emulator', 'emulator'],
    ['cmdline-tools/latest/bin', 'avdmanager'],
  ] as const) {
    await NodeFSP.mkdir(`${baseDir}/sdk/${directory}`, { recursive: true });
    await NodeFSP.writeFile(`${baseDir}/sdk/${directory}/${tool}`, '');
  }
  const host: DeviceHost = await createLocalDeviceHost({
    baseDir,
    stateDir: baseDir,
    runtime: fakeRuntime({
      env: { HOME: baseDir, PATH: `${baseDir}/bin`, ANDROID_HOME: `${baseDir}/sdk` },
      platform: 'darwin',
      fetch: async () => {
        throw new Error('Readiness must not make network requests');
      },
      runner: {
        run: async () => {
          throw new Error('Platform availability must not probe emulator video');
        },
      },
    }),
  });
  expect((await host.summary()).platforms).toEqual([
    { platform: 'ios', available: true },
    { platform: 'android', available: true },
  ]);
  expect(await host.platformAvailability('android')).toEqual({ platform: 'android', available: true });
  expect(await host.platformAvailability('ios')).toEqual({ platform: 'ios', available: true });
});

it('constructs and inspects an unconfigured host without installing or starting helpers', async () => {
  const { directory: baseDir, cleanup } = await tempDir('device-consent-');
  cleanups.push(cleanup);
  const host = await createLocalDeviceHost({
    baseDir,
    stateDir: baseDir,
    runtime: fakeRuntime({
      env: { HOME: baseDir, PATH: '' },
      platform: 'linux',
      // A packaged build has to find Node on PATH, and there is none.
      isExecutable: true,
      spawn: async () => {
        throw new Error('Host construction must not spawn processes');
      },
      runner: {
        run: async () => {
          throw new Error('Host construction must not run commands');
        },
      },
      fetch: async () => {
        throw new Error('Host construction must not make network requests');
      },
    }),
  });
  expect(await host.current()).toBeNull();
  const error = await rejection(
    host.ensureReady(() => {
      throw new Error('Must not install without Node');
    }),
  );
  expect(error).not.toBeInstanceOf(DeviceHostUnavailableError);
  expect(error.message).toContain('Local device support requires Node.js');
  expect(error.message).toContain('Install Node.js');
  await host.stop();
  expect(await fileExists(NodeFSP, `${baseDir}/tools`)).toBe(false);
});
