/**
 * Signing in to Claude for the Factory: `claude auth login --claudeai` run by
 * the server in a throwaway config dir, its OAuth pair captured and kept as a
 * `claude_login` account (see `ModelCredentialsStorage`), and the throwaway
 * dir and Keychain item removed again. The pair is the server's from then on:
 * it refreshes it (`oauth.ts`) and hands a run the access token alone.
 *
 * The CLI opens the sign-in page in a browser on the machine it runs on, so
 * this is offered only where that machine is the person's own (local
 * development).
 *
 * Where the CLI files the pair:
 * - macOS: the Keychain item `Claude Code-credentials-<8 hex of sha256(dir)>`
 *   for the config dir given as `CLAUDE_SECURESTORAGE_CONFIG_DIR`, account
 *   `$USER`. `claude auth login` may also overwrite the default item
 *   (`Claude Code-credentials`, the person's own `claude` login), so that item
 *   is read before and put back after.
 * - elsewhere: `<dir>/.credentials.json`.
 * Both hold `{ claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes,
 * subscriptionType } }`. Who signed in is the `oauthAccount` the CLI writes to
 * `<dir>/.claude.json`.
 *
 * No secret is ever logged; a Keychain secret travels on the `security`
 * command line only while the default item is put back.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import { buildClaudeEnv } from '@factory/harness-claude-code';
import { harnessCommandPath, isHarnessExecutableUnavailable, type HarnessCommand } from '@factory/harness/executable';
import type { ClaudeLoginOAuth, ModelCredentialsStorage } from '@factory/store';

import { createSignInCommandRunner } from '../accounts/sign-in-command.ts';
import type { SignInCommandResult, SignInCommandRunner } from '../accounts/sign-in-command.ts';
import { createAccountSignInService } from '../accounts/sign-in.ts';
import type { AccountSignInFlow, AccountSignInService, AccountSignInStatus } from '../accounts/sign-in.ts';

import { CLAUDE_CODE_ACCOUNT_PROVIDER } from './credentials.ts';

/** The CLI's Keychain service for its default config dir; a custom dir appends `-<hash>`. */
export const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** How long a person gets to finish signing in in the browser. */
export const CLAUDE_SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const KEYCHAIN_TIMEOUT_MS = 10_000;

/** `security` exits with this when the item does not exist. */
const KEYCHAIN_NOT_FOUND_EXIT = 44;

export type ClaudeSignInCommandResult = SignInCommandResult;

/** Runs one command to its end. Rejects only when it cannot start or runs past its timeout. */
export type ClaudeSignInRunner = SignInCommandRunner;

export class ClaudeSignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeSignInError';
  }
}

/** The Keychain service the CLI uses for a config dir (`CLAUDE_SECURESTORAGE_CONFIG_DIR`). */
export function claudeKeychainService(configDir: string): string {
  return `${CLAUDE_KEYCHAIN_SERVICE}-${createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8)}`;
}

/** The OAuth pair in what the CLI stores, or `undefined` when it holds none. */
export function parseClaudeStoredCredentials(raw: string): Omit<ClaudeLoginOAuth, 'email' | 'accountUuid' | 'organizationUuid'> | undefined {
  let oauth: Record<string, unknown> | undefined;
  try {
    oauth = (JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> } | null)?.claudeAiOauth;
  } catch {
    return undefined;
  }
  if (!oauth || typeof oauth !== 'object') return undefined;
  const { accessToken, refreshToken, expiresAt, scopes, subscriptionType } = oauth;
  if (typeof accessToken !== 'string' || !accessToken || typeof refreshToken !== 'string' || !refreshToken) return undefined;
  return {
    accessToken,
    refreshToken,
    // No expiry recorded: due now, so the first turn refreshes it.
    expiresAt: typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? expiresAt : 0,
    scopes: Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === 'string') : [],
    ...(typeof subscriptionType === 'string' && subscriptionType ? { subscriptionType } : {}),
  };
}

