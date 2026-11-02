import { describe, expect, it } from 'vitest';

import type { ClaudeLoginOAuth } from '@factory/store';

import {
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_REFRESH_MARGIN_MS,
  CLAUDE_OAUTH_TOKEN_URL,
  claudeOAuthIsFresh,
  ClaudeSignInExpiredError,
  refreshClaudeOAuth,
} from './oauth.ts';

const NOW = 1_800_000_000_000;

const current = (overrides: Partial<ClaudeLoginOAuth> = {}): ClaudeLoginOAuth => ({
  accessToken: 'fake-access-1',
  refreshToken: 'fake-refresh-1',
  expiresAt: NOW,
  scopes: ['user:inference'],
  email: 'alice@example.com',
  ...overrides,
});

/** A token endpoint answering `respond()`; records each request it got. */
function endpoint(respond: () => Response) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { requests, fetchImpl };
}

const refresh = (respond: () => Response, oauth = current()) => {
  const token = endpoint(respond);
  return { token, result: refreshClaudeOAuth(oauth, { fetch: token.fetchImpl, now: () => NOW }) };
};

describe('claudeOAuthIsFresh', () => {
  it('refreshes a token with less than ten minutes left', () => {
    expect(CLAUDE_OAUTH_REFRESH_MARGIN_MS).toBe(600_000);
  });

  it('counts a token with exactly the margin left as fresh, and one a millisecond short as due', () => {
    expect(claudeOAuthIsFresh(current({ expiresAt: NOW + CLAUDE_OAUTH_REFRESH_MARGIN_MS }), NOW)).toBe(true);
    expect(claudeOAuthIsFresh(current({ expiresAt: NOW + CLAUDE_OAUTH_REFRESH_MARGIN_MS - 1 }), NOW)).toBe(false);
    expect(claudeOAuthIsFresh(current({ expiresAt: NOW + 5 }), NOW, 5)).toBe(true);
  });

  it('treats an expiry that is not a number as due', () => {
    expect(claudeOAuthIsFresh(current({ expiresAt: Number.NaN }), NOW)).toBe(false);
    expect(claudeOAuthIsFresh(current({ expiresAt: Number.POSITIVE_INFINITY }), NOW)).toBe(false);
  });
});

describe('refreshClaudeOAuth', () => {
  it('posts a form-encoded refresh grant for the CLI’s client to the token endpoint', async () => {
    const { token, result } = refresh(() => Response.json({ access_token: 'fake-access-2', expires_in: 60 }));
    await result;

    expect(token.requests).toHaveLength(1);
    const [{ url, init }] = token.requests as [{ url: string; init: RequestInit }];
    expect(url).toBe(CLAUDE_OAUTH_TOKEN_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' });
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'fake-refresh-1',
      client_id: CLAUDE_OAUTH_CLIENT_ID,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('keeps the rotated refresh token, the new scopes and the new lifetime', async () => {
    const { result } = refresh(() =>
      Response.json({ access_token: 'fake-access-2', refresh_token: 'fake-refresh-2', expires_in: 3600, scope: 'a b' }),
    );
    await expect(result).resolves.toEqual({
      accessToken: 'fake-access-2',
      refreshToken: 'fake-refresh-2',
      expiresAt: NOW + 3_600_000,
      scopes: ['a', 'b'],
      email: 'alice@example.com',
    });
  });

  it('keeps the old refresh token and scopes when the answer has none, and treats a missing lifetime as due now', async () => {
    const { result } = refresh(() => Response.json({ access_token: 'fake-access-2' }));
    await expect(result).resolves.toEqual({ ...current(), accessToken: 'fake-access-2', expiresAt: NOW });

    const blank = refresh(() =>
      Response.json({ access_token: 'fake-access-3', refresh_token: '  ', scope: ' ', expires_in: '3600' }),
    );
    await expect(blank.result).resolves.toEqual({ ...current(), accessToken: 'fake-access-3', expiresAt: NOW });
  });

  it('turns a refused grant into a sign-in-again error naming the reason', async () => {
    const invalid = refresh(() => Response.json({ error: 'invalid_grant' }, { status: 400 })).result;
    await expect(invalid).rejects.toBeInstanceOf(ClaudeSignInExpiredError);
    await expect(invalid).rejects.toThrow('(invalid_grant)');

    const unauthorized = refresh(() => Response.json({ error: { code: 7 } }, { status: 401 })).result;
    await expect(unauthorized).rejects.toThrow('(HTTP 401)');

    const notJson = refresh(() => new Response('nope', { status: 400 })).result;
    await expect(notJson).rejects.toThrow('(HTTP 400)');

    const nullBody = refresh(() => new Response('null', { status: 400 })).result;
    await expect(nullBody).rejects.toBeInstanceOf(ClaudeSignInExpiredError);
  });

  it('keeps the pair on any other failure: a server error, or an answer without an access token', async () => {
    const busy = refresh(() => new Response('busy', { status: 503 })).result;
    await expect(busy).rejects.toThrow('HTTP 503');
    await expect(busy).rejects.not.toBeInstanceOf(ClaudeSignInExpiredError);

    for (const body of ['{}', 'null', '{"access_token":"   "}', '{"access_token":42}']) {
      const answer = refresh(() => new Response(body, { status: 200 })).result;
      await expect(answer).rejects.toThrow('The Claude token endpoint answered without an access token.');
    }
  });
});
