/**
 * Signing in with ChatGPT for Codex, as for Claude (`../claude/sign-in.ts`): `codex login` run by
 * the server in a throwaway `CODEX_HOME`, the pair it filed in that home's `auth.json` captured with
 * who signed in (the id token's claims), kept as the person's `codex_login` account (see
 * `createAccountSignInService`), and the throwaway home removed. The pair is the server's from then
 * on: it refreshes it (`oauth.ts`) and hands a run the access token alone.
 *
 * The CLI opens the sign-in page in a browser on the machine it runs on and waits for it on its own
 * localhost callback, so this is offered only where that machine is the person's own (local
 * development).
 *
 * The throwaway home is created 0700 and the sign-in is filed as a file (`cli_auth_credentials_store
 * = "file"`, both on the command line and in the home's `config.toml`), never the OS keyring, and
 * never the person's own `~/.codex`. No secret is logged.
 */

import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildCodexEnv } from '@factory/harness-codex';
import { CODEX_FILE_CREDENTIALS_ARGS } from '@factory/harness-codex/launchArgs';
import type { ModelCredentialsStorage, SignInOAuth } from '@factory/store';

import { createSignInCommandRunner } from '../accounts/sign-in-command.ts';
import type { SignInCommandResult, SignInCommandRunner } from '../accounts/sign-in-command.ts';
import { createAccountSignInService } from '../accounts/sign-in.ts';
import type { AccountSignInService } from '../accounts/sign-in.ts';
import { CODEX_ACCOUNT_PROVIDER } from './credentials.ts';
import { parseCodexAuthJson } from './oauth.ts';

/** How long a person gets to finish signing in in the browser. */
export const CODEX_SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/** The sign-in kept as a file in the throwaway home, whatever the CLI would default to. */
const CODEX_FILE_CREDENTIALS_CONFIG = 'cli_auth_credentials_store = "file"\n';

export type CodexSignInCommandResult = SignInCommandResult;

/** Runs one command to its end. Rejects only when it cannot start, runs past its timeout, or is cancelled. */
export type CodexSignInRunner = SignInCommandRunner;

export class CodexSignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexSignInError';
  }
}

/** The default {@link CodexSignInRunner}: spawns the command with stdio piped. */
export const runCodexSignInCommand: CodexSignInRunner = createSignInCommandRunner({
  name: 'ChatGPT',
  error: message => new CodexSignInError(message),
});

/** The `codex login` arguments: the browser sign-in, filed as a file in `CODEX_HOME`. */
export function codexSignInArgs(): string[] {
  return ['login', ...CODEX_FILE_CREDENTIALS_ARGS];
}

export interface CaptureCodexSignInOptions {
  run?: CodexSignInRunner;
  /** The `codex` executable; `codex` on the PATH by default. */
  command?: string;
  /** Where the throwaway home is made; the OS temp dir by default. */
  tempRoot?: string;
  /** The server's env, which the CLI inherits only the allowed part of. */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Sign in once with the CLI in a throwaway home and return the pair it filed, with who signed in. */
export async function captureCodexSignIn(options: CaptureCodexSignInOptions = {}): Promise<SignInOAuth> {
  if (options.signal?.aborted) throw new CodexSignInError('ChatGPT sign-in was cancelled.');
  const run = options.run ?? runCodexSignInCommand;
  // `mkdtemp` makes the home 0700.
  const home = await realpath(await mkdtemp(join(options.tempRoot ?? tmpdir(), 'factory-codex-sign-in-')));
  try {
    await writeFile(join(home, 'config.toml'), CODEX_FILE_CREDENTIALS_CONFIG, { mode: 0o600 });
    const login = await run(options.command ?? 'codex', codexSignInArgs(), {
      env: buildCodexEnv(options.env ?? process.env, { CODEX_HOME: home }),
      timeoutMs: options.timeoutMs ?? CODEX_SIGN_IN_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (login.code !== 0) throw new CodexSignInError(`ChatGPT sign-in did not finish (codex exited with ${login.code}).`);
    const stored = await readFile(join(home, 'auth.json'), 'utf8').catch(() => undefined);
    const oauth = stored ? parseCodexAuthJson(stored) : undefined;
    if (!oauth) throw new CodexSignInError('ChatGPT sign-in finished without a stored ChatGPT login.');
    return oauth;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * Runs sign-ins and files each as the person's `codex_login` account (see
 * `createAccountSignInService`): a new sign-in to a ChatGPT account they already added replaces its
 * pair (and turns it back on) instead of adding a second one.
 */
export function createCodexSignInService({
  credentials,
  capture,
  command,
  run,
  env,
  now,
}: {
  credentials: ModelCredentialsStorage;
  capture?: (options: { signal: AbortSignal }) => Promise<SignInOAuth>;
  command?: string;
  run?: CodexSignInRunner;
  env?: Record<string, string | undefined>;
  now?: () => number;
}): AccountSignInService {
  return createAccountSignInService({
    credentials,
    provider: CODEX_ACCOUNT_PROVIDER,
    kind: 'codex_login',
    name: 'ChatGPT',
    capture:
      capture ??
      (({ signal }) =>
        captureCodexSignIn({
          signal,
          ...(command ? { command } : {}),
          ...(run ? { run } : {}),
          ...(env ? { env } : {}),
        })),
    isUserFacing: (error): error is Error => error instanceof CodexSignInError,
    ...(now ? { now } : {}),
  });
}
