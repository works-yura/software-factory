import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';

import type { AccountUsageLimits, HarnessUsageRegistry, SessionUsage, UsageSummary, UsageTurn, WorkItemUsage } from '@factory/harness/usage';
import type { HarnessUsage } from '@factory/harness/usage';
import { daysBetween, reconcileUsageWindows, summarizeSessionUsage, summarizeUsage, summarizeWorkItemUsage, utcDay } from '@factory/harness/usage';
import { Route } from '@factory/http';
import type { RouteAuth, RouteDependencies } from '@factory/http';
import { canViewSourceControlSession } from '@factory/session';
import type { SourceControlSessionLookup } from '@factory/session';
import { isSignInCredentialKind } from '@factory/store';
import type { FactoryProjectsStorage, ModelCredentialsStorage, SourceControlSession, UsageStorage, WorkItemsStorage } from '@factory/store';

/** A probe of an account's allowance is made at most this often; a view in between reads the stored one. */
export const ACCOUNT_USAGE_PROBE_INTERVAL_MS = 60_000;
/** The period a usage summary covers when the request names none. */
export const DEFAULT_USAGE_PERIOD_DAYS = 30;
/** The longest period a summary covers. */
export const MAX_USAGE_PERIOD_DAYS = 366;
/** The most cards one request asks about. */
const MAX_WORK_ITEMS = 200;
/** Probes run this many at a time. */
const PROBE_CONCURRENCY = 4;
/** Session rows read this many at a time when checking who may see a turn. */
const SESSION_LOOKUP_CONCURRENCY = 8;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** One account's allowance as the accounts section reads it. */
export interface AccountUsageView extends AccountUsageLimits {
  /** The provider was not asked this time (asked too recently, or the account is off); this is the last answer. */
  stale?: boolean;
}

export interface AccountsUsageResponse {
  accounts: Record<string, AccountUsageView>;
}

/** One sign-in's allowance beside whose it is, as the limits overview reads it. */
export interface UsageLimitsAccount {
  accountId: string;
  label: string;
  /** The harness whose sessions run on it (`claude-code`, `codex`) and its name. */
  harnessId: string;
  harnessName: string;
  /** The credential-account provider it is filed under (`anthropic`, `openai-codex`). */
  provider: string;
  disabled: boolean;
  usage: AccountUsageView;
}

/**
 * Every sign-in of every harness that reports allowances, in one list: what the status line, the
 * Analytics limits card and anything else that shows limits read, without knowing the harness.
 * Accounts with no reading yet are left out.
 */
export interface UsageLimitsResponse {
  accounts: UsageLimitsAccount[];
}

export interface UsageSummaryResponse extends UsageSummary {
  /** Names for the ids the groups carry: accounts by label, Factories by name, sessions by title. */
  labels: { accounts: Record<string, string>; factories: Record<string, string>; sessions: Record<string, string> };
}

export interface SessionUsageResponse {
  usage: SessionUsage;
}

export interface WorkItemsUsageResponse {
  workItems: Record<string, WorkItemUsage>;
}

export interface UsageRoutesDeps extends RouteDependencies {
  auth: RouteAuth;
  usage: Pick<UsageStorage, 'listTurns' | 'listSessionTurns' | 'listWorkItemTurns' | 'listAccountLimits' | 'saveAccountLimits'>;
  /** The harnesses' usage facets, which read an account's allowance from its provider. */
  harnesses: HarnessUsageRegistry;
  /** Session rows: a turn is shown only to whoever may read its session (`canViewSourceControlSession`). */
  sessions: Pick<SourceControlSessionLookup, 'getBySessionId'>;
  /** Cards: a card's usage is shown only when the caller's organization can read the card. */
  workItems: Pick<WorkItemsStorage, 'get'>;
  modelCredentials?: Pick<ModelCredentialsStorage, 'listAccounts'>;
  projects?: Pick<FactoryProjectsStorage, 'list'>;
  now?: () => Date;
}

class Refusal {
  readonly status: 400 | 401 | 403 | 404;
  readonly body: Record<string, unknown>;
  constructor(status: 400 | 401 | 403 | 404, body: Record<string, unknown>) {
    this.status = status;
    this.body = body;
  }
}

