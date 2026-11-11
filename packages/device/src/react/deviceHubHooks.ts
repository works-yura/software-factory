// Plain React replacement for t3code's deviceHubAtoms.ts: each hook reads the
// device hub while mounted and stops when unmounted or its target changes.
import { useEffect, useState } from "react";
import type { DeviceHubAccess } from "../client/hubAccess.ts";
import type { DevicePlatform } from "../contracts.ts";
import {
  appendDeviceEventLog,
  type DeviceAxElement,
  type DeviceEventLogEntry,
  type DeviceForegroundInfo,
  fetchDeviceAxTree,
  subscribeDeviceEventLog,
  subscribeDeviceForeground,
} from "./deviceHubApi.ts";
import { isAndroidFoldError, readAndroidFold, type AndroidFoldState } from "./deviceFold.ts";
import { useDeviceStore, useDeviceStoreValue, type AndroidFoldView } from "./deviceStore.tsx";

export type { AndroidFoldView } from "./deviceStore.tsx";

const AX_POLL_INTERVAL_MS = 2_000;
const FOLD_RETRY_MS = 3_000;

const NO_AX_ELEMENTS: ReadonlyArray<DeviceAxElement> = [];
const NO_EVENTS: ReadonlyArray<DeviceEventLogEntry> = [];

interface HubTargetInput {
  readonly access: DeviceHubAccess;
  readonly platform: DevicePlatform;
  readonly deviceId: string;
}

/** `undefined` until the hub reports an app; the device detail's app fills in until then. */
export function useDeviceForeground(
  target: HubTargetInput | null,
): DeviceForegroundInfo | null | undefined {
  const [value, setValue] = useState<{
    readonly target: HubTargetInput | null;
    readonly app: DeviceForegroundInfo | null | undefined;
  }>({ target: null, app: undefined });
  const access = target?.access;
  const platform = target?.platform;
  const deviceId = target?.deviceId;
  // subscribes to the hub's foreground app events for the mounted target
  useEffect(() => {
    if (!access || !platform || !deviceId) return;
    const current = { access, platform, deviceId };
    return subscribeDeviceForeground(current, (app) => setValue({ target: current, app }));
  }, [access, platform, deviceId]);
  const same =
    value.target?.access === access &&
    value.target?.platform === platform &&
    value.target?.deviceId === deviceId;
  return target && same ? value.app : undefined;
}

export function useDeviceEventLog(target: HubTargetInput): ReadonlyArray<DeviceEventLogEntry> {
  const [entries, setEntries] = useState(NO_EVENTS);
  const { access, platform, deviceId } = target;
  // streams the hub's event log for the mounted target
  useEffect(() => {
    let current = NO_EVENTS;
    setEntries(NO_EVENTS);
    return subscribeDeviceEventLog({ access, platform, deviceId }, (incoming, reset) => {
      current = appendDeviceEventLog(current, incoming, reset);
      setEntries(current);
    });
  }, [access, platform, deviceId]);
  return entries;
}

/** Polls the accessibility tree; a failed poll keeps the last frames on screen. */
export function useDeviceAxElements(target: HubTargetInput | null): ReadonlyArray<DeviceAxElement> {
  const [elements, setElements] = useState(NO_AX_ELEMENTS);
  const access = target?.access;
  const platform = target?.platform;
  const deviceId = target?.deviceId;
  // polls the hub's accessibility tree while the overlay is on
  useEffect(() => {
    setElements(NO_AX_ELEMENTS);
    if (!access || !platform || !deviceId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      fetchDeviceAxTree({ access, platform, deviceId }, controller.signal)
        .then((tree) => {
          if (!controller.signal.aborted) setElements(tree.elements);
        })
        .catch(() => {})
        .finally(() => {
          if (!controller.signal.aborted) timer = setTimeout(poll, AX_POLL_INTERVAL_MS);
        });
    };
    poll();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [access, platform, deviceId]);
  return elements;
}

export const foldAngle = (fold: AndroidFoldState) =>
  fold.hingeAngle ?? (fold.posture === "closed" ? 0 : 180);

/** The fold view shared by the fold controls and the 3D phone, keyed by host and device. */
export function useAndroidFoldView(deviceKey: string): AndroidFoldView {
  return useDeviceStoreValue((store) => store.getFold(deviceKey));
}

/**
 * Reads the fold while mounted and records it in the device's fold view. The
 * screen size is part of the key because folding resizes the screen, so a new
 * size means the posture may have changed. An expired session stops retrying:
 * renewed access is a new key and reads again.
 */
export function useAndroidFoldRead(
  input: {
    readonly deviceKey: string;
    readonly access: DeviceHubAccess;
    readonly deviceId: string;
    readonly screenWidth: number;
    readonly screenHeight: number;
  } | null,
): void {
  const store = useDeviceStore();
  const deviceKey = input?.deviceKey;
  const access = input?.access;
  const deviceId = input?.deviceId;
  const screenWidth = input?.screenWidth;
  const screenHeight = input?.screenHeight;
  useEffect(() => {
    if (!deviceKey || !access || !deviceId || !screenWidth || !screenHeight) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      readAndroidFold(access, deviceId, controller.signal).then(
        (fold) => {
          if (controller.signal.aborted) return;
          store.setFold(deviceKey, { fold, angle: fold.supported ? foldAngle(fold) : null });
        },
        (cause: unknown) => {
          if (controller.signal.aborted) return;
          if (isAndroidFoldError(cause) && cause.status === 401) return;
          timer = setTimeout(read, FOLD_RETRY_MS);
        },
      );
    };
    read();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [store, deviceKey, access, deviceId, screenWidth, screenHeight]);
}
