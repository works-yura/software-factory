// Resumes chat sessions (personal, side sessions, the Factory chat) that parked because every account
// they may use ran out of usage (`@factory/harness/usage-limit-park`). One timer per parked session,
// set from the session's `usage_limit_parked` event and, on startup, from a scan of the harnesses'
// stores (the park is kept with the session, so it survives a restart). At the park's time, plus a
// little jitter so sessions parked on the same reset don't all start at once, the session is resumed;
// one still limited parks anew and its new event sets the next timer. A session bound to a card's run
// is left to the dispatcher, which resumes card runs itself.
import type { UsageLimitPark, UsageLimitResumeResult } from '@factory/harness/usage-limit-park';

/** A turn-based session that may park on a usage limit (Claude Code's, Codex's). */
export interface ParkableSession {
  readonly id: string;
  readonly usageLimitPark: UsageLimitPark | undefined;
  readonly run: { isRunning(): boolean };
  resumeFromUsageLimit(): Promise<UsageLimitResumeResult>;
  subscribe(listener: (event: { type: string }) => void): () => void;
}

/** One harness's parked sessions: what its store holds, and the live session behind an id. */
export interface ParkedSessionSource {
  /** Every session parked in the store, read once on startup. */
  parked(): Promise<Array<{ sessionId: string; until: string }>>;
  /** The session (loaded, and so observed, if this process had not yet); `undefined` when this harness has none. */
  get(sessionId: string): Promise<ParkableSession | undefined>;
}

