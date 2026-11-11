import type { AgentControllerRequestContext } from '@mastra/core/agent-controller';
import type { RequestContext } from '@mastra/core/request-context';

import { getFactoryAuthOrgId, getFactoryAuthUserFromContext } from '@factory/auth';
import type { WorkItemsStorage } from '@factory/store';

import type { McpHubSession } from './hub.ts';

export interface McpSessionCoordinates {
  orgId: string;
  sessionId: string;
  factoryProjectId?: string;
}

/** The session behind a tool request (a Mastra turn, or a Claude Code / Codex call to the Factory MCP endpoint). */
export function mcpSessionCoordinates(requestContext: RequestContext | undefined): McpSessionCoordinates | undefined {
  if (!requestContext || typeof requestContext.get !== 'function') return undefined;
  const controller = requestContext.get('controller') as AgentControllerRequestContext<{ factoryProjectId?: string }> | undefined;
  const orgId = getFactoryAuthOrgId(getFactoryAuthUserFromContext(requestContext));
  if (!controller?.sessionId || !orgId) return undefined;
  const factoryProjectId = controller.getState?.().factoryProjectId;
  return { orgId, sessionId: controller.sessionId, ...(factoryProjectId ? { factoryProjectId } : {}) };
}

/**
 * The scope a session's MCP servers are chosen by: its Factory and, when it works a card, the
 * card's board and phase. A session outside any Factory gets none.
 */
export async function resolveMcpSessionScope(
  coordinates: McpSessionCoordinates | undefined,
  workItems: Pick<WorkItemsStorage, 'listWorkItemIdsForSession' | 'get'> | undefined,
): Promise<McpHubSession | undefined> {
  if (!coordinates?.factoryProjectId) return undefined;
  const base = { orgId: coordinates.orgId, sessionId: coordinates.sessionId, factoryProjectId: coordinates.factoryProjectId };
  if (!workItems) return base;
  const [workItemId] = await workItems.listWorkItemIdsForSession({
    orgId: coordinates.orgId,
    factoryProjectId: coordinates.factoryProjectId,
    sessionId: coordinates.sessionId,
  });
  if (!workItemId) return base;
  const item = await workItems.get({ orgId: coordinates.orgId, id: workItemId });
  if (!item) return base;
  // A card stands in one phase; several (a fan-out) name no single one.
  const phase = item.stages.length === 1 ? item.stages[0] : undefined;
  return { ...base, ...(item.board ? { board: item.board } : {}), ...(phase ? { phase } : {}) };
}
