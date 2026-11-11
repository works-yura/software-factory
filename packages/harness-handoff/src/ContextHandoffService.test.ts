import { assert, describe, it } from "vitest";

import type { OrchestrationV2AppThread, OrchestrationV2TurnItem } from "./contracts.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import { HandoffThreadNotFoundError } from "./errors.ts";
import { THREAD_READ_TOOL_NAME } from "./handoffBudget.ts";

const service = ContextHandoffService.makeContextHandoffService({ tokenCap: 16_000 });

function importedItem(
  input:
    | {
        readonly role: "user";
        readonly id: string;
        readonly text: string;
        readonly ordinal: number;
      }
    | {
        readonly role: "assistant";
        readonly id: string;
        readonly text: string;
        readonly ordinal: number;
      },
): OrchestrationV2TurnItem {
  const now = "2026-01-01T00:00:00.000Z";
  const base = {
    id: `turn-item:${input.id}`,
    threadId: "thread:legacy-context",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    messageId: `message:${input.id}`,
    text: input.text,
  };
  return input.role === "user"
    ? {
        ...base,
        createdBy: "user",
        creationSource: "server",
        type: "user_message",
        inputIntent: "turn_start",
        attachments: [],
      }
    : {
        ...base,
        type: "assistant_message",
        streaming: false,
      };
}

describe("ContextHandoffService legacy import", () => {
  it("prepares imported history for the first native v2 turn", async () => {
    const handoff = await service.prepareLegacyImport({
      threadId: "thread:legacy-context",
      targetRunId: "run:first-v2",
      toProviderThreadId: "provider-thread:first-v2",
      toProviderInstanceId: "codex",
      items: [
        importedItem({ role: "user", id: "one", text: "What did we decide?", ordinal: 1 }),
        importedItem({
          role: "assistant",
          id: "two",
          text: "We decided to keep the migration lightweight.",
          ordinal: 2,
        }),
      ],
      createdAt: "2026-01-02T00:00:00.000Z",
    });

    assert.equal(handoff.strategy, "manual_context");
    assert.deepStrictEqual(handoff.fromProviderThreadIds, []);
    assert.include(handoff.summaryText, "What did we decide?");
    assert.include(handoff.summaryText, "keep the migration lightweight");
  });

  it("preserves role attribution when truncating imported history", async () => {
    const handoff = await service.prepareLegacyImport({
      threadId: "thread:legacy-context",
      targetRunId: "run:first-v2",
      toProviderThreadId: "provider-thread:first-v2",
      toProviderInstanceId: "codex",
      items: [
        importedItem({
          role: "user",
          id: "long",
          text: `${"x".repeat(35_000)} retained final words`,
          ordinal: 1,
        }),
      ],
      createdAt: "2026-01-02T00:00:00.000Z",
    });

    assert.isAtMost(handoff.summaryText.length, 32_000);
    assert.include(handoff.summaryText, "User:\n... retained final words");
    assert.notMatch(handoff.summaryText, /\n+x+ retained final words/);
  });

  it("retains the newest oversized import even when it has no whitespace", async () => {
    const handoff = await service.prepareLegacyImport({
      threadId: "thread:legacy-context",
      targetRunId: "run:first-v2",
      toProviderThreadId: "provider-thread:first-v2",
      toProviderInstanceId: "codex",
      items: [
        importedItem({
          role: "assistant",
          id: "older",
          text: "older message",
          ordinal: 1,
        }),
        importedItem({
          role: "user",
          id: "long-single-token",
          text: `${"🧪".repeat(20_000)}LATEST_SINGLE_TOKEN`,
          ordinal: 2,
        }),
      ],
      createdAt: "2026-01-02T00:00:00.000Z",
    });

    assert.include(handoff.history?.omittedItemIds ?? [], "turn-item:long-single-token");
    assert.isAtMost(handoff.summaryText.length, 32_000);
    assert.include(handoff.summaryText, "User:\n... ");
    assert.include(handoff.summaryText, "LATEST_SINGLE_TOKEN");
    assert.notInclude(handoff.summaryText, "�");
  });
});

