/**
 * Browser-side helpers for Factory projects and the GitHub source-control flow:
 * creating named Factory projects, connecting GitHub installations, linking
 * repositories, and per-repository sandbox/git operations.
 *
 * All requests go to the server's `/web/github/*` and `/auth/github/*`
 * routes, which are behind the auth gate and scoped to the logged-in
 * user. The browser never sees installation tokens — those live only inside the
 * server and the cloud sandbox.
 *
 * Every helper takes the API base URL injected by `ApiConfigProvider` (empty
 * string when served same-origin) so a frontend dev server on another port
 * still reaches the Mastra server — same pattern as the shared API client.
 */

import type { ModelSelection, ProviderOptionSelection } from '@factory/harness/models/contracts';
import type { ThinkingLevelSetting } from '@mastra/code-sdk/thinking';
import type { ProjectListRepository } from '@factory/contracts';

import { postRepositoryGitOp, postSourceControlRepositoryOp, readJsonOrThrow } from './http';
import type { GitLabRepository } from '../../factory/services/gitlab';
import { translator } from '../../../i18n/t';

const tk = translator('workspaces');

export interface GithubInstallation {
  installationId: number;
  accountLogin: string | null;
  accountType: string | null;
}

/**
 * Reason the GitHub feature is in its current state. Every value but
 * `unavailable` comes from the server; `unavailable` is set by the browser
 * when the status endpoint could not be reached or answered with an error,
 * so consumers can tell a transient failure from a deliberately disabled
 * feature.
 */
export type GithubStatusReason =
  | 'missing_config'
  | 'auth_required'
  | 'organization_required'
  | 'not_connected'
  | 'ready'
  | 'unavailable';

/** Non-secret diagnostic snapshot of every GitHub feature gate. */
export interface GithubFeatureDiagnostics {
  githubAppConfigured: boolean;
  factoryAuthEnabled: boolean;
  appDbConfigured: boolean;
  stateSecretConfigured: boolean;
  sandboxEnabled: boolean;
  sandboxProvider: string;
  /** Names of missing required GitHub App env vars (non-secret names only). */
  missingGithubAppEnvVars: string[];
}

export interface GithubStatus {
  enabled: boolean;
  sandboxEnabled?: boolean;
  /**
   * `token`: the deployment's access token connects the org by itself, so
   * there is no Connect or Manage step. Absent on older servers (App only).
   */
  mode?: 'app' | 'token';
  connected: boolean;
  installations: GithubInstallation[];
  /**
   * True when the status request failed because the user is not authenticated
   * (HTTP 401), as opposed to the feature being genuinely disabled. Lets the SPA
   * prompt re-login instead of silently hiding GitHub.
   */
  authRequired?: boolean;
  /** True when the user is signed in but has no org (personal account). */
  organizationRequired?: boolean;
  /** Machine-readable reason for the current state; see {@link GithubStatusReason}. */
  reason?: GithubStatusReason;
  /**
   * Whether the signed-in user has personally authorized the GitHub App, so
   * issues/PRs they originate are authored as them instead of the App bot.
   * Absent on older servers that predate per-user connections.
   */
  userConnected?: boolean;
  /** GitHub username backing the personal connection, when connected. */
  userGithubUsername?: string | null;
  /** Non-secret feature-gate diagnostics from the server. */
  diagnostics?: GithubFeatureDiagnostics;
}

export interface GithubRepo {
  id: number;
  fullName: string;
  name: string;
  owner: string;
  defaultBranch: string;
  private: boolean;
  installationId: number;
  /** Storage UUID of the installation row backing this repo. */
  installationStorageId: string;
  sandboxProvider: string;
  sandboxWorkdir: string;
}

export type SourceControlRepository = GithubRepo | GitLabRepository;

export function isGitLabRepository(repo: SourceControlRepository): repo is GitLabRepository {
  return 'provider' in repo && repo.provider === 'gitlab';
}

