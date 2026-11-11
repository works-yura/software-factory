// Device state as a plain React store: one store per device API, read with
// `useSyncExternalStore`.
import {
  createContext,
  use,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { DeviceHubAccess } from "../client/hubAccess.ts";
import type {
  DeviceActionInput,
  DeviceCloseInput,
  DeviceConfigureInput,
  DeviceDetail,
  DeviceListInput,
  DeviceOpenInput,
  DeviceServiceState,
  DeviceSession,
  DeviceShutdownInput,
} from "../contracts.ts";
import { deviceHubAccess, formatDeviceError, type DeviceApi } from "./deviceApi.ts";
import type { AndroidFoldState } from "./deviceFold.ts";
import type { DeviceModelUrls } from "./deviceModels.ts";

export type CommandResult<T> =
  | { readonly _tag: "Success"; readonly value: T }
  | { readonly _tag: "Failure"; readonly cause: unknown; readonly message: string };

export interface CommandOptions {
  /** Reports a failure through the store's `onCommandError`. Defaults to true. */
  readonly reportFailure?: boolean;
}

export interface DeviceStateSnapshot {
  readonly state: DeviceServiceState | null;
  readonly error: string | null;
}

export interface DeviceDetailView {
  /** Settings the host last confirmed, by a read or by an action's answer. */
  readonly detail: DeviceDetail | null;
  readonly error: string | null;
}

export interface AndroidFoldView {
  readonly fold: AndroidFoldState | null;
  /** Hinge angle the 3D phone shows, including an optimistic one while a change is in flight. */
  readonly angle: number | null;
}

export interface DeviceStoreOptions {
  /** Shown for failed commands that report failures (e.g. as a toast). */
  readonly onCommandError?: (message: string, cause: unknown) => void;
}

export const EMPTY_DEVICE_STATE: DeviceServiceState = {
  hosts: [],
  hostStatus: "disabled",
  hostStatuses: {},
  devices: [],
  sessions: [],
  onboardingCompleted: false,
  agentAccessEnabled: false,
  hubBasePath: "/api/device/hub",
  revision: 0,
};

const EMPTY_DETAIL_VIEW: DeviceDetailView = { detail: null, error: null };
const EMPTY_FOLD_VIEW: AndroidFoldView = { fold: null, angle: null };
// A cookie-authenticated hub that keeps answering 401 must not restart streams in a tight loop.
const HUB_ACCESS_REFRESH_INTERVAL_MS = 2_000;

export const deviceScreenKey = (hostId: string, deviceId: string) => `${hostId}\u0000${deviceId}`;

export type DeviceStore = ReturnType<typeof createDeviceStore>;

export function createDeviceStore(api: DeviceApi, options: DeviceStoreOptions = {}) {
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  // State subscription, live while any view retains it.
  let snapshot: DeviceStateSnapshot = { state: null, error: null };
  const setSnapshot = (next: DeviceStateSnapshot) => {
    snapshot = next;
    emit();
  };
  const applyState = (state: DeviceServiceState, force: boolean) => {
    // A command's answer can arrive after a newer pushed state.
    if (!force && snapshot.state && state.revision < snapshot.state.revision) return;
    setSnapshot({ state, error: null });
  };
  let retainers = 0;
  let connection: { readonly close: () => void } | null = null;
  const connect = () => {
    const controller = new AbortController();
    let pushed = false;
    const unsubscribe = api.subscribeState(
      (state) => {
        pushed = true;
        applyState(state, true);
      },
      (error) => {
        // Without a first snapshot a failed subscription never settles on its own.
        if (!snapshot.state && !pushed) setSnapshot({ state: null, error: error.message });
      },
    );
    api.getState(controller.signal).then(
      (state) => {
        if (!controller.signal.aborted && !pushed) applyState(state, false);
      },
      (cause: unknown) => {
        if (!controller.signal.aborted && !snapshot.state)
          setSnapshot({ state: null, error: formatDeviceError(cause) });
      },
    );
    connection = {
      close: () => {
        controller.abort();
        unsubscribe();
      },
    };
  };
  const retainState = () => {
    retainers += 1;
    if (retainers === 1 && !connection) connect();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      retainers -= 1;
      // A view that remounts in the same commit keeps the connection.
      queueMicrotask(() => {
        if (retainers > 0 || !connection) return;
        connection.close();
        connection = null;
      });
    };
  };
  const refresh = () => {
    connection?.close();
    connection = null;
    setSnapshot({ state: snapshot.state, error: null });
    if (retainers > 0) connect();
  };

  // Commands. Reads and actions share one serial lane, so a read never answers before an action sent ahead of it. Each
  // device opens in its own lane: a slow boot must not hold up anything else.
  const lanes = new Map<string, Promise<unknown>>();
  const serial = <T,>(lane: string, task: () => Promise<T>): Promise<T> => {
    const previous = lanes.get(lane) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    lanes.set(lane, settled);
    void settled.then(() => {
      if (lanes.get(lane) === settled) lanes.delete(lane);
    });
    return run;
  };
  const command = async <T,>(
    lane: string,
    task: () => Promise<T>,
    commandOptions: CommandOptions | undefined,
  ): Promise<CommandResult<T>> => {
    try {
      return { _tag: "Success", value: await serial(lane, task) };
    } catch (cause) {
      const message = formatDeviceError(cause);
      if (commandOptions?.reportFailure !== false) options.onCommandError?.(message, cause);
      return { _tag: "Failure", cause, message };
    }
  };
  const ENVIRONMENT_LANE = "environment";
  const stateCommand =
    <I,>(run: (input: I) => Promise<DeviceServiceState>) =>
    (input: I, commandOptions?: CommandOptions) =>
      command(
        ENVIRONMENT_LANE,
        () =>
          run(input).then((state) => {
            applyState(state, false);
            return state;
          }),
        commandOptions,
      );

  const list = stateCommand<DeviceListInput>(api.list);
  const configure = stateCommand<DeviceConfigureInput>(api.configure);
  const close = stateCommand<DeviceCloseInput>(api.close);
  const shutdown = stateCommand<DeviceShutdownInput>(api.shutdown);
  const open = (input: DeviceOpenInput, commandOptions?: CommandOptions) =>
    command<DeviceSession>(
      JSON.stringify(["open", input.threadId, input.hostId ?? null, input.deviceId]),
      () => api.open(input),
      commandOptions,
    );
  const detail = (input: { hostId: string; deviceId: string }, commandOptions?: CommandOptions) =>
    command<DeviceDetail>(ENVIRONMENT_LANE, () => api.detail(input), commandOptions);
  const action = (input: DeviceActionInput, commandOptions?: CommandOptions) =>
    command<DeviceDetail>(ENVIRONMENT_LANE, () => api.action(input), commandOptions);

  // Probes the hosts once while any view mounts the probe. Probing never installs or starts helpers.
  let probes = 0;
  const mountHostProbe = () => {
    probes += 1;
    if (probes === 1) void list({}, { reportFailure: false });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      queueMicrotask(() => {
        probes -= 1;
      });
    };
  };

  // Hub access. The hub proxy authenticates with the page's cookies, so refreshing only
  // mints a new access object, which restarts the streams keyed by it.
  let accessGeneration = 0;
  let lastAccessRefresh = -Infinity;
  const accessCache = new Map<string, DeviceHubAccess>();
  const hubAccess = (hostId: string): DeviceHubAccess | null => {
    const state = snapshot.state;
    if (!state) return null;
    const key = `${accessGeneration}\u0000${state.hubBasePath}\u0000${hostId}`;
    let access = accessCache.get(key);
    if (!access) {
      for (const cached of accessCache.keys()) {
        if (cached.endsWith(`\u0000${hostId}`)) accessCache.delete(cached);
      }
      access = deviceHubAccess(api, state.hubBasePath, hostId);
      accessCache.set(key, access);
    }
    return access;
  };
  const refreshHubAccess = () => {
    const now = Date.now();
    if (now - lastAccessRefresh < HUB_ACCESS_REFRESH_INTERVAL_MS) return;
    lastAccessRefresh = now;
    accessGeneration += 1;
    emit();
  };
  /** Fresh access for a one-off request that failed with 401. */
  const renewHubAccess = (hostId: string): Promise<DeviceHubAccess | null> => {
    refreshHubAccess();
    return Promise.resolve(hubAccess(hostId));
  };

  // Device detail views.
  const details = new Map<string, DeviceDetailView>();
  const getDetail = (hostId: string, deviceId: string) =>
    details.get(deviceScreenKey(hostId, deviceId)) ?? EMPTY_DETAIL_VIEW;
  const setDetail = (
    hostId: string,
    deviceId: string,
    update: DeviceDetailView | ((current: DeviceDetailView) => DeviceDetailView),
  ) => {
    const current = getDetail(hostId, deviceId);
    details.set(
      deviceScreenKey(hostId, deviceId),
      typeof update === "function" ? update(current) : update,
    );
    emit();
  };
  /** Reads a device's settings into its detail view. */
  const readDetail = async (hostId: string, deviceId: string) => {
    const result = await detail({ hostId, deviceId }, { reportFailure: false });
    setDetail(
      hostId,
      deviceId,
      result._tag === "Success"
        ? { detail: result.value, error: null }
        : { detail: null, error: result.message },
    );
  };

  // The fold controls and the 3D phone share one view of a device's fold.
  const folds = new Map<string, AndroidFoldView>();
  const getFold = (deviceKey: string) => folds.get(deviceKey) ?? EMPTY_FOLD_VIEW;
  const setFold = (
    deviceKey: string,
    update: AndroidFoldView | ((current: AndroidFoldView) => AndroidFoldView),
  ) => {
    folds.set(deviceKey, typeof update === "function" ? update(getFold(deviceKey)) : update);
    emit();
  };

  return {
    api,
    subscribe,
    getSnapshot: () => snapshot,
    retainState,
    refresh,
    list,
    configure,
    open,
    close,
    shutdown,
    detail,
    action,
    mountHostProbe,
    hubAccess,
    refreshHubAccess,
    renewHubAccess,
    getDetail,
    setDetail,
    readDetail,
    getFold,
    setFold,
  };
}

