// The hub runs at origin root; the server strips its prefix and the Device panel derives stream URLs from it.
import * as NodePath from 'node:path';

import { z } from 'zod';

import {
  deviceToolInstallMessage,
  type DeviceHostSummary,
  type DevicePlatform,
  type DevicePlatformAvailability,
  LOCAL_DEVICE_HOST_ID,
  LOCAL_DEVICE_HOST_LABEL,
} from '../contracts.ts';
import { releaseAgentDeviceSession } from './AgentDeviceTarget.ts';
import {
  type AgentDeviceEndpoint,
  AgentDeviceStartError,
  type DeviceHost,
  type DeviceHostAgentReady,
  DeviceHostError,
  type DeviceHostPhaseListener,
  type DeviceHostReady,
  type DeviceHubEndpoint,
  DeviceHostTimeoutError,
} from './DeviceHost.ts';
import { makeDeviceHubOperations } from './DeviceHubOperations.ts';
import { hubAuthorization, hubSessionTokenOf, withoutHubSessionToken } from './hubSessionToken.ts';
import {
  AGENT_DEVICE_VERSION,
  agentDeviceStateDir,
  DEVICE_HUB_VERSION,
  type DeviceToolPaths,
  deviceToolVersions,
  ensureAgentDevice,
  ensureDeviceHub,
  installedAgentDeviceEntry,
  isAgentDeviceInstalled,
  isDeviceHubInstalled,
} from './DeviceToolchain.ts';
import { pruneLocalDeviceTools } from './deviceToolMaintenance.ts';
import {
  type ChildHandle,
  type DeviceRuntime,
  fileExists,
  isCommandAvailable,
  pathFor,
  type ProcessRunOutput,
  resolveNodeExecutable,
  Semaphore,
  sleep,
  waitForHttpReady,
  withTimeout,
  writeFileAtomically,
} from './runtime.ts';

const HUB_READY_TIMEOUT_MS = 30_000;
const HUB_TOKEN_TIMEOUT_MS = 5_000;
const DAEMON_READY_TIMEOUT_MS = 30_000;
const DAEMON_POLL_MS = 100;
const HUB_RESTART_STABLE_UPTIME_MS = 60_000;
const HUB_RESTART_MAX_DELAY_MS = 30_000;

// Persist hub state so restarts without finalizers can clean up orphaned loopback listeners.
const HubStateFile = z.object({
  pid: z.number().int(),
  port: z.number().int(),
  entryPath: z.string(),
});

const AgentDeviceDaemonFile = z.object({
  httpPort: z.number().int(),
  token: z.string(),
  pid: z.number().int().optional(),
  version: z.string().optional(),
});
type AgentDeviceDaemonFile = z.infer<typeof AgentDeviceDaemonFile>;

const AgentDeviceFailure = z.object({
  error: z.object({
    details: z.object({
      reason: z.string(),
      inspection: z.object({ reason: z.string() }).optional(),
    }),
  }),
});

