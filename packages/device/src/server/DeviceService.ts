import * as NodePath from 'node:path';

import {
  type DeviceActionInput,
  type DeviceCloseInput,
  type DeviceConfigureInput,
  type DeviceDetail,
  type DeviceDetailInput,
  DeviceHostUnavailableError,
  type DeviceHostId,
  type DeviceId,
  DeviceNotFoundError,
  DeviceOperationError,
  type DeviceOpenInput,
  type DevicePlatform,
  DevicePlatformUnavailableError,
  type DeviceServiceState,
  type DeviceSession,
  type DeviceShutdownInput,
  type DeviceSummary,
  isDeviceError,
  LOCAL_DEVICE_HOST_ID,
  LOCAL_DEVICE_HOST_LABEL,
  type ThreadId,
} from '../contracts.ts';
import { readDeviceDetail, runDeviceAction } from './DeviceActions.ts';
import {
  agentDeviceCloseOutcome,
  bindAgentDeviceLauncher,
  ensureAgentDeviceShim,
  pruneAgentDeviceLaunchers,
} from './AgentDeviceShim.ts';
import { agentDeviceConfigPath, agentDeviceSession, writeAgentDeviceConfig } from './AgentDeviceTarget.ts';
import type {
  AgentDaemonEndpoint,
  AgentDeviceEndpoint,
  DeviceHost,
  DeviceHostReady,
  DeviceOpenContext,
} from './DeviceHost.ts';
import { ensureAgentDevice, ensureDeviceHub } from './DeviceToolchain.ts';
import { deviceSettingsPath, type DeviceSettingsStore, fileDeviceSettingsStore } from './deviceSettings.ts';
import { createLocalDeviceHost } from './LocalDeviceHost.ts';
import {
  type DeviceRuntime,
  nodeDeviceRuntime,
  nodeRuntimeUnavailableMessage,
  resolveNodeExecutable,
  Semaphore,
} from './runtime.ts';

/** Where `createDeviceRoutes` mounts the hub proxy unless told otherwise. */
export const DEFAULT_DEVICE_HUB_BASE_PATH = '/api/device/hub';

export interface DeviceScreenshot {
  readonly device: DeviceSummary;
  readonly png: Uint8Array;
}

export interface DeviceReadiness extends DeviceHostReady {
  readonly hostId: DeviceHostId;
}

export interface DeviceAgentReadiness extends DeviceReadiness {
  /** Null when each device has its own daemon; see `DeviceOperations.agentEndpoint`. */
  readonly agentDevice: AgentDeviceEndpoint | null;
}

interface DeviceHostName {
  readonly id: DeviceHostId;
  readonly label?: string | undefined;
}
const hostName = (host: DeviceHostName) => host.label ?? `host ${host.id}`;

export class DeviceHostAmbiguousError extends Error {
  readonly _tag = 'DeviceHostAmbiguousError';
  readonly deviceId: DeviceId;
  readonly hosts: ReadonlyArray<DeviceHostName>;
  constructor(fields: { deviceId: DeviceId; hosts: ReadonlyArray<DeviceHostName> }) {
    super(`Device ${fields.deviceId} is on more than one host: ${fields.hosts.map(hostName).join(', ')}.`);
    this.deviceId = fields.deviceId;
    this.hosts = fields.hosts;
  }
}

export class DeviceOnOtherHostError extends Error {
  readonly _tag = 'DeviceOnOtherHostError';
  readonly deviceId: DeviceId;
  readonly host: DeviceHostName;
  readonly hosts: ReadonlyArray<DeviceHostName>;
  constructor(fields: { deviceId: DeviceId; host: DeviceHostName; hosts: ReadonlyArray<DeviceHostName> }) {
    super(
      `Device ${fields.deviceId} is not on ${hostName(fields.host)}. It is on ${fields.hosts.map(hostName).join(', ')}.`,
    );
    this.deviceId = fields.deviceId;
    this.host = fields.host;
    this.hosts = fields.hosts;
  }
}

/**
 * The device panel's server side. Methods reject with the contract's `DeviceError`s unless
 * noted; `threadId` is an opaque owner id (a session, thread or any caller-chosen string).
 */
