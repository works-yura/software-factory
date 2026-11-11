import type { DeviceSummary } from "../contracts.ts";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { DeviceToolsPanel } from "./DeviceToolsPanel.tsx";
import type { DeviceControls } from "./useDeviceControls.ts";

const device: DeviceSummary = {
  hostId: "local",
  id: "emulator",
  name: "Pixel",
  platform: "android",
  version: "Android 15",
  booted: true,
  physical: false,
};

afterEach(cleanup);

it("keeps a typed URL until opening it succeeds", async () => {
  const run = vi
    .fn<DeviceControls["act"]>()
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  const controls: DeviceControls = {
    detail: null,
    pending: false,
    error: null,
    act: run,
    disabled: false,
    foregroundApp: null,
  };
  render(
    <DeviceToolsPanel
      controls={controls}
      hostDiagnostics={undefined}
      device={device}
      access={null}
      axOverlay={false}
      onAxOverlayChange={() => {}}
      onClose={() => {}}
    />,
  );
  const url = "myapp://settings";
  const field = screen.getByPlaceholderText<HTMLInputElement>("https://… or myapp://");
  const open = screen.getByRole("button", { name: "Open" });

  fireEvent.change(field, { target: { value: url } });
  fireEvent.click(open);
  await act(() => run.mock.results[0]?.value);
  expect(field.value).toBe(url);

  fireEvent.click(open);
  await act(() => run.mock.results[1]?.value);
  expect(field.value).toBe("");
});
