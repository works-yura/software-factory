import { RequestContext } from '@mastra/core/request-context';

import { localCheckoutPresent, peekSessionSandbox, sessionLayout } from '@factory/sandbox';

/** The workspace a Mastra session gets, as `createWorkspaceFactory` builds it. */
export interface ClaudeSessionWorkspace {
  sandbox?: { provider?: string; start?: () => Promise<void> } | undefined;
  filesystem?: { basePath: string; exists: (path: string) => Promise<boolean> } | undefined;
}

export type ClaudeWorkspaceResolver = (context: {
  requestContext: RequestContext;
}) => Promise<ClaudeSessionWorkspace | undefined>;

interface CheckoutSessions {
  getBySessionId(sessionId: string): Promise<{ orgId: string; userId: string; factoryProjectId: string | null } | null>;
}

/**
 * The session's workspace, resolved as its owner's own Mastra turn would:
 * building it constructs (and memoizes) the session's sandbox, which is cheap
 * and side-effect free; nothing starts until `sandbox.start()`.
 */
async function resolveSessionWorkspace(
  workspaces: ClaudeWorkspaceResolver,
  sessions: CheckoutSessions,
  sessionId: string,
): Promise<ClaudeSessionWorkspace> {
  const row = await sessions.getBySessionId(sessionId);
  if (!row) throw new Error(`Factory session ${sessionId} has no source-control session to check out.`);
  const requestContext = new RequestContext();
  requestContext.set('user', { id: row.userId, organizationId: row.orgId });
  // The workspace pins its checkout in the controller state (`projectPath`); here that state lives for this call.
  const state: Record<string, unknown> = { factoryProjectId: row.factoryProjectId ?? undefined, factoryOrgId: row.orgId };
  requestContext.set('controller', {
    sessionId,
    state,
    getState: () => state,
    setState: async (patch: Record<string, unknown>) => {
      Object.assign(state, patch);
    },
  });
  const workspace = await workspaces({ requestContext });
  if (!workspace?.sandbox || !workspace.filesystem) {
    throw new Error(`Factory session ${sessionId} has no workspace to check out.`);
  }
  return workspace;
}

/**
 * The working directory of a Claude Code session: the very workspace a Mastra
 * session gets (`createWorkspaceFactory`), so both harnesses share one
 * checkout path — the session branch, every repository of the Factory's
 * environment beneath one root, the repositories' and the workspace's setup
 * commands, retirement — and the session's sandbox memo the source-control
 * tools run git in.
 *
 * The CLI runs on this host, so only a local sandbox can hold its cwd; a remote
 * sandbox needs the CLI inside it and is refused here.
 */
export function createClaudeCheckoutResolver({
  workspaces,
  sessions,
}: {
  workspaces: ClaudeWorkspaceResolver;
  sessions: CheckoutSessions;
}): (sessionId: string) => Promise<string> {
  return async sessionId => {
    const workspace = await resolveSessionWorkspace(workspaces, sessions, sessionId);
    if (workspace.sandbox!.provider !== 'local') {
      throw new Error(
        `Claude Code sessions run on this host and need a local sandbox; the '${workspace.sandbox!.provider}' sandbox is not supported yet.`,
      );
    }
    // Starting runs the session's setup: materialize, branch, setup commands, the other repositories.
    await workspace.sandbox!.start?.();
    // The first file operation resolves the workspace root: the checkout, or the root of several.
    await workspace.filesystem!.exists('/');
    const workdir = workspace.filesystem!.basePath;
    if (!workdir) throw new Error(`Factory session ${sessionId} has no working directory.`);
    return workdir;
  };
}

/**
 * Attach a session's local checkout that is already on this host's disk, e.g.
 * after a server restart, before the session's next turn: the session's
 * sandbox is built as its turn would build it (memoized, so that turn reuses
 * it) but not started, so no clone, setup command or network call happens.
 * Resolves true when every repository of the session is a checkout on disk.
 * The file panels then read it (`sessionFilesSandbox`). Only for a local
 * sandbox; the caller wires it only when the Factory's sandbox is local.
 */
export function createLocalCheckoutAttacher({
  workspaces,
  sessions,
}: {
  workspaces: ClaudeWorkspaceResolver;
  sessions: CheckoutSessions;
}): (session: { id: string; sessionId: string }) => Promise<boolean> {
  return async session => {
    if (!peekSessionSandbox(session.id)) {
      const workspace = await resolveSessionWorkspace(workspaces, sessions, session.sessionId);
      if (workspace.sandbox!.provider !== 'local') return false;
    }
    const entry = peekSessionSandbox(session.id);
    if (!entry || entry.sandbox.provider !== 'local') return false;
    const layout = sessionLayout(entry);
    return layout ? localCheckoutPresent(layout) : false;
  };
}
