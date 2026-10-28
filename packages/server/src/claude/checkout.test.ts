import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __clearSessionSandboxesForTests, checkoutSessionBranch, materializeRepo } from '@factory/sandbox';

import { createClaudeCheckoutResolver } from './checkout.ts';
import type { ClaudeCheckoutSourceControl } from './checkout.ts';

// The git work itself (clone, branch checkout) is covered in @factory/sandbox; here it is
// replaced so the resolver's choices — which repo, which branch, where — can be asserted.
vi.mock('@factory/sandbox', async importOriginal => {
  const actual = await importOriginal<typeof import('@factory/sandbox')>();
  return { ...actual, materializeRepo: vi.fn(async () => {}), checkoutSessionBranch: vi.fn(async () => {}) };
});

const ROOT = '/sandboxes/row-1';

interface SessionRow {
  id: string;
  sessionId: string;
  orgId: string;
  userId: string;
  factoryProjectId: string | null;
  projectRepositoryId: string | null;
  branch: string;
  baseBranch: string;
  sandboxId: string | null;
  materializedAt: Date | null;
}

function sessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'row-1',
    sessionId: 'session-1',
    orgId: 'org-1',
    userId: 'user-1',
    factoryProjectId: 'factory-1',
    projectRepositoryId: 'link-1',
    branch: 'factory/work-1',
    baseBranch: 'develop',
    sandboxId: 'vm-1',
    materializedAt: null,
    ...overrides,
  };
}

interface FakeOptions {
  id?: string;
  sessions?: Record<string, SessionRow>;
  links?: Record<string, { orgId: string; repositoryId: string; branch: string | null; setupCommand: string | null }>;
  repositories?: Record<string, { orgId: string; id: string; slug: string; defaultBranch: string }>;
  access?: { cloneUrl?: string; authorization?: { token?: string; username?: string } };
  gitIdentity?: ClaudeCheckoutSourceControl['gitIdentity'];
}

function sourceControl(options: FakeOptions = {}) {
  const sessions = options.sessions ?? {};
  const links = options.links ?? {
    'link-1': { orgId: 'org-1', repositoryId: 'repo-1', branch: 'release', setupCommand: 'pnpm install' },
  };
  const repositories = options.repositories ?? {
    'repo-1': { orgId: 'org-1', id: 'repo-1', slug: 'acme/widgets', defaultBranch: 'main' },
  };
  const access = options.access ?? {
    cloneUrl: 'https://git.test/acme/widgets.git',
    authorization: { token: 'repo-token', username: 'x-access-token' },
  };
  const sessionsStorage = { getBySessionId: vi.fn(async (id: string) => sessions[id] ?? null) };
  const projectRepositories = {
    get: vi.fn(async ({ orgId, id }: { orgId: string; id: string }) => {
      const link = links[id];
      return link && link.orgId === orgId ? { id, ...link } : null;
    }),
  };
  const repositoriesStorage = {
    get: vi.fn(async ({ orgId, id }: { orgId: string; id: string }) => {
      const repository = repositories[id];
      return repository && repository.orgId === orgId ? repository : null;
    }),
  };
  const getRepositoryAccess = vi.fn(async (_input: { orgId: string; repositoryId: string }) => access);
  const provider = {
    id: options.id ?? 'github',
    versionControl: { getRepositoryAccess },
    storage: { sessions: sessionsStorage, projectRepositories, repositories: repositoriesStorage },
    ...(options.gitIdentity ? { gitIdentity: options.gitIdentity } : {}),
  } as unknown as ClaudeCheckoutSourceControl;
  return { provider, sessionsStorage, projectRepositories, repositoriesStorage, getRepositoryAccess };
}

function fakeSandbox(options: { provider?: string; workingDirectory?: string; exec?: boolean } = {}) {
  const started = vi.fn(async () => {});
  const instance = {
    id: 'sandbox-1',
    provider: options.provider ?? 'local',
    workingDirectory: 'workingDirectory' in options ? options.workingDirectory : ROOT,
    start: started,
    ...(options.exec === false ? {} : { executeCommand: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })) }),
  };
  const create = vi.fn((_ctx: Record<string, unknown>, _settings: Record<string, unknown>) => instance);
  return { sandbox: { create } as never, create, instance, started };
}

function projectsStore(projects: Record<string, { orgId: string; sandboxSettings: Record<string, unknown> | null }> = {}) {
  return {
    get: vi.fn(async ({ orgId, id }: { orgId: string; id: string }) => {
      const project = projects[id];
      return project && project.orgId === orgId ? ({ id, ...project } as never) : null;
    }),
  };
}

