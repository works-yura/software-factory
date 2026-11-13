import { afterEach, describe, expect, it, vi } from 'vitest';

import { ServerReachability } from '../serverReachability/serverReachability';
import { BuildFreshness, entryScriptOf } from './buildFreshness';

const index = (entry: string) => `<!doctype html><html><head>
  <script>window.__MASTRACODE_CONFIG__ = {}</script>
  <script type="module" crossorigin src="${entry}"></script>
  <link rel="modulepreload" crossorigin href="/assets/vendor-abc.js">
</head><body><div id="root"></div></body></html>`;

/** A document stand-in whose visibility the test flips. */
function fakeDoc() {
  const target = new EventTarget();
  const doc = {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    show() {
      doc.visibilityState = 'visible';
      target.dispatchEvent(new Event('visibilitychange'));
    },
  };
  return doc;
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
let freshness: BuildFreshness | undefined;
afterEach(() => {
  freshness?.dispose();
  vi.useRealTimers();
});

describe('entryScriptOf', () => {
  it("reads the built page's hashed module entry, not inline scripts or preloads", () => {
    expect(entryScriptOf(index('/assets/index-DnhKAiM1.js'))).toBe('/assets/index-DnhKAiM1.js');
  });

  it('finds none in a dev page (sources) or a page that is not the app', () => {
    expect(entryScriptOf('<script type="module" src="/src/ui/main.tsx"></script>')).toBeUndefined();
    expect(entryScriptOf('<!doctype html><title>Mastra Server</title>')).toBeUndefined();
  });
});

describe('BuildFreshness', () => {
  it('turns stale when the served index names another entry after a deploy, and tells listeners once', async () => {
    let served = index('/assets/index-old.js');
    const doc = fakeDoc();
    freshness = new BuildFreshness({ loaded: '/assets/index-old.js', fetchIndex: async () => served, doc });
    const listener = vi.fn();
    freshness.subscribe(listener);

    doc.show();
    await flush();
    expect(freshness.getSnapshot()).toBe(false);

    served = index('/assets/index-new.js');
    doc.show();
    await flush();
    expect(freshness.getSnapshot()).toBe(true);
    doc.show();
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('learns nothing from a failed request or a page that is not the app', async () => {
    const answers: Array<() => Promise<string>> = [
      () => Promise.reject(new TypeError('Failed to fetch')),
      async () => '<!doctype html><title>Mastra Server</title>',
    ];
    freshness = new BuildFreshness({ loaded: '/assets/index-old.js', fetchIndex: () => answers.shift()!(), doc: fakeDoc() });
    await freshness.checkNow();
    await freshness.checkNow();
    expect(freshness.getSnapshot()).toBe(false);
  });

  it('asks on its interval', async () => {
    vi.useFakeTimers();
    const fetchIndex = vi.fn(async () => index('/assets/index-new.js'));
    freshness = new BuildFreshness({ loaded: '/assets/index-old.js', fetchIndex, doc: fakeDoc(), intervalMs: 1_000 });
    expect(fetchIndex).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(freshness.getSnapshot()).toBe(true);
  });

  it('asks as soon as the server answers again after a restart (a deploy restarts it)', async () => {
    let healthy = false;
    const reachability = new ServerReachability({
      fetchImpl: async () => (healthy ? new Response('ok') : Promise.reject(new TypeError('Failed to fetch'))),
    });
    const fetchIndex = vi.fn(async () => index('/assets/index-new.js'));
    freshness = new BuildFreshness({ loaded: '/assets/index-old.js', fetchIndex, reachability, doc: fakeDoc(), intervalMs: 3_600_000 });

    reachability.requestFailed();
    await vi.waitFor(() => expect(reachability.getSnapshot().status).toBe('down'));
    expect(fetchIndex).not.toHaveBeenCalled();
    healthy = true;
    reachability.checkNow();
    await vi.waitFor(() => expect(freshness!.getSnapshot()).toBe(true));
  });
});
