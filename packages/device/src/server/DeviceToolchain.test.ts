import * as NodeFSP from 'node:fs/promises';
import * as NodePath from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { DEVICE_HUB_VERSION, deviceToolVersions, ensureDeviceHub, isDeviceHubInstalled } from './DeviceToolchain.ts';
import { processOutput, tempDir } from './testing.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it('failed installation cleans staging and exposes only a safe failure message', async () => {
  const { directory: baseDir, cleanup } = await tempDir('device-install-');
  cleanups.push(cleanup);
  const result = processOutput(1, '', 'registry rejected https://private:credential@example.test/package');
  const error = await ensureDeviceHub({ fs: NodeFSP, runner: { run: async () => result } }, baseDir).then(
    () => expect.unreachable(),
    (failure: Error) => failure,
  );
  expect(error.message).toBe('Installing expo-device-hub failed while running npm install (exit code 1).');
  expect(error.cause).toBe(result);
  expect(await isDeviceHubInstalled(NodeFSP, baseDir)).toBe(false);
  expect(await NodeFSP.readdir(NodePath.join(baseDir, 'tools', 'expo-device-hub'))).toEqual([]);
});

it('inventory reports only completed versions without installing the required version', async () => {
  const { directory: base, cleanup } = await tempDir('device-inventory-');
  cleanups.push(cleanup);
  for (const [version, sentinel] of [
    ['0.9.0', '0.9.0'],
    [DEVICE_HUB_VERSION, 'wrong'],
    ['.staging-123', '.staging-123'],
  ] as const) {
    const dir = NodePath.join(base, 'tools', 'expo-device-hub', version);
    await NodeFSP.mkdir(NodePath.join(dir, 'node_modules/expo-device-hub/dist/server'), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(dir, 'node_modules/expo-device-hub/dist/server/cli.mjs'), '');
    await NodeFSP.writeFile(NodePath.join(dir, '.install-complete'), sentinel);
  }
  const tools = await deviceToolVersions(NodeFSP, base);
  expect(tools?.hub).toEqual({
    requiredVersion: DEVICE_HUB_VERSION,
    installedVersions: ['0.9.0'],
    runningVersion: null,
  });
  expect(tools?.agent.installedVersions).toEqual([]);
  expect(await isDeviceHubInstalled(NodeFSP, base)).toBe(false);
});

it('unreadable inventory stays unknown instead of reporting no installs', async () => {
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
  const tools = await deviceToolVersions(
    {
      ...NodeFSP,
      readdir: (async () => {
        throw denied;
      }) as unknown as typeof NodeFSP.readdir,
    },
    '/unreadable',
  );
  expect(tools).toBeUndefined();
});
