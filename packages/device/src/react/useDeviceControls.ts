import type { DeviceHubAccess } from "../client/hubAccess.ts";
import type { DeviceActionInput, DeviceSummary } from "../contracts.ts";
import { useEffect, useRef, useState } from "react";
import { useDeviceForeground } from "./deviceHubHooks.ts";
import { useDeviceStore, useDeviceStoreValue } from "./deviceStore.tsx";

type ActionBody = DeviceActionInput extends infer A
  ? A extends { readonly type: string }
    ? Omit<A, "hostId" | "deviceId">
    : never
  : never;

/** Mount keyed by device. */
export function useDeviceControls(options: {
  device: DeviceSummary;
  access: DeviceHubAccess | null;
  visible: boolean;
}) {
  const { device, access, visible } = options;
  const store = useDeviceStore();
  const { hostId, id: deviceId } = device;
  const { detail, error } = useDeviceStoreValue((current) => current.getDetail(hostId, deviceId));
  // Reads the device's settings each time the controls become visible. Reads and
  // actions share one serial lane, so a read never answers before an action that
  // was sent ahead of it.
  useEffect(() => {
    if (visible) void store.readDetail(hostId, deviceId);
  }, [store, visible, hostId, deviceId]);
  const foreground = useDeviceForeground(
    access && visible ? { access, platform: device.platform, deviceId } : null,
  );
  const [pending, setPending] = useState(false);
  // Hiding does not cancel host commands, so actions stay serialized until settlement
  // rather than letting a reopened panel race the previous command.
  const busy = useRef(false);

  const available = detail !== null && visible;
  const act = async (body: ActionBody) => {
    if (busy.current || !available) return false;
    busy.current = true;
    setPending(true);
    store.setDetail(hostId, deviceId, (current) => ({ ...current, error: null }));
    return store
      .action({ hostId, deviceId, ...body } as DeviceActionInput, { reportFailure: false })
      .then((result) => {
        store.setDetail(hostId, deviceId, (current) =>
          result._tag === "Success"
            ? { detail: result.value, error: null }
            : { ...current, error: result.message },
        );
        return result._tag === "Success";
      })
      .finally(() => {
        busy.current = false;
        setPending(false);
      });
  };

  return {
    detail,
    pending,
    error,
    act,
    disabled: pending || !detail || !visible,
    foregroundApp: foreground === undefined ? (detail?.foregroundApp ?? null) : foreground,
  };
}

export type DeviceControls = ReturnType<typeof useDeviceControls>;
