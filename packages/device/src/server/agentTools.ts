// Agent tools (t3code mcp/toolkits/device) as plain functions. An MCP server mounts them by
// name with `deviceAgentToolDefinitions` and calls them with the invoking thread's context.
import {
  type DeviceHostId,
  type DeviceHostSummary,
  type DeviceId,
  type DevicePlatform,
  type DeviceSummary,
  DeviceToolCloseInput,
  type DeviceToolListResult,
  DeviceToolOpenInput,
  type DeviceToolOpenResult,
  type DeviceToolScreenshotResult,
  DeviceToolTargetInput,
  DeviceToolUnavailableError,
  LOCAL_DEVICE_HOST_ID,
  type ThreadId,
} from '../contracts.ts';
import { DeviceHostAmbiguousError, DeviceOnOtherHostError, type DeviceService } from './DeviceService.ts';
import { z } from 'zod';

function agentDeviceTargetArgs(device: DeviceSummary): ReadonlyArray<string> {
  return device.platform === 'ios'
    ? ['--platform', 'ios', '--udid', device.id]
    : ['--platform', 'android', '--serial', device.id];
}

const shellWord = (value: string) =>
  /^[a-zA-Z0-9_./:-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\"'\"'") + "'";

/** `targetArgs` are the flags the command still needs; a bound launcher needs none. */
export function agentDeviceQuickStart(
  device: DeviceSummary,
  targetArgs = agentDeviceTargetArgs(device),
  command = 'agent-device',
): string {
  const executable = shellWord(command);
  const target = targetArgs.map(shellWord).join(' ');
  const run = (args: string) => [executable, args, target].filter(Boolean).join(' ');
  const platformNotes =
    device.platform === 'ios'
      ? 'First use builds an XCTest runner and can take a couple of minutes; later commands are fast.'
      : 'The Android snapshot helper installs itself on first use.';
  return [
    `The user is watching ${device.name} (${device.version}) in the Device panel.`,
    target === ''
      ? `Drive it with ${executable}. It is bound to this device and session, so it needs no --platform, --udid, --serial, --config or --session flags. Use this exact path; login shells may reset PATH.`
      : `Drive it with ${executable}. Use this exact path; login shells may reset PATH. Always pass ${target}.`,
    // Screenshots and input need the session agent-device's open starts, and an iOS snapshot also
    // needs its app. device_open does not run open itself: on iOS that can start a minutes-long
    // XCTest runner build.
    'Every app launch, deep link, tap, text entry, alert, setting, screenshot and recording on this device goes through it. Run open <bundle-or-package-id> (apps lists them) before snapshots, CLI screenshots or input; it starts the session they need. Use device_screenshot just to look.',
    `  ${run('open <bundle-or-package-id> --relaunch')}  # restarts the app; Expo dev clients connect to their Metro, --metro-port <port> picks it`,
    `  ${run('open <bundle-or-package-id> <deep-link-url>')}`,
    `  ${run('snapshot -i')}  # accessibility tree with @eN refs`,
    `  ${run('press @e3 --settle')}`,
    `  ${run('fill @e5 "text" --settle')}`,
    `  ${run('alert accept')}`,
    `  ${run('settings appearance dark')}  # also text-size, permission grant <name>`,
    `  ${run('screenshot /tmp/shot.png')}  # ${device.platform === 'ios' ? 'iOS saves 1x points; add --pixel-density <n> (3 on most iPhones) for device resolution, ' : ''}or call device_screenshot to look`,
    `  ${run('record start --scope device /tmp/run.mp4')}  # then record stop`,
    `  ${run('install <app> <path-to-.app-or-.apk>')}`,
    `Prefer snapshot refs over coordinates. Run ${executable} help <command> for flags and ${executable} help workflow for guides.`,
    'Do not use simctl, idb, adb or ssh for those actions. They stay fine for builds, installs, code sync, Metro, port forwards, logs, test runners and what this command cannot do; come back to it for every UI action and screenshot so the user can watch.',
    'Each device_open returns its own command; opening another device does not retarget this one.',
    ...(target === ''
      ? ['The command is removed when the device closes or the server restarts. If it is missing, call device_open again.']
      : []),
    platformNotes,
  ].join('\n');
}

