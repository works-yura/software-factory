import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';

import type { SandboxSleeper } from '@factory/sandbox';
import type { FactoryProjectsStorage } from '@factory/store';
import { FACTORY_ROUTE_CONTRACTS, sandboxSleepBodySchema, UUID_PATTERN } from '@factory/contracts';
import type { RouteDependencies } from '@factory/http';
import { Route } from '@factory/http';

const UUID_RE = new RegExp(UUID_PATTERN);

export interface SandboxRoutesDeps extends RouteDependencies {
  projects: Pick<FactoryProjectsStorage, 'get'>;
  /** Absent when the sandbox keeps no template (no mirrors, nothing sleeps): the list is empty. */
  sleeper?: Pick<SandboxSleeper, 'list' | 'sleep'>;
}

type Resolved = { orgId: string; projectId: string };

/**
 * Settings › Environment › Sandboxes (ADR-0039): a Factory's local sandbox
 * folders and a manual «save and stop» for one no agent works in. Both are
 * for organization admins, like the rest of the sandbox settings.
 */
export class SandboxRoutes extends Route<SandboxRoutesDeps> {
  async #resolve(context: Context): Promise<Resolved | { response: Response }> {
    await this.deps.auth.ensureUser(context);
    const tenant = this.deps.auth.tenant(context);
    if (!tenant) return { response: context.json({ error: 'unauthorized' }, 401) };
    if (!tenant.orgId) {
      return {
        response: context.json({ error: 'organization_required', message: 'Factory projects require an organization.' }, 403),
      };
    }
    const projectId = context.req.param('id');
    if (!projectId || !UUID_RE.test(projectId)) return { response: context.json({ error: 'Project not found' }, 404) };
    const project = await this.deps.projects.get({ orgId: tenant.orgId, id: projectId });
    if (!project) return { response: context.json({ error: 'Project not found' }, 404) };
    if (this.deps.auth.enabled() && !(await this.deps.auth.isOrganizationAdmin(context, tenant.orgId))) {
      return {
        response: context.json(
          { error: 'organization_admin_required', message: 'Organization administrator access is required to manage sandboxes.' },
          403,
        ),
      };
    }
    return { orgId: tenant.orgId, projectId };
  }

  #route(
    contract: { path: string; method: 'GET' | 'POST' },
    handle: (context: Context, scope: Resolved) => Promise<Response>,
  ): ApiRoute {
    return registerApiRoute(contract.path, {
      method: contract.method,
      requiresAuth: false,
      handler: async routeContext => {
        const context = routeContext as unknown as Context;
        const scope = await this.#resolve(context);
        const response = 'response' in scope ? scope.response : await handle(context, scope);
        response.headers.set('Cache-Control', 'no-store');
        return response;
      },
    });
  }

  routes(): ApiRoute[] {
    const contracts = FACTORY_ROUTE_CONTRACTS;
    return [
      this.#route(contracts.projectSandboxesList, async (context, scope) => {
        const sandboxes = this.deps.sleeper ? await this.deps.sleeper.list(scope.projectId) : [];
        return context.json({
          sandboxes: sandboxes.map(({ orgId: _orgId, factoryProjectId: _factoryProjectId, ...view }) => view),
          canManage: true,
        });
      }),
      this.#route(contracts.projectSandboxSleep, async (context, scope) => {
        let body: unknown;
        try {
          body = await context.req.json();
        } catch {
          return context.json({ error: 'invalid_body' }, 400);
        }
        const parsed = sandboxSleepBodySchema.safeParse(body);
        if (!parsed.success) return context.json({ error: 'invalid_body' }, 400);
        const sleeper = this.deps.sleeper;
        if (!sleeper) return context.json({ error: 'not_found', message: 'This server keeps no sandbox template.' }, 404);
        // Only a sandbox of this Factory, as its list names it.
        const known = (await sleeper.list(scope.projectId)).some(view => view.key === parsed.data.key && view.state !== 'asleep');
        if (!known) return context.json({ error: 'not_found', message: 'No awake sandbox of this Factory by that key.' }, 404);
        const result = await sleeper.sleep(parsed.data.key, 'manual');
        switch (result.outcome) {
          case 'slept':
            return context.json({ outcome: 'slept' });
          case 'active':
            return context.json({ error: 'sandbox_active', message: 'An agent is working in this sandbox; it is never stopped.' }, 409);
          case 'failed':
            return context.json({ error: 'save_failed', message: result.message }, 500);
          default:
            return context.json({ error: 'not_found', message: 'The sandbox is already asleep or gone.' }, 404);
        }
      }),
    ];
  }
}
