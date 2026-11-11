// Dropped: SSH, EAS and Simlock host configs, their account checks and the
// wire transform that kept older clients compatible. Only the local host remains.
import { z } from 'zod';

const trimmedNonEmpty = z.string().trim().min(1);

export const DevicePlatform = z.enum(['ios', 'android']);
export type DevicePlatform = z.infer<typeof DevicePlatform>;

export const DeviceHostId = trimmedNonEmpty.max(128);
export type DeviceHostId = z.infer<typeof DeviceHostId>;

export const LOCAL_DEVICE_HOST_ID: DeviceHostId = 'local';
export const LOCAL_DEVICE_HOST_LABEL = 'This machine';

/** Who owns a device session: a Factory session, thread or any caller-chosen id. */
export const ThreadId = trimmedNonEmpty;
export type ThreadId = z.infer<typeof ThreadId>;

export const DeviceId = trimmedNonEmpty.max(256);
export type DeviceId = z.infer<typeof DeviceId>;

export const DeviceSummary = z.object({
  hostId: DeviceHostId,
  id: DeviceId,
  platform: DevicePlatform,
  name: trimmedNonEmpty,
  version: z.string(),
  booted: z.boolean(),
  physical: z.boolean(),
});
export type DeviceSummary = z.infer<typeof DeviceSummary>;

export const DevicePlatformAvailability = z.object({
  platform: DevicePlatform,
  available: z.boolean(),
  reason: z.string().optional(),
});
export type DevicePlatformAvailability = z.infer<typeof DevicePlatformAvailability>;

export const DeviceToolVersion = z.object({
  requiredVersion: z.string(),
  installedVersions: z.array(z.string()),
  runningVersion: z.string().nullable(),
});
export type DeviceToolVersion = z.infer<typeof DeviceToolVersion>;

export const DeviceToolVersions = z.object({
  hub: DeviceToolVersion,
  agent: DeviceToolVersion,
});
export type DeviceToolVersions = z.infer<typeof DeviceToolVersions>;

export const DeviceHostSummary = z.object({
  id: DeviceHostId,
  label: trimmedNonEmpty,
  kind: z.literal('local'),
  platforms: z.array(DevicePlatformAvailability),
  tools: DeviceToolVersions.optional(),
  toolInspectionError: z.string().optional(),
  hubInstalled: z.boolean(),
  agentDeviceInstalled: z.boolean(),
});
export type DeviceHostSummary = z.infer<typeof DeviceHostSummary>;

export const DeviceHostStatus = z.enum(['disabled', 'idle', 'installing', 'starting', 'ready', 'failed']);
export type DeviceHostStatus = z.infer<typeof DeviceHostStatus>;

export const DeviceSession = z.object({
  threadId: ThreadId,
  hostId: DeviceHostId,
  deviceId: DeviceId,
  platform: DevicePlatform,
  openedAt: z.string(),
});
export type DeviceSession = z.infer<typeof DeviceSession>;

export const DeviceHostStatusEntry = z.object({
  status: DeviceHostStatus,
  detail: z.string().optional(),
  androidDiscoveryIncomplete: z.boolean().optional(),
  incompletePlatforms: z.array(DevicePlatform).optional(),
});
export type DeviceHostStatusEntry = z.infer<typeof DeviceHostStatusEntry>;

export const DeviceHostStatuses = z.record(DeviceHostId, DeviceHostStatusEntry);
export type DeviceHostStatuses = z.infer<typeof DeviceHostStatuses>;

export const DeviceServiceState = z.object({
  supportsHostRetry: z.boolean().optional(),
  supportsToolUpdate: z.boolean().optional(),
  supportsToolInspection: z.boolean().optional(),
  hostStatus: DeviceHostStatus,
  hostStatusDetail: z.string().optional(),
  hostStatuses: DeviceHostStatuses,
  hosts: z.array(DeviceHostSummary),
  devices: z.array(DeviceSummary),
  sessions: z.array(DeviceSession),
  bootingDevices: z.array(DeviceSummary.extend({ threadId: ThreadId })).optional(),
  onboardingCompleted: z.boolean(),
  agentAccessEnabled: z.boolean(),
  hubBasePath: z.string(),
  revision: z.number().int(),
});
export type DeviceServiceState = z.infer<typeof DeviceServiceState>;

export const DeviceListInput = z.object({
  updateTool: z.enum(['hub', 'agent']).optional(),
  inspectOnly: z.boolean().optional(),
  retryHostId: DeviceHostId.optional(),
});
export type DeviceListInput = z.infer<typeof DeviceListInput>;

