// The zod schemas the handoff code reads. Ids are plain trimmed strings; timestamps are ISO-8601
// strings (what a host persists anyway).
import { z } from "zod";

const TrimmedNonEmptyString = z.string().trim().min(1);
const NonNegativeInt = z.number().int().min(0);
const PositiveInt = z.number().int().min(1);
/** The ISO string a host stores. */
const IsoDateTime = z.string();

export const ThreadId = TrimmedNonEmptyString;
export type ThreadId = z.infer<typeof ThreadId>;
export const RunId = TrimmedNonEmptyString;
export type RunId = z.infer<typeof RunId>;
export const RunAttemptId = TrimmedNonEmptyString;
export type RunAttemptId = z.infer<typeof RunAttemptId>;
export const NodeId = TrimmedNonEmptyString;
export type NodeId = z.infer<typeof NodeId>;
export const TurnItemId = TrimmedNonEmptyString;
export type TurnItemId = z.infer<typeof TurnItemId>;
export const MessageId = TrimmedNonEmptyString;
export type MessageId = z.infer<typeof MessageId>;
export const ProviderThreadId = TrimmedNonEmptyString;
export type ProviderThreadId = z.infer<typeof ProviderThreadId>;
export const ProviderTurnId = TrimmedNonEmptyString;
export type ProviderTurnId = z.infer<typeof ProviderTurnId>;
export const ProviderSessionId = TrimmedNonEmptyString;
export type ProviderSessionId = z.infer<typeof ProviderSessionId>;
export const ProviderInstanceId = TrimmedNonEmptyString;
export type ProviderInstanceId = z.infer<typeof ProviderInstanceId>;
export const ProviderDriverKind = TrimmedNonEmptyString;
export type ProviderDriverKind = z.infer<typeof ProviderDriverKind>;
export const ContextHandoffId = TrimmedNonEmptyString;
export type ContextHandoffId = z.infer<typeof ContextHandoffId>;
export const ContextTransferId = TrimmedNonEmptyString;
export type ContextTransferId = z.infer<typeof ContextTransferId>;
export const CheckpointId = TrimmedNonEmptyString;
export type CheckpointId = z.infer<typeof CheckpointId>;
export const ProjectId = TrimmedNonEmptyString;
export type ProjectId = z.infer<typeof ProjectId>;

// ---- modelSelection.ts ------------------------------------------------------------------------

export const ModelSelection = z.object({
  instanceId: ProviderInstanceId,
  model: z.string(),
  options: z
    .array(z.object({ id: z.string(), value: z.union([z.string(), z.boolean()]) }))
    .optional(),
});
export type ModelSelection = z.infer<typeof ModelSelection>;

// ---- chatAttachment.ts ------------------------------------------------------------------------

export const PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 100;

const ChatAttachmentFields = {
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString.max(255),
  mimeType: TrimmedNonEmptyString.max(100),
  sizeBytes: NonNegativeInt,
};
export const ChatAttachment = z.discriminatedUnion("type", [
  z.object({ type: z.literal("image"), ...ChatAttachmentFields }),
  z.object({ type: z.literal("file"), ...ChatAttachmentFields }),
  z.object({ type: z.literal("unknown"), ...ChatAttachmentFields }),
]);
export type ChatAttachment = z.infer<typeof ChatAttachment>;

// ---- providerRuntime.ts -----------------------------------------------------------------------

export const ThreadTokenUsageSnapshot = z.object({
  usedTokens: NonNegativeInt,
  totalProcessedTokens: NonNegativeInt.optional(),
  maxTokens: PositiveInt.optional(),
  inputTokens: NonNegativeInt.optional(),
  cachedInputTokens: NonNegativeInt.optional(),
  outputTokens: NonNegativeInt.optional(),
  reasoningOutputTokens: NonNegativeInt.optional(),
  lastUsedTokens: NonNegativeInt.optional(),
  lastInputTokens: NonNegativeInt.optional(),
  lastCachedInputTokens: NonNegativeInt.optional(),
  lastOutputTokens: NonNegativeInt.optional(),
  lastReasoningOutputTokens: NonNegativeInt.optional(),
  toolUses: NonNegativeInt.optional(),
  durationMs: NonNegativeInt.optional(),
  compactsAutomatically: z.boolean().optional(),
  autoCompactThreshold: PositiveInt.optional(),
});
export type ThreadTokenUsageSnapshot = z.infer<typeof ThreadTokenUsageSnapshot>;

