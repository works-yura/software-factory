// serve-sim's preview socket accepts shell commands; use typed actions to avoid arbitrary host execution.
import {
  type DeviceActionInput,
  type DeviceActionType,
  DeviceActionUnavailableError,
  type DeviceForegroundApp,
  DeviceOperationError,
  type DeviceOrientation,
  type DevicePlatform,
  type DeviceSettings,
  type DeviceTextSize,
} from '../contracts.ts';
import type { DeviceHostReady, DeviceHostRunResult } from './DeviceHost.ts';

type Runner = DeviceHostReady['run'];

const decodeAxStatus = (raw: string): Record<string, string> => {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected an object');
  for (const entry of Object.values(value)) if (typeof entry !== 'string') throw new Error('Expected string values');
  return value as Record<string, string>;
};

const IOS_ACTIONS: ReadonlySet<DeviceActionType> = new Set([
  'setAppearance',
  'setTextSize',
  'setToggle',
  'setLiquidGlass',
  'setColorFilter',
  'setLocation',
  'clearLocation',
  'setPermission',
  'openUrl',
  'launchApp',
  'terminateApp',
  'sendPush',
]);

const ANDROID_ACTIONS: ReadonlySet<DeviceActionType> = new Set([
  'setAppearance',
  'setTextSize',
  'setToggle',
  'setOrientation',
  'setLocation',
  'clearLocation',
  'setPermission',
  'openUrl',
  'launchApp',
  'terminateApp',
]);

const IOS_TOGGLES = new Set(['reduceMotion', 'increaseContrast', 'reduceTransparency', 'showBorders', 'voiceOver']);
const ANDROID_TOGGLES = new Set(['reduceMotion', 'networkEnabled']);

const supportsAction = (platform: DevicePlatform, input: DeviceActionInput): boolean => {
  const actions = platform === 'ios' ? IOS_ACTIONS : ANDROID_ACTIONS;
  if (!actions.has(input.type)) return false;
  if (input.type === 'setToggle') {
    return (platform === 'ios' ? IOS_TOGGLES : ANDROID_TOGGLES).has(input.setting);
  }
  return true;
};

const ok = (operation: string) => (result: DeviceHostRunResult) => {
  if (result.code === 0) return result.stdout;
  throw new DeviceOperationError({ operation, reason: 'command_failed', exitCode: result.code, cause: result });
};

const IOS_TEXT_SIZES: Record<DeviceTextSize, string> = {
  small: 'small',
  default: 'large',
  large: 'extra-extra-large',
  'extra-large': 'accessibility-large',
};
const ANDROID_TEXT_SIZES: Record<DeviceTextSize, string> = {
  small: '0.85',
  default: '1.0',
  large: '1.15',
  'extra-large': '1.3',
};

const textSizeFromIos = (category: string): DeviceTextSize | undefined => {
  const entry = (Object.entries(IOS_TEXT_SIZES) as Array<[DeviceTextSize, string]>).find(
    ([, value]) => value === category,
  );
  if (entry) return entry[0];
  if (category.startsWith('accessibility')) return 'extra-large';
  if (category === 'extra-small' || category === 'small' || category === 'medium') return 'small';
  return category.includes('extra') ? 'large' : 'default';
};

const textSizeFromAndroid = (scale: number): DeviceTextSize => {
  if (scale <= 0.9) return 'small';
  if (scale >= 1.25) return 'extra-large';
  if (scale >= 1.1) return 'large';
  return 'default';
};

const IOS_TOGGLE_OPTIONS: Record<string, string> = {
  reduceMotion: 'reduce-motion',
  increaseContrast: 'increase-contrast',
  reduceTransparency: 'reduce-transparency',
  showBorders: 'show-borders',
  voiceOver: 'voiceover',
};

const IOS_TCC_SERVICES: Record<string, string> = {
  camera: 'camera',
  microphone: 'microphone',
  photos: 'photos',
  contacts: 'contacts',
  calendar: 'calendar',
  reminders: 'reminders',
  motion: 'motion',
  'media-library': 'media-library',
  faceid: 'faceid',
};

const ANDROID_PERMISSIONS: Record<string, ReadonlyArray<string>> = {
  camera: ['android.permission.CAMERA'],
  microphone: ['android.permission.RECORD_AUDIO'],
  photos: ['android.permission.READ_MEDIA_IMAGES', 'android.permission.READ_EXTERNAL_STORAGE'],
  contacts: ['android.permission.READ_CONTACTS', 'android.permission.WRITE_CONTACTS'],
  calendar: ['android.permission.READ_CALENDAR', 'android.permission.WRITE_CALENDAR'],
  location: ['android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION'],
  notifications: ['android.permission.POST_NOTIFICATIONS'],
  motion: ['android.permission.ACTIVITY_RECOGNITION'],
};