export const DeviceConfigureInput = z.object({
  enabled: z.boolean().optional(),
  agentAccessEnabled: z.boolean().optional(),
  onboardingCompleted: z.boolean().optional(),
});
export type DeviceConfigureInput = z.infer<typeof DeviceConfigureInput>;

export const DeviceOpenInput = z.object({
  threadId: ThreadId,
  hostId: DeviceHostId.optional(),
  deviceId: DeviceId,
  platform: DevicePlatform,
  /** Boot the simulator or emulator when it is not running. Defaults to true. */
  boot: z.boolean().optional(),
});
export type DeviceOpenInput = z.infer<typeof DeviceOpenInput>;

export const DeviceCloseInput = z.object({
  hostId: DeviceHostId.optional(),
  threadId: ThreadId,
  /** Omit to close every device session for the thread. */
  deviceId: DeviceId.optional(),
  /** Also shut the simulator or emulator down. Defaults to false. */
  shutdown: z.boolean().optional(),
});
export type DeviceCloseInput = z.infer<typeof DeviceCloseInput>;

export const DeviceShutdownInput = z.object({
  hostId: DeviceHostId.optional(),
  deviceId: DeviceId,
  platform: DevicePlatform,
});
export type DeviceShutdownInput = z.infer<typeof DeviceShutdownInput>;

export const DeviceAppearance = z.enum(['light', 'dark']);
export type DeviceAppearance = z.infer<typeof DeviceAppearance>;

export const DeviceTextSize = z.enum(['small', 'default', 'large', 'extra-large']);
export type DeviceTextSize = z.infer<typeof DeviceTextSize>;

export const DeviceColorFilter = z.enum(['none', 'grayscale', 'red-green', 'green-red', 'blue-yellow']);
export type DeviceColorFilter = z.infer<typeof DeviceColorFilter>;

export const DeviceOrientation = z.enum([
  'portrait',
  'landscape_left',
  'portrait_upside_down',
  'landscape_right',
]);
export type DeviceOrientation = z.infer<typeof DeviceOrientation>;

export const DeviceSettings = z.object({
  appearance: DeviceAppearance.optional(),
  textSize: DeviceTextSize.optional(),
  reduceMotion: z.boolean().optional(),
  increaseContrast: z.boolean().optional(),
  reduceTransparency: z.boolean().optional(),
  showBorders: z.boolean().optional(),
  voiceOver: z.boolean().optional(),
  liquidGlass: z.enum(['clear', 'tinted']).optional(),
  colorFilter: DeviceColorFilter.optional(),
  networkEnabled: z.boolean().optional(),
  location: z.object({ latitude: z.number(), longitude: z.number() }).nullable().optional(),
});
export type DeviceSettings = z.infer<typeof DeviceSettings>;

export const DeviceForegroundApp = z.object({
  id: z.string(),
  name: z.string().optional(),
  version: z.string().optional(),
});
export type DeviceForegroundApp = z.infer<typeof DeviceForegroundApp>;

export const DeviceDetail = z.object({
  hostId: DeviceHostId,
  deviceId: DeviceId,
  settings: DeviceSettings,
  foregroundApp: DeviceForegroundApp.nullable(),
  readAt: z.string(),
});
export type DeviceDetail = z.infer<typeof DeviceDetail>;

export const DevicePermission = z.enum([
  'camera',
  'microphone',
  'photos',
  'contacts',
  'calendar',
  'reminders',
  'location',
  'notifications',
  'motion',
  'media-library',
  'faceid',
]);
export type DevicePermission = z.infer<typeof DevicePermission>;

const target = { hostId: DeviceHostId.optional(), deviceId: DeviceId };

