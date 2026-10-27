/**
 * Supervisor routes: the per-factory supervisor session address and the
 * deterministic health check the supervisor page pins above its transcript.
 *
 * Mounted from {@link WorkItemRoutes} so they share its tenant + project
 * resolution: a caller can only address a supervisor for a project their org
 * owns.
 */

import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';

import type { BoardRegistry } from '@factory/core';
import type { WorkItemsStorage } from '@factory/store';
import { runFactoryHealthCheck } from '@factory/supervisor';
import { supervisorResourceId, supervisorThreadId } from '@factory/session';
import { FACTORY_ROUTE_CONTRACTS } from '@factory/contracts';

interface SupervisorRouteDependencies {
  workItems: WorkItemsStorage;
  boards: BoardRegistry;
  resolveProject(
    context: unknown,
  ): Promise<{ orgId: string; userId: string; factoryProjectId: string } | { response: Response }>;
}

export function buildSupervisorRoutes(dependencies: SupervisorRouteDependencies): ApiRoute[] {
  const { workItems, boards } = dependencies;
  return [
    // The session is addressed deterministically and created lazily by the
    // agent controller on first reach (see hydrateSupervisorSession), so
    // "ensure" only has to hand back the address once ownership is verified.
    registerApiRoute(FACTORY_ROUTE_CONTRACTS.supervisorSession.path, {
      method: FACTORY_ROUTE_CONTRACTS.supervisorSession.method,
      requiresAuth: false,
      handler: async context => {
        const resolved = await dependencies.resolveProject(context);
        if ('response' in resolved) return resolved.response;
        return context.json({
          sessionId: supervisorResourceId(resolved.factoryProjectId),
          threadId: supervisorThreadId(resolved.factoryProjectId),
          factoryProjectId: resolved.factoryProjectId,
        });
      },
    }),
    registerApiRoute(FACTORY_ROUTE_CONTRACTS.supervisorHealth.path, {
      method: FACTORY_ROUTE_CONTRACTS.supervisorHealth.method,
      requiresAuth: false,
      handler: async context => {
        const resolved = await dependencies.resolveProject(context);
        if ('response' in resolved) return resolved.response;
        await workItems.ensureReady();
        const report = await runFactoryHealthCheck(workItems, boards, resolved);
        return context.json(report);
      },
    }),
  ];
}
