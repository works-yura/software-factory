import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';
import { z } from 'zod';

import { resolveCredentialContext } from '@factory/credentials';
import { Route } from '@factory/http';
import type { RouteAuth, RouteDependencies } from '@factory/http';
import { isPersonalCredentialKind, isSignInCredentialKind } from '@factory/store';
import type { CredentialAccount, CredentialAccountKind, ModelCredentialsStorage, SignInCredentialKind } from '@factory/store';

/** The provider Claude Code turns read their sign-ins from. */
export const CLAUDE_CODE_ACCOUNT_PROVIDER = 'anthropic';
/** The provider Codex turns read their ChatGPT sign-ins from. */
export const CODEX_ACCOUNT_PROVIDER = 'openai-codex';

/** Each turn-based harness's accounts: the provider they are filed under, the sign-in kind its turns run on, and its name. */
export const SIGN_IN_ACCOUNT_PROVIDERS: Readonly<Record<string, { kind: SignInCredentialKind; name: string; harness: string }>> = {
  [CLAUDE_CODE_ACCOUNT_PROVIDER]: { kind: 'claude_login', name: 'Claude', harness: 'Claude Code' },
  [CODEX_ACCOUNT_PROVIDER]: { kind: 'codex_login', name: 'ChatGPT', harness: 'Codex' },
};

/** Providers whose runs rotate through several accounts: one per turn-based harness. */
export const CREDENTIAL_ACCOUNT_PROVIDERS: ReadonlySet<string> = new Set(Object.keys(SIGN_IN_ACCOUNT_PROVIDERS));

const MAX_LABEL_LENGTH = 100;

const labelSchema = z.string().trim().min(1, 'label is required').max(MAX_LABEL_LENGTH);
const prioritySchema = z.number().int().min(-1000).max(1000);

const updateSchema = z
  .object({
    label: labelSchema.optional(),
    priority: prioritySchema.optional(),
    disabled: z.boolean().optional(),
  })
  .strict();

export type CredentialAccountStatus = 'active' | 'limited' | 'disabled';

/** One account as the settings page sees it: never the secret. */
export interface CredentialAccountView {
  id: string;
  label: string;
  kind: CredentialAccountKind;
  /** The caller's own sign-in. */
  mine: boolean;
  priority: number;
  status: CredentialAccountStatus;
  limitedUntil?: string;
  lastError?: string;
  lastUsedAt?: string;
  hint: string;
  /** Whether the caller may change or remove it. */
  canManage: boolean;
  /**
   * A pasted setup token or API key from before Claude Code took only Claude sign-ins: no turn uses it any
   * more, and it is listed only so it can be removed.
   */
  legacy: boolean;
  /** A sign-in the token endpoint refused: its owner must sign in again. */
  needsSignIn: boolean;
  createdAt: string;
}

/** One sign-in a person started (see the server's `createAccountSignInService`). */
export interface AccountSignInFlowView {
  id: string;
  orgId: string;
  userId: string;
  status: 'pending' | 'done' | 'error';
  /** The page (and device code) the person finishes signing in with, once the provider gave it. */
  prompt?: { url: string; code?: string };
  error?: string;
  accountId?: string;
}

/** Runs a provider's sign-in for a person (`claude auth login`, Codex's device sign-in). */
export interface AccountSignInFlows {
  start(owner: { orgId: string; userId: string }): AccountSignInFlowView;
  get(id: string): AccountSignInFlowView | undefined;
  cancel(id: string): boolean;
}

/** @deprecated Claude's alone; see {@link AccountSignInFlowView}. */
export type ClaudeSignInFlowView = AccountSignInFlowView;
/** @deprecated Claude's alone; see {@link AccountSignInFlows}. */
export type ClaudeSignInFlows = AccountSignInFlows;

export interface CredentialAccountRoutesDeps extends RouteDependencies {
  auth: RouteAuth;
  modelCredentials?: ModelCredentialsStorage;
  /** Claude sign-in on this host; unset where the CLI's browser would open on a machine nobody sits at. */
  claudeSignIn?: AccountSignInFlows;
  /** Sign-in per provider (`openai-codex`: Codex's device sign-in); `claudeSignIn` is `anthropic`'s. */
  accountSignIn?: Readonly<Record<string, AccountSignInFlows | undefined>>;
  now?: () => Date;
}

function statusOf(account: CredentialAccount, now: Date): CredentialAccountStatus {
  if (account.disabled) return 'disabled';
  if (account.limitedUntil && account.limitedUntil.getTime() > now.getTime()) return 'limited';
  return 'active';
}

