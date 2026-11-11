import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceDetail, DeviceServiceState } from "../contracts.ts";
import { createDeviceApi, DeviceApiError, deviceHubAccess } from "./deviceApi.ts";

const state: DeviceServiceState = {
  hosts: [],
  hostStatus: "ready",
  hostStatuses: {},
  devices: [],
  sessions: [],
  onboardingCompleted: true,
  agentAccessEnabled: false,
  hubBasePath: "/api/device/hub",
  revision: 3,
};
const detail: DeviceDetail = {
  hostId: "local",
  deviceId: "phone",
  settings: { appearance: "dark" },
  foregroundApp: null,
  readAt: "2026-01-01T00:00:00Z",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.restoreAllMocks());

describe("device API client", () => {
  it("reads state and posts commands under the base path", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(state))
      .mockResolvedValueOnce(json(detail));
    const api = createDeviceApi({ basePath: "/api/device/", baseUrl: "https://app.test", fetch });

    expect(await api.getState()).toEqual(state);
    expect(
      await api.action({ hostId: "local", deviceId: "phone", type: "setAppearance", value: "dark" }),
    ).toEqual(detail);

    expect(fetch.mock.calls[0]?.[0]).toBe("https://app.test/api/device/state");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin" });
    const [url, init] = fetch.mock.calls[1]!;
    expect(url).toBe("https://app.test/api/device/action");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(JSON.parse(String(init?.body))).toEqual({
      hostId: "local",
      deviceId: "phone",
      type: "setAppearance",
      value: "dark",
    });
  });

  it("raises the server's tagged error and rejects malformed answers", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ _tag: "DeviceNotFoundError", message: "No such device" }, 404))
      .mockResolvedValueOnce(json({ hosts: "nope" }))
      .mockResolvedValueOnce(new Response("oops", { status: 502 }));
    const api = createDeviceApi({ baseUrl: "https://app.test", fetch });
    const input = { hostId: "local", deviceId: "phone" };

    const notFound = await api.detail(input).catch((cause: unknown) => cause);
    expect(notFound).toBeInstanceOf(DeviceApiError);
    expect(notFound).toMatchObject({ _tag: "DeviceNotFoundError", message: "No such device", status: 404 });
    await expect(api.list({})).rejects.toMatchObject({ _tag: "DeviceResponseError" });
    await expect(api.detail(input)).rejects.toMatchObject({ _tag: "DeviceHttpError", status: 502 });
  });

  it("streams state events and closes the source on unsubscribe", () => {
    const sources: FakeEventSource[] = [];
    class FakeEventSource {
      readonly listeners = new Map<string, (event: { data?: string }) => void>();
      readonly close = vi.fn();
      readonly url: string;
      constructor(url: string) {
        this.url = url;
        sources.push(this);
      }
      addEventListener(type: string, listener: (event: { data?: string }) => void) {
        this.listeners.set(type, listener);
      }
    }
    const api = createDeviceApi({
      baseUrl: "https://app.test",
      EventSource: FakeEventSource as unknown as typeof EventSource,
    });
    const onState = vi.fn();
    const onError = vi.fn();
    const stop = api.subscribeState(onState, onError);
    const source = sources[0]!;
    expect(source.url).toBe("https://app.test/api/device/events");

    source.listeners.get("state")?.({ data: JSON.stringify(state) });
    source.listeners.get("state")?.({ data: "{}" });
    expect(onState.mock.calls).toEqual([[state]]);
    expect(onError).toHaveBeenCalledOnce();

    stop();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it("builds hub access for a host on the same origin", () => {
    const api = createDeviceApi({ baseUrl: "https://app.test" });
    expect(deviceHubAccess(api, "/api/device/hub", "local")).toEqual({
      httpBase: "https://app.test/api/device/hub/local",
      wsBase: "wss://app.test/api/device/hub/local",
      query: {},
      credentials: true,
    });
  });
});