export const DeviceActionInput = z.discriminatedUnion('type', [
  z.object({ ...target, type: z.literal('setAppearance'), value: DeviceAppearance }),
  z.object({ ...target, type: z.literal('setTextSize'), value: DeviceTextSize }),
  z.object({
    ...target,
    type: z.literal('setToggle'),
    setting: z.enum([
      'reduceMotion',
      'increaseContrast',
      'reduceTransparency',
      'showBorders',
      'voiceOver',
      'networkEnabled',
    ]),
    value: z.boolean(),
  }),
  z.object({ ...target, type: z.literal('setLiquidGlass'), value: z.enum(['clear', 'tinted']) }),
  z.object({ ...target, type: z.literal('setColorFilter'), value: DeviceColorFilter }),
  z.object({ ...target, type: z.literal('setOrientation'), value: DeviceOrientation }),
  z.object({
    ...target,
    type: z.literal('setLocation'),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  }),
  z.object({ ...target, type: z.literal('clearLocation') }),
  z.object({
    ...target,
    type: z.literal('setPermission'),
    appId: trimmedNonEmpty,
    permission: DevicePermission,
    decision: z.enum(['grant', 'revoke', 'reset']),
  }),
  z.object({ ...target, type: z.literal('openUrl'), url: trimmedNonEmpty }),
  z.object({ ...target, type: z.literal('launchApp'), appId: trimmedNonEmpty }),
  z.object({ ...target, type: z.literal('terminateApp'), appId: trimmedNonEmpty }),
  z.object({ ...target, type: z.literal('shake') }),
  z.object({
    ...target,
    type: z.literal('sendPush'),
    appId: trimmedNonEmpty,
    payload: z.union([z.string(), z.record(z.string(), z.unknown())]),
  }),
]);
export type DeviceActionInput = z.infer<typeof DeviceActionInput>;
export type DeviceActionType = DeviceActionInput['type'];

export const DeviceDetailInput = z.object(target);
export type DeviceDetailInput = z.infer<typeof DeviceDetailInput>;

export const DeviceToolListResult = z.object({
  hostStatuses: DeviceHostStatuses,
  hosts: z.array(DeviceHostSummary),
  devices: z.array(DeviceSummary),
  open: z.array(z.object({ hostId: DeviceHostId, deviceId: DeviceId })),
});
export type DeviceToolListResult = z.infer<typeof DeviceToolListResult>;

export const DeviceToolOpenInput = z.object({
  deviceId: DeviceId.optional().describe('Device id from `device_list`. Default: the booted or last used device.'),
  platform: DevicePlatform.optional().describe('Needed with no `deviceId` when both platforms exist.'),
  hostId: DeviceHostId.optional().describe('Host from `device_list`. Default local.'),
});
export type DeviceToolOpenInput = z.infer<typeof DeviceToolOpenInput>;

export const DeviceToolOpenResult = z.object({
  device: DeviceSummary,
  agentDevice: z.object({
    command: z.string(),
    targetArgs: z.array(z.string()),
    session: z.string(),
  }),
  quickStart: z.string(),
});
export type DeviceToolOpenResult = z.infer<typeof DeviceToolOpenResult>;

export const DeviceToolTargetInput = z.object({
  deviceId: DeviceId.optional().describe('Device. Default: the last one opened here.'),
  hostId: DeviceHostId.optional(),
});
export type DeviceToolTargetInput = z.infer<typeof DeviceToolTargetInput>;

export const DeviceToolScreenshotResult = z.object({
  device: DeviceSummary,
  screenshot: z.object({
    mimeType: z.literal('image/png'),
    data: z.string(),
    width: z.number().int(),
    height: z.number().int(),
  }),
});
export type DeviceToolScreenshotResult = z.infer<typeof DeviceToolScreenshotResult>;

export const DeviceToolCloseInput = z.object({
  deviceId: DeviceId.optional().describe('Device to close. None: close all here.'),
  hostId: DeviceHostId.optional(),
  shutdown: z.boolean().optional().describe('Also turn it off. Default false.'),
});
export type DeviceToolCloseInput = z.infer<typeof DeviceToolCloseInput>;

// Errors. Each carries a `_tag` and a message
// so the server can send `{ _tag, ...fields, message }` and the UI can switch on `_tag`.

abstract class TaggedDeviceError<F extends object = object> extends Error {
  abstract readonly _tag: string;
  readonly fields: F;
  constructor(message: string, fields: F) {
    const cause = (fields as { cause?: unknown }).cause;
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.fields = fields;
  }
}

export class DeviceHostUnavailableError extends TaggedDeviceError<{ hostId: string; hostLabel?: string; reason: string; cause?: unknown }> {
  readonly _tag = 'DeviceHostUnavailableError';
  constructor(fields: { hostId: string; hostLabel?: string; reason: string; cause?: unknown }) {
    super(`${fields.hostLabel ?? `Device host ${fields.hostId}`} is unavailable: ${fields.reason}`, fields);
  }
}

export class DevicePlatformUnavailableError extends TaggedDeviceError<{ hostId: string; platform: DevicePlatform; reason: string }> {
  readonly _tag = 'DevicePlatformUnavailableError';
  constructor(fields: { hostId: string; platform: DevicePlatform; reason: string }) {
    super(`${fields.platform} devices are unavailable on host ${fields.hostId}: ${fields.reason}`, fields);
  }
}

