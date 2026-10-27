import type { AgentHarness, AgentRunContext, AgentRunContextInput, AgentSession, AgentSkill } from './contract.ts';

/** A harness that owns some sessions, and how to tell which. */
export interface HarnessRoute {
  harness: AgentHarness;
  /**
   * Whether this harness owns the session. Asked before `getSession`, so a
   * harness whose `getSession` would create or adopt sessions it does not own
   * is never handed one by mistake.
   */
  owns(sessionId: string): Promise<boolean>;
}

/**
 * One harness in front of several: each session goes to the harness that owns
 * it, and anything no route claims goes to `fallback`.
 *
 * A Factory picks its harness when it is created, so every session lives in
 * exactly one of them; the dispatcher keeps taking a single harness and never
 * learns there are two. Routes are asked in order, cheapest first: an owned
 * session is never looked up in the fallback, which keeps a Claude Code session
 * from being resurrected as an empty Mastra one.
 */
export function createRoutingHarness({
  routes,
  fallback,
}: {
  routes: HarnessRoute[];
  fallback: AgentHarness;
}): AgentHarness {
  // The session objects a harness handed out; the contract's other calls take them back.
  const owners = new WeakMap<AgentSession, AgentHarness>();

  const ownerOf = (session: AgentSession): AgentHarness => owners.get(session) ?? fallback;

  return {
    async getSession(sessionId: string): Promise<AgentSession | undefined> {
      let owner = fallback;
      for (const route of routes) {
        if (await route.owns(sessionId)) {
          owner = route.harness;
          break;
        }
      }
      const session = await owner.getSession(sessionId);
      if (session) owners.set(session, owner);
      return session;
    },

    listActiveThreadRuns() {
      return [...routes.map(route => route.harness), fallback].flatMap(harness => harness.listActiveThreadRuns());
    },

    runContext(session: AgentSession, input: AgentRunContextInput): AgentRunContext {
      return ownerOf(session).runContext(session, input);
    },

    findSkill(session: AgentSession, name: string): Promise<AgentSkill | undefined> {
      return ownerOf(session).findSkill(session, name);
    },
  };
}
