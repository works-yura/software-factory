import type { ClaudeToolCategory, ClaudeToolPermissions, ClaudeToolPolicy } from '@factory/harness-claude-code';
import { CLAUDE_TOOL_CATEGORIES } from '@factory/harness-claude-code';

import type { ClaudeFactoryPermissionsHook } from './harness.ts';

/** The slice of the Factory's own agent-controller session the permissions are read from. */
export interface FactorySettingsSession {
  state: { get(): unknown };
}

const POLICIES: readonly ClaudeToolPolicy[] = ['allow', 'ask', 'deny'];

/**
 * The Factory's tool permissions as Settings → Behavior writes them: the
 * Factory's own agent-controller session (its id is the Factory id) keeps
 * them in its state, `permissionRules.categories` and `yolo` (auto-approve).
 * They live in memory, so after a restart (or before anyone opened the
 * Factory) there is no session and every category asks.
 */
export function createFactoryToolPermissions(
  getSession: (sessionId: string) => Promise<FactorySettingsSession | undefined>,
): ClaudeFactoryPermissionsHook {
  return async ({ orgId, factoryProjectId }) => {
    const session = await getSession(factoryProjectId).catch(() => undefined);
    const state = session?.state.get() as
      | { factoryOrgId?: unknown; yolo?: unknown; permissionRules?: { categories?: Record<string, unknown> } }
      | undefined;
    if (!state) return undefined;
    // Never another organization's settings, should ids ever collide.
    if (typeof state.factoryOrgId === 'string' && state.factoryOrgId !== orgId) return undefined;
    const categories: Partial<Record<ClaudeToolCategory, ClaudeToolPolicy>> = {};
    for (const category of CLAUDE_TOOL_CATEGORIES) {
      const policy = state.permissionRules?.categories?.[category];
      if (POLICIES.includes(policy as ClaudeToolPolicy)) categories[category] = policy as ClaudeToolPolicy;
    }
    const permissions: ClaudeToolPermissions = { categories };
    if (state.yolo === true) permissions.yolo = true;
    return permissions;
  };
}
