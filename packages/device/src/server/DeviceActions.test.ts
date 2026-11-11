import * as NodeChildProcess from 'node:child_process';
import * as NodeUtil from 'node:util';

import { describe, expect, it } from 'vitest';

import { DeviceOperationError } from '../contracts.ts';
import { readDeviceDetail, runDeviceAction } from './DeviceActions.ts';
import type { DeviceHostReady } from './DeviceHost.ts';

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

type Call = { command: string; args: ReadonlyArray<string>; stdin?: string };

const makeReady = (
  respond: (call: Call) => { stdout?: string; stderr?: string; code?: number } = () => ({}),
  helpers: DeviceHostReady['helpers'] = {
    serveSimAxSettings: '/hub/simax/serve-sim-ax-settings',
    serveSimCli: '/hub/serve-sim.js',
  },
) => {
  const calls: Call[] = [];
  const unused = () => {
    throw new Error('Device actions run host commands, never device operations');
  };
  const ready: DeviceHostReady = {
    nodePath: process.execPath,
    hub: { origin: 'http://127.0.0.1:1' },
    devices: { list: unused, boot: unused, attach: unused, shutdown: unused, screenshot: unused },
    helpers,
    run: async (command, args, options) => {
      const call = { command, args, ...(options?.stdin ? { stdin: options.stdin } : {}) };
      calls.push(call);
      const result = respond(call);
      return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', code: result.code ?? 0 };
    },
  };
  return { ready, calls };
};

const udid = 'SIM-1';