export interface CaptureClaudeSignInOptions {
  run?: ClaudeSignInRunner;
  /** The `claude` executable, or the server's resolver (`harnessExecutableFor`); `claude` on the PATH by default. */
  command?: HarnessCommand;
  platform?: NodeJS.Platform;
  /** Where the throwaway config dir is made; the OS temp dir by default. */
  tempRoot?: string;
  /** The Keychain account the CLI files items under. */
  user?: string;
  /** The server's env, which the CLI inherits only the allowed part of. */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function keychainUser(): string {
  try {
    const name = process.env.USER || process.env.USERNAME || userInfo().username;
    return /^[a-zA-Z0-9._-]+$/.test(name) ? name : 'claude-code-user';
  } catch {
    return 'claude-code-user';
  }
}

/** Sign in once with the CLI in a throwaway config dir and return the pair it stored, with who signed in. */
export async function captureClaudeSignIn(options: CaptureClaudeSignInOptions = {}): Promise<ClaudeLoginOAuth> {
  const run = options.run ?? runClaudeSignInCommand;
  const command = signInCommand(options.command);
  const darwin = (options.platform ?? process.platform) === 'darwin';
  const user = options.user ?? keychainUser();
  // The resolved path: the CLI hashes the dir it is given, and macOS temp dirs sit behind a symlink.
  const dir = await realpath(await mkdtemp(join(options.tempRoot ?? tmpdir(), 'factory-claude-sign-in-')));
  const env = buildClaudeEnv(options.env ?? process.env, { CLAUDE_CONFIG_DIR: dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: dir });
  const keychain = (args: string[]) => run('security', args, { env, timeoutMs: KEYCHAIN_TIMEOUT_MS });
  const readItem = async (service: string) => {
    const result = await keychain(['find-generic-password', '-s', service, '-a', user, '-w']);
    if (result.code === 0 && result.stdout.trim()) return result.stdout.trim();
    if (result.code === KEYCHAIN_NOT_FOUND_EXIT || result.code === 0) return undefined;
    throw new ClaudeSignInError('The macOS Keychain could not be read.');
  };

  // The person's own login, to put back if the sign-in overwrites it.
  const ownLogin = darwin ? await readItem(CLAUDE_KEYCHAIN_SERVICE).catch(() => null) : undefined;
  try {
    const login = await run(command, ['auth', 'login', '--claudeai'], {
      env,
      timeoutMs: options.timeoutMs ?? CLAUDE_SIGN_IN_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (login.code !== 0) throw new ClaudeSignInError(`Claude sign-in did not finish (claude exited with ${login.code}).`);
    const stored = darwin
      ? await readItem(claudeKeychainService(dir))
      : await readFile(join(dir, '.credentials.json'), 'utf8').catch(() => undefined);
    const pair = stored ? parseClaudeStoredCredentials(stored) : undefined;
    if (!pair) throw new ClaudeSignInError('Claude sign-in finished without a stored Claude login.');
    return { ...pair, ...(await signedInAccount(dir)) };
  } finally {
    if (darwin) {
      await keychain(['delete-generic-password', '-s', claudeKeychainService(dir), '-a', user]).catch(() => undefined);
      // `null`: the own login could not be read, so it is left exactly as it is.
      if (ownLogin !== null) {
        const now = await readItem(CLAUDE_KEYCHAIN_SERVICE).catch(() => null);
        if (now !== null && now !== ownLogin) {
          await (ownLogin === undefined
            ? keychain(['delete-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE, '-a', user])
            : keychain(['add-generic-password', '-U', '-s', CLAUDE_KEYCHAIN_SERVICE, '-a', user, '-w', ownLogin])
          ).catch(() => undefined);
        }
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
}

/** The path to run; a CLI the server cannot find is the person's to read, not a generic failure. */
function signInCommand(command: HarnessCommand | undefined): string {
  try {
    return harnessCommandPath(command, 'claude');
  } catch (error) {
    if (isHarnessExecutableUnavailable(error)) throw new ClaudeSignInError((error as Error).message);
    throw error;
  }
}

/** Who signed in, from the `oauthAccount` the CLI wrote; nothing when it wrote none. */
async function signedInAccount(dir: string): Promise<Pick<ClaudeLoginOAuth, 'email' | 'accountUuid' | 'organizationUuid'>> {
  try {
    const config = JSON.parse(await readFile(join(dir, '.claude.json'), 'utf8')) as {
      oauthAccount?: { emailAddress?: unknown; accountUuid?: unknown; organizationUuid?: unknown };
    };
    const account = config.oauthAccount ?? {};
    return {
      ...(typeof account.emailAddress === 'string' && account.emailAddress ? { email: account.emailAddress } : {}),
      ...(typeof account.accountUuid === 'string' && account.accountUuid ? { accountUuid: account.accountUuid } : {}),
      ...(typeof account.organizationUuid === 'string' && account.organizationUuid
        ? { organizationUuid: account.organizationUuid }
        : {}),
    };
  } catch {
    return {};
  }
}

/** The default {@link ClaudeSignInRunner}: spawns the command with stdio piped. */
export const runClaudeSignInCommand: ClaudeSignInRunner = createSignInCommandRunner({
  name: 'Claude',
  error: message => new ClaudeSignInError(message),
});

export type ClaudeSignInStatus = AccountSignInStatus;
export type ClaudeSignInFlow = AccountSignInFlow;
/** Sign-ins people started, by id; each runs one `claude auth login` and keeps its outcome for a while. */
export type ClaudeSignInService = AccountSignInService;

/**
 * Runs sign-ins and files each as the person's `claude_login` account (see
 * `createAccountSignInService`): a new sign-in to a Claude account they
 * already added replaces its pair (and turns it back on) instead of adding a
 * second one.
 */
export function createClaudeSignInService({
  credentials,
  command,
  capture = options => captureClaudeSignIn({ ...options, ...(command ? { command } : {}) }),
  now,
}: {
  credentials: ModelCredentialsStorage;
  /** The `claude` the sign-in runs: the harness's own (`harnessExecutableFor`); `claude` on the PATH by default. */
  command?: HarnessCommand;
  capture?: (options: { signal: AbortSignal }) => Promise<ClaudeLoginOAuth>;
  now?: () => number;
}): ClaudeSignInService {
  return createAccountSignInService({
    credentials,
    provider: CLAUDE_CODE_ACCOUNT_PROVIDER,
    kind: 'claude_login',
    name: 'Claude',
    capture: ({ signal }) => capture({ signal }),
    isUserFacing: (error): error is Error => error instanceof ClaudeSignInError,
    ...(now ? { now } : {}),
  });
}