const materialize = vi.mocked(materializeRepo);
const checkout = vi.mocked(checkoutSessionBranch);

describe('createClaudeCheckoutResolver', () => {
  beforeEach(() => {
    __clearSessionSandboxesForTests();
    materialize.mockClear();
    checkout.mockClear();
  });
  afterEach(() => __clearSessionSandboxesForTests());

  it('checks out the session’s repository on its branch in its own local sandbox', async () => {
    const other = sourceControl({ id: 'gitlab' });
    const owner = sourceControl({
      sessions: { 'session-1': sessionRow() },
      gitIdentity: { name: 'Factory Bot', email: 'bot@factory.test' },
    });
    const box = fakeSandbox();
    const projects = projectsStore({ 'factory-1': { orgId: 'org-1', sandboxSettings: { image: 'node-22' } } });
    const resolve = createClaudeCheckoutResolver({
      sandbox: box.sandbox,
      sourceControls: () => [other.provider, owner.provider],
      projects,
    });

    const workdir = await resolve('session-1');

    expect(workdir).toBe(`${ROOT}/widgets`);
    expect(other.sessionsStorage.getBySessionId).toHaveBeenCalledWith('session-1');
    expect(owner.projectRepositories.get).toHaveBeenCalledWith({ orgId: 'org-1', id: 'link-1' });
    expect(owner.repositoriesStorage.get).toHaveBeenCalledWith({ orgId: 'org-1', id: 'repo-1' });
    expect(projects.get).toHaveBeenCalledWith({ orgId: 'org-1', id: 'factory-1' });

    expect(box.create).toHaveBeenCalledTimes(1);
    const [ctx, settings] = box.create.mock.calls[0]!;
    expect(ctx).toMatchObject({
      sessionId: 'row-1',
      sandboxId: 'vm-1',
      repoFullName: 'acme/widgets',
      setupCommand: 'pnpm install',
    });
    expect(settings).toEqual({ image: 'node-22' });
    // The access callback handed to the sandbox is scoped to this session's org and repository.
    await (ctx.getRepositoryAccess as () => Promise<unknown>)();
    expect(owner.getRepositoryAccess).toHaveBeenLastCalledWith({ orgId: 'org-1', repositoryId: 'repo-1' });
    expect(other.getRepositoryAccess).not.toHaveBeenCalled();

    expect(box.started).toHaveBeenCalledTimes(1);
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(materialize.mock.calls[0]![0]).toMatchObject({
      row: { id: 'row-1', sandboxWorkdir: `${ROOT}/widgets`, materializedAt: null },
      repoInfo: {
        repoFullName: 'acme/widgets',
        defaultBranch: 'main',
        cloneUrl: 'https://git.test/acme/widgets.git',
        authUsername: 'x-access-token',
      },
      sandbox: box.instance,
      token: 'repo-token',
      storage: owner.sessionsStorage,
    });

    expect(checkout).toHaveBeenCalledTimes(1);
    const [target, dir, branchOptions] = checkout.mock.calls[0]!;
    expect(target).toBe(box.instance);
    expect(dir).toBe(`${ROOT}/widgets`);
    expect(branchOptions).toEqual({
      identity: { name: 'Factory Bot', email: 'bot@factory.test' },
      branch: 'factory/work-1',
      baseBranch: 'develop',
      token: 'repo-token',
      repoFullName: 'acme/widgets',
      cloneUrl: 'https://git.test/acme/widgets.git',
      authUsername: 'x-access-token',
      pullRequestNumber: undefined,
      mergeRequestNumber: undefined,
    });
    expect(materialize.mock.invocationCallOrder[0]!).toBeLessThan(checkout.mock.invocationCallOrder[0]!);
  });

  it('stops at the first source control that knows the session', async () => {
    const first = sourceControl({ sessions: { 'session-1': sessionRow() } });
    const second = sourceControl({ id: 'gitlab', sessions: { 'session-1': sessionRow() } });
    const resolve = createClaudeCheckoutResolver({
      sandbox: fakeSandbox().sandbox,
      sourceControls: () => [first.provider, second.provider],
      projects: projectsStore(),
    });
    await resolve('session-1');
    expect(second.sessionsStorage.getBySessionId).not.toHaveBeenCalled();
    expect(first.getRepositoryAccess).toHaveBeenCalled();
  });

  it('reads the source controls on every call, so a provider registered later is found', async () => {
    const providers: ClaudeCheckoutSourceControl[] = [];
    const resolve = createClaudeCheckoutResolver({
      sandbox: fakeSandbox().sandbox,
      sourceControls: () => providers,
      projects: projectsStore(),
    });
    await expect(resolve('session-1')).rejects.toThrow(/has no source-control session/);
    providers.push(sourceControl({ sessions: { 'session-1': sessionRow() } }).provider);
    await expect(resolve('session-1')).resolves.toBe(`${ROOT}/widgets`);
  });

  it('refuses a session no source control knows, before touching any sandbox', async () => {
    const box = fakeSandbox();
    const resolve = createClaudeCheckoutResolver({
      sandbox: box.sandbox,
      sourceControls: () => [sourceControl().provider],
      projects: projectsStore(),
    });
    await expect(resolve('session-unknown')).rejects.toThrow(
      'Factory session session-unknown has no source-control session to check out.',
    );
    expect(box.create).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
  });

  it('needs a sandbox', async () => {
    const owner = sourceControl({ sessions: { 'session-1': sessionRow() } });
    const resolve = createClaudeCheckoutResolver({
      sandbox: undefined,
      sourceControls: () => [owner.provider],
      projects: projectsStore(),
    });
    await expect(resolve('session-1')).rejects.toThrow('A sandbox is required to check out a Claude Code session.');
    expect(owner.getRepositoryAccess).not.toHaveBeenCalled();
  });

  it('refuses a session with no repository link', async () => {
    const owner = sourceControl({ sessions: { 'session-1': sessionRow({ projectRepositoryId: null }) } });
    const box = fakeSandbox();
    const resolve = createClaudeCheckoutResolver({
      sandbox: box.sandbox,
      sourceControls: () => [owner.provider],
      projects: projectsStore(),
    });
    await expect(resolve('session-1')).rejects.toThrow('Repository link null was not found');
    expect(owner.projectRepositories.get).not.toHaveBeenCalled();
    expect(box.create).not.toHaveBeenCalled();
  });

  it('refuses a repository link that is missing or belongs to another org', async () => {
    const owner = sourceControl({
      sessions: { 'session-1': sessionRow({ projectRepositoryId: 'link-foreign' }) },
      links: { 'link-foreign': { orgId: 'org-2', repositoryId: 'repo-1', branch: null, setupCommand: null } },
    });
    const box = fakeSandbox();
    const resolve = createClaudeCheckoutResolver({
      sandbox: box.sandbox,
      sourceControls: () => [owner.provider],
      projects: projectsStore(),
    });
    await expect(resolve('session-1')).rejects.toThrow('Repository link link-foreign was not found');
    expect(owner.repositoriesStorage.get).not.toHaveBeenCalled();
    expect(box.create).not.toHaveBeenCalled();
  });

  it('refuses a link whose repository is missing or belongs to another org', async () => {
    const owner = sourceControl({
      sessions: { 'session-1': sessionRow() },
      repositories: { 'repo-1': { orgId: 'org-2', id: 'repo-1', slug: 'other/secret', defaultBranch: 'main' } },
    });
    const box = fakeSandbox();
    const resolve = createClaudeCheckoutResolver({
      sandbox: box.sandbox,
      sourceControls: () => [owner.provider],
      projects: projectsStore(),
    });
    await expect(resolve('session-1')).rejects.toThrow('Repository link link-1 was not found');
    expect(owner.repositoriesStorage.get).toHaveBeenCalledWith({ orgId: 'org-1', id: 'repo-1' });
    expect(box.create).not.toHaveBeenCalled();
    expect(owner.getRepositoryAccess).not.toHaveBeenCalled();
  });

  it('uses default sandbox settings when the session has no factory or its factory is gone', async () => {
    for (const row of [sessionRow({ factoryProjectId: null }), sessionRow({ factoryProjectId: 'factory-gone' })]) {
      __clearSessionSandboxesForTests();
      const projects = projectsStore({ 'factory-gone': { orgId: 'org-2', sandboxSettings: { image: 'foreign' } } });
      const box = fakeSandbox();
      const resolve = createClaudeCheckoutResolver({
        sandbox: box.sandbox,
        sourceControls: () => [sourceControl({ sessions: { 'session-1': row } }).provider],
        projects,
      });
      await expect(resolve('session-1')).resolves.toBe(`${ROOT}/widgets`);
      expect(box.create.mock.calls[0]![1]).toEqual({});
      if (row.factoryProjectId === null) expect(projects.get).not.toHaveBeenCalled();
      else expect(projects.get).toHaveBeenCalledWith({ orgId: 'org-1', id: 'factory-gone' });
    }
  });

  it('passes no sandbox id or setup command when the session and link have none', async () => {
    const owner = sourceControl({
      sessions: { 'session-1': sessionRow({ sandboxId: null }) },
      links: { 'link-1': { orgId: 'org-1', repositoryId: 'repo-1', branch: null, setupCommand: null } },
    });
    const box = fakeSandbox();
    const resolve = createClaudeCheckoutResolver({
      sandbox: box.sandbox,
      sourceControls: () => [owner.provider],
      projects: projectsStore(),
    });
    await resolve('session-1');
    const ctx = box.create.mock.calls[0]![0];
    expect(ctx.sandboxId).toBeUndefined();
    expect(ctx.setupCommand).toBeUndefined();
  });

  it('bases the branch on the session’s base, then the link’s branch, then the default branch', async () => {
    const cases = [
      { baseBranch: 'develop', linkBranch: 'release', expected: 'develop' },
      { baseBranch: '', linkBranch: 'release', expected: 'release' },
      { baseBranch: '', linkBranch: null, expected: 'main' },
    ];
    for (const { baseBranch, linkBranch, expected } of cases) {
      __clearSessionSandboxesForTests();
      checkout.mockClear();
      const owner = sourceControl({
        sessions: { 'session-1': sessionRow({ baseBranch }) },
        links: { 'link-1': { orgId: 'org-1', repositoryId: 'repo-1', branch: linkBranch, setupCommand: null } },
      });
      const resolve = createClaudeCheckoutResolver({
        sandbox: fakeSandbox().sandbox,
        sourceControls: () => [owner.provider],
        projects: projectsStore(),
      });
      await resolve('session-1');
      expect(checkout.mock.calls[0]![2].baseBranch).toBe(expected);
    }
  });

  it('resumes a pull request branch with its number, and a merge request only on GitLab', async () => {
    const run = async (id: string, branch: string) => {
      __clearSessionSandboxesForTests();
      checkout.mockClear();
      const owner = sourceControl({ id, sessions: { 'session-1': sessionRow({ branch }) } });
      const resolve = createClaudeCheckoutResolver({
        sandbox: fakeSandbox().sandbox,
        sourceControls: () => [owner.provider],
        projects: projectsStore(),
      });
      await resolve('session-1');
      const { branch: checkedOut, pullRequestNumber, mergeRequestNumber } = checkout.mock.calls[0]![2];
      return { checkedOut, pullRequestNumber, mergeRequestNumber };
    };
    await expect(run('github', 'factory/pr-42')).resolves.toEqual({
      checkedOut: 'factory/pr-42',
      pullRequestNumber: 42,
      mergeRequestNumber: undefined,
    });
    await expect(run('gitlab', 'factory/gitlab-mr-7-abc123')).resolves.toEqual({
      checkedOut: 'factory/gitlab-mr-7-abc123',
      pullRequestNumber: undefined,
      mergeRequestNumber: 7,
    });
    await expect(run('github', 'factory/gitlab-mr-7-abc123')).resolves.toMatchObject({
      mergeRequestNumber: undefined,
    });
  });

  it('omits the git identity when the provider has none', async () => {
    const owner = sourceControl({ sessions: { 'session-1': sessionRow() } });
    const resolve = createClaudeCheckoutResolver({
      sandbox: fakeSandbox().sandbox,
      sourceControls: () => [owner.provider],
      projects: projectsStore(),
    });
    await resolve('session-1');
    expect(checkout.mock.calls[0]![2]).not.toHaveProperty('identity');
  });

  it('refuses a remote sandbox, since the CLI runs on this host', async () => {
    const owner = sourceControl({ sessions: { 'session-1': sessionRow() } });
    const box = fakeSandbox({ provider: 'e2b', workingDirectory: '/home/user' });
    const resolve = createClaudeCheckoutResolver({
      sandbox: box.sandbox,
      sourceControls: () => [owner.provider],
      projects: projectsStore(),
    });
    await expect(resolve('session-1')).rejects.toThrow(
      "Claude Code sessions run on this host and need a local sandbox; the 'e2b' sandbox is not supported yet.",
    );
    expect(box.started).not.toHaveBeenCalled();
    expect(owner.getRepositoryAccess).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
  });

  it('refuses a local sandbox with no working directory', async () => {
    const box = fakeSandbox({ workingDirectory: undefined });
    const resolve = createClaudeCheckoutResolver({
      sandbox: box.sandbox,
      sourceControls: () => [sourceControl({ sessions: { 'session-1': sessionRow() } }).provider],
      projects: projectsStore(),
    });
    await expect(resolve('session-1')).rejects.toThrow(/need a local sandbox; the 'local' sandbox/);
    expect(box.started).not.toHaveBeenCalled();
  });

  // The Mastra side may already have resolved (and memoized) a remote VM's workdir for this session.
  it('refuses a remote sandbox even when its workdir was already memoized', async () => {
    const { getSessionSandbox, resolveSessionWorkdir } = await import('@factory/sandbox');
    const box = fakeSandbox({ provider: 'e2b', workingDirectory: '/home/user' });
    const entry = getSessionSandbox('row-1', 'acme/widgets', () => box.instance as never);
    await resolveSessionWorkdir('row-1', entry.sandbox, 'acme/widgets');
    expect(entry.workdir).toBe('/home/user/widgets');

    const owner = sourceControl({ sessions: { 'session-1': sessionRow() } });
    const resolve = createClaudeCheckoutResolver({
      sandbox: box.sandbox,
      sourceControls: () => [owner.provider],
      projects: projectsStore(),
    });
    await expect(resolve('session-1')).rejects.toThrow(/need a local sandbox/);
  });

  it('refuses a sandbox that cannot run commands', async () => {
    const box = fakeSandbox({ exec: false });
    const resolve = createClaudeCheckoutResolver({
      sandbox: box.sandbox,
      sourceControls: () => [sourceControl({ sessions: { 'session-1': sessionRow() } }).provider],
      projects: projectsStore(),
    });
    await expect(resolve('session-1')).rejects.toThrow(/does not support executeCommand/);
    expect(materialize).not.toHaveBeenCalled();
  });

  it('refuses repository access without a bearer token, before cloning', async () => {
    for (const access of [{ cloneUrl: 'https://git.test/x.git' }, { authorization: { username: 'u' } }]) {
      __clearSessionSandboxesForTests();
      const resolve = createClaudeCheckoutResolver({
        sandbox: fakeSandbox().sandbox,
        sourceControls: () => [sourceControl({ access, sessions: { 'session-1': sessionRow() } }).provider],
        projects: projectsStore(),
      });
      await expect(resolve('session-1')).rejects.toThrow(
        'Repository access did not include a bearer token for the Factory session',
      );
    }
    expect(materialize).not.toHaveBeenCalled();
    expect(checkout).not.toHaveBeenCalled();
  });

  it('propagates a failed clone without checking out a branch', async () => {
    materialize.mockRejectedValueOnce(new Error('clone failed'));
    const resolve = createClaudeCheckoutResolver({
      sandbox: fakeSandbox().sandbox,
      sourceControls: () => [sourceControl({ sessions: { 'session-1': sessionRow() } }).provider],
      projects: projectsStore(),
    });
    await expect(resolve('session-1')).rejects.toThrow('clone failed');
    expect(checkout).not.toHaveBeenCalled();
  });

  it('keeps the checkout inside the sandbox root whatever the repository slug', async () => {
    for (const slug of ['acme/..', 'acme/../../etc', '../..', 'acme/.hidden', 'acme/we ird;rm -rf']) {
      __clearSessionSandboxesForTests();
      const owner = sourceControl({
        sessions: { 'session-1': sessionRow() },
        repositories: { 'repo-1': { orgId: 'org-1', id: 'repo-1', slug, defaultBranch: 'main' } },
      });
      const resolve = createClaudeCheckoutResolver({
        sandbox: fakeSandbox().sandbox,
        sourceControls: () => [owner.provider],
        projects: projectsStore(),
      });
      const workdir = await resolve('session-1');
      expect(workdir.startsWith(`${ROOT}/`)).toBe(true);
      expect(workdir.slice(ROOT.length + 1)).toMatch(/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/);
    }
  });

  it('reuses the session’s memoized sandbox across turns', async () => {
    const box = fakeSandbox();
    const resolve = createClaudeCheckoutResolver({
      sandbox: box.sandbox,
      sourceControls: () => [sourceControl({ sessions: { 'session-1': sessionRow() } }).provider],
      projects: projectsStore(),
    });
    await expect(resolve('session-1')).resolves.toBe(`${ROOT}/widgets`);
    await expect(resolve('session-1')).resolves.toBe(`${ROOT}/widgets`);
    expect(box.create).toHaveBeenCalledTimes(1);
    expect(materialize).toHaveBeenCalledTimes(2);
  });
});
