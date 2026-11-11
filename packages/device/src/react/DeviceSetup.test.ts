import type { DeviceServiceState } from "../contracts.ts";
import { describe, expect, it } from "vitest";

import { deviceHubReadiness, platformSetupStatus } from "./DeviceSetup.tsx";

const deviceState = (overrides: Partial<DeviceServiceState> = {}): DeviceServiceState => ({
  hosts: [
    {
      id: "local",
      kind: "local",
      label: "This machine",
      hubInstalled: false,
      agentDeviceInstalled: false,
      platforms: [
        { platform: "ios", available: true },
        { platform: "android", available: true },
      ],
    },
  ],
  hostStatus: "ready",
  hostStatuses: {},
  devices: [],
  sessions: [],
  onboardingCompleted: false,
  agentAccessEnabled: false,
  hubBasePath: "/api/device-hub",
  revision: 0,
  ...overrides,
});

describe("device setup guidance", () => {
  it("waits for complete discovery before advising device setup", () => {
    const state = deviceState({
      hostStatus: "idle",
      hostStatuses: { local: { status: "ready", androidDiscoveryIncomplete: true } },
    });
    expect(platformSetupStatus(state, "android").message).toContain("may be incomplete");
    expect(platformSetupStatus(state, "ios").message).toContain("Xcode Settings");
    expect(
      platformSetupStatus({ ...state, hostStatuses: { local: { status: "ready" } } }, "android")
        .message,
    ).toContain("Device Manager");
    expect(
      platformSetupStatus(
        { ...state, hostStatuses: { local: { status: "ready", incompletePlatforms: ["ios"] } } },
        "ios",
      ).message,
    ).toContain("discovery reported a problem");
  });

  // Only the local host exists, so this
  // checks the per-host status that stands in for the legacy local hostStatus.
  it("counts the host's own ready status when the legacy hub status is idle", () => {
    const state = deviceState({
      hostStatus: "idle",
      hostStatuses: { local: { status: "ready" } },
      hosts: [
        {
          ...deviceState().hosts[0]!,
          platforms: [
            { platform: "ios", available: true },
            { platform: "android", available: false, reason: "Android SDK was not found." },
          ],
        },
      ],
      devices: [
        {
          hostId: "local",
          id: "iphone",
          platform: "ios",
          name: "iPhone 16 Pro",
          version: "iOS 27.0",
          booted: true,
          physical: false,
        },
      ],
    });
    expect(deviceHubReadiness(state).ready).toBe(true);
    expect(platformSetupStatus(state, "ios")).toEqual({
      ready: true,
      message: "Xcode and iOS Simulator are available.",
    });
    expect(platformSetupStatus(state, "android")).toEqual({
      ready: false,
      message: "Android SDK was not found.",
    });
  });
});
