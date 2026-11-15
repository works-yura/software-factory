/**
 * A turn's model on an account pool (the person's Claude or ChatGPT sign-ins, the organization's
 * OpenCode accounts): the model runs on one account, and when the provider says that account is out
 * of usage (HTTP 429) the call moves on to the next account the pool gives, the way Factory's
 * harness turns do. An account the provider names a reset time for sits out until then (the pool
 * parks it, for Factory runs too); one that said nothing is only skipped for this turn, so a short
 * rate limit never parks a person's Claude Code account for an hour.
 *
 * When no other account is left the turn fails with the provider's own words (or the pool's "every
 * account is out of usage until …"): never another model, never another provider.
 */

/** One account's model for the turn. */
export interface PooledAccountModel<Model> {
  accountId: string;
  model: Model;
}

export interface ModelAccountPool<Model> {
  /** The next account's model; throws when none is left (the pool's own error says why). */
  pick(request: { exclude: string[]; preferredAccountId?: string }): Promise<PooledAccountModel<Model>>;
  /** The provider said the account is out of usage until `resetsAt`. */
  park(accountId: string, failure: { message: string; resetsAt: Date }): Promise<void>;
}

/** What a 429 said about when usage comes back. */
export interface RateLimitFacts {
  resetsAt?: Date;
  message: string;
}

function headerOf(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  const record = headers as Record<string, unknown>;
  const key = Object.keys(record).find(candidate => candidate.toLowerCase() === name);
  const value = key ? record[key] : undefined;
  return typeof value === 'string' ? value : undefined;
}

function epochSeconds(value: unknown): Date | undefined {
  const seconds = typeof value === 'string' ? Number(value) : value;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 1e9 ? new Date(seconds * 1000) : undefined;
}

/** When the provider says usage comes back: Anthropic's unified reset, `retry-after`, Codex's `resets_at`/`resets_in_seconds`. */
function resetOf(record: Record<string, unknown>, now: Date): Date | undefined {
  const headers = record.responseHeaders ?? record.headers;
  const unified = epochSeconds(headerOf(headers, 'anthropic-ratelimit-unified-reset'));
  if (unified) return unified;
  const retryAfter = headerOf(headers, 'retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return new Date(now.getTime() + seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return new Date(date);
  }
  const body = typeof record.responseBody === 'string' ? record.responseBody : undefined;
  if (body) {
    try {
      const parsed = JSON.parse(body) as { error?: { resets_at?: unknown; resets_in_seconds?: unknown } };
      const at = epochSeconds(parsed.error?.resets_at);
      if (at) return at;
      const inSeconds = parsed.error?.resets_in_seconds;
      if (typeof inSeconds === 'number' && Number.isFinite(inSeconds) && inSeconds >= 0) return new Date(now.getTime() + inSeconds * 1000);
    } catch {
      // Not JSON: no reset time.
    }
  }
  return undefined;
}

/** The 429 in an error (or its causes), with when usage comes back; `undefined` for any other failure. */
export function rateLimitOf(error: unknown, now: Date = new Date()): RateLimitFacts | undefined {
  const seen = new Set<unknown>();
  let value: unknown = error;
  for (let depth = 0; depth < 6 && value && typeof value === 'object' && !seen.has(value); depth += 1) {
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (record.statusCode === 429 || record.status === 429) {
      const resetsAt = resetOf(record, now);
      const message = typeof record.message === 'string' && record.message ? record.message : 'The provider answered 429 (out of usage).';
      return { message, ...(resetsAt ? { resetsAt } : {}) };
    }
    value = record.cause ?? record.lastError;
  }
  return undefined;
}

type ModelCall = (...args: unknown[]) => Promise<unknown>;

/**
 * The model of the first account the pool gives, moving to the next on a 429. Everything but the
 * calls (`doGenerate`, `doStream`) reads from the account the turn is on now.
 */
export async function createPooledModel<Model extends object>(input: {
  pool: ModelAccountPool<Model>;
  now?: () => Date;
}): Promise<Model> {
  const now = input.now ?? (() => new Date());
  let current = await input.pool.pick({ exclude: [] });
  const tried: string[] = [];

  const call = async (property: 'doGenerate' | 'doStream', args: unknown[]) => {
    for (;;) {
      const target = current.model as unknown as Record<string, ModelCall>;
      try {
        return await target[property]!.apply(current.model, args);
      } catch (error) {
        const limit = rateLimitOf(error, now());
        if (!limit) throw error;
        if (!tried.includes(current.accountId)) tried.push(current.accountId);
        if (limit.resetsAt && limit.resetsAt.getTime() > now().getTime()) {
          await input.pool.park(current.accountId, { message: limit.message, resetsAt: limit.resetsAt }).catch(() => {});
        }
        let next: PooledAccountModel<Model>;
        try {
          next = await input.pool.pick({ exclude: tried, preferredAccountId: current.accountId });
        } catch (poolError) {
          // Every account parked: the pool says when the first comes back. Otherwise the provider's own 429.
          throw isRateLimitError(poolError) ? poolError : error;
        }
        if (tried.includes(next.accountId)) throw error;
        current = next;
      }
    }
  };

  return new Proxy(current.model, {
    get(_target, property) {
      if (property === 'doGenerate' || property === 'doStream') return (...args: unknown[]) => call(property, args);
      const value = Reflect.get(current.model, property, current.model) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(current.model) : value;
    },
  });
}

/** A pool's "every account is out of usage" error (it carries `statusCode: 429`). */
export function isRateLimitError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && ((error as { statusCode?: unknown }).statusCode === 429 || (error as { kind?: unknown }).kind === 'rate_limit'));
}