interface DeviceContextValue {
  readonly store: DeviceStore;
  readonly modelUrls: Partial<DeviceModelUrls> | null;
}

const DeviceContext = createContext<DeviceContextValue | null>(null);

/**
 * Provides the device store to every device view below it. Pass `store` to share one
 * store, or `api` to create one. `modelUrls` enables the 3D device models.
 */
export function DeviceProvider(props: {
  readonly store?: DeviceStore;
  readonly api?: DeviceApi;
  readonly options?: DeviceStoreOptions;
  readonly modelUrls?: Partial<DeviceModelUrls> | null;
  readonly children: ReactNode;
}) {
  const [ownStore] = useState(() => {
    if (props.store) return null;
    if (!props.api) throw new Error("DeviceProvider needs a store or an api.");
    return createDeviceStore(props.api, props.options);
  });
  const store = props.store ?? ownStore!;
  return (
    <DeviceContext value={{ store, modelUrls: props.modelUrls ?? null }}>
      {props.children}
    </DeviceContext>
  );
}

export function useDeviceStore(): DeviceStore {
  const context = use(DeviceContext);
  if (!context) throw new Error("Device views must be inside a DeviceProvider.");
  return context.store;
}

export function useHasDeviceProvider(): boolean {
  return use(DeviceContext) !== null;
}

