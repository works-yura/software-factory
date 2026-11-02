/**
 * The supervisor session's address: one per factory, addressed by a
 * self-describing resourceId so a restarted server can recover its scope
 * without a lookup table. Session access, credentials and tool permissions
 * recognise a supervisor by it; the session itself lives in @factory/supervisor.
 */

const RESOURCE_PREFIX = 'factory-supervisor:';

export function supervisorResourceId(factoryProjectId: string): string {
  return `${RESOURCE_PREFIX}${factoryProjectId}`;
}

/** The supervisor thread shares the session's id: one thread per factory. */
export function supervisorThreadId(factoryProjectId: string): string {
  return supervisorResourceId(factoryProjectId);
}

export function parseSupervisorResourceId(resourceId: string | undefined | null): string | null {
  if (!resourceId?.startsWith(RESOURCE_PREFIX)) return null;
  const factoryProjectId = resourceId.slice(RESOURCE_PREFIX.length);
  return factoryProjectId.length > 0 ? factoryProjectId : null;
}

/**
 * Since @mastra/factory 0.24 sessions are addressed by their own id
 * under the factory resource, so a supervisor may arrive with its marker on
 * either the session id or the resource id.
 */
export function supervisorProjectIdFromContext(
  context: { sessionId?: string | null; resourceId?: string | null } | undefined,
): string | null {
  return parseSupervisorResourceId(context?.sessionId) ?? parseSupervisorResourceId(context?.resourceId);
}
