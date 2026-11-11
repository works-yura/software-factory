import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';

import type { Intake } from '@factory/capabilities';
import type { AuditEmitter } from '@factory/feed';
import type { IntakeConfig, IntakeStorage } from '@factory/store';
import type { RouteDependencies } from '@factory/http';
import { Route } from '@factory/http';

export interface IntakeIntegration {
  id: string;
  intake: Pick<Intake, 'listSources'>;
}

export interface IntakeRoutesDeps extends RouteDependencies {
  audit: AuditEmitter;
  /** Intake selection domain handle. */
  intake: IntakeStorage;
  integrations?: IntakeIntegration[];
}

export interface IntakeIntegrationFailure {
  integrationId: string;
  message: string;
}

type SettledIntegration<T> = { integrationId: string; value: T } | IntakeIntegrationFailure;

const PROVIDER_READ_TIMEOUT_MS = 15_000;

/** The Intake contract takes no abort signal, so a slow read is abandoned, not cancelled. */
function withTimeout<T>(
  integrationId: string,
  read: () => Promise<T>,
  timeoutMs: number = PROVIDER_READ_TIMEOUT_MS,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const budget = Math.max(0, timeoutMs);
    const timer = setTimeout(
      () => reject(new Error(`${integrationId} did not answer within ${Math.round(budget / 1000)}s`)),
      budget,
    );
    read()
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

/**
 * Read every integration concurrently and isolate the ones that throw or hang, so a single
 * unreachable provider degrades to a per-source error instead of failing the listing.
 */
async function settleByIntegration<T>(
  requests: Array<{ integrationId: string; read: () => Promise<T> }>,
): Promise<{ pages: Array<{ integrationId: string; value: T }>; failures: IntakeIntegrationFailure[] }> {
  const settled = await Promise.all(
    requests.map(async ({ integrationId, read }): Promise<SettledIntegration<T>> => {
      try {
        return { integrationId, value: await withTimeout(integrationId, read) };
      } catch (error) {
        console.error(`[factory] intake integration ${integrationId} is unavailable:`, error);
        return { integrationId, message: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  const pages: Array<{ integrationId: string; value: T }> = [];
  const failures: IntakeIntegrationFailure[] = [];
  for (const entry of settled) {
    if ('value' in entry) pages.push(entry);
    else failures.push(entry);
  }
  return { pages, failures };
}

const MAX_INTAKE_SOURCE_ID_LENGTH = 1024;

function loose(c: unknown): Context {
  return c as Context;
}

function sanitizeIdList(value: unknown): string[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 200) return undefined;
  const ids = value.filter(
    (item): item is string => typeof item === 'string' && item.length > 0 && item.length <= MAX_INTAKE_SOURCE_ID_LENGTH,
  );
  return ids.length === value.length && new Set(ids).size === ids.length ? ids : undefined;
}

/** Validate a request body into an intake config, rejecting unknown shapes. */
export function parseIntakeConfig(body: unknown): IntakeConfig | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const entries = Object.entries(body);
  if (entries.length > 50) return null;

  // Null-prototype so an `__proto__` key lands as a real entry instead of silently
  // reassigning the prototype and disappearing from the validation below.
  const config: IntakeConfig = Object.create(null);
  for (const [integrationId, value] of entries) {
    if (
      !integrationId ||
      integrationId.length > 128 ||
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value)
    ) {
      return null;
    }
    const selection = value as { enabled?: unknown; sourceIds?: unknown };
    if (typeof selection.enabled !== 'boolean') return null;
    const sourceIds = sanitizeIdList(selection.sourceIds ?? null);
    if (sourceIds === undefined) return null;
    config[integrationId] = { enabled: selection.enabled, sourceIds };
  }
  return config;
}

export class IntakeRoutes extends Route<IntakeRoutesDeps> {
  async #resolveTenant(c: Context): Promise<{ orgId: string; userId: string } | { response: Response }> {
    await this.deps.auth.ensureUser(c);
    const tenant = this.deps.auth.tenant(c);
    if (!tenant) return { response: c.json({ error: 'unauthorized' }, 401) };
    if (!tenant.orgId) {
      return {
        response: c.json(
          { error: 'organization_required', message: 'Intake configuration requires an organization.' },
          403,
        ),
      };
    }
    return { orgId: tenant.orgId, userId: tenant.userId };
  }

  routes(): ApiRoute[] {
    const { audit, intake, integrations = [] } = this.deps;
    const integrationIds = integrations.map(integration => integration.id);

    return [
      registerApiRoute('/web/intake/config', {
        method: 'GET',
        requiresAuth: false,
        handler: async c => {
          const tenant = await this.#resolveTenant(loose(c));
          if ('response' in tenant) return tenant.response;
          await intake.ensureReady();
          const config = await intake.getConfig({ orgId: tenant.orgId, integrationIds });
          return c.json({ config });
        },
      }),
      registerApiRoute('/web/intake/config', {
        method: 'PUT',
        requiresAuth: false,
        handler: async c => {
          const tenant = await this.#resolveTenant(loose(c));
          if ('response' in tenant) return tenant.response;

          let body: unknown;
          try {
            body = await c.req.json();
          } catch {
            return c.json({ error: 'Invalid JSON body' }, 400);
          }
          const config = parseIntakeConfig(body);
          if (!config) {
            return c.json({ error: 'invalid_config' }, 400);
          }

          const registeredConfig: IntakeConfig = Object.create(null);
          for (const [integrationId, selection] of Object.entries(config)) {
            if (integrationIds.includes(integrationId)) {
              registeredConfig[integrationId] = selection;
              continue;
            }
            if (selection.enabled || selection.sourceIds?.length) {
              return c.json({ error: 'invalid_config' }, 400);
            }
          }

          await intake.ensureReady();
          await intake.saveConfig({ orgId: tenant.orgId, config: registeredConfig });
          await audit.emit({
            context: loose(c),
            input: {
              action: 'factory.intake.config_updated',
              targets: [{ type: 'intake_config', id: tenant.orgId }],
              metadata: Object.fromEntries(
                Object.entries(registeredConfig).map(([integrationId, selection]) => [
                  integrationId,
                  { enabled: selection.enabled, sources: selection.sourceIds?.length ?? null },
                ]),
              ),
            },
          });
          return c.json({ config: registeredConfig });
        },
      }),
      // Label routes are gone: a project's intake routes decide where its cards land.
      ...(['GET', 'PUT'] as const).map(method =>
        registerApiRoute('/web/intake/label-routes', {
          method,
          requiresAuth: false,
          handler: async c => {
            const tenant = await this.#resolveTenant(loose(c));
            if ('response' in tenant) return tenant.response;
            return c.json(
              {
                error: 'label_routes_removed',
                message:
                  "Label routes were removed. Add an intake route on the project instead: POST /web/factory/projects/:id/intake-routes with a condition on 'item.labels'.",
              },
              410,
            );
          },
        }),
      ),
      registerApiRoute('/web/intake/sources', {
        method: 'GET',
        requiresAuth: false,
        handler: async c => {
          const tenant = await this.#resolveTenant(loose(c));
          if ('response' in tenant) return tenant.response;
          const requested = c.req.query('integrationId');
          const { pages, failures } = await settleByIntegration(
            (requested ? integrations.filter(integration => integration.id === requested) : integrations).map(
              integration => ({
                integrationId: integration.id,
                read: () => integration.intake.listSources(tenant),
              }),
            ),
          );
          return c.json({
            sources: pages.flatMap(({ integrationId, value }) => value.map(source => ({ integrationId, ...source }))),
            failures,
          });
        },
      }),
    ];
  }
}
