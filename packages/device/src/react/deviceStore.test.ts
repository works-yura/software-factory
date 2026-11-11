import { describe, expect, it, vi } from "vitest";
import type { DeviceServiceState } from "../contracts.ts";
import { createDeviceStore } from "./deviceStore.tsx";
import { fakeDeviceApi } from "./testing/fakeDeviceApi.ts";

const state = (revision: number): DeviceServiceState => ({
  hosts: [],
  hostStatus: "ready",
  hostStatuses: {},
  devices: [],
  sessions: [],
  onboardingCompleted: true,
  agentAccessEnabled: false,
  hubBasePath: "/api/device/hub",
  revision,
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("device store", () => {
  it("keeps one state connection while any view retains it", async () => {
    const { api } = fakeDeviceApi(state(1));
    const store = createDeviceStore(api);
    const releaseA = store.retainState();
    const releaseB = store.retainState();
    await flush();
    expect(api.subscribeState).toHaveBeenCalledOnce();
    expect(store.getSnapshot().state?.revision).toBe(1);

    releaseA();
    // A view remounting in the same commit keeps the connection.
    releaseB();
    const releaseC = store.retainState();
    await flush();
    expect(api.subscribeState).toHaveBeenCalledOnce();
    releaseC();
    await flush();
    store.retainState();
    expect(api.subscribeState).toHaveBeenCalledTimes(2);
  });

  it("prefers pushed state over an older command answer", async () => {
    const fake = fakeDeviceApi(state(1));
    const store = createDeviceStore(fake.api);
    store.retainState();
    await flush();
    fake.push(state(5));
    fake.api.list.mockResolvedValueOnce(state(4));
    const result = await store.list({});
    expect(result).toEqual({ _tag: "Success", value: state(4) });
    expect(store.getSnapshot().state?.revision).toBe(5);
  });

  it("reports failed commands unless asked not to", async () => {
    const { api } = fakeDeviceApi(state(1));
    const onCommandError = vi.fn();
    const store = createDeviceStore(api, { onCommandError });
    api.configure.mockRejectedValue(new Error("Not allowed"));
    expect(await store.configure({ enabled: true })).toMatchObject({
      _tag: "Failure",
      message: "Not allowed",
    });
    await store.configure({ enabled: true }, { reportFailure: false });
    expect(onCommandError.mock.calls.map(([message]) => message)).toEqual(["Not allowed"]);
  });

  it("probes the hosts once however many views mount the probe", async () => {
    const { api } = fakeDeviceApi(state(1));
    api.list.mockResolvedValue(state(1));
    const store = createDeviceStore(api);
    const releaseA = store.mountHostProbe();
    const releaseB = store.mountHostProbe();
    releaseA();
    releaseB();
    await flush();
    expect(api.list).toHaveBeenCalledOnce();
    store.mountHostProbe();
    await flush();
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it("renews hub access as a new object for the same host path", async () => {
    vi.useFakeTimers();
    try {
      const { api } = fakeDeviceApi(state(1));
      const store = createDeviceStore(api);
      expect(store.hubAccess("local")).toBeNull();
      store.retainState();
      await vi.advanceTimersByTimeAsync(0);
      const access = store.hubAccess("local");
      expect(access?.httpBase).toBe("http://test/api/device/hub/local");
      expect(store.hubAccess("local")).toBe(access);
      vi.advanceTimersByTime(5_000);
      const renewed = await store.renewHubAccess("local");
      expect(renewed).not.toBe(access);
      expect(renewed).toEqual(access);
    } finally {
      vi.useRealTimers();
    }
  });
});
