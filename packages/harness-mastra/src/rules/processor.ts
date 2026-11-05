import { resolveRequestThinkingLevel } from '@mastra/code-sdk/agents/model';
import type { ThinkingLevel } from '@mastra/code-sdk/providers/openai-codex';
import type { MastraCodeState } from '@mastra/code-sdk/schema';
import type { MastraDBMessage, MessageList } from '@mastra/core/agent/message-list';
import type { AgentControllerRequestContext } from '@mastra/core/agent-controller';
import type {
  ComputeStateSignalArgs,
  ComputeStateSignalResult,
  ProcessInputArgs,
  ProcessInputStepArgs,
  Processor,
} from '@mastra/core/processors';

import { boardForWorkItem, resolveBoardToolRule, reviewsPullRequest, workItemPhaseSemantics } from '@factory/core';
import type { BoardRegistry } from '@factory/core';
import type { FactoryRunBindingRecord, WorkItemsStorage, WorkItemRow } from '@factory/store';
import type { Card } from '@factory/store';
import { findSessionRunBinding, getFactorySessionCoordinates } from '@factory/session';
import { toBoardSource } from '@factory/runtime';
import type { FactoryTransitionService, ProjectBoardSource } from '@factory/runtime';
import { workItemSource } from '@factory/core';
import type {
  FactoryCommitDecision,
  FactoryRuleDecision,
  FactoryRuleJsonValue,
  FactoryRuleStage,
  FactoryToolResultRuleContext,
} from '@factory/core';
import {
  assertFactoryDecisionTarget,
  normalizeFactoryRuleJsonValue,
  validateFactoryRuleDecisions,
} from '@factory/core';

const STATE_ID = 'factory-phase';
const RULE_TIMEOUT_MS = 5_000;
const TRANSCRIPT_PAGE_SIZE = 50;
const MAX_LINKED_ITEMS = 5;
function ruleStage(boards: BoardRegistry, item: Card | null | undefined): string | undefined {
  return item && workItemPhaseSemantics(boards, item) ? item.stages[0] : undefined;
}

function itemInRuleStage(boards: BoardRegistry, item: Card | null | undefined): item is Card {
  return ruleStage(boards, item) !== undefined;
}

type PersistedMessageReader = {
  listMessages(input: {
    threadId: string;
    resourceId?: string;
    page: number;
    perPage: number;
    filter?: { dateRange?: { start?: Date } };
    orderBy: { field: 'createdAt'; direction: 'ASC' };
  }): Promise<{ messages: MastraDBMessage[]; hasMore: boolean }>;
};

type CompletedToolResult = {
  assistantMessageId: string;
  messageCreatedAt: Date;
  toolCallId: string;
  toolName: string;
  input: FactoryRuleJsonValue;
  status: 'success' | 'error';
  value: FactoryRuleJsonValue;
};

function isApprovedPlanResult(result: CompletedToolResult): boolean {
  if (result.toolName !== 'submit_plan' || result.status !== 'success') return false;
  if (typeof result.value === 'string') return result.value.startsWith('Plan approved.');
  if (!result.value || typeof result.value !== 'object' || Array.isArray(result.value)) return false;
  const content = result.value.content;
  return typeof content === 'string' && content.startsWith('Plan approved.');
}

type RuntimeSnapshot = {
  modelId: string;
  thinkingLevel: ThinkingLevel;
};

type ActivePhaseSnapshotBase = {
  bindingId: string;
  itemId: string;
  revision: number;
  stage: FactoryRuleStage;
  role: string;
  configVersion: string;
  status: 'active';
};

type ActivePhaseSnapshotValue = ActivePhaseSnapshotBase & {
  board: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
};

type PhaseSnapshotValue = ActivePhaseSnapshotValue | { bindingId?: string; status: 'none' };

function reviewRuntimeFromRequestContext(
  requestContext: ComputeStateSignalArgs['requestContext'],
  factoryThinkingLevel: ThinkingLevel | undefined,
): RuntimeSnapshot {
  if (!requestContext || typeof requestContext.get !== 'function') {
    throw new Error('Factory review phase requires a controller request context.');
  }
  const context = requestContext.get<'controller', AgentControllerRequestContext<MastraCodeState>>('controller');
  const modelId = context?.session?.modelId.trim();
  if (!modelId) {
    throw new Error('Factory review phase requires a selected session model.');
  }
  return {
    modelId,
    thinkingLevel: resolveRequestThinkingLevel({ state: context?.state }, undefined, factoryThinkingLevel),
  };
}

