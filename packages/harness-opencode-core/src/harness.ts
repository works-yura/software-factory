import { isAbsolute, join } from 'node:path';

import type { AgentHarness, AgentRunContext, AgentRunContextInput, AgentSession, AgentSkill, HarnessModels } from '@factory/harness';
import { readSkill } from '@factory/harness-claude-code/skills';

import { OpenCodeSession, type OpenCodeSessionConfig } from './session.ts';

export interface OpenCodeHarnessConfig extends OpenCodeSessionConfig {
  /** Extra skills directories, searched before the session's `<cwd>/.opencode/skills` and `<cwd>/.agents/skills`. */
  skillsDir?: string | string[];
  /** Called once for every session object the harness builds (created or rehydrated), before anyone drives it. */
  onSession?: (session: OpenCodeSession) => void;
  /** The harness's model facet (`createOpenCodeHarnessModels`), exposed as `harness.models`. */
  models?: HarnessModels;
}

/** The context a delivery runs with; a plain map, since OpenCode's tools never read it in-process. */
export class OpenCodeRunContext implements AgentRunContext {
  readonly #values = new Map<string, unknown>();

  get(key: string): unknown {
    return this.#values.get(key);
  }

  set(key: string, value: unknown): this {
    this.#values.set(key, value);
    return this;
  }
}

export interface OpenCodeHarness extends AgentHarness {
  getSession(sessionId: string): Promise<OpenCodeSession | undefined>;
  /** Creates the session, or returns the one already stored under this id. */
  createSession(input: { sessionId: string; threadId: string; resourceId?: string }): Promise<OpenCodeSession>;
  /** Tears a session down for good: stops its run and server, forgets it and removes its record. */
  deleteSession(sessionId: string): Promise<void>;
  /** Gives a session up: it moved to another harness (a context handoff). */
  releaseSession(sessionId: string): Promise<void>;
}

function openCodeSession(session: AgentSession): OpenCodeSession {
  if (!(session instanceof OpenCodeSession)) throw new Error('Not an OpenCode session.');
  return session;
}

/** The OpenCode harness: each Factory session is one OpenCode session, rehydrated from the store on first use in this process. */
export function createOpenCodeHarness(config: OpenCodeHarnessConfig): OpenCodeHarness {
  const sessions = new Map<string, OpenCodeSession>();
  const loading = new Map<string, Promise<OpenCodeSession | undefined>>();

  const load = (sessionId: string): Promise<OpenCodeSession | undefined> => {
    const cached = sessions.get(sessionId);
    if (cached) return Promise.resolve(cached);
    let pending = loading.get(sessionId);
    if (!pending) {
      pending = config.store
        .get(sessionId)
        .then(record => {
          if (!record) return undefined;
          const cached = sessions.get(sessionId);
          if (cached) return cached;
          const session = new OpenCodeSession(record, config);
          sessions.set(sessionId, session);
          try {
            config.onSession?.(session);
          } catch (error) {
            console.warn('[opencode harness] Session observer failed.', error);
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
      await config.store.put({ sessionId, threadId, ...(resourceId ? { resourceId } : {}), threads: {}, updatedAt: new Date().toISOString() });
      return (await load(sessionId))!;
    },

    async deleteSession(sessionId) {
      const session = await load(sessionId);
      if (!session) return;
      session.dispose();
      sessions.delete(sessionId);
      await config.store.delete?.(sessionId);
    },

    async releaseSession(sessionId) {
      const session = await load(sessionId);
      session?.dispose();
      sessions.delete(sessionId);
      if (!config.store.delete) throw new Error('This OpenCode session store cannot give a session up.');
      await config.store.delete(sessionId);
    },

    listActiveThreadRuns() {
      const runs: Array<{ threadId: string; runId?: string; resourceId?: string }> = [];
      for (const session of sessions.values()) {
        if (!session.run.isRunning()) continue;
        const runId = session.runId;
        const resourceId = session.resourceId;
        runs.push({ threadId: session.thread.requireId(), ...(runId ? { runId } : {}), ...(resourceId ? { resourceId } : {}) });
      }
      return runs;
    },

    runContext(agentSession: AgentSession, input: AgentRunContextInput): AgentRunContext {
      const session = openCodeSession(agentSession);
      return new OpenCodeRunContext()
        .set('user', { id: input.userId, organizationId: input.orgId })
        .set('controller', {
          threadId: input.threadId,
          resourceId: input.resourceId,
          session: { id: session.id, openCodeSessionId: session.openCodeSessionId },
        });
    },

    async findSkill(agentSession: AgentSession, name: string): Promise<AgentSkill | undefined> {
      const session = openCodeSession(agentSession);
      const cwd = session.cwd ?? (await config.cwdFor(session.id));
      const extra = [config.skillsDir ?? []].flat().map(dir => (isAbsolute(dir) ? dir : join(cwd, dir)));
      return readSkill([...extra, join(cwd, '.opencode', 'skills'), join(cwd, '.agents', 'skills')], name);
    },
  };
}
