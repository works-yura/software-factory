import { randomUUID } from 'node:crypto';

import type { CredentialAccount, ModelCredentialsStorage, SignInCredentialKind, SignInOAuth } from '@factory/store';

export type AccountSignInStatus = 'pending' | 'done' | 'error';

export interface AccountSignInFlow {
  id: string;
  orgId: string;
  userId: string;
  status: AccountSignInStatus;
  error?: string;
  accountId?: string;
}

/** Sign-ins people started, by id; each runs one capture and keeps its outcome for a while. */
export interface AccountSignInService {
  start(owner: { orgId: string; userId: string }): AccountSignInFlow;
  get(id: string): AccountSignInFlow | undefined;
  cancel(id: string): boolean;
}

/**
 * One sign-in, run to its end: the pair it got and who signed in. The provider's CLI runs it on the
 * server's machine and opens its page in the browser there.
 */
export type AccountSignInCapture = (options: { signal: AbortSignal }) => Promise<SignInOAuth>;

/** How long a finished sign-in's outcome stays readable. */
const FINISHED_FLOW_TTL_MS = 10 * 60_000;

type HeldFlow = AccountSignInFlow & { controller: AbortController; finishedAt?: number };

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
  const view = ({ controller: _controller, finishedAt: _finishedAt, ...flow }: HeldFlow): AccountSignInFlow => ({ ...flow });
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
      void options
        .capture({ signal: flow.controller.signal })
        .then(oauth => file(orgId, userId, oauth))
        .then(account => {
          if (flow.status !== 'pending') return;
          Object.assign(flow, { status: 'done', accountId: account.id, finishedAt: now() });
        })
        .catch((error: unknown) => {
          if (flow.status !== 'pending') return;
          Object.assign(flow, {
            status: 'error',
            error: options.isUserFacing(error) ? error.message : `${name} sign-in failed.`,
            finishedAt: now(),
          });
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
      return true;
    },
  };
}
