/**
 * Signing in with ChatGPT for Codex, as for Claude (`../claude/sign-in.ts`): `codex login` run by
 * the server in a throwaway `CODEX_HOME`, the pair it filed in that home's `auth.json` captured with
 * who signed in (the id token's claims), kept as the person's `codex_login` account (see
 * `createAccountSignInService`), and the throwaway home removed. The pair is the server's from then
 * on: it refreshes it (`oauth.ts`) and hands a run the access token alone.
 *
 * The server may run on another machine than the person's browser, so the CLI signs in with a device
 * code (`codex login --device-auth`): it prints a page (`https://auth.openai.com/codex/device`) and a
 * one-time code, both shown to the person (`onPrompt`), who opens the page in their own browser and
 * enters the code; the CLI polls until they did. Nothing opens a browser or listens on a localhost
 * callback on the server's machine. The person's ChatGPT workspace must allow device-code sign-in.
 *
 * The throwaway home is created 0700 and the sign-in is filed as a file (`cli_auth_credentials_store
 * = "file"`, both on the command line and in the home's `config.toml`), never the OS keyring, and
 * never the person's own `~/.codex`. No secret is logged, nor the one-time code.
 */

import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildCodexEnv } from '@factory/harness-codex';
import { harnessCommandPath, isHarnessExecutableUnavailable, type HarnessCommand } from '@factory/harness/executable';
import { CODEX_FILE_CREDENTIALS_ARGS } from '@factory/harness-codex/launchArgs';
import type { ModelCredentialsStorage, SignInOAuth } from '@factory/store';

import { createSignInCommandRunner, NO_BROWSER } from '../accounts/sign-in-command.ts';
import type { SignInCommandResult, SignInCommandRunner } from '../accounts/sign-in-command.ts';
import { findDeviceCode, findSignInUrl, stripTerminalEscapes } from '../accounts/sign-in-output.ts';
import { createAccountSignInService } from '../accounts/sign-in.ts';
import type { AccountSignInCapture, AccountSignInCapturePrompt, AccountSignInService } from '../accounts/sign-in.ts';
import { CODEX_ACCOUNT_PROVIDER } from './credentials.ts';
import { parseCodexAuthJson } from './oauth.ts';

/** Where the device page lives; a URL elsewhere is never shown to the person. */
export const CODEX_SIGN_IN_HOSTS: readonly string[] = ['openai.com', 'chatgpt.com'];

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

/** The `codex login` arguments: the device-code sign-in, filed as a file in `CODEX_HOME`. */
export function codexSignInArgs(): string[] {
  return ['login', '--device-auth', ...CODEX_FILE_CREDENTIALS_ARGS];
}

export interface CaptureCodexSignInOptions {
  run?: CodexSignInRunner;
  /** The `codex` executable, or the server's resolver (`harnessExecutableFor`); `codex` on the PATH by default. */
  command?: HarnessCommand;
  /** Where the throwaway home is made; the OS temp dir by default. */
  tempRoot?: string;
  /** The server's env, which the CLI inherits only the allowed part of. */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Told once the CLI printed its device page and one-time code. */
  onPrompt?: (prompt: AccountSignInCapturePrompt) => void;
}

/** Sign in once with the CLI in a throwaway home and return the pair it filed, with who signed in. */
export async function captureCodexSignIn(options: CaptureCodexSignInOptions = {}): Promise<SignInOAuth> {
  if (options.signal?.aborted) throw new CodexSignInError('ChatGPT sign-in was cancelled.');
  const run = options.run ?? runCodexSignInCommand;
  // `mkdtemp` makes the home 0700.
  const home = await realpath(await mkdtemp(join(options.tempRoot ?? tmpdir(), 'factory-codex-sign-in-')));
  try {
    await writeFile(join(home, 'config.toml'), CODEX_FILE_CREDENTIALS_CONFIG, { mode: 0o600 });
    let output = '';
    let prompted = false;
    const login = await run(signInCommand(options.command), codexSignInArgs(), {
      // `BROWSER`: should a CLI ever open one, nothing opens on the server's machine.
      env: { ...buildCodexEnv(options.env ?? process.env, { CODEX_HOME: home }), BROWSER: NO_BROWSER },
      timeoutMs: options.timeoutMs ?? CODEX_SIGN_IN_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
      onOutput: text => {
        if (prompted) return;
        output += text;
        const url = findSignInUrl(output, CODEX_SIGN_IN_HOSTS);
        const userCode = url ? findDeviceCode(output) : undefined;
        if (!url || !userCode) return;
        prompted = true;
        output = '';
        options.onPrompt?.({ url, userCode });
      },
    });
    if (login.code !== 0) throw new CodexSignInError(codexLoginFailure(login));
    const stored = await readFile(join(home, 'auth.json'), 'utf8').catch(() => undefined);
    const oauth = stored ? parseCodexAuthJson(stored) : undefined;
    if (!oauth) throw new CodexSignInError('ChatGPT sign-in finished without a stored ChatGPT login.');
    return oauth;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** Why `codex login` failed, with its last line of error output when it wrote one. */
function codexLoginFailure(login: SignInCommandResult): string {
  const said = stripTerminalEscapes(login.stderr)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .at(-1);
  return said
    ? `ChatGPT sign-in failed: ${said.slice(0, 300)}`
    : `ChatGPT sign-in did not finish (codex exited with ${login.code}).`;
}

/** The path to run; a CLI the server cannot find is the person's to read, not a generic failure. */
function signInCommand(command: HarnessCommand | undefined): string {
  try {
    return harnessCommandPath(command, 'codex');
  } catch (error) {
    if (isHarnessExecutableUnavailable(error)) throw new CodexSignInError((error as Error).message);
    throw error;
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
  capture?: AccountSignInCapture;
  command?: HarnessCommand;
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
      (({ signal, onPrompt }) =>
        captureCodexSignIn({
          signal,
          ...(onPrompt ? { onPrompt } : {}),
          ...(command ? { command } : {}),
          ...(run ? { run } : {}),
          ...(env ? { env } : {}),
        })),
    isUserFacing: (error): error is Error => error instanceof CodexSignInError,
    ...(now ? { now } : {}),
  });
}
