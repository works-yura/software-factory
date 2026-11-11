// The host side of the port. t3code reads threads from its SQLite projection store
// (`ProjectionStoreV2Shape.getThreadRecords` / `getTimelinePage`); a Factory host implements
// these over whatever keeps its threads (Mastra memory, the Claude Code transcript, …) and maps
// its messages onto `OrchestrationV2TurnItem`.
import type {
  OrchestrationV2AppThread,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2TurnItem,
  RunId,
  ThreadId,
  TurnItemId,
} from "./contracts.ts";

export interface HandoffThreadRecords {
  readonly thread: OrchestrationV2AppThread;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly attempts: ReadonlyArray<OrchestrationV2RunAttempt>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}

export type HandoffRecordField = Exclude<keyof HandoffThreadRecords, "thread">;

export interface HandoffRecordFilter {
  /** Only items of these runs; `null` selects items without a run (imported history). */
  readonly turnItemRunIds?: ReadonlyArray<RunId | null>;
}

/** What the handoff code reads from the host. */
export interface HandoffHistorySource {
  /**
   * The thread and the requested records, items in timeline order. Throws
   * `HandoffThreadNotFoundError` for a thread the host does not have.
   */
  readonly getThreadRecords: <K extends HandoffRecordField>(
    threadId: ThreadId,
    fields: ReadonlyArray<K>,
    filter?: HandoffRecordFilter,
  ) => Promise<Pick<HandoffThreadRecords, "thread" | K>>;
}

/** From t3code apps/server/src/orchestration-v2/ProjectionStore.ts. */
export interface ProjectionTimelinePageOptions {
  readonly afterPosition?: number;
  readonly itemId?: TurnItemId;
  readonly view?: "messages" | "activity";
  readonly limit: number;
}

export interface ProjectionTimelinePage {
  readonly items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly totalItems: number;
  readonly hasMore: boolean;
}

/** What the thread-read tool reads from the host. */
export interface ThreadReadSource {
  /** Throws `HandoffThreadNotFoundError` for a thread the caller may not read. */
  readonly getThread: (threadId: ThreadId) => Promise<{ readonly id: ThreadId; readonly title: string }>;
  readonly getTimelinePage: (
    threadId: ThreadId,
    options: ProjectionTimelinePageOptions,
  ) => Promise<ProjectionTimelinePage>;
}

/**
 * The in-memory form of t3code's `getTimelinePage` SQL: page a thread's visible timeline (its
 * inherited rows, then its own) by position, or find one item by id. `messages` shows only user
 * and assistant messages and plans.
 */
export function timelinePageFromRows(
  visible: ReadonlyArray<Omit<OrchestrationV2ProjectedTurnItem, "position">>,
  options: ProjectionTimelinePageOptions,
): ProjectionTimelinePage {
  const matching = visible
    .map((row, position) => ({ ...row, position }))
    .filter((row) =>
      options.itemId === undefined
        ? row.position > (options.afterPosition ?? -1) &&
          (options.view === "activity" ||
            ["user_message", "assistant_message", "proposed_plan"].includes(row.item.type))
        : row.sourceItemId === options.itemId,
    );
  const page = matching.slice(0, options.limit);
  return {
    items: page,
    totalItems: visible.length,
    hasMore: matching.length > page.length,
  };
}