export function useDeviceModelUrls(): Partial<DeviceModelUrls> | null {
  return use(DeviceContext)?.modelUrls ?? null;
}

/** Selects from the store; the selector must return stable references. */
export function useDeviceStoreValue<T>(select: (store: DeviceStore) => T): T {
  const store = useDeviceStore();
  return useSyncExternalStore(
    store.subscribe,
    () => select(store),
    () => select(store),
  );
}

function useRetainedState(store: DeviceStore) {
  useEffect(() => store.retainState(), [store]);
}

export function useDeviceState(): {
  readonly state: DeviceServiceState;
  readonly loaded: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
} {
  const store = useDeviceStore();
  useRetainedState(store);
  const snapshot = useDeviceStoreValue((current) => current.getSnapshot());
  return {
    state: snapshot.state ?? EMPTY_DEVICE_STATE,
    loaded: snapshot.state !== null,
    error: snapshot.error,
    refresh: store.refresh,
  };
}

/** Null until the first device state names the hub path. */
export function useDeviceHubAccess(hostId: string): DeviceHubAccess | null {
  const store = useDeviceStore();
  useRetainedState(store);
  return useDeviceStoreValue((current) => current.hubAccess(hostId));
}

/** Probes the device hosts while mounted and enabled; one probe however many views mount it. */
export function useDeviceHostProbe(enabled: boolean): void {
  const store = useDeviceStore();
  useEffect(() => (enabled ? store.mountHostProbe() : undefined), [store, enabled]);
}
