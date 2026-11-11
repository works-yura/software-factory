import { useEffect, useState } from "react";
import { createCanvasFrameSink } from "../client/frame.ts";
import type { DuoControlState } from "../client/duoControl.ts";
import type { DeviceHubAccess } from "../client/hubAccess.ts";
import {
  createDeviceStreamClient,
  type DeviceScreenSize,
  type DeviceStreamClient,
  type DeviceStreamStatus,
} from "../client/stream.ts";
import type { DevicePlatform } from "../contracts.ts";

export interface DeviceStreamState {
  readonly status: DeviceStreamStatus;
  readonly detail: string | undefined;
  /** A frame arrived during this session, so a reconnect can keep showing it. */
  readonly hasFrame: boolean;
  readonly screen: DeviceScreenSize | null;
  readonly mjpegUrl: string | null;
  readonly mjpegGeneration: number;
  readonly input: { readonly connected: boolean; readonly detail?: string };
  readonly duoControl: DuoControlState;
  readonly phoneUnavailable: boolean;
}

export interface DeviceStreamSession {
  readonly stream: DeviceStreamClient;
  /** The stream draws here; the view mounts it and the 3D viewers sample it. */
  readonly canvas: HTMLCanvasElement;
  readonly setFrameListener: (listener: (() => void) | null) => void;
  /** Called when the hub rejects a Duo control, so the 3D viewer drops its optimistic pose. */
  readonly setControlRejectedListener: (listener: (() => void) | null) => void;
  readonly markPhoneUnavailable: () => void;
  readonly reconnect: () => void;
  readonly state: DeviceStreamState;
}

export interface DeviceStreamKey {
  readonly hostId: string;
  readonly platform: DevicePlatform;
  readonly deviceId: string;
  readonly access: DeviceHubAccess;
  /** See `DeviceStreamTarget.serveSimOnly`. */
  readonly serveSimOnly: boolean;
  /** An expired or rejected session renews hub access, which starts a new session. */
  readonly onUnauthorized: () => void;
  /** Reports the screen this view's stream last reported, null once it streams nothing. */
  readonly onScreen?: (screen: DeviceScreenSize | null) => void;
}

export const IDLE_DEVICE_STREAM_STATE: DeviceStreamState = {
  status: "connecting",
  detail: undefined,
  hasFrame: false,
  screen: null,
  mjpegUrl: null,
  mjpegGeneration: 0,
  input: { connected: false },
  duoControl: { pending: false, requested: null, error: null },
  phoneUnavailable: false,
};

function createDeviceStreamSession(
  key: DeviceStreamKey,
  publish: (session: DeviceStreamSession) => void,
  onScreen: (screen: DeviceScreenSize | null) => void,
): DeviceStreamSession {
  const canvas = document.createElement("canvas");
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  let frameListener: (() => void) | null = null;
  let controlRejectedListener: (() => void) | null = null;
  let state = IDLE_DEVICE_STREAM_STATE;
  let session: DeviceStreamSession;
  const update = (patch: Partial<DeviceStreamState>) => {
    state = { ...state, ...patch };
    session = { ...session, state };
    publish(session);
  };
  const client = createDeviceStreamClient(
    {
      platform: key.platform,
      deviceId: key.deviceId,
      access: key.access,
      serveSimOnly: key.serveSimOnly,
    },
    createCanvasFrameSink(canvas, () => frameListener?.()),
    {
      onDuoControl: (duoControl) => {
        if (duoControl.error && duoControl.error !== state.duoControl.error)
          controlRejectedListener?.();
        update({ duoControl });
      },
      onDuoUnavailable: () => update({ phoneUnavailable: true }),
      onStatus: (status, detail) =>
        update({ status, detail, ...(status === "streaming" ? { hasFrame: true } : {}) }),
      onScreen: (screen) => {
        onScreen(screen);
        update({ screen });
      },
      onUnauthorized: key.onUnauthorized,
      onMjpegFallback: (mjpegUrl) =>
        update({ mjpegUrl, mjpegGeneration: state.mjpegGeneration + 1 }),
      onCanvasVideo: () => update({ mjpegUrl: null }),
      onInputConnected: (connected, detail) =>
        update({ input: { connected, ...(detail ? { detail } : {}) } }),
    },
  );
  session = {
    stream: client,
    canvas,
    setFrameListener: (listener) => {
      frameListener = listener;
    },
    setControlRejectedListener: (listener) => {
      controlRejectedListener = listener;
    },
    markPhoneUnavailable: () => update({ phoneUnavailable: true }),
    reconnect: () => {
      client.stop();
      update({ phoneUnavailable: false });
      client.start();
    },
    state,
  };
  return session;
}

/**
 * A device's video and input connection, live while a view mounts it with a key.
 * Each mounted view owns its own client: one canvas cannot be in two places.
 */
export function useDeviceStreamSession(key: DeviceStreamKey | null): DeviceStreamSession | null {
  const [session, setSession] = useState<DeviceStreamSession | null>(null);
  const access = key?.access;
  const hostId = key?.hostId;
  const platform = key?.platform;
  const deviceId = key?.deviceId;
  const serveSimOnly = key?.serveSimOnly === true;
  // The callbacks may change identity every render; the session reads the latest ones.
  const [callbacks] = useState<{
    onUnauthorized: () => void;
    onScreen: (screen: DeviceScreenSize | null) => void;
  }>(() => ({ onUnauthorized: () => {}, onScreen: () => {} }));
  callbacks.onUnauthorized = key?.onUnauthorized ?? (() => {});
  callbacks.onScreen = key?.onScreen ?? (() => {});
  // owns the stream client for the mounted key and publishes its state
  useEffect(() => {
    if (!access || !hostId || !platform || !deviceId) {
      setSession(null);
      return;
    }
    let active = true;
    const created = createDeviceStreamSession(
      {
        hostId,
        platform,
        deviceId,
        access,
        serveSimOnly,
        onUnauthorized: () => callbacks.onUnauthorized(),
      },
      (next) => {
        if (active) setSession(next);
      },
      (screen) => callbacks.onScreen(screen),
    );
    setSession(created);
    created.stream.start();
    return () => {
      active = false;
      created.stream.stop();
      callbacks.onScreen(null);
      setSession(null);
    };
  }, [callbacks, access, hostId, platform, deviceId, serveSimOnly]);
  return session;
}
