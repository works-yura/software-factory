import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { timeout } from 'hono/timeout';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { handleServerError } from './server-error.ts';

function buildApp() {
  const app = new Hono();
  app.onError(handleServerError);
  app.get('/boom', () => {
    throw new Error('db connection refused');
  });
  app.get('/teapot', () => {
    throw new HTTPException(418, { message: 'short and stout' });
  });
  return app;
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('handleServerError', () => {
  it('returns structured JSON with the error message instead of an opaque 500', async () => {
    const res = await buildApp().request('/boom');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error', message: 'db connection refused' });
  });

  it('logs method, path, and stack server-side', async () => {
    await buildApp().request('/boom');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = String(errorSpy.mock.calls[0]![0]);
    expect(logged).toContain('GET /boom failed');
    expect(logged).toContain('db connection refused');
    // Stack trace, not just the message.
    expect(logged).toContain('at ');
  });

  it("answers another hono copy's HTTPException by its status, as the deployer's bundled hono throws", async () => {
    // Shaped like hono's class, but not ours: `instanceof` cannot recognize it.
    class ForeignHttpException extends Error {
      readonly status: number;
      constructor(status: number, message: string) {
        super(message);
        this.status = status;
      }
      getResponse() {
        return new Response(this.message, { status: this.status });
      }
    }
    const app = new Hono();
    app.onError(handleServerError);
    app.get('/limit', () => {
      throw new ForeignHttpException(413, 'Request body too large');
    });

    const res = await app.request('/limit');

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'Request body too large' });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('answers a request timeout with a 504, and keeps quiet when its handler ends afterwards', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    let ended!: () => void;
    const handlerEnded = new Promise<void>(resolve => (ended = resolve));
    // The deployer's order: the timeout wraps CORS, which sets headers after the handler answers.
    const app = new Hono();
    app.onError(handleServerError);
    app.use('*', timeout(20), cors({ origin: ['http://localhost:5173'], credentials: true }));
    app.post('/slow', async c => {
      await new Promise(resolve => setTimeout(resolve, 60));
      setTimeout(ended, 0);
      return c.json({ started: true });
    });

    const res = await app.request('/slow', { method: 'POST', headers: { origin: 'http://localhost:5173' } });

    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({
      error: 'gateway_timeout',
      message: 'The server stopped waiting for this request after its time limit; what it started may still finish.',
    });
    await handlerEnded;
    // CORS then writes onto the response already read, which throws; that is no server fault.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('POST /slow ended after its timeout answered'));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('passes HTTPException status + message through without logging', async () => {
    const res = await buildApp().request('/teapot');
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ error: 'short and stout' });
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