/** Resolves untrusted `from`/`to` days into a bounded period ending today at the latest. */
export function parseUsagePeriod(from: unknown, to: unknown, now: Date): { from: string; to: string } {
  const today = utcDay(now);
  const end = typeof to === 'string' && DAY_RE.test(to) && to <= today ? to : today;
  const endMs = Date.parse(`${end}T00:00:00Z`);
  const earliest = utcDay(endMs - (MAX_USAGE_PERIOD_DAYS - 1) * DAY_MS);
  const fallback = utcDay(endMs - (DEFAULT_USAGE_PERIOD_DAYS - 1) * DAY_MS);
  let start = typeof from === 'string' && DAY_RE.test(from) && !Number.isNaN(Date.parse(from)) ? from : fallback;
  if (start > end) start = end;
  if (start < earliest) start = earliest;
  return { from: start, to: end };
}

async function mapLimited<T, R>(items: ReadonlyArray<T>, limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * What the Factory's agents spent, for every harness alike (`@factory/harness/usage`):
 *
 *   - `GET /web/config/providers/:provider/accounts/usage[?refresh=1]` each account's allowance
 *     windows; `refresh` asks the provider again for accounts not asked within a minute
 *   - `GET /web/usage/limits[?refresh=1]` every harness's sign-ins with their allowance windows, in
 *     one list (the status line and the Analytics limits card); `refresh` as above
 *   - `GET /web/usage/summary?from&to&factoryProjectId&harnessId&model&accountId` tokens and
 *     estimated cost over a period, by day, harness, model, account, Factory, card-run role and
 *     the sessions that spent most
 *   - `GET /web/usage/sessions/:sessionId` a session's turns, total and context fill
 *   - `GET /web/usage/work-items?ids=a,b` each card's total and runs
 *
 * Everything is the caller's organization's, and a turn is seen only by whoever may read its
 * session, by the rule the session routes use (`canViewSourceControlSession`): a private session's
 * turns reach its owner alone (an organization admin included, as the session itself does), a
 * shared session's every member. A session's usage answers 404 where the session would; a card's
 * needs a card the organization can read; the summary sums only the turns the caller may see. A
 * turn whose session row is gone reaches only the person it was recorded for.
 */
export class UsageRoutes extends Route<UsageRoutesDeps> {
  #now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async #tenant(c: Context): Promise<{ orgId: string; userId: string }> {
    await this.deps.auth.ensureUser(c);
    const tenant = this.deps.auth.tenant(c);
    if (!tenant) throw new Refusal(401, { error: 'unauthorized' });
    if (!tenant.orgId) throw new Refusal(403, { error: 'organization_required', message: 'Usage belongs to an organization.' });
    return { orgId: tenant.orgId, userId: tenant.userId };
  }

  /** Which of `sessionIds` the viewer may read; rows that are gone come back as `null`. */
  async #sessionRows(sessionIds: ReadonlyArray<string>): Promise<Map<string, SourceControlSession | null>> {
    const unique = [...new Set(sessionIds)];
    const rows = await mapLimited(unique, SESSION_LOOKUP_CONCURRENCY, id => this.deps.sessions.getBySessionId(id));
    return new Map(unique.map((id, index) => [id, rows[index] ?? null]));
  }

  /** The turns whose session the viewer may read. Without auth there is no tenant to keep apart. */
  async #readable(turns: ReadonlyArray<UsageTurn>, viewer: { orgId: string; userId: string }): Promise<UsageTurn[]> {
    if (!this.deps.auth.enabled() || turns.length === 0) return [...turns];
    const rows = await this.#sessionRows(turns.map(turn => turn.sessionId));
    return turns.filter(turn => {
      const row = rows.get(turn.sessionId);
      return row ? canViewSourceControlSession(row, viewer) : turn.userId === viewer.userId;
    });
  }

  #handle(run: (c: Context) => Promise<Response>) {
    return async (c: Context) => {
      try {
        return await run(c);
      } catch (error) {
        if (error instanceof Refusal) return c.json(error.body, error.status);
        throw error;
      }
    };
  }

  /**
   * The facet's sign-ins and their allowances: what was stored, or with `refresh` read from the
   * provider again for accounts not asked within a minute. A reading in a unit its source does not
   * use is put right against the stored one (`reconcileUsageWindows`).
   */
  async #readAccounts(
    orgId: string,
    facet: HarnessUsage,
    refresh: boolean,
  ): Promise<Array<{ account: { id: string; label: string; disabled: boolean }; usage: AccountUsageView | undefined }>> {
    const accounts = (await this.deps.modelCredentials?.listAccounts(orgId, facet.accountProvider)) ?? [];
    const signIns = accounts.filter(account => isSignInCredentialKind(account.kind));
    const stored = await this.deps.usage.listAccountLimits(orgId, signIns.map(account => account.id));
    const now = this.#now();
    return mapLimited(signIns, PROBE_CONCURRENCY, async account => {
      const entry = { id: account.id, label: account.label, disabled: Boolean(account.disabled) };
      const known = stored.get(account.id);
      const fresh = known !== undefined && now.getTime() - Date.parse(known.checkedAt) < ACCOUNT_USAGE_PROBE_INTERVAL_MS;
      if (!refresh || fresh || account.disabled || !facet.readAccountLimits) {
        return { account: entry, usage: known ? { ...known, ...(refresh ? { stale: true } : {}) } : undefined };
      }
      const read = await facet.readAccountLimits({ orgId, accountId: account.id });
      // A failed probe keeps the windows last seen and says why they are not newer.
      if (read.unavailable && known && known.windows.length > 0) {
        return { account: entry, usage: { ...known, stale: true, unavailable: read.unavailable } };
      }
      const reconciled = reconcileUsageWindows(known?.windows ?? [], read.windows);
      if (reconciled.suspectedUnitChange.length > 0) {
        console.warn(
          `[Factory usage] ${facet.displayName} reported ${reconciled.suspectedUnitChange.join(', ')} as a fraction; read as a percentage.`,
        );
      }
      return { account: entry, usage: await this.deps.usage.saveAccountLimits(orgId, account.id, { ...read, windows: reconciled.windows }) };
    });
  }

  #refreshRequested(c: Context): boolean {
    return c.req.query('refresh') === '1' || c.req.query('refresh') === 'true';
  }

  async #accountsUsage(c: Context): Promise<Response> {
    const { orgId } = await this.#tenant(c);
    const provider = c.req.param('provider') ?? '';
    const facet = this.deps.harnesses.forProvider(provider);
    if (!facet) throw new Refusal(404, { error: 'unsupported_provider', provider });
    const read = await this.#readAccounts(orgId, facet, this.#refreshRequested(c));
    const accounts: Record<string, AccountUsageView> = {};
    for (const { account, usage } of read) if (usage) accounts[account.id] = usage;
    const body: AccountsUsageResponse = { accounts };
    return c.json(body);
  }

  async #limits(c: Context): Promise<Response> {
    const { orgId } = await this.#tenant(c);
    const refresh = this.#refreshRequested(c);
    const accounts: UsageLimitsAccount[] = [];
    for (const facet of this.deps.harnesses.all()) {
      for (const { account, usage } of await this.#readAccounts(orgId, facet, refresh)) {
        if (!usage) continue;
        accounts.push({
          accountId: account.id,
          label: account.label,
          harnessId: facet.harnessId,
          harnessName: facet.displayName,
          provider: facet.accountProvider,
          disabled: account.disabled,
          usage,
        });
      }
    }
    const body: UsageLimitsResponse = { accounts };
    return c.json(body);
  }

  async #summary(c: Context): Promise<Response> {
    const viewer = await this.#tenant(c);
    const { orgId } = viewer;
    const period = parseUsagePeriod(c.req.query('from'), c.req.query('to'), this.#now());
    const optional = (name: string) => {
      const value = c.req.query(name);
      return value ? value : undefined;
    };
    const factoryProjectId = optional('factoryProjectId');
    const harnessId = optional('harnessId');
    const model = optional('model');
    const accountId = optional('accountId');
    const listed = await this.deps.usage.listTurns({
      orgId,
      days: daysBetween(period.from, period.to),
      ...(factoryProjectId ? { factoryProjectId } : {}),
      ...(harnessId ? { harnessId } : {}),
      ...(model ? { model } : {}),
      ...(accountId ? { accountId } : {}),
    });
    const summary = summarizeUsage(await this.#readable(listed, viewer), period);
    // Names only for what the caller's turns name; a session is named by its title.
    const sessionRows = await this.#sessionRows(summary.bySession.map(group => group.key));
    const sessions: Record<string, string> = {};
    for (const [id, row] of sessionRows) if (row?.title) sessions[id] = row.title;
    const accountIds = new Set(summary.byAccount.map(group => group.key));
    const factoryIds = new Set(summary.byFactory.map(group => group.key));
    const accounts: Record<string, string> = {};
    for (const facet of this.deps.harnesses.all()) {
      for (const account of (await this.deps.modelCredentials?.listAccounts(orgId, facet.accountProvider)) ?? []) {
        if (accountIds.has(account.id)) accounts[account.id] = account.label;
      }
    }
    const factories: Record<string, string> = {};
    for (const project of (await this.deps.projects?.list({ orgId })) ?? []) {
      if (factoryIds.has(project.id)) factories[project.id] = project.name;
    }
    const body: UsageSummaryResponse = { ...summary, labels: { accounts, factories, sessions } };
    return c.json(body);
  }

  async #session(c: Context): Promise<Response> {
    const viewer = await this.#tenant(c);
    const sessionId = c.req.param('sessionId') ?? '';
    if (!sessionId) throw new Refusal(404, { error: 'not_found' });
    if (this.deps.auth.enabled()) {
      // As the session itself answers: missing to whoever may not read it.
      const row = await this.deps.sessions.getBySessionId(sessionId);
      if (row && !canViewSourceControlSession(row, viewer)) throw new Refusal(404, { error: 'not_found' });
    }
    const turns = await this.#readable(await this.deps.usage.listSessionTurns(viewer.orgId, sessionId), viewer);
    const body: SessionUsageResponse = { usage: summarizeSessionUsage(sessionId, turns) };
    return c.json(body);
  }

  async #workItems(c: Context): Promise<Response> {
    const viewer = await this.#tenant(c);
    const { orgId } = viewer;
    const requested = [...new Set((c.req.query('ids') ?? '').split(',').map(id => id.trim()).filter(Boolean))];
    if (requested.length > MAX_WORK_ITEMS) throw new Refusal(400, { error: 'too_many_work_items', max: MAX_WORK_ITEMS });
    // A card the caller's organization cannot read has no usage to show.
    const cards = await mapLimited(requested, SESSION_LOOKUP_CONCURRENCY, id => this.deps.workItems.get({ orgId, id }));
    const ids = requested.filter((_, index) => cards[index] !== null);
    const turns = ids.length > 0 ? await this.#readable(await this.deps.usage.listWorkItemTurns(orgId, ids), viewer) : [];
    const workItems: Record<string, WorkItemUsage> = {};
    for (const id of ids) {
      const own = turns.filter(turn => turn.workItemId === id);
      if (own.length > 0) workItems[id] = summarizeWorkItemUsage(id, own);
    }
    const body: WorkItemsUsageResponse = { workItems };
    return c.json(body);
  }

  routes(): ApiRoute[] {
    return [
      registerApiRoute('/web/config/providers/:provider/accounts/usage', {
        method: 'GET',
        requiresAuth: false,
        handler: this.#handle(c => this.#accountsUsage(c)),
      }),
      registerApiRoute('/web/usage/limits', { method: 'GET', requiresAuth: false, handler: this.#handle(c => this.#limits(c)) }),
      registerApiRoute('/web/usage/summary', { method: 'GET', requiresAuth: false, handler: this.#handle(c => this.#summary(c)) }),
      registerApiRoute('/web/usage/sessions/:sessionId', {
        method: 'GET',
        requiresAuth: false,
        handler: this.#handle(c => this.#session(c)),
      }),
      registerApiRoute('/web/usage/work-items', { method: 'GET', requiresAuth: false, handler: this.#handle(c => this.#workItems(c)) }),
    ];
  }
}
