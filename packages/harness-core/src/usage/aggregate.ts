// Usage turns summed for reading: a session's or a card's total, and the Factory's totals by day,
// harness, model, account and Factory over a period. Pure, so the server and its tests share it.
import type { UsageTokenTotals, UsageTurn } from './contracts.ts';
import { addTokenTotals, emptyTokenTotals, totalTokens } from './contracts.ts';
import type { RateTable } from './pricing.ts';
import { DEFAULT_RATE_TABLE, modelContextWindow, priceUsage } from './pricing.ts';

/** Turns summed: their tokens, what they cost, and how much of that is only an estimate. */
export interface UsageAggregate {
  turns: number;
  totals: UsageTokenTotals;
  totalTokens: number;
  /** Reported and estimated cost together. */
  costUsd: number;
  /** The part of `costUsd` the provider reported (the rest is the rate table's estimate). */
  reportedCostUsd: number;
  /** Turns no rate prices: their tokens count, their cost is unknown (not zero). */
  unpricedTurns: number;
}

export function emptyUsageAggregate(): UsageAggregate {
  return { turns: 0, totals: emptyTokenTotals(), totalTokens: 0, costUsd: 0, reportedCostUsd: 0, unpricedTurns: 0 };
}

/** One turn with its price. */
export interface PricedUsageTurn extends UsageTurn {
  totalTokens: number;
  costUsd: number;
  costSource: 'reported' | 'estimated' | 'unpriced';
}

export function priceTurn(turn: UsageTurn, table: RateTable = DEFAULT_RATE_TABLE): PricedUsageTurn {
  const priced = priceUsage({ model: turn.model, totals: turn.totals, reportedCostUsd: turn.reportedCostUsd }, table);
  return { ...turn, totalTokens: totalTokens(turn.totals), costUsd: priced.costUsd, costSource: priced.costSource };
}

export function addTurn(aggregate: UsageAggregate, turn: PricedUsageTurn): UsageAggregate {
  const totals = addTokenTotals(aggregate.totals, turn.totals);
  return {
    turns: aggregate.turns + 1,
    totals,
    totalTokens: totalTokens(totals),
    costUsd: aggregate.costUsd + turn.costUsd,
    reportedCostUsd: aggregate.reportedCostUsd + (turn.costSource === 'reported' ? turn.costUsd : 0),
    unpricedTurns: aggregate.unpricedTurns + (turn.costSource === 'unpriced' ? 1 : 0),
  };
}

export function aggregateTurns(turns: ReadonlyArray<PricedUsageTurn>): UsageAggregate {
  return turns.reduce(addTurn, emptyUsageAggregate());
}

export interface UsageGroup extends UsageAggregate {
  key: string;
}

/** Turns summed per key, largest spend first (tokens break ties). */
export function groupTurns(turns: ReadonlyArray<PricedUsageTurn>, keyOf: (turn: PricedUsageTurn) => string): UsageGroup[] {
  const groups = new Map<string, UsageAggregate>();
  for (const turn of turns) {
    const key = keyOf(turn);
    groups.set(key, addTurn(groups.get(key) ?? emptyUsageAggregate(), turn));
  }
  return [...groups.entries()]
    .map(([key, aggregate]) => ({ key, ...aggregate }))
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens || a.key.localeCompare(b.key));
}

export interface UsageDay extends UsageAggregate {
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
}

/** The Factory's usage over a period, as the usage page reads it. */
export interface UsageSummary {
  /** First and last UTC day of the period. */
  from: string;
  to: string;
  total: UsageAggregate;
  /** Every day of the period, empty ones included. */
  byDay: UsageDay[];
  byHarness: UsageGroup[];
  byModel: UsageGroup[];
  byAccount: UsageGroup[];
  byFactory: UsageGroup[];
}

const DAY_MS = 86_400_000;

/** The UTC day of a time, `YYYY-MM-DD`. */
export function utcDay(time: Date | string | number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** Every UTC day from `from` to `to`, both included. */
export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= end; at += DAY_MS) days.push(utcDay(at));
  return days;
}

/** Group key of a turn with no value for it (no model reported, no account). */
export const UNKNOWN_USAGE_KEY = '';

export function summarizeUsage(
  turns: ReadonlyArray<UsageTurn>,
  period: { from: string; to: string },
  table: RateTable = DEFAULT_RATE_TABLE,
): UsageSummary {
  const priced = turns.map(turn => priceTurn(turn, table));
  const perDay = new Map(groupTurns(priced, turn => utcDay(turn.occurredAt)).map(group => [group.key, group]));
  return {
    from: period.from,
    to: period.to,
    total: aggregateTurns(priced),
    byDay: daysBetween(period.from, period.to).map(day => {
      const { key, ...aggregate } = perDay.get(day) ?? { key: day, ...emptyUsageAggregate() };
      void key;
      return { day, ...aggregate };
    }),
    byHarness: groupTurns(priced, turn => turn.harnessId),
    byModel: groupTurns(priced, turn => turn.model ?? UNKNOWN_USAGE_KEY),
    byAccount: groupTurns(priced, turn => turn.accountId ?? UNKNOWN_USAGE_KEY),
    byFactory: groupTurns(priced, turn => turn.factoryProjectId ?? UNKNOWN_USAGE_KEY),
  };
}

/** A session's usage: each turn, newest last, its total and how full its context is now. */
export interface SessionUsage {
  sessionId: string;
  turns: PricedUsageTurn[];
  total: UsageAggregate;
  /** The last turn's context fill, against its model's window when known. */
  context: { tokens: number; window: number | null } | null;
}

export function summarizeSessionUsage(
  sessionId: string,
  turns: ReadonlyArray<UsageTurn>,
  table: RateTable = DEFAULT_RATE_TABLE,
): SessionUsage {
  const priced = [...turns].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)).map(turn => priceTurn(turn, table));
  const last = [...priced].reverse().find(turn => turn.contextTokens !== null);
  return {
    sessionId,
    turns: priced,
    total: aggregateTurns(priced),
    context: last ? { tokens: last.contextTokens!, window: modelContextWindow(last.model, table) ?? null } : null,
  };
}

/** A card's usage: its total and each of its runs (turns of one kickoff). */
export interface WorkItemUsage {
  workItemId: string;
  total: UsageAggregate;
  runs: Array<UsageAggregate & { kickoffId: string | null; sessionId: string; harnessId: string; model: string | null; endedAt: string }>;
}

export function summarizeWorkItemUsage(
  workItemId: string,
  turns: ReadonlyArray<UsageTurn>,
  table: RateTable = DEFAULT_RATE_TABLE,
): WorkItemUsage {
  const priced = turns.map(turn => priceTurn(turn, table));
  const runs = new Map<string, { turns: PricedUsageTurn[] }>();
  for (const turn of priced) {
    // Turns outside a recorded kickoff (a person's message into the card's session) group per session.
    const key = turn.kickoffId ?? `session:${turn.sessionId}`;
    (runs.get(key) ?? runs.set(key, { turns: [] }).get(key)!).turns.push(turn);
  }
  return {
    workItemId,
    total: aggregateTurns(priced),
    runs: [...runs.values()]
      .map(({ turns: runTurns }) => {
        const last = runTurns.reduce((latest, turn) => (turn.occurredAt > latest.occurredAt ? turn : latest));
        return {
          kickoffId: last.kickoffId,
          sessionId: last.sessionId,
          harnessId: last.harnessId,
          model: last.model,
          endedAt: last.occurredAt,
          ...aggregateTurns(runTurns),
        };
      })
      .sort((a, b) => b.endedAt.localeCompare(a.endedAt)),
  };
}