function workItemSourceKey(item: Card): string | null {
  const source = item.externalSource;
  return source ? `${source.integrationId}:${source.type}:${source.externalId}` : null;
}

function boundedError(value: unknown): FactoryRuleJsonValue {
  const message = value instanceof Error ? value.message : typeof value === 'string' ? value : 'Tool execution failed.';
  return { message: message.slice(0, 2_000) };
}

function boundedResult(value: unknown): FactoryRuleJsonValue {
  try {
    return normalizeFactoryRuleJsonValue(value);
  } catch {
    return { message: 'Tool result was not serializable.' };
  }
}

function messageParts(message: MastraDBMessage): unknown[] {
  const content = message.content as { parts?: unknown[]; toolInvocations?: unknown[] } | unknown[] | undefined;
  if (Array.isArray(content)) return content;
  if (Array.isArray(content?.parts)) return content.parts;
  return Array.isArray(content?.toolInvocations) ? content.toolInvocations : [];
}

function completedStepToolCallIds(steps: unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const rawStep of steps) {
    if (!rawStep || typeof rawStep !== 'object') continue;
    const toolResults = (rawStep as { toolResults?: unknown[] }).toolResults;
    if (!Array.isArray(toolResults)) continue;
    for (const rawResult of toolResults) {
      if (!rawResult || typeof rawResult !== 'object') continue;
      const toolCallId = (rawResult as { toolCallId?: unknown }).toolCallId;
      if (typeof toolCallId === 'string') ids.add(toolCallId);
    }
  }
  return ids;
}

function completedToolResults(message: MastraDBMessage): CompletedToolResult[] {
  if (message.role !== 'assistant') return [];
  const createdAt = message.createdAt instanceof Date ? message.createdAt : new Date(message.createdAt);
  const completed: CompletedToolResult[] = [];
  for (const rawPart of messageParts(message)) {
    if (!rawPart || typeof rawPart !== 'object') continue;
    const part = rawPart as Record<string, unknown>;
    const invocation =
      part.type === 'tool-invocation' && part.toolInvocation && typeof part.toolInvocation === 'object'
        ? (part.toolInvocation as Record<string, unknown>)
        : part;
    const state = invocation.state;
    if (state !== 'result' && state !== 'error') continue;
    const toolCallId = invocation.toolCallId;
    const toolName = invocation.toolName ?? invocation.name;
    if (typeof toolCallId !== 'string' || typeof toolName !== 'string') continue;
    // A Claude Code transcript settles a failed call as a `result` marked `isError`.
    const failed = state === 'error' || invocation.isError === true;
    completed.push({
      assistantMessageId: message.id,
      messageCreatedAt: createdAt,
      toolCallId,
      toolName: toolName.slice(0, 256),
      input: boundedResult(invocation.args ?? {}),
      status: failed ? 'error' : 'success',
      value: failed ? boundedError(invocation.result ?? invocation.error) : boundedResult(invocation.result),
    });
  }
  return completed;
}

function currentCompletedToolMessage(
  messages: MastraDBMessage[],
  toolCallIds: ReadonlySet<string>,
): MastraDBMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (completedToolResults(message).some(result => toolCallIds.has(result.toolCallId))) return message;
  }
  return undefined;
}

async function phaseCacheKey(value: ActivePhaseSnapshotValue, linked: Card[]): Promise<string> {
  const serialized = JSON.stringify({
    ...value,
    linked: linked.map(item => [item.id, item.revision, item.stages[0]]),
  });
  return Buffer.from(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized))).toString(
    'hex',
  );
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function phaseFromSignal(signal: { metadata?: Record<string, unknown> } | undefined): PhaseSnapshotValue | undefined {
  return (signal?.metadata?.value as { phase?: PhaseSnapshotValue } | undefined)?.phase;
}