// ---- orchestrationV2.ts -----------------------------------------------------------------------

export const OrchestrationV2Actor = z.enum(["user", "agent", "system"]);
export type OrchestrationV2Actor = z.infer<typeof OrchestrationV2Actor>;

/** The client a request came from; a Factory host names its own. */
export const OrchestrationV2CreationSource = z.string();
export type OrchestrationV2CreationSource = z.infer<typeof OrchestrationV2CreationSource>;

export const OrchestrationV2NativeRefStrength = z.enum(["strong", "weak", "none"]);
export type OrchestrationV2NativeRefStrength = z.infer<typeof OrchestrationV2NativeRefStrength>;

export const OrchestrationV2ProviderRef = z.object({
  driver: ProviderDriverKind,
  nativeId: TrimmedNonEmptyString.nullable(),
  strength: OrchestrationV2NativeRefStrength,
  fingerprint: TrimmedNonEmptyString.optional(),
  ordinal: NonNegativeInt.optional(),
});
export type OrchestrationV2ProviderRef = z.infer<typeof OrchestrationV2ProviderRef>;

export const OrchestrationV2AppThreadLineage = z.object({
  parentThreadId: ThreadId.nullable(),
  relationshipToParent: z.enum(["fork", "subagent"]).nullable(),
  rootThreadId: ThreadId,
  sideChat: z.literal(true).optional(),
});
export type OrchestrationV2AppThreadLineage = z.infer<typeof OrchestrationV2AppThreadLineage>;

export const OrchestrationV2ContextTransferType = z.enum([
  "fork",
  "provider_handoff",
  "merge_back",
  "subagent_spawn",
  "subagent_result",
]);
export type OrchestrationV2ContextTransferType = z.infer<typeof OrchestrationV2ContextTransferType>;

export const OrchestrationV2ContextSourcePoint = z.object({
  threadId: ThreadId,
  runId: RunId.optional(),
  checkpointId: CheckpointId.optional(),
  turnItemId: TurnItemId.optional(),
  providerThreadRef: OrchestrationV2ProviderRef.optional(),
  providerTurnRef: OrchestrationV2ProviderRef.optional(),
});
export type OrchestrationV2ContextSourcePoint = z.infer<typeof OrchestrationV2ContextSourcePoint>;

export const OrchestrationV2ContextTransferResolution = z.discriminatedUnion("strategy", [
  z.object({ strategy: z.literal("native_fork"), providerThreadRef: OrchestrationV2ProviderRef }),
  z.object({ strategy: z.literal("portable_context"), contextHandoffId: ContextHandoffId }),
  z.object({ strategy: z.literal("delta_context"), contextHandoffId: ContextHandoffId }),
  z.object({ strategy: z.literal("fork_delta_context"), contextHandoffId: ContextHandoffId }),
  z.object({ strategy: z.literal("checkpoint_context"), contextHandoffId: ContextHandoffId }),
]);
export type OrchestrationV2ContextTransferResolution = z.infer<
  typeof OrchestrationV2ContextTransferResolution
>;

export const OrchestrationV2ProviderTurnTokenUsage = z.object({
  usedTokens: NonNegativeInt,
  maxTokens: NonNegativeInt.nullable().optional(),
  inputTokens: NonNegativeInt.optional(),
  cachedInputTokens: NonNegativeInt.optional(),
  outputTokens: NonNegativeInt.optional(),
  reasoningOutputTokens: NonNegativeInt.optional(),
  promptCacheTtlMs: PositiveInt.optional(),
  autoCompactThreshold: PositiveInt.optional(),
  promptCacheExpiresAt: z.string().optional(),
  updatedAt: z.string(),
});
export type OrchestrationV2ProviderTurnTokenUsage = z.infer<
  typeof OrchestrationV2ProviderTurnTokenUsage
>;