export interface DeviceService {
  /**
   * The agent-device flags that reach the device: its config and session,
   * and the id agent-device selects it by, which can differ from its id here.
   */
  readonly agentTarget: (input: { threadId: ThreadId; hostId: DeviceHostId; deviceId: DeviceId }) => Promise<{
    readonly agentDeviceId: string | null;
    readonly session: string;
    readonly args: ReadonlyArray<string>;
    readonly installDirectory?: string | undefined;
  }>;
  /**
   * The command agents run for one agent-device session; it is removed when the session ends.
   * Null when the session closed before it could be bound.
   */
  readonly agentLauncher: (input: {
    readonly threadId: ThreadId;
    readonly hostId: DeviceHostId;
    readonly deviceId: DeviceId;
    readonly targetArgs: ReadonlyArray<string>;
  }) => Promise<string | null>;
  readonly state: () => DeviceServiceState;
  /** Calls `listener` with every published state; returns the unsubscribe function. */
  readonly subscribe: (listener: (state: DeviceServiceState) => void) => () => void;
  readonly configure: (input: DeviceConfigureInput) => Promise<DeviceServiceState>;
  readonly list: () => Promise<DeviceServiceState>;
  readonly updateTool: (tool: 'hub' | 'agent') => Promise<DeviceServiceState>;
  /** Never rejects. */
  readonly inspect: () => Promise<DeviceServiceState>;
  readonly retryHost: (hostId: DeviceHostId) => Promise<DeviceServiceState>;
  readonly open: (input: DeviceOpenInput, context?: DeviceOpenContext) => Promise<DeviceSession>;
  readonly close: (input: DeviceCloseInput) => Promise<void>;
  readonly shutdown: (input: DeviceShutdownInput) => Promise<void>;
  readonly detail: (input: DeviceDetailInput) => Promise<DeviceDetail>;
  readonly action: (input: DeviceActionInput) => Promise<DeviceDetail>;
  readonly screenshot: (input: {
    readonly hostId?: DeviceHostId | undefined;
    readonly deviceId: DeviceId;
  }) => Promise<DeviceScreenshot>;
  /**
   * The device an id names in the last listing. Ids are unique per host, not across hosts (an
   * Android AVD name can exist on two), so a hostId decides, and without one the id has to be
   * on a single host. Rejects with `DeviceHostAmbiguousError` or `DeviceOnOtherHostError`.
   */
  readonly locateDevice: (input: {
    readonly hostId?: DeviceHostId | undefined;
    readonly deviceId: DeviceId;
  }) => Promise<DeviceSummary | undefined>;
  /** As `locateDevice`, among the devices a thread has open. */
  readonly locateSession: (input: {
    readonly threadId: ThreadId;
    readonly hostId?: DeviceHostId | undefined;
    readonly deviceId: DeviceId;
  }) => Promise<DeviceSession | undefined>;
  readonly readiness: (hostId?: DeviceHostId) => Promise<DeviceReadiness>;
  readonly readinessIfSupported: (hostId?: DeviceHostId) => Promise<DeviceReadiness | null>;
  readonly agentReadinessIfSupported: (hostId?: DeviceHostId) => Promise<DeviceAgentReadiness | null>;
  /** Never rejects. */
  readonly currentReadiness: (hostId?: DeviceHostId) => Promise<DeviceReadiness | null>;
  readonly sessionsForThread: (threadId: ThreadId) => ReadonlyArray<DeviceSession>;
  /** Stops every host's helpers. Devices keep running. */
  readonly dispose: () => Promise<void>;
}

export interface AgentDeviceLaunchers {
  /** Rejects with a `DeviceError`. */
  readonly bind: (input: { readonly session: string; readonly targetArgs: ReadonlyArray<string> }) => Promise<string>;
  /** Removes every launcher whose session is not in `live`. */
  readonly prune: (live: ReadonlySet<string>) => Promise<void>;
  /** Ends the agent-device session behind a launcher, which releases its claim on the device. */
  readonly release?: (launcher: string) => Promise<void>;
}

export interface DeviceServiceWithHostsOptions {
  readonly settings: DeviceSettingsStore;
  readonly hubBasePath?: string;
  /** Writes an agent-device config for a host (or one of its devices) and returns its path. */
  readonly configureAgent?: (
    hostId: DeviceHostId,
    endpoint: AgentDaemonEndpoint & { readonly stateDir?: string | undefined },
    deviceId?: DeviceId,
  ) => Promise<string>;
  readonly installTool?: (tool: 'hub' | 'agent') => Promise<unknown>;
  readonly launchers?: AgentDeviceLaunchers;
  readonly now?: () => number;
  readonly log?: { readonly warn: (message: string, fields?: Record<string, unknown>) => void };
}

/** Test seams the original exposed next to the service. */
export interface DeviceServiceInternals extends DeviceService {
  readonly setHostStatus: (
    hostId: DeviceHostId,
    status: DeviceServiceState['hostStatuses'][string],
  ) => Promise<DeviceServiceState>;
  readonly withLifecycleLock: <T>(task: () => Promise<T>) => Promise<T>;
  /** Republishes host summaries and drops state of hosts removed or replaced in `hosts`. */
  readonly refreshHosts: () => Promise<void>;
}

const errorTag = (error: unknown) => (error as { _tag?: unknown } | null)?._tag;
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What a failed host shows in its status. */
const failureDetail = (error: unknown) =>
  error instanceof DeviceHostUnavailableError ? error.fields.reason : errorMessage(error);

const forEachConcurrently = async <T>(items: Iterable<T>, concurrency: number, task: (item: T) => Promise<void>) => {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await task(item);
    }),
  );
};

/**
 * The service over a mutable host map. Replacing or removing an entry takes effect for new
 * operations; call `refreshHosts` (under `withLifecycleLock`) to drop the old host's state.
 */
