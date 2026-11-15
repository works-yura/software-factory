import { randomUUID } from 'node:crypto';

import type { CredentialAccount, ModelCredentialsStorage, SignInCredentialKind, SignInOAuth } from '@factory/store';

export type AccountSignInStatus = 'pending' | 'done' | 'error';

/**
 * What the person does in their own browser to finish a pending sign-in: open `url` (the provider's
 * page, printed by the CLI on the server), and either enter `userCode` there (a device-code sign-in)
 * or paste back the code that page shows (`acceptsCode`, until one was submitted).
 */
export interface AccountSignInPrompt {
  url: string;
  userCode?: string;
  acceptsCode: boolean;
}

export interface AccountSignInFlow {
  id: string;
  orgId: string;
  userId: string;
  status: AccountSignInStatus;
  error?: string;
  accountId?: string;
  /** Set once the CLI printed its sign-in page, while the flow is pending. */
  prompt?: AccountSignInPrompt;
}

/** What submitting a pasted code did: handed to the CLI, or why not. */
export type AccountSignInCodeResult = 'accepted' | 'not_found' | 'not_waiting' | 'invalid';

/** Sign-ins people started, by id; each runs one capture and keeps its outcome for a while. */
export interface AccountSignInService {
  start(owner: { orgId: string; userId: string }): AccountSignInFlow;
  get(id: string): AccountSignInFlow | undefined;
  cancel(id: string): boolean;
  /** Hands the code the person pasted to their own pending sign-in's CLI (`owner` must have started it). */
  submitCode(id: string, owner: { orgId: string; userId: string }, code: string): AccountSignInCodeResult;
}

/** The page a capture's CLI printed, and, when it reads a pasted code, what hands one to it. */
export interface AccountSignInCapturePrompt {
  url: string;
  userCode?: string;
  submitCode?: (code: string) => void;
}

/**
 * One sign-in, run to its end: the pair it got and who signed in. The provider's CLI runs it on the
 * server's machine without opening a browser there; it reports the page the person opens in their own
 * browser (`onPrompt`).
 */
export type AccountSignInCapture = (options: {
  signal: AbortSignal;
  onPrompt?: (prompt: AccountSignInCapturePrompt) => void;
}) => Promise<SignInOAuth>;

/** The longest code a person may paste; a provider's codes are far shorter. */
const MAX_SIGN_IN_CODE_LENGTH = 2048;

/** A pasted code, trimmed: one line of printable characters without spaces, or `undefined`. */
export function normalizeSignInCode(code: string): string | undefined {
  const trimmed = code.trim();
  return trimmed && trimmed.length <= MAX_SIGN_IN_CODE_LENGTH && /^[\x21-\x7e]+$/.test(trimmed) ? trimmed : undefined;
}

/** How long a finished sign-in's outcome stays readable. */
const FINISHED_FLOW_TTL_MS = 10 * 60_000;

type HeldFlow = AccountSignInFlow & {
  controller: AbortController;
  finishedAt?: number;
  submit?: (code: string) => void;
};

export interface AccountSignInServiceOptions {
  credentials: ModelCredentialsStorage;
  provider: string;
  kind: SignInCredentialKind;
  capture: AccountSignInCapture;
  /** How the provider names itself in a label and an error ("Claude", "ChatGPT"). */
  name: string;
  /** The error type whose message the person may read; anything else becomes a generic failure. */
  isUserFacing(error: unknown): error is Error;
  now?: () => number;
}

/**
 * Runs sign-ins and files each as the person's own account of `kind`: a new sign-in to an account
 * they already added (the same provider account, else the same label) replaces its pair and turns
 * it back on instead of adding a second one. One sign-in per person at a time.
 */