describe('runDeviceAction', () => {
  it.skipIf(process.platform === 'win32').each([
    'https://example.com/callback?code=1&state=2',
    "https://example.com/it's?a=1&b=2",
    'https://example.com/a b?key=value',
    'https://example.com/plain',
  ])('opens the complete Android URL %s', async (url) => {
    const { ready, calls } = makeReady();
    await runDeviceAction(ready, 'android', { type: 'openUrl', deviceId: 'emulator-5554', url });
    const args = calls[0]!.args;
    expect(args.slice(0, 3)).toEqual(['-s', 'emulator-5554', 'shell']);
    // adb joins arguments verbatim before the Android shell parses them.
    const { stdout } = await execFile('/bin/sh', ['-c', `am() { printf '%s\\0' "$@"; }\n${args.slice(3).join(' ')}`]);
    expect(stdout.split('\0').slice(0, -1)).toEqual(['start', '-a', 'android.intent.action.VIEW', '-d', url]);
  });

  it.each([
    ['emulator-5554', 'Physical size: 2560x1600', 'portrait', '-9.81:0:0'],
    ['emulator-5554', 'Physical size: 2560x1600', 'landscape_left', '0:9.81:0'],
    ['R5CT1234', 'Physical size: 2560x1600', 'portrait', '3'],
    ['R5CT1234', 'Physical size: 2560x1600', 'landscape_left', '0'],
    ['R5CT1234', 'Physical size: 1080x1920\nOverride size: 1920x1080', 'portrait', '3'],
  ] as const)('rotates from the natural orientation reported by wm size: %s %j %s', async (deviceId, wmSize, value, expected) => {
    const { ready, calls } = makeReady((call) =>
      call.args.join(' ').endsWith('shell wm size') ? { stdout: `${wmSize}\n` } : {},
    );
    await runDeviceAction(ready, 'android', { type: 'setOrientation', deviceId, value });
    expect(calls.at(-1)?.args.at(-1)).toBe(expected);
  });

  it.each([
    ['camera', 'grant', 'android.permission.CAMERA'],
    ['photos', 'revoke', 'android.permission.READ_MEDIA_IMAGES'],
  ] as const)('reports an Android %s %s that no pm command applied', async (permission, decision, firstPermission) => {
    const { ready } = makeReady((call) => ({ code: 1, stderr: `Unknown package: ${call.args.at(-1)}` }));
    const error = await runDeviceAction(ready, 'android', {
      type: 'setPermission',
      deviceId: 'emulator-5554',
      appId: 'com.example.missing',
      permission,
      decision,
    }).then(
      () => expect.unreachable(),
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(DeviceOperationError);
    const operationError = error as DeviceOperationError;
    expect(operationError._tag).toBe('DeviceOperationError');
    expect(operationError.fields.operation).toBe('permission');
    expect(operationError.fields.cause).toMatchObject({ stderr: `Unknown package: ${firstPermission}` });
  });

  it.each([
    ['photos', ['android.permission.READ_MEDIA_IMAGES', 'android.permission.READ_EXTERNAL_STORAGE'], 1],
    ['contacts', ['android.permission.READ_CONTACTS', 'android.permission.WRITE_CONTACTS'], 0],
  ] as const)('keeps a partially applied %s permission change', async (permission, permissions, success) => {
    const { ready, calls } = makeReady((call) => ({ code: call.args.at(-1) === permissions[success] ? 0 : 1 }));
    const result = await runDeviceAction(ready, 'android', {
      type: 'setPermission',
      deviceId: 'emulator-5554',
      appId: 'com.example.app',
      permission,
      decision: 'grant',
    });
    expect(result).toBeUndefined();
    expect(calls.map((call) => call.args.at(-1))).toEqual(permissions);
  });
});

describe('readDeviceDetail', () => {
  it('reads the smallest iOS text size as small', async () => {
    const { ready } = makeReady((call) =>
      call.args.join(' ').endsWith('ui SIM-1 content_size') ? { stdout: 'extra-small\n' } : { code: 1 },
    );
    const detail = await readDeviceDetail(ready, 'ios', udid);
    expect(detail.settings.textSize).toBe('small');
  });

  it('reads iOS settings from simctl and the accessibility helper', async () => {
    const { ready } = makeReady((call) => {
      const key = call.args.join(' ');
      if (key.endsWith('ui SIM-1 appearance')) return { stdout: 'dark\n' };
      if (key.endsWith('ui SIM-1 content_size')) return { stdout: 'extra-extra-large\n' };
      if (key.endsWith('ui SIM-1 increase_contrast')) return { stdout: 'enabled\n' };
      if (key.includes('serve-sim-ax-settings status')) {
        return {
          stdout:
            '{"reduce-motion":"on","reduce-transparency":"off","show-borders":"off","voiceover":"off","liquid-glass":"tinted","color-filter":"grayscale"}',
        };
      }
      return { code: 1 };
    });
    const detail = await readDeviceDetail(ready, 'ios', udid);
    expect(detail.settings).toEqual({
      appearance: 'dark',
      textSize: 'large',
      increaseContrast: true,
      reduceMotion: true,
      reduceTransparency: false,
      showBorders: false,
      voiceOver: false,
      liquidGlass: 'tinted',
      colorFilter: 'grayscale',
    });
  });

  it('degrades unreadable values to unknown instead of failing', async () => {
    const { ready } = makeReady(() => ({ code: 1, stderr: 'boom' }));
    const detail = await readDeviceDetail(ready, 'ios', udid);
    expect(detail.settings).toEqual({});
    expect(detail.foregroundApp).toBeNull();
  });

  it('reads Android settings and the focused package', async () => {
    const { ready } = makeReady((call) => {
      const key = call.args.join(' ');
      if (key.endsWith('cmd uimode night')) return { stdout: 'Night mode: yes\n' };
      if (key.endsWith('font_scale')) return { stdout: '0.85\n' };
      if (key.endsWith('animator_duration_scale')) return { stdout: '0\n' };
      if (key.endsWith('wifi_on')) return { stdout: '1\n' };
      if (key.endsWith('dumpsys window')) {
        return {
          stdout:
            '  mFocusedApp=ActivityRecord{155579877 u0 com.example.app/.MainActivity t15}\n  mCurrentFocus=Window{1a2b u0 com.example.app/com.example.app.MainActivity}\n',
        };
      }
      return { code: 1 };
    });
    const detail = await readDeviceDetail(ready, 'android', 'emulator-5554');
    expect(detail.settings).toEqual({ appearance: 'dark', textSize: 'small', reduceMotion: true, networkEnabled: true });
    expect(detail.foregroundApp).toEqual({ id: 'com.example.app' });
  });
});
