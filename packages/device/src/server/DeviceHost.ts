import type {
  DeviceHostId,
  DeviceHostSummary,
  DevicePlatform,
  DevicePlatformAvailability,
  DeviceSummary,
} from '../contracts.ts';

export class DeviceHostError extends Error {
  readonly _tag = 'DeviceHostError';
  readonly hostId: string;
  readonly step: string;
  constructor(fields: { hostId: string; step: string; cause: unknown }) {
    super(`Device host ${fields.hostId} failed while ${fields.step}.`, { cause: fields.cause });
    this.hostId = fields.hostId;
    this.step = fields.step;
  }
}

export class DeviceHostTimeoutError extends Error {
  readonly _tag = 'DeviceHostTimeoutError';
  readonly hostId: string;
  readonly timeoutMs: number;
  constructor(fields: { hostId: string; timeoutMs: number }) {
    super(`Device host ${fields.hostId} did not start agent tools within ${fields.timeoutMs} ms.`);
    this.hostId = fields.hostId;
    this.timeoutMs = fields.timeoutMs;
  }
}

export type AgentDeviceStartFailure =
  | 'daemon_lock_not_directory'
  | 'daemon_registration_unproven'
  | 'daemon_retirement_unconfirmed'
  | 'command_failed';

export class AgentDeviceStartError extends Error {
  readonly _tag = 'AgentDeviceStartError';
  readonly hostId: string;
  readonly stateDir: string;
  readonly exitCode: number | null;
  readonly reason: AgentDeviceStartFailure;
  constructor(fields: {
    hostId: string;
    stateDir: string;
    exitCode: number | null;
    reason: AgentDeviceStartFailure;
    cause: unknown;
  }) {
    const exit = fields.exitCode === null ? '' : ` (exit code ${fields.exitCode})`;
    const detail =
      fields.reason === 'daemon_lock_not_directory'
        ? 'Daemon registration ownership could not be verified: daemon.lock is not a directory.'
        : fields.reason === 'daemon_registration_unproven'
          ? 'Daemon registration ownership could not be verified.'
          : fields.reason === 'daemon_retirement_unconfirmed'
            ? 'Daemon replacement could not be confirmed.'
            : 'The AgentDevice startup command failed.';
    const recovery =
      fields.reason === 'command_failed'
        ? `Inspect daemon diagnostics in ${fields.stateDir}.`
        : `Inspect daemon.lock and daemon diagnostics in ${fields.stateDir}. Stop older clients and daemons with their original CLI before manually repairing retained state.`;
    super(`Agent tools failed to start${exit}. ${detail} ${recovery}`, { cause: fields.cause });
    this.hostId = fields.hostId;
    this.stateDir = fields.stateDir;
    this.exitCode = fields.exitCode;
    this.reason = fields.reason;
  }
}