/** Throws `DeviceToolUnavailableError` for an unknown or ambiguous host. */
export function resolveHostId(
  hosts: ReadonlyArray<DeviceHostSummary>,
  hostId: string | undefined,
): DeviceHostId | undefined {
  if (!hostId) return undefined;
  const exact = hosts.find((host) => host.id === hostId);
  if (exact) return exact.id;
  const labelMatches = hosts.filter((host) => host.label.toLowerCase() === hostId.toLowerCase());
  if (labelMatches.length === 1) return labelMatches[0]!.id;
  const candidates = labelMatches.length > 1 ? labelMatches : hosts;
  const listed = [
    ...candidates.slice(0, 10).map((host) => `${host.label.slice(0, 64)} (${host.id})`),
    ...(candidates.length > 10 ? [`${candidates.length - 10} more`] : []),
  ].join(', ');
  const selector = hostId.slice(0, 128);
  throw new DeviceToolUnavailableError({
    reason:
      labelMatches.length > 1
        ? `Several device hosts are named ${selector}; pass one id: ${listed}.`
        : `No device host ${selector}. Known hosts: ${listed || 'none'}.`,
  });
}

const hostName = (host: { readonly id: DeviceHostId; readonly label?: string | undefined }) =>
  host.label === undefined ? `hostId ${host.id}` : `'${host.label}' (hostId ${host.id})`;

const mapLocateErrors = async <A>(promise: Promise<A>): Promise<A> => {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof DeviceHostAmbiguousError)
      throw new DeviceToolUnavailableError({
        reason: `Device ${error.deviceId} is on more than one host: ${error.hosts.map(hostName).join(', ')}. Pass hostId.`,
      });
    if (error instanceof DeviceOnOtherHostError)
      throw new DeviceToolUnavailableError({
        reason: `Device ${error.deviceId} is not on ${hostName(error.host)}. It is on ${error.hosts.map(hostName).join(', ')}; pass that hostId.`,
      });
    throw error;
  }
};

const pickDevice = async (
  service: DeviceService,
  state: { readonly hosts: ReadonlyArray<DeviceHostSummary>; readonly devices: ReadonlyArray<DeviceSummary> },
  input: {
    readonly deviceId?: DeviceId | undefined;
    readonly platform?: DevicePlatform | undefined;
    readonly hostId?: DeviceHostId | undefined;
  },
): Promise<DeviceSummary> => {
  if (input.deviceId !== undefined) {
    const { deviceId, hostId } = input;
    const located = await mapLocateErrors(service.locateDevice({ deviceId, hostId }));
    if (located) return located;
    throw new DeviceToolUnavailableError({
      reason: `No device ${deviceId} on ${hostId === undefined ? 'any host' : hostName(state.hosts.find((host) => host.id === hostId) ?? { id: hostId })}. Call device_list for current ids.`,
    });
  }
  const hostId = input.hostId ?? LOCAL_DEVICE_HOST_ID;
  const candidates = state.devices.filter(
    (device) => device.hostId === hostId && (input.platform === undefined || device.platform === input.platform),
  );
  if (candidates.length === 0) {
    throw new DeviceToolUnavailableError({
      reason:
        input.platform === undefined
          ? 'No simulators or emulators were found. Call device_list to see why.'
          : `No ${input.platform} devices were found on host ${hostId}. Call device_list to see why.`,
    });
  }
  const platforms = new Set(candidates.map((device) => device.platform));
  if (input.platform === undefined && platforms.size > 1) {
    throw new DeviceToolUnavailableError({
      reason: 'Both iOS and Android devices are available; pass platform or deviceId.',
    });
  }
  return candidates.find((device) => device.booted) ?? candidates[0]!;
};

