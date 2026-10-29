import { afterEach, describe, expect, it } from 'vitest';

import type { ClaudeCredentialFailure, ClaudeCredentialRequest, ClaudeTurnCredentials } from '../src/session.ts';
import type { MockFailure } from './mock-anthropic.ts';
import { contractSession, type ContractSession } from './setup.ts';

let open: ContractSession | undefined;
afterEach(async () => {
  await open?.dispose();
  open = undefined;
});

/** Two accounts: `a` (an API key, or a subscription's OAuth token) and `b` (an API key). */
function accounts(baseUrl: () => string, subscription: boolean) {
  const asked: ClaudeCredentialRequest[] = [];
  const failures: ClaudeCredentialFailure[] = [];
  const credentials = async (_: unknown, request: ClaudeCredentialRequest): Promise<ClaudeTurnCredentials> => {
    asked.push({ ...request, exclude: [...request.exclude] });
    if (!request.exclude.includes('a')) {
      const key: Record<string, string> = subscription ? { CLAUDE_CODE_OAUTH_TOKEN: OAUTH_A } : { ANTHROPIC_API_KEY: 'sk-ant-account-a' };
      return { accountId: 'a', env: { ...key, ANTHROPIC_BASE_URL: baseUrl() } };
    }
    if (!request.exclude.includes('b')) return { accountId: 'b', env: { ANTHROPIC_API_KEY: 'sk-ant-account-b', ANTHROPIC_BASE_URL: baseUrl() } };
    throw new Error('no account left');
  };
  return { asked, failures, credentials, onCredentialFailure: async (_: unknown, failure: ClaudeCredentialFailure) => void failures.push(failure) };
}

const OAUTH_A = 'sk-ant-oat01-account-a';
const isAccountA = (headers: Record<string, string | string[] | undefined>) =>
  headers['x-api-key'] === 'sk-ant-account-a' || headers.authorization === `Bearer ${OAUTH_A}`;

async function withAccounts(refusal: MockFailure, subscription = false) {
  let session!: ContractSession;
  const pool = accounts(() => session.mock.url, subscription);
  session = await contractSession({
    script: () => ({ text: 'ANSWERED' }),
    config: { credentials: pool.credentials, onCredentialFailure: pool.onCredentialFailure },
  });
  session.mock.refuse(headers => (isAccountA(headers) ? refusal : undefined));
  open = session;
  return { session, pool };
}

describe('moving to another account, against the real CLI', () => {
  it('stays on one API key through a rate limit when there is no pool, as the CLI retries', async () => {
    let session!: ContractSession;
    session = await contractSession({ script: () => ({ text: 'ANSWERED' }) });
    let refusals = 0;
    // Two refusals, then the limit lifts: the CLI's own retries get through.
    session.mock.refuse(() =>
      ++refusals <= 2
        ? { status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, headers: { 'retry-after': '0' } }
        : undefined,
    );
    open = session;
    expect(await session.say('Hello.')).toBe('complete');
    expect(session.lastModelText()).toBe('ANSWERED');
  });

  it('moves on when the API key is refused (401)', async () => {
    const { session, pool } = await withAccounts({
      status: 401,
      body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
    });
    const started = Date.now();
    expect(await session.say('Hello.')).toBe('complete');
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(session.lastModelText()).toBe('ANSWERED');
    expect(pool.failures.map(failure => [failure.accountId, failure.error.kind])).toEqual([['a', 'auth']]);
    expect(pool.asked.at(-1)?.exclude).toEqual(['a']);
  });

  it('moves on when the account is forbidden (403)', async () => {
    const { session, pool } = await withAccounts({
      status: 403,
      body: { type: 'error', error: { type: 'permission_error', message: 'Your organization has been disabled.' } },
    });
    expect(await session.say('Hello.')).toBe('complete');
    expect(session.lastModelText()).toBe('ANSWERED');
    expect(pool.failures.map(failure => [failure.accountId, failure.error.kind])).toEqual([['a', 'auth']]);
  });

  it('moves on when the account hit its rate limit (429)', async () => {
    const { session, pool } = await withAccounts({
      status: 429,
      body: { type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit' } },
      headers: { 'retry-after': '0' },
    });
    const started = Date.now();
    expect(await session.say('Hello.')).toBe('complete');
    // Not the CLI's ten retries over minutes.
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(session.lastModelText()).toBe('ANSWERED');
    expect(pool.failures.map(failure => [failure.accountId, failure.error.kind])).toEqual([['a', 'rate_limit']]);
  });

  it('moves on when a subscription is out of usage, and knows when it resets', async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3 * 3600;
    const { session, pool } = await withAccounts({
      status: 429,
      body: { type: 'error', error: { type: 'rate_limit_error', message: 'This request would exceed your account’s rate limit.' } },
      headers: {
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-reset': String(resetsAt),
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      },
    }, true);
    expect(await session.say('Hello.')).toBe('complete');
    expect(session.lastModelText()).toBe('ANSWERED');
    expect(pool.failures.map(failure => [failure.accountId, failure.error.kind])).toEqual([['a', 'rate_limit']]);
    expect(pool.failures[0]?.error.resetsAt?.getTime()).toBe(resetsAt * 1000);
  });
});