it("caps the side chat context block without summarizing discarded parent history", async () => {
  const parentThreadId = "thread:side-chat-parent";
  let summarizedItems = 0;
  const parentItems = Array.from({ length: 60 }, (_, index) => ({
    ...importedItem({
      role: index % 2 === 0 ? "user" : "assistant",
      id: `parent-${index}`,
      text: `item-${index} ${"x".repeat(228)}😀${"x".repeat(70)}`,
      ordinal: index,
    }),
    get text() {
      summarizedItems++;
      return `item-${index} ${"x".repeat(228)}😀${"x".repeat(70)}`;
    },
  })) as unknown as ReadonlyArray<OrchestrationV2TurnItem>;
  const handoff = await service.prepareSideChatContext({
    parentThreadId,
    threadId: "thread:side-chat",
    targetRunId: "run:side-chat",
    transferId: "transfer:side-chat",
    toProviderThreadId: "provider-thread:side-chat",
    fromProviderInstanceId: "codex",
    toProviderInstanceId: "codex",
    coveredRunOrdinals: { from: 1, to: 1 },
    parentItems,
    createdAt: new Date(0).toISOString(),
  });
  const context = handoff.summaryText;
  assert.isBelow(summarizedItems, parentItems.length);

  assert.include(context, "- Earlier items truncated.");
  assert.notInclude(context, "item-0 ");
  assert.include(context, "- Assistant: item-59 ");
  assert.isAtMost(context.length, 8_000);
  assert.isTrue(context.isWellFormed());
  assert.isTrue(
    context.endsWith(
      `Use ${THREAD_READ_TOOL_NAME} on thread ${parentThreadId} to see the main thread's live state.`,
    ),
  );

  const framingOnly = ContextHandoffService.makeSideChatContext({
    parentThreadId,
    digest: [],
  });
  assert.isTrue(framingOnly.startsWith("You are in a side chat beside the main thread."));
  assert.notInclude(framingOnly, "Main thread activity");

  const multiFilePatch = ContextHandoffService.makeSideChatContext({
    parentThreadId,
    digest: [
      {
        id: "turn-item:patch",
        threadId: parentThreadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 60,
        status: "completed",
        title: null,
        startedAt: null,
        completedAt: null,
        updatedAt: new Date(0).toISOString(),
        type: "file_change",
        fileName: "src/a.ts",
        changes: [
          { operation: "update", path: "src/a.ts" },
          { operation: "add", path: "src/b.ts" },
          { operation: "update", path: "src/new.ts", oldPath: "src/old.ts" },
        ],
      },
    ],
  });
  assert.include(multiFilePatch, "- File change: src/a.ts, src/b.ts, src/new.ts");
});

it("covers the run range of a very long delta", () => {
  const runs = [
    { id: "run:long-delta-early", ordinal: 2 },
    { id: "run:long-delta-late", ordinal: 5 },
  ];
  const items = Array.from({ length: 150_000 }, (_, index) => ({
    runId: runs[index % 2]!.id,
  }));

  assert.deepEqual(
    ContextHandoffService.visibleDeltaRunOrdinals({ runs }, [...items, { runId: null }]),
    { from: 2, to: 5 },
  );
});

it("inherited history stops at a missing fork ancestor", async () => {
  const now = "2026-01-01T00:00:00.000Z";
  const threadId = "thread:fork-of-missing";
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: "project:fork-of-missing",
    title: "Fork of a missing thread",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: {
      type: "run",
      threadId: "thread:missing-ancestor",
      runId: "run:missing-ancestor",
    },
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    deletedAt: null,
  };
  const items = await ContextHandoffService.readInheritedHandoffItems(
    {
      getThreadRecords: async (missing) => {
        throw new HandoffThreadNotFoundError({ threadId: missing });
      },
    },
    thread,
  );
  assert.deepEqual(items, []);
});
