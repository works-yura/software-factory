import { DeviceHostUpdates } from "./DeviceHostUpdates.tsx";
import type { DevicePlatform, DeviceServiceState, DeviceSummary } from "../contracts.ts";
import { ArrowUpRight, CircleAlert, Play, Smartphone, X } from "./ui/icons.tsx";
import { type ReactNode, useState } from "react";

import { Button } from "./ui/button.tsx";
import { DiscoveryList, Spinner } from "./ui/controls.tsx";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/floating.tsx";
import { WizardPopup } from "./ui/wizard.tsx";
import { cn } from "./ui/cn.ts";
import type { DeviceApi } from "./deviceApi.ts";
import type { DeviceModelUrls } from "./deviceModels.ts";
import {
  DeviceProvider,
  useDeviceHostProbe,
  useDeviceState,
  useDeviceStore,
  useHasDeviceProvider,
  type DeviceStore,
  type DeviceStoreOptions,
} from "./deviceStore.tsx";
import { DeviceLoadingView } from "./DeviceLoadingView.tsx";
import {
  DeviceSetup,
  deviceHubReadiness,
  incompleteListings,
  isAndroidDiscoveryUncertain,
} from "./DeviceSetup.tsx";
import { DeviceWorkspace } from "./DeviceWorkspace.tsx";

const platformLabel = (platform: DevicePlatform) =>
  platform === "ios" ? "iOS Simulators" : "Android Emulators";

const deviceKey = (device: Pick<DeviceSummary, "hostId" | "id">) =>
  `${device.hostId}\u0000${device.id}`;

/** The device a thread shows in the panel. */
export interface DevicePanelTarget {
  readonly hostId: string;
  readonly deviceId: string;
  readonly platform: DevicePlatform;
  readonly name: string;
}

export interface DevicePanelProps {
  /** Who owns the device sessions the panel opens: a session, thread or any caller-chosen id. */
  readonly threadId: string;
  /** Creates the panel's own store when no DeviceProvider is above it. */
  readonly api?: DeviceApi;
  /** Shares a store instead of creating one from `api`. */
  readonly store?: DeviceStore;
  readonly storeOptions?: DeviceStoreOptions;
  readonly modelUrls?: Partial<DeviceModelUrls> | null;
  /** Hidden panels stay mounted but stop streaming. Defaults to true. */
  readonly visible?: boolean;
  /**
   * The device this thread shows. Omit to let the panel track it per thread;
   * pass it (null for the device list) with `onOpenDevice` and `onCloseDevice` to control it.
   */
  readonly target?: Pick<DevicePanelTarget, "hostId" | "deviceId"> | null;
  /** A device opened for `threadId`, which may no longer be the thread the panel shows. */
  readonly onOpenDevice?: (threadId: string, target: DevicePanelTarget) => void;
  /** The thread's device view closed (closed or powered off). */
  readonly onCloseDevice?: (threadId: string) => void;
  /** Shows "Float device over chat" in the device menu when set. */
  readonly onFloat?: (threadId: string, target: DevicePanelTarget) => void;
  /** Cancel in the setup wizard. */
  readonly onDismissSetup?: () => void;
  readonly className?: string;
}

/**
 * Lists the environment's simulators and emulators, opens one for a thread and
 * streams it. Shows device setup until onboarding is complete.
 */
export function DevicePanel(props: DevicePanelProps) {
  const hasProvider = useHasDeviceProvider();
  if (props.store || props.api || !hasProvider) {
    return (
      <DeviceProvider
        {...(props.store ? { store: props.store } : {})}
        {...(props.api ? { api: props.api } : {})}
        {...(props.storeOptions ? { options: props.storeOptions } : {})}
        modelUrls={props.modelUrls ?? null}
      >
        <DevicePanelContent {...props} />
      </DeviceProvider>
    );
  }
  return <DevicePanelContent {...props} />;
}

