// Ported from t3code apps/server/src/orchestration-v2/ProviderSessionTransitionPolicy.ts.
// Changed: imports; `ProviderContinuationIdentity` (provider-core driver.ts) and the mode types inlined.
import type { ModelSelection, ProviderDriverKind } from "./contracts.ts";
import { modelSelectionsEqual } from "./model.ts";
import type { ProviderSelectionTransitionPlan } from "./selectionTransition.ts";

/** From t3code packages/provider-core/src/server/driver.ts. */
export interface ProviderContinuationIdentity {
  readonly driverKind: ProviderDriverKind;
  readonly continuationKey: string;
}

/** t3code: `RuntimeMode` and `ProviderInteractionMode` literals; a Factory host names its own. */
type RuntimeMode = string;
type ProviderInteractionMode = string;

export type ProviderSessionTransition =
  | { readonly type: "reuse" }
  | { readonly type: "switch_model_in_session" }
  | { readonly type: "restart_and_resume" }
  | { readonly type: "create_with_handoff" }
  | { readonly type: "reject"; readonly reason: string };

export interface ProviderSessionTransitionState {
  readonly driver: ProviderDriverKind;
  readonly continuationIdentity: ProviderContinuationIdentity;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspace: string;
}

export interface ProviderSessionTransitionTarget extends ProviderSessionTransitionState {
  readonly available: boolean;
}

export function decideProviderSessionTransition(input: {
  readonly current: ProviderSessionTransitionState | null;
  readonly target: ProviderSessionTransitionTarget;
  readonly selectionTransition?: ProviderSelectionTransitionPlan;
}): ProviderSessionTransition {
  if (!input.target.available) {
    return { type: "reject", reason: "The target provider instance is unavailable." };
  }
  if (input.current === null) {
    return { type: "create_with_handoff" };
  }

  const current = input.current;
  const target = input.target;
  const continuationCompatible =
    current.continuationIdentity.driverKind === target.continuationIdentity.driverKind &&
    current.continuationIdentity.continuationKey === target.continuationIdentity.continuationKey;
  if (!continuationCompatible || current.driver !== target.driver) {
    return { type: "create_with_handoff" };
  }

  const instanceChanged = current.modelSelection.instanceId !== target.modelSelection.instanceId;
  const runtimeChanged = current.runtimeMode !== target.runtimeMode;
  const workspaceChanged = current.workspace !== target.workspace;
  const selectionChanged = !modelSelectionsEqual(current.modelSelection, target.modelSelection);
  if (selectionChanged && !instanceChanged) {
    switch (input.selectionTransition?.type) {
      case "create_with_handoff":
        return { type: "create_with_handoff" };
      case "reject":
        return { type: "reject", reason: input.selectionTransition.reason };
      case undefined:
        return {
          type: "reject",
          reason: "The provider adapter did not classify the selection change.",
        };
      case "apply_on_next_turn":
      case "restart_session":
        break;
    }
  }
  if (instanceChanged || runtimeChanged || workspaceChanged) {
    return { type: "restart_and_resume" };
  }

  if (selectionChanged) {
    switch (input.selectionTransition?.type) {
      case "apply_on_next_turn":
        return { type: "switch_model_in_session" };
      case "restart_session":
        return { type: "restart_and_resume" };
    }
  }

  // Apply interaction mode on the next turn.
  return { type: "reuse" };
}