function latestPhase(args: ComputeStateSignalArgs): PhaseSnapshotValue | undefined {
  for (const signal of [...args.activeStateSignals].reverse()) {
    const phase = phaseFromSignal(signal);
    if (phase) return phase;
  }
  return phaseFromSignal(args.lastSnapshot);
}

async function withRuleTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('FACTORY_RULE_TIMEOUT')), RULE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const reportedUnavailableMemorySettings = new WeakSet<object>();

/**
 * Marks this run's Factory memory settings as unavailable so memory falls back
 * to auto, and tells the thread once per request that saved choices were not
 * applied. The reserved request-context key keeps clients from spoofing it.
 */
export function reportMemorySettingsUnavailable(
  requestContext: NonNullable<ProcessInputArgs['requestContext']>,
  reason: string,
): void {
  requestContext.set('mastra__factoryMemorySettings', { status: 'unavailable', reason });
  console.warn('[Factory Memory Settings] Failed to load settings for run', { error: reason });
  if (reportedUnavailableMemorySettings.has(requestContext)) return;
  reportedUnavailableMemorySettings.add(requestContext);
  const controller = requestContext.get('controller') as
    | Pick<AgentControllerRequestContext<MastraCodeState>, 'emitEvent'>
    | undefined;
  controller?.emitEvent?.({
    type: 'error',
    error: new Error(
      'Memory settings could not be loaded for this run, so observational memory is using Auto models and default thresholds.',
    ),
    errorType: 'factory_memory_settings_unavailable',
    retryable: false,
  });
}

/**
 * The `factory-phase` signal's text for an active run binding: the board and
 * stage, the work item, the role and revision, and what ends the phase. A
 * Mastra session sees it as a state signal; a Claude Code session gets the same
 * text ahead of each turn.
 */
export async function describeFactoryPhase(input: {
  storage: WorkItemsStorage;
  boards: BoardRegistry | ProjectBoardSource;
  configVersion: string;
  binding: FactoryRunBindingRecord;
  /**
   * The model and reasoning setting a Review run reports in its published
   * review; a harness without Mastra thinking levels names its own setting.
   */
  runtime?: () => Promise<{ modelId: string; thinkingLevel: ThinkingLevel | (string & {}) } | undefined>;
}): Promise<{ value: ActivePhaseSnapshotValue; contents: string; linked: WorkItemRow[] } | undefined> {
  const { binding } = input;
  const item = await input.storage.get({ orgId: binding.orgId, id: binding.workItemId });
  const boards = await toBoardSource(input.boards).load(binding);
  const stage = ruleStage(boards, item);
  if (!item || !stage) return undefined;
  const allItems = await input.storage.list({
    orgId: binding.orgId,
    factoryProjectId: binding.factoryProjectId,
  });
  const linked = allItems
    .filter(candidate => candidate.parentWorkItemId === item.id || item.parentWorkItemId === candidate.id)
    .slice(0, MAX_LINKED_ITEMS);
  const board = boardForWorkItem(item);
  const baseValue: ActivePhaseSnapshotBase = {
    status: 'active',
    bindingId: binding.id,
    itemId: item.id,
    revision: item.revision,
    stage,
    role: binding.role,
    configVersion: input.configVersion,
  };
  // A pull request's own card (on Review, or on Work's `pr-review`) carries the review runtime.
  const value: ActivePhaseSnapshotValue = reviewsPullRequest({ board, item: { source: workItemSource(item.externalSource) } })
    ? {
        ...baseValue,
        board,
        ...((await input.runtime?.()) as RuntimeSnapshot | undefined),
      }
    : { ...baseValue, board };

  const linkedText = linked.length
    ? `\nLinked items: ${linked.map(candidate => `${workItemSource(candidate.externalSource)} ${candidate.title}`).join('; ')}`
    : '';
  const phase = boards.get(board)?.phases[stage];
  const phaseLabel = phase?.name ?? stage;
  const exitText =
    phase?.kind === 'working' && phase.exitTool
      ? boards.get(board)?.tools[phase.exitTool.id]
        ? `This phase ends when ${escapeText(phase.exitTool.id)} succeeds${phase.exitTool.id === 'submit_plan' ? ' and is approved' : ''}; that moves the card on. Next phases: ${phase.nextPhases.map(escapeText).join(', ')}. You can move it on to a working phase yourself with factory_transition_work_item only when ${escapeText(phase.exitTool.id)} is auto-approved for this card; otherwise a person approves the handoff.\n`
        : `This phase ends when ${escapeText(phase.exitTool.id)} succeeds. Then move the card with factory_transition_work_item to one of: ${phase.nextPhases.map(escapeText).join(', ')}.\n`
      : '';
  const runtime =
    value.modelId && value.thinkingLevel ? { modelId: value.modelId, thinkingLevel: value.thinkingLevel } : null;
  const contents =
    `Factory ${board} phase: ${escapeText(phaseLabel)} (${escapeText(stage)})\n` +
    `Work item: ${escapeText(item.title)} (${item.id})\n` +
    `Role: ${escapeText(binding.role)}\nRevision: ${item.revision}\nConfig: ${escapeText(input.configVersion)}\n` +
    (runtime
      ? `Runtime: model=${escapeText(runtime.modelId)}, reasoning-setting=${escapeText(runtime.thinkingLevel)}\n`
      : '') +
    // Review and every board that ships change requests (Work) park cards in Intake.
    ((board === 'review' || boards.get(board)?.changeRequests !== undefined) && stage === 'intake'
      ? 'This card rests in Intake: its work is paused. Answer questions without moving it; when the user asks to resume, request the transition into the working stage first, then continue the work in this session.\n'
      : '') +
    exitText +
    `Use factory_transition_work_item with expectedRevision ${item.revision} to request a phase change.${escapeText(linkedText)}`;
  return { value, contents, linked };
}

