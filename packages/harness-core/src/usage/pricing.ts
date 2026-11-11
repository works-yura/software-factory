// What a turn would have cost at API list prices: per-token rates for the models Claude Code and
// Codex run (input, cache reads, cache writes, output; a fast tier where one exists), how a model
// name finds its rate, and the turn's price split by category. A subscription bills none of this;
// the figure says what the same tokens cost on the API.
import type { UsageCostSource, UsageTokenTotals } from './contracts.ts';

export interface TokenRates {
  readonly inputCostPerToken: number;
  readonly outputCostPerToken: number;
  readonly cacheReadCostPerToken: number;
  readonly cacheCreationCostPerToken: number;
}

export interface ModelRate extends TokenRates {
  readonly fast: TokenRates | null;
  /** The model's context window in tokens, when known. */
  readonly contextWindow?: number;
}

export type RateTable = ReadonlyMap<string, ModelRate>;

export type UsageSpeed = 'standard' | 'fast';

const PER_MILLION = 1_000_000;

interface RateRow {
  /** $ per million tokens. */
  input: number;
  output: number;
  /** $ per million; 0.1× input when absent. */
  cacheRead?: number;
  /** $ per million for a 5-minute cache write; 1.25× input when absent. */
  cacheWrite?: number;
  /** Multiple of every rate in fast mode. */
  fast?: number;
  contextWindow?: number;
}

const M = 1_000_000;

/**
 * List prices, $ per million tokens (Anthropic's and OpenAI's first-party APIs). A model missing
 * here is unpriced: its tokens still count, its cost reads as unknown rather than as zero.
 */
const LIST_PRICES: Readonly<Record<string, RateRow>> = {
  // Anthropic: cache writes are 1.25× input (5-minute TTL), reads as the model's own rate says.
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10, fast: 2, contextWindow: M },
  'claude-mythos-5-2': { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10, fast: 2, contextWindow: M },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, contextWindow: M },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25, contextWindow: M },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, contextWindow: M },
  'claude-mythos-5': { input: 10, output: 50, cacheRead: 1, contextWindow: M },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, fast: 2, contextWindow: M },
  'claude-opus-5': { input: 5, output: 25, fast: 2, contextWindow: M },
  'claude-opus-4-8': { input: 5, output: 25, fast: 2, contextWindow: M },
  'claude-opus-4-7': { input: 5, output: 25, contextWindow: M },
  'claude-opus-4-6': { input: 5, output: 25, contextWindow: M },
  'claude-opus-4-5': { input: 5, output: 25, contextWindow: 200_000 },
  'claude-opus-4-1': { input: 15, output: 75, contextWindow: 200_000 },
  'claude-opus-4': { input: 15, output: 75, contextWindow: 200_000 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, contextWindow: M },
  'claude-sonnet-5': { input: 2, output: 10, contextWindow: M },
  'claude-sonnet-4-6': { input: 3, output: 15, contextWindow: M },
  'claude-sonnet-4-5': { input: 3, output: 15, contextWindow: 200_000 },
  'claude-sonnet-4': { input: 3, output: 15, contextWindow: 200_000 },
  'claude-3-7-sonnet': { input: 3, output: 15, contextWindow: 200_000 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, contextWindow: M },
  'claude-haiku-4-5': { input: 1, output: 5, contextWindow: 200_000 },
  'claude-3-5-haiku': { input: 0.8, output: 4, contextWindow: 200_000 },
  // OpenAI: cached input is 0.1× input; no cache-write premium.
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25, fast: 2, contextWindow: 400_000 },
  'gpt-5-codex': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25, contextWindow: 400_000 },
  'gpt-5-mini': { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25, contextWindow: 400_000 },
  'gpt-5-nano': { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0.05, contextWindow: 400_000 },
  'gpt-5.1': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25, fast: 2, contextWindow: 400_000 },
  'gpt-5.1-codex': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25, contextWindow: 400_000 },
  'gpt-5.1-codex-max': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25, contextWindow: 400_000 },
  'gpt-5.1-codex-mini': { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25, contextWindow: 400_000 },
  'gpt-5.2': { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 1.75, fast: 2, contextWindow: 400_000 },
  'gpt-5.2-codex': { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 1.75, contextWindow: 400_000 },
};

function rateOf(row: RateRow): ModelRate {
  const standard: TokenRates = {
    inputCostPerToken: row.input / PER_MILLION,
    outputCostPerToken: row.output / PER_MILLION,
    cacheReadCostPerToken: (row.cacheRead ?? row.input * 0.1) / PER_MILLION,
    cacheCreationCostPerToken: (row.cacheWrite ?? row.input * 1.25) / PER_MILLION,
  };
  return {
    ...standard,
    fast: row.fast ? scaleTokenRates(standard, row.fast) : null,
    ...(row.contextWindow ? { contextWindow: row.contextWindow } : {}),
  };
}

function scaleTokenRates(rates: TokenRates, multiple: number): TokenRates {
  return {
    inputCostPerToken: rates.inputCostPerToken * multiple,
    outputCostPerToken: rates.outputCostPerToken * multiple,
    cacheReadCostPerToken: rates.cacheReadCostPerToken * multiple,
    cacheCreationCostPerToken: rates.cacheCreationCostPerToken * multiple,
  };
}

/** The list prices as a rate table. */
export const DEFAULT_RATE_TABLE: RateTable = new Map(Object.entries(LIST_PRICES).map(([model, row]) => [model, rateOf(row)]));

/**
 * A rate table from per-million prices (a host's own, or a test's). Cache rates default as the list
 * prices' do: reads at 0.1× input, writes at 1.25×.
 */
