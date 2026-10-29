import type { AgentControllerEvent } from '@mastra/core/agent-controller';

import type { FactoryProjectsStorage, FactoryToolPermissions } from '@factory/store';
import { parseFactoryToolPermissions } from '@factory/store';

import { parseSupervisorResourceId } from './supervisor-session.ts';

export interface ToolPermissionsSession {
  readonly identity: { getId(): string; getResourceId(): string };
  readonly state: { get(): unknown; set(updates: Record<string, unknown>): Promise<unknown> };
  subscribe(listener: (event: AgentControllerEvent) => void): () => void;
}

type ToolPermissionsProjects = Pick<FactoryProjectsStorage, 'getById' | 'update'>;

interface PermissionState {
  permissionRules?: { categories?: Record<string, unknown>; tools?: Record<string, unknown> };
  yolo?: unknown;
}

/** The settings the session's state holds, as the Factory stores them. */
function fromState(state: unknown): FactoryToolPermissions {
  const { permissionRules, yolo } = (state ?? {}) as PermissionState;
  return parseFactoryToolPermissions({ categories: permissionRules?.categories ?? {}, yolo }) ?? { categories: {}, yolo: false };
}

/**
 * Keeps a Factory's tool permissions (Settings → Behavior) across restarts.
 * The agent controller holds them only in the session's memory, so on every
 * (re)creation of a Factory session the stored settings are put back into its
 * state, and every later change in the session is written to the Factory.
 * Returns the unsubscribe; sessions that belong to no Factory are left alone.
 */
export async function persistFactoryToolPermissions(
  session: ToolPermissionsSession,
  deps: { projects: ToolPermissionsProjects },
): Promise<() => void> {
  const factoryProjectId =
    parseSupervisorResourceId(session.identity.getId()) ??
    parseSupervisorResourceId(session.identity.getResourceId()) ??
    // The Factory's own session carries the Factory's id as its own.
    session.identity.getId();
  const project = await deps.projects.getById({ id: factoryProjectId });
  if (!project) return () => {};

  const stored = project.toolPermissions;
  if (stored) {
    const current = (session.state.get() ?? {}) as PermissionState;
    await session.state.set({
      permissionRules: { categories: { ...stored.categories }, tools: { ...(current.permissionRules?.tools ?? {}) } },
      yolo: stored.yolo,
    });
  }

  let last = JSON.stringify(fromState(session.state.get()));
  let writes = Promise.resolve();
  return session.subscribe(event => {
    if (event.type !== 'state_changed') return;
    if (!event.changedKeys.some(key => key === 'permissionRules' || key === 'yolo')) return;
    const next = fromState(event.state);
    const serialized = JSON.stringify(next);
    if (serialized === last) return;
    last = serialized;
    // In order, so an older write never lands after a newer one.
    writes = writes
      .then(() => deps.projects.update({ orgId: project.orgId, id: project.id, input: { toolPermissions: next } }))
      .then(
        () => undefined,
        error => console.warn('[Factory tool permissions] Unable to keep the Factory’s tool permissions.', error),
      );
  });
}