export interface FactoryPhaseStateProcessorOptions {
  configVersion: string;
  storage: WorkItemsStorage;
  boards: BoardRegistry | ProjectBoardSource;
  loadMemorySettings?: (args: {
    requestContext: ProcessInputStepArgs['requestContext'];
    binding: FactoryRunBindingRecord | null;
  }) => Promise<void>;
  /** The Factory's stored thinking default, used when the session has not picked a level. */
  factoryThinkingLevel?: (factoryProjectId: string) => Promise<ThinkingLevel>;
  transitionService?: Pick<FactoryTransitionService, 'transition'>;
  messageReader?: PersistedMessageReader;
  recordPullRequestProvenance?: (input: {
    binding: FactoryRunBindingRecord;
    item: WorkItemRow;
    assistantMessageId: string;
    toolCallId: string;
    toolName: string;
    toolInput: FactoryRuleJsonValue;
    toolResult: FactoryRuleJsonValue;
    status: 'success' | 'error';
  }) => Promise<void>;
  /**
   * The tool name a board rule knows, for a call stored under another name: a Claude Code
   * session's transcript names the Factory's tools as its MCP client does (`mcp__factory__<tool>`).
   */
  bareToolName?: (toolName: string) => string;
}

export class FactoryPhaseStateProcessor implements Processor<'factory-phase'> {
  readonly id = STATE_ID;
  readonly stateId = STATE_ID;
  /** Request contexts whose caller row is already resolved for this request. */
  private readonly loadedMemorySettings = new WeakSet<object>();

  private readonly options: FactoryPhaseStateProcessorOptions;
  private readonly boards: ProjectBoardSource;

  constructor(options: FactoryPhaseStateProcessorOptions) {
    this.options = options;
    this.boards = toBoardSource(options.boards);
  }

  /**
   * Memory settings are caller state, not run state. Factory invokes this while
   * resolving its configured processor list, before Agent resolves dynamic
   * Memory and enumerates Memory's processors. This guarantees both the Memory
   * options and its model callbacks see the authoritative row for this
   * invocation. Doing this in `processInputStep` would be too late: Memory's
   * input-step hook runs before configured processors.
   */
  async prepareMemorySettings(requestContext: ProcessInputArgs['requestContext']): Promise<void> {
    await this.loadCallerMemorySettings(requestContext, undefined, true);
  }

  async processInput(args: ProcessInputArgs): Promise<MessageList> {
    await this.loadCallerMemorySettings(args.requestContext);
    return args.messageList;
  }