export function createRateTable(rows: Readonly<Record<string, RateRow>>): RateTable {
  return new Map(Object.entries(rows).map(([model, row]) => [normalizeRateKey(model), rateOf(row)]));
}

function normalizeRateKey(model: string): string {
  return model.trim().toLowerCase();
}

function bareModelName(key: string): string {
  const slash = key.lastIndexOf('/');
  return slash === -1 ? key : key.slice(slash + 1);
}

/** Claude's bracketed context variants (`claude-opus-4-6[1m]`) price at the base tier. */
function stripVariantSuffix(key: string): string {
  const bracket = key.indexOf('[');
  return bracket === -1 ? key : key.slice(0, bracket);
}

/** Bedrock and Vertex ids: `anthropic.claude-…-v1:0`, `us.anthropic.…`, `claude-…@20251101`. */
function stripPlatformDecorations(key: string): string {
  return key
    .replace(/^(?:[a-z]{2}\.)?anthropic\./, '')
    .replace(/@\d{8}$/, '')
    .replace(/-v\d+(?::\d+)?$/, '');
}

/** A dated snapshot (`claude-haiku-4-5-20251001`, `gpt-5-2025-08-07`) prices as its model. */
function stripDateSuffix(key: string): string {
  return key.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

/** Synthetic messages are unbilled; bare family names could be any generation, so stay unpriced. */
const UNPRICEABLE_MODELS = new Set(['<synthetic>', 'synthetic', 'opus', 'sonnet', 'haiku', 'fable', 'default']);

const resolvedRates = new WeakMap<RateTable, Map<string, ModelRate | null>>();

/** The rate for a model name as a harness reports it (with a provider prefix, a variant or a date). */
export function lookupRate(table: RateTable, model: string): ModelRate | null {
  let resolved = resolvedRates.get(table);
  if (!resolved) {
    resolved = new Map();
    resolvedRates.set(table, resolved);
  }
  let rate = resolved.get(model);
  if (rate === undefined) {
    rate = resolveRate(table, model);
    resolved.set(model, rate);
  }
  return rate;
}

function resolveRate(table: RateTable, model: string): ModelRate | null {
  const key = stripVariantSuffix(normalizeRateKey(model));
  const bare = bareModelName(key);
  if (!bare || UNPRICEABLE_MODELS.has(bare)) return null;
  for (const candidate of [key, bare, stripPlatformDecorations(bare), stripDateSuffix(stripPlatformDecorations(bare))]) {
    const rate = table.get(candidate);
    if (rate) return rate;
  }
  return null;
}

/** The model's context window, when the table knows it; `[1m]` variants run with a million. */
export function modelContextWindow(model: string | null | undefined, table: RateTable = DEFAULT_RATE_TABLE): number | undefined {
  if (!model) return undefined;
  if (/\[1m\]/i.test(model)) return 1_000_000;
  return lookupRate(table, model)?.contextWindow;
}

export interface UsageCategoryCost {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface PricedUsage {
  costUsd: number;
  costSource: UsageCostSource;
  categoryCostUsd: UsageCategoryCost | null;
}

export interface PricedRecord {
  model: string | null;
  totals: UsageTokenTotals;
  speed?: UsageSpeed;
  /** The provider's own figure, which wins over the table's (split in the table's proportions). */
  reportedCostUsd?: number | null;
}

function costByCategory(totals: UsageTokenTotals, rates: TokenRates): UsageCategoryCost {
  return {
    input: totals.inputTokens * rates.inputCostPerToken,
    cacheRead: totals.cacheReadTokens * rates.cacheReadCostPerToken,
    cacheWrite: totals.cacheWriteTokens * rates.cacheCreationCostPerToken,
    output: totals.outputTokens * rates.outputCostPerToken,
  };
}

function sumCategories(cost: UsageCategoryCost): number {
  return cost.input + cost.cacheRead + cost.cacheWrite + cost.output;
}

/** Reasoning tokens are already in `outputTokens`; they are not charged twice. */
export function priceUsage(record: PricedRecord, table: RateTable = DEFAULT_RATE_TABLE): PricedUsage {
  const reported =
    typeof record.reportedCostUsd === 'number' && Number.isFinite(record.reportedCostUsd) && record.reportedCostUsd >= 0
      ? record.reportedCostUsd
      : null;
  const rate = record.model ? lookupRate(table, record.model) : null;
  if (!rate) {
    return reported === null
      ? { costUsd: 0, costSource: 'unpriced', categoryCostUsd: null }
      : { costUsd: reported, costSource: 'reported', categoryCostUsd: null };
  }
  const rates = record.speed === 'fast' && rate.fast ? rate.fast : rate;
  const list = costByCategory(record.totals, rates);
  const listUsd = sumCategories(list);
  if (reported === null) return { costUsd: listUsd, costSource: 'estimated', categoryCostUsd: list };
  if (listUsd <= 0) return { costUsd: reported, costSource: 'reported', categoryCostUsd: null };
  const scale = reported / listUsd;
  return {
    costUsd: reported,
    costSource: 'reported',
    categoryCostUsd: {
      input: list.input * scale,
      cacheRead: list.cacheRead * scale,
      cacheWrite: list.cacheWrite * scale,
      output: list.output * scale,
    },
  };
}

/** What the cache reads saved against paying full input price for the same tokens. */
export function cacheSavingsUsd(record: PricedRecord, table: RateTable = DEFAULT_RATE_TABLE): number {
  const rate = record.model ? lookupRate(table, record.model) : null;
  if (!rate) return 0;
  const rates = record.speed === 'fast' && rate.fast ? rate.fast : rate;
  return record.totals.cacheReadTokens * (rates.inputCostPerToken - rates.cacheReadCostPerToken);
}
