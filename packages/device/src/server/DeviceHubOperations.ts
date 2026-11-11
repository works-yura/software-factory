import { z } from 'zod';

import { DeviceBootError, type DeviceHostId, DeviceOperationError, type DevicePlatform } from '../contracts.ts';
import type { DeviceHostReady, DeviceOperations, HostDevice } from './DeviceHost.ts';
import { HttpStatusError, timeoutOption, withTimeout } from './runtime.ts';

const BOOT_TIMEOUT_MS = 3 * 60_000;
const SCREENSHOT_TIMEOUT_MS = 20_000;
// Let the hub's 30 s simctl timeout report its cause first.
const LIST_TIMEOUT_SECONDS = 40;
// expo-device-hub 0.19.1 reports a failed simulator listing only as text; its error ids are hashes.
const SIMULATOR_LIST_FAILED =
  /^\[apple-utils\] (?:Failed to (?:run `xcrun simctl list devices|parse JSON output:|list devices:)|`xcrun simctl list devices --json` did not respond within )/;
// The hub passes numeric display IDs that Xcode 26 rejects; iOS 27 needs them for multiple displays.
const runsOnXcode26Runtime = (version: string) => Number(/^iOS (\d+)/.exec(version)?.[1]) <= 26;
const DEFAULT_DISPLAY_SCREENSHOT = `f=$(mktemp -t t3-screenshot) || exit 1
trap 'rm -f "$f"' 0
xcrun simctl io "$1" screenshot --type=png "$f" >/dev/null && base64 -i "$f"`;

const HubDevice = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  platform: z.enum(['ios', 'android']),
  booted: z.boolean(),
  physical: z.boolean(),
});
const HubErrors = z.array(z.object({ message: z.string(), error: z.string().optional() })).optional();
const HubDeviceList = z.object({
  simulators: z.array(HubDevice),
  emulators: z.array(HubDevice),
  errors: HubErrors,
});
const HubActionResult = z.object({
  ok: z.boolean(),
  id: z.string().optional(),
  serial: z.string().optional(),
  error: z.string().optional(),
  errors: HubErrors,
});

// Hub diagnostics can carry a whole stderr dump.
const boundDiagnostics = (text: string) => (text.length > 2_000 ? `${text.slice(0, 1_999)}…` : text);

// The hub's `error` is a util.inspect of Node's exec error; the stack and the
// inspected fields follow the first frame, so keep the lines before it.
const errorHead = (error: string) => {
  const lines = error.split(/\r?\n/);
  const firstFrame = lines.findIndex((line) => /^\s+at /.test(line));
  return (firstFrame === -1 ? lines : lines.slice(0, firstFrame))
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
};

const vendorPrefix = (platform: DevicePlatform) => (platform === 'ios' ? '/vendor/serve-sim' : '/vendor/serve-emu');

/** Device operations for a host that runs expo-device-hub at `origin`. */
export const makeDeviceHubOperations = (options: {
  readonly hostId: DeviceHostId;
  readonly origin: string;
  readonly fetch: typeof fetch;
  readonly run: DeviceHostReady['run'];
  /** Android gates listing AVDs, which the hub does not report until they boot. */
  readonly platformAvailable: (platform: DevicePlatform) => Promise<boolean>;
  readonly log?: { readonly info: (message: string, fields?: Record<string, unknown>) => void };
}): DeviceOperations => {
  const { hostId, origin, run } = options;

  const fetchJson = async <T>(
    url: string,
    init: RequestInit,
    schema: z.ZodType<T>,
    signal: AbortSignal,
  ): Promise<T> => {
    const response = await options.fetch(url, { ...init, signal });
    if (!response.ok) {
      await response.arrayBuffer().catch(() => undefined);
      throw new HttpStatusError(url, response.status);
    }
    return schema.parse(await response.json());
  };

  const hubJson = async <T>(
    path: string,
    body: Record<string, string>,
    schema: z.ZodType<T>,
    operation: string,
    timeoutMs = 15_000,
  ): Promise<T> => {
    let encoded: string;
    try {
      encoded = JSON.stringify(body);
    } catch (cause) {
      throw new DeviceOperationError({ operation, reason: 'invalid_payload', cause });
    }
    try {
      return await withTimeout(timeoutMs, (signal) =>
        fetchJson(
          `${origin}${path}`,
          { method: 'POST', headers: { 'content-type': 'application/json' }, body: encoded },
          schema,
          signal,
        ),
      );
    } catch (cause) {
      throw new DeviceOperationError({ operation, reason: 'request_failed', cause });
    }
  };

  // Booting alone does not attach a serve-sim helper; the grid start does both
  // and is idempotent for a booted simulator.
  const attachIosStream = (udid: string) =>
    hubJson(`${vendorPrefix('ios')}/grid/api/start`, { udid }, HubActionResult, 'attach stream', BOOT_TIMEOUT_MS);

  const list: DeviceOperations['list'] = async () => {
    let listed: z.infer<typeof HubDeviceList> | undefined;
    try {
      listed = await timeoutOption(LIST_TIMEOUT_SECONDS * 1_000, (signal) =>
        fetchJson(`${origin}/api/devices`, {}, HubDeviceList, signal),
      );
    } catch (cause) {
      throw new DeviceOperationError({ operation: 'list', reason: 'request_failed', cause });
    }
    if (listed === undefined) {
      const incompletePlatforms: DevicePlatform[] = [];
      for (const platform of ['ios', 'android'] as const) {
        if (await options.platformAvailable(platform)) incompletePlatforms.push(platform);
      }
      return {
        devices: [],
        detail: `The device hub did not answer within ${LIST_TIMEOUT_SECONDS} seconds.`,
        incompletePlatforms,
      };
    }
    const hubList = listed;
    const devices: Array<HostDevice> = [...hubList.simulators, ...hubList.emulators];
    const androidAvailable = await options.platformAvailable('android');
    const warnings = hubList.errors?.filter(
      (error) =>
        // The host summary already explains a missing Android SDK; the hub's failed probes are noise.
        !(!androidAvailable && error.message.startsWith('[android-utils] ')) &&
        // CoreSimulator can retain deleted devices; their optional usage timestamps are absent.
        !(
          error.message.startsWith('[apple-utils] Failed to read CoreSimulator plist at ') &&
          /\/CoreSimulator\/Devices\/[^/]+\/device\.plist:$/.test(error.message) &&
          /(?:^Error:\s*ENOENT:|\bcode:\s*['"]ENOENT['"])/.test(error.error ?? '')
        ),
    );
    const details =
      warnings?.map((error) => {
        const head = errorHead(error.error ?? '');
        return boundDiagnostics(head ? `${error.message} ${head}` : error.message);
      }) ?? [];
    let androidDiscoveryIncomplete = false;
    if (androidAvailable) {
      const avds = await run('emulator', ['-list-avds']);
      // Discovered devices stay listed; the AVDs that could not be listed are a warning.
      if (avds.code !== 0) {
        androidDiscoveryIncomplete = true;
        details.push(
          `Could not list Android virtual devices (emulator -list-avds, exit code ${avds.code}). Discovered devices remain available.`,
        );
      }
      for (const name of (avds.code === 0 ? avds.stdout : '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)) {
        if (!devices.some((device) => device.platform === 'android' && device.name === name)) {
          devices.push({ id: name, name, platform: 'android', version: 'Android', booted: false, physical: false });
        }
      }
    }
    const simulatorsUnlisted =
      hubList.simulators.length === 0 &&
      (hubList.errors ?? []).some((error) => SIMULATOR_LIST_FAILED.test(error.message));
    return {
      devices,
      detail: details.join('\n') || undefined,
      androidDiscoveryIncomplete,
      ...(simulatorsUnlisted ? { incompletePlatforms: ['ios'] as const } : {}),
    };
  };

  const boot: DeviceOperations['boot'] = async (device) => {
    const result = await hubJson(
      '/api/devices/boot',
      { platform: device.platform, id: device.id, name: device.name },
      HubActionResult,
      'boot',
      BOOT_TIMEOUT_MS,
    );
    if (!result.ok) {
      // Keep the hub's launch command and nested failure available to agents for recovery.
      const diagnostics = [result.error, ...(result.errors ?? []).flatMap((error) => [error.message, error.error])]
        .filter((text) => text?.trim())
        .join('\n\n');
      throw new DeviceBootError({
        hostId,
        deviceId: device.id,
        reason: /insufficient.*(?:disk|space)|not enough.*(?:disk|space)|no space left/i.test(diagnostics)
          ? 'disk_space'
          : /timed? out|timeout/i.test(diagnostics)
            ? 'timeout'
            : 'launch_failed',
        ...(diagnostics ? { diagnostics: boundDiagnostics(diagnostics) } : {}),
        cause: result,
      });
    }
    if (device.platform === 'ios') await attachIosStream(device.id);
    return result.serial ?? result.id ?? device.id;
  };

  const attach: DeviceOperations['attach'] = async (device) => {
    if (device.platform === 'ios') await attachIosStream(device.id);
  };

  const shutdown: DeviceOperations['shutdown'] = async (device) => {
    const postShutdown = async (path: string, body: Record<string, string>) => {
      const result = await hubJson(path, body, HubActionResult, 'shutdown');
      if (!result.ok) throw new DeviceOperationError({ operation: 'shutdown', reason: 'hub_rejected', cause: result });
    };
    // serve-sim's shutdown closes its in-process capture session before it
    // runs `simctl shutdown`; the hub's generic shutdown can leave that
    // session cached across a reboot. serve-sim runs simctl bare, though, so
    // a simulator that is already off fails there.
    if (device.platform === 'ios') {
      try {
        await postShutdown(`${vendorPrefix('ios')}/grid/api/shutdown`, { udid: device.id });
      } catch (cause) {
        const { devices } = await list();
        if (devices.find((candidate) => candidate.id === device.id)?.booted === false) {
          options.log?.info('iOS simulator was already shut down', { deviceId: device.id });
          return;
        }
        throw cause;
      }
      return;
    }
    await postShutdown('/api/devices/shutdown', { platform: device.platform, id: device.id });
  };

  const defaultDisplayScreenshot = async (udid: string) => {
    const capture = await run('sh', ['-c', DEFAULT_DISPLAY_SCREENSHOT, 'sh', udid], {
      timeoutMs: SCREENSHOT_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024 * 1024,
    });
    if (capture.code !== 0) {
      throw new DeviceOperationError({
        operation: 'screenshot',
        reason: 'command_failed',
        exitCode: capture.code,
        cause: capture.stderr.trim(),
      });
    }
    return new Uint8Array(Buffer.from(capture.stdout, 'base64'));
  };

  const screenshot: DeviceOperations['screenshot'] = async (device) => {
    try {
      return await withTimeout(SCREENSHOT_TIMEOUT_MS, async (signal) => {
        const url = `${origin}${vendorPrefix(device.platform)}/api/screenshot?device=${encodeURIComponent(device.id)}`;
        const response = await options.fetch(url, { method: 'POST', signal });
        if (!response.ok) {
          await response.arrayBuffer().catch(() => undefined);
          throw new HttpStatusError(url, response.status);
        }
        return new Uint8Array(await response.arrayBuffer());
      });
    } catch (cause) {
      const error = new DeviceOperationError({
        operation: 'screenshot',
        reason: cause instanceof HttpStatusError ? 'hub_rejected' : 'request_failed',
        cause,
      });
      if (device.platform === 'ios' && runsOnXcode26Runtime(device.version) && error.fields.reason === 'hub_rejected') {
        return defaultDisplayScreenshot(device.id);
      }
      throw error;
    }
  };

  return { list, boot, attach, shutdown, screenshot };
};