export interface UsageLimitResumerOptions {
  sources: ParkedSessionSource[];
  /** A session someone else resumes (bound to a card's run: the dispatcher); never resumed here. */
  handledElsewhere?: (sessionId: string) => Promise<boolean>;
  now?: () => number;
  /** The most a resume waits past the park's time; 30 seconds by default. */
  maxJitterMs?: number;
  /** How long to wait before trying again when a resume failed outright; 5 minutes by default. */
  retryMs?: number;
  random?: () => number;
  setTimer?: (fire: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export interface UsageLimitResumer {
  /** Follows a session's park events (call for every session object a harness builds). */
  observe(session: ParkableSession): void;
  /** Schedules every session the stores hold parked; resolves once the scan is done. */
  start(): Promise<void>;
  /** When each scheduled session is due (tests, diagnostics). */
  scheduled(): Map<string, number>;
  stop(): void;
}

/** setTimeout's longest delay; a later park wakes once on the way and waits again. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export function createUsageLimitResumer(options: UsageLimitResumerOptions): UsageLimitResumer {
  const now = options.now ?? (() => Date.now());
  const maxJitterMs = options.maxJitterMs ?? 30_000;
  const retryMs = options.retryMs ?? 5 * 60_000;
  const random = options.random ?? Math.random;
  const setTimer =
    options.setTimer ??
    ((fire: () => void, ms: number) => {
      const timer = setTimeout(fire, ms);
      timer.unref?.();
      return timer;
    });
  const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as NodeJS.Timeout));
  const timers = new Map<string, { timer: unknown; due: number; session?: ParkableSession }>();
  const observed = new WeakSet<ParkableSession>();
  let stopped = false;

  const cancel = (sessionId: string) => {
    const entry = timers.get(sessionId);
    if (!entry) return;
    clearTimer(entry.timer);
    timers.delete(sessionId);
  };

  const schedule = (sessionId: string, until: string, session?: ParkableSession, jitter = true) => {
    if (stopped) return;
    const at = Date.parse(until);
    if (Number.isNaN(at)) return;
    const due = at + (jitter ? Math.floor(random() * maxJitterMs) : 0);
    const known = timers.get(sessionId);
    cancel(sessionId);
    const delay = Math.min(Math.max(0, due - now()), MAX_TIMER_MS);
    const timer = setTimer(() => void fire(sessionId), delay);
    timers.set(sessionId, { timer, due, ...((session ?? known?.session) ? { session: session ?? known?.session } : {}) });
  };

  const sessionFor = async (sessionId: string): Promise<ParkableSession | undefined> => {
    const known = timers.get(sessionId)?.session;
    if (known) return known;
    for (const source of options.sources) {
      const session = await source.get(sessionId);
      if (session) return session;
    }
    return undefined;
  };

  const fire = async (sessionId: string) => {
    const entry = timers.get(sessionId);
    timers.delete(sessionId);
    if (stopped) return;
    try {
      const session = entry?.session ?? (await sessionFor(sessionId));
      if (!session) return;
      if (await options.handledElsewhere?.(sessionId)) return;
      // A run in flight took the park up (a person wrote meanwhile); its end parks it anew if need be.
      if (session.run.isRunning()) return;
      const park = session.usageLimitPark;
      if (!park) return;
      // A timer capped at setTimeout's limit, or a park moved later meanwhile: wait on.
      if (Date.parse(park.until) > now()) {
        schedule(sessionId, park.until, session, false);
        return;
      }
      const result = await session.resumeFromUsageLimit();
      // Still limited: the session parked anew (its event set the timer too; this is the same time).
      if (result.action === 'parked') schedule(sessionId, result.park.until, session);
    } catch (error) {
      console.warn('[factory] Could not resume a session parked on a usage limit; trying again later', { sessionId, error });
      if (!stopped) {
        const timer = setTimer(() => void fire(sessionId), retryMs);
        timers.set(sessionId, { timer, due: now() + retryMs, ...(entry?.session ? { session: entry.session } : {}) });
      }
    }
  };

  return {
    observe(session) {
      if (observed.has(session)) return;
      observed.add(session);
      session.subscribe(event => {
        if (event.type === 'usage_limit_parked') {
          const { park } = event as unknown as { park: UsageLimitPark };
          schedule(session.id, park.until, session);
        } else if (event.type === 'usage_limit_cleared') {
          cancel(session.id);
        }
      });
      // A session loaded parked (after a restart) that the scan has not reached yet.
      const park = session.usageLimitPark;
      if (park && !timers.has(session.id)) schedule(session.id, park.until, session);
      else if (timers.has(session.id)) timers.get(session.id)!.session = session;
    },
    async start() {
      for (const source of options.sources) {
        let parked: Array<{ sessionId: string; until: string }>;
        try {
          parked = await source.parked();
        } catch (error) {
          console.warn('[factory] Could not read the sessions parked on a usage limit', error);
          continue;
        }
        for (const { sessionId, until } of parked) {
          if (timers.has(sessionId)) continue;
          try {
            if (await options.handledElsewhere?.(sessionId)) continue;
          } catch (error) {
            console.warn('[factory] Could not tell whether a parked session is a card run', { sessionId, error });
            continue;
          }
          schedule(sessionId, until);
        }
      }
    },
    scheduled() {
      return new Map([...timers].map(([sessionId, entry]) => [sessionId, entry.due]));
    },
    stop() {
      stopped = true;
      for (const sessionId of [...timers.keys()]) cancel(sessionId);
    },
  };
}

/**
 * The parked sessions of a turn-based harness's store (Claude Code's, Codex's): each record's
 * current thread's park.
 */
export function storeParkedSessions(store: {
  list(): Promise<Array<{ sessionId: string; threadId: string; threads: Record<string, { usageLimitPark?: UsageLimitPark }> }>>;
}): ParkedSessionSource['parked'] {
  return async () =>
    (await store.list()).flatMap(record => {
      const park = record.threads[record.threadId]?.usageLimitPark;
      return park ? [{ sessionId: record.sessionId, until: park.until }] : [];
    });
}

/**
 * Whether a session is bound to a card's run (an active run binding): the dispatcher resumes such a
 * run when the limit resets, so the session must neither park nor be resumed here. A session with
 * no Factory row (the Factory chat) or no binding is a chat session.
 */
export function createCardRunCheck(deps: {
  sessions: { getBySessionId(sessionId: string): Promise<{ orgId: string; factoryProjectId?: string | null } | null | undefined> };
  /** Absent while the work-items domain is not ready: no session is a card run then. */
  workItems?: {
    findActiveRunBindingForSession(input: { orgId: string; factoryProjectId: string; sessionId: string }): Promise<unknown>;
  };
}): (sessionId: string) => Promise<boolean> {
  return async sessionId => {
    if (!deps.workItems) return false;
    const row = await deps.sessions.getBySessionId(sessionId);
    if (!row?.factoryProjectId) return false;
    const binding = await deps.workItems.findActiveRunBindingForSession({ orgId: row.orgId, factoryProjectId: row.factoryProjectId, sessionId });
    return binding !== null && binding !== undefined;
  };
}
