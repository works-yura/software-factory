import { isAbsolute, join } from 'node:path';

import type { AgentHarness, AgentRunContext, AgentRunContextInput, AgentSession, AgentSkill, HarnessModels } from '@factory/harness';
import { readSkill } from '@factory/harness-claude-code/skills';

import { CodexSession, type CodexSessionConfig } from './session.ts';

export interface CodexHarnessConfig extends CodexSessionConfig {
  /** Extra skills directories, searched before the session's `<cwd>/.codex/skills` and `<cwd>/.agents/skills`. */
  skillsDir?: string | string[];
  /** Called once for every session object the harness builds (created or rehydrated), before anyone drives it. */
  onSession?: (session: CodexSession) => void;
  /** The harness's model facet (`createCodexHarnessModels`), exposed as `harness.models`. */
  models?: HarnessModels;
}

/** The context a delivery runs with; a plain map, since Codex tools never read it in-process. */
export class CodexRunContext implements AgentRunContext {
  readonly #values = new Map<string, unknown>();

  get(key: string): unknown {
    return this.#values.get(key);
  }

  set(key: string, value: unknown): this {
    this.#values.set(key, value);
    return this;
  }
}

export interface CodexHarness extends AgentHarness {
  getSession(sessionId: string): Promise<CodexSession | undefined>;
  /** Creates the session, or returns the one already stored under this id. */
  createSession(input: { sessionId: string; threadId: string; resourceId?: string }): Promise<CodexSession>;
  /** Stops a session's run and forgets it in this process; what it persisted stays. */
  deleteSession(sessionId: string): Promise<void>;
}

function codexSession(session: AgentSession): CodexSession {
  if (!(session instanceof CodexSession)) throw new Error('Not a Codex session.');
  return session;
}

/** The Codex harness: each Factory session is one resumable Codex thread, rehydrated from the store on first use in this process. */
export function createCodexHarness(config: CodexHarnessConfig): CodexHarness {
  const sessions = new Map<string, CodexSession>();
  const loading = new Map<string, Promise<CodexSession | undefined>>();

  const load = (sessionId: string): Promise<CodexSession | undefined> => {
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
          const session = new CodexSession(record, config);
          sessions.set(sessionId, session);
          try {
            config.onSession?.(session);
          } catch (error) {
            console.warn('[codex harness] Session observer failed.', error);
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
      const session = codexSession(agentSession);
      return new CodexRunContext()
        .set('user', { id: input.userId, organizationId: input.orgId })
        .set('controller', {
          threadId: input.threadId,
          resourceId: input.resourceId,
          session: { id: session.id, codexThreadId: session.codexThreadId },
        });
    },

    async findSkill(agentSession: AgentSession, name: string): Promise<AgentSkill | undefined> {
      const session = codexSession(agentSession);
      const cwd = session.cwd ?? (await config.cwdFor(session.id));
      const extra = [config.skillsDir ?? []].flat().map(dir => (isAbsolute(dir) ? dir : join(cwd, dir)));
      return readSkill([...extra, join(cwd, '.codex', 'skills'), join(cwd, '.agents', 'skills')], name);
    },
  };
}
