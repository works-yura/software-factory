import type { DeviceServiceState, DeviceSession } from "../contracts.ts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DevicePanel } from "./DevicePanel.tsx";
import { fakeDeviceApi } from "./testing/fakeDeviceApi.ts";

const phone = {
  hostId: "local",
  id: "phone",
  name: "Phone",
  platform: "ios",
  version: "iOS 19",
  booted: false,
  physical: false,
} as const;
const deviceState: DeviceServiceState = {
  hosts: [
    {
      id: "local",
      kind: "local",
      label: "This Mac",
      platforms: [{ platform: "ios", available: true }],
      hubInstalled: true,
      agentDeviceInstalled: true,
    },
  ],
  hostStatus: "ready",
  hostStatuses: { local: { status: "ready" } },
  devices: [phone],
  sessions: [
    {
      threadId: "thread-1",
      hostId: "local",
      deviceId: "phone",
      platform: "ios",
      openedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  onboardingCompleted: true,
  agentAccessEnabled: true,
  hubBasePath: "/api/device/hub",
  revision: 1,
};

const threadA = "thread-1";
// The panel stays mounted across thread switches.
const threadB = "thread-2";
const phoneTarget = { hostId: "local", deviceId: "phone", platform: "ios", name: "Phone" };
const session = (threadId: string): DeviceSession => ({
  threadId,
  hostId: "local",
  deviceId: "phone",
  platform: "ios",
  openedAt: "2026-01-01T00:00:00.000Z",
});

const deferred = () => {
  let resolve!: (value: DeviceSession) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<DeviceSession>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

function setup(state = deviceState) {
  const fake = fakeDeviceApi(state);
  fake.api.list.mockResolvedValue(state);
  const openDevice = vi.fn();
  // A controlled target that never changes, as t3code's mocked right panel store did.
  const devicePanel = (threadId: string) => (
    <DevicePanel
      key="device-panel"
      api={fake.api}
      threadId={threadId}
      target={null}
      onOpenDevice={openDevice}
    />
  );
  return { ...fake, openDevice, devicePanel };
}

const startButton = () =>
  document.querySelector<HTMLButtonElement>('[aria-label="Start Phone"]');
const click = (button: HTMLButtonElement | null) =>
  act(async () => {
    button!.click();
  });
const errors = () => document.querySelectorAll('[role="alert"]');

afterEach(cleanup);

describe("DevicePanel thread switches", () => {
  it("keeps the latest pick pending across switches away and back", async () => {
    const { api, openDevice, devicePanel } = setup();
    const first = deferred();
    const second = deferred();
    const latest = deferred();
    api.open
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(latest.promise);
    const view = render(devicePanel(threadA));
    await waitFor(() => expect(startButton()).not.toBeNull());
    await click(startButton());
    view.rerender(devicePanel(threadB));
    await click(startButton());
    view.rerender(devicePanel(threadA));
    await click(startButton());

    await act(async () => first.reject(new Error("boom")));

    expect(startButton()).toBeNull();
    expect(errors()).toHaveLength(0);
    expect(openDevice).not.toHaveBeenCalled();

    await act(async () => second.resolve(session(threadB)));

    expect(startButton()).toBeNull();
    expect(openDevice.mock.calls).toEqual([[threadB, phoneTarget]]);

    await act(async () => latest.resolve(session(threadA)));

    expect(startButton()?.disabled).toBe(false);
    expect(errors()).toHaveLength(0);
    expect(openDevice.mock.calls).toEqual([
      [threadB, phoneTarget],
      [threadA, phoneTarget],
    ]);
  });
});

describe("DevicePanel host probe", () => {
  it("probes the hosts once while setup shows inside the panel", async () => {
    const { api, devicePanel } = setup({ ...deviceState, onboardingCompleted: false });
    render(devicePanel(threadA));

    await waitFor(() => expect(api.list).toHaveBeenCalled());
    await screen.findByText("Set up devices");
    expect(api.list.mock.calls).toEqual([[{}]]);
  });
});

describe("DevicePanel discovery warning", () => {
  it("a dismissal hides only the cause it was made for", async () => {
    const withCause = (detail: string, revision: number): DeviceServiceState => ({
      ...deviceState,
      hostStatuses: { local: { status: "ready", detail, incompletePlatforms: ["ios"] } },
      revision,
    });
    const first = withCause("first cause", 1);
    const { push, devicePanel } = setup(first);
    const warning = "iOS list on This Mac may be incomplete.";
    const view = render(devicePanel(threadA));

    fireEvent.click(
      await screen.findByRole("button", { name: "Dismiss device warning for This Mac" }),
    );
    view.rerender(devicePanel(threadA));
    expect(screen.queryByText(warning)).toBeNull();

    act(() => push(withCause("second cause", 2)));
    view.rerender(devicePanel(threadA));
    expect(screen.getByText(warning)).toBeTruthy();
  });
});

// From t3code's state/device.browser.test.tsx.
describe("DevicePanel first load", () => {
  it("reports a failed first device load and retries it", async () => {
    const { api, devicePanel } = setup();
    api.getState
      .mockRejectedValueOnce(new Error("Device access denied"))
      .mockResolvedValue({ ...deviceState, devices: [] });
    render(devicePanel(threadA));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Device access denied");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("button", { name: "Refresh devices" });
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});
