import type { ClaudeToolCategory, ClaudeToolPermissions, ClaudeToolPolicy } from '@factory/harness-claude-code';
import { CLAUDE_TOOL_CATEGORIES } from '@factory/harness-claude-code';

import type { FactoryToolPermissions } from '@factory/store';

import type { ClaudeFactoryPermissionsHook } from './harness.ts';

/** The slice of the Factory's own agent-controller session the permissions are read from. */
export interface FactorySettingsSession {
  state: { get(): unknown };
}

const POLICIES: readonly ClaudeToolPolicy[] = ['allow', 'ask', 'deny'];

/** Where a Factory's settings are kept, for when its session is not in memory. */
export interface FactoryToolPermissionsStore {
  get(input: { orgId: string; id: string }): Promise<{ toolPermissions: FactoryToolPermissions | null } | null>;
}

/**
 * The Factory's tool permissions as Settings → Behavior writes them, read from
 * the Factory's stored copy first: Claude Code's Behavior settings write it
 * directly, and Mastra's (the Factory's own agent-controller session, whose id
 * is the Factory id, keeps `permissionRules.categories` and `yolo` in memory)
 * copy theirs there through `persistFactoryToolPermissions`. A Factory with no
 * stored copy yet falls back to that session's state; with neither, every
 * category asks.
 */
export function createFactoryToolPermissions(
  getSession: (sessionId: string) => Promise<FactorySettingsSession | undefined>,
  projects?: FactoryToolPermissionsStore,
): ClaudeFactoryPermissionsHook {
  return async ({ orgId, factoryProjectId }) => {
    const stored = await storedPermissions(projects, orgId, factoryProjectId);
    if (stored) return stored;
    const session = await getSession(factoryProjectId).catch(() => undefined);
    const state = session?.state.get() as
      | { factoryOrgId?: unknown; yolo?: unknown; permissionRules?: { categories?: Record<string, unknown> } }
      | undefined;
    if (!state) return undefined;
    // Never another organization's settings, should ids ever collide.
    if (typeof state.factoryOrgId === 'string' && state.factoryOrgId !== orgId) return undefined;
    return toPermissions(state.permissionRules?.categories, state.yolo === true);
  };
}

async function storedPermissions(
  projects: FactoryToolPermissionsStore | undefined,
  orgId: string,
  factoryProjectId: string,
): Promise<ClaudeToolPermissions | undefined> {
  // Scoped by organization: another organization's Factory reads as missing.
  const project = await projects?.get({ orgId, id: factoryProjectId }).catch(() => null);
  const stored = project?.toolPermissions;
  return stored ? toPermissions(stored.categories, stored.yolo) : undefined;
}

function toPermissions(source: Record<string, unknown> | undefined, yolo: boolean): ClaudeToolPermissions {
  const categories: Partial<Record<ClaudeToolCategory, ClaudeToolPolicy>> = {};
  for (const category of CLAUDE_TOOL_CATEGORIES) {
    const policy = source?.[category];
    if (POLICIES.includes(policy as ClaudeToolPolicy)) categories[category] = policy as ClaudeToolPolicy;
  }
  const permissions: ClaudeToolPermissions = { categories };
  if (yolo) permissions.yolo = true;
  return permissions;
}