/**
 * The turn-based harnesses' accounts (Claude Code's `anthropic`, Codex's
 * `openai-codex`): the members' own sign-ins, which turns rotate through when
 * one runs out of usage. A sign-in is the only way to add one; a pasted token
 * or API key is refused (410), and such accounts left from before are listed
 * as `legacy` only so they can be removed: no turn uses them.
 *
 *   - `GET    /web/config/providers/:provider/accounts`
 *   - `POST   /web/config/providers/:provider/accounts`      refused: sign in instead
 *   - `PATCH  /web/config/providers/:provider/accounts/:id`  `{ label?, priority?, disabled? }`
 *   - `DELETE /web/config/providers/:provider/accounts/:id`
 *
 *   - `POST   /web/config/providers/:provider/accounts/sign-in`      start a sign-in
 *   - `GET    /web/config/providers/:provider/accounts/sign-in/:id`  its status (and device code)
 *   - `DELETE /web/config/providers/:provider/accounts/sign-in/:id`  cancel it
 *
 * Who may do what: any member signs in and manages their own sign-in;
 * switching off or removing anyone's account takes an organization admin. A
 * sign-in is renewed by signing in again.
 */
export class CredentialAccountRoutes extends Route<CredentialAccountRoutesDeps> {
  routes(): ApiRoute[] {
    const { auth } = this.deps;
    const now = this.deps.now ?? (() => new Date());

    const context = async (c: Context) => {
      const provider = c.req.param('provider') ?? '';
      if (!CREDENTIAL_ACCOUNT_PROVIDERS.has(provider)) {
        return { response: c.json({ error: 'unsupported_provider', provider }, 400) };
      }
      const ctx = await resolveCredentialContext({ c, auth, credentials: this.deps.modelCredentials });
      if ('response' in ctx) return ctx;
      if (ctx.mode !== 'tenant') {
        return {
          response: c.json(
            { error: 'accounts_need_sign_in', message: 'Credential accounts need a signed-in organization.' },
            400,
          ),
        };
      }
      const admin = await auth.isOrganizationAdmin(c, ctx.orgId);
      return { provider, storage: ctx.storage, orgId: ctx.orgId, userId: ctx.userId, admin };
    };

    const view = (account: CredentialAccount, caller: { userId: string; admin: boolean }): CredentialAccountView => {
      const signInKind = SIGN_IN_ACCOUNT_PROVIDERS[account.provider]?.kind;
      const mine = isPersonalCredentialKind(account.kind) && account.ownerUserId === caller.userId;
      return {
        id: account.id,
        label: account.label,
        kind: account.kind,
        mine,
        priority: account.priority,
        status: statusOf(account, now()),
        ...(account.limitedUntil ? { limitedUntil: account.limitedUntil.toISOString() } : {}),
        ...(account.lastError ? { lastError: account.lastError } : {}),
        ...(account.lastUsedAt ? { lastUsedAt: account.lastUsedAt.toISOString() } : {}),
        hint: account.hint,
        canManage: mine || caller.admin,
        legacy: account.kind !== signInKind,
        needsSignIn: isSignInCredentialKind(account.kind) && account.disabled && account.lastError !== undefined,
        createdAt: account.createdAt.toISOString(),
      };
    };

    const body = async (c: Context): Promise<unknown> => {
      try {
        return await c.req.json();
      } catch {
        return undefined;
      }
    };

    const invalid = (c: Context, error: z.ZodError) =>
      c.json({ error: 'invalid_request', message: error.issues.map(issue => issue.message).join('; ') }, 400);

    /** The caller's own sign-in flow, or the response that refuses it. */
    const signInFlow = async (c: Context) => {
      const ctx = await context(c);
      if ('response' in ctx) return ctx;
      const flows =
        this.deps.accountSignIn?.[ctx.provider] ?? (ctx.provider === CLAUDE_CODE_ACCOUNT_PROVIDER ? this.deps.claudeSignIn : undefined);
      if (!flows) {
        const name = SIGN_IN_ACCOUNT_PROVIDERS[ctx.provider]?.name ?? ctx.provider;
        return {
          response: c.json(
            {
              error: 'sign_in_unavailable',
              message:
                ctx.provider === CLAUDE_CODE_ACCOUNT_PROVIDER
                  ? 'Signing in to Claude here works only where the Factory server runs on your own machine.'
                  : `Signing in to ${name} is not available on this server.`,
            },
            404,
          ),
        };
      }
      return { ...ctx, flows };
    };

    const flowView = async (
      flow: AccountSignInFlowView,
      ctx: { storage: ModelCredentialsStorage; orgId: string; userId: string; admin: boolean },
    ) => {
      const account = flow.accountId ? await ctx.storage.getAccount(ctx.orgId, flow.accountId) : undefined;
      return {
        id: flow.id,
        status: flow.status,
        ...(flow.prompt ? { prompt: flow.prompt } : {}),
        ...(flow.error ? { error: flow.error } : {}),
        ...(account ? { account: view(account, ctx) } : {}),
      };
    };

    return [
      registerApiRoute('/web/config/providers/:provider/accounts/sign-in', {
        method: 'POST',
        requiresAuth: false,
        handler: async c => {
          const ctx = await signInFlow(c);
          if ('response' in ctx) return ctx.response;
          const flow = ctx.flows.start({ orgId: ctx.orgId, userId: ctx.userId });
          return c.json({ signIn: await flowView(flow, ctx) }, 202);
        },
      }),

      registerApiRoute('/web/config/providers/:provider/accounts/sign-in/:id', {
        method: 'GET',
        requiresAuth: false,
        handler: async c => {
          const ctx = await signInFlow(c);
          if ('response' in ctx) return ctx.response;
          const flow = ctx.flows.get(c.req.param('id') ?? '');
          // Another person's sign-in is not there for this caller.
          if (!flow || flow.orgId !== ctx.orgId || flow.userId !== ctx.userId) return c.json({ error: 'not_found' }, 404);
          return c.json({ signIn: await flowView(flow, ctx) });
        },
      }),

      registerApiRoute('/web/config/providers/:provider/accounts/sign-in/:id', {
        method: 'DELETE',
        requiresAuth: false,
        handler: async c => {
          const ctx = await signInFlow(c);
          if ('response' in ctx) return ctx.response;
          const id = c.req.param('id') ?? '';
          const flow = ctx.flows.get(id);
          if (!flow || flow.orgId !== ctx.orgId || flow.userId !== ctx.userId) return c.json({ error: 'not_found' }, 404);
          return c.json({ cancelled: ctx.flows.cancel(id) });
        },
      }),

      registerApiRoute('/web/config/providers/:provider/accounts', {
        method: 'GET',
        requiresAuth: false,
        handler: async c => {
          const ctx = await context(c);
          if ('response' in ctx) return ctx.response;
          const accounts = await ctx.storage.listAccounts(ctx.orgId, ctx.provider);
          return c.json({ accounts: accounts.map(account => view(account, ctx)) });
        },
      }),

      // Turns run only on sign-ins: a pasted setup token or API key is refused.
      registerApiRoute('/web/config/providers/:provider/accounts', {
        method: 'POST',
        requiresAuth: false,
        handler: async c => {
          const ctx = await context(c);
          if ('response' in ctx) return ctx.response;
          const provider = SIGN_IN_ACCOUNT_PROVIDERS[ctx.provider]!;
          return c.json(
            {
              error: ctx.provider === CLAUDE_CODE_ACCOUNT_PROVIDER ? 'claude_sign_in_required' : 'sign_in_required',
              message: `${provider.harness} accounts are added by signing in to ${provider.name}; tokens and API keys are not accepted.`,
            },
            410,
          );
        },
      }),

      registerApiRoute('/web/config/providers/:provider/accounts/:id', {
        method: 'PATCH',
        requiresAuth: false,
        handler: async c => {
          const ctx = await context(c);
          if ('response' in ctx) return ctx.response;
          const parsed = updateSchema.safeParse(await body(c));
          if (!parsed.success) return invalid(c, parsed.error);
          const id = c.req.param('id') ?? '';
          const existing = await ctx.storage.getAccount(ctx.orgId, id);
          if (!existing || existing.provider !== ctx.provider) return c.json({ error: 'not_found' }, 404);
          const current = view(existing, ctx);
          if (!current.canManage) return c.json({ error: 'forbidden' }, 403);
          const updated = await ctx.storage.updateAccount(ctx.orgId, id, parsed.data);
          if (!updated) return c.json({ error: 'not_found' }, 404);
          return c.json({ account: view(updated, ctx) });
        },
      }),

      registerApiRoute('/web/config/providers/:provider/accounts/:id', {
        method: 'DELETE',
        requiresAuth: false,
        handler: async c => {
          const ctx = await context(c);
          if ('response' in ctx) return ctx.response;
          const id = c.req.param('id') ?? '';
          const existing = await ctx.storage.getAccount(ctx.orgId, id);
          if (!existing || existing.provider !== ctx.provider) return c.json({ error: 'not_found' }, 404);
          if (!view(existing, ctx).canManage) return c.json({ error: 'forbidden' }, 403);
          await ctx.storage.removeAccount(ctx.orgId, id);
          return c.json({ ok: true });
        },
      }),
    ];
  }
}