// Android numbers rotations from the display's natural orientation and the emulator's accelerometer
// reports gravity in that same frame, so both tables are keyed by the orientation a portrait-native
// device shows at each rotation.
const ANDROID_GRAVITY: Record<DeviceOrientation, string> = {
  portrait: '0:9.81:0',
  landscape_left: '9.81:0:0',
  portrait_upside_down: '0:-9.81:0',
  landscape_right: '-9.81:0:0',
};
const ANDROID_ROTATION: Record<DeviceOrientation, string> = {
  portrait: '0',
  landscape_left: '1',
  portrait_upside_down: '2',
  landscape_right: '3',
};
// A landscape-native tablet sits a quarter turn further along that sequence: its portrait is
// rotation 3 and its landscape is rotation 0.
const ANDROID_LANDSCAPE_NATIVE_ROTATION: Record<DeviceOrientation, DeviceOrientation> = {
  portrait: 'landscape_right',
  landscape_left: 'portrait',
  portrait_upside_down: 'landscape_left',
  landscape_right: 'portrait_upside_down',
};

// `wm size` reports the natural-orientation size; an `Override size:` line is what the window
// manager uses and is printed after `Physical size:`.
const isLandscapeNative = (wmSize: string | undefined) => {
  const size = wmSize ? [...wmSize.matchAll(/size: (\d+)x(\d+)/g)].at(-1) : undefined;
  return size !== undefined && Number(size[1]) > Number(size[2]);
};

/** Rejects with `DeviceActionUnavailableError` or `DeviceOperationError`. */
export const runDeviceAction = async (
  ready: DeviceHostReady,
  platform: DevicePlatform,
  input: DeviceActionInput,
): Promise<void> => {
  if (!supportsAction(platform, input)) {
    throw new DeviceActionUnavailableError({ operation: input.type, platform, reason: 'unsupported' });
  }
  if (platform === 'ios') return runIos(ready, input);
  return runAndroid(ready.run, input);
};

const simctl = async (run: Runner, udid: string, args: ReadonlyArray<string>, operation: string) =>
  ok(operation)(await run('xcrun', ['simctl', ...args.slice(0, 1), udid, ...args.slice(1)]));

const axSettings = async (ready: DeviceHostReady, udid: string, args: ReadonlyArray<string>) => {
  const helper = ready.helpers.serveSimAxSettings;
  if (!helper) {
    throw new DeviceActionUnavailableError({ operation: 'accessibility', platform: 'ios', reason: 'helper_missing' });
  }
  return ok('accessibility')(await ready.run('xcrun', ['simctl', 'spawn', udid, helper, ...args]));
};

const runIos = async (ready: DeviceHostReady, input: DeviceActionInput): Promise<void> => {
  const udid = input.deviceId;
  const { run } = ready;
  switch (input.type) {
    case 'setAppearance':
      await simctl(run, udid, ['ui', 'appearance', input.value], 'appearance');
      return;
    case 'setTextSize':
      await simctl(run, udid, ['ui', 'content_size', IOS_TEXT_SIZES[input.value]], 'text size');
      return;
    case 'setToggle':
      if (input.setting === 'increaseContrast') {
        await simctl(run, udid, ['ui', 'increase_contrast', input.value ? 'enabled' : 'disabled'], 'increase contrast');
        return;
      }
      await axSettings(ready, udid, ['set', IOS_TOGGLE_OPTIONS[input.setting]!, input.value ? 'on' : 'off']);
      return;
    case 'setLiquidGlass':
      await axSettings(ready, udid, ['set', 'liquid-glass', input.value]);
      return;
    case 'setColorFilter':
      await axSettings(ready, udid, ['set', 'color-filter', input.value]);
      return;
    case 'setLocation':
      await simctl(run, udid, ['location', 'set', `${input.latitude},${input.longitude}`], 'location');
      return;
    case 'clearLocation':
      await simctl(run, udid, ['location', 'clear'], 'location');
      return;
    case 'setPermission': {
      if (input.permission === 'notifications') {
        // simctl lacks notification permissions; serve-sim edits the BulletinBoard plist.
        await serveSimPermissions(ready, udid, input);
        return;
      }
      const service = input.permission === 'location' ? 'location' : IOS_TCC_SERVICES[input.permission];
      if (!service) {
        throw new DeviceActionUnavailableError({ operation: 'permission', platform: 'ios', reason: 'unsupported' });
      }
      await simctl(run, udid, ['privacy', input.decision, service, input.appId], 'permission');
      return;
    }
    case 'openUrl':
      await simctl(run, udid, ['openurl', input.url], 'open url');
      return;
    case 'launchApp':
      await simctl(run, udid, ['launch', input.appId], 'launch');
      return;
    case 'terminateApp':
      await simctl(run, udid, ['terminate', input.appId], 'terminate');
      return;
    case 'sendPush': {
      const payload = typeof input.payload === 'string' ? { aps: { alert: input.payload } } : input.payload;
      let encoded: string;
      try {
        encoded = JSON.stringify(payload);
      } catch (cause) {
        throw new DeviceOperationError({ operation: 'push', reason: 'invalid_payload', cause });
      }
      ok('push')(await run('xcrun', ['simctl', 'push', udid, input.appId, '-'], { stdin: encoded }));
      return;
    }
    case 'shake':
    case 'setOrientation':
      throw new DeviceActionUnavailableError({ operation: input.type, platform: 'ios', reason: 'unsupported' });
  }
};

