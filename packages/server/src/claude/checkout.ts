import { RequestContext } from '@mastra/core/request-context';

/** The workspace a Mastra session gets, as `createWorkspaceFactory` builds it. */
export interface ClaudeSessionWorkspace {
  sandbox?: { provider?: string; start?: () => Promise<void> } | undefined;
  filesystem?: { basePath: string; exists: (path: string) => Promise<boolean> } | undefined;
}

export type ClaudeWorkspaceResolver = (context: {
  requestContext: RequestContext;
}) => Promise<ClaudeSessionWorkspace | undefined>;

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
  sessions: {
    getBySessionId(
      sessionId: string,
    ): Promise<{ orgId: string; userId: string; factoryProjectId: string | null } | null>;
  };
}): (sessionId: string) => Promise<string> {
  return async sessionId => {
    const row = await sessions.getBySessionId(sessionId);
    if (!row) throw new Error(`Factory session ${sessionId} has no source-control session to check out.`);
    // The workspace resolves as the session's owner, the way their own Mastra turn would.
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
    if (workspace.sandbox.provider !== 'local') {
      throw new Error(
        `Claude Code sessions run on this host and need a local sandbox; the '${workspace.sandbox.provider}' sandbox is not supported yet.`,
      );
    }
    // Starting runs the session's setup: materialize, branch, setup commands, the other repositories.
    await workspace.sandbox.start?.();
    // The first file operation resolves the workspace root: the checkout, or the root of several.
    await workspace.filesystem.exists('/');
    const workdir = workspace.filesystem.basePath;
    if (!workdir) throw new Error(`Factory session ${sessionId} has no working directory.`);
    return workdir;
  };
}
