// Plans a provider or model switch. `makeProviderSwitchService(adapters)` takes the adapter
// registry as an injected interface; a lookup that throws counts as unavailable, and anything
// thrown that is not already a ProviderSwitchPlanError is wrapped in one.
import type {
  ModelSelection,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ThreadProjection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
} from "./contracts.ts";
import { ProviderSwitchPlanError } from "./errors.ts";
import { modelSelectionsEqual } from "./model.ts";
import {
  decideProviderSessionTransition,
  type ProviderSessionTransition,
} from "./ProviderSessionTransitionPolicy.ts";
import type {
  ProviderSelectionTransitionInput,
  ProviderSelectionTransitionPlan,
} from "./selectionTransition.ts";

export interface ProviderSwitchPlanV2 {
  readonly instanceChanged: boolean;
  readonly releaseProviderSessionIds: ReadonlyArray<ProviderSessionId>;
  readonly transition: ProviderSessionTransition;
}

/** The part of a provider adapter a switch plan asks. */
export interface ProviderSwitchAdapter {
  readonly driver: ProviderDriverKind;
  readonly getCapabilities: () => Promise<OrchestrationV2ProviderCapabilities>;
  readonly planSelectionTransition: (
    input: ProviderSelectionTransitionInput,
  ) => Promise<ProviderSelectionTransitionPlan>;
}

export interface ProviderInstanceMetadata {
  readonly driver: ProviderDriverKind;
  /** Instances with the same driver and key can resume each other's native threads. */
  readonly continuationKey: string;
  readonly enabled: boolean;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
}

/** The provider adapter registry: lookups throw for an unknown instance. */
export interface ProviderSwitchAdapterRegistry {
  readonly get: (instanceId: ProviderInstanceId) => Promise<ProviderSwitchAdapter>;
  readonly getMetadata?: (instanceId: ProviderInstanceId) => Promise<ProviderInstanceMetadata>;
}

export interface ProviderSwitchServiceV2Shape {
  readonly plan: (input: {
    readonly projection: Pick<
      OrchestrationV2ThreadProjection,
      "thread" | "providerSessions" | "providerThreads"
    >;
    readonly targetModelSelection: ModelSelection;
  }) => Promise<ProviderSwitchPlanV2>;
}

const isLiveProviderSession = (
  session: OrchestrationV2ThreadProjection["providerSessions"][number],
) => session.status !== "stopped" && session.status !== "error";

const option = async <A>(promise: () => Promise<A>): Promise<A | undefined> => {
  try {
    return await promise();
  } catch {
    return undefined;
  }
};

export function makeProviderSwitchService(
  adapters: ProviderSwitchAdapterRegistry,
): ProviderSwitchServiceV2Shape {
  const plan = async ({
    projection,
    targetModelSelection,
  }: Parameters<ProviderSwitchServiceV2Shape["plan"]>[0]): Promise<ProviderSwitchPlanV2> => {
    const current = projection.thread.modelSelection;
    const instanceChanged = current.instanceId !== targetModelSelection.instanceId;
    const getMetadata = (instanceId: typeof current.instanceId) =>
      adapters.getMetadata !== undefined
        ? adapters.getMetadata(instanceId)
        : adapters.get(instanceId).then((adapter) =>
            adapter.getCapabilities().then((capabilities) => ({
              driver: adapter.driver,
              continuationKey: `${adapter.driver}:instance:${instanceId}`,
              enabled: true,
              capabilities,
            })),
          );
    const currentInstance = await option(() => getMetadata(current.instanceId));
    const targetInstance = await option(() => getMetadata(targetModelSelection.instanceId));
    const targetAdapter = await option(() => adapters.get(targetModelSelection.instanceId));
    const currentSessions = projection.providerSessions
      .filter((session) => session.providerInstanceId === current.instanceId)
      .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    const currentSession = currentSessions.find(isLiveProviderSession);
    const negotiatedCapabilities =
      currentSession?.capabilities ?? currentSessions[0]?.capabilities ?? undefined;
    const currentProviderThread = projection.providerThreads.find(
      (thread) =>
        thread.id === projection.thread.activeProviderThreadId &&
        thread.providerInstanceId === current.instanceId &&
        thread.nativeThreadRef !== null,
    );
    const selectionTransition =
      current.instanceId === targetModelSelection.instanceId &&
      !modelSelectionsEqual(current, targetModelSelection) &&
      targetAdapter !== undefined &&
      currentInstance !== undefined &&
      (currentSession !== undefined || currentProviderThread !== undefined)
        ? await targetAdapter.planSelectionTransition({
            current,
            target: targetModelSelection,
            sessionCapabilities: negotiatedCapabilities ?? currentInstance.capabilities,
          })
        : undefined;
    const transition =
      targetInstance === undefined || targetAdapter === undefined
        ? ({
            type: "reject",
            reason: "The target provider instance is unavailable.",
          } as const)
        : decideProviderSessionTransition({
            current:
              currentInstance === undefined ||
              (currentSession === undefined && currentProviderThread === undefined)
                ? null
                : {
                    driver: currentInstance.driver,
                    continuationIdentity: {
                      driverKind: currentInstance.driver,
                      continuationKey: currentInstance.continuationKey,
                    },
                    modelSelection: current,
                    runtimeMode: projection.thread.runtimeMode,
                    interactionMode: projection.thread.interactionMode,
                    workspace:
                      currentSession?.cwd ??
                      projection.thread.worktreePath ??
                      "<unresolved-workspace>",
                  },
            target: {
              driver: targetInstance.driver,
              continuationIdentity: {
                driverKind: targetInstance.driver,
                continuationKey: targetInstance.continuationKey,
              },
              modelSelection: targetModelSelection,
              runtimeMode: projection.thread.runtimeMode,
              interactionMode: projection.thread.interactionMode,
              workspace:
                projection.thread.worktreePath ?? currentSession?.cwd ?? "<unresolved-workspace>",
              available: targetInstance.enabled,
            },
            ...(selectionTransition === undefined ? {} : { selectionTransition }),
          });
    if (transition.type === "reject") {
      throw new ProviderSwitchPlanError({
        threadId: projection.thread.id,
        targetProviderInstanceId: targetModelSelection.instanceId,
        cause: transition.reason,
      });
    }
    const releaseProviderSessionIds = projection.providerSessions
      .filter((session) => {
        if (!isLiveProviderSession(session)) return false;
        if (transition.type === "restart_and_resume") {
          // Release only the replaced session; peers can serve pooled or delegated bindings.
          return session.id === currentSession?.id;
        }
        if (transition.type === "create_with_handoff") {
          return session.providerInstanceId !== targetModelSelection.instanceId;
        }
        return false;
      })
      .map((session) => session.id);
    return {
      instanceChanged,
      releaseProviderSessionIds,
      transition,
    };
  };

  return {
    plan: async (input) => {
      try {
        return await plan(input);
      } catch (cause) {
        if (cause instanceof ProviderSwitchPlanError) throw cause;
        throw new ProviderSwitchPlanError({
          threadId: input.projection.thread.id,
          targetProviderInstanceId: input.targetModelSelection.instanceId,
          cause,
        });
      }
    },
  };
}
