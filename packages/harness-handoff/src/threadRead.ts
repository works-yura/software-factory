// The thread-read tool a handoff points the agent at to recover omitted history.
// It pages a thread's timeline and long items; the thread detail and recent-runs header are left
// to the host's own thread views.
import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2TurnItem,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadTimelineItem,
  ThreadId,
} from "./contracts.ts";
import { readInheritedHandoffItems, visibleConversationItems } from "./ContextHandoffService.ts";
import { THREAD_READ_TOOL_NAME } from "./handoffBudget.ts";
import {
  timelinePageFromRows,
  type HandoffHistorySource,
  type ThreadReadSource,
} from "./historySource.ts";

export { THREAD_READ_TOOL_NAME };

export const DEFAULT_THREAD_READ_LIMIT = 50;
export const DEFAULT_THREAD_ITEM_MAX_CHARS = 20_000;

export const THREAD_READ_TOOL_DESCRIPTION =
  "Read any thread by id. `messages` (default): user and assistant messages and plans. `activity`: all timeline items. Keep reads small: low `limit` and `maxCharsPerItem`. Page with `afterPosition=nextPosition`. Cut-off text: `itemId` with `textOffset=nextTextOffset`.";

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function turnItemText(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "notification":
      return [item.summary, item.detail].filter((part) => part !== undefined).join("\n");
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return item.text;
    case "proposed_plan":
      return item.markdown;
    case "file_change":
      return [
        item.fileName,
        item.additions === undefined && item.deletions === undefined
          ? undefined
          : `+${item.additions ?? 0} -${item.deletions ?? 0}`,
        item.diffStr ?? item.newStr,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "command_execution":
      return [`$ ${item.input}`, item.output]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "checkpoint":
      return jsonText(item.files);
    case "run_interrupt_request":
    case "run_interrupt_result":
    case "system_notice":
      return item.message;
    case "error":
      return item.failure.message;
    case "compaction":
      return item.summary ?? null;
    case "handoff":
      return item.summary ?? `${item.strategy} handoff to ${item.toProviderInstanceId}`;
    case "fork":
      return `Forked to thread ${item.targetThreadId}.`;
    case "dynamic_tool":
      return jsonText({ toolName: item.toolName, input: item.input, output: item.output });
  }
}

/** A cut inside a surrogate pair would leave half an emoji on each page. */
function textPageEnd(text: string | null, offset: number, maxChars: number): number {
  const end = offset + maxChars;
  if (text === null || end >= text.length) return end;
  const last = text.charCodeAt(end - 1);
  if (last < 0xd800 || last > 0xdbff) return end;
  return end - 1 > offset ? end - 1 : end + 1;
}

function timelineItem(input: {
  readonly row: OrchestrationV2ProjectedTurnItem;
  readonly maxChars: number;
  readonly textOffset?: number;
}): OrchestratorMcpThreadTimelineItem {
  const text = turnItemText(input.row.item);
  const offset = input.textOffset ?? 0;
  const end = textPageEnd(text, offset, input.maxChars);
  const textTruncated = text !== null && text.length > end;
  const messageId =
    input.row.item.type === "user_message" || input.row.item.type === "assistant_message"
      ? input.row.item.messageId
      : null;
  return {
    position: input.row.position,
    visibility: input.row.visibility,
    sourceThreadId: input.row.sourceThreadId,
    itemId: input.row.sourceItemId,
    runId: input.row.item.runId,
    messageId,
    createdBy: input.row.item.type === "user_message" ? input.row.item.createdBy : null,
    type: input.row.item.type,
    status: input.row.item.status,
    title: input.row.item.title,
    text: text === null ? null : text.slice(offset, end),
    textTruncated,
    nextTextOffset: textTruncated ? end : null,
    updatedAt: input.row.item.updatedAt,
  };
}

/** `OrchestratorMcpService.readThread`, without the parts listed at the top of this file. */
export async function readThread(
  source: ThreadReadSource,
  input: OrchestratorMcpThreadReadInput,
): Promise<OrchestratorMcpThreadReadResult> {
  const thread = await source.getThread(input.threadId);
  const view = input.view ?? "messages";
  const afterPosition = input.afterPosition ?? -1;
  const limit = input.limit ?? DEFAULT_THREAD_READ_LIMIT;
  const maxChars = input.maxCharsPerItem ?? DEFAULT_THREAD_ITEM_MAX_CHARS;
  const timeline = await source.getTimelinePage(input.threadId, {
    afterPosition,
    limit,
    view,
    ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
  });
  const page = timeline.items;
  return {
    thread: { threadId: thread.id, title: thread.title, itemCount: timeline.totalItems },
    items: page.map((row) =>
      timelineItem({
        row,
        maxChars,
        ...(input.itemId === undefined ? {} : { textOffset: input.textOffset ?? 0 }),
      }),
    ),
    nextPosition: page.at(-1)?.position ?? null,
    hasMore: timeline.hasMore,
  };
}

/**
 * A thread's visible timeline: rows inherited from fork ancestors
 * (oldest first), then its own rows without rolled-back runs and cancelled queued input.
 */
export async function readTimelineRows(
  history: HandoffHistorySource,
  threadId: ThreadId,
): Promise<Array<Omit<OrchestrationV2ProjectedTurnItem, "position">>> {
  const records = await history.getThreadRecords(threadId, ["runs", "attempts", "turnItems"]);
  const inherited = await readInheritedHandoffItems(history, records.thread);
  return [
    ...inherited.map((item) => ({
      visibility: "inherited" as const,
      sourceThreadId: item.threadId,
      sourceItemId: item.id,
      item,
    })),
    ...visibleConversationItems(records, records.turnItems).map((item) => ({
      visibility: "local" as const,
      sourceThreadId: item.threadId,
      sourceItemId: item.id,
      item,
    })),
  ];
}

/** A {@link ThreadReadSource} over a {@link HandoffHistorySource}, for hosts without their own timeline index. */
export function threadReadSourceFromHistory(history: HandoffHistorySource): ThreadReadSource {
  return {
    getThread: async (threadId) => {
      const { thread } = await history.getThreadRecords(threadId, []);
      return { id: thread.id, title: thread.title };
    },
    getTimelinePage: async (threadId, options) =>
      timelinePageFromRows(await readTimelineRows(history, threadId), options),
  };
}
