import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BACK_NOTICE_MS, HEALTH_BACKOFF_MS, isServerRequest, observeFetch, ServerReachability } from './serverReachability';

const up = () => Promise.resolve(new Response('{"success":true}', { status: 200 }));
const gone = () => Promise.reject(new TypeError('Failed to fetch'));

function reachabilityWith(health: () => Promise<Response>) {
  const fetchImpl = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => health());
  return { reachability: new ServerReachability({ fetchImpl }), fetchImpl };
}

describe('ServerReachability', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stays up when a request fails but /health answers', async () => {
    const { reachability, fetchImpl } = reachabilityWith(up);
    reachability.requestFailed();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledWith('/health', expect.objectContaining({ cache: 'no-store' }));
    expect(reachability.state.status).toBe('up');
  });

  it('shares one health check between failures that arrive together', async () => {
    const { reachability, fetchImpl } = reachabilityWith(up);
    reachability.requestFailed();
    reachability.requestFailed();
    reachability.requestFailed();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('goes down when /health fails, polls with backoff, and comes back', async () => {
    let healthy = false;
    const { reachability, fetchImpl } = reachabilityWith(() => (healthy ? up() : gone()));

    reachability.requestFailed();
    await vi.advanceTimersByTimeAsync(0);
    expect(reachability.state).toMatchObject({ status: 'down', nextCheckAt: Date.now() + HEALTH_BACKOFF_MS[0] });

    await vi.advanceTimersByTimeAsync(HEALTH_BACKOFF_MS[0]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(reachability.state.nextCheckAt).toBe(Date.now() + HEALTH_BACKOFF_MS[1]);

    healthy = true;
    await vi.advanceTimersByTimeAsync(HEALTH_BACKOFF_MS[1]);
    expect(reachability.state.status).toBe('back');

    await vi.advanceTimersByTimeAsync(BACK_NOTICE_MS);
    expect(reachability.state.status).toBe('up');
  });

  it('checks at once on "Try now" and drops the pending check', async () => {
    let healthy = false;
    const { reachability, fetchImpl } = reachabilityWith(() => (healthy ? up() : gone()));
    reachability.requestFailed();
    await vi.advanceTimersByTimeAsync(0);

    healthy = true;
    reachability.checkNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(reachability.state.status).toBe('back');

    await vi.advanceTimersByTimeAsync(HEALTH_BACKOFF_MS[0]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('notifies subscribers on every change', async () => {
    const { reachability } = reachabilityWith(gone);
    const listener = vi.fn();
    const unsubscribe = reachability.subscribe(listener);
    reachability.requestFailed();
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalled();
    expect(reachability.getSnapshot()).toBe(reachability.state);
    unsubscribe();
  });
});

describe('observeFetch', () => {
  const origin = 'https://factory.example';

  function page(respond: () => Promise<Response>) {
    return { fetch: vi.fn(respond), location: { origin } } as unknown as typeof globalThis;
  }

  function spyReachability() {
    return { requestFailed: vi.fn(), requestSucceeded: vi.fn() } as unknown as ServerReachability;
  }

  it('reports a same-origin network failure and still rethrows it', async () => {
    const reachability = spyReachability();
    const target = page(gone);
    observeFetch(reachability, target);
    await expect(target.fetch('/web/status')).rejects.toThrow('Failed to fetch');
    expect(reachability.requestFailed).toHaveBeenCalledTimes(1);
  });

  it('reports a 502 from the proxy and returns the response untouched', async () => {
    const reachability = spyReachability();
    const target = page(() => Promise.resolve(new Response('', { status: 502 })));
    observeFetch(reachability, target);
    expect((await target.fetch('/web/status')).status).toBe(502);
    expect(reachability.requestFailed).toHaveBeenCalledTimes(1);
  });

  it('reports an answered request as a success', async () => {
    const reachability = spyReachability();
    const target = page(() => Promise.resolve(new Response('', { status: 401 })));
    observeFetch(reachability, target);
    await target.fetch('/web/status');
    expect(reachability.requestSucceeded).toHaveBeenCalledTimes(1);
  });

  it('ignores aborted requests and other origins', async () => {
    const reachability = spyReachability();
    const target = page(() => Promise.reject(new DOMException('aborted', 'AbortError')));
    observeFetch(reachability, target);
    await expect(target.fetch('/web/status')).rejects.toThrow();
    await expect(target.fetch('https://other.example/x')).rejects.toThrow();
    expect(reachability.requestFailed).not.toHaveBeenCalled();
  });

  it('restores the original fetch on undo', () => {
    const target = page(up);
    const original = target.fetch;
    const undo = observeFetch(spyReachability(), target);
    expect(target.fetch).not.toBe(original);
    undo();
    expect(target.fetch).toBe(original);
  });

  it('treats /health and other origins as not the page’s server requests', () => {
    expect(isServerRequest('/health', origin)).toBe(false);
    expect(isServerRequest('https://accounts.google.com/x', origin)).toBe(false);
    expect(isServerRequest(`${origin}/api/agents`, origin)).toBe(true);
    expect(isServerRequest(new URL('/web/status', origin), origin)).toBe(true);
  });
});
