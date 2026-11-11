import type { OrchestrationV2ContextHandoff } from "./contracts.ts";

/** Clients see that a handoff happened, never the transcript it carried or its delivery state. */
export function projectContextHandoffForWire(
  handoff: OrchestrationV2ContextHandoff,
): OrchestrationV2ContextHandoff {
  const { history: _history, delivery: _delivery, ...projected } = handoff;
  return { ...projected, summaryText: "" };
}