const serveSimPermissions = async (
  ready: DeviceHostReady,
  udid: string,
  input: Extract<DeviceActionInput, { type: 'setPermission' }>,
) => {
  const cli = ready.helpers.serveSimCli;
  if (!cli) {
    throw new DeviceActionUnavailableError({ operation: 'permission', platform: 'ios', reason: 'helper_missing' });
  }
  ok('permission')(
    await ready.run(ready.nodePath, [cli, 'permissions', input.decision, input.permission, input.appId, '-d', udid]),
  );
};

const adb = async (run: Runner, serial: string, args: ReadonlyArray<string>, operation: string) =>
  ok(operation)(await run('adb', ['-s', serial, ...args]));

// adb shell joins arguments without escaping before the device's shell parses them.
const androidShellWord = (value: string) =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

const quiet = <A>(promise: Promise<A>): Promise<A | undefined> => promise.catch(() => undefined);

const runAndroid = async (run: Runner, input: DeviceActionInput): Promise<void> => {
  const serial = input.deviceId;
  const shell = (args: ReadonlyArray<string>, operation: string) =>
    adb(run, serial, ['shell', ...args.map(androidShellWord)], operation);
  switch (input.type) {
    case 'setAppearance':
      await shell(['cmd', 'uimode', 'night', input.value === 'dark' ? 'yes' : 'no'], 'appearance');
      return;
    case 'setTextSize':
      await shell(['settings', 'put', 'system', 'font_scale', ANDROID_TEXT_SIZES[input.value]], 'text size');
      return;
    case 'setToggle':
      if (input.setting === 'networkEnabled') {
        const state = input.value ? 'enable' : 'disable';
        await shell(['svc', 'wifi', state], 'network');
        await shell(['svc', 'data', state], 'network');
        return;
      }
      if (input.setting === 'reduceMotion') {
        const scale = input.value ? '0' : '1';
        for (const key of ['animator_duration_scale', 'transition_animation_scale', 'window_animation_scale']) {
          await shell(['settings', 'put', 'global', key, scale], 'reduce motion');
        }
        return;
      }
      throw new DeviceActionUnavailableError({ operation: input.type, platform: 'android', reason: 'unsupported' });
    case 'setOrientation': {
      const wmSize = await quiet(shell(['wm', 'size'], 'orientation'));
      const rotation = isLandscapeNative(wmSize) ? ANDROID_LANDSCAPE_NATIVE_ROTATION[input.value] : input.value;
      // `user-rotation lock` only rotates window content on recent images; the display the
      // encoder captures stays put. Tilting the emulator's accelerometer rotates it for real, so
      // that is used whenever the target is an emulator.
      if (serial.startsWith('emulator-')) {
        await shell(['settings', 'put', 'system', 'accelerometer_rotation', '1'], 'orientation');
        await shell(['cmd', 'window', 'user-rotation', 'free'], 'orientation');
        await adb(run, serial, ['emu', 'sensor', 'set', 'acceleration', ANDROID_GRAVITY[rotation]], 'orientation');
        return;
      }
      await shell(['cmd', 'window', 'user-rotation', 'lock', ANDROID_ROTATION[rotation]], 'orientation');
      return;
    }
    case 'setLocation':
      await adb(run, serial, ['emu', 'geo', 'fix', String(input.longitude), String(input.latitude)], 'location');
      return;
    case 'clearLocation':
      // The emulator cannot clear location; keep the fix and refresh the reading.
      return;
    case 'setPermission': {
      const permissions = ANDROID_PERMISSIONS[input.permission];
      if (!permissions) {
        throw new DeviceActionUnavailableError({ operation: 'permission', platform: 'android', reason: 'unsupported' });
      }
      const verb = input.decision === 'grant' ? 'grant' : 'revoke';
      // `pm` rejects a permission the app or system image does not declare, and Photos lists both
      // the Android 13 and the older storage permission, so fail only when none of them applied.
      const results: Array<{ ok: true } | { ok: false; error: unknown }> = [];
      for (const permission of permissions) {
        results.push(
          await shell(['pm', verb, input.appId, permission], 'permission').then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          ),
        );
      }
      const failure = results.find((result) => !result.ok);
      if (failure && !failure.ok && !results.some((result) => result.ok)) throw failure.error;
      return;
    }
    case 'openUrl':
      await shell(['am', 'start', '-a', 'android.intent.action.VIEW', '-d', input.url], 'open url');
      return;
    case 'launchApp':
      await shell(['monkey', '-p', input.appId, '-c', 'android.intent.category.LAUNCHER', '1'], 'launch');
      return;
    case 'terminateApp':
      await shell(['am', 'force-stop', input.appId], 'terminate');
      return;
    case 'setLiquidGlass':
    case 'setColorFilter':
    case 'shake':
    case 'sendPush':
      throw new DeviceActionUnavailableError({ operation: input.type, platform: 'android', reason: 'unsupported' });
  }
};

