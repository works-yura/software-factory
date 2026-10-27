/**
 * The card fields the conveyor reads. Persistence stays behind {@link CardMoveStore};
 * v3's `WorkItemsStorage` is not part of this package.
 */
export interface ExternalWorkItemSource {
  integrationId: string;
  type: string;
  /**
   * The tenant on the platform, never ours: a Slack team (`T0ABC…`), a Discord
   * guild. Scopes the key, because a platform id such as a channel or a message
   * `ts` is only unique inside the workspace that issued it.
   */
  workspaceId?: string;
  externalId: string;
  url?: string;
}

export interface PipelineCard {
  id: string;
  orgId: string;
  factoryProjectId: string;
  board: string | null;
  externalSource: ExternalWorkItemSource | null;
  stages: string[];
  sessions: Readonly<Record<string, unknown>>;
  metadata: Record<string, unknown> | null;
  revision: number;
}

export class WorkItemUpdateConflictError extends Error {
  readonly code = 'work_item_update_conflict';
  readonly reason: 'board' | 'revision';

  constructor(reason: 'board' | 'revision') {
    super(`Work item ${reason} precondition failed`);
    this.reason = reason;
    this.name = 'WorkItemUpdateConflictError';
  }
}

/**
 * The two writes a board change performs. A host implements them on its own store; the engine
 * issues them in order and does not wrap them in a transaction.
 */
export interface CardMoveStore {
  /**
   * Compare-and-set on `expectedRevision` and `expectedBoard`. Throws
   * {@link WorkItemUpdateConflictError} or resolves falsy when the preconditions fail.
   */
  update(input: {
    orgId: string;
    id: string;
    userId: string;
    patch: { board: string; stages: string[] };
    expectedRevision: number;
    expectedBoard: string | null;
  }): Promise<unknown>;
  supersedeDecisionsForWorkItem(input: {
    orgId: string;
    factoryProjectId: string;
    workItemId: string;
    supersededAt: Date;
  }): Promise<unknown>;
}
