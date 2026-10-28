import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';
import { z } from 'zod';

import { anthropicSecretKind, resolveCredentialContext } from '@factory/credentials';
import { Route } from '@factory/http';
import type { RouteAuth, RouteDependencies } from '@factory/http';
import type { CredentialAccount, CredentialAccountKind, ModelCredentialsStorage } from '@factory/store';

/** Providers whose runs rotate through several accounts; Claude Code turns read `anthropic`. */
export const CREDENTIAL_ACCOUNT_PROVIDERS: ReadonlySet<string> = new Set(['anthropic']);

const MAX_LABEL_LENGTH = 100;
const MAX_SECRET_LENGTH = 4096;

const secretSchema = z
  .string()
  .trim()
  .min(20, 'secret is too short')
  .max(MAX_SECRET_LENGTH)
  .refine(value => !/\s/.test(value), 'secret must not contain whitespace');
const labelSchema = z.string().trim().min(1, 'label is required').max(MAX_LABEL_LENGTH);
const prioritySchema = z.number().int().min(-1000).max(1000);

const createSchema = z.object({ label: labelSchema, secret: secretSchema, priority: prioritySchema.optional() }).strict();
const updateSchema = z
  .object({
    label: labelSchema.optional(),
    secret: secretSchema.optional(),
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
  /** The caller's own subscription. */
  mine: boolean;
  priority: number;
  status: CredentialAccountStatus;
  limitedUntil?: string;
  lastError?: string;
  lastUsedAt?: string;
  hint: string;
  /** Whether the caller may change or remove it. */
  canManage: boolean;
  /** Whether the caller may replace its secret (only the owner of a subscription). */
  canReplaceSecret: boolean;
  createdAt: string;
}

export interface CredentialAccountRoutesDeps extends RouteDependencies {
  auth: RouteAuth;
  modelCredentials?: ModelCredentialsStorage;
  now?: () => Date;
}

function kindOf(provider: string, secret: string): CredentialAccountKind {
  return provider === 'anthropic' ? anthropicSecretKind(secret) : 'api_key';
}

function statusOf(account: CredentialAccount, now: Date): CredentialAccountStatus {
  if (account.disabled) return 'disabled';
  if (account.limitedUntil && account.limitedUntil.getTime() > now.getTime()) return 'limited';
  return 'active';
}

/**
 * Credential accounts for a provider: the organization's API keys and its
 * members' own subscriptions, which Claude Code turns rotate through when one
 * runs out of usage.
 *
 *   - `GET    /web/config/providers/:provider/accounts`
 *   - `POST   /web/config/providers/:provider/accounts`      `{ label, secret, priority? }`
 *   - `PATCH  /web/config/providers/:provider/accounts/:id`  `{ label?, secret?, priority?, disabled? }`
 *   - `DELETE /web/config/providers/:provider/accounts/:id`
 *
 * Who may do what: any member adds their own subscription (a `sk-ant-oat`
 * setup token) and manages it; organization API keys, and switching off or
 * removing anyone's account, take an organization admin; only a
 * subscription's owner replaces its secret.
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
      const mine = account.kind === 'subscription' && account.ownerUserId === caller.userId;
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
        canReplaceSecret: account.kind === 'subscription' ? mine : caller.admin,
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

    return [
      registerApiRoute('/web/config/providers/:provider/accounts', {
        method: 'GET',
        requiresAuth: false,
        handler: async c => {
          const ctx = await context(c);
          if ('response' in ctx) return ctx.response;
          const accounts = await ctx.storage.listAccounts(ctx.orgId, ctx.provider);
          return c.json({ accounts: accounts.map(account => view(account, ctx)), canAddOrgKeys: ctx.admin });
        },
      }),

      registerApiRoute('/web/config/providers/:provider/accounts', {
        method: 'POST',
        requiresAuth: false,
        handler: async c => {
          const ctx = await context(c);
          if ('response' in ctx) return ctx.response;
          const parsed = createSchema.safeParse(await body(c));
          if (!parsed.success) return invalid(c, parsed.error);
          const kind = kindOf(ctx.provider, parsed.data.secret);
          // A subscription is personal and always the caller's own; organization keys are an admin's call.
          if (kind === 'api_key' && !ctx.admin) return c.json({ error: 'organization_admin_required' }, 403);
          const account = await ctx.storage.addAccount({
            orgId: ctx.orgId,
            provider: ctx.provider,
            label: parsed.data.label,
            kind,
            ...(kind === 'subscription' ? { ownerUserId: ctx.userId } : {}),
            secret: parsed.data.secret,
            createdBy: ctx.userId,
            ...(parsed.data.priority !== undefined ? { priority: parsed.data.priority } : {}),
          });
          return c.json({ account: view(account, ctx) }, 201);
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
          if (parsed.data.secret !== undefined) {
            if (!current.canReplaceSecret) return c.json({ error: 'forbidden' }, 403);
            if (kindOf(ctx.provider, parsed.data.secret) !== existing.kind) {
              return c.json(
                { error: 'invalid_request', message: 'The new secret must be of the same kind as the old one.' },
                400,
              );
            }
          }
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