  async processInputStep(args: ProcessInputStepArgs): Promise<MessageList | undefined> {
    const address = getFactorySessionCoordinates(args.requestContext);
    let binding: FactoryRunBindingRecord | null | undefined;
    try {
      binding = address ? await this.options.storage.findRunBindingBySession(address) : undefined;
    } catch {
      await this.loadCallerMemorySettings(args.requestContext, undefined);
      return;
    }
    // Resumed runs skip the input-processor phase, so re-check here: it is a
    // no-op once `processInput` already placed the row for this request. Passing
    // `undefined` (not `null`) keeps the recovery lookup inside the loader, so a
    // recovered session reaches its project row from this hook too.
    await this.loadCallerMemorySettings(args.requestContext, binding);
    if (!binding || binding.status !== 'active') return;
    const completedToolCallIds = completedStepToolCallIds(args.steps);
    const completedMessage = currentCompletedToolMessage(args.messages, completedToolCallIds);
    if (completedMessage) {
      await this.ingestMessages(binding, [completedMessage], completedToolCallIds);
    }
  }

  /**
   * Loads the caller's row once per invocation. The input hook always refreshes
   * it in case the controller reused a request context; later step hooks reuse
   * that value (`undefined` means it has not been loaded yet; `null` means an
   * empty row).
   *
   * The WeakSet covers loaders that do not set the context key themselves, so a
   * request is still loaded once. A failed load records an unavailable sentinel
   * (memory then runs both roles on auto with default thresholds) and is not
   * marked loaded so the next step can retry.
   */
  private async loadCallerMemorySettings(
    requestContext: ProcessInputStepArgs['requestContext'] | ProcessInputArgs['requestContext'],
    binding?: FactoryRunBindingRecord | null,
    force = false,
  ): Promise<void> {
    if (!requestContext || !this.options.loadMemorySettings) return;
    const currentSettings = requestContext.get('mastra__factoryMemorySettings') as
      | { status?: unknown }
      | null
      | undefined;
    if (force) this.loadedMemorySettings.delete(requestContext);
    if (!force && currentSettings !== undefined && currentSettings?.status !== 'unavailable') return;
    if (!force && this.loadedMemorySettings.has(requestContext)) return;
    try {
      let runBinding = binding ?? null;
      if (binding === undefined) {
        const address = getFactorySessionCoordinates(requestContext);
        runBinding = address
          ? await this.options.storage.findRunBindingBySession(address)
          : // Crash-recovered sessions come back with empty state, so the binding
            // table is the last source of the project whose row applies. Without
            // this the run would silently read the caller's personal row.
            await findSessionRunBinding(requestContext, this.options.storage);
      }
      await this.options.loadMemorySettings({ requestContext, binding: runBinding });
      this.loadedMemorySettings.add(requestContext);
    } catch (error) {
      reportMemorySettingsUnavailable(requestContext, error instanceof Error ? error.message : String(error));
    }
  }

  async computeStateSignal(args: ComputeStateSignalArgs): Promise<ComputeStateSignalResult> {
    const address = getFactorySessionCoordinates(args.requestContext);
    if (!address) return;
    const binding = await this.options.storage.findRunBindingBySession(address);
    const prior = latestPhase(args);
    const hasBase = Boolean(args.lastSnapshot) && args.contextWindow.hasSnapshot;

    if (!binding) return;
    if (binding.status !== 'active') {
      if (!hasBase || prior?.status !== 'active') return;
      return {
        id: STATE_ID,
        cacheKey: `factory:none:${prior.bindingId ?? 'revoked'}`,
        mode: 'snapshot',
        tagName: 'factory-phase',
        contents: '\n',
        value: { phase: { status: 'none' } },
        attributes: { status: 'none' },
        metadata: { value: { phase: { status: 'none' } } },
      };
    }

    const described = await describeFactoryPhase({
      storage: this.options.storage,
      boards: this.boards,
      configVersion: this.options.configVersion,
      binding,
      runtime: async () =>
        reviewRuntimeFromRequestContext(
          args.requestContext,
          await this.options.factoryThinkingLevel?.(binding.factoryProjectId),
        ),
    });
    if (!described) return;
    const { value, contents: snapshotContents, linked } = described;
    const { board, stage } = value;
    const cacheKey = await phaseCacheKey(value, linked);
    if (hasBase && (args.tracking?.currentCacheKey ?? args.lastSnapshot?.metadata?.state?.cacheKey) === cacheKey)
      return;
    const runtime =
      value.modelId && value.thinkingLevel ? { modelId: value.modelId, thinkingLevel: value.thinkingLevel } : null;
    const isDelta = hasBase && prior?.status === 'active';
    return {
      id: STATE_ID,
      cacheKey,
      mode: isDelta ? 'delta' : 'snapshot',
      tagName: 'factory-phase',
      contents: isDelta ? `Factory phase update:\n${snapshotContents}` : snapshotContents,
      value: { phase: value },
      ...(isDelta ? { delta: { phase: value } } : {}),
      attributes: {
        status: 'active',
        board,
        stage,
        role: binding.role,
        revision: value.revision,
        ...(runtime ?? {}),
      },
      metadata: { value: { phase: value } },
    };
  }

