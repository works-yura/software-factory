import { FactoryStorageDomain } from '@mastra/core/storage';
import type { CollectionSchema, CollectionWhere } from '@mastra/core/storage';

import type { AccountUsageLimits, UsageTurn, UsageWindow } from '@factory/harness/usage';
import { mergeUsageWindows, utcDay } from '@factory/harness/usage';

/**
 * What the Factory's agents spent: one row per turn of a session on any harness (Claude Code,
 * Codex, Mastra), written from the harness's `usage_update` events when the turn ends, and the last
 * allowance windows each subscription account was seen with.
 *
 * A turn's day (`day`, UTC) is stored beside its time so a period reads as a list of days: the
 * storage surface filters by equality only.
 */
export const USAGE_TURNS_SCHEMA: CollectionSchema = {
  name: 'factory_usage_turns',
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    factory_project_id: { type: 'text', nullable: true },
    session_id: { type: 'text' },
    thread_id: { type: 'text', nullable: true },
    run_id: { type: 'text', nullable: true },
    work_item_id: { type: 'text', nullable: true },
    kickoff_id: { type: 'text', nullable: true },
    user_id: { type: 'text', nullable: true },
    harness_id: { type: 'text' },
    model: { type: 'text', nullable: true },
    account_id: { type: 'text', nullable: true },
    occurred_at: { type: 'timestamp' },
    day: { type: 'text' },
    input_tokens: { type: 'bigint' },
    cache_read_tokens: { type: 'bigint' },
    cache_write_tokens: { type: 'bigint' },
    output_tokens: { type: 'bigint' },
    reasoning_tokens: { type: 'bigint' },
    step_count: { type: 'integer' },
    context_tokens: { type: 'bigint', nullable: true },
    /** The provider's own cost for the turn, in millionths of a dollar. */
    reported_cost_micros: { type: 'bigint', nullable: true },
  },
  indexes: [
    { name: 'factory_usage_turns_org_day_idx', columns: ['org_id', 'day'] },
    { name: 'factory_usage_turns_session_idx', columns: ['session_id', 'occurred_at'] },
    { name: 'factory_usage_turns_work_item_idx', columns: ['org_id', 'work_item_id'] },
  ],
};

export const ACCOUNT_USAGE_LIMITS_SCHEMA: CollectionSchema = {
  name: 'factory_account_usage_limits',
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    account_id: { type: 'text' },
    checked_at: { type: 'timestamp' },
    source: { type: 'text' },
    windows: { type: 'json' },
    unavailable: { type: 'json', nullable: true },
  },
  uniqueIndexes: [{ name: 'factory_account_usage_limits_account_idx', columns: ['org_id', 'account_id'] }],
};

interface TurnRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  factory_project_id: string | null;
  session_id: string;
  thread_id: string | null;
  run_id: string | null;
  work_item_id: string | null;
  kickoff_id: string | null;
  user_id: string | null;
  harness_id: string;
  model: string | null;
  account_id: string | null;
  occurred_at: Date;
  day: string;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  step_count: number;
  context_tokens: number | null;
  reported_cost_micros: number | null;
}

interface LimitsRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  account_id: string;
  checked_at: Date;
  source: string;
  windows: unknown;
  unavailable: unknown;
}

/** A turn to record: everything but its id, and the organization it is filed under. */
export type RecordUsageTurnInput = Omit<UsageTurn, 'id'> & { orgId: string };

/** Which turns of an organization to read; every filter is optional. */
export interface UsageTurnFilter {
  orgId: string;
  /** UTC days (`YYYY-MM-DD`) the turns ended on. */
  days?: ReadonlyArray<string>;
  factoryProjectId?: string;
  harnessId?: string;
  model?: string;
  accountId?: string;
}

/** How many values one `in` filter carries; longer lists are read in chunks. */
const IN_CHUNK = 200;

const round = (value: number) => Math.max(0, Math.round(value));

function json<T>(value: unknown): T | undefined {
  if (value === null || value === undefined) return undefined;
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function toTurn(row: TurnRow): UsageTurn {
  return {
    id: row.id,
    sessionId: row.session_id,
    threadId: row.thread_id,
    runId: row.run_id,
    factoryProjectId: row.factory_project_id,
    workItemId: row.work_item_id,
    kickoffId: row.kickoff_id,
    userId: row.user_id,
    harnessId: row.harness_id,
    model: row.model,
    accountId: row.account_id,
    occurredAt: new Date(row.occurred_at).toISOString(),
    totals: {
      inputTokens: Number(row.input_tokens),
      cacheReadTokens: Number(row.cache_read_tokens),
      cacheWriteTokens: Number(row.cache_write_tokens),
      outputTokens: Number(row.output_tokens),
      reasoningTokens: Number(row.reasoning_tokens),
    },
    stepCount: Number(row.step_count),
    contextTokens: row.context_tokens === null ? null : Number(row.context_tokens),
    reportedCostUsd: row.reported_cost_micros === null ? null : Number(row.reported_cost_micros) / 1_000_000,
  };
}

function toLimits(row: LimitsRow): AccountUsageLimits {
  const unavailable = json<AccountUsageLimits['unavailable']>(row.unavailable);
  return {
    checkedAt: new Date(row.checked_at).toISOString(),
    windows: json<UsageWindow[]>(row.windows) ?? [],
    source: row.source === 'probe' ? 'probe' : 'stream',
    ...(unavailable ? { unavailable } : {}),
  };
}

function chunks<T>(values: ReadonlyArray<T>): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < values.length; at += IN_CHUNK) out.push(values.slice(at, at + IN_CHUNK));
  return out;
}

export class UsageStorage extends FactoryStorageDomain {
  constructor() {
    super('usage');
  }