export interface DeviceHubEndpoint {
  readonly origin: string;
  /**
   * Headers every request to the hub carries: its session token. The hub listens on loopback, where
   * any local process (an agent running as another user among them) could otherwise drive it.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface AgentDeviceEndpoint {
  readonly baseUrl: string;
  readonly token: string;
  readonly entryPath: string;
}

export type HostDevice = Omit<DeviceSummary, 'hostId'>;

/** Where a device is being opened from, for hosts whose devices depend on the project. */
export interface DeviceOpenContext {
  readonly workspaceRoot?: string | undefined;
}

export type AgentDaemonEndpoint = Pick<AgentDeviceEndpoint, 'baseUrl' | 'token'>;

export interface AgentDeviceBinding extends AgentDaemonEndpoint {
  /** Null when the session alone picks the device and selector flags would be refused. */
  readonly agentDeviceId: string | null;
  /** The one session the device is leased to, shared by every thread. */
  readonly session?: string;
  /** agent-device state holding that session's connection. */
  readonly stateDir?: string;
  /** agent-device accepts installs into the session only from the directory that opened it. */
  readonly installDirectory?: string;
}

/** Where the proxy sends a device hub request, for hosts that serve several upstreams. */
export interface HubUpstream {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly protocols: ReadonlyArray<string>;
}

export interface DeviceListing {
  readonly devices: ReadonlyArray<HostDevice>;
  readonly detail: string | undefined;
  /** Some Android virtual devices could not be listed; the rest are. */
  readonly androidDiscoveryIncomplete?: boolean;
  /** Platforms that could not be listed; their last known devices stay listed. */
  readonly incompletePlatforms?: ReadonlyArray<DevicePlatform>;
}

/**
 * Discovery and lifecycle for the devices a ready host can run. Methods reject with the
 * contract errors (`DeviceOperationError`, `DeviceBootError`, `DeviceHostUnavailableError`).
 */
export interface DeviceOperations {
  readonly list: () => Promise<DeviceListing>;
  /**
   * Boots the device and prepares its stream. Android AVDs change id when they
   * boot (AVD name to emulator serial), so the returned id is authoritative.
   */
  readonly boot: (device: HostDevice, context?: DeviceOpenContext) => Promise<string>;
  /** Prepares the stream of a device that is already booted. */
  readonly attach: (device: HostDevice) => Promise<void>;
  readonly shutdown: (device: { readonly id: string; readonly platform: DevicePlatform }) => Promise<void>;
  readonly screenshot: (device: HostDevice) => Promise<Uint8Array>;
  /**
   * For hosts that run one agent-device daemon per device instead of one per
   * host. `agentDeviceId` is the id agent-device selects the device by, when
   * it differs from the host's device id.
   */
  readonly agentEndpoint?: (deviceId: string) => Promise<AgentDeviceBinding>;
  /**
   * Set by hosts that end devices on their own (cloud hosts stop sessions at their
   * limits), so a session on a device the host stops listing is dropped.
   */
  readonly endsDevices?: boolean;
}

export interface DeviceHostRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface DeviceHostReady {
  readonly nodePath: string;
  /**
   * Ends an agent-device session on the daemon that serves `deviceId`. Hosts
   * with a shared daemon provide it only while that daemon runs; hosts with a
   * daemon per device succeed when the device's daemon is gone. Cleanup never
   * starts a daemon or a device.
   */
  readonly releaseAgentSession?: (session: string, deviceId: string) => Promise<void>;
  readonly hub: DeviceHubEndpoint;
  readonly devices: DeviceOperations;
  /** Never rejects: spawn failures resolve with code 127 and timeouts with 124. */
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    options?: {
      readonly timeoutMs?: number;
      readonly stdin?: string;
      /** Local output cap. */
      readonly maxOutputBytes?: number;
    },
  ) => Promise<DeviceHostRunResult>;
  readonly helpers: {
    readonly serveSimAxSettings: string | null;
    readonly serveSimCli: string | null;
  };
  /** Routes proxied hub requests itself; otherwise they go to `hub.origin`. */
  readonly upstream?: (hubPath: string, search: URLSearchParams) => Promise<HubUpstream | null>;
}

export interface DeviceHostAgentReady extends DeviceHostReady {
  /** Null when each device has its own daemon; see `DeviceOperations.agentEndpoint`. */
  readonly agentDevice: AgentDeviceEndpoint | null;
}

export type DeviceHostPhase = 'installing' | 'starting';
export type DeviceHostPhaseListener = (phase: DeviceHostPhase, detail?: string) => Promise<void> | void;

/**
 * A machine that runs simulators and emulators. Only the local host ships today; the
 * interface stays general so remote hosts (SSH, cloud pools) can be added later.
 */
export interface DeviceHost {
  readonly id: DeviceHostId;
  /** The name errors and the Device panel show for this host. */
  readonly label: string;
  /**
   * Set by hosts reached over a connection (SSH and the like). A lost connection does not
   * establish that the host's agent daemon stopped, so close keeps sessions until it reconnects,
   * and readiness does not require a locally available platform.
   */
  readonly remote?: boolean;
  readonly summary: () => Promise<DeviceHostSummary>;
  /** Rejects with `DeviceHostError` when the host cannot be inspected. */
  readonly inspect?: () => Promise<DeviceHostSummary>;
  readonly platformAvailability: (platform: DevicePlatform) => Promise<DevicePlatformAvailability>;
  /** Rejects with `DeviceHostError` or `NodeRuntimeUnavailableError`. */
  readonly ensureReady: (onPhase: DeviceHostPhaseListener) => Promise<DeviceHostReady>;
  /** Also rejects with `DeviceHostTimeoutError` or `AgentDeviceStartError`. */
  readonly ensureAgentReady: (onPhase: DeviceHostPhaseListener) => Promise<DeviceHostAgentReady>;
  readonly current: () => Promise<DeviceHostReady | null>;
  readonly stopAgent: () => Promise<void>;
  /** Stops helpers. Devices themselves keep running; the user owns those. */
  readonly stop: () => Promise<void>;
}