export function createAccountSignInService(options: AccountSignInServiceOptions): AccountSignInService {
  const { credentials, provider, kind, name } = options;
  const now = options.now ?? (() => Date.now());
  const flows = new Map<string, HeldFlow>();
  const view = ({ controller: _controller, finishedAt: _finishedAt, submit: _submit, prompt, ...flow }: HeldFlow): AccountSignInFlow => ({
    ...flow,
    // The page matters only while the sign-in waits on it.
    ...(prompt && flow.status === 'pending' ? { prompt: { ...prompt } } : {}),
  });
  const prune = () => {
    for (const [id, flow] of flows) {
      if (flow.finishedAt !== undefined && now() - flow.finishedAt > FINISHED_FLOW_TTL_MS) flows.delete(id);
    }
  };

  const file = async (orgId: string, userId: string, oauth: SignInOAuth): Promise<CredentialAccount> => {
    const label = oauth.email ?? name;
    const accounts = await credentials.listAccounts(orgId, provider);
    const own = accounts.filter(account => account.kind === kind && account.ownerUserId === userId);
    for (const account of own) {
      const stored = await credentials.getAccountOAuth(orgId, account.id);
      const same = oauth.accountUuid ? stored?.accountUuid === oauth.accountUuid : account.label === label;
      if (!same) continue;
      const updated = await credentials.updateAccount(orgId, account.id, { oauth, label });
      if (updated) return updated;
    }
    return credentials.addAccount({
      orgId,
      provider,
      label,
      kind,
      ownerUserId: userId,
      secret: oauth.accessToken,
      oauth,
      createdBy: userId,
    });
  };

  return {
    start({ orgId, userId }) {
      prune();
      for (const flow of flows.values()) {
        // One sign-in per person at a time: a second click shows the first.
        if (flow.orgId === orgId && flow.userId === userId && flow.status === 'pending') return view(flow);
      }
      const flow: HeldFlow = { id: randomUUID(), orgId, userId, status: 'pending', controller: new AbortController() };
      flows.set(flow.id, flow);
      const onPrompt = ({ url, userCode, submitCode }: AccountSignInCapturePrompt) => {
        if (flow.status !== 'pending') return;
        flow.prompt = { url, ...(userCode ? { userCode } : {}), acceptsCode: submitCode !== undefined };
        if (submitCode) flow.submit = submitCode;
        else delete flow.submit;
      };
      void options
        .capture({ signal: flow.controller.signal, onPrompt })
        .then(oauth => file(orgId, userId, oauth))
        .then(account => {
          if (flow.status !== 'pending') return;
          Object.assign(flow, { status: 'done', accountId: account.id, finishedAt: now() });
          delete flow.submit;
        })
        .catch((error: unknown) => {
          if (flow.status !== 'pending') return;
          Object.assign(flow, {
            status: 'error',
            error: options.isUserFacing(error) ? error.message : `${name} sign-in failed.`,
            finishedAt: now(),
          });
          delete flow.submit;
          if (!options.isUserFacing(error)) console.warn(`[factory] ${name} sign-in failed`, { orgId, error });
        });
      return view(flow);
    },
    get(id) {
      prune();
      const flow = flows.get(id);
      return flow ? view(flow) : undefined;
    },
    cancel(id) {
      const flow = flows.get(id);
      if (!flow || flow.status !== 'pending') return false;
      flow.controller.abort();
      Object.assign(flow, { status: 'error', error: `${name} sign-in was cancelled.`, finishedAt: now() });
      delete flow.submit;
      return true;
    },
    submitCode(id, { orgId, userId }, code) {
      const flow = flows.get(id);
      // Another person's sign-in is not there for this caller.
      if (!flow || flow.orgId !== orgId || flow.userId !== userId) return 'not_found';
      if (flow.status !== 'pending' || !flow.submit || !flow.prompt?.acceptsCode) return 'not_waiting';
      const normalized = normalizeSignInCode(code);
      if (!normalized) return 'invalid';
      // One code per sign-in: the CLI reads one line and then finishes or fails.
      const submit = flow.submit;
      delete flow.submit;
      flow.prompt = { ...flow.prompt, acceptsCode: false };
      submit(normalized);
      return 'accepted';
    },
  };
}
