import { isAbsolute, join } from 'node:path';

import type { AgentHarness, AgentRunContext, AgentRunContextInput, AgentSession, AgentSkill } from '@factory/harness';

import { ClaudeCodeSession, type ClaudeCodeSessionConfig } from './session.ts';
import { readSkill } from './skills.ts';

export interface ClaudeCodeHarnessConfig extends ClaudeCodeSessionConfig {
  /**
   * Extra skills directory, searched before the session's `<cwd>/.claude/skills`.
   * A relative path resolves against the session's cwd.
   */
  skillsDir?: string;
}

/** The context a delivery runs with; a plain map, since Claude Code tools never read it in-process. */
export class ClaudeCodeRunContext implements AgentRunContext {
  readonly #values = new Map<string, unknown>();

  get(key: string): unknown {
    return this.#values.get(key);
  }

  set(key: string, value: unknown): this {
    this.#values.set(key, value);
    return this;
  }
}

export interface ClaudeCodeHarness extends AgentHarness {
  getSession(sessionId: string): Promise<ClaudeCodeSession | undefined>;
  /** Creates the session, or returns the one already stored under this id. */
  createSession(input: { sessionId: string; threadId: string; resourceId?: string }): Promise<ClaudeCodeSession>;
}

function claudeSession(session: AgentSession): ClaudeCodeSession {
  if (!(session instanceof ClaudeCodeSession)) throw new Error('Not a Claude Code session.');
  return session;
}

/**
 * The Claude Code harness: each Factory session is one resumable `claude`
 * session, rehydrated from the store on first use in this process.
 */
export function createClaudeCodeHarness(config: ClaudeCodeHarnessConfig): ClaudeCodeHarness {
  const sessions = new Map<string, ClaudeCodeSession>();
  const loading = new Map<string, Promise<ClaudeCodeSession | undefined>>();

  const load = (sessionId: string): Promise<ClaudeCodeSession | undefined> => {
    const cached = sessions.get(sessionId);
    if (cached) return Promise.resolve(cached);
    // Two concurrent lookups must share one session object, or each would run its own process.
    let pending = loading.get(sessionId);
    if (!pending) {
      pending = config.store
        .get(sessionId)
        .then(record => {
          if (!record) return undefined;
          const session = sessions.get(sessionId) ?? new ClaudeCodeSession(record, config);
          sessions.set(sessionId, session);
          return session;
        })
        .finally(() => loading.delete(sessionId));
      loading.set(sessionId, pending);
    }
    return pending;
  };

  return {
    getSession: load,

    async createSession({ sessionId, threadId, resourceId }) {
      const existing = await load(sessionId);
      if (existing) return existing;
      const record = {
        sessionId,
        threadId,
        ...(resourceId ? { resourceId } : {}),
        threads: {},
        updatedAt: new Date().toISOString(),
      };
      await config.store.put(record);
      return (await load(sessionId))!;
    },

    listActiveThreadRuns() {
      const runs: Array<{ threadId: string; runId?: string; resourceId?: string }> = [];
      for (const session of sessions.values()) {
        if (!session.run.isRunning()) continue;
        const runId = session.runId;
        const resourceId = session.resourceId;
        runs.push({
          threadId: session.thread.requireId(),
          ...(runId ? { runId } : {}),
          ...(resourceId ? { resourceId } : {}),
        });
      }
      return runs;
    },

    runContext(agentSession: AgentSession, input: AgentRunContextInput): AgentRunContext {
      const session = claudeSession(agentSession);
      return new ClaudeCodeRunContext()
        .set('user', { workosId: input.userId, organizationId: input.orgId })
        .set('controller', {
          threadId: input.threadId,
          resourceId: input.resourceId,
          session: { id: session.id, claudeSessionId: session.claudeSessionId },
        });
    },

    async findSkill(agentSession: AgentSession, name: string): Promise<AgentSkill | undefined> {
      const session = claudeSession(agentSession);
      const cwd = session.cwd ?? (await config.cwdFor(session.id));
      const directories = [join(cwd, '.claude', 'skills')];
      if (config.skillsDir) directories.unshift(isAbsolute(config.skillsDir) ? config.skillsDir : join(cwd, config.skillsDir));
      return readSkill(directories, name);
    },
  };
}
