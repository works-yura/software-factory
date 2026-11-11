import { assert, describe, it } from "vitest";

import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  OrchestrationV2ContextHandoff,
  type OrchestrationV2HistoricalMessage,
  type OrchestrationV2ProviderThread,
} from "./contracts.ts";
import {
  THREAD_READ_TOOL_NAME,
  contextUsageForHandoff,
  handoffBudget,
  historyCost,
  historyResponseItems,
  selectHistory,
  historicalMessage,
} from "./handoffBudget.ts";
import { projectContextHandoffForWire } from "./WireProjection.ts";
import {
  deliverContextHandoffs,
  type ProviderAdapterV2HistoricalContext,
} from "./ContextHandoffDelivery.ts";

const decodeHandoff = (value: unknown) => OrchestrationV2ContextHandoff.parse(value);

const now = "2026-09-17T00:00:00.000Z";
const threadId = "thread:handoff";
const providerThread: OrchestrationV2ProviderThread = {
  id: "provider-thread:target",
  driver: "codex",
  providerInstanceId: "codex",
  providerSessionId: null,
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: {
    driver: "codex",
    strength: "strong",
    nativeId: "native:target",
  },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
};
const message = (
  id: string,
  role: "user" | "assistant",
  text: string,
): OrchestrationV2HistoricalMessage => ({
  itemId: id,
  role,
  text,
  threadId,
  runId: "run:source",
  providerThreadId: "provider-thread:source",
  status: "interrupted",
  kind: role === "user" ? "user_message" : "assistant_message",
});
const messages = [
  message("item:one", "user", "Preserve every line.\n\n  And this indentation.\n"),
  message("item:two", "assistant", "Partial work: 日本語 🧪 مرحبا\n" + "x".repeat(600)),
];
const handoff: OrchestrationV2ContextHandoff = {
  id: "handoff:one",
  threadId,
  targetRunId: "run:target",
  fromProviderThreadIds: [],
  toProviderThreadId: providerThread.id,
  coveredRunOrdinals: { from: 1, to: 2 },
  strategy: "full_thread_summary",
  status: "ready",
  summaryMessageId: null,
  summaryText: "",
  history: {
    messages,
    coverage: `Historical context; retrieve thread:handoff with ${THREAD_READ_TOOL_NAME}.`,
    omittedItems: 0,
  },
  createdByProviderInstanceId: null,
  createdAt: now,
  updatedAt: now,
};

const failure = async (promise: Promise<unknown>) =>
  promise.then(
    () => ({ _tag: "Success" as const }),
    (error: unknown) => ({ _tag: "Failure" as const, error }),
  );

