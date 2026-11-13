/**
 * Notices that the server now serves a newer build of this app than the one this page runs.
 *
 * A page left open across a deploy keeps its old JavaScript, which still calls the routes and
 * shapes it was built against; once one moves, its actions fail with errors that say nothing about
 * the cause. Vite names the entry script by its content hash (`/assets/index-<hash>.js`), so the
 * served `index.html` naming another entry means a new build is live. Asked every few minutes, when
 * the tab becomes visible again, and when the server answers after a restart (a deploy restarts
 * it); a failed or unreadable answer proves nothing and is ignored. Once stale, it stays stale until
 * the page reloads.
 */

import type { ServerReachability } from '../serverReachability/serverReachability';

const CHECK_INTERVAL_MS = 5 * 60_000;

/** The module entry script an `index.html` loads, as its `src` says (`/assets/index-<hash>.js`). */
export function entryScriptOf(html: string): string | undefined {
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    if (!/\btype=["']module["']/i.test(tag)) continue;
    const src = /\bsrc=["']([^"']+)["']/i.exec(tag)?.[1];
    if (src && /\/assets\/[^/]+\.js$/.test(src)) return src;
  }
  return undefined;
}

/** The entry script this page loaded; none in dev, where Vite serves sources instead. */
export function loadedEntryScript(doc: Document = document): string | undefined {
  return entryScriptOf(Array.from(doc.querySelectorAll('script[type="module"][src]'), script => script.outerHTML).join(''));
}

export interface BuildFreshnessOptions {
  /** The entry script this page runs. */
  loaded: string;
  /** The `index.html` the server serves now. */
  fetchIndex: () => Promise<string>;
  /** Asks again when it answers after being down. */
  reachability?: ServerReachability;
  intervalMs?: number;
  /** Where `visibilitychange` fires, and whose `visibilityState` says the tab is shown. */
  doc?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
}

export class BuildFreshness {
  #stale = false;
  #checking = false;
  readonly #listeners = new Set<() => void>();
  readonly #options: BuildFreshnessOptions;
  readonly #stop: Array<() => void> = [];

  constructor(options: BuildFreshnessOptions) {
    this.#options = options;
    const doc = options.doc ?? document;
    const onVisible = () => {
      if (doc.visibilityState === 'visible') void this.checkNow();
    };
    doc.addEventListener('visibilitychange', onVisible);
    this.#stop.push(() => doc.removeEventListener('visibilitychange', onVisible));
    const timer = setInterval(() => void this.checkNow(), options.intervalMs ?? CHECK_INTERVAL_MS);
    this.#stop.push(() => clearInterval(timer));
    const reachability = options.reachability;
    if (reachability) {
      let previous = reachability.getSnapshot().status;
      this.#stop.push(
        reachability.subscribe(() => {
          const status = reachability.getSnapshot().status;
          if (status === 'back' && previous !== 'back') void this.checkNow();
          previous = status;
        }),
      );
    }
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Whether the server serves a build other than this page's. */
  readonly getSnapshot = (): boolean => this.#stale;

  async checkNow(): Promise<void> {
    if (this.#stale || this.#checking) return;
    this.#checking = true;
    try {
      const served = entryScriptOf(await this.#options.fetchIndex());
      if (served && served !== this.#options.loaded) this.#markStale();
    } catch {
      // Unreachable or not an index page (a sign-in redirect, a proxy error): nothing learned.
    } finally {
      this.#checking = false;
    }
  }

  dispose(): void {
    for (const stop of this.#stop.splice(0)) stop();
  }

  #markStale(): void {
    this.#stale = true;
    this.dispose();
    for (const listener of this.#listeners) listener();
  }
}

let installed: BuildFreshness | undefined;

/**
 * Starts watching, once, in a production build (the page loaded a hashed entry script). The index
 * is asked fresh (`no-store`) from the origin that served this page.
 */
export function installBuildFreshness(reachability?: ServerReachability): BuildFreshness | undefined {
  if (installed) return installed;
  const loaded = loadedEntryScript();
  if (!loaded) return undefined;
  installed = new BuildFreshness({
    loaded,
    reachability,
    fetchIndex: async () => {
      const res = await fetch(new URL(import.meta.env.BASE_URL ?? '/', window.location.origin), {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'text/html' },
      });
      if (!res.ok) throw new Error(`index ${res.status}`);
      return res.text();
    },
  });
  return installed;
}

export function installedBuildFreshness(): BuildFreshness | undefined {
  return installed;
}