export const OrchestrationV2ContextTransfer = z.object({
  id: ContextTransferId,
  type: OrchestrationV2ContextTransferType,
  sourceThreadId: ThreadId,
  targetThreadId: ThreadId,
  sourcePoint: OrchestrationV2ContextSourcePoint,
  basePoint: OrchestrationV2ContextSourcePoint.nullable(),
  sourceProviderInstanceId: ProviderInstanceId.nullable(),
  sourceTokenUsage: OrchestrationV2ProviderTurnTokenUsage.optional(),
  targetProviderInstanceId: ProviderInstanceId.nullable(),
  targetRunId: RunId.nullable(),
  status: z.enum([
    "pending",
    "resolved_native",
    "resolved_portable",
    "failed",
    "consumed",
    "superseded",
  ]),
  resolution: OrchestrationV2ContextTransferResolution.nullable(),
  createdBy: OrchestrationV2Actor,
  error: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  consumedAt: IsoDateTime.nullable(),
});
export type OrchestrationV2ContextTransfer = z.infer<typeof OrchestrationV2ContextTransfer>;

export const OrchestrationV2SessionCapabilities = z.object({
  supportsMultipleProviderThreadsPerSession: z.boolean(),
  supportsModelSwitchInSession: z.boolean(),
  supportsProviderSwitchingViaHandoff: z.boolean(),
  supportsRuntimeModeSwitchInSession: z.boolean(),
  pendingRequestsSurviveRestart: z.boolean(),
});
export type OrchestrationV2SessionCapabilities = z.infer<typeof OrchestrationV2SessionCapabilities>;

/** A provider's capabilities; only `sessions` is read here. */
export const OrchestrationV2ProviderCapabilities = z.looseObject({
  sessions: OrchestrationV2SessionCapabilities,
});
export type OrchestrationV2ProviderCapabilities = z.infer<
  typeof OrchestrationV2ProviderCapabilities
>;

export const IDLE_COMPACTION_TEXT = "/compact";

interface CompactionMessageFields {
  readonly role: string;
  readonly text: string;
  readonly attachments?: ReadonlyArray<unknown> | undefined;
}

/** A prompt that only asks the provider to compact, so its turn is the compaction itself. */
export function isCompactionCommandMessage(message: CompactionMessageFields): boolean {
  return (
    message.role === "user" &&
    message.text.trim().toLowerCase() === IDLE_COMPACTION_TEXT &&
    (message.attachments?.length ?? 0) === 0
  );
}