describe("handoff budget", () => {
  it("keeps old preview handoffs readable and delivery history off the wire", () => {
    const projected = projectContextHandoffForWire({
      ...handoff,
      summaryText: "private transcript and command output",
      delivery: {
        nativeThreadId: "native:target",
        status: "injected",
        itemIds: [messages[0]!.itemId],
      },
    });
    assert.equal(projected.summaryText, "");
    assert.isUndefined(projected.history);
    assert.isUndefined(projected.delivery);
    assert.equal(decodeHandoff(projected).id, handoff.id);
    assert.deepEqual(handoff.history?.messages, messages);
  });
  it("carries command outcomes as attributed activity and excludes reasoning", () => {
    const base = {
      id: "item:command",
      threadId,
      runId: "run:source",
      nodeId: null,
      providerThreadId: providerThread.id,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "failed" as const,
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    };
    const command = historicalMessage({
      ...base,
      type: "command_execution",
      input: "vp test",
      output: "Failure near the end: " + "界".repeat(300),
      exitCode: 1,
    });
    assert.equal(command?.role, "assistant");
    assert.equal(command?.kind, "command_execution");
    assert.include(command!.text, "Exit code: 1");
    assert.include(command!.text, "界".repeat(300));
    assert.equal(
      historicalMessage({
        ...base,
        type: "file_change",
        fileName: "src/a.ts",
        changes: [
          { operation: "update", path: "src/a.ts" },
          { operation: "add", path: "src/b.ts" },
          { operation: "update", path: "src/new.ts", oldPath: "src/old.ts" },
        ],
      })?.text,
      "File change: src/a.ts, src/b.ts, src/new.ts",
    );
    assert.isNull(
      historicalMessage({
        ...base,
        type: "reasoning",
        text: "private reasoning",
        streaming: false,
      }),
    );
    assert.equal(historyResponseItems([command!], "Activity")[1]?.type, "message");
  });

  it("omits oversized multilingual items whole, preserves original constraints and recent work", () => {
    const candidates = [
      messages[0]!,
      message("huge", "assistant", "界🧪".repeat(20_000)),
      message("old", "assistant", "a".repeat(4_000)),
      messages[1]!,
    ];
    const selected = selectHistory({
      messages: candidates,
      coverage: "thread:handoff runs 1-4",
      budget: 3_000,
    });
    assert.deepEqual(selected.messages, messages);
    assert.equal(selected.omittedItems, 2);
    assert.isAtMost(historyCost(selected.messages, selected.context), 3_000);
  });

  it("counts JSON escaping and UTF-8 bytes across many messages", () => {
    const candidates = Array.from({ length: 500 }, (_, i) =>
      message(`item:${i}`, i % 2 ? "assistant" : "user", '\u0000\\"🧪界'.repeat(15)),
    );
    for (const budget of [1_024, 4_000, 16_000]) {
      const selected = selectHistory({
        messages: candidates,
        coverage: "Retrieve omitted history",
        budget,
      });
      assert.isAtMost(historyCost(selected.messages, selected.context), budget);
      assert.isAbove(selected.omittedItems, 0);
    }
  });

  it("fits the final envelope at intermediate selected/omitted digit boundaries", () => {
    const candidates = Array.from({ length: 20 }, (_, index) =>
      message(`boundary:${index}`, "user", "Short request"),
    );
    for (let budget = 4_000; budget <= 9_000; budget++) {
      const selected = selectHistory({
        messages: candidates,
        coverage: "Recover history",
        omittedItems: 90,
        budget,
      });
      assert.isAtMost(historyCost(selected.messages, selected.context), budget);
    }
  });

  it("subtracts native usage, input, attachments, instructions and space for work", () => {
    const base = {
      tokenCap: 16_000,
      userText: "Continue",
      attachments: [],
      providerThread,
      nativeContextEstimate: 0,
      modelContextWindow: 32_000,
    };
    assert.isBelow(handoffBudget(base), 16_000);
    assert.isBelow(handoffBudget({ ...base, nativeContextEstimate: 8_000 }), handoffBudget(base));
    assert.equal(handoffBudget({ ...base, userText: "界".repeat(30_000) }), 0);
    assert.equal(
      handoffBudget({
        ...base,
        providerThread: {
          ...providerThread,
          contextUsage: { usedTokens: 23_000, maxTokens: 24_000 },
        },
      }),
      0,
    );
    for (const sizeBytes of [100_000, 10 * 1024 * 1024]) {
      const attachments = [
        {
          type: "image" as const,
          id: "attachment",
          name: "image.png",
          mimeType: "image/png",
          sizeBytes,
        },
      ];
      const withImage = handoffBudget({ ...base, attachments });
      assert.isAbove(withImage, 4_000);
      assert.isBelow(withImage, handoffBudget(base));
      assert.equal(handoffBudget({ ...base, attachments: [...attachments, ...attachments] }), 0);
      assert.equal(
        handoffBudget({
          ...base,
          tokenCap: 64_000,
          modelContextWindow: 1_000_000,
          userText: "x".repeat(70_000),
          attachments,
          providerThread: {
            ...providerThread,
            contextUsage: { usedTokens: 0, maxTokens: 1_000_000 },
          },
        }),
        64_000,
      );
    }
    assert.equal(handoffBudget({ ...base, tokenCap: 2_000 }), 2_000);
  });

  it("keeps measured occupancy across a model change", () => {
    const previous = {
      usedTokens: 37_321,
      maxTokens: 258_400,
      autoCompactThreshold: 32_000,
    };
    assert.isNull(
      contextUsageForHandoff({
        sameNativeThread: false,
        sameSelection: false,
        reuseTelemetry: false,
        previousUsage: previous,
      }),
    );
    assert.equal(
      contextUsageForHandoff({
        sameNativeThread: true,
        sameSelection: true,
        reuseTelemetry: true,
        previousUsage: previous,
      }),
      previous,
    );
    assert.deepEqual(
      contextUsageForHandoff({
        sameNativeThread: true,
        sameSelection: false,
        reuseTelemetry: true,
        previousUsage: previous,
      }),
      { usedTokens: 37_321, maxTokens: 258_400 },
    );
    assert.deepEqual(
      contextUsageForHandoff({
        sameNativeThread: true,
        sameSelection: false,
        reuseTelemetry: false,
        previousUsage: previous,
      }),
      { usedTokens: 37_321, maxTokens: 258_400 },
    );
    assert.deepEqual(
      contextUsageForHandoff({
        sameNativeThread: true,
        sameSelection: false,
        reuseTelemetry: false,
        previousUsage: { usedTokens: 30_000, maxTokens: 32_000, autoCompactThreshold: 31_000 },
        knownModelWindow: 1_000_000,
      }),
      { usedTokens: 30_000, maxTokens: 1_000_000 },
    );

    const preserved = contextUsageForHandoff({
      sameNativeThread: true,
      sameSelection: false,
      reuseTelemetry: false,
      previousUsage: previous,
    });
    assert.equal(
      handoffBudget({
        tokenCap: 16_000,
        userText: "Continue work",
        attachments: [
          {
            type: "image",
            id: "screenshot-a",
            name: "a.png",
            mimeType: "image/png",
            sizeBytes: 100_000,
          },
          {
            type: "image",
            id: "screenshot-b",
            name: "b.png",
            mimeType: "image/png",
            sizeBytes: 100_000,
          },
        ],
        providerThread: { ...providerThread, contextUsage: preserved },
        nativeContextEstimate: 0,
        modelContextWindow: preserved?.maxTokens,
      }),
      16_000,
    );
    assert.equal(
      handoffBudget({
        tokenCap: 16_000,
        userText: "Continue work",
        attachments: [],
        providerThread,
        nativeContextEstimate: 120_000,
      }),
      0,
    );
  });
  it("reserves context for image batches up to the attachment limit, honoring smaller known windows", () => {
    let previousBudget = 16_000;
    for (let count = 1; count <= PROVIDER_SEND_TURN_MAX_ATTACHMENTS; count++) {
      const input = {
        tokenCap: 16_000,
        userText: "Compare these screenshots",
        providerThread,
        nativeContextEstimate: 0,
        attachments: Array.from({ length: count }, (_, index) => ({
          type: "image" as const,
          id: `image-${index}`,
          name: "image.png",
          mimeType: "image/png",
          sizeBytes: 100_000,
        })),
      };
      const budget = handoffBudget(input);
      assert.isAtLeast(budget, 0);
      assert.isAtMost(budget, previousBudget);
      previousBudget = budget;
      if (count <= 8) assert.equal(budget, 16_000);
      if (count === 10) {
        assert.isAbove(budget, 0);
        assert.isBelow(budget, 16_000);
      }
      if (count === PROVIDER_SEND_TURN_MAX_ATTACHMENTS) assert.equal(budget, 0);
      if (budget > 0) {
        const selected = selectHistory({ messages, coverage: "Recover omitted history", budget });
        assert.isAtMost(historyCost(selected.messages, selected.context), budget);
      }
      assert.equal(handoffBudget({ ...input, modelContextWindow: 2_000_000 }), 16_000);
      assert.equal(handoffBudget({ ...input, modelContextWindow: 20_000 }), 0);
      assert.equal(
        handoffBudget({
          ...input,
          providerThread: { ...providerThread, contextUsage: { usedTokens: 0, maxTokens: 20_000 } },
        }),
        0,
      );
      assert.equal(
        handoffBudget({
          ...input,
          modelContextWindow: 1_000_000,
          providerThread: {
            ...providerThread,
            contextUsage: { usedTokens: 0, maxTokens: 1_000_000, autoCompactThreshold: 20_000 },
          },
        }),
        0,
      );
    }
  });
});

