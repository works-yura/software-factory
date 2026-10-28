import type { VersionControl } from '@factory/capabilities';
import {
  checkoutSessionBranch,
  deriveLocalWorkdir,
  getSessionSandbox,
  materializeRepo,
  requireExec,
} from '@factory/sandbox';
import { mergeRequestNumberFromBranch, pullRequestNumberFromBranch } from '@factory/pipelines';
import type { FactorySandbox } from '@mastra/core/workspace';
import type { FactoryProjectsStorage, SourceControlStorageHandle } from '@factory/store';

export interface ClaudeCheckoutSourceControl {
  id: string;
  versionControl: Pick<VersionControl, 'getRepositoryAccess'>;
  storage: SourceControlStorageHandle;
  gitIdentity?: { name?: string | null; email?: string | null; login?: string | null };
}

/**
 * The working directory of a Claude Code session: its repository checked out
 * on the session branch, materialized the way a Mastra session's workspace
 * does it (`materializeRepo`, `checkoutSessionBranch`) in the session's own
 * sandbox directory, which is shared with the Mastra sandbox memo so session
 * retirement finds and releases it.
 *
 * The CLI runs on this host, so only a local sandbox can hold its cwd; a remote
 * sandbox needs the CLI inside it (the sandbox phase) and is refused here.
 * Repository setup commands are not run yet.
 */
export function createClaudeCheckoutResolver({
  sandbox,
  sourceControls,
  projects,
}: {
  sandbox: FactorySandbox | undefined;
  sourceControls: () => readonly ClaudeCheckoutSourceControl[];
  projects: Pick<FactoryProjectsStorage, 'get'>;
}): (sessionId: string) => Promise<string> {
  return async sessionId => {
    let found:
      | {
          provider: ClaudeCheckoutSourceControl;
          session: NonNullable<Awaited<ReturnType<SourceControlStorageHandle['sessions']['getBySessionId']>>>;
        }
      | undefined;
    for (const provider of sourceControls()) {
      const session = await provider.storage.sessions.getBySessionId(sessionId);
      if (session) {
        found = { provider, session };
        break;
      }
    }
    if (!found) throw new Error(`Factory session ${sessionId} has no source-control session to check out.`);
    const { provider, session } = found;
    if (!sandbox) throw new Error('A sandbox is required to check out a Claude Code session.');
    const storage = provider.storage;
    const link = session.projectRepositoryId
      ? await storage.projectRepositories.get({ orgId: session.orgId, id: session.projectRepositoryId })
      : null;
    const repository = link ? await storage.repositories.get({ orgId: session.orgId, id: link.repositoryId }) : null;
    if (!link || !repository) throw new Error(`Repository link ${session.projectRepositoryId} was not found`);
    const project = session.factoryProjectId
      ? await projects.get({ orgId: session.orgId, id: session.factoryProjectId })
      : null;
    const getRepositoryAccess = () =>
      provider.versionControl.getRepositoryAccess({ orgId: session.orgId, repositoryId: repository.id });
    const entry = getSessionSandbox(session.id, repository.slug, () =>
      sandbox.create(
        {
          sessionId: session.id,
          sandboxId: session.sandboxId ?? undefined,
          repoFullName: repository.slug,
          setupCommand: link.setupCommand ?? undefined,
          getRepositoryAccess,
        },
        project?.sandboxSettings ?? {},
      ),
    );
    // Only a local sandbox has a directory on this host; a remembered workdir of a remote one is a path on another machine.
    const workdir =
      entry.sandbox.provider === 'local' ? (entry.workdir ?? deriveLocalWorkdir(entry.sandbox, repository.slug)) : undefined;
    if (!workdir) {
      throw new Error(
        `Claude Code sessions run on this host and need a local sandbox; the '${entry.sandbox.provider}' sandbox is not supported yet.`,
      );
    }
    await entry.sandbox.start?.();
    const target = requireExec(entry.sandbox);
    const access = await getRepositoryAccess();
    const token = access.authorization?.token;
    if (!token) throw new Error('Repository access did not include a bearer token for the Factory session');
    await materializeRepo({
      row: { id: session.id, sandboxWorkdir: workdir, materializedAt: session.materializedAt },
      repoInfo: {
        repoFullName: repository.slug,
        defaultBranch: repository.defaultBranch,
        cloneUrl: access.cloneUrl,
        authUsername: access.authorization?.username,
      },
      sandbox: target,
      token,
      storage: storage.sessions,
    });
    await checkoutSessionBranch(target, workdir, {
      ...(provider.gitIdentity ? { identity: provider.gitIdentity } : {}),
      branch: session.branch,
      baseBranch: session.baseBranch || link.branch || repository.defaultBranch,
      token,
      repoFullName: repository.slug,
      cloneUrl: access.cloneUrl,
      authUsername: access.authorization?.username,
      pullRequestNumber: pullRequestNumberFromBranch(session.branch),
      mergeRequestNumber: provider.id === 'gitlab' ? mergeRequestNumberFromBranch(session.branch) : undefined,
    });
    return workdir;
  };
}
