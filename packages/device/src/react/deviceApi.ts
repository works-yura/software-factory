// Typed HTTP client for the device server API. Replaces t3code's WebSocket RPC
// (`WS_METHODS.device*`) and its device hub ticket minting: the hub proxy is on
// the same origin and authenticates with cookies.
import type { z } from "zod";
import {
  DeviceDetail,
  DeviceErrorBody,
  DeviceServiceState,
  DeviceSession,
  type DeviceActionInput,
  type DeviceCloseInput,
  type DeviceConfigureInput,
  type DeviceDetailInput,
  type DeviceListInput,
  type DeviceOpenInput,
  type DeviceShutdownInput,
} from "../contracts.ts";
import type { DeviceHubAccess } from "../client/hubAccess.ts";

export interface DeviceApiOptions {
  /** Path (or absolute URL) the device routes are mounted at. Defaults to `/api/device`. */
  readonly basePath?: string;
  /** Origin that relative paths resolve against. Defaults to `window.location.origin`. */
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly EventSource?: typeof globalThis.EventSource;
}

/** A non-2xx answer. `_tag` is the server's error tag, such as `DeviceNotFoundError`. */
export class DeviceApiError extends Error {
  readonly _tag: string;
  readonly status: number;
  constructor(fields: { readonly _tag: string; readonly message: string; readonly status: number }) {
    super(fields.message);
    this.name = "DeviceApiError";
    this._tag = fields._tag;
    this.status = fields.status;
  }
}

export interface DeviceApi {
  readonly basePath: string;
  /** Resolves a server path, such as `state.hubBasePath`, to an absolute URL. */
  readonly resolveUrl: (path: string) => string;
  readonly getState: (signal?: AbortSignal) => Promise<DeviceServiceState>;
  /** Streams every state change over SSE. Returns the unsubscribe. */
  readonly subscribeState: (
    onState: (state: DeviceServiceState) => void,
    onError?: (error: Error) => void,
  ) => () => void;
  readonly list: (input: DeviceListInput) => Promise<DeviceServiceState>;
  readonly configure: (input: DeviceConfigureInput) => Promise<DeviceServiceState>;
  readonly open: (input: DeviceOpenInput) => Promise<DeviceSession>;
  readonly close: (input: DeviceCloseInput) => Promise<DeviceServiceState>;
  readonly shutdown: (input: DeviceShutdownInput) => Promise<DeviceServiceState>;
  readonly detail: (input: DeviceDetailInput) => Promise<DeviceDetail>;
  readonly action: (input: DeviceActionInput) => Promise<DeviceDetail>;
}

const defaultOrigin = () =>
  typeof window !== "undefined" && window.location ? window.location.origin : "http://localhost";

export function createDeviceApi(options: DeviceApiOptions = {}): DeviceApi {
  const basePath = (options.basePath ?? "/api/device").replace(/\/+$/, "");
  const origin = options.baseUrl ?? defaultOrigin();
  const resolveUrl = (path: string) => new URL(path, origin).toString();
  const doFetch = (input: string, init: RequestInit) =>
    (options.fetch ?? globalThis.fetch)(input, init);

  const request = async <S extends z.ZodType>(
    schema: S,
    path: string,
    init: RequestInit,
  ): Promise<z.infer<S>> => {
    let response: Response;
    try {
      response = await doFetch(resolveUrl(`${basePath}${path}`), {
        credentials: "same-origin",
        cache: "no-store",
        ...init,
      });
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") throw cause;
      throw new DeviceApiError({
        _tag: "DeviceNetworkError",
        message: "Could not reach the device server.",
        status: 0,
      });
    }
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const body = DeviceErrorBody.safeParse(payload);
      throw new DeviceApiError(
        body.success
          ? { ...body.data, status: response.status }
          : {
              _tag: "DeviceHttpError",
              message: `Device request failed (${response.status}).`,
              status: response.status,
            },
      );
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new DeviceApiError({
        _tag: "DeviceResponseError",
        message: "The device server sent an unexpected response.",
        status: response.status,
      });
    }
    return parsed.data;
  };

  const post =
    <S extends z.ZodType, I>(schema: S, path: string) =>
    (input: I) =>
      request(schema, path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });

  return {
    basePath,
    resolveUrl,
    getState: (signal) => request(DeviceServiceState, "/state", signal ? { signal } : {}),
    subscribeState(onState, onError) {
      const Source = options.EventSource ?? globalThis.EventSource;
      const source = new Source(resolveUrl(`${basePath}/events`), { withCredentials: true });
      source.addEventListener("state", (event) => {
        let state: DeviceServiceState;
        try {
          state = DeviceServiceState.parse(JSON.parse(String((event as MessageEvent).data)));
        } catch {
          onError?.(new Error("The device server sent an unexpected state event."));
          return;
        }
        onState(state);
      });
      source.addEventListener("error", () => {
        onError?.(new Error("The device state stream disconnected."));
      });
      return () => source.close();
    },
    list: post<typeof DeviceServiceState, DeviceListInput>(DeviceServiceState, "/list"),
    configure: post<typeof DeviceServiceState, DeviceConfigureInput>(
      DeviceServiceState,
      "/configure",
    ),
    open: post<typeof DeviceSession, DeviceOpenInput>(DeviceSession, "/open"),
    close: post<typeof DeviceServiceState, DeviceCloseInput>(DeviceServiceState, "/close"),
    shutdown: post<typeof DeviceServiceState, DeviceShutdownInput>(DeviceServiceState, "/shutdown"),
    detail: post<typeof DeviceDetail, DeviceDetailInput>(DeviceDetail, "/detail"),
    action: post<typeof DeviceDetail, DeviceActionInput>(DeviceDetail, "/action"),
  };
}

/**
 * Hub access for one device host: `{hubBasePath}/{hostId}` over HTTP and the same
 * path with a ws(s) scheme for the input socket. Same origin, cookie credentials.
 */
export function deviceHubAccess(
  api: Pick<DeviceApi, "resolveUrl">,
  hubBasePath: string,
  hostId: string,
): DeviceHubAccess {
  const httpBase = api.resolveUrl(
    `${hubBasePath.replace(/\/+$/, "")}/${encodeURIComponent(hostId)}`,
  );
  return { httpBase, wsBase: httpBase.replace(/^http/, "ws"), query: {}, credentials: true };
}

/** The message a failed command shows, like t3code's `formatEnvironmentQueryError`. */
export function formatDeviceError(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === "string" && cause) return cause;
  return "The device request failed.";
}
