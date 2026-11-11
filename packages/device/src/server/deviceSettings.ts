// t3code kept these three switches in its server settings (enableDeviceSupport,
// enableAgentDeviceAccess, deviceOnboardingCompleted); here they live in a JSON file in the state dir.
import * as NodePath from 'node:path';

import { z } from 'zod';

import { type DeviceFs, isNotFound, Semaphore, writeFileAtomically } from './runtime.ts';

export interface DeviceSettingsValues {
  /** Device support is on: tools may be installed and helpers started. */
  readonly enabled: boolean;
  /** Agents may drive devices through agent-device. */
  readonly agentAccessEnabled: boolean;
  readonly onboardingCompleted: boolean;
}

export const DEFAULT_DEVICE_SETTINGS: DeviceSettingsValues = {
  enabled: false,
  agentAccessEnabled: false,
  onboardingCompleted: false,
};

export interface DeviceSettingsStore {
  readonly read: () => Promise<DeviceSettingsValues>;
  readonly update: (patch: Partial<DeviceSettingsValues>) => Promise<DeviceSettingsValues>;
}

const StoredSettings = z
  .object({
    enabled: z.boolean().optional(),
    agentAccessEnabled: z.boolean().optional(),
    onboardingCompleted: z.boolean().optional(),
  })
  .loose();

const definedPatch = (patch: Partial<DeviceSettingsValues>) =>
  Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<DeviceSettingsValues>;

export const deviceSettingsPath = (stateDir: string) => NodePath.join(stateDir, 'device', 'settings.json');

/** Settings persisted to `file`; a missing file reads as the defaults. */
export const fileDeviceSettingsStore = (fs: DeviceFs, file: string): DeviceSettingsStore => {
  const lock = new Semaphore(1);
  const read = async (): Promise<DeviceSettingsValues> => {
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return DEFAULT_DEVICE_SETTINGS;
      throw error;
    }
    const stored = StoredSettings.parse(JSON.parse(raw));
    return {
      enabled: stored.enabled ?? DEFAULT_DEVICE_SETTINGS.enabled,
      agentAccessEnabled: stored.agentAccessEnabled ?? DEFAULT_DEVICE_SETTINGS.agentAccessEnabled,
      onboardingCompleted: stored.onboardingCompleted ?? DEFAULT_DEVICE_SETTINGS.onboardingCompleted,
    };
  };
  return {
    read: () => lock.withPermit(read),
    update: (patch) =>
      lock.withPermit(async () => {
        const next = { ...(await read()), ...definedPatch(patch) };
        await writeFileAtomically(fs, file, `${JSON.stringify(next, null, 2)}\n`);
        return next;
      }),
  };
};

/** Settings held in memory, for tests and embedders that persist them elsewhere. */
export const memoryDeviceSettingsStore = (initial: Partial<DeviceSettingsValues> = {}) => {
  let value: DeviceSettingsValues = { ...DEFAULT_DEVICE_SETTINGS, ...definedPatch(initial) };
  return {
    get value() {
      return value;
    },
    set value(next: DeviceSettingsValues) {
      value = next;
    },
    read: async () => value,
    update: async (patch: Partial<DeviceSettingsValues>) => {
      value = { ...value, ...definedPatch(patch) };
      return value;
    },
  } satisfies DeviceSettingsStore & { value: DeviceSettingsValues };
};