export const readDeviceDetail = (
  ready: DeviceHostReady,
  platform: DevicePlatform,
  deviceId: string,
): Promise<{ settings: DeviceSettings; foregroundApp: DeviceForegroundApp | null }> =>
  platform === 'ios' ? readIos(ready, deviceId) : readAndroid(ready.run, deviceId);

const readIos = async (ready: DeviceHostReady, udid: string) => {
  const { run } = ready;
  const uiValue = (option: string) =>
    quiet(simctl(run, udid, ['ui', option], option).then((out) => out.trim().toLowerCase()));
  const [appearance, contentSize, contrast, axStatus] = await Promise.all([
    uiValue('appearance'),
    uiValue('content_size'),
    uiValue('increase_contrast'),
    quiet(axSettings(ready, udid, ['status']).then(decodeAxStatus)),
  ]);
  const onOff = (value: string | undefined) => (value === 'on' ? true : value === 'off' ? false : undefined);
  const settings: DeviceSettings = {
    ...(appearance === 'light' || appearance === 'dark' ? { appearance } : {}),
    ...(contentSize ? { textSize: textSizeFromIos(contentSize) } : {}),
    ...(contrast ? { increaseContrast: contrast === 'enabled' } : {}),
    ...(axStatus
      ? {
          ...(onOff(axStatus['reduce-motion']) === undefined ? {} : { reduceMotion: onOff(axStatus['reduce-motion']) }),
          ...(onOff(axStatus['reduce-transparency']) === undefined
            ? {}
            : { reduceTransparency: onOff(axStatus['reduce-transparency']) }),
          ...(onOff(axStatus['show-borders']) === undefined ? {} : { showBorders: onOff(axStatus['show-borders']) }),
          ...(onOff(axStatus.voiceover) === undefined ? {} : { voiceOver: onOff(axStatus.voiceover) }),
          ...(axStatus['liquid-glass'] === 'clear' || axStatus['liquid-glass'] === 'tinted'
            ? { liquidGlass: axStatus['liquid-glass'] }
            : {}),
          ...(isColorFilter(axStatus['color-filter']) ? { colorFilter: axStatus['color-filter'] } : {}),
        }
      : {}),
  };
  return { settings, foregroundApp: null };
};

const isColorFilter = (value: unknown): value is NonNullable<DeviceSettings['colorFilter']> =>
  value === 'none' || value === 'grayscale' || value === 'red-green' || value === 'green-red' || value === 'blue-yellow';

const readAndroid = async (run: Runner, serial: string) => {
  const shell = (args: ReadonlyArray<string>) =>
    quiet(adb(run, serial, ['shell', ...args], args[0] ?? 'shell').then((s) => s.trim()));
  const [night, fontScale, animator, wifi, focus] = await Promise.all([
    shell(['cmd', 'uimode', 'night']),
    shell(['settings', 'get', 'system', 'font_scale']),
    shell(['settings', 'get', 'global', 'animator_duration_scale']),
    shell(['settings', 'get', 'global', 'wifi_on']),
    // API 36 dropped focus from `dumpsys window windows`; use the unfiltered dump.
    shell(['dumpsys', 'window']),
  ]);
  const scale = fontScale && fontScale !== 'null' ? Number(fontScale) : Number.NaN;
  const focused = focus?.match(/m(?:CurrentFocus|FocusedApp)=\w+\{[^ ]+ u\d+ ([^/ ]+)\//);
  const settings: DeviceSettings = {
    ...(night?.includes('yes') ? { appearance: 'dark' } : night?.includes('no') ? { appearance: 'light' } : {}),
    ...(Number.isFinite(scale) ? { textSize: textSizeFromAndroid(scale) } : {}),
    ...(animator !== undefined && animator !== 'null' ? { reduceMotion: Number(animator) === 0 } : {}),
    ...(wifi === '1' || wifi === '0' ? { networkEnabled: wifi === '1' } : {}),
  };
  return {
    settings,
    foregroundApp: focused ? { id: focused[1]! } : null,
  };
};
