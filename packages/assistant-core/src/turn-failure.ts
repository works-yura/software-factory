/**
 * Why an agent turn failed, in a shape the thread can explain (ADR-0051): which model, what kind
 * of failure, and the provider's raw words kept as detail. The thread headlines the kind with the
 * provider and model named and a fix; the raw detail stays available, collapsed.
 *
 * A failure is never retried on another model or provider: the person sees it and chooses.
 */
import { AssistantError } from './errors.ts';

export const TURN_FAILURE_KINDS = ['no_model', 'rate_limit', 'auth', 'model_not_found', 'overloaded', 'unknown'] as const;
export type TurnFailureKind = (typeof TURN_FAILURE_KINDS)[number];

export interface TurnFailure {
  kind: TurnFailureKind;
  /** The model the turn ran on (`provider/model`), when one was resolved. */
  modelId: string | null;
  /** The HTTP status the provider answered, when there was one. */
  status: number | null;
  /** The raw error text (and the provider's body, when it said more): detail, never the headline. */
  detail: string;
}

/** A turn's failure on a model the turn resolved: the brain names the model, the cause stays. */
export class AssistantTurnError extends Error {
  readonly modelId: string;
  constructor(modelId: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'AssistantTurnError';
    this.modelId = modelId;
  }
}

const MAX_DETAIL = 2000;

interface ErrorFacts {
  status: number | null;
  texts: string[];
}

/** Walks an error, its `cause`, the AI SDK's `lastError`/`errors` (retries) for statuses and texts. */
function facts(error: unknown): ErrorFacts {
  const seen = new Set<unknown>();
  const texts: string[] = [];
  let status: number | null = null;
  const visit = (value: unknown, depth: number) => {
    if (value === null || value === undefined || depth > 6 || seen.has(value)) return;
    seen.add(value);
    if (typeof value !== 'object') {
      texts.push(String(value));
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message) texts.push(record.message);
    for (const key of ['statusCode', 'status']) {
      const candidate = record[key];
      if (status === null && typeof candidate === 'number' && candidate >= 400 && candidate < 600) status = candidate;
    }
    if (typeof record.responseBody === 'string' && record.responseBody) texts.push(record.responseBody);
    if (record.data && typeof record.data === 'object') texts.push(JSON.stringify(record.data));
    visit(record.cause, depth + 1);
    visit(record.lastError, depth + 1);
    if (Array.isArray(record.errors)) for (const inner of record.errors) visit(inner, depth + 1);
  };
  visit(error, 0);
  return { status, texts };
}

const RATE_LIMIT = /resource[\s_-]*(?:has been\s+)?exhausted|rate[\s_-]?limit|too many requests|quota|insufficient[\s_-]?(?:quota|credits?|balance|funds)|\bcredits?\b|spending limit|\bbilling\b/i;
const AUTH = /unauthori[sz]ed|invalid[\s_-]?(?:api[\s_-]?)?key|incorrect api key|authentication|permission[\s_-]?denied|forbidden/i;
const MODEL_NOT_FOUND = /model[^.]{0,80}(?:not[\s_-]?found|does not exist|not available|unknown|not supported)|(?:unknown|invalid)[\s_-]?model|model_not_found/i;
const OVERLOADED = /overloaded|service unavailable|bad gateway|gateway timeout|internal server error|temporarily unavailable/i;

/** What kind of failure a turn hit: the person's fix differs for each. */
export function classifyTurnFailure(error: unknown, fallbackModelId: string | null = null): TurnFailure {
  if (error instanceof AssistantError && error.code === 'no_org_model') {
    return { kind: 'no_model', modelId: null, status: null, detail: error.message };
  }
  const modelId = error instanceof AssistantTurnError ? error.modelId : fallbackModelId;
  const { status, texts } = facts(error);
  const unique = [...new Set(texts.map(text => text.trim()).filter(Boolean))];
  const detail = unique.join('\n').slice(0, MAX_DETAIL) || 'The model failed without saying why.';
  const all = unique.join('\n');
  const kind = ((): TurnFailureKind => {
    if (status === 429 || RATE_LIMIT.test(all)) return 'rate_limit';
    if (status === 401 || status === 403 || AUTH.test(all)) return 'auth';
    if (status === 404 || MODEL_NOT_FOUND.test(all)) return 'model_not_found';
    if ((status !== null && status >= 500) || OVERLOADED.test(all)) return 'overloaded';
    return 'unknown';
  })();
  return { kind, modelId, status, detail };
}

function isKind(value: unknown): value is TurnFailureKind {
  return typeof value === 'string' && (TURN_FAILURE_KINDS as readonly string[]).includes(value);
}

/** As stored in `last_error` (text): JSON. */
export function serializeTurnFailure(failure: TurnFailure): string {
  return JSON.stringify(failure);
}

/** From `last_error`: JSON as stored now; a plain text stored before is an `unknown` failure. */
export function parseTurnFailure(stored: string | null | undefined): TurnFailure | null {
  if (!stored) return null;
  try {
    const value: unknown = JSON.parse(stored);
    if (value && typeof value === 'object' && isKind((value as { kind?: unknown }).kind)) {
      const record = value as Partial<TurnFailure>;
      return {
        kind: record.kind!,
        modelId: typeof record.modelId === 'string' ? record.modelId : null,
        status: typeof record.status === 'number' ? record.status : null,
        detail: typeof record.detail === 'string' ? record.detail : '',
      };
    }
  } catch {
    // Plain text from before failures were classified.
  }
  return { kind: 'unknown', modelId: null, status: null, detail: stored };
}