export const OrchestrationV2RunStatus = z.enum([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);
export type OrchestrationV2RunStatus = z.infer<typeof OrchestrationV2RunStatus>;

export const OrchestrationV2Run = z.object({
  id: RunId,
  threadId: ThreadId,
  ordinal: PositiveInt,
  providerInstanceId: ProviderInstanceId,
  modelSelection: ModelSelection,
  providerThreadId: ProviderThreadId.nullable(),
  userMessageId: MessageId,
  rootNodeId: NodeId.nullable(),
  activeAttemptId: RunAttemptId.nullable(),
  status: OrchestrationV2RunStatus,
  queuePosition: NonNegativeInt.nullable(),
  requestedAt: IsoDateTime,
  startedAt: IsoDateTime.nullable(),
  completedAt: IsoDateTime.nullable(),
  checkpointId: CheckpointId.nullable(),
  contextHandoffId: ContextHandoffId.nullable(),
});
export type OrchestrationV2Run = z.infer<typeof OrchestrationV2Run>;

export const OrchestrationV2RunAttempt = z.object({
  id: RunAttemptId,
  // Provider-thread rows can be reused after recovery; retain the native input destination.
  nativeThreadId: z.string().optional(),
  runId: RunId,
  attemptOrdinal: PositiveInt,
  rootNodeId: NodeId,
  providerInstanceId: ProviderInstanceId,
  providerThreadId: ProviderThreadId,
  providerTurnId: ProviderTurnId.nullable(),
  reason: z.enum(["initial", "steering_restart", "retry", "provider_recovery"]),
  status: z.enum([
    "pending",
    "running",
    "completed",
    "interrupted",
    "failed",
    "cancelled",
    "superseded",
  ]),
  startedAt: IsoDateTime.nullable(),
  completedAt: IsoDateTime.nullable(),
});
export type OrchestrationV2RunAttempt = z.infer<typeof OrchestrationV2RunAttempt>;

export const OrchestrationV2ProviderSession = z.object({
  id: ProviderSessionId,
  providerInstanceId: ProviderInstanceId,
  status: z.string(),
  cwd: z.string().nullable().optional(),
  capabilities: OrchestrationV2ProviderCapabilities.nullable().optional(),
  updatedAt: IsoDateTime,
});
export type OrchestrationV2ProviderSession = z.infer<typeof OrchestrationV2ProviderSession>;

export const OrchestrationV2ProviderThread = z.object({
  id: ProviderThreadId,
  driver: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: ProviderSessionId.nullable(),
  appThreadId: ThreadId.nullable(),
  ownerNodeId: NodeId.nullable(),
  nativeThreadRef: OrchestrationV2ProviderRef.nullable(),
  nativeConversationHeadRef: OrchestrationV2ProviderRef.nullable(),
  status: z.enum(["not_loaded", "idle", "active", "archived", "closed", "error"]),
  firstRunOrdinal: PositiveInt.nullable(),
  lastRunOrdinal: PositiveInt.nullable(),
  handoffIds: z.array(ContextHandoffId),
  forkedFrom: z
    .object({
      providerThreadId: ProviderThreadId,
      providerTurnId: ProviderTurnId.optional(),
      checkpointId: CheckpointId.optional(),
    })
    .nullable(),
  contextUsage: ThreadTokenUsageSnapshot.nullable().optional(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationV2ProviderThread = z.infer<typeof OrchestrationV2ProviderThread>;

export const OrchestrationV2ProviderTurn = z.object({
  id: ProviderTurnId,
  providerThreadId: ProviderThreadId,
  nodeId: NodeId,
  runAttemptId: RunAttemptId.nullable(),
  tokenUsage: OrchestrationV2ProviderTurnTokenUsage.optional(),
});
export type OrchestrationV2ProviderTurn = z.infer<typeof OrchestrationV2ProviderTurn>;

/**
 * The app thread a handoff moves between. UI state (pin, snooze, settle, guest share, pull
 * request watches, title jobs) that a fork resets lives elsewhere in a Factory thread, so only
 * lineage and the fields the handoff code reads are modelled. Unknown
 * keys pass through, so a host's own thread fields survive a fork plan.
 */
export const OrchestrationV2AppThread = z.looseObject({
  id: ThreadId,
  projectId: ProjectId,
  title: z.string(),
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  providerInstanceId: ProviderInstanceId,
  modelSelection: ModelSelection,
  runtimeMode: z.string(),
  interactionMode: z.string(),
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
  activeProviderThreadId: ProviderThreadId.nullable(),
  lineage: OrchestrationV2AppThreadLineage,
  forkedFrom: z
    .object({ type: z.literal("run"), threadId: ThreadId, runId: RunId })
    .nullable(),
  historyOrigin: z.enum(["native", "v1_import"]).optional(),
  /** The remote parent that delegated this thread here, when one did. */
  delegatedFrom: z.looseObject({ threadId: ThreadId }).optional(),
  /** Linked pull requests; a fork keeps them without the source's `watch`. */
  pullRequests: z.array(z.looseObject({ watch: z.unknown().optional() })).optional(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: IsoDateTime.nullable(),
  deletedAt: IsoDateTime.nullable(),
});
export type OrchestrationV2AppThread = z.infer<typeof OrchestrationV2AppThread>;

export const OrchestrationV2TurnItemStatus = z.enum([
  "idle",
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type OrchestrationV2TurnItemStatus = z.infer<typeof OrchestrationV2TurnItemStatus>;

export const OrchestrationV2UserMessageInputIntent = z.enum([
  "turn_start",
  "queued_turn",
  "steer",
  "promoted_queued_to_steer",
]);
export type OrchestrationV2UserMessageInputIntent = z.infer<
  typeof OrchestrationV2UserMessageInputIntent
>;

export const OrchestrationV2FileChangeDetail = z.object({
  operation: TrimmedNonEmptyString,
  path: z.string(),
  oldPath: z.string().optional(),
});

const TurnItemBase = {
  id: TurnItemId,
  threadId: ThreadId,
  runId: RunId.nullable(),
  nodeId: NodeId.nullable(),
  providerThreadId: ProviderThreadId.nullable(),
  providerTurnId: ProviderTurnId.nullable(),
  nativeItemRef: OrchestrationV2ProviderRef.nullable(),
  parentItemId: TurnItemId.nullable(),
  ordinal: NonNegativeInt,
  status: OrchestrationV2TurnItemStatus,
  title: z.string().nullable(),
  startedAt: IsoDateTime.nullable(),
  completedAt: IsoDateTime.nullable(),
  updatedAt: IsoDateTime,
};

/**
 * Timeline rows: the item types the handoff and thread-read code
 * render. A host maps everything else to `dynamic_tool` or leaves it out.
 */
export const OrchestrationV2TurnItem = z.discriminatedUnion("type", [
  z.object({
    ...TurnItemBase,
    type: z.literal("user_message"),
    messageId: MessageId,
    text: z.string(),
    inputIntent: OrchestrationV2UserMessageInputIntent,
    attachments: z.array(ChatAttachment),
    createdBy: OrchestrationV2Actor,
    creationSource: OrchestrationV2CreationSource,
    /** The model or effort change this message's run brought; see `modelSwitchSince`. */
    modelSwitch: z.object({ from: ModelSelection, to: ModelSelection }).optional(),
  }),
  z.object({
    ...TurnItemBase,
    type: z.literal("assistant_message"),
    messageId: MessageId,
    text: z.string(),
    streaming: z.boolean(),
  }),
  z.object({ ...TurnItemBase, type: z.literal("reasoning"), text: z.string(), streaming: z.boolean() }),
  z.object({ ...TurnItemBase, type: z.literal("proposed_plan"), markdown: z.string() }),
  z.object({
    ...TurnItemBase,
    type: z.literal("command_execution"),
    input: z.string(),
    output: z.string().optional(),
    exitCode: z.number().int().nullable().optional(),
  }),
  z.object({
    ...TurnItemBase,
    type: z.literal("file_change"),
    fileName: z.string(),
    changes: z.array(OrchestrationV2FileChangeDetail).optional(),
    additions: NonNegativeInt.optional(),
    deletions: NonNegativeInt.optional(),
    diffStr: z.string().optional(),
    newStr: z.string().optional(),
  }),
  z.object({ ...TurnItemBase, type: z.literal("checkpoint"), files: z.array(z.unknown()) }),
  z.object({ ...TurnItemBase, type: z.literal("error"), failure: z.looseObject({ message: z.string() }) }),
  z.object({ ...TurnItemBase, type: z.literal("run_interrupt_request"), message: z.string() }),
  z.object({ ...TurnItemBase, type: z.literal("run_interrupt_result"), message: z.string() }),
  z.object({ ...TurnItemBase, type: z.literal("system_notice"), message: z.string() }),
  z.object({
    ...TurnItemBase,
    type: z.literal("notification"),
    summary: z.string(),
    detail: z.string().optional(),
  }),
  z.object({ ...TurnItemBase, type: z.literal("compaction"), summary: z.string().nullable().optional() }),
  z.object({
    ...TurnItemBase,
    type: z.literal("handoff"),
    summary: z.string().nullable().optional(),
    strategy: z.string(),
    toProviderInstanceId: ProviderInstanceId,
  }),
  z.object({ ...TurnItemBase, type: z.literal("fork"), targetThreadId: ThreadId }),
  z.object({
    ...TurnItemBase,
    type: z.literal("dynamic_tool"),
    toolName: z.string(),
    input: z.unknown(),
    output: z.unknown(),
  }),
]);
export type OrchestrationV2TurnItem = z.infer<typeof OrchestrationV2TurnItem>;

export const OrchestrationV2ProjectedTurnItem = z.object({
  position: NonNegativeInt,
  visibility: z.enum(["local", "inherited", "synthetic"]),
  sourceThreadId: ThreadId,
  sourceItemId: TurnItemId,
  item: OrchestrationV2TurnItem,
});
export type OrchestrationV2ProjectedTurnItem = z.infer<typeof OrchestrationV2ProjectedTurnItem>;

/** What a thread projection holds, as far as handoff code reads it. */
export interface OrchestrationV2ThreadProjection {
  readonly thread: OrchestrationV2AppThread;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly attempts: ReadonlyArray<OrchestrationV2RunAttempt>;
  readonly providerSessions: ReadonlyArray<OrchestrationV2ProviderSession>;
  readonly providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>;
  readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly contextHandoffs: ReadonlyArray<OrchestrationV2ContextHandoff>;
  readonly contextTransfers: ReadonlyArray<OrchestrationV2ContextTransfer>;
}

export const OrchestrationV2HistoricalMessage = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  runStatus: z.string().optional(),
  threadId: ThreadId,
  runId: RunId.nullable(),
  itemId: TurnItemId,
  providerThreadId: ProviderThreadId.nullable(),
  status: z.string(),
  kind: z.string(),
});
export type OrchestrationV2HistoricalMessage = z.infer<typeof OrchestrationV2HistoricalMessage>;

export const OrchestrationV2ContextHandoff = z.object({
  id: ContextHandoffId,
  transferId: ContextTransferId.nullable().optional(),
  threadId: ThreadId,
  targetRunId: RunId,
  fromProviderThreadIds: z.array(ProviderThreadId),
  toProviderThreadId: ProviderThreadId,
  coveredRunOrdinals: z.object({
    from: PositiveInt,
    to: PositiveInt,
  }),
  strategy: z.enum([
    "delta_since_target_last_seen",
    "fork_delta_summary",
    "full_thread_summary",
    "checkpoint_summary",
    "manual_context",
  ]),
  status: z.enum(["pending", "ready", "failed", "superseded"]),
  summaryMessageId: MessageId.nullable(),
  summaryText: z.string(),
  history: z
    .object({
      messages: z.array(OrchestrationV2HistoricalMessage),
      coverage: z.string(),
      omittedItems: NonNegativeInt,
      omittedItemIds: z.array(TurnItemId).optional(),
    })
    .optional(),
  delivery: z
    .object({
      nativeThreadId: z.string(),
      status: z.enum(["pending", "injected", "inline"]),
      itemIds: z.array(TurnItemId),
      omittedItemIds: z.array(TurnItemId).optional(),
    })
    .optional(),
  detailInTurnItem: z.literal(true).optional(),
  createdByProviderInstanceId: ProviderInstanceId.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationV2ContextHandoff = z.infer<typeof OrchestrationV2ContextHandoff>;

// ---- orchestratorMcp.ts (thread read) ---------------------------------------------------------

// Codex hides `minimum` and `maximum` from the model, so a value above the maximum clamps on
// decode instead of failing the call; pagination returns the rest. Values below 1 still fail:
// 0 asks for nothing, and answering it with one item would be a different request.
const clampedPositiveInt = (maximum: number) =>
  PositiveInt.transform((value) => Math.min(value, maximum));

export const OrchestratorMcpThreadReadInput = z.object({
  threadId: ThreadId,
  itemId: TurnItemId.optional(),
  textOffset: NonNegativeInt.optional(),
  view: z.enum(["messages", "activity"]).optional(),
  afterPosition: NonNegativeInt.optional(),
  limit: clampedPositiveInt(100).optional().describe("Max items, 1 to 100."),
  maxCharsPerItem: clampedPositiveInt(50_000).optional().describe("Max chars per item, 1 to 50000."),
});
export type OrchestratorMcpThreadReadInput = z.infer<typeof OrchestratorMcpThreadReadInput>;

export const OrchestratorMcpThreadTimelineItem = z.object({
  position: NonNegativeInt,
  visibility: z.enum(["local", "inherited", "synthetic"]),
  sourceThreadId: ThreadId,
  itemId: TurnItemId,
  runId: RunId.nullable(),
  messageId: MessageId.nullable(),
  createdBy: OrchestrationV2Actor.nullable(),
  type: z.string(),
  status: OrchestrationV2TurnItemStatus,
  title: z.string().nullable(),
  text: z.string().nullable(),
  textTruncated: z.boolean(),
  nextTextOffset: NonNegativeInt.nullable().optional(),
  updatedAt: IsoDateTime,
});
export type OrchestratorMcpThreadTimelineItem = z.infer<typeof OrchestratorMcpThreadTimelineItem>;

export const OrchestratorMcpThreadReadResult = z.object({
  thread: z.object({ threadId: ThreadId, title: z.string(), itemCount: NonNegativeInt }),
  items: z.array(OrchestratorMcpThreadTimelineItem),
  nextPosition: NonNegativeInt.nullable(),
  hasMore: z.boolean(),
});
export type OrchestratorMcpThreadReadResult = z.infer<typeof OrchestratorMcpThreadReadResult>;
