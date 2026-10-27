import type { IntegrationTools } from '@factory/integrations';
import { createFactoryApprovalTools } from './approval-tools.ts';
import type { FactoryApprovalToolDependencies } from './approval-tools.ts';
import { createFactoryMessagingTools } from './messaging-tools.ts';
import type { FactoryMessagingToolDependencies } from './messaging-tools.ts';
import { createFactoryReadTools } from './read-tools.ts';
import type { FactoryReadToolDependencies } from './read-tools.ts';
import type { FactoryToolScope } from './scope.ts';
import { createFactorySessionTools } from './session-tools.ts';
import type { FactorySessionToolDependencies } from './session-tools.ts';
import { createFactoryWorkItemTools } from './work-item-tools.ts';
import type { FactoryWorkItemToolDependencies } from './work-item-tools.ts';

export { FACTORY_TOOLS_WITHOUT_APPROVAL, applyFactoryToolPermissions } from './permissions.ts';
export { FACTORY_INTERACTIVE_KEY, resolveFactoryToolScope } from './scope.ts';
export type { FactoryToolScope } from './scope.ts';

/** Storage and services the Factory tools act through. */
export type FactoryToolDependencies = FactoryReadToolDependencies &
  FactoryWorkItemToolDependencies &
  FactoryMessagingToolDependencies &
  FactorySessionToolDependencies &
  FactoryApprovalToolDependencies;

export interface CreateFactoryToolsOptions {
  scope: FactoryToolScope;
  deps: FactoryToolDependencies;
}

/**
 * The Factory toolset for a resolved scope. Tools take scope and storage by
 * closure and never read the request context, so a non-session transport
 * (an MCP server) can mount the same set with a scope it resolved itself.
 *
 * Worker and side sessions only answer messages. User sessions get every tool
 * on every turn. Turns nobody signed in started (notification wakes, webhooks,
 * dispatcher notices) carry text other people wrote, so each tool limits what
 * it does on them itself: approvals, proposals, plan pre-approval and muting
 * side sessions need a person, moves run as an agent, model switches reach
 * only this session and its side sessions, and starts are side sessions only.
 */
export function createFactoryTools({ scope, deps }: CreateFactoryToolsOptions): IntegrationTools {
  const messagingTools = createFactoryMessagingTools(scope, deps);
  if (scope.kind !== 'user') return messagingTools;
  return {
    ...createFactoryReadTools(scope, deps),
    ...messagingTools,
    ...createFactoryWorkItemTools(scope, deps),
    ...createFactorySessionTools(scope, deps),
    ...createFactoryApprovalTools(scope, deps),
  };
}
