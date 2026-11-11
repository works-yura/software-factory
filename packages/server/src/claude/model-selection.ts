import {
  CLAUDE_CODE_INSTANCE_ID,
  createClaudeCodeHarnessModels,
  type ClaudeCodeHarnessModels,
  type ClaudeCodeSession,
} from '@factory/harness-claude-code';
import type { ModelSelection } from '@factory/harness/models/contracts';
import type { FactoryProject } from '@factory/store';

import { CLAUDE_THREAD_SETTINGS } from './start-coordinator.ts';

/** What a Claude Code turn reads from its Factory: its per-harness model defaults. */
export type ClaudeModelDefaults = Pick<FactoryProject, 'harnessModelDefaults'> | null;

/** A Factory's Claude Code default (`harnessModelDefaults['claude-code']`), as the harness's model facet reads it. */
export function claudeModelDefaults(project: ClaudeModelDefaults): ModelSelection | null {
  return project?.harnessModelDefaults?.[CLAUDE_CODE_INSTANCE_ID] ?? null;
}

/**
 * The Claude Code harness's model facet as a Factory runs it: a session's own pick is a thread
 * setting (`factoryModelSelection`), its default its Factory's Claude Code default, and the
 * selection a turn ran is remembered (`factoryLastModelSelection`) so the turn after a switch
 * carries the `modelSwitch` marker (the chat's "Opus High → Sonnet Medium" divider).
 */
export function claudeFactoryHarnessModels(options: {
  owns(sessionId: string): Promise<boolean>;
  getSession(sessionId: string): Promise<ClaudeCodeSession | undefined>;
  defaultsFor(session: ClaudeCodeSession): Promise<ClaudeModelDefaults>;
  factoryDefaults?(factoryProjectId: string, orgId: string): Promise<ClaudeModelDefaults>;
}): ClaudeCodeHarnessModels<ClaudeCodeSession> {
  const factoryDefaults = options.factoryDefaults;
  return createClaudeCodeHarnessModels<ClaudeCodeSession>({
    owns: options.owns,
    getSession: options.getSession,
    defaults: async session => claudeModelDefaults(await options.defaultsFor(session)),
    ...(factoryDefaults
      ? {
          factoryDefaults: async ctx =>
            ctx.factoryProjectId ? claudeModelDefaults(await factoryDefaults(ctx.factoryProjectId, ctx.viewer.orgId)) : null,
        }
      : {}),
    settingKeys: {
      selection: CLAUDE_THREAD_SETTINGS.modelSelection,
      lastSelection: CLAUDE_THREAD_SETTINGS.lastModelSelection,
    },
  });
}