function DevicePanelContent(props: DevicePanelProps) {
  const { threadId } = props;
  const visible = props.visible ?? true;
  const store = useDeviceStore();
  const { state, loaded, error: stateError, refresh: refreshState } = useDeviceState();
  // Uncontrolled targets, per thread: the panel can stay mounted across thread switches.
  const [ownTargets, setOwnTargets] = useState<
    Readonly<Record<string, Pick<DevicePanelTarget, "hostId" | "deviceId"> | null>>
  >({});
  const controlled = props.target !== undefined;
  const target = controlled ? props.target : (ownTargets[threadId] ?? null);
  // The panel stays mounted across thread switches, so an in-flight open or
  // power-off is tagged with the thread it belongs to and only shown there.
  const scope = threadId;
  const [operation, setOperation] = useState<{
    readonly scope: string;
    readonly pending: DeviceSummary | null;
    readonly error: string | null;
  } | null>(null);
  const pendingDevice = operation?.scope === scope ? operation.pending : null;
  const operationError = operation?.scope === scope ? operation.error : null;
  const pendingDeviceKey = pendingDevice ? deviceKey(pendingDevice) : null;

  const hostDisabled = state.hostStatus === "disabled";

  useDeviceHostProbe(visible && loaded && !hostDisabled);

  const sessions = state.sessions.filter((session) => session.threadId === threadId);
  const activeSession = target
    ? sessions.find(
        (session) => session.deviceId === target.deviceId && session.hostId === target.hostId,
      )
    : undefined;
  const activeDevice = activeSession
    ? state.devices.find(
        (device) => device.hostId === activeSession.hostId && device.id === activeSession.deviceId,
      )
    : undefined;
  const activeHost = activeDevice
    ? state.hosts.find((host) => host.id === activeDevice.hostId)
    : undefined;

  const grouped = groupDevices(state);

  const startOperation = (pending: DeviceSummary | null) => {
    const started = { scope, pending, error: null };
    setOperation(started);
    // Returning to the same thread can start a newer operation before this one settles.
    return (error: string | null) =>
      setOperation((current) =>
        current === started ? { ...started, pending: null, error } : current,
      );
  };

  const selectDevice = async (value: string) => {
    const device = state.devices.find((candidate) => deviceKey(candidate) === value);
    if (!device) return;
    const settleOperation = startOperation(device);
    const result = await store.open({
      threadId,
      hostId: device.hostId,
      deviceId: device.id,
      platform: device.platform,
    });
    if (result._tag === "Failure") settleOperation(result.message);
    else {
      // The server opened the device for the starting thread, so its view opens there.
      const opened: DevicePanelTarget = {
        hostId: result.value.hostId,
        deviceId: result.value.deviceId,
        platform: device.platform,
        name: device.name,
      };
      if (!controlled) setOwnTargets((current) => ({ ...current, [threadId]: opened }));
      props.onOpenDevice?.(threadId, opened);
      settleOperation(null);
    }
  };

  const onFloat = props.onFloat;
  const floatActive =
    onFloat && activeDevice
      ? () =>
          onFloat(threadId, {
            hostId: activeDevice.hostId,
            deviceId: activeDevice.id,
            platform: activeDevice.platform,
            name: activeDevice.name,
          })
      : undefined;

  const closeSurface = () => {
    if (!controlled) setOwnTargets((current) => ({ ...current, [threadId]: null }));
    props.onCloseDevice?.(threadId);
  };

  const closeActive = (powerOff: boolean) => {
    if (!powerOff) {
      closeSurface();
      return;
    }
    if (!activeSession) return;
    const settleOperation = startOperation(null);
    void store
      .close({
        threadId,
        hostId: activeSession.hostId,
        deviceId: activeSession.deviceId,
        shutdown: powerOff,
      })
      .then((result) => {
        if (result._tag === "Failure") settleOperation(result.message);
        else closeSurface();
      });
  };

  const bootingDevices =
    state.bootingDevices?.filter((device) => device.threadId === threadId) ?? [];
  const { ready: hostReady, busy: hostBusy } = deviceHubReadiness(state);
  const loading = !activeDevice && (pendingDevice !== null || hostBusy || !loaded);
  // Without a first snapshot a failed subscription never settles on its own.
  const loadError = loaded ? null : stateError;
  const diagnostics = state.hosts.flatMap((host) => {
    const status = state.hostStatuses[host.id];
    const detail = status?.detail ?? (host.kind === "local" ? state.hostStatusDetail : undefined);
    return detail && (status?.status ?? state.hostStatus) === "ready"
      ? [
          {
            hostId: host.id,
            label: host.label,
            detail,
            incompletePlatforms: incompleteListings(status),
          },
        ]
      : [];
  });
  const unavailablePlatforms = state.hosts.flatMap((host) =>
    host.platforms
      .filter((platform) => !platform.available)
      .map((platform) => ({ ...platform, hostId: host.id, hostLabel: host.label })),
  );

  if (loaded && (!state.onboardingCompleted || hostDisabled)) {
    return (
      <div className={cn("flex h-full min-h-0 flex-col", props.className)} hidden={!visible}>
        <WizardPopup>
          <DeviceSetup
            state={state}
            {...(props.onDismissSetup ? { onCancel: props.onDismissSetup } : {})}
          />
        </WizardPopup>
      </div>
    );
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-col", props.className)}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          className={cn(
            "shrink-0 bg-background",
            loading && "absolute inset-x-0 top-0 z-10 max-h-[40%] overflow-y-auto",
          )}
        >
          <div hidden={!!activeDevice}>
            {diagnostics.map((diagnostic) => (
              <DeviceDiscoveryWarning
                key={diagnostic.hostId}
                label={diagnostic.label}
                detail={diagnostic.detail}
                incompletePlatforms={diagnostic.incompletePlatforms}
                onRetry={() => store.list({}, { reportFailure: false })}
              />
            ))}
          </div>
          <DeviceHostUpdates state={state} />
          {bootingDevices.length > 0 ? (
            <div role="status" className="border-b px-3 py-2 text-xs text-muted-foreground">
              Starting {bootingDevices.map((device) => device.name).join(", ")}… This can take a
              minute.
            </div>
          ) : null}
          {operationError ? (
            <DeviceNotice onDismiss={() => setOperation(null)}>{operationError}</DeviceNotice>
          ) : null}
        </div>
        <div className="@container relative flex min-h-0 flex-1">
          {activeDevice && activeSession ? (
            <DeviceWorkspace
              key={deviceKey(activeDevice)}
              device={activeDevice}
              hostLabel={activeHost?.label ?? "Device host"}
              hostKind={activeHost?.kind}
              hostDiagnostics={
                diagnostics.find(({ hostId }) => hostId === activeDevice.hostId)?.detail
              }
              visible={visible}
              onFloat={floatActive}
              onClose={() => closeActive(false)}
              onPowerOff={() => closeActive(true)}
            />
          ) : loading ? (
            <DeviceLoadingView
              name={pendingDevice?.name ?? "Devices"}
              description={
                pendingDevice
                  ? `${state.hosts.find((host) => host.id === pendingDevice.hostId)?.label ?? "Device host"} · ${pendingDevice.version}`
                  : ""
              }
              stage="opening"
              message={
                loadError ??
                (pendingDevice
                  ? pendingDevice.booted
                    ? "Opening device…"
                    : "Starting device…"
                  : state.hostStatus === "installing"
                    ? (state.hostStatusDetail ?? "Installing device support…")
                    : "Finding devices…")
              }
              error={loadError !== null}
            >
              {loadError !== null ? (
                <Button size="sm" variant="outline" onClick={refreshState}>
                  Retry
                </Button>
              ) : null}
            </DeviceLoadingView>
          ) : (
            <div className="scrollbar-gutter-both flex size-full flex-col overflow-y-auto px-5 py-8 text-sm text-muted-foreground">
              <div
                className={cn(
                  "mx-auto flex w-full max-w-xl flex-col gap-6",
                  grouped.length === 0 && "my-auto items-center text-center",
                )}
              >
                {grouped.length === 0 ? (
                  <>
                    <Smartphone className="size-6 opacity-60" />
                    <p
                      className="max-h-32 w-full max-w-sm overflow-y-auto whitespace-pre-line break-words"
                      tabIndex={state.hostStatus === "failed" ? 0 : undefined}
                    >
                      {state.hostStatus === "failed"
                        ? (state.hostStatusDetail ?? "The device hub failed to start.")
                        : "No simulators or emulators were found on this environment."}
                    </p>
                  </>
                ) : null}
                {hostReady && grouped.length > 0 ? (
                  <div className="w-full space-y-6 text-left">
                    {grouped.map((group) => (
                      <section key={group.platform} className="space-y-3">
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Smartphone className="size-4 shrink-0" />
                          <h3 className="font-medium">{platformLabel(group.platform)}</h3>
                        </div>
                        <DiscoveryList>
                          {group.devices.map((device) => (
                            <div
                              key={deviceKey(device)}
                              className="flex items-center gap-3 px-3 py-3"
                            >
                              <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border/60">
                                <Smartphone className="size-4" />
                              </span>
                              <div className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate text-sm font-medium text-foreground">
                                  {device.name}
                                </span>
                                <span className="truncate text-xs text-muted-foreground">
                                  {`${state.hosts.find((host) => host.id === device.hostId)?.label} · ${device.version} · ${device.booted ? "Running" : "Stopped"}`}
                                </span>
                              </div>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={pendingDeviceKey !== null}
                                aria-label={`${device.booted ? "Open" : "Start"} ${device.name}`}
                                onClick={() => void selectDevice(deviceKey(device))}
                              >
                                {pendingDeviceKey === deviceKey(device) ? (
                                  <Spinner size="xs" />
                                ) : device.booted ? (
                                  <ArrowUpRight />
                                ) : (
                                  <Play />
                                )}
                                {device.booted ? "Open" : "Start"}
                              </Button>
                            </div>
                          ))}
                        </DiscoveryList>
                      </section>
                    ))}
                  </div>
                ) : null}
                {hostReady &&
                !isAndroidDiscoveryUncertain(state) &&
                !state.devices.some((device) => device.platform === "android") &&
                !unavailablePlatforms.some((platform) => platform.platform === "android") ? (
                  <p className="max-w-sm text-xs">
                    No Android virtual devices found. Create one in Android Studio's Device Manager,
                    then refresh.
                  </p>
                ) : null}
                {loaded && !hostBusy ? (
                  <Button
                    className={grouped.length > 0 ? "self-start" : "self-center"}
                    variant="outline"
                    size="sm"
                    onClick={() => void store.list({}, { reportFailure: false })}
                  >
                    Refresh devices
                  </Button>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DeviceNotice(props: { readonly onDismiss: () => void; readonly children: ReactNode }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 border-b bg-destructive-indicator/5 px-3 py-2 text-xs text-destructive-indicator"
    >
      <CircleAlert className="mt-1 size-3.5 shrink-0" />
      <div
        className="max-h-32 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words"
        tabIndex={0}
      >
        {props.children}
      </div>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Dismiss device error"
        onClick={props.onDismiss}
      >
        <X />
      </Button>
    </div>
  );
}

function DeviceDiscoveryWarning(props: {
  readonly label: string;
  readonly detail: string;
  readonly incompletePlatforms: readonly DevicePlatform[];
  readonly onRetry: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [dismissedCause, setDismissedCause] = useState<string | null>(null);
  const cause = `${props.incompletePlatforms.join()}\u0000${props.detail}`;
  // A dismissal hides one occurrence; a cause that returns later shows again.
  if (dismissedCause !== null && dismissedCause !== cause) setDismissedCause(null);
  if (dismissedCause === cause) return null;
  const platforms = props.incompletePlatforms.map((platform) =>
    platform === "ios" ? "iOS" : "Android",
  );
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b px-3 py-1 text-xs text-muted-foreground"
    >
      <span className="flex min-w-0 flex-1 basis-56 items-start gap-2">
        <CircleAlert className="mt-px size-3.5 shrink-0 text-warning-foreground" />
        <span className="min-w-0">
          {platforms.length > 0
            ? `${platforms.join(" and ")} ${platforms.length > 1 ? "lists" : "list"} on ${props.label} may be incomplete.`
            : `Device discovery on ${props.label} reported a warning.`}
        </span>
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-0.5">
        {platforms.length > 0 ? (
          <Button
            size="micro"
            variant="ghost"
            disabled={retrying}
            aria-label={`Retry device discovery on ${props.label}`}
            onClick={() => {
              setRetrying(true);
              void props.onRetry().finally(() => setRetrying(false));
            }}
          >
            {retrying ? "Retrying…" : "Retry"}
          </Button>
        ) : null}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            aria-label={`Details for ${props.label}`}
            render={<Button size="micro" variant="ghost" />}
          >
            Details
          </PopoverTrigger>
          <PopoverPopup side="bottom" align="end" width="lg" padding="compact">
            <p className="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
              {props.detail}
            </p>
          </PopoverPopup>
        </Popover>
        <Button
          size="icon-micro"
          variant="ghost"
          aria-label={`Dismiss device warning for ${props.label}`}
          onClick={() => {
            setOpen(false);
            setDismissedCause(cause);
          }}
        >
          <X />
        </Button>
      </span>
    </div>
  );
}

function groupDevices(state: DeviceServiceState) {
  const groups: Array<{ platform: DevicePlatform; devices: DeviceSummary[] }> = [];
  for (const platform of ["ios", "android"] as const) {
    const devices = state.devices
      .filter((device) => device.platform === platform)
      .toSorted((a, b) => Number(b.booted) - Number(a.booted) || a.name.localeCompare(b.name));
    if (devices.length > 0) groups.push({ platform, devices });
  }
  return groups;
}
