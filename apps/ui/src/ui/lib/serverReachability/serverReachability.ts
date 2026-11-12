import { onlineManager } from '@tanstack/react-query';

/**
 * Whether the Factory server answers, for the banner shown while it restarts.
 *
 * Detection: the page notices the server is gone from its own requests. A same-origin request
 * that fails on the network or comes back 502/503/504 (the proxy's answer while nothing
 * listens) makes it ask `GET /health`; only a failed health check marks the server down, so one
 * dropped request raises nothing. While down it polls `/health` with backoff.
 *
 * Effect: "down" is fed into TanStack Query's `onlineManager`, the library's own switch for
 * "no network". Queries and mutations pause instead of failing and resume by themselves when
 * the server answers again, so nothing here refetches by hand.
 *
 * Requests are watched by wrapping `fetch` because about half the app's calls (auth, chat
 * streams, SSE) use `fetch` directly rather than the API client; the wrapper only observes.
 */

export type ServerReachabilityStatus = 'up' | 'down' | 'back';

export interface ServerReachabilityState {
  readonly status: ServerReachabilityStatus;
  /** While down: when the next health check runs (epoch ms), for the countdown. */
  readonly nextCheckAt?: number;
  /** While down: a health check is running now. */
  readonly checking: boolean;
}

export const HEALTH_PATH = '/health';
/** Delays between health checks while down: quick at first, then every 15 s. */
export const HEALTH_BACKOFF_MS = [2_000, 4_000, 8_000, 15_000] as const;
/** How long "back" is shown before the banner goes away. */
export const BACK_NOTICE_MS = 4_000;
const HEALTH_TIMEOUT_MS = 5_000;

const UP: ServerReachabilityState = { status: 'up', checking: false };

export class ServerReachability {
  #state: ServerReachabilityState = UP;
  readonly #listeners = new Set<() => void>();
  readonly #healthUrl: string;
  readonly #fetch: typeof fetch;
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #probe: Promise<void> | undefined;

  /** `fetchImpl` is the page's own fetch, taken before `observeFetch` wraps it. */
  constructor({ fetchImpl, baseUrl = '' }: { fetchImpl: typeof fetch; baseUrl?: string }) {
    this.#fetch = fetchImpl;
    this.#healthUrl = `${baseUrl}${HEALTH_PATH}`;
  }

  get state(): ServerReachabilityState {
    return this.#state;
  }

  /** `useSyncExternalStore`-shaped subscription. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): ServerReachabilityState => this.#state;

  /** A request failed in a way that may mean the server is gone: check before saying so. */
  requestFailed(): void {
    if (this.#state.status !== 'down') void this.#check();
  }

  /** A request got an answer while the server was marked down: confirm it is back. */
  requestSucceeded(): void {
    if (this.#state.status === 'down') void this.#check();
  }

  /** "Try now", or the browser coming back online: check at once. */
  checkNow(): void {
    void this.#check();
  }

  /** One health check at a time; concurrent callers share it. */
  #check(): Promise<void> {
    this.#probe ??= this.#runCheck().finally(() => {
      this.#probe = undefined;
    });
    return this.#probe;
  }

  async #runCheck(): Promise<void> {
    this.#clearTimer();
    if (this.#state.status === 'down') this.#set({ ...this.#state, checking: true });
    if (await this.#healthy()) {
      if (this.#state.status === 'down') this.#markBack();
    } else {
      this.#markDown();
    }
  }

  async #healthy(): Promise<boolean> {
    try {
      const response = await this.#fetch(this.#healthUrl, {
        cache: 'no-store',
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  #markDown(): void {
    const delay = HEALTH_BACKOFF_MS[Math.min(this.#attempt, HEALTH_BACKOFF_MS.length - 1)]!;
    this.#attempt += 1;
    this.#set({ status: 'down', checking: false, nextCheckAt: Date.now() + delay });
    this.#timer = setTimeout(() => void this.#check(), delay);
  }

  #markBack(): void {
    this.#attempt = 0;
    this.#set({ status: 'back', checking: false });
    this.#timer = setTimeout(() => this.#set(UP), BACK_NOTICE_MS);
  }

  #clearTimer(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #set(state: ServerReachabilityState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}

/** Whether a request is one of the page's own requests to the Factory server. */
export function isServerRequest(input: RequestInfo | URL, origin: string): boolean {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!URL.canParse(raw, origin)) return false;
  const url = new URL(raw, origin);
  return url.origin === origin && url.pathname !== HEALTH_PATH;
}

/** The proxy's answers while the server behind it does not listen. */
export function isGatewayFailure(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

/**
 * Wraps `target.fetch` so each same-origin request reports to `reachability`. The wrapper returns
 * what fetch returns and rethrows what it throws. Returns the undo.
 */
export function observeFetch(reachability: ServerReachability, target: typeof globalThis = globalThis): () => void {
  const original = target.fetch;
  const origin = target.location?.origin ?? '';
  const observed: typeof fetch = async (input, init) => {
    const watched = isServerRequest(input, origin);
    try {
      const response = await original.call(target, input, init);
      if (watched) {
        if (isGatewayFailure(response.status)) reachability.requestFailed();
        else reachability.requestSucceeded();
      }
      return response;
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      if (watched && !aborted) reachability.requestFailed();
      throw error;
    }
  };
  target.fetch = observed;
  return () => {
    if (target.fetch === observed) target.fetch = original;
  };
}

/**
 * TanStack Query is "online" while the browser is online and the server is not marked down.
 * Replaces the library's default listener (browser `online`/`offline` only), keeping its part.
 */
export function bindOnlineManager(reachability: ServerReachability): void {
  onlineManager.setEventListener(setOnline => {
    const update = () => setOnline(navigator.onLine && reachability.state.status !== 'down');
    const backOnline = () => {
      update();
      reachability.checkNow();
    };
    window.addEventListener('online', backOnline);
    window.addEventListener('offline', update);
    const unsubscribe = reachability.subscribe(update);
    return () => {
      window.removeEventListener('online', backOnline);
      window.removeEventListener('offline', update);
      unsubscribe();
    };
  });
}

let installed: ServerReachability | undefined;

/**
 * Creates the page's one watcher and attaches it to `fetch` and TanStack Query. Called once by
 * the web entry (`main.tsx`); tests and other entries that skip it get no banner and no wrapping.
 */
export function installServerReachability(): ServerReachability {
  if (!installed) {
    installed = new ServerReachability({ fetchImpl: globalThis.fetch.bind(globalThis) });
    observeFetch(installed);
    bindOnlineManager(installed);
  }
  return installed;
}

/** The watcher `installServerReachability` created, if the entry installed one. */
export function installedServerReachability(): ServerReachability | undefined {
  return installed;
}