export const makeDeviceServiceWithHosts = async (
  hosts: Map<DeviceHostId, DeviceHost>,
  options: DeviceServiceWithHostsOptions,
): Promise<DeviceServiceInternals> => {
  const { settings, launchers, installTool } = options;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? { warn: () => undefined };
  const configureAgent =
    options.configureAgent ??
    (async (hostId: DeviceHostId) => {
      throw new DeviceHostUnavailableError({
        hostId,
        reason: 'Agent configuration is unavailable in this device service.',
      });
    });
  const lifecycleLock = new Semaphore(1);
  const readDeviceSettings = async () => {
    try {
      return await settings.read();
    } catch (cause) {
      throw new DeviceOperationError({ operation: 'settings', reason: 'settings_failed', cause });
    }
  };
  const initialSettings = await readDeviceSettings();

  const listeners = new Set<(state: DeviceServiceState) => void>();
  const initialHosts = await Promise.all([...hosts.values()].map((host) => host.summary()));
  let publishedHosts = new Map(hosts);
  let current: DeviceServiceState = {
    supportsHostRetry: true,
    supportsToolUpdate: installTool !== undefined,
    supportsToolInspection: true,
    hosts: initialHosts,
    hostStatus: initialSettings.enabled ? 'idle' : 'disabled',
    hostStatuses: {},
    devices: [],
    sessions: [],
    onboardingCompleted: initialSettings.onboardingCompleted,
    agentAccessEnabled: initialSettings.agentAccessEnabled,
    hubBasePath: options.hubBasePath ?? DEFAULT_DEVICE_HUB_BASE_PATH,
    revision: 0,
  };

  const launcherLock = new Semaphore(1);
  /** Launchers bound since startup, by agent-device session. */
  const boundLaunchers = new Map<string, string>();
  /** Launchers on a session the host leases to every thread; the host ends it, not a retiring thread. */
  const hostSessionLaunchers = new Set<string>();
  // Binding and pruning read sessions under the lock, so neither acts on a session list the other has outdated.
  // A retired session's agent-device session ends before its launcher goes, and a reopen of the same
  // device waits for the lock, so the close cannot end the reopened session.
  const pruneLaunchers = () =>
    launcherLock.withPermit(async () => {
      if (!launchers) return;
      const live = new Set(
        current.sessions.map((session) => agentDeviceSession(session.threadId, session.hostId, session.deviceId)),
      );
      const retired = [...boundLaunchers].filter(([session]) => !live.has(session));
      for (const [session] of retired) boundLaunchers.delete(session);
      const ending = retired.filter(([session]) => !hostSessionLaunchers.delete(session));
      const release = launchers.release;
      if (release) await Promise.all(ending.map(([, launcher]) => release(launcher)));
      await launchers.prune(live);
    });

  const releaseLaunchers = (sessions: ReadonlyArray<DeviceSession>) =>
    launcherLock.withPermit(async () => {
      for (const session of sessions) {
        const name = agentDeviceSession(session.threadId, session.hostId, session.deviceId);
        const launcher = boundLaunchers.get(name);
        if (!launcher || hostSessionLaunchers.has(name) || !launchers?.release) continue;
        await launchers.release(launcher);
        boundLaunchers.delete(name);
      }
    });

  // A committed retirement always prunes, even if its caller stops waiting.
  const publish = async (update: (state: DeviceServiceState) => DeviceServiceState) => {
    const previous = current;
    const next = { ...update(previous), revision: previous.revision + 1 };
    current = next;
    for (const listener of listeners) {
      try {
        listener(next);
      } catch {}
    }
    const retired = previous.sessions.some((session) => !next.sessions.includes(session));
    if (retired) await pruneLaunchers();
    return next;
  };

  const resolveHost = async (hostId: DeviceHostId | undefined) => {
    const id = hostId ?? LOCAL_DEVICE_HOST_ID;
    const host = hosts.get(id);
    if (!host) throw new DeviceHostUnavailableError({ hostId: id, reason: 'Unknown host.' });
    return host;
  };

  // Readiness phases replace the shown detail; this restores an incomplete listing's cause once ready.
  const discoveryDetails = new Map<DeviceHostId, string>();

  const setHostStatus: DeviceServiceInternals['setHostStatus'] = async (hostId, status) => {
    if (!hosts.has(hostId)) return current;
    return publish((state) => {
      const previous = state.hostStatuses[hostId];
      const detail =
        status.detail ??
        (status.status === 'ready' && (previous?.incompletePlatforms || previous?.androidDiscoveryIncomplete)
          ? discoveryDetails.get(hostId)
          : undefined);
      return {
        ...state,
        ...(hostId === LOCAL_DEVICE_HOST_ID ? { hostStatus: status.status, hostStatusDetail: detail } : {}),
        hostStatuses: {
          ...state.hostStatuses,
          [hostId]: {
            ...(previous?.androidDiscoveryIncomplete ? { androidDiscoveryIncomplete: true } : {}),
            ...(previous?.incompletePlatforms ? { incompletePlatforms: previous.incompletePlatforms } : {}),
            ...stripUndefined(status),
            ...(detail ? { detail } : {}),
          },
        },
      };
    });
  };

  const hostFailureReason = (error: unknown, feature: 'starting' | 'agent') => {
    const tag = errorTag(error);
    if (tag === 'NodeRuntimeUnavailableError') return nodeRuntimeUnavailableMessage('Local device support');
    if (feature === 'agent' && tag === 'DeviceHostTimeoutError')
      return `Agent tools did not start within ${(error as { timeoutMs: number }).timeoutMs} ms.`;
    if (feature === 'agent' && tag === 'AgentDeviceStartError') return errorMessage(error);
    if (tag === 'DeviceHostError') return `Device support failed during ${(error as { step: string }).step}.`;
    return errorMessage(error);
  };

  const readiness: DeviceService['readiness'] = (hostId) =>
    lifecycleLock.withPermit(async () => {
      const host = await resolveHost(hostId);
      if (!(await readDeviceSettings()).enabled) {
        throw new DeviceHostUnavailableError({
          hostId: host.id,
          hostLabel: host.label,
          reason: 'Device support is off. Enable it in the Device panel before installing or starting device tools.',
        });
      }
      let ready: DeviceHostReady;
      try {
        ready = await host.ensureReady(async (status, detail) => {
          await setHostStatus(host.id, { status, ...(detail === undefined ? {} : { detail }) });
        });
      } catch (error) {
        await setHostStatus(host.id, { status: 'failed', detail: errorMessage(error) });
        throw new DeviceHostUnavailableError({
          hostId: host.id,
          hostLabel: host.label,
          reason: hostFailureReason(error, 'starting'),
          cause: error,
        });
      }
      if (hosts.get(host.id) !== host)
        throw new DeviceHostUnavailableError({
          hostId: host.id,
          hostLabel: host.label,
          reason: 'Host configuration changed. Retry the operation.',
        });
      if (current.hostStatuses[host.id]?.status !== 'ready') {
        await setHostStatus(host.id, { status: 'ready' });
      }
      return { hostId: host.id, ...ready };
    });

  const supportsPlatforms = async (host: DeviceHost) =>
    host.remote === true || (await host.summary()).platforms.some((platform) => platform.available);

  const readinessIfSupported: DeviceService['readinessIfSupported'] = async (hostId) => {
    if (!(await readDeviceSettings()).enabled) return null;
    const host = await resolveHost(hostId);
    if (!(await supportsPlatforms(host))) return null;
    return readiness(host.id);
  };

  const agentReadinessIfSupported: DeviceService['agentReadinessIfSupported'] = (hostId) =>
    lifecycleLock.withPermit(async () => {
      const deviceSettings = await readDeviceSettings();
      if (!deviceSettings.enabled || !deviceSettings.agentAccessEnabled) return null;
      const host = await resolveHost(hostId);
      if (!(await supportsPlatforms(host))) return null;
      let ready;
      try {
        ready = await host.ensureAgentReady(async (phase, detail) => {
          await setHostStatus(host.id, { status: phase, ...(detail === undefined ? {} : { detail }) });
        });
      } catch (error) {
        await setHostStatus(host.id, { status: 'failed', detail: errorMessage(error) });
        throw new DeviceHostUnavailableError({
          hostId: host.id,
          hostLabel: host.label,
          reason: hostFailureReason(error, 'agent'),
          cause: error,
        });
      }
      const hostSummaries = await Promise.all([...hosts.values()].map((candidate) => candidate.summary()));
      await publish((state) => ({ ...state, hosts: hostSummaries }));
      await setHostStatus(host.id, { status: 'ready' });
      return { hostId: host.id, ...ready };
    });

  const currentReadiness: DeviceService['currentReadiness'] = async (hostId) => {
    try {
      const host = await resolveHost(hostId);
      const ready = await host.current();
      return ready ? { hostId: host.id, ...ready } : null;
    } catch {
      return null;
    }
  };

  const fetchDevices = async (ready: DeviceReadiness) => {
    const { devices, detail, androidDiscoveryIncomplete, incompletePlatforms } = await ready.devices.list();
    return {
      devices: devices.map((device): DeviceSummary => ({ ...device, hostId: ready.hostId })),
      detail,
      androidDiscoveryIncomplete,
      incompletePlatforms: [...(incompletePlatforms ?? [])],
    };
  };

  const refresh = async (ready: DeviceReadiness) => {
    const host = hosts.get(ready.hostId);
    // A session opened while the listing ran is on a device the listing could
    // not have seen yet; only sessions from before it can be pruned by it.
    const sessionKey = (session: DeviceSession) =>
      `${session.hostId}\u0000${session.deviceId}\u0000${session.threadId}\u0000${session.openedAt}`;
    const before = new Set(current.sessions.map(sessionKey));
    const { devices, detail, androidDiscoveryIncomplete, incompletePlatforms } = await fetchDevices(ready);
    const hostSummaries = await Promise.all([...hosts.values()].map((candidate) => candidate.summary()));
    return lifecycleLock.withPermit(async () => {
      if (!(await readDeviceSettings()).enabled || !host || hosts.get(ready.hostId) !== host) return current;
      if (detail && (incompletePlatforms.length > 0 || androidDiscoveryIncomplete))
        discoveryDetails.set(ready.hostId, detail);
      else discoveryDetails.delete(ready.hostId);
      return publish((state) => ({
        ...state,
        hosts: hostSummaries,
        ...(ready.hostId === LOCAL_DEVICE_HOST_ID ? { hostStatusDetail: detail } : {}),
        devices: [
          ...state.devices.filter(
            (device) => device.hostId !== ready.hostId || incompletePlatforms.includes(device.platform),
          ),
          ...devices.filter((device) => !incompletePlatforms.includes(device.platform)),
        ],
        // A host that ends devices itself (cloud hosts stop sessions at their limits)
        // leaves sessions on devices it no longer lists with nothing to stream.
        // Other hosts can miss a device for one listing, so theirs stay.
        sessions: ready.devices.endsDevices
          ? state.sessions.filter(
              (session) =>
                session.hostId !== ready.hostId ||
                !before.has(sessionKey(session)) ||
                devices.some((device) => device.id === session.deviceId),
            )
          : state.sessions,
        hostStatuses: {
          ...state.hostStatuses,
          [ready.hostId]: {
            status: 'ready',
            ...(detail ? { detail } : {}),
            ...(androidDiscoveryIncomplete ? { androidDiscoveryIncomplete } : {}),
            ...(incompletePlatforms.length > 0 ? { incompletePlatforms } : {}),
          },
        },
      }));
    });
  };

  const list: DeviceService['list'] = async () => {
    if (!(await readDeviceSettings()).enabled) return current;
    await forEachConcurrently(hosts.values(), 4, async (host) => {
      try {
        const ready = await readinessIfSupported(host.id);
        if (ready) await refresh(ready);
      } catch (error) {
        await setHostStatus(host.id, { status: 'failed', detail: failureDetail(error) });
      }
    });
    return current;
  };

  const inspect: DeviceService['inspect'] = async () => {
    await forEachConcurrently(hosts.values(), 4, async (host) => {
      let result: { ok: true; summary: DeviceServiceState['hosts'][number] } | { ok: false };
      try {
        result = { ok: true, summary: await (host.inspect ?? host.summary)() };
      } catch {
        result = { ok: false };
      }
      if (hosts.get(host.id) !== host) return;
      if (!result.ok) {
        await publish((state) => ({
          ...state,
          hosts: state.hosts.map((value) =>
            value.id === host.id
              ? {
                  ...value,
                  toolInspectionError:
                    'Cannot check versions. Reconnect the host and check again. Installed tools have not been changed.',
                }
              : value,
          ),
        }));
        return;
      }
      const summary = result.summary;
      await publish((state) => ({
        ...state,
        hosts: state.hosts.map((value) => (value.id === host.id ? summary : value)),
      }));
    });
    return current;
  };

  const retryHost: DeviceService['retryHost'] = async (hostId) => {
    await resolveHost(hostId);
    if (!(await readDeviceSettings()).enabled) return current;
    try {
      const ready = (await agentReadinessIfSupported(hostId)) ?? (await readinessIfSupported(hostId));
      if (ready) await refresh(ready);
    } catch (error) {
      await setHostStatus(hostId, { status: 'failed', detail: failureDetail(error) });
    }
    return current;
  };

  const configure: DeviceService['configure'] = async (input) => {
    const currentSettings = await readDeviceSettings();
    const nextEnabled = input.enabled ?? currentSettings.enabled;
    const nextAgentAccess = input.agentAccessEnabled ?? currentSettings.agentAccessEnabled;
    await lifecycleLock.withPermit(async () => {
      try {
        await settings.update({
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          ...(input.agentAccessEnabled === undefined ? {} : { agentAccessEnabled: input.agentAccessEnabled }),
          ...(input.onboardingCompleted === undefined ? {} : { onboardingCompleted: input.onboardingCompleted }),
        });
      } catch (cause) {
        throw new DeviceOperationError({ operation: 'configure', reason: 'settings_failed', cause });
      }
      if (!nextEnabled) {
        for (const host of hosts.values()) await host.stop();
      } else if (input.agentAccessEnabled === false) {
        for (const host of hosts.values()) await host.stopAgent();
      }
      await publish((state) => ({
        ...state,
        hostStatus: nextEnabled ? 'idle' : 'disabled',
        hostStatusDetail: undefined,
        hostStatuses: {},
        devices: nextEnabled ? state.devices : [],
        sessions: nextEnabled ? state.sessions : [],
        bootingDevices: nextEnabled ? state.bootingDevices : [],
        agentAccessEnabled: nextAgentAccess,
        onboardingCompleted: input.onboardingCompleted ?? state.onboardingCompleted,
      }));
    });
    if (nextEnabled && nextAgentAccess && input.agentAccessEnabled === true) {
      await agentReadinessIfSupported();
    }
    return list();
  };

  const findDevice = (state: DeviceServiceState, hostId: DeviceHostId, deviceId: DeviceId): DeviceSummary | undefined =>
    state.devices.find((device) => device.hostId === hostId && device.id === deviceId);

  const ensurePlatform = async (host: DeviceHost, platform: DevicePlatform) => {
    const availability = await host.platformAvailability(platform);
    if (!availability.available) {
      throw new DevicePlatformUnavailableError({
        hostId: host.id,
        platform,
        reason: availability.reason ?? 'Platform toolchain missing.',
      });
    }
  };

  const open: DeviceService['open'] = async (input, context) => {
    const host = await resolveHost(input.hostId);
    await ensurePlatform(host, input.platform);
    const ready = await readiness(host.id);
    let state = await refresh(ready);
    let device = findDevice(state, host.id, input.deviceId);
    if (!device) throw new DeviceNotFoundError({ hostId: host.id, deviceId: input.deviceId });
    // Hosts that route their own streams never encode emulator video with serve-emu's ffmpeg.
    if (device.platform === 'android' && !device.physical && !ready.upstream) {
      // Resolve the override on the device host the way its hub does.
      const encoders = await ready.run(ready.nodePath, [
        '-e',
        `const { spawnSync } = require("node:child_process");
  const result = spawnSync(process.env.SERVE_EMU_FFMPEG?.trim() || "ffmpeg", ["-hide_banner", "-encoders"], {
    stdio: "inherit", timeout: 10000, killSignal: "SIGKILL",
  });
  process.exitCode = result.error ? 1 : (result.status ?? 1);`,
      ]);
      if (encoders.code !== 0) {
        throw new DevicePlatformUnavailableError({
          hostId: host.id,
          platform: 'android',
          reason:
            'Android emulator video needs working ffmpeg with the libx264 encoder. Install it on the device host\'s PATH or set SERVE_EMU_FFMPEG there, then retry opening the emulator. After changing PATH or SERVE_EMU_FFMPEG, restart the local environment server.',
        });
      }
      if (!/^\s*V\S*[ \t]+libx264(?:[ \t]|$)/m.test(`${encoders.stdout}\n${encoders.stderr}`)) {
        throw new DevicePlatformUnavailableError({
          hostId: host.id,
          platform: 'android',
          reason:
            'Android emulator video needs the libx264 encoder. Install an ffmpeg build that includes libx264 on the device host, then retry opening the emulator. After changing PATH or SERVE_EMU_FFMPEG, restart the local environment server.',
        });
      }
    }
    if (!device.booted && input.boot !== false) {
      const booting = { ...device, threadId: input.threadId };
      await publish((state) => ({
        ...state,
        bootingDevices: [
          ...(state.bootingDevices ?? []).filter((entry) => entry.hostId !== booting.hostId || entry.id !== booting.id),
          booting,
        ],
      }));
      let bootedId: string;
      try {
        bootedId = await ready.devices.boot(device, context);
      } finally {
        await publish((state) => ({
          ...state,
          bootingDevices: (state.bootingDevices ?? []).filter(
            (entry) => entry.hostId !== booting.hostId || entry.id !== booting.id,
          ),
        }));
      }
      state = await refresh(ready);
      // Retained entries predate the boot, so only a complete listing confirms the booted device.
      device = state.hostStatuses[host.id]?.incompletePlatforms?.includes(device.platform)
        ? undefined
        : (findDevice(state, host.id, bootedId) ?? findDevice(state, host.id, device.id));
      if (!device) throw new DeviceNotFoundError({ hostId: host.id, deviceId: bootedId });
    } else if (device.booted) {
      await ready.devices.attach(device);
    }
    if (hosts.get(host.id) !== host)
      throw new DeviceHostUnavailableError({
        hostId: host.id,
        hostLabel: host.label,
        reason: 'Host configuration changed. Retry the operation.',
      });
    const session: DeviceSession = {
      threadId: input.threadId,
      hostId: host.id,
      deviceId: device.id,
      platform: device.platform,
      openedAt: new Date(now()).toISOString(),
    };
    await lifecycleLock.withPermit(async () => {
      if (!(await readDeviceSettings()).enabled)
        throw new DeviceHostUnavailableError({
          hostId: host.id,
          hostLabel: host.label,
          reason: 'Device support was turned off while the device was opening.',
        });
      await publish((state) => ({
        ...state,
        sessions: [
          ...state.sessions.filter(
            (existing) =>
              !(
                existing.threadId === session.threadId &&
                existing.hostId === session.hostId &&
                existing.deviceId === session.deviceId
              ),
          ),
          session,
        ],
      }));
    });
    return session;
  };

  const refreshAfterShutdown = async (ready: DeviceReadiness) => {
    try {
      await refresh(ready);
    } catch (cause) {
      log.warn('Device discovery unavailable after shutdown', { cause });
    }
  };

  const shutdownDevice = async (ready: DeviceReadiness, deviceId: DeviceId, platform: DevicePlatform) => {
    await ready.devices.shutdown({ id: deviceId, platform });
    await publish((state) => ({
      ...state,
      devices: state.devices.map((device) =>
        device.hostId === ready.hostId && device.id === deviceId ? { ...device, booted: false } : device,
      ),
    }));
  };

  const close: DeviceService['close'] = async (input) => {
    // Open publishes under the same lock; an old close must not release a reopened claim.
    const closing = await lifecycleLock.withPermit(async () => {
      const state = current;
      const closing = state.sessions.filter(
        (session) =>
          session.threadId === input.threadId &&
          (input.hostId === undefined || session.hostId === input.hostId) &&
          (input.deviceId === undefined || session.deviceId === input.deviceId),
      );
      const ending = input.shutdown
        ? state.sessions.filter((session) =>
            closing.some((closed) => closed.hostId === session.hostId && closed.deviceId === session.deviceId),
          )
        : closing;
      for (const session of ending) {
        const host = await resolveHost(session.hostId);
        const ready = await host.current();
        // A lost connection to a remote host does not establish that its daemon stopped.
        if (!ready && host.remote)
          throw new DeviceHostUnavailableError({
            hostId: session.hostId,
            hostLabel: host.label,
            reason: 'Device host is reconnecting. Retry close after it reconnects.',
          });
        if (ready?.releaseAgentSession) {
          const name = agentDeviceSession(session.threadId, session.hostId, session.deviceId);
          await ready.releaseAgentSession(name, session.deviceId);
        }
      }
      if (input.shutdown) await releaseLaunchers(ending);
      if (input.shutdown) {
        for (const session of closing) {
          const ready = await currentReadiness(session.hostId);
          if (!ready)
            throw new DeviceHostUnavailableError({
              hostId: session.hostId,
              reason: 'Device host is not running. Reconnect before retrying close.',
            });
          await shutdownDevice(ready, session.deviceId, session.platform);
        }
      }
      await publish((state) => ({
        ...state,
        sessions: state.sessions.filter((session) => !ending.includes(session)),
      }));
      return closing;
    });
    if (input.shutdown) {
      for (const session of closing) {
        const ready = await currentReadiness(session.hostId);
        if (ready) await refreshAfterShutdown(ready);
      }
    }
  };

  // Sessions retire before the power-off, while their agent-device sessions can still close the app;
  // agent-device keeps a claim whose app close fails.
  const shutdown: DeviceService['shutdown'] = async (input) => {
    const host = await resolveHost(input.hostId);
    await publish((state) => ({
      ...state,
      sessions: state.sessions.filter(
        (session) => !(session.hostId === host.id && session.deviceId === input.deviceId),
      ),
    }));
    const ready = await readiness(host.id);
    await shutdownDevice(ready, input.deviceId, input.platform);
    await refreshAfterShutdown(ready);
  };

  const resolveDevice = async (hostId: DeviceHostId | undefined, deviceId: DeviceId) => {
    const host = await resolveHost(hostId);
    const ready = await readiness(host.id);
    const device = findDevice(current, host.id, deviceId) ?? findDevice(await refresh(ready), host.id, deviceId);
    if (!device) throw new DeviceNotFoundError({ hostId: host.id, deviceId });
    return { ready, device };
  };

  const screenshot: DeviceService['screenshot'] = async (input) => {
    const { ready, device } = await resolveDevice(input.hostId, input.deviceId);
    return { device, png: await ready.devices.screenshot(device) };
  };

  const detail: DeviceService['detail'] = async (input) => {
    const { ready, device } = await resolveDevice(input.hostId, input.deviceId);
    const read = await readDeviceDetail(ready, device.platform, device.id);
    return {
      hostId: ready.hostId,
      deviceId: device.id,
      settings: read.settings,
      foregroundApp: read.foregroundApp,
      readAt: new Date(now()).toISOString(),
    };
  };

  const action: DeviceService['action'] = async (input) => {
    const { ready, device } = await resolveDevice(input.hostId, input.deviceId);
    await runDeviceAction(ready, device.platform, input);
    return detail({ hostId: ready.hostId, deviceId: device.id });
  };

  const sessionsForThread: DeviceService['sessionsForThread'] = (threadId) =>
    current.sessions.filter((session) => session.threadId === threadId);

  const locate = <T extends { readonly hostId: DeviceHostId }>(
    state: DeviceServiceState,
    input: { readonly hostId?: DeviceHostId | undefined; readonly deviceId: DeviceId },
    matches: ReadonlyArray<T>,
  ): T | undefined => {
    const named = (id: DeviceHostId) => ({ id, label: state.hosts.find((host) => host.id === id)?.label });
    const onHost = matches.filter((match) => input.hostId === undefined || match.hostId === input.hostId);
    const hostIds = [...new Set(onHost.map((match) => match.hostId))];
    if (hostIds.length === 1) return onHost.at(-1)!;
    if (hostIds.length > 1) {
      throw new DeviceHostAmbiguousError({ deviceId: input.deviceId, hosts: hostIds.map(named) });
    }
    const elsewhere = [...new Set(matches.map((match) => match.hostId))];
    if (input.hostId !== undefined && elsewhere.length > 0) {
      throw new DeviceOnOtherHostError({
        deviceId: input.deviceId,
        host: named(input.hostId),
        hosts: elsewhere.map(named),
      });
    }
    return undefined;
  };

  const locateDevice: DeviceService['locateDevice'] = async (input) =>
    locate(
      current,
      input,
      current.devices.filter((device) => device.id === input.deviceId),
    );

  const locateSession: DeviceService['locateSession'] = async (input) =>
    locate(
      current,
      input,
      current.sessions.filter((session) => session.threadId === input.threadId && session.deviceId === input.deviceId),
    );

  const updateTool: DeviceService['updateTool'] = (tool) =>
    lifecycleLock.withPermit(async () => {
      if (!installTool)
        throw new DeviceOperationError({
          operation: 'update device tool',
          reason: 'request_failed',
          cause: new Error('Tool installation is unavailable in this device service.'),
        });
      await installTool(tool);
      return inspect();
    });

  const agentTarget: DeviceService['agentTarget'] = async (input) => {
    const host = await resolveHost(input.hostId);
    const ready = await agentReadinessIfSupported(input.hostId);
    if (!ready)
      throw new DeviceHostUnavailableError({
        hostId: host.id,
        hostLabel: host.label,
        reason:
          'Agent device access requires enabled device support, agent access, and an available simulator platform on this host.',
      });
    const { configPath, agentDeviceId, boundSession, installDirectory } = await lifecycleLock.withPermit(async () => {
      if (hosts.get(host.id) !== host)
        throw new DeviceHostUnavailableError({
          hostId: host.id,
          hostLabel: host.label,
          reason: 'Host configuration changed. Retry the operation.',
        });
      if (ready.devices.agentEndpoint) {
        const endpoint = await ready.devices.agentEndpoint(input.deviceId);
        return {
          configPath: await configureAgent(input.hostId, endpoint, input.deviceId),
          agentDeviceId: endpoint.agentDeviceId,
          boundSession: endpoint.session,
          installDirectory: endpoint.installDirectory,
        };
      }
      if (!ready.agentDevice)
        throw new DeviceHostUnavailableError({
          hostId: host.id,
          hostLabel: host.label,
          reason: 'This host has no agent-device daemon.',
        });
      return {
        configPath: await configureAgent(input.hostId, ready.agentDevice),
        agentDeviceId: input.deviceId as string | null,
        boundSession: undefined,
        installDirectory: undefined,
      };
    });
    const ownSession = agentDeviceSession(input.threadId, input.hostId, input.deviceId);
    if (boundSession) hostSessionLaunchers.add(ownSession);
    const session = boundSession ?? ownSession;
    return {
      agentDeviceId,
      session,
      args: ['--config', configPath, '--session', session],
      installDirectory,
    };
  };

  const agentLauncher: DeviceService['agentLauncher'] = async ({ targetArgs, ...target }) => {
    if (!launchers)
      throw new DeviceHostUnavailableError({
        hostId: target.hostId,
        reason: 'Agent launchers are unavailable in this device service.',
      });
    const session = agentDeviceSession(target.threadId, target.hostId, target.deviceId);
    return launcherLock.withPermit(async () => {
      if (
        !current.sessions.some(
          (live) =>
            live.threadId === target.threadId && live.hostId === target.hostId && live.deviceId === target.deviceId,
        )
      )
        return null;
      const launcher = await launchers.bind({ session, targetArgs });
      boundLaunchers.set(session, launcher);
      return launcher;
    });
  };

  const refreshHosts = async () => {
    const summaries = await Promise.all([...hosts.values()].map((host) => host.summary()));
    const unchanged = (id: DeviceHostId) => hosts.has(id) && hosts.get(id) === publishedHosts.get(id);
    await publish((state) => ({
      ...state,
      hosts: summaries,
      hostStatuses: Object.fromEntries(Object.entries(state.hostStatuses).filter(([id]) => unchanged(id))),
      devices: state.devices.filter((device) => unchanged(device.hostId)),
      sessions: state.sessions.filter((session) => unchanged(session.hostId)),
    }));
    publishedHosts = new Map(hosts);
  };

  // Sessions live in memory, so this removes every launcher a previous run left behind.
  await pruneLaunchers();

  return {
    agentTarget,
    agentLauncher,
    state: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    configure,
    list,
    updateTool,
    inspect,
    retryHost,
    open,
    close,
    shutdown,
    detail,
    action,
    screenshot,
    locateDevice,
    locateSession,
    readiness,
    readinessIfSupported,
    agentReadinessIfSupported,
    currentReadiness,
    sessionsForThread,
    dispose: async () => {
      for (const host of hosts.values()) await host.stop().catch(() => undefined);
    },
    setHostStatus,
    withLifecycleLock: (task) => lifecycleLock.withPermit(task),
    refreshHosts,
  };
};

