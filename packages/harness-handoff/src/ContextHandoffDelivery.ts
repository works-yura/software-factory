// Delivers pending handoffs to a provider thread. `delivered` / `unsent` are thunks the caller runs
// once the provider accepted (or refused) the prompt; a lazy budget is `() => Promise<number>`;
// failures throw the tagged errors in errors.ts.
import type {
  OrchestrationV2ContextHandoff,
  OrchestrationV2HistoricalMessage,
  OrchestrationV2ProviderThread,
} from "./contracts.ts";
import { ContextHandoffBudgetError, ContextHandoffDeliveryUncertainError } from "./errors.ts";
import {
  THREAD_READ_TOOL_NAME,
  historyCost,
  renderHistory,
  selectHistory,
} from "./handoffBudget.ts";

/** What native history injection receives. */
export interface ProviderAdapterV2HistoricalContext {
  readonly messages: ReadonlyArray<OrchestrationV2HistoricalMessage>;
  readonly context: string;
}

export interface ContextHandoffDeliveryResult {
  /** Inline context for the turn's prompt; empty when injected natively or nothing is pending. */
  readonly context: string;
  /** Run once the provider consumed the prompt that carried `context`. */
  readonly delivered: () => Promise<void>;
  /** Run when the prompt was refused before the provider consumed it. */
  readonly unsent: () => Promise<void>;
}

const noop = async () => {};

/** The provider prompt for a turn that carries inline context ahead of the user's text. */
export const withInlineContext = (context: string, userText: string): string =>
  context === "" ? userText : `${context}\n\nUser message:\n${userText}`;

/** Persist around injection; ambiguous delivery requires a fresh native thread. Call unsent if refused before prompt consumption. */
export async function deliverContextHandoffs(input: {
  readonly handoffs: ReadonlyArray<OrchestrationV2ContextHandoff>;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly budget: number | (() => Promise<number>);
  readonly deferInline?: boolean;
  readonly alreadyDeliveredItemIds: ReadonlySet<string>;
  readonly inject?: (history: ProviderAdapterV2HistoricalContext) => Promise<boolean>;
  readonly persist: (handoff: OrchestrationV2ContextHandoff) => Promise<void>;
}): Promise<ContextHandoffDeliveryResult> {
  const nativeThreadId = input.providerThread.nativeThreadRef?.nativeId ?? undefined;
  const pending = input.handoffs.filter(
    (handoff) =>
      nativeThreadId === undefined ||
      handoff.delivery?.nativeThreadId !== nativeThreadId ||
      handoff.delivery.status === "pending",
  );
  if (pending.length === 0 || (input.deferInline && input.inject === undefined))
    return { context: "", delivered: noop, unsent: noop };
  const budget = typeof input.budget === "number" ? input.budget : await input.budget();
  let coverage = pending
    .map(
      (handoff) =>
        `Context handoff (${handoff.strategy === "fork_delta_summary" ? "merge_back / fork_delta_summary" : handoff.strategy}):\n${
          handoff.history?.coverage ??
          `From thread ${handoff.threadId}, runs ${handoff.coveredRunOrdinals.from}-${handoff.coveredRunOrdinals.to}. Recover history with ${THREAD_READ_TOOL_NAME}, view=activity; paginate with afterPosition, and use itemId/textOffset for long items.`
        }`,
    )
    .join("\n");
  if (historyCost([], coverage) > Math.min(4_000, budget / 2)) {
    const strategies = Array.from(new Set(pending.map((handoff) => handoff.strategy)));
    coverage = `Context handoff (${strategies.join(", ")}). ${pending.length} handoff records; detailed coverage references omitted. Recover history with ${THREAD_READ_TOOL_NAME}({threadId:"${input.providerThread.appThreadId ?? pending[0]!.threadId}",view:"activity",limit:20,maxCharsPerItem:4000}); paginate with afterPosition=nextPosition. Follow fork/handoff source references in activity. For long items use itemId and textOffset=nextTextOffset until null.`;
  }
  const seen = new Set(input.alreadyDeliveredItemIds);
  const messages = pending
    .flatMap((handoff) => handoff.history?.messages ?? [])
    .filter((message) => {
      if (seen.has(message.itemId)) return false;
      seen.add(message.itemId);
      return true;
    });
  const oldContext = pending
    .filter((handoff) => handoff.history === undefined)
    .map((handoff) => handoff.summaryText)
    .join("\n\n");
  const fullCoverage =
    oldContext && historyCost([], `${coverage}\n${oldContext}`) + 512 <= budget
      ? `${coverage}\n${oldContext}`
      : coverage;
  const selected = selectHistory({
    messages,
    coverage: fullCoverage,
    omittedItems: pending.reduce((sum, handoff) => sum + (handoff.history?.omittedItems ?? 0), 0),
    budget,
  });
  if (historyCost(selected.messages, selected.context) > budget) {
    if (input.deferInline) return { context: "", delivered: noop, unsent: noop };
    throw new ContextHandoffBudgetError();
  }
  const omittedItemIds = new Set(selected.omittedItemIds);
  const persist = async (status: "pending" | "injected" | "inline") => {
    for (const handoff of pending) {
      await input.persist({
        ...handoff,
        ...(nativeThreadId === undefined
          ? {}
          : {
              delivery: {
                nativeThreadId,
                status,
                omittedItemIds: [
                  ...(handoff.history?.omittedItemIds ?? []),
                  ...(handoff.history?.messages ?? [])
                    .filter((message) => omittedItemIds.has(message.itemId))
                    .map((message) => message.itemId),
                ],
                itemIds: selected.messages
                  .filter((message) =>
                    handoff.history?.messages.some(
                      (candidate) => candidate.itemId === message.itemId,
                    ),
                  )
                  .map((message) => message.itemId),
              },
            }),
      });
    }
  };
  const persistUnchanged = async () => {
    for (const handoff of pending) await input.persist(handoff);
  };
  if (input.inject !== undefined && nativeThreadId !== undefined) {
    if (
      pending.some(
        (handoff) =>
          handoff.delivery?.nativeThreadId === nativeThreadId &&
          handoff.delivery.status === "pending",
      )
    ) {
      throw new ContextHandoffDeliveryUncertainError();
    }
    await persist("pending");
    const injected = await input.inject({
      messages: selected.messages,
      context: selected.context,
    });
    if (injected) {
      await persist("injected");
      return { context: "", delivered: noop, unsent: noop };
    }
  } else {
    await persist("pending");
  }
  if (input.deferInline) {
    // Compaction cannot carry inline transcripts; retain for the next turn if native injection is unsupported.
    await persistUnchanged();
    return { context: "", delivered: noop, unsent: noop };
  }
  return {
    context: renderHistory(selected.messages, selected.context),
    delivered: () => persist("inline"),
    unsent: persistUnchanged,
  };
}
