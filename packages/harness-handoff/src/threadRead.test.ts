// Not in t3code: its thread read is covered by orchestrator integration tests that need the whole
// server. These cover the ported paging, the in-memory timeline index and the env cap.
import { assert, describe, it } from "vitest";

import type {
  OrchestrationV2AppThread,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
} from "./contracts.ts";
import { OrchestratorMcpThreadReadInput } from "./contracts.ts";
import { HandoffThreadNotFoundError } from "./errors.ts";
import { DEFAULT_HANDOFF_TOKEN_CAP, handoffTokenCapFromEnv } from "./handoffBudget.ts";
import type { HandoffHistorySource, HandoffThreadRecords } from "./historySource.ts";
import { readThread, threadReadSourceFromHistory } from "./threadRead.ts";
import { createThreadReadTool } from "./mastra.ts";

const now = "2026-01-01T00:00:00.000Z";

const thread = (id: string, forkedFrom: OrchestrationV2AppThread["forkedFrom"]): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id,
  projectId: "project",
  title: `Thread ${id}`,
  providerInstanceId: "mastra",
  modelSelection: { instanceId: "mastra", model: "anthropic/claude-sonnet" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: {
    parentThreadId: forkedFrom?.threadId ?? null,
    relationshipToParent: forkedFrom ? "fork" : null,
    rootThreadId: "parent",
  },
  forkedFrom,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  deletedAt: null,
});

const run = (threadId: string, id: string, ordinal: number, status: OrchestrationV2Run["status"] = "completed"): OrchestrationV2Run => ({
  id,
  threadId,
  ordinal,
  providerInstanceId: "mastra",
  modelSelection: { instanceId: "mastra", model: "anthropic/claude-sonnet" },
  providerThreadId: null,
  userMessageId: `message:${id}`,
  rootNodeId: null,
  activeAttemptId: null,
  status,
  queuePosition: null,
  requestedAt: now,
  startedAt: now,
  completedAt: now,
  checkpointId: null,
  contextHandoffId: null,
});

const base = (threadId: string, id: string, runId: string) => ({
  id,
  threadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed" as const,
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
});

const user = (threadId: string, id: string, runId: string, text: string): OrchestrationV2TurnItem => ({
  ...base(threadId, id, runId),
  type: "user_message",
  messageId: `message:${id}`,
  text,
  inputIntent: "turn_start",
  attachments: [],
  createdBy: "user",
  creationSource: "web",
});

const assistant = (threadId: string, id: string, runId: string, text: string): OrchestrationV2TurnItem => ({
  ...base(threadId, id, runId),
  type: "assistant_message",
  messageId: `message:${id}`,
  text,
  streaming: false,
});

const records: Record<string, HandoffThreadRecords> = {
  parent: {
    thread: thread("parent", null),
    runs: [run("parent", "p1", 1), run("parent", "p2", 2)],
    attempts: [],
    turnItems: [
      user("parent", "p1:u", "p1", "Build the importer."),
      assistant("parent", "p1:a", "p1", "Done: importer added."),
      { ...base("parent", "p1:cmd", "p1"), type: "command_execution", input: "pnpm test", output: "ok", exitCode: 0 },
      user("parent", "p2:u", "p2", "After the fork point."),
    ],
  },
  child: {
    thread: thread("child", { type: "run", threadId: "parent", runId: "p1" }),
    runs: [run("child", "c1", 1), run("child", "c2", 2, "rolled_back")],
    attempts: [],
    turnItems: [
      user("child", "c1:u", "c1", "Now 🧪".repeat(10)),
      assistant("child", "c2:a", "c2", "Rolled back answer."),
    ],
  },
};

const history: HandoffHistorySource = {
  getThreadRecords: async (threadId, _fields, filter) => {
    const found = records[threadId];
    if (found === undefined) throw new HandoffThreadNotFoundError({ threadId });
    const runIds = filter?.turnItemRunIds;
    return {
      ...found,
      turnItems: runIds === undefined ? found.turnItems : found.turnItems.filter((item) => runIds.includes(item.runId)),
    };
  },
};

describe("thread read", () => {
  const source = threadReadSourceFromHistory(history);

  it("shows inherited rows through the fork run, then the thread's own visible rows", async () => {
    const page = await readThread(source, { threadId: "child", view: "activity" });
    assert.deepEqual(
      page.items.map((item) => [item.itemId, item.visibility]),
      [
        ["p1:u", "inherited"],
        ["p1:a", "inherited"],
        ["p1:cmd", "inherited"],
        ["c1:u", "local"],
      ],
    );
    assert.equal(page.thread.itemCount, 4);
    assert.isFalse(page.hasMore);
  });

  it("pages messages by position and long items by text offset without splitting surrogates", async () => {
    const first = await readThread(source, { threadId: "child", limit: 1 });
    assert.deepEqual(first.items.map((item) => item.itemId), ["p1:u"]);
    assert.isTrue(first.hasMore);
    const second = await readThread(source, { threadId: "child", afterPosition: first.nextPosition!, limit: 5 });
    // `messages` skips the command row.
    assert.deepEqual(second.items.map((item) => item.itemId), ["p1:a", "c1:u"]);

    const head = await readThread(source, { threadId: "child", itemId: "c1:u", maxCharsPerItem: 5 });
    assert.equal(head.items[0]!.text, "Now ");
    assert.isTrue(head.items[0]!.text!.isWellFormed());
    assert.equal(head.items[0]!.nextTextOffset, 4);
    const tail = await readThread(source, { threadId: "child", itemId: "c1:u", textOffset: 4, maxCharsPerItem: 500 });
    assert.isFalse(tail.items[0]!.textTruncated);
    assert.isNull(tail.items[0]!.nextTextOffset);
  });

  it("clamps oversized limits on decode and refuses zero", () => {
    assert.equal(OrchestratorMcpThreadReadInput.parse({ threadId: "t", limit: 500 }).limit, 100);
    assert.isFalse(OrchestratorMcpThreadReadInput.safeParse({ threadId: "t", limit: 0 }).success);
  });

  it("exposes the reader as a Mastra tool", async () => {
    const tool = createThreadReadTool(() => source);
    assert.equal(tool.id, "factory_thread_read");
    const result = (await tool.execute!({ threadId: "parent", view: "activity" }, {} as never)) as Awaited<
      ReturnType<typeof readThread>
    >;
    assert.deepEqual(result.items.map((item) => item.itemId), ["p1:u", "p1:a", "p1:cmd", "p2:u"]);
  });
});

describe("handoff token cap", () => {
  it("defaults, clamps to 1,024–64,000 and ignores non-integers", () => {
    assert.equal(handoffTokenCapFromEnv({}), DEFAULT_HANDOFF_TOKEN_CAP);
    assert.equal(handoffTokenCapFromEnv({ FACTORY_CONTEXT_HANDOFF_TOKEN_CAP: "8000" }), 8_000);
    assert.equal(handoffTokenCapFromEnv({ FACTORY_CONTEXT_HANDOFF_TOKEN_CAP: "10" }), 1_024);
    assert.equal(handoffTokenCapFromEnv({ FACTORY_CONTEXT_HANDOFF_TOKEN_CAP: "999999" }), 64_000);
    assert.equal(handoffTokenCapFromEnv({ FACTORY_CONTEXT_HANDOFF_TOKEN_CAP: "12.5" }), DEFAULT_HANDOFF_TOKEN_CAP);
  });
});