  async reconcileAllBoundThreads(): Promise<void> {
    if (!this.options.messageReader) return;
    const bindings = await this.options.storage.listActiveRunBindings();
    for (const binding of bindings) await this.reconcileBinding(binding);
  }

  async reconcileBinding(binding: FactoryRunBindingRecord): Promise<void> {
    const reader = this.options.messageReader;
    if (!reader || binding.status !== 'active') return;
    // One keyed read up front: a binding whose item is gone or no longer in a
    // single rule stage would ingest nothing, so skip the cursor and message
    // reads entirely instead of paying them on every walk.
    const item = await this.options.storage.get({ orgId: binding.orgId, id: binding.workItemId });
    if (!itemInRuleStage(await this.boards.load(binding), item)) return;
    const cursor = await this.options.storage.getToolResultCursor(binding.orgId, binding.factoryProjectId, binding.id);
    let page = 0;
    while (true) {
      const result = await reader.listMessages({
        threadId: binding.threadId,
        resourceId: binding.resourceId,
        page,
        perPage: TRANSCRIPT_PAGE_SIZE,
        ...(cursor ? { filter: { dateRange: { start: cursor.lastMessageCreatedAt } } } : {}),
        orderBy: { field: 'createdAt', direction: 'ASC' },
      });
      await this.ingestMessages(binding, result.messages, undefined, item);
      const last = result.messages.at(-1);
      if (last) {
        await this.options.storage.advanceToolResultCursor({
          bindingId: binding.id,
          orgId: binding.orgId,
          factoryProjectId: binding.factoryProjectId,
          lastMessageId: last.id,
          lastMessageCreatedAt: last.createdAt instanceof Date ? last.createdAt : new Date(last.createdAt),
          updatedAt: new Date(),
        });
      }
      if (!result.hasMore) break;
      page += 1;
    }
  }

  private async ingestMessages(
    binding: FactoryRunBindingRecord,
    messages: MastraDBMessage[],
    toolCallIds?: ReadonlySet<string>,
    preloadedItem?: Card,
  ): Promise<void> {
    const item = preloadedItem ?? (await this.options.storage.get({ orgId: binding.orgId, id: binding.workItemId }));
    if (!itemInRuleStage(await this.boards.load(binding), item)) return;
    for (const message of messages) {
      for (const stored of completedToolResults(message)) {
        const toolResult = this.options.bareToolName
          ? { ...stored, toolName: this.options.bareToolName(stored.toolName) }
          : stored;
        if (toolCallIds && !toolCallIds.has(toolResult.toolCallId)) continue;
        try {
          await this.options.recordPullRequestProvenance?.({
            binding,
            item,
            assistantMessageId: toolResult.assistantMessageId,
            toolCallId: toolResult.toolCallId,
            toolName: toolResult.toolName,
            toolInput: toolResult.input,
            toolResult: toolResult.value,
            status: toolResult.status,
          });
        } catch {
          // Provenance is supporting evidence and must not block authoritative rule ingress.
        }
        await this.ingestToolResult(binding, item, toolResult);
      }
    }
  }

