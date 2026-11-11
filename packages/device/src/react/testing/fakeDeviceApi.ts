// Test double for the device API: no network, every method a mock.
import { vi } from "vitest";
import type { DeviceServiceState } from "../../contracts.ts";
import type { DeviceApi } from "../deviceApi.ts";

export function fakeDeviceApi(initial: DeviceServiceState | null) {
  let push: ((state: DeviceServiceState) => void) | null = null;
  const api = {
    basePath: "/api/device",
    resolveUrl: (path: string) => new URL(path, "http://test").toString(),
    getState: vi.fn<DeviceApi["getState"]>(() =>
      initial ? Promise.resolve(initial) : new Promise<DeviceServiceState>(() => {}),
    ),
    subscribeState: vi.fn<DeviceApi["subscribeState"]>((onState) => {
      push = onState;
      return () => {
        if (push === onState) push = null;
      };
    }),
    list: vi.fn<DeviceApi["list"]>(() => Promise.reject(new Error("list not stubbed"))),
    configure: vi.fn<DeviceApi["configure"]>(() =>
      Promise.reject(new Error("configure not stubbed")),
    ),
    open: vi.fn<DeviceApi["open"]>(() => Promise.reject(new Error("open not stubbed"))),
    close: vi.fn<DeviceApi["close"]>(() => Promise.reject(new Error("close not stubbed"))),
    shutdown: vi.fn<DeviceApi["shutdown"]>(() =>
      Promise.reject(new Error("shutdown not stubbed")),
    ),
    detail: vi.fn<DeviceApi["detail"]>(() => Promise.reject(new Error("detail not stubbed"))),
    action: vi.fn<DeviceApi["action"]>(() => Promise.reject(new Error("action not stubbed"))),
  } satisfies DeviceApi;
  return {
    api,
    /** Pushes a state as the SSE stream would. */
    push(state: DeviceServiceState) {
      push?.(state);
    },
  };
}