export class DeviceNotFoundError extends TaggedDeviceError<{ hostId: string; deviceId: string }> {
  readonly _tag = 'DeviceNotFoundError';
  constructor(fields: { hostId: string; deviceId: string }) {
    super(`Device ${fields.deviceId} was not found on host ${fields.hostId}.`, fields);
  }
}

export class DeviceBootError extends TaggedDeviceError<{
      hostId: string;
      deviceId: string;
      reason: 'disk_space' | 'timeout' | 'launch_failed';
      diagnostics?: string;
      cause?: unknown;
    }> {
  readonly _tag = 'DeviceBootError';
  constructor(fields: {
      hostId: string;
      deviceId: string;
      reason: 'disk_space' | 'timeout' | 'launch_failed';
      diagnostics?: string;
      cause?: unknown;
    }) {
    const explanation = {
      disk_space: 'There is not enough free disk space on its device host.',
      timeout: 'The device did not become ready in time.',
      launch_failed: 'The simulator or emulator could not start.',
    }[fields.reason];
    const summary = `Device ${fields.deviceId} failed to boot: ${explanation}`;
    super(
      fields.diagnostics
        ? `${summary}\n\n${fields.diagnostics.slice(0, 2_000)}`
        : `${summary} The device host sent no details. Try again or open another device; if it keeps failing, check the device on that host.`,
      fields,
    );
  }
}

export type DeviceOperationFailure =
  | 'command_failed'
  | 'request_failed'
  | 'invalid_payload'
  | 'settings_failed'
  | 'hub_rejected';

export class DeviceOperationError extends TaggedDeviceError<{
      operation: string;
      reason: DeviceOperationFailure;
      exitCode?: number;
      cause?: unknown;
    }> {
  readonly _tag = 'DeviceOperationError';
  constructor(fields: {
      operation: string;
      reason: DeviceOperationFailure;
      exitCode?: number;
      cause?: unknown;
    }) {
    const explanation = {
      command_failed: `The device command failed${fields.exitCode === undefined ? '' : ` (exit code ${fields.exitCode})`}.`,
      request_failed: 'Could not communicate with device support. Try refreshing devices.',
      invalid_payload: 'The device request could not be encoded.',
      settings_failed: 'Could not read or save device settings.',
      hub_rejected: 'The device hub could not complete the request.',
    }[fields.reason];
    super(`Device ${fields.operation} failed: ${explanation}`, fields);
  }
}

export class DeviceActionUnavailableError extends TaggedDeviceError<{
      operation: string;
      platform: DevicePlatform;
      reason: 'unsupported' | 'helper_missing';
    }> {
  readonly _tag = 'DeviceActionUnavailableError';
  constructor(fields: {
      operation: string;
      platform: DevicePlatform;
      reason: 'unsupported' | 'helper_missing';
    }) {
    super(
      fields.reason === 'helper_missing'
        ? `Device ${fields.operation} requires a helper missing from this install. Set up device support again.`
        : `Device ${fields.operation} is not supported on ${fields.platform}.`,
      fields,
    );
  }
}

export class DeviceToolUnavailableError extends TaggedDeviceError<{ reason: string; cause?: unknown }> {
  readonly _tag = 'DeviceToolUnavailableError';
  constructor(fields: { reason: string; cause?: unknown }) {
    super(fields.reason, fields);
  }
}

export type DeviceError =
  | DeviceHostUnavailableError
  | DevicePlatformUnavailableError
  | DeviceNotFoundError
  | DeviceBootError
  | DeviceOperationError
  | DeviceActionUnavailableError;

export type DeviceToolError = DeviceError | DeviceToolUnavailableError;

export const isDeviceError = (error: unknown): error is DeviceToolError =>
  error instanceof TaggedDeviceError;

/** What the HTTP API sends for a failed device call. */
export const DeviceErrorBody = z.object({ _tag: z.string(), message: z.string() });
export type DeviceErrorBody = z.infer<typeof DeviceErrorBody>;

export function deviceToolInstallMessage(name: string, tool: DeviceToolVersion | undefined) {
  if (!tool) return `Installing ${name}…`;
  const previous =
    tool.runningVersion ??
    [...tool.installedVersions].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1);
  return previous && !tool.installedVersions.includes(tool.requiredVersion)
    ? `Updating ${name} from ${previous} to ${tool.requiredVersion}…`
    : `Installing ${name} ${tool.requiredVersion}…`;
}