const stripUndefined = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;

export interface CreateDeviceServiceOptions {
  /** Device state: settings, hub and daemon records, agent-device config and launchers. */
  readonly stateDir: string;
  /** Where device tools are installed. Defaults to `stateDir`. */
  readonly baseDir?: string;
  /** The mount path of the hub proxy, published in `state.hubBasePath`. */
  readonly hubBasePath?: string;
  /** Defaults to `{stateDir}/device/settings.json`. */
  readonly settings?: DeviceSettingsStore;
  readonly runtime?: DeviceRuntime;
  /** Defaults to this machine. Pass more hosts to add remote ones. */
  readonly hosts?: ReadonlyArray<DeviceHost>;
}

/** The device service on this machine, with tool installs, agent configs and launchers on disk. */
export const createDeviceService = async (options: CreateDeviceServiceOptions): Promise<DeviceServiceInternals> => {
  const runtime = options.runtime ?? nodeDeviceRuntime();
  const { stateDir } = options;
  const baseDir = options.baseDir ?? stateDir;
  const { fs, runner } = runtime;
  const hostList =
    options.hosts ?? [await createLocalDeviceHost({ baseDir, stateDir, runtime })];
  const hosts = new Map<DeviceHostId, DeviceHost>(hostList.map((host) => [host.id, host]));

  const configureAgent = async (
    hostId: DeviceHostId,
    endpoint: AgentDaemonEndpoint & { readonly stateDir?: string | undefined },
    deviceId?: DeviceId,
  ) => {
    const file = agentDeviceConfigPath(stateDir, hostId, deviceId);
    try {
      await writeAgentDeviceConfig(fs, file, endpoint);
    } catch (cause) {
      throw new DeviceOperationError({ operation: 'configure agent', reason: 'settings_failed', cause });
    }
    return file;
  };

  const automationUnavailable = (cause: unknown) =>
    new DeviceHostUnavailableError({
      hostId: LOCAL_DEVICE_HOST_ID,
      hostLabel: LOCAL_DEVICE_HOST_LABEL,
      reason: nodeRuntimeUnavailableMessage('Device automation'),
      cause,
    });

  const agentCli = async () => {
    try {
      await resolveNodeExecutable('Device automation', runtime);
      return (await ensureAgentDevice(runtime, baseDir)).entryPath;
    } catch (error) {
      if (errorTag(error) === 'NodeRuntimeUnavailableError') throw automationUnavailable(error);
      throw new DeviceOperationError({ operation: 'install agent CLI', reason: 'command_failed', cause: error });
    }
  };

  const launchers: AgentDeviceLaunchers = {
    bind: async (input) => {
      const entryPath = await agentCli();
      try {
        // The unbound launcher stays current for agents that still call it with flags.
        await ensureAgentDeviceShim(runtime, { entryPath, stateDir });
        return await bindAgentDeviceLauncher(runtime, { entryPath, stateDir, ...input });
      } catch (cause) {
        if (errorTag(cause) === 'NodeRuntimeUnavailableError') throw automationUnavailable(cause);
        throw new DeviceHostUnavailableError({
          hostId: LOCAL_DEVICE_HOST_ID,
          hostLabel: LOCAL_DEVICE_HOST_LABEL,
          reason: 'Could not prepare the agent-device launcher.',
          cause,
        });
      }
    },
    prune: (live) => pruneAgentDeviceLaunchers(runtime, { stateDir, live }),
    // Best effort: an unreachable host fails fast in the launcher's connection check, and the
    // launcher goes either way. Only a failed or timed-out close can leave the device claimed.
    release: async (launcher) => {
      try {
        const node = await resolveNodeExecutable('Device automation', runtime);
        const result = await runner.run({
          command: node,
          args: [NodePath.join(NodePath.dirname(launcher), 'agent-device-launcher.mjs'), 'close'],
          env: { ...runtime.env, ELECTRON_RUN_AS_NODE: '1' },
          timeoutMs: 15_000,
          timeoutBehavior: 'timedOutResult',
        });
        const outcome = agentDeviceCloseOutcome(result);
        if (outcome === 'failed' || outcome === 'timed-out')
          runtime.log.warn('Could not end the agent-device session', {
            launcher,
            outcome,
            stderr: result.stderr.slice(-500),
          });
      } catch (cause) {
        runtime.log.warn('Could not end the agent-device session', { launcher, cause });
      }
    },
  };

  return makeDeviceServiceWithHosts(hosts, {
    settings: options.settings ?? fileDeviceSettingsStore(fs, deviceSettingsPath(stateDir)),
    ...(options.hubBasePath === undefined ? {} : { hubBasePath: options.hubBasePath }),
    configureAgent,
    installTool: async (tool) => {
      try {
        return tool === 'hub' ? await ensureDeviceHub(runtime, baseDir) : await ensureAgentDevice(runtime, baseDir);
      } catch (cause) {
        const exitCode = (cause as { exitCode?: unknown }).exitCode;
        throw new DeviceOperationError({
          operation: 'update device tool',
          reason: 'command_failed',
          // Only the exit code goes into the shown message; npm's stderr can carry registry credentials.
          ...(typeof exitCode === 'number' ? { exitCode } : {}),
          cause,
        });
      }
    },
    launchers,
    now: runtime.now,
    log: runtime.log,
  });
};

/** True for errors the service reports to clients as `{ _tag, message }`. */
export const isReportedDeviceError = (error: unknown) =>
  isDeviceError(error) || error instanceof DeviceHostAmbiguousError || error instanceof DeviceOnOtherHostError;