  async init(): Promise<void> {
    await this.ensureCollections([USAGE_TURNS_SCHEMA, ACCOUNT_USAGE_LIMITS_SCHEMA]);
  }

  async dangerouslyClearAll(): Promise<void> {
    await this.ops.deleteMany(USAGE_TURNS_SCHEMA.name, {});
    await this.ops.deleteMany(ACCOUNT_USAGE_LIMITS_SCHEMA.name, {});
  }

  async recordTurn(input: RecordUsageTurnInput): Promise<UsageTurn> {
    const occurredAt = new Date(input.occurredAt);
    const row = await this.ops.insertOne<TurnRow>(USAGE_TURNS_SCHEMA.name, {
      org_id: input.orgId,
      factory_project_id: input.factoryProjectId,
      session_id: input.sessionId,
      thread_id: input.threadId,
      run_id: input.runId,
      work_item_id: input.workItemId,
      kickoff_id: input.kickoffId,
      user_id: input.userId,
      harness_id: input.harnessId,
      model: input.model,
      account_id: input.accountId,
      occurred_at: occurredAt,
      day: utcDay(occurredAt),
      input_tokens: round(input.totals.inputTokens),
      cache_read_tokens: round(input.totals.cacheReadTokens),
      cache_write_tokens: round(input.totals.cacheWriteTokens),
      output_tokens: round(input.totals.outputTokens),
      reasoning_tokens: round(input.totals.reasoningTokens),
      step_count: round(input.stepCount),
      context_tokens: input.contextTokens === null ? null : round(input.contextTokens),
      reported_cost_micros: input.reportedCostUsd === null ? null : round(input.reportedCostUsd * 1_000_000),
    });
    return toTurn(row);
  }

  /** An organization's turns, oldest first. */
  async listTurns(filter: UsageTurnFilter): Promise<UsageTurn[]> {
    const base: CollectionWhere = { org_id: filter.orgId };
    if (filter.factoryProjectId) base.factory_project_id = filter.factoryProjectId;
    if (filter.harnessId) base.harness_id = filter.harnessId;
    if (filter.model) base.model = filter.model;
    if (filter.accountId) base.account_id = filter.accountId;
    const wheres = filter.days ? chunks(filter.days).map(days => ({ ...base, day: { in: days } })) : [base];
    const rows: TurnRow[] = [];
    for (const where of wheres) {
      rows.push(...(await this.ops.findMany<TurnRow>(USAGE_TURNS_SCHEMA.name, where, { orderBy: [['occurred_at', 'asc']] })));
    }
    return rows.map(toTurn).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }

  /** A session's turns, oldest first. */
  async listSessionTurns(orgId: string, sessionId: string): Promise<UsageTurn[]> {
    const rows = await this.ops.findMany<TurnRow>(
      USAGE_TURNS_SCHEMA.name,
      { org_id: orgId, session_id: sessionId },
      { orderBy: [['occurred_at', 'asc']] },
    );
    return rows.map(toTurn);
  }

  /** The turns of these cards' runs, oldest first. */
  async listWorkItemTurns(orgId: string, workItemIds: ReadonlyArray<string>): Promise<UsageTurn[]> {
    const rows: TurnRow[] = [];
    for (const ids of chunks(workItemIds)) {
      rows.push(
        ...(await this.ops.findMany<TurnRow>(
          USAGE_TURNS_SCHEMA.name,
          { org_id: orgId, work_item_id: { in: ids } },
          { orderBy: [['occurred_at', 'asc']] },
        )),
      );
    }
    return rows.map(toTurn).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }

  /** The last windows seen for these accounts, by account id. */
  async listAccountLimits(orgId: string, accountIds: ReadonlyArray<string>): Promise<Map<string, AccountUsageLimits>> {
    const found = new Map<string, AccountUsageLimits>();
    for (const ids of chunks(accountIds)) {
      const rows = await this.ops.findMany<LimitsRow>(ACCOUNT_USAGE_LIMITS_SCHEMA.name, { org_id: orgId, account_id: { in: ids } });
      for (const row of rows) found.set(row.account_id, toLimits(row));
    }
    return found;
  }

  /** Replaces what is known of the account's windows (a probe read them all). */
  async saveAccountLimits(orgId: string, accountId: string, limits: AccountUsageLimits): Promise<AccountUsageLimits> {
    const row = await this.ops.upsertOne<LimitsRow>(ACCOUNT_USAGE_LIMITS_SCHEMA.name, ['org_id', 'account_id'], {
      org_id: orgId,
      account_id: accountId,
      checked_at: new Date(limits.checkedAt),
      source: limits.source,
      windows: limits.windows,
      unavailable: limits.unavailable ?? null,
    });
    return toLimits(row);
  }

  /**
   * Folds windows a running turn was told into what is known of the account: the windows it names
   * replace theirs, the rest stay. An update older than what is stored changes nothing.
   */
  async mergeAccountLimits(
    orgId: string,
    accountId: string,
    update: { windows: ReadonlyArray<UsageWindow>; checkedAt: string },
  ): Promise<AccountUsageLimits> {
    const merged = await this.ops.updateAtomic<LimitsRow>(
      ACCOUNT_USAGE_LIMITS_SCHEMA.name,
      { org_id: orgId, account_id: accountId },
      row => {
        if (new Date(row.checked_at).getTime() > Date.parse(update.checkedAt)) return null;
        return {
          windows: mergeUsageWindows(json<UsageWindow[]>(row.windows) ?? [], update.windows),
          checked_at: new Date(update.checkedAt),
          source: 'stream',
          unavailable: null,
        };
      },
    );
    if (merged) return toLimits(merged);
    return this.saveAccountLimits(orgId, accountId, { checkedAt: update.checkedAt, windows: [...update.windows], source: 'stream' });
  }
}