describe("handoff delivery", () => {
  it.each([
    { native: true, label: "injected" },
    { native: false, label: "inline" },
  ])("records omitted recovery coverage separately from $label text", async ({ native }) => {
    const omittedBeforeDelivery = "item:omitted-during-preparation";
    const oversized = message("item:oversized", "user", "x".repeat(20_000));
    let durable: OrchestrationV2ContextHandoff = {
      ...handoff,
      history: {
        ...handoff.history!,
        messages: [...messages, oversized],
        omittedItems: 1,
        omittedItemIds: [omittedBeforeDelivery],
      },
    };
    const result = await deliverContextHandoffs({
      handoffs: [durable],
      providerThread,
      budget: 16_000,
      alreadyDeliveredItemIds: new Set(),
      inject: async (value) => {
        assert.include(value.context, "omitted 2 items");
        assert.notInclude(
          value.messages.map((item) => item.itemId),
          oversized.itemId,
        );
        return native;
      },
      persist: async (value) => {
        durable = value;
      },
    });
    assert.equal(durable.delivery?.status, native ? "injected" : "pending");
    await result.delivered();
    assert.equal(durable.delivery?.status, native ? "injected" : "inline");
    assert.deepEqual(
      durable.delivery?.itemIds,
      messages.map((item) => item.itemId),
    );
    assert.deepEqual(durable.delivery?.omittedItemIds, [omittedBeforeDelivery, oversized.itemId]);
    assert.deepEqual(decodeHandoff(durable).delivery, durable.delivery);
  });

  it("persists successful injection before turn start and skips it on retry", async () => {
    let durable = handoff;
    const history: unknown[] = [];
    const statuses: string[] = [];
    const input = {
      providerThread,
      budget: 16_000,
      alreadyDeliveredItemIds: new Set<string>(),
      inject: async (value: ProviderAdapterV2HistoricalContext) => {
        history.push(...historyResponseItems(value.messages, value.context));
        return true;
      },
      persist: async (value: OrchestrationV2ContextHandoff) => {
        durable = value;
        statuses.push(value.delivery!.status);
      },
    };
    const first = await deliverContextHandoffs({ ...input, handoffs: [durable] });
    assert.equal(first.context, "");
    assert.deepEqual(statuses, ["pending", "injected"]);
    assert.lengthOf(history, 3);
    const second = await deliverContextHandoffs({ ...input, handoffs: [durable] });
    assert.equal(second.context, "");
    assert.lengthOf(history, 3);
  });

  it("uses the same selection on explicit native fallback, marking only accepted input", async () => {
    let durable = handoff;
    const result = await deliverContextHandoffs({
      handoffs: [handoff],
      providerThread,
      budget: 16_000,
      alreadyDeliveredItemIds: new Set(),
      inject: async () => false,
      persist: async (value) => {
        durable = value;
      },
    });
    assert.include(result.context, messages[0]!.text);
    assert.include(result.context, messages[1]!.text);
    assert.equal(durable.delivery?.status, "pending");
    await result.delivered();
    assert.equal(durable.delivery?.status, "inline");
  });

  it("defers unsupported compaction history until a normal turn without marking delivery uncertain", async () => {
    let durable = handoff;
    const persist = async (value: OrchestrationV2ContextHandoff) => {
      durable = value;
    };
    const compact = await deliverContextHandoffs({
      handoffs: [durable],
      providerThread,
      budget: 16_000,
      alreadyDeliveredItemIds: new Set(),
      deferInline: true,
      inject: async () => false,
      persist,
    });
    await compact.delivered();
    assert.equal(compact.context, "");
    assert.isUndefined((() => durable.delivery)());
    const next = await deliverContextHandoffs({
      handoffs: [durable],
      providerThread,
      budget: 16_000,
      alreadyDeliveredItemIds: new Set(),
      inject: async () => false,
      persist,
    });
    assert.include(next.context, messages[0]!.text);
    await next.delivered();
    assert.equal(durable.delivery?.status, "inline");
  });

  it("bounds accumulated recovery markers while keeping omitted history discoverable", async () => {
    const many = Array.from({ length: 100 }, (_, index) => ({
      ...handoff,
      id: `handoff:retry:${index}`,
    }));
    let captured: ProviderAdapterV2HistoricalContext | undefined;
    const result = await deliverContextHandoffs({
      handoffs: many,
      providerThread,
      budget: 2_500,
      alreadyDeliveredItemIds: new Set(),
      inject: async (history) => {
        captured = history;
        return true;
      },
      persist: async () => {},
    });
    assert.equal(result.context, "");
    assert.isDefined(captured);
    assert.include(captured!.context, "detailed coverage references omitted");
    assert.include(captured!.context, THREAD_READ_TOOL_NAME);
    assert.include(captured!.context, threadId);
    assert.isAtMost(historyCost(captured!.messages, captured!.context), 2_500);
    assert.isAbove(captured!.messages.length, 0);
  });

  it("does not redeliver after ambiguous injection failure", async () => {
    let durable = handoff;
    let calls = 0;
    const input = {
      providerThread,
      budget: 16_000,
      alreadyDeliveredItemIds: new Set<string>(),
      inject: async (): Promise<boolean> => {
        calls++;
        throw new Error("connection lost");
      },
      persist: async (value: OrchestrationV2ContextHandoff) => {
        durable = value;
      },
    };
    await failure(deliverContextHandoffs({ ...input, handoffs: [durable] }));
    assert.equal(durable.delivery?.status, "pending");
    const retry = await failure(deliverContextHandoffs({ ...input, handoffs: [durable] }));
    assert.equal(retry._tag, "Failure");
    assert.equal(calls, 1);
  });

  it("budgets multiple handoffs together and skips previously delivered items", async () => {
    const extra = {
      ...handoff,
      id: "handoff:two",
      history: {
        ...handoff.history!,
        messages: [...messages, message("item:three", "assistant", "Latest result")],
      },
    };
    let delivered: ReadonlyArray<unknown> = [];
    await deliverContextHandoffs({
      handoffs: [handoff, extra],
      providerThread,
      budget: 2_500,
      alreadyDeliveredItemIds: new Set(["item:one"]),
      inject: async (value) => {
        delivered = historyResponseItems(value.messages, value.context);
        return true;
      },
      persist: async () => {},
    });
    const serialized = JSON.stringify(delivered);
    assert.isAtMost(Buffer.byteLength(serialized), 2_500);
    assert.notInclude(serialized, "Preserve every line");
    assert.equal(serialized.split("Partial work").length - 1, 1);
    assert.include(serialized, "Latest result");
  });

  it("fails before delivery when even the coverage marker cannot fit", async () => {
    let calls = 0;
    const result = await failure(
      deliverContextHandoffs({
        handoffs: [handoff],
        providerThread,
        budget: 0,
        alreadyDeliveredItemIds: new Set(),
        inject: async () => {
          calls++;
          return true;
        },
        persist: async () => {},
      }),
    );
    assert.equal(result._tag, "Failure");
    assert.equal(calls, 0);
  });
});
