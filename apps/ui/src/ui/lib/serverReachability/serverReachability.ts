/**
 * Whether the Factory server answers, for the banner shown while it restarts.
 *
 * The page notices the server is gone from its own requests: a same-origin fetch that fails on
 * the network or comes back 502/503/504 (the proxy's answer while nothing listens) makes it ask
 * `GET /health`. Only a failed health check marks the server down, so one dropped request does
 * not raise the banner. While down it polls `/health` with backoff; the first answer marks it
 * back, and listeners (the banner) refresh the page's data.
 */

export type ServerReachabilityStatus = 'up' | 'down' | 'back';

export interface ServerReachabilityState {
  status: ServerReachabilityStatus;
  /** While down: when the next health check runs (epoch ms), for the countdown. */
  nextCheckAt?: number;
  /** While down: whether a health check is running now. */
  checking: boolean;
}

export const HEALTH_PATH = '/health';
/** Seconds between health checks while down: quick at first, then every 15 s. */
const BACKOFF_MS = [2_000, 4_000, 8_000, 15_000];
/** How long the "back" state lasts before the banner goes away. */
const BACK_MS = 4_000;
const HEALTH_TIMEOUT_MS = 5_000;

type Listener = (state: ServerReachabilityState) => void;

export interface ServerReachabilityOptions {
  /** The fetch the health check uses: the page's own, before the observer wraps it. */
  fetchImpl: typeof fetch;
  baseUrl?: string;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export class ServerReachability {
  #state: ServerReachabilityState = { status: 'up', checking: false };
  readonly #listeners = new Set<Listener>();
  readonly #options: Required<Omit<ServerReachabilityOptions, 'baseUrl'>> & { baseUrl: string };
  #attempt = 0;
  #timer: unknown;
  #probing = false;

  constructor(options: ServerReachabilityOptions) {
    this.#options = {
      baseUrl: options.baseUrl ?? '',
      fetchImpl: options.fetchImpl,
      now: options.now ?? Date.now,
      setTimer: options.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: options.clearTimer ?? (id => clearTimeout(id as ReturnType<typeof setTimeout>)),
    };
  }

  get state(): ServerReachabilityState {
    return this.#state;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** A request failed in a way that may mean the server is gone: check before saying so. */
  reportFailure(): void {
    if (this.#state.status === 'down') return;
    void this.#probe();
  }

  /** A request got an answer from the server: it is there. */
  reportSuccess(): void {
    if (this.#state.status === 'down') void this.#probe();
  }

  /** The banner's "Try now": check at once. */
  checkNow(): void {
    if (this.#state.status !== 'down') return;
    this.#clearTimer();
    void this.#probe();
  }

  async #probe(): Promise<void> {
    if (this.#probing) return;
    this.#probing = true;
    if (this.#state.status === 'down') this.#set({ ...this.#state, checking: true });
    const ok = await this.#healthy();
    this.#probing = false;
    if (ok) {
      if (this.#state.status === 'down') this.#markBack();
      return;
    }
    this.#scheduleNext();
  }

  async #healthy(): Promise<boolean> {
    const controller = typeof AbortController === 'undefined' ? undefined : new AbortController();
    const timeout = this.#options.setTimer(() => controller?.abort(), HEALTH_TIMEOUT_MS);
    try {
      const response = await this.#options.fetchImpl(`${this.#options.baseUrl}${HEALTH_PATH}`, {
        cache: 'no-store',
        signal: controller?.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      this.#options.clearTimer(timeout);
    }
  }

  #scheduleNext(): void {
    const delay = BACKOFF_MS[Math.min(this.#attempt, BACKOFF_MS.length - 1)]!;
    this.#attempt += 1;
    this.#clearTimer();
    this.#set({ status: 'down', checking: false, nextCheckAt: this.#options.now() + delay });
    this.#timer = this.#options.setTimer(() => {
      this.#timer = undefined;
      void this.#probe();
    }, delay);
  }

  #markBack(): void {
    this.#attempt = 0;
    this.#clearTimer();
    this.#set({ status: 'back', checking: false });
    this.#timer = this.#options.setTimer(() => {
      this.#timer = undefined;
      if (this.#state.status === 'back') this.#set({ status: 'up', checking: false });
    }, BACK_MS);
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) this.#options.clearTimer(this.#timer);
    this.#timer = undefined;
  }

  #set(state: ServerReachabilityState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }
}

/** Whether a failed or answered request says anything about the Factory server's reachability. */
export function isServerRequest(input: RequestInfo | URL, origin: string): boolean {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return false;
  }
  return url.origin === origin && url.pathname !== HEALTH_PATH;
}

/** The proxy's answers while the server behind it does not listen. */
export function isGatewayFailure(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Wraps `globalThis.fetch` so every same-origin request reports to `reachability`. The wrapper
 * returns exactly what fetch returns and rethrows what it throws: it only watches.
 */
export function observeFetch(reachability: ServerReachability, target: typeof globalThis = globalThis): () => void {
  const original = target.fetch;
  const origin = target.location?.origin ?? '';
  const observed: typeof fetch = async (input, init) => {
    const watched = isServerRequest(input, origin);
    try {
      const response = await original.call(target, input, init);
      if (watched) {
        if (isGatewayFailure(response.status)) reachability.reportFailure();
        else reachability.reportSuccess();
      }
      return response;
    } catch (error) {
      if (watched && !isAbort(error)) reachability.reportFailure();
      throw error;
    }
  };
  target.fetch = observed;
  return () => {
    if (target.fetch === observed) target.fetch = original;
  };
}

let shared: ServerReachability | undefined;

/** The page's one watcher, created and attached to `fetch` on first use (`main.tsx`). */
export function serverReachability(): ServerReachability {
  if (!shared) {
    const original = globalThis.fetch.bind(globalThis);
    shared = new ServerReachability({ fetchImpl: original });
    observeFetch(shared);
    globalThis.addEventListener?.('online', () => shared?.reportFailure());
  }
  return shared;
}
