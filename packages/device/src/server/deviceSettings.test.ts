import * as NodeFSP from 'node:fs/promises';

import { afterEach, expect, it } from 'vitest';

import { DEFAULT_DEVICE_SETTINGS, deviceSettingsPath, fileDeviceSettingsStore } from './deviceSettings.ts';
import { tempDir } from './testing.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it('persists device switches to a JSON file in the state dir and reads defaults without one', async () => {
  const { directory, cleanup } = await tempDir('device-settings-');
  cleanups.push(cleanup);
  const file = deviceSettingsPath(directory);
  const store = fileDeviceSettingsStore(NodeFSP, file);
  expect(await store.read()).toEqual(DEFAULT_DEVICE_SETTINGS);
  expect(await store.update({ enabled: true, agentAccessEnabled: undefined })).toEqual({
    ...DEFAULT_DEVICE_SETTINGS,
    enabled: true,
  });
  await store.update({ onboardingCompleted: true });
  expect(JSON.parse(await NodeFSP.readFile(file, 'utf8'))).toEqual({
    enabled: true,
    agentAccessEnabled: false,
    onboardingCompleted: true,
  });
  expect(await fileDeviceSettingsStore(NodeFSP, file).read()).toEqual({
    enabled: true,
    agentAccessEnabled: false,
    onboardingCompleted: true,
  });
  expect(await NodeFSP.readdir(`${directory}/device`)).toEqual(['settings.json']);
});
