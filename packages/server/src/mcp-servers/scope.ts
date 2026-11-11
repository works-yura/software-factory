import type { AgentControllerRequestContext } from '@mastra/core/agent-controller';
import type { RequestContext } from '@mastra/core/request-context';

import { getFactoryAuthOrgId, getFactoryAuthUserFromContext } from '@factory/auth';
import { supervisorProjectIdFromContext } from '@factory/session';
import type { WorkItemsStorage } from '@factory/store';

import type { McpHubSession } from './hub.ts';

export interface McpSessionCoordinates {
  orgId: string;
  sessionId: string;
  factoryProjectId?: string;
  /** The session's resource; the Factory chat (supervisor) is recognised by it or by its id. */
  resourceId?: string;
}

/** The session behind a tool request (a Mastra turn, or a Claude Code / Codex call to the Factory MCP endpoint). */
export function mcpSessionCoordinates(requestContext: RequestContext | undefined): McpSessionCoordinates | undefined {
  if (!requestContext || typeof requestContext.get !== 'function') return undefined;
  const controller = requestContext.get('controller') as AgentControllerRequestContext<{ factoryProjectId?: string }> | undefined;
  const orgId = getFactoryAuthOrgId(getFactoryAuthUserFromContext(requestContext));
  if (!controller?.sessionId || !orgId) return undefined;
  const factoryProjectId = controller.getState?.().factoryProjectId;
  const resourceId = (controller as { resourceId?: string }).resourceId;
  return {
    orgId,
    sessionId: controller.sessionId,
    ...(factoryProjectId ? { factoryProjectId } : {}),
    ...(resourceId ? { resourceId } : {}),
  };
}

/**
 * The scope a session's MCP servers are chosen by: its Factory, its kind (the Factory chat, a card
 * session, else a member's own session) and, for a card, its board and phase. A session outside
 * any Factory gets none.
 */
export async function resolveMcpSessionScope(
  coordinates: McpSessionCoordinates | undefined,
  workItems: Pick<WorkItemsStorage, 'listWorkItemIdsForSession' | 'get'> | undefined,
): Promise<McpHubSession | undefined> {
  if (!coordinates?.factoryProjectId) return undefined;
  const ids = { orgId: coordinates.orgId, sessionId: coordinates.sessionId, factoryProjectId: coordinates.factoryProjectId };
  if (supervisorProjectIdFromContext({ sessionId: coordinates.sessionId, resourceId: coordinates.resourceId ?? null })) {
    return { ...ids, kind: 'chat' };
  }
  const base = { ...ids, kind: 'personal' as const };
  if (!workItems) return base;
  const [workItemId] = await workItems.listWorkItemIdsForSession({
    orgId: coordinates.orgId,
    factoryProjectId: coordinates.factoryProjectId,
    sessionId: coordinates.sessionId,
  });
  if (!workItemId) return base;
  const item = await workItems.get({ orgId: coordinates.orgId, id: workItemId });
  // A card session whose card is gone still is not a member's own session: it gets card access only.
  if (!item) return { ...ids, kind: 'card' };
  // A card stands in one phase; several (a fan-out) name no single one.
  const phase = item.stages.length === 1 ? item.stages[0] : undefined;
  return { ...ids, kind: 'card', ...(item.board ? { board: item.board } : {}), ...(phase ? { phase } : {}) };
}