/**
 * Read GitHub feature/connection status. Never throws: a 401 is reported via
 * `authRequired` so the SPA can prompt re-login, and any other failed response
 * or network error resolves to a disabled status with `reason: 'unavailable'`
 * so the SPA can offer a retry instead of reporting the feature as
 * unconfigured. A server that has the feature off answers 200 with
 * `enabled: false` and its own reason.
 */
export async function fetchGithubStatus(baseUrl: string): Promise<GithubStatus> {
  try {
    const res = await fetch(`${baseUrl}/web/github/status`, {
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
    if (res.status === 401) {
      return { enabled: false, connected: false, installations: [], authRequired: true, reason: 'auth_required' };
    }
    if (!res.ok) return unavailableStatus();
    return (await res.json()) as GithubStatus;
  } catch {
    return unavailableStatus();
  }
}

/**
 * Status used when the endpoint failed or could not be reached. It is not a
 * `missing_config` answer: the server never said the feature is off, so the
 * UI should offer a retry rather than report the feature as unconfigured.
 */
function unavailableStatus(): GithubStatus {
  return { enabled: false, connected: false, installations: [], reason: 'unavailable' };
}

function currentPageRedirectTo(): string {
  return encodeURIComponent(window.location.pathname);
}

/** Begin the GitHub App install/connect flow (full-page redirect). */
export function connectGithub(baseUrl: string): void {
  window.location.assign(`${baseUrl}/auth/github/connect?redirectTo=${currentPageRedirectTo()}`);
}

/**
 * Open GitHub's installation page to add/remove accounts and repo access
 * (full-page redirect). Unlike {@link connectGithub}, this skips the OAuth
 * identify bounce — for an already-authorized user that bounce completes
 * instantly and invisibly, which would make the manage button a silent no-op.
 */
export function manageGithubConnection(baseUrl: string): void {
  window.location.assign(`${baseUrl}/auth/github/connect?manage=1&redirectTo=${currentPageRedirectTo()}`);
}

/**
 * Begin the GitHub App *user authorization* flow for the signed-in user
 * (full-page redirect). Unlike {@link connectGithub} this never installs the
 * App into an account — it links the user's own GitHub identity so
 * factory-originated issues and PRs are authored as them. The flow returns to
 * the current path with `github_app_user_authorized=true`, and the fresh page
 * load refetches `/web/github/status`.
 */
export function connectUserGithub(baseUrl: string): void {
  window.location.assign(`${baseUrl}/auth/github/connect-user?redirectTo=${currentPageRedirectTo()}`);
}

/** `default` = the worker token every sandbox gets; `reviewer` = optional
 * token review-board sessions use so PR reviews come from another account. */
export type GithubPatKind = 'default' | 'reviewer';

export interface GithubPatStatus {
  configured: boolean;
  reviewerConfigured: boolean;
}

/**
 * Which GitHub Personal Access Tokens the org has configured for `gh` CLI
 * use in sandboxes. The tokens themselves never reach the browser.
 */
export async function fetchGithubPatStatus(baseUrl: string): Promise<GithubPatStatus> {
  const res = await fetch(`${baseUrl}/web/github/pat`, {
    headers: { Accept: 'application/json' },
    credentials: 'include',
  });
  if (!res.ok) throw new Error(tk('errors.loadGithubToken', { status: res.status }));
  return (await res.json()) as GithubPatStatus;
}

/** Save an org GitHub PAT (used only for `gh` CLI auth in sandboxes). */
export async function saveGithubPat(baseUrl: string, token: string, kind: GithubPatKind = 'default'): Promise<void> {
  const res = await fetch(`${baseUrl}/web/github/pat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ token, kind }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
    throw new Error(body?.error ?? tk('errors.saveGithubToken', { status: res.status }));
  }
}

/** Remove an org GitHub PAT. */
export async function deleteGithubPat(baseUrl: string, kind: GithubPatKind = 'default'): Promise<void> {
  const res = await fetch(`${baseUrl}/web/github/pat?kind=${kind}`, {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
    credentials: 'include',
  });
  if (!res.ok) throw new Error(tk('errors.removeGithubToken', { status: res.status }));
}

/**
 * List repos across the user's installations, optionally filtered by query.
 * `refresh` bypasses the server's short-lived repository cache.
 */
export async function listGithubRepos(
  baseUrl: string,
  query?: string,
  options?: { refresh?: boolean },
): Promise<GithubRepo[]> {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (options?.refresh) params.set('refresh', '1');
  const search = params.toString();
  const url = `${baseUrl}/web/github/repos${search ? `?${search}` : ''}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'include' });
  if (!res.ok) throw new Error(tk('errors.listRepos', { status: res.status }));
  const body = (await res.json()) as { repos: GithubRepo[] };
  return body.repos;
}

/** The GitHub source-control integration id registered on the server. */
const GITHUB_INTEGRATION_ID = 'github';

/** Runtimes a Factory's agents can run on; mirrors `FACTORY_HARNESS_KINDS` in @factory/contracts. */
export const FACTORY_HARNESSES = ['mastra', 'claude-code', 'codex'] as const;

export type FactoryHarness = (typeof FACTORY_HARNESSES)[number];

export function isFactoryHarness(value: unknown): value is FactoryHarness {
  return FACTORY_HARNESSES.some(harness => harness === value);
}


/** The language a Factory's agents write to the team in; mirrors `AGENT_LANGUAGES` in @factory/contracts. */
export const AGENT_LANGUAGES = ['uk', 'en'] as const;

export type AgentLanguage = (typeof AGENT_LANGUAGES)[number];

export function isAgentLanguage(value: unknown): value is AgentLanguage {
  return AGENT_LANGUAGES.some(language => language === value);
}

/** A Factory project row from `/web/factory/projects`. */
export type FactoryToolPolicy = 'allow' | 'ask' | 'deny';
export type FactoryToolCategory = 'read' | 'edit' | 'execute' | 'mcp' | 'other';

export interface FactoryToolPermissions {
  /** A category left out asks. */
  categories: Partial<Record<FactoryToolCategory, FactoryToolPolicy>>;
  /** Auto-approve: every category is allowed. */
  yolo: boolean;
}

export interface FactoryProjectPayload {
  id: string;
  name: string;
  /**
   * The runtime new agent sessions start on; switching it leaves running cards on theirs.
   * Absent from servers that predate it (= mastra).
   */
  harness?: FactoryHarness;
  /** The language every agent of this Factory writes to the team in; absent from servers that predate it. */
  agentLanguage?: AgentLanguage;
  /**
   * The Factory's default model per harness instance (`{ [instanceId]: selection }`): what its
   * sessions of that harness start on. An instance left out follows its harness's catalog default.
   */
  harnessModelDefaults?: Record<string, ModelSelection>;
  /** Read-only view of `harnessModelDefaults.mastra.model`, which the Mastra chat reads; null when unset. */
  defaultModelId?: string | null;
  /** Read-only view of the Mastra default's thinking level (`effort`), what `/think` falls back to. */
  defaultThinkingLevel?: ThinkingLevelSetting;
  /** Settings → Behavior tool permissions of a Factory on Claude Code; null until set (every category asks). */
  toolPermissions?: FactoryToolPermissions | null;
}

/** A Factory project row from `GET /web/factory/projects`, with its linked repositories. */
export interface ListedFactoryProjectPayload extends FactoryProjectPayload {
  repositories: ProjectListRepository[];
}

/** `{...projectRepository, repository}` payload from the Factory project routes. */
interface ProjectRepositoryPayload {
  id: string;
  branch: string | null;
  /** Whether the sandbox boots this repository; absent from older servers. */
  inEnvironment?: boolean;
  position?: number;
  sandboxWorkdir: string;
  repository: { externalId: string; slug: string; defaultBranch: string } | null;
}

interface ProjectConnectionPayload {
  id: string;
  installationId: string;
}

/** Browser-shaped view of a repository linked to a Factory project. */
export interface LinkedRepositoryPayload {
  projectRepositoryId: string;
  provider?: 'github' | 'gitlab';
  /** Provider repository/project id; stable across renames. */
  externalId?: string;
  slug: string;
  gitBranch?: string;
  sandboxWorkdir?: string;
  /** Whether every new session of the Factory checks this repository out. */
  inEnvironment?: boolean;
  /** Environment order; position 1 is the link a session row is filed under. */
  position?: number;
}

/** A Factory project with its linked repositories flattened across connections. */
export interface FactoryProjectSnapshot extends FactoryProjectPayload {
  repositories: LinkedRepositoryPayload[];
}

export type FactoryProject = FactoryProjectSnapshot;

function toLinkedRepositoryPayload(
  projectName: string,
  repository: Pick<
    ProjectListRepository,
    'projectRepositoryId' | 'integrationId' | 'externalId' | 'slug' | 'defaultBranch' | 'branch' | 'sandboxWorkdir'
  > &
    // Absent from older servers.
    Partial<Pick<ProjectListRepository, 'position' | 'inEnvironment'>>,
): LinkedRepositoryPayload {
  return {
    projectRepositoryId: repository.projectRepositoryId,
    provider: repository.integrationId === 'gitlab' ? 'gitlab' : 'github',
    externalId: repository.externalId ?? undefined,
    slug: repository.slug ?? projectName,
    gitBranch: repository.branch ?? repository.defaultBranch ?? undefined,
    sandboxWorkdir: repository.sandboxWorkdir,
    ...(repository.inEnvironment === undefined ? {} : { inEnvironment: repository.inEnvironment }),
    ...(repository.position === undefined ? {} : { position: repository.position }),
  };
}

async function listProjectConnections(baseUrl: string, factoryProjectId: string): Promise<ProjectConnectionPayload[]> {
  const res = await fetch(
    `${baseUrl}/web/factory/projects/${encodeURIComponent(factoryProjectId)}/source-control-connections`,
    { credentials: 'include', headers: { Accept: 'application/json' } },
  );
  const { connections } = await readJsonOrThrow<{ connections: ProjectConnectionPayload[] }>(
    res,
    tk('errors.listFactoryRepositories'),
  );
  return connections;
}

/**
 * List the org's Factory projects with their linked repositories. Resolves to
 * `null` when the caller is unauthenticated, org-less, or the feature is off,
 * so hydration can keep the local cache instead of wiping it.
 */
export async function listFactoryProjects(baseUrl: string): Promise<FactoryProjectSnapshot[] | null> {
  const res = await fetch(`${baseUrl}/web/factory/projects`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (res.status === 401 || res.status === 403 || res.status === 404) return null;
  const { projects } = await readJsonOrThrow<{ projects: ListedFactoryProjectPayload[] }>(
    res,
    tk('errors.listFactories'),
  );
  return projects.map(project => ({
    ...project,
    repositories: project.repositories.map(repository => toLinkedRepositoryPayload(project.name, repository)),
  }));
}

/** Create a named Factory project. The name is user-chosen, not derived from a repo. */
export async function createFactoryProject(
  baseUrl: string,
  name: string,
  description?: string,
  harness?: FactoryHarness,
): Promise<FactoryProjectPayload> {
  const res = await fetch(`${baseUrl}/web/factory/projects`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      name,
      ...(description ? { description } : {}),
      ...(harness ? { harness } : {}),
    }),
  });
  const { project } = await readJsonOrThrow<{ project: FactoryProjectPayload }>(res, tk('errors.createFactory'));
  return project;
}

