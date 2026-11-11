import { assert, it } from "vitest";

import type {
  ModelSelection,
  OrchestrationV2AppThread,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "./contracts.ts";
import { ThreadForkPlanError } from "./errors.ts";
import * as ThreadForkService from "./ThreadForkService.ts";

const sourceThreadId = "thread:fork-snoozed-source";
const targetThreadId = "thread:fork-awake-target";
const sourceRunId = "run:fork-snoozed-source";
const providerInstanceId = "codex";
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;
const sourceCreatedAt = "2026-07-24T09:00:00.000Z";
const snoozedAt = "2026-07-24T09:05:00.000Z";
const snoozedUntil = "2026-07-25T09:00:00.000Z";
const forkCreatedAt = "2026-07-24T09:10:00.000Z";

function makeSourceThread(): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: sourceThreadId,
    projectId: "project:fork-snooze",
    title: "Snoozed source",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "plan",
    branch: "feature/source",
    worktreePath: "/tmp/source-worktree",
    activeProviderThreadId: "provider-thread:fork-snoozed-source",
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: sourceThreadId,
    },
    forkedFrom: null,
    createdAt: sourceCreatedAt,
    updatedAt: snoozedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    snoozedUntil,
    snoozedAt,
    deletedAt: null,
  };
}

function makeSourceRun(status: OrchestrationV2Run["status"]): OrchestrationV2Run {
  return {
    id: sourceRunId,
    threadId: sourceThreadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection,
    providerThreadId: "provider-thread:fork-snoozed-source",
    userMessageId: "message:fork-snoozed-source",
    rootNodeId: null,
    activeAttemptId: null,
    status,
    queuePosition: null,
    requestedAt: sourceCreatedAt,
    startedAt: sourceCreatedAt,
    completedAt: snoozedAt,
    checkpointId: null,
    contextHandoffId: null,
  };
}

function makeSourceProjection(
  _sourceRun: OrchestrationV2Run,
): Pick<OrchestrationV2ThreadProjection, "thread"> {
  return { thread: makeSourceThread() };
}

const planFork = (
  sourceRun: OrchestrationV2Run,
  sourceProjection = makeSourceProjection(sourceRun),
  options: { readonly sideChat?: boolean } = {},
) =>
  ThreadForkService.planThreadFork({
    sourceProjection,
    sourceRun,
    sourceProviderThread: undefined,
    canonicalSourcePoint: {
      threadId: sourceThreadId,
      runId: sourceRunId,
    },
    transferId: "context-transfer:fork-snoozed-source",
    targetThreadId,
    title: "Awake fork",
    ...options,
    createdBy: "user",
    creationSource: "mobile",
    createdAt: forkCreatedAt,
  });

const flip = (plan: () => unknown): ThreadForkPlanError => {
  try {
    plan();
  } catch (error) {
    if (error instanceof ThreadForkPlanError) return error;
    throw error;
  }
  throw new Error("Expected the fork plan to fail.");
};

it("resets a fork's pin, snooze, settle and delegation state but keeps its origin", () => {
  const linkOrigin = { sessionId: "mcp-session:fork-source", label: "Linked laptop" };
  const sourceThread: OrchestrationV2AppThread = {
    ...makeSourceThread(),
    lastSnoozeWakeAt: snoozedAt,
    pinnedAt: snoozedAt,
    pinOrderKey: "a0",
    activeOrderKey: "a1",
    autoSettleDisabledAt: snoozedAt,
    delegatedFrom: {
      environmentId: "linked-environment",
      threadId: "linked-parent",
      title: "Linked parent",
    },
    historyOrigin: "v1_import",
    linkOrigin,
    tags: ["private"],
  };
  const sourceRun = makeSourceRun("completed");
  const result = planFork(sourceRun, {
    ...makeSourceProjection(sourceRun),
    thread: sourceThread,
  });

  assert.isNull(result.targetThread.snoozedUntil);
  assert.isNull(result.targetThread.snoozedAt);
  assert.isNull(result.targetThread.lastSnoozeWakeAt);
  assert.isNull(result.targetThread.pinnedAt);
  assert.isNull(result.targetThread.pinOrderKey);
  assert.isNull(result.targetThread.activeOrderKey);
  assert.isNull(result.targetThread.autoSettleDisabledAt);
  assert.isUndefined(result.targetThread.delegatedFrom);
  assert.equal(result.targetThread.historyOrigin, "v1_import");
  assert.deepEqual(result.targetThread.linkOrigin, linkOrigin);
  assert.deepEqual(result.targetThread.tags, ["private"]);
  assert.equal(result.targetThread.projectId, sourceThread.projectId);
  assert.equal(result.targetThread.providerInstanceId, sourceThread.providerInstanceId);
  assert.deepEqual(result.targetThread.modelSelection, sourceThread.modelSelection);
  assert.equal(result.targetThread.runtimeMode, sourceThread.runtimeMode);
  assert.equal(result.targetThread.interactionMode, sourceThread.interactionMode);
  assert.equal(result.targetThread.branch, sourceThread.branch);
  assert.equal(result.targetThread.worktreePath, sourceThread.worktreePath);
  assert.isNull(result.targetThread.activeProviderThreadId);
  assert.deepEqual(result.targetThread.lineage, {
    parentThreadId: sourceThreadId,
    relationshipToParent: "fork",
    rootThreadId: sourceThreadId,
  });
  assert.deepEqual(result.targetThread.forkedFrom, {
    type: "run",
    threadId: sourceThreadId,
    runId: sourceRunId,
  });
});

