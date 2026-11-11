/**
 * Signing in with ChatGPT for Codex: a device sign-in run by the server through `codex app-server`
 * (`account/login/start` with `chatgptDeviceCode`) in a throwaway `CODEX_HOME`. The person opens
 * the page the flow shows and enters its one-time code there (on any machine: nothing opens on the
 * server's); once Codex reports the sign-in done, the pair it filed in the throwaway home's
 * `auth.json` is captured with who signed in, kept as the person's `codex_login` account (see
 * `createAccountSignInService`), and the throwaway home removed. The pair is the server's from then
 * on: it refreshes it (`oauth.ts`) and hands a run the access token alone.
 *
 * The throwaway home is created 0700 and its sign-in is filed as a file (`cli_auth_credentials_store
 * = "file"`), never the OS keyring, and never the person's own `~/.codex`. No secret is logged.
 *
 * A ChatGPT workspace may have device sign-ins turned off (ChatGPT security settings); Codex then
 * fails the sign-in and the flow says why.
 */

import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildCodexEnv, spawnCodexAppServer } from '@factory/harness-codex';
import type { CodexAppServerProcess, CodexSpawn } from '@factory/harness-codex';
import { CODEX_FILE_CREDENTIALS_ARGS, codexAppServerArgs, resolveCodexLaunchArgs } from '@factory/harness-codex/launchArgs';
import type { ModelCredentialsStorage, SignInOAuth } from '@factory/store';

import { createAccountSignInService } from '../accounts/sign-in.ts';
import type { AccountSignInPrompt, AccountSignInService } from '../accounts/sign-in.ts';
import { CODEX_ACCOUNT_PROVIDER } from './credentials.ts';
import { parseCodexAuthJson } from './oauth.ts';

/** How long a person gets to finish a device sign-in (Codex's device codes live about as long). */
export const CODEX_SIGN_IN_TIMEOUT_MS = 15 * 60_000;

export class CodexSignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexSignInError';
  }
}

export interface CaptureCodexSignInOptions {
  signal: AbortSignal;
  onPrompt: (prompt: AccountSignInPrompt) => void;
  /** The `codex` executable; `codex` on the PATH by default. */
  command?: string;
  launchArgs?: string;
  spawn?: CodexSpawn;
  /** Where the throwaway home is made; the OS temp dir by default. */
  tempRoot?: string;
  /** The server's env, which the CLI inherits only the allowed part of. */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

/** Sign in once with a device code in a throwaway home and return the pair Codex filed, with who signed in. */
export async function captureCodexSignIn(options: CaptureCodexSignInOptions): Promise<SignInOAuth> {
  const env = options.env ?? process.env;
  const home = await realpath(await mkdtemp(join(options.tempRoot ?? tmpdir(), 'factory-codex-sign-in-')));
  let server: CodexAppServerProcess | undefined;
  let timer: NodeJS.Timeout | undefined;
  const cleanup: Array<() => void> = [];
  try {
    if (options.signal.aborted) throw new CodexSignInError('ChatGPT sign-in was cancelled.');
    server = await spawnCodexAppServer({
      ...(options.command ? { command: options.command } : {}),
      args: [...CODEX_FILE_CREDENTIALS_ARGS, ...codexAppServerArgs(resolveCodexLaunchArgs(options.launchArgs, env))],
      cwd: home,
      env: buildCodexEnv(env, { CODEX_HOME: home }),
      ...(options.spawn ? { spawn: options.spawn } : {}),
    }).catch((error: unknown) => {
      throw new CodexSignInError(`Codex could not start: ${error instanceof Error ? error.message : String(error)}`);
    });
    const appServer = server;
    let loginId: string | undefined;
    const completed = new Promise<void>((resolve, reject) => {
      cleanup.push(
        appServer.client.handleServerNotification('account/login/completed', payload => {
          if (loginId !== undefined && payload.loginId !== null && payload.loginId !== loginId) return;
          if (payload.success) resolve();
          else reject(new CodexSignInError(payload.error ? `ChatGPT sign-in failed: ${payload.error}` : 'ChatGPT sign-in did not finish.'));
        }),
        appServer.client.onTerminated(() => reject(new CodexSignInError('Codex stopped before the sign-in finished.'))),
      );
      const abort = () => {
        if (loginId) void appServer.client.request('account/login/cancel', { loginId }).catch(() => {});
        reject(new CodexSignInError('ChatGPT sign-in was cancelled.'));
      };
      options.signal.addEventListener('abort', abort, { once: true });
      cleanup.push(() => options.signal.removeEventListener('abort', abort));
      timer = setTimeout(() => reject(new CodexSignInError('ChatGPT sign-in timed out.')), options.timeoutMs ?? CODEX_SIGN_IN_TIMEOUT_MS);
      timer.unref?.();
    });
    completed.catch(() => {});
    const started = await appServer.client.request('account/login/start', { type: 'chatgptDeviceCode' });
    if (started.type !== 'chatgptDeviceCode') throw new CodexSignInError('Codex did not start a device sign-in.');
    loginId = started.loginId;
    options.onPrompt({ url: started.verificationUrl, code: started.userCode });
    await completed;
    const stored = await readFile(join(home, 'auth.json'), 'utf8').catch(() => undefined);
    const oauth = stored ? parseCodexAuthJson(stored) : undefined;
    if (!oauth) throw new CodexSignInError('ChatGPT sign-in finished without a stored ChatGPT login.');
    // Codex's own reading of who signed in, where the tokens left it out.
    const account = await appServer.client.request('account/read', {}).catch(() => undefined);
    const chatgpt = account?.account?.type === 'chatgpt' ? account.account : undefined;
    return {
      ...oauth,
      ...(!oauth.email && chatgpt?.email ? { email: chatgpt.email } : {}),
      ...(!oauth.subscriptionType && chatgpt?.planType ? { subscriptionType: chatgpt.planType } : {}),
    };
  } finally {
    if (timer) clearTimeout(timer);
    for (const stop of cleanup) stop();
    server?.terminate();
    await server?.exited.catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
}

/** Runs device sign-ins and files each as the person's `codex_login` account (see `createAccountSignInService`). */
export function createCodexSignInService({
  credentials,
  capture,
  command,
  launchArgs,
  spawn,
  env,
  now,
}: {
  credentials: ModelCredentialsStorage;
  capture?: (options: { signal: AbortSignal; onPrompt: (prompt: AccountSignInPrompt) => void }) => Promise<SignInOAuth>;
  command?: string;
  launchArgs?: string;
  spawn?: CodexSpawn;
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
      (options =>
        captureCodexSignIn({
          ...options,
          ...(command ? { command } : {}),
          ...(launchArgs ? { launchArgs } : {}),
          ...(spawn ? { spawn } : {}),
          ...(env ? { env } : {}),
        })),
    isUserFacing: (error): error is Error => error instanceof CodexSignInError,
    ...(now ? { now } : {}),
  });
}