export function pngDimensions(png: Uint8Array): { width: number; height: number } {
  if (png.length < 24) return { width: 0, height: 0 };
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const isPng =
    view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a && view.getUint32(12) === 0x49484452;
  return isPng ? { width: view.getUint32(16), height: view.getUint32(20) } : { width: 0, height: 0 };
}

/** Who is calling a device tool. */
export interface DeviceAgentToolContext {
  /** The owner id sessions are opened under, as in the Device panel. */
  readonly threadId: ThreadId;
  /** The project directory, for hosts whose devices depend on it. */
  readonly workspaceRoot?: string | undefined;
  /**
   * False when agent device access is off for this caller (t3code's per-thread MCP capability).
   * Defaults to true; the service still requires agent access in its settings.
   */
  readonly deviceAccess?: boolean | undefined;
}

const requireDeviceAccess = (context: DeviceAgentToolContext) => {
  if (context.deviceAccess === false)
    throw new DeviceToolUnavailableError({
      reason:
        'Agent device access is turned off for this environment. Ask the user to turn on Agent device access in the Device panel; it applies when the agent session next starts, such as in a new thread.',
    });
};

const deviceSupportOff = () =>
  new DeviceToolUnavailableError({
    reason:
      'Device support is off. Ask the user to enable it in the Device panel before installing or starting device tools.',
  });

export const DeviceToolListInput = z.object({
  hostId: z.string().optional().describe('Limit to one device host. Defaults to all hosts.'),
});
export type DeviceToolListInput = z.infer<typeof DeviceToolListInput>;

/** Tools reject with the contract's `DeviceToolError`s. */
export interface DeviceAgentTools {
  readonly device_list: (context: DeviceAgentToolContext, input?: DeviceToolListInput) => Promise<DeviceToolListResult>;
  readonly device_open: (context: DeviceAgentToolContext, input: DeviceToolOpenInput) => Promise<DeviceToolOpenResult>;
  readonly device_screenshot: (
    context: DeviceAgentToolContext,
    input: DeviceToolTargetInput,
  ) => Promise<DeviceToolScreenshotResult>;
  readonly device_close: (context: DeviceAgentToolContext, input: DeviceToolCloseInput) => Promise<Record<string, never>>;
}