it("starts a fork without the source thread's pending title regeneration", () => {
  const sourceRun = makeSourceRun("completed");
  const titleRegeneration = {
    requestId: "command:fork-source-title",
    startedAt: snoozedAt,
  };
  const sourceProjection = {
    ...makeSourceProjection(sourceRun),
    thread: { ...makeSourceThread(), titleRegeneration },
  };
  const result = planFork(sourceRun, sourceProjection);

  assert.isNull(result.targetThread.titleRegeneration);
  assert.deepEqual(sourceProjection.thread.titleRegeneration, titleRegeneration);
});

it("preserves pull request context without inheriting any watches", () => {
  const sourceRun = makeSourceRun("completed");
  const watch = {
    startedAt: sourceCreatedAt,
    headSha: "source-head",
    failedChecks: ["lint"],
    passed: false,
    passedChecks: [],
    remarksThrough: snoozedAt,
    remarkIds: ["review-1"],
    conflicting: true,
    wakes: 2,
  };
  const links = (["agent", "stack", "manual", "stack-dismissed"] as const).map(
    (source, index) => ({
      host: "github.com",
      repository: "example/repo",
      number: index + 1,
      url: `https://github.com/example/repo/pull/${index + 1}`,
      source,
      linkedAt: sourceCreatedAt,
      snapshot: {
        state: "open",
        title: `Pull request ${index + 1}`,
        headBranch: `feature-${index + 1}`,
        baseBranch: "main",
        isDraft: false,
        updatedAt: null,
        syncedAt: snoozedAt,
      },
      stack: {
        kind: "native",
        id: "stack-1",
        number: 1,
        url: "https://github.com/example/repo/stack/1",
        base: "main",
        layers: [{ number: 1, headBranch: "feature-1", state: "open" }],
      },
    }),
  );
  const watchedLinks: ReadonlyArray<Record<string, unknown>> = links.map((link, index) =>
    index < 2 ? { ...link, watch } : link,
  );
  const legacyLink = {
    projectId: makeSourceThread().projectId,
    repository: "example/repo",
    number: 1,
    url: links[0]!.url,
  };
  const sourceProjection = {
    ...makeSourceProjection(sourceRun),
    thread: {
      ...makeSourceThread(),
      pullRequests: [...watchedLinks],
      linkedPullRequest: legacyLink,
      branchPullRequest: legacyLink,
    },
  };
  const result = planFork(sourceRun, sourceProjection);

  assert.deepEqual(result.targetThread.pullRequests, links);
  assert.deepEqual(result.targetThread.linkedPullRequest, legacyLink);
  assert.deepEqual(result.targetThread.branchPullRequest, legacyLink);
  assert.deepEqual(sourceProjection.thread.pullRequests, watchedLinks);
  assert.deepEqual(sourceProjection.thread.pullRequests[0]?.watch, watch);
  assert.deepEqual(sourceProjection.thread.pullRequests[1]?.watch, watch);
});

it("rejects in-progress and rolled-back fork sources", () => {
  for (const status of ["running", "rolled_back"] as const) {
    const sourceRun = makeSourceRun(status);
    const error = flip(() => planFork(sourceRun));
    assert.equal(error._tag, "ThreadForkPlanError");
    assert.equal(error.sourceThreadId, sourceThreadId);
    assert.equal(error.targetThreadId, targetThreadId);
    assert.equal(error.cause, ThreadForkService.forkableSourceRunStatusError(sourceRun));
  }
});

it("marks only requested forks as side chats and inherits parent permissions", () => {
  const sourceRun = makeSourceRun("completed");
  const sideChat = planFork(sourceRun, makeSourceProjection(sourceRun), {
    sideChat: true,
  });
  assert.isTrue(sideChat.targetThread.lineage.sideChat);
  assert.equal(sideChat.targetThread.runtimeMode, "full-access");
  for (const runtimeMode of [
    "approval-required",
    "auto-accept-edits",
    "auto",
    "full-access",
  ] as const) {
    const source = makeSourceProjection(sourceRun);
    const inherited = planFork(
      sourceRun,
      {
        ...source,
        thread: { ...source.thread, runtimeMode },
      },
      { sideChat: true },
    );
    assert.equal(inherited.targetThread.runtimeMode, runtimeMode);
  }

  const sideChatSource = makeSourceProjection(sourceRun);
  const sideChatProjection = {
    ...sideChatSource,
    thread: {
      ...sideChatSource.thread,
      lineage: { ...sideChatSource.thread.lineage, sideChat: true as const },
    },
  };
  const forkOfSideChat = planFork(sourceRun, sideChatProjection);
  assert.isUndefined(forkOfSideChat.targetThread.lineage.sideChat);
  assert.equal(forkOfSideChat.targetThread.runtimeMode, "full-access");

  const nested = flip(() => planFork(sourceRun, sideChatProjection, { sideChat: true }));
  assert.equal(nested.cause, "A side chat cannot start another side chat.");

  const subagentSource = makeSourceProjection(sourceRun);
  const fromSubagent = flip(() =>
    planFork(
      sourceRun,
      {
        ...subagentSource,
        thread: {
          ...subagentSource.thread,
          lineage: { ...subagentSource.thread.lineage, relationshipToParent: "subagent" },
        },
      },
      { sideChat: true },
    ),
  );
  assert.equal(fromSubagent.cause, "A subagent cannot start a side chat.");

  const delegatedSource = makeSourceProjection(sourceRun);
  const fromDelegated = flip(() =>
    planFork(
      sourceRun,
      {
        ...delegatedSource,
        thread: {
          ...delegatedSource.thread,
          delegatedFrom: {
            environmentId: "linked-environment",
            threadId: "linked-parent",
            title: "Linked parent",
          },
        },
      },
      { sideChat: true },
    ),
  );
  assert.equal(fromDelegated.cause, "A subagent cannot start a side chat.");
});