const decodeAgentDeviceFailure = (stdout: string) => {
  try {
    const parsed = AgentDeviceFailure.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

interface HubProcess {
  readonly nodePath: string;
  readonly child: ChildHandle;
  readonly origin: string;
  /** The session token the hub printed; every request carries it. */
  readonly token: string;
  readonly startedAtMillis: number;
}

interface RunningHost {
  readonly hub: HubProcess;
  readonly agentDevice: AgentDeviceEndpoint | null;
  readonly helpers: DeviceHostReady['helpers'];
}

/** What the local host needs from this machine. */
export type LocalDeviceHostRuntime = DeviceRuntime;

type SdkRuntime = Pick<DeviceRuntime, 'fs' | 'env' | 'platform'>;

const platformReason = async (
  platform: DevicePlatform,
  runtime: Pick<DeviceRuntime, 'fs' | 'env' | 'platform'>,
): Promise<string | null> => {
  if (platform === 'ios') {
    if (runtime.platform !== 'darwin') return 'iOS Simulators need macOS with Xcode.';
    if (!(await isCommandAvailable('xcrun', runtime))) return 'Xcode command line tools were not found.';
    return null;
  }
  const sdk = await androidSdk(runtime);
  if (!sdk.root)
    return 'Android SDK was not found. Install it with Android Studio or set ANDROID_HOME to your SDK directory.';
  if (!sdk.adb)
    return `Android SDK Platform-Tools are missing from ${sdk.root}. Install them in Android Studio's SDK Manager.`;
  if (!sdk.emulator)
    return `Android Emulator is missing from ${sdk.root}. Install it in Android Studio's SDK Manager.`;
  if (!sdk.avdmanager) {
    if (sdk.legacyAvdmanager)
      return `The Android SDK command-line tools in ${sdk.root} appear to be an older, unsupported version. Install Android SDK Command-line Tools (latest) in Android Studio's SDK Manager under SDK Tools.`;
    return `Android SDK Command-line Tools (latest) are missing from ${sdk.root}. Install them in Android Studio's SDK Manager.`;
  }
  return null;
};

interface AndroidSdk {
  readonly root: string | null;
  readonly adb: boolean;
  readonly emulator: boolean;
  readonly avdmanager: boolean;
  readonly legacyAvdmanager: boolean;
}

const androidSdk = async (runtime: SdkRuntime): Promise<AndroidSdk> => {
  const { fs, env: environment } = runtime;
  const path = pathFor(runtime.platform);
  const windows = runtime.platform === 'win32';
  const home = environment.HOME ?? environment.USERPROFILE ?? '';
  const explicit = environment.ANDROID_HOME?.trim() || environment.ANDROID_SDK_ROOT?.trim();
  const exists = (file: string) => fileExists(fs, file);
  const adbBinary = windows ? 'adb.exe' : 'adb';
  const avdmanagerBinary = windows ? 'avdmanager.bat' : 'avdmanager';
  const inspect = async (root: string): Promise<AndroidSdk | null> => {
    const adb = await exists(path.join(root, 'platform-tools', adbBinary));
    const emulator = await exists(path.join(root, 'emulator', windows ? 'emulator.exe' : 'emulator'));
    if (!explicit && !adb && !emulator) return null;
    const avdmanager = await exists(path.join(root, 'cmdline-tools', 'latest', 'bin', avdmanagerBinary));
    const legacyAvdmanager = !avdmanager && (await exists(path.join(root, 'tools', 'bin', avdmanagerBinary)));
    return { root, adb, emulator, avdmanager, legacyAvdmanager };
  };
  const candidates = explicit
    ? [explicit]
    : [
        path.join(home, 'Library', 'Android', 'sdk'),
        path.join(home, 'Android', 'Sdk'),
        path.join(environment.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Android', 'Sdk'),
      ];
  for (const root of candidates) {
    const sdk = await inspect(root);
    if (sdk) return sdk;
  }
  // PATH entries can be slow to stat (network shares), so only consult them after the standard locations miss.
  if (!explicit) {
    const searchPath = environment.PATH ?? environment.Path ?? '';
    for (const directory of searchPath.split(windows ? ';' : ':')) {
      if (!directory) continue;
      const adb = path.join(directory, adbBinary);
      if (!(await exists(adb))) continue;
      const resolved = await fs.realpath(adb).catch(() => adb);
      const sdk = await inspect(path.dirname(path.dirname(resolved)));
      if (sdk) return sdk;
    }
  }
  return { root: null, adb: false, emulator: false, avdmanager: false, legacyAvdmanager: false };
};

const deviceHostEnvironment = (
  environment: NodeJS.ProcessEnv,
  sdkRoot: string | null,
  hostPlatform: NodeJS.Platform,
): NodeJS.ProcessEnv => {
  const path = pathFor(hostPlatform);
  return sdkRoot
    ? {
        ...environment,
        ANDROID_HOME: sdkRoot,
        PATH: [
          path.join(sdkRoot, 'platform-tools'),
          path.join(sdkRoot, 'emulator'),
          environment.PATH ?? environment.Path ?? '',
        ].join(hostPlatform === 'win32' ? ';' : ':'),
      }
    : environment;
};

const hubEnvironment = async (
  environment: NodeJS.ProcessEnv,
  runtime: Pick<DeviceRuntime, 'platform' | 'uid' | 'fs' | 'runner'>,
): Promise<NodeJS.ProcessEnv> => {
  const env: NodeJS.ProcessEnv = { ...environment, FORCE_COLOR: '0', NO_COLOR: '1' };
  const { platform, uid } = runtime;
  if (env.ANDROID_HOME) {
    const path = pathFor(platform);
    const emulator = path.join(env.ANDROID_HOME, 'emulator', platform === 'win32' ? 'emulator.exe' : 'emulator');
    const cameraArgs: string[] = [];
    for (const facing of ['front', 'back']) {
      cameraArgs.push(
        await runtime.runner
          .run({ command: emulator, args: [`-help-camera-${facing}`], env, timeoutMs: 5_000 })
          .then((result) => {
            const help = `${result.stdout}\n${result.stderr}`;
            // The hub wires imagefile cameras unconditionally; older SDK emulators reject that mode.
            return result.code === 0 && /\bemulated\b/.test(help) && !/\bimagefile\b/.test(help)
              ? `-camera-${facing} emulated`
              : '';
          })
          .catch(() => ''),
      );
    }
    const overrides = cameraArgs.filter(Boolean).join(' ');
    if (overrides) {
      env.EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS = [overrides, env.EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS]
        .filter(Boolean)
        .join(' ');
    }
  }
  if (platform === 'linux' && env.XDG_RUNTIME_DIR === undefined && uid !== undefined) {
    // SSH sessions may omit the directory where the emulator publishes its gRPC token.
    const runtimeDir = `/run/user/${uid}`;
    const stat = await runtime.fs.stat(runtimeDir).catch(() => null);
    if (stat && stat.isDirectory() && stat.uid === uid) {
      env.XDG_RUNTIME_DIR = runtimeDir;
    }
  }
  return env;
};

/** Only a Mac can list Apple simulators; elsewhere the hub's attempt surfaces as an error. */
const hubPlatformArguments = (hostPlatform: NodeJS.Platform) => (hostPlatform === 'darwin' ? [] : ['--platform', 'android']);

export interface LocalDeviceHostOptions {
  /** Where device tools are installed (`{baseDir}/tools/...`). */
  readonly baseDir: string;
  /** Where hub and agent-device state lives (`{stateDir}/device/agent-device`). */
  readonly stateDir: string;
  readonly runtime: LocalDeviceHostRuntime;
}

export const createLocalDeviceHost = async (options: LocalDeviceHostOptions): Promise<DeviceHost> => {
  const { baseDir, stateDir, runtime } = options;
  const { fs, runner, log } = runtime;
  const hostPlatform = runtime.platform;
  const sdk = await androidSdk(runtime);
  const hostEnvironment = deviceHostEnvironment(runtime.env, sdk.root, hostPlatform);
  const startLock = new Semaphore(1);
  let running: RunningHost | null = null;
  let restartDelay = 0;
  const hostId = LOCAL_DEVICE_HOST_ID;

  const platformAvailability = async (platform: DevicePlatform): Promise<DevicePlatformAvailability> => {
    const reason = await platformReason(platform, runtime);
    return reason === null ? { platform, available: true } : { platform, available: false, reason };
  };

  const isProcessAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const summary = async (): Promise<DeviceHostSummary> => {
    const [platforms, hubInstalled, agentDeviceInstalled] = await Promise.all([
      Promise.all([platformAvailability('ios'), platformAvailability('android')]),
      isDeviceHubInstalled(fs, baseDir),
      isAgentDeviceInstalled(fs, baseDir),
    ]);
    const current = running;
    const daemon = current?.agentDevice ? await readDaemonFile().catch(() => null) : null;
    const hubAlive = current ? current.hub.child.isRunning() : false;
    const agentAlive = daemon?.pid ? isProcessAlive(daemon.pid) : false;
    const tools = await deviceToolVersions(fs, baseDir, {
      ...(hubAlive ? { hub: DEVICE_HUB_VERSION } : {}),
      ...(agentAlive && daemon?.version ? { agent: daemon.version } : {}),
    });
    return {
      ...(tools ? { tools } : {}),
      id: hostId,
      kind: 'local',
      label: LOCAL_DEVICE_HOST_LABEL,
      platforms,
      hubInstalled,
      agentDeviceInstalled,
    };
  };

  const stopHub = (hub: HubProcess | undefined) => {
    hub?.child.kill();
  };

  const hubStatePath = () => NodePath.join(agentDeviceStateDir(stateDir), 'hub.json');

  // Check PID and entry path before reaping; the PID may have been recycled.
  const reapStaleHub = async () => {
    try {
      const raw = await fs.readFile(hubStatePath(), 'utf8').catch(() => null);
      const previous = raw === null ? null : safeJson(HubStateFile, raw);
      if (!previous) return;
      if (isProcessAlive(previous.pid)) {
        const commandLine = await runner
          .run({
            command: 'ps',
            args: ['-o', 'command=', '-p', String(previous.pid)],
            timeoutMs: 5_000,
            timeoutBehavior: 'timedOutResult',
          })
          .then((result) => result.stdout)
          .catch(() => '');
        if (commandLine.includes(previous.entryPath)) {
          log.warn('Stopping a device hub left behind by a previous server', { pid: previous.pid, port: previous.port });
          try {
            process.kill(previous.pid, 'SIGTERM');
          } catch {}
        }
      }
      await fs.rm(hubStatePath(), { force: true }).catch(() => undefined);
    } catch {}
  };

  const recordHub = async (hub: HubProcess, hubTool: DeviceToolPaths) => {
    try {
      await writeFileAtomically(
        fs,
        hubStatePath(),
        JSON.stringify({ pid: Number(hub.child.pid), port: Number(new URL(hub.origin).port), entryPath: hubTool.entryPath }),
      );
    } catch {}
  };

  const spawnHub = async (hubTool: DeviceToolPaths, nodePath: string): Promise<HubProcess> => {
    await reapStaleHub();
    await fs.mkdir(agentDeviceStateDir(stateDir), { recursive: true }).catch(() => undefined);
    let port: number;
    try {
      port = await runtime.reserveLoopbackPort();
    } catch (cause) {
      throw new DeviceHostError({ hostId, step: 'reserving a port for the device hub', cause });
    }
    const origin = `http://127.0.0.1:${port}`;
    const env = await hubEnvironment(hostEnvironment, runtime);
    let child: ChildHandle;
    try {
      child = await runtime.spawn(
        nodePath,
        [
          hubTool.entryPath,
          '--port',
          String(port),
          '--host',
          '127.0.0.1',
          '--hide-sidebar',
          '--hide-boot-device',
          '--require-token',
          ...hubPlatformArguments(hostPlatform),
        ],
        { cwd: runtime.cwd, env },
      );
    } catch (cause) {
      throw new DeviceHostError({ hostId, step: 'starting the device hub', cause });
    }
    // The hub is not recorded yet; stop it on failure from spawn onward.
    try {
      let token: string | undefined;
      let tokenPrinted: () => void = () => undefined;
      const printed = new Promise<void>((resolve) => (tokenPrinted = resolve));
      child.onOutputLine((line) => {
        const found = hubSessionTokenOf(line);
        if (found !== undefined && token === undefined) {
          token = found;
          tokenPrinted();
        }
        const output = withoutHubSessionToken(line.trim());
        if (output.length > 0) log.debug('Device hub output', { pid: Number(child.pid), output });
      });
      await waitForHttpReady({
        fetch: runtime.fetch,
        baseUrl: origin,
        path: '/readyz',
        timeoutMs: HUB_READY_TIMEOUT_MS,
        makeError: (info) => new DeviceHostError({ hostId, step: 'waiting for the device hub to answer', cause: info.cause }),
      });
      // The hub prints its link right after it starts listening, so it is there by now or very soon.
      let waited: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        printed,
        child.exited,
        new Promise<void>((resolve) => (waited = setTimeout(resolve, HUB_TOKEN_TIMEOUT_MS))),
      ]);
      clearTimeout(waited);
      if (token === undefined) {
        throw new DeviceHostError({
          hostId,
          step: 'reading the device hub session token',
          cause: new Error('The device hub did not print a link with its session token.'),
        });
      }
      const hub: HubProcess = { child, origin, token, startedAtMillis: runtime.now(), nodePath };
      await recordHub(hub, hubTool);
      log.info('Device hub started', { pid: Number(child.pid), port });
      return hub;
    } catch (error) {
      child.kill();
      throw error;
    }
  };

  // Waits for the hub's lifetime and restarts it when it exits on its own.
  const superviseHub = (hub: HubProcess, hubTool: DeviceToolPaths): void => {
    void hub.child.exited
      .then(async () => {
        if (running?.hub.child.pid !== hub.child.pid) return;
        const uptime = runtime.now() - hub.startedAtMillis;
        let delay: number;
        if (uptime >= HUB_RESTART_STABLE_UPTIME_MS) {
          delay = 0;
          restartDelay = 0;
        } else {
          delay = restartDelay;
          restartDelay = restartDelay === 0 ? 1_000 : Math.min(restartDelay * 2, HUB_RESTART_MAX_DELAY_MS);
        }
        log.warn('Device hub exited; restarting', { pid: Number(hub.child.pid), delayMs: delay });
        await sleep(delay);
        await startLock.withPermit(async () => {
          const current = running;
          if (!current || current.hub.child.pid !== hub.child.pid) return;
          const replacement = await spawnHub(hubTool, hub.nodePath);
          running = { ...current, hub: replacement };
          superviseHub(replacement, hubTool);
        });
      })
      .catch((cause: unknown) => log.warn('Device hub supervisor failed', { cause }));
  };

  const daemonFilePath = () => NodePath.join(agentDeviceStateDir(stateDir), 'daemon.json');

  /** Rejects when the file is missing or malformed. */
  const readDaemonFile = async (): Promise<AgentDeviceDaemonFile> =>
    AgentDeviceDaemonFile.parse(JSON.parse(await fs.readFile(daemonFilePath(), 'utf8')));

  const startAgentDeviceDaemon = async (
    agentTool: Pick<DeviceToolPaths, 'entryPath'>,
    nodePath: string,
  ): Promise<AgentDeviceEndpoint> => {
    const agentStateDir = agentDeviceStateDir(stateDir);
    await fs.mkdir(agentStateDir, { recursive: true }).catch(() => undefined);
    const existing = await readDaemonFile().catch(() => null);
    const daemonEnvironment: NodeJS.ProcessEnv = {
      ...hostEnvironment,
      AGENT_DEVICE_STATE_DIR: agentStateDir,
      AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
      // Disable the five-minute idle timeout; the server owns shutdown.
      AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
      AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1',
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    };
    const toEndpoint = (file: AgentDeviceDaemonFile): AgentDeviceEndpoint => ({
      baseUrl: `http://127.0.0.1:${file.httpPort}`,
      token: file.token,
      entryPath: agentTool.entryPath,
    });
    if (existing) {
      const alive = await withTimeout(2_000, async (signal) => {
        const response = await runtime.fetch(`http://127.0.0.1:${existing.httpPort}/health`, { signal });
        await response.arrayBuffer();
        return response.status === 200;
      }).catch(() => false);
      if (alive) return toEndpoint(existing);
      await fs.rm(daemonFilePath(), { force: true }).catch(() => undefined);
    }
    // No `daemon start` exists; `devices` is the cheapest command that starts and awaits it.
    let runResult: { ok: true; value: ProcessRunOutput } | { ok: false; error: unknown };
    try {
      runResult = {
        ok: true,
        value: await runner.run({
          command: nodePath,
          args: [agentTool.entryPath, 'devices', '--json'],
          env: daemonEnvironment,
          timeoutMs: DAEMON_READY_TIMEOUT_MS,
          timeoutBehavior: 'timedOutResult',
        }),
      };
    } catch (error) {
      runResult = { ok: false, error };
    }
    // Discovery may fail after startup; accept a published endpoint or preserve the CLI failure.
    const started = await readDaemonFile().catch(() => null);
    if (started) return toEndpoint(started);
    if (!runResult.ok) {
      throw new DeviceHostError({ hostId, step: 'starting agent tools', cause: runResult.error });
    }
    const result = runResult.value;
    if (result.timedOut) {
      throw new DeviceHostTimeoutError({ hostId, timeoutMs: DAEMON_READY_TIMEOUT_MS });
    }
    if (result.code !== 0) {
      const details = decodeAgentDeviceFailure(result.stdout)?.error.details;
      const reason =
        details?.reason === 'daemon_registration_unproven'
          ? details.inspection?.reason === 'non-directory'
            ? 'daemon_lock_not_directory'
            : 'daemon_registration_unproven'
          : details?.reason === 'daemon_retirement_unconfirmed'
            ? 'daemon_retirement_unconfirmed'
            : 'command_failed';
      throw new AgentDeviceStartError({
        hostId,
        stateDir: agentStateDir,
        exitCode: result.code === null ? null : Number(result.code),
        reason,
        cause: result,
      });
    }
    const deadline = runtime.now() + DAEMON_READY_TIMEOUT_MS;
    while (true) {
      const file = await readDaemonFile().catch(() => null);
      if (file) return toEndpoint(file);
      if (runtime.now() > deadline) {
        throw new DeviceHostTimeoutError({ hostId, timeoutMs: DAEMON_READY_TIMEOUT_MS });
      }
      await sleep(DAEMON_POLL_MS);
    }
  };

  // The daemon may predate this process (an earlier server was killed, possibly on an
  // older pin), so stop it with the CLI of its recorded version when that is installed.
  const stopAgentDeviceDaemon = async () => {
    try {
      if (!(await fileExists(fs, daemonFilePath()))) return;
      const recorded = await readDaemonFile().catch(() => null);
      if (recorded?.pid && !isProcessAlive(recorded.pid)) {
        await fs.rm(daemonFilePath(), { force: true });
        return;
      }
      const entryPath = await installedAgentDeviceEntry(fs, baseDir, [
        ...(recorded?.version ? [recorded.version] : []),
        AGENT_DEVICE_VERSION,
      ]);
      if (!entryPath) return;
      const nodePath = await resolveNodeExecutable('Local device support', runtime, hostEnvironment);
      await runner.run({
        command: nodePath,
        args: [entryPath, 'daemon', 'stop', '--state-dir', agentDeviceStateDir(stateDir)],
        env: { ...hostEnvironment, AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1' },
        timeoutMs: 10_000,
        timeoutBehavior: 'timedOutResult',
      });
    } catch {}
  };

  const helperPaths = (hubTool: DeviceToolPaths) => {
    const serveSimDist = NodePath.join(hubTool.installDir, 'node_modules', 'expo-device-hub', 'vendor', 'serve-sim', 'dist');
    return {
      serveSimAxSettings: NodePath.join(serveSimDist, 'simax', 'serve-sim-ax-settings'),
      serveSimCli: NodePath.join(serveSimDist, 'serve-sim.js'),
    };
  };

  const ensureHubReady = async (onPhase: DeviceHostPhaseListener): Promise<RunningHost> => {
    const previous = running;
    // A dead hub's record stays until a replacement is published: the agent
    // daemon outlives the hub, and close needs its endpoint if the restart fails.
    if (previous && previous.hub.child.isRunning()) return previous;
    const nodePath = await resolveNodeExecutable('Local device support', runtime, hostEnvironment);
    const installed = await isDeviceHubInstalled(fs, baseDir);
    if (!installed) {
      const inventory = await summary();
      await onPhase('installing', deviceToolInstallMessage('device hub', inventory.tools?.hub));
    }
    let hubTool: DeviceToolPaths;
    try {
      hubTool = await ensureDeviceHub(runtime, baseDir);
    } catch (cause) {
      throw new DeviceHostError({ hostId, step: 'installing device support', cause });
    }
    await onPhase('starting');
    const hub = await spawnHub(hubTool, nodePath);
    let next: RunningHost;
    try {
      await pruneLocalDeviceTools(runner, baseDir, nodePath, 'hub').catch(() => undefined);
      const candidate = helperPaths(hubTool);
      const [axExists, cliExists] = await Promise.all([
        fileExists(fs, candidate.serveSimAxSettings),
        fileExists(fs, candidate.serveSimCli),
      ]);
      next = {
        hub,
        agentDevice: previous?.agentDevice ?? null,
        helpers: {
          serveSimAxSettings: axExists ? candidate.serveSimAxSettings : null,
          serveSimCli: cliExists ? candidate.serveSimCli : null,
        },
      };
      running = next;
    } catch (error) {
      stopHub(hub);
      throw error;
    }
    restartDelay = 0;
    superviseHub(hub, hubTool);
    return next;
  };

  const run: DeviceHostReady['run'] = (command, args, runOptions) =>
    runner
      .run({
        command:
          command === 'emulator' && sdk.root
            ? pathFor(hostPlatform).join(sdk.root, 'emulator', hostPlatform === 'win32' ? 'emulator.exe' : 'emulator')
            : command,
        args,
        cwd: runtime.cwd,
        env: hostEnvironment,
        timeoutMs: runOptions?.timeoutMs ?? 20_000,
        timeoutBehavior: 'timedOutResult',
        ...(runOptions?.stdin === undefined ? {} : { stdin: runOptions.stdin }),
        ...(runOptions?.maxOutputBytes === undefined ? {} : { maxOutputBytes: runOptions.maxOutputBytes }),
      })
      .then(
        (result) => ({
          stdout: result.stdout,
          stderr: result.stderr,
          code: result.timedOut ? 124 : Number(result.code ?? 127),
        }),
        (cause: unknown) => ({ stdout: '', stderr: String(cause), code: 127 }),
      );

  const toReady = (current: RunningHost): DeviceHostReady => ({
    hub: { origin: current.hub.origin, headers: hubAuthorization(current.hub.token) } satisfies DeviceHubEndpoint,
    devices: makeDeviceHubOperations({
      hostId,
      origin: current.hub.origin,
      headers: hubAuthorization(current.hub.token),
      fetch: runtime.fetch,
      run,
      platformAvailable: (platform) => platformAvailability(platform).then((availability) => availability.available),
      log,
    }),
    nodePath: current.hub.nodePath,
    run,
    helpers: current.helpers,
    ...(current.agentDevice ? { releaseAgentSession: releaseAgentDeviceSession(runtime.fetch, current.agentDevice) } : {}),
  });

  const ensureReady: DeviceHost['ensureReady'] = (onPhase) =>
    startLock.withPermit(async () => toReady(await ensureHubReady(onPhase)));

  const ensureAgentReady: DeviceHost['ensureAgentReady'] = (onPhase) =>
    startLock.withPermit(async (): Promise<DeviceHostAgentReady> => {
      const current = await ensureHubReady(onPhase);
      if (current.agentDevice) {
        const agentDevice = await startAgentDeviceDaemon(current.agentDevice, current.hub.nodePath);
        running = { ...current, agentDevice };
        return { ...toReady(running), agentDevice };
      }
      const installed = await isAgentDeviceInstalled(fs, baseDir);
      if (!installed) {
        const inventory = await summary();
        await onPhase('installing', deviceToolInstallMessage('agent tools', inventory.tools?.agent));
      }
      let agentTool: DeviceToolPaths;
      try {
        agentTool = await ensureAgentDevice(runtime, baseDir);
      } catch (cause) {
        throw new DeviceHostError({ hostId, step: 'installing agent tools', cause });
      }
      await onPhase('starting');
      const agentDevice = await startAgentDeviceDaemon(agentTool, current.hub.nodePath);
      await pruneLocalDeviceTools(runner, baseDir, current.hub.nodePath, 'agent').catch(() => undefined);
      const next = { ...current, agentDevice };
      running = next;
      return { ...toReady(next), agentDevice };
    });

  const current: DeviceHost['current'] = async () => (running ? toReady(running) : null);

  const stopAgent: DeviceHost['stopAgent'] = () =>
    startLock.withPermit(async () => {
      await stopAgentDeviceDaemon();
      if (running) running = { ...running, agentDevice: null };
    });

  const stop: DeviceHost['stop'] = () =>
    startLock.withPermit(async () => {
      const previous = running;
      running = null;
      stopHub(previous?.hub);
      await fs.rm(hubStatePath(), { force: true }).catch(() => undefined);
      await stopAgentDeviceDaemon();
    });

  return {
    id: hostId,
    label: LOCAL_DEVICE_HOST_LABEL,
    summary,
    platformAvailability,
    ensureReady,
    ensureAgentReady,
    current,
    stopAgent,
    stop,
  };
};

const safeJson = <T>(schema: z.ZodType<T>, raw: string): T | null => {
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

export const __testing = {
  AgentDeviceDaemonFile,
  androidSdk,
  platformReason,
  deviceHostEnvironment,
  hubEnvironment,
};
