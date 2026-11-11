import type { MiddlewareHandler } from 'hono';

const SESSION_ROUTE = /\/agent-controller\/([^/]+)\/sessions(?:\/([^/]+)(\/.*)?)?\/?$/;

const decode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** The turn-based harnesses, by id, as the refusal names them. */
const TURN_HARNESS_LABELS: Readonly<Record<string, string>> = { 'claude-code': 'Claude Code', codex: 'Codex' };

/**
 * Keeps a turn-based harness's Factory (Claude Code's, Codex's) own id from becoming a Mastra chat. Outside any
 * session the chat addresses the Factory itself (session id = Factory id); on a
 * Mastra Factory that is a Mastra session, but no Claude Code session answers
 * that id, so the request would fall through to the Mastra controller and start
 * a Mastra agent in a Factory that runs on Claude Code. Anything that would
 * create or drive such a session is refused, as the Claude session routes
 * refuse what they do not support; reads pass. A Claude Code Factory's chats are
 * its Claude Code sessions (New session) and its Factory chat (supervisor).
 */
export function createClaudeFactoryChatGuard(options: {
  controllerId: string;
  /** The harness of the Factory with this id; `undefined` when the id names no Factory. */
  factoryHarness: (factoryProjectId: string) => Promise<string | undefined>;
}): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') return next();
    const match = SESSION_ROUTE.exec(c.req.path);
    if (!match || decode(match[1]!) !== options.controllerId) return next();
    let sessionId = match[2] ? decode(match[2]) : undefined;
    if (!sessionId && c.req.method === 'POST') {
      // Read a clone: the route behind reads the raw request, whose body can be read only once.
      const body = (await c.req.raw
        .clone()
        .json()
        .catch(() => ({}))) as { sessionId?: unknown };
      sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
    }
    const harness = sessionId ? await options.factoryHarness(sessionId) : undefined;
    const label = harness ? TURN_HARNESS_LABELS[harness] : undefined;
    if (!label) return next();
    return c.json(
      {
        error: `This Factory runs on ${label}: start a chat with New session, or use the Factory chat. Its own id is not a Mastra session.`,
      },
      409,
    );
  };
}
