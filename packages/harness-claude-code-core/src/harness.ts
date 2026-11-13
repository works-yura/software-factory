import { isAbsolute, join } from 'node:path';

import type { AgentHarness, AgentRunContext, AgentRunContextInput, AgentSession, AgentSkill, HarnessModels } from '@factory/harness';

import { ClaudeCodeSession, type ClaudeCodeSessionConfig } from './session.ts';
import { readSkill } from './skills.ts';

export interface ClaudeCodeHarnessConfig extends ClaudeCodeSessionConfig {
  /**
   * Extra skills directory, searched before the session's `<cwd>/.claude/skills`.
   * A relative path resolves against the session's cwd. A list is searched in order.
   */
  skillsDir?: string | string[];
  /**
   * Called once for every session object the harness builds, whether created
   * or rehydrated from the store, before anyone can drive it: the place to
   * attach observers such as the chat UI's transcript recorder.
   */
  onSession?: (session: ClaudeCodeSession) => void;
  /** The harness's model facet (`createClaudeCodeHarnessModels`), exposed as `harness.models`. */
  models?: HarnessModels;
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
  /**
   * Tears a session down for good, as the controller's `deleteSession` does a
   * Mastra one: stops its run, forgets it in this process and removes its
   * record, so `getSession` no longer finds it (the dispatcher's sweep revokes
   * a binding whose session is gone, ADR-0038). The thread's messages stay in
   * the Factory's memory. A no-op for a session it does not hold.
   */
  deleteSession(sessionId: string): Promise<void>;
  /**
   * Gives a session up: it moved to another harness (a context handoff). Stops its run, forgets it
   * in this process and removes its record, so this harness no longer holds it. A no-op for a
   * session it does not hold.
   */
  releaseSession(sessionId: string): Promise<void>;
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
          const cached = sessions.get(sessionId);
          if (cached) return cached;
          const session = new ClaudeCodeSession(record, config);
          sessions.set(sessionId, session);
          try {
            config.onSession?.(session);
          } catch (error) {
            console.warn('[claude-code harness] Session observer failed.', error);
          }
          return session;
        })
        .finally(() => loading.delete(sessionId));
      loading.set(sessionId, pending);
    }
    return pending;
  };

  return {
    ...(config.models ? { models: config.models } : {}),
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

    async deleteSession(sessionId) {
      const session = await load(sessionId);
      if (!session) return;
      session.abort('delete');
      sessions.delete(sessionId);
      // Left in the store, the next lookup would load it again: a deleted session would still exist.
      await config.store.delete?.(sessionId);
    },

    async releaseSession(sessionId) {
      const session = await load(sessionId);
      session?.abort('release');
      sessions.delete(sessionId);
      if (!config.store.delete) throw new Error('This Claude Code session store cannot give a session up.');
      await config.store.delete(sessionId);
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
        .set('user', { id: input.userId, organizationId: input.orgId })
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
      const extra = [config.skillsDir ?? []].flat().map(dir => (isAbsolute(dir) ? dir : join(cwd, dir)));
      directories.unshift(...extra);
      return readSkill(directories, name);
    },
  };
}