  private async ingestToolResult(
    binding: FactoryRunBindingRecord,
    item: Card,
    toolResult: CompletedToolResult,
  ): Promise<void> {
    const board = boardForWorkItem(item);
    const boards = await this.boards.load(binding);
    const rule = resolveBoardToolRule(boards, board, toolResult.toolName);
    if (!rule) return;
    const ingressId = JSON.stringify([
      binding.id,
      binding.threadId,
      toolResult.assistantMessageId,
      toolResult.toolCallId,
    ]);
    const prior = await this.options.storage.getTransitionResultByIngress(
      binding.orgId,
      binding.factoryProjectId,
      ingressId,
    );
    if (prior) return;
    const context: FactoryToolResultRuleContext = {
      tenant: { orgId: binding.orgId, projectId: binding.factoryProjectId },
      actor: { type: 'agent', bindingId: binding.id, role: binding.role },
      ingress: { type: 'toolResult', id: ingressId },
      cause: `Completed ${toolResult.toolName}`,
      causalChain: [],
      configVersion: this.options.configVersion,
      item: {
        id: item.id,
        source: workItemSource(item.externalSource),
        sourceKey: workItemSourceKey(item),
        parentWorkItemId: item.parentWorkItemId,
        title: item.title,
        url: item.externalSource?.url ?? null,
        stages: item.stages,
        workItem: item.workItem,
        acceptedAt: item.acceptedAt,
        metadata: item.metadata,
      },
      board,
      itemRevision: item.revision,
      toolName: toolResult.toolName,
      threadId: binding.threadId,
      assistantMessageId: toolResult.assistantMessageId,
      toolCallId: toolResult.toolCallId,
      result: { status: toolResult.status, value: toolResult.value },
    };

    let decision: FactoryRuleDecision | void = undefined;
    let decisions: FactoryCommitDecision[] = [];
    let outcome: { status: 'accepted' | 'rejected'; code?: string; reason?: string } = { status: 'accepted' };
    try {
      decision = await withRuleTimeout(Promise.resolve(rule(Object.freeze(context))));
      if (decision?.type === 'reject') {
        outcome = { status: 'rejected', code: decision.code, reason: decision.reason };
      } else if (decision) {
        const validated = validateFactoryRuleDecisions([decision]);
        for (const entry of validated) assertFactoryDecisionTarget(entry, boards, board);
        decisions = validated;
      }
    } catch (error) {
      const timedOut = error instanceof Error && error.message === 'FACTORY_RULE_TIMEOUT';
      outcome = {
        status: 'rejected',
        code: timedOut ? 'timeout' : 'rule_error',
        reason: timedOut
          ? 'Factory rule evaluation timed out.'
          : error instanceof Error
            ? error.message.slice(0, 2_000)
            : 'Factory tool-result rule failed.',
      };
    }
    const committed = await this.options.storage.commitRuleEvaluation({
      orgId: binding.orgId,
      factoryProjectId: binding.factoryProjectId,
      workItemId: item.id,
      ingress: { identity: ingressId, triggerType: 'tool.result' },
      configVersion: this.options.configVersion,
      expectedRevision: item.revision,
      actor: { ...context.actor },
      outcome,
      decisions: decisions.map(entry => ({ ...entry })),
      causalChain: [],
      now: new Date(),
      // The bound agent's own tool call carries the same consent as its governed moves.
      consentedBy: `agent:${binding.id}`,
    });
    if (committed.status !== 'committed' || !this.options.transitionService) return;
    for (const entry of decisions) {
      if (entry.type !== 'transition') continue;
      await this.options.transitionService.transition({
        orgId: binding.orgId,
        factoryProjectId: binding.factoryProjectId,
        workItemId: item.id,
        board: entry.board,
        stage: entry.stage,
        ...(entry.reenter ? { reenter: true } : {}),
        expectedRevision: item.revision,
        actor: { type: 'system', id: 'factory-tool-result-rule' },
        ingress: { type: 'rule', identity: `decision:${entry.idempotencyKey}` },
        cause: 'tool_result_rule',
        causalChain: [{ ingressId, decisionType: entry.type }],
        ...(isApprovedPlanResult(toolResult) ? { planApproved: true } : {}),
        ...(toolResult.status === 'success' ? { completedTool: toolResult.toolName } : {}),
        ...(toolResult.status === 'success' ? { completedTool: toolResult.toolName } : {}),
      });
    }
  }
}