/**
 * Create a Factory and, for one on a turn-based harness (Claude Code, Codex), set the model picked
 * with it as that harness's default (its instance id is the harness id; null: the catalog default).
 */
export async function createFactoryWithHarnessModel(
  baseUrl: string,
  input: { name: string; description?: string | undefined; harness?: FactoryHarness | undefined; model?: string | null | undefined },
): Promise<FactoryProjectPayload> {
  const project = await createFactoryProject(baseUrl, input.name, input.description, input.harness);
  if (!input.model || !input.harness || input.harness === 'mastra') return project;
  return setFactoryModelDefault(baseUrl, project.id, input.harness, { model: input.model });
}

/** Fetch a single Factory project (includes its `defaultModelId`). */
export async function fetchFactoryProject(baseUrl: string, factoryProjectId: string): Promise<FactoryProjectPayload> {
  const res = await fetch(`${baseUrl}/web/factory/projects/${encodeURIComponent(factoryProjectId)}`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  const { project } = await readJsonOrThrow<{ project: FactoryProjectPayload }>(res, tk('errors.loadFactory'));
  return project;
}

function modelDefaultUrl(baseUrl: string, factoryProjectId: string, instanceId: string, suffix = '') {
  return `${baseUrl}/web/factory/projects/${encodeURIComponent(factoryProjectId)}/model-defaults/${encodeURIComponent(instanceId)}${suffix}`;
}

/**
 * Set the Factory's default for one harness instance; the server checks it against that harness's
 * catalog. Admin-only.
 */
export async function setFactoryModelDefault(
  baseUrl: string,
  factoryProjectId: string,
  instanceId: string,
  selection: { model: string; options?: ReadonlyArray<ProviderOptionSelection> | undefined },
): Promise<FactoryProjectPayload> {
  const res = await fetch(modelDefaultUrl(baseUrl, factoryProjectId, instanceId), {
    method: 'PUT',
    credentials: 'include',
    headers: { 'content-type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ model: selection.model, ...(selection.options?.length ? { options: selection.options } : {}) }),
  });
  if (res.status === 400) {
    // The harness said why: a model or option its catalog does not offer.
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    const error = new Error(body?.message ?? tk('errors.updateDefaultModel')) as Error & { status?: number };
    error.status = 400;
    throw error;
  }
  const { project } = await readJsonOrThrow<{ project: FactoryProjectPayload }>(res, tk('errors.updateDefaultModel'));
  return project;
}

/** Clear one instance's default: its sessions follow the harness's catalog default. Admin-only. */
export async function clearFactoryModelDefault(
  baseUrl: string,
  factoryProjectId: string,
  instanceId: string,
): Promise<FactoryProjectPayload> {
  const res = await fetch(modelDefaultUrl(baseUrl, factoryProjectId, instanceId), {
    method: 'DELETE',
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  const { project } = await readJsonOrThrow<{ project: FactoryProjectPayload }>(res, tk('errors.updateDefaultModel'));
  return project;
}

/**
 * Switch the harness new sessions start on, or the agents' language. Cards
 * already running finish on the harness they started on.
 */
export async function updateFactoryHarness(
  baseUrl: string,
  factoryProjectId: string,
  patch: { harness?: FactoryHarness; agentLanguage?: AgentLanguage },
): Promise<FactoryProjectPayload> {
  const res = await fetch(`${baseUrl}/web/factory/projects/${encodeURIComponent(factoryProjectId)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(patch),
  });
  const { project } = await readJsonOrThrow<{ project: FactoryProjectPayload }>(res, tk('errors.updateHarness'));
  return project;
}

export async function updateFactoryToolPermissions(
  baseUrl: string,
  factoryProjectId: string,
  toolPermissions: FactoryToolPermissions,
): Promise<FactoryProjectPayload> {
  const res = await fetch(`${baseUrl}/web/factory/projects/${encodeURIComponent(factoryProjectId)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ toolPermissions }),
  });
  const { project } = await readJsonOrThrow<{ project: FactoryProjectPayload }>(res, tk('errors.updateToolPermissions'));
  return project;
}

export async function renameFactoryProject(
  baseUrl: string,
  factoryProjectId: string,
  name: string,
): Promise<FactoryProjectPayload> {
  const res = await fetch(`${baseUrl}/web/factory/projects/${encodeURIComponent(factoryProjectId)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ name }),
  });
  const { project } = await readJsonOrThrow<{ project: FactoryProjectPayload }>(res, tk('errors.updateName'));
  return project;
}

export interface ApplyFactoryModelDefaultResult {
  selection: ModelSelection;
  applied: string[];
  skipped: Array<{ threadId: string; reason: string }>;
}

/** Move the Factory's running sessions of one harness instance onto its default (when its harness can). */
export async function applyFactoryModelDefault(
  baseUrl: string,
  factoryProjectId: string,
  instanceId: string,
): Promise<ApplyFactoryModelDefaultResult> {
  const res = await fetch(modelDefaultUrl(baseUrl, factoryProjectId, instanceId, '/apply'), {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  return readJsonOrThrow<ApplyFactoryModelDefaultResult>(res, tk('errors.switchSessions'));
}

/**
 * Ensure the Factory project has a source-control connection for the given
 * GitHub installation, reusing an existing one when present. Returns the
 * connection id repositories are linked under.
 */
export async function connectInstallation(
  baseUrl: string,
  factoryProjectId: string,
  installationId: string,
  integrationId: 'github' | 'gitlab' = GITHUB_INTEGRATION_ID,
): Promise<string> {
  const connections = await listProjectConnections(baseUrl, factoryProjectId);
  const existing = connections.find(connection => connection.installationId === installationId);
  if (existing) return existing.id;

  const res = await fetch(
    `${baseUrl}/web/factory/projects/${encodeURIComponent(factoryProjectId)}/source-control-connections`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ integrationId, installationId }),
    },
  );
  const { connection } = await readJsonOrThrow<{ connection: { id: string } }>(
    res,
    tk('errors.connectInstallation', { host: integrationId === 'gitlab' ? 'GitLab' : 'GitHub' }),
  );
  return connection.id;
}

/**
 * Link a GitHub repository to a Factory project under the given connection.
 * Returns the browser-shaped linked-repository payload.
 */
export async function linkRepository(
  baseUrl: string,
  factoryProjectId: string,
  connectionId: string,
  repo: SourceControlRepository,
): Promise<LinkedRepositoryPayload> {
  const gitlab = isGitLabRepository(repo);
  const res = await fetch(
    `${baseUrl}/web/factory/projects/${encodeURIComponent(factoryProjectId)}/source-control-connections/${encodeURIComponent(connectionId)}/repositories`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        repository: { externalId: gitlab ? repo.externalId : String(repo.id), slug: repo.fullName },
        branch: repo.defaultBranch,
        sandboxProvider: repo.sandboxProvider,
        sandboxWorkdir: repo.sandboxWorkdir,
      }),
    },
  );
  const { projectRepository } = await readJsonOrThrow<{ projectRepository: ProjectRepositoryPayload }>(
    res,
    tk('errors.linkRepository', { host: gitlab ? 'GitLab' : 'GitHub' }),
  );
  return toLinkedRepositoryPayload(repo.fullName, {
    projectRepositoryId: projectRepository.id,
    integrationId: gitlab ? 'gitlab' : 'github',
    externalId: projectRepository.repository?.externalId ?? null,
    slug: projectRepository.repository?.slug ?? null,
    defaultBranch: projectRepository.repository?.defaultBranch ?? null,
    branch: projectRepository.branch,
    sandboxWorkdir: projectRepository.sandboxWorkdir,
    position: projectRepository.position,
    inEnvironment: projectRepository.inEnvironment,
  });
}

/**
 * Unlink a repository from its Factory project. Missing links are treated as
 * already removed so unlink stays idempotent.
 */
export async function unlinkRepository(
  baseUrl: string,
  factoryProjectId: string,
  projectRepositoryId: string,
): Promise<void> {
  const res = await fetch(
    `${baseUrl}/web/factory/projects/${encodeURIComponent(factoryProjectId)}/repositories/${encodeURIComponent(projectRepositoryId)}`,
    { method: 'DELETE', credentials: 'include', headers: { Accept: 'application/json' } },
  );
  if (!res.ok && res.status !== 404) throw new Error(tk('errors.unlinkRepository', { status: res.status }));
}

/**
 * Delete a Factory project. The server cascades over its source-control
 * connections (and their repository links). Missing projects are treated as
 * already deleted so removal stays idempotent.
 */
export async function deleteFactoryProject(baseUrl: string, factoryProjectId: string): Promise<void> {
  const res = await fetch(`${baseUrl}/web/factory/projects/${encodeURIComponent(factoryProjectId)}`, {
    method: 'DELETE',
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok && res.status !== 404) throw new Error(tk('errors.deleteFactory', { status: res.status }));
}

export interface CommitResult {
  committed: boolean;
}

/** Stage and commit all changes in a Factory session workspace. */
export async function commitChanges(
  baseUrl: string,
  projectRepositoryId: string,
  message: string,
  sessionId: string,
): Promise<CommitResult> {
  return postRepositoryGitOp<CommitResult>(baseUrl, projectRepositoryId, 'commit', { message, sessionId });
}

export interface PushResult {
  pushed: boolean;
  branch: string;
}

/** Push a Factory session branch back to GitHub (token minted server-side). */
export async function pushBranch(
  baseUrl: string,
  projectRepositoryId: string,
  branch: string,
  sessionId: string,
): Promise<PushResult> {
  return postRepositoryGitOp<PushResult>(baseUrl, projectRepositoryId, 'push', { branch, sessionId });
}

export interface PullRequestResult {
  url: string;
}

/** Open a pull request via the sandbox `gh` CLI. `base` defaults to the project default branch. */
export async function openPullRequest(
  baseUrl: string,
  projectRepositoryId: string,
  args: {
    branch: string;
    title: string;
    body?: string;
    base?: string;
    sessionId: string;
  },
): Promise<PullRequestResult> {
  return postRepositoryGitOp<PullRequestResult>(baseUrl, projectRepositoryId, 'pr', args);
}

/** Per-repository settings persisted on the server. */
export interface RepositorySettings {
  /**
   * Shell command run inside every freshly created worktree before any agent
   * execution (e.g. `pnpm i && pnpm build`). `null` when no setup step is
   * configured.
   */
  setupCommand: string | null;
  /** Best-effort shell command run before a session workspace is retired. */
  teardownCommand: string | null;
}

/** Read a repository's worktree lifecycle settings. */
export async function fetchRepositorySettings(
  baseUrl: string,
  projectRepositoryId: string,
): Promise<RepositorySettings> {
  const res = await fetch(
    `${baseUrl}/web/source-control/projects/${encodeURIComponent(projectRepositoryId)}/settings`,
    {
      headers: { Accept: 'application/json' },
      credentials: 'include',
    },
  );
  if (!res.ok) throw new Error(tk('errors.loadRepositorySettings', { status: res.status }));
  return (await res.json()) as RepositorySettings;
}

/** Persist a repository's lifecycle commands. Pass `null` (or blank) to clear one. */
export async function saveRepositorySettings(
  baseUrl: string,
  projectRepositoryId: string,
  settings: RepositorySettings,
): Promise<RepositorySettings> {
  return postSourceControlRepositoryOp<RepositorySettings>(baseUrl, projectRepositoryId, 'settings', settings);
}
