import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isServerRequest, observeFetch, ServerReachability } from './serverReachability';

function reachabilityWith(health: () => Promise<Response>) {
  const fetchImpl = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => health());
  const reachability = new ServerReachability({ fetchImpl: fetchImpl as unknown as typeof fetch });
  return { reachability, fetchImpl };
}

const up = () => Promise.resolve(new Response('{"success":true}', { status: 200 }));
const gone = () => Promise.reject(new TypeError('Failed to fetch'));

describe('ServerReachability', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stays up when a request fails but /health answers', async () => {
    const { reachability, fetchImpl } = reachabilityWith(up);
    reachability.reportFailure();
    await vi.runAllTicks();
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledWith('/health', expect.objectContaining({ cache: 'no-store' }));
    expect(reachability.state.status).toBe('up');
  });

  it('goes down when /health fails, polls with backoff, and comes back', async () => {
    let healthy = false;
    const { reachability, fetchImpl } = reachabilityWith(() => (healthy ? up() : gone()));
    const seen: string[] = [];
    reachability.subscribe(state => seen.push(state.status));

    reachability.reportFailure();
    await vi.advanceTimersByTimeAsync(0);
    expect(reachability.state.status).toBe('down');
    expect(reachability.state.nextCheckAt).toBe(Date.now() + 2_000);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(reachability.state.nextCheckAt).toBe(Date.now() + 4_000);

    healthy = true;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(reachability.state.status).toBe('back');

    await vi.advanceTimersByTimeAsync(4_000);
    expect(reachability.state.status).toBe('up');
    expect(seen).toContain('back');
  });

  it('checks at once on "Try now"', async () => {
    let healthy = false;
    const { reachability } = reachabilityWith(() => (healthy ? up() : gone()));
    reachability.reportFailure();
    await vi.advanceTimersByTimeAsync(0);
    expect(reachability.state.status).toBe('down');

    healthy = true;
    reachability.checkNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(reachability.state.status).toBe('back');
  });
});

describe('observeFetch', () => {
  const origin = 'https://factory.example';

  function target(respond: () => Promise<Response>) {
    return { fetch: vi.fn(respond), location: { origin } } as unknown as typeof globalThis;
  }

  it('reports a same-origin network failure and still rethrows it', async () => {
    const reachability = { reportFailure: vi.fn(), reportSuccess: vi.fn() } as unknown as ServerReachability;
    const page = target(gone);
    observeFetch(reachability, page);
    await expect(page.fetch('/web/status')).rejects.toThrow('Failed to fetch');
    expect(reachability.reportFailure).toHaveBeenCalledTimes(1);
  });

  it('reports a 502 from the proxy and returns the response untouched', async () => {
    const reachability = { reportFailure: vi.fn(), reportSuccess: vi.fn() } as unknown as ServerReachability;
    const page = target(() => Promise.resolve(new Response('', { status: 502 })));
    observeFetch(reachability, page);
    const response = await page.fetch('/web/status');
    expect(response.status).toBe(502);
    expect(reachability.reportFailure).toHaveBeenCalledTimes(1);
  });

  it('ignores other origins and aborted requests', async () => {
    const reachability = { reportFailure: vi.fn(), reportSuccess: vi.fn() } as unknown as ServerReachability;
    const page = target(() => Promise.reject(new DOMException('aborted', 'AbortError')));
    observeFetch(reachability, page);
    await expect(page.fetch('/web/status')).rejects.toThrow();
    await expect(page.fetch('https://other.example/x')).rejects.toThrow();
    expect(reachability.reportFailure).not.toHaveBeenCalled();
  });

  it('treats /health and other origins as not the page’s server requests', () => {
    expect(isServerRequest('/health', origin)).toBe(false);
    expect(isServerRequest('https://accounts.google.com/x', origin)).toBe(false);
    expect(isServerRequest(`${origin}/api/agents`, origin)).toBe(true);
  });
});