export const createDeviceAgentTools = (service: DeviceService): DeviceAgentTools => ({
  device_list: async (context, input) => {
    requireDeviceAccess(context);
    const state = await service.list();
    if (state.hostStatus === 'disabled') throw deviceSupportOff();
    const hostId = resolveHostId(state.hosts, input?.hostId);
    const open = state.sessions
      .filter((session) => session.threadId === context.threadId)
      .map((session) => ({ hostId: session.hostId, deviceId: session.deviceId }));
    return {
      hostStatuses: Object.fromEntries(Object.entries(state.hostStatuses).filter(([id]) => !hostId || id === hostId)),
      hosts: hostId ? state.hosts.filter((host) => host.id === hostId) : state.hosts,
      devices: hostId ? state.devices.filter((device) => device.hostId === hostId) : state.devices,
      open,
    };
  },
  device_open: async (context, input) => {
    requireDeviceAccess(context);
    const state = await service.list();
    if (state.hostStatus === 'disabled') throw deviceSupportOff();
    const hostId = resolveHostId(state.hosts, input.hostId);
    const target = await pickDevice(service, state, { ...input, hostId });
    // Resolve consent and agent connectivity before booting or registering a session.
    if (!(await service.agentReadinessIfSupported(target.hostId))) {
      throw new DeviceToolUnavailableError({
        reason:
          'Agent device access requires enabled device support, agent access, and an available simulator platform on this host.',
      });
    }
    const session = await service.open(
      { threadId: context.threadId, hostId: target.hostId, deviceId: target.id, platform: target.platform },
      { workspaceRoot: context.workspaceRoot },
    );
    const after = service.state();
    const device =
      after.devices.find((candidate) => candidate.hostId === session.hostId && candidate.id === session.deviceId) ??
      target;
    // Target the opened device: a cloud device and its agent-device daemon
    // exist only once its session runs, and Android ids change on boot.
    const opened = { threadId: context.threadId, hostId: session.hostId, deviceId: session.deviceId };
    const agent = await service.agentTarget(opened);
    const targetArgs = [
      ...(agent.agentDeviceId === null ? [] : agentDeviceTargetArgs({ ...device, id: agent.agentDeviceId })),
      ...agent.args,
    ];
    const command = await service.agentLauncher({ ...opened, targetArgs });
    if (command === null) {
      throw new DeviceToolUnavailableError({
        reason:
          'The device was closed while device_open was preparing it. Call device_open again only if you still need it.',
      });
    }
    return {
      device,
      agentDevice: { command, targetArgs, session: agent.session },
      quickStart: agentDeviceQuickStart(device, [], command),
    };
  },
  device_screenshot: async (context, input) => {
    requireDeviceAccess(context);
    const threadId = context.threadId;
    const hostId = input.hostId === undefined ? undefined : resolveHostId(service.state().hosts, input.hostId);
    const target =
      input.deviceId === undefined
        ? service.sessionsForThread(threadId).findLast((session) => hostId === undefined || session.hostId === hostId)
        : await mapLocateErrors(service.locateSession({ threadId, deviceId: input.deviceId, hostId }));
    if (!target) {
      throw new DeviceToolUnavailableError({
        reason:
          input.deviceId === undefined
            ? 'No device is open in this thread. Call device_open first.'
            : `Device ${input.deviceId} is not open in this thread. Call device_open first.`,
      });
    }
    const shot = await service.screenshot(target);
    return {
      device: shot.device,
      screenshot: {
        mimeType: 'image/png' as const,
        data: Buffer.from(shot.png).toString('base64'),
        ...pngDimensions(shot.png),
      },
    };
  },
  device_close: async (context, input) => {
    requireDeviceAccess(context);
    const deviceId = input.deviceId;
    const inputHostId = input.hostId === undefined ? undefined : resolveHostId(service.state().hosts, input.hostId);
    const open =
      deviceId === undefined
        ? undefined
        : await mapLocateErrors(service.locateSession({ threadId: context.threadId, deviceId, hostId: inputHostId }));
    const hostId = open ? open.hostId : inputHostId;
    await service.close({
      threadId: context.threadId,
      ...(hostId === undefined ? {} : { hostId }),
      ...(deviceId === undefined ? {} : { deviceId }),
      ...(input.shutdown === undefined ? {} : { shutdown: input.shutdown }),
    });
    return {};
  },
});

/** Names, descriptions, annotations and schemas for registering the tools with an MCP server. */
export const deviceAgentToolDefinitions = {
  device_list: {
    title: 'List devices',
    description:
      'List iOS Simulators and Android Emulators on every device host, what each host can run, and what is open in this thread\'s Device panel. Call before `device_open` when you do not know a device id.',
    // An empty object serializes as `anyOf [object, array]` in some converters, which some
    // providers reject and then drop every tool on the server with it.
    input: DeviceToolListInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  device_open: {
    title: 'Open device',
    description:
      "Open a simulator or emulator for this thread. Pass `deviceId` and `hostId` from `device_list`. Boots it if needed and shows it in the user's Device panel. Returns the `agent-device` CLI call pinned to that device. Drive the device with that CLI.",
    input: DeviceToolOpenInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  device_screenshot: {
    title: 'Screenshot device',
    description: "Get a PNG of an open device's screen. For taps and text, use the `agent-device` CLI.",
    input: DeviceToolTargetInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  device_close: {
    title: 'Close device',
    description: "Remove a device from this thread's Device panel. `shutdown=true` also turns it off.",
    input: DeviceToolCloseInput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
} as const;
