import type { DeviceDetail, DeviceSummary } from "../contracts.ts";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, it } from "vitest";

import { createDeviceStore, DeviceProvider } from "./deviceStore.tsx";
import { fakeDeviceApi } from "./testing/fakeDeviceApi.ts";
import { useDeviceControls, type DeviceControls } from "./useDeviceControls.ts";

const offline = new Error("Device offline");
const device: DeviceSummary = {
  hostId: "remote",
  id: "phone",
  name: "Phone",
  platform: "ios",
  version: "iOS",
  booted: true,
  physical: false,
};
const snapshot = (appearance: "light" | "dark"): DeviceDetail => ({
  hostId: "remote",
  deviceId: "phone",
  settings: { appearance },
  foregroundApp: null,
  readAt: "2026-09-20T00:00:00Z",
});
function deferred() {
  let resolve!: (value: DeviceDetail) => void;
  const promise = new Promise<DeviceDetail>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let controls: DeviceControls;
function Probe({ visible }: { visible: boolean }) {
  const next = useDeviceControls({ device, access: null, visible });
  useEffect(() => {
    controls = next;
  }, [next]);
  return null;
}
function setup() {
  const { api } = fakeDeviceApi(null);
  const read = api.detail;
  const action = api.action;
  read.mockResolvedValue(snapshot("light"));
  // The real store decides ordering: reads and actions share one serial lane.
  const store = createDeviceStore(api);
  const view = (visible: boolean) => (
    <DeviceProvider store={store}>
      <Probe visible={visible} />
    </DeviceProvider>
  );
  const screen = render(view(true));
  const hide = () => screen.rerender(view(false));
  const show = () => screen.rerender(view(true));
  return { read, action, hide, show };
}

afterEach(cleanup);

it("serializes rapid actions and retains confirmed settings while pending or after failure", async () => {
  const { action } = setup();
  await waitFor(() => expect(controls.detail?.settings.appearance).toBe("light"));
  const response = deferred();
  action.mockReturnValueOnce(response.promise);
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = controls.act({ type: "setAppearance", value: "dark" });
    expect(await controls.act({ type: "setAppearance", value: "light" })).toBe(false);
  });
  expect(action).toHaveBeenCalledOnce();
  expect(controls.disabled).toBe(true);
  expect(controls.detail?.settings.appearance).toBe("light");
  await act(async () => {
    response.resolve(snapshot("dark"));
    expect(await pending).toBe(true);
  });
  expect(controls.detail?.settings.appearance).toBe("dark");
  action.mockRejectedValueOnce(offline);
  await act(async () => {
    expect(await controls.act({ type: "setAppearance", value: "light" })).toBe(false);
  });
  expect(controls.detail?.settings.appearance).toBe("dark");
  expect(controls.error).toBe("Device offline");
  expect(controls.disabled).toBe(false);
});

it("confirms settings again after a command sent before the panel reopened", async () => {
  const { read, action, hide, show } = setup();
  await waitFor(() => expect(controls.detail).not.toBeNull());
  const response = deferred();
  action.mockReturnValueOnce(response.promise);
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = controls.act({ type: "setAppearance", value: "dark" });
  });
  hide();
  read.mockRejectedValueOnce(offline);
  show();
  await act(async () => {
    response.resolve(snapshot("dark"));
    await pending;
  });
  await waitFor(() => expect(controls.error).toBe("Device offline"));
  expect(controls.detail).toBeNull();
  expect(controls.disabled).toBe(true);
  await act(async () => controls.act({ type: "setAppearance", value: "light" }));
  expect(action).toHaveBeenCalledOnce();
  hide();
  show();
  await waitFor(() => expect(controls.disabled).toBe(false));
  expect(controls.error).toBeNull();
});

it("does not let a read sent before an action overwrite the action's answer", async () => {
  const { read, action, hide, show } = setup();
  await waitFor(() => expect(controls.detail).not.toBeNull());
  hide();
  const refresh = deferred();
  read.mockReturnValueOnce(refresh.promise);
  show();
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  action.mockResolvedValueOnce(snapshot("dark"));
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = controls.act({ type: "setAppearance", value: "dark" });
  });
  await act(async () => {
    refresh.resolve(snapshot("light"));
    await pending;
  });
  expect(controls.detail?.settings.appearance).toBe("dark");
});
