import { MastraError } from '@mastra/core/error';
import type { StandardSchemaWithJSON } from '@mastra/core/schema';
import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import type { FactoryStorageOps } from '@mastra/core/storage';
import { describeFactorySandbox, normalizeFactorySandboxSettings } from '@mastra/core/workspace';
import type { FactorySandbox, FactorySandboxDescription } from '@mastra/core/workspace';
import type { Context } from 'hono';

import { withHarnessModelDefault } from '@factory/harness/models/defaults';
import type { HarnessModelContext, HarnessModels } from '@factory/harness/models/facet';
import type { HarnessModelRegistry } from '@factory/harness/models/registry';
import type { EnvironmentBuildRunner } from '@factory/harness-mastra';
import { ensureSchedule, invalidCronMessage, readSchedule, scheduleIdFor } from '@factory/harness-mastra';
import { redactCredentials } from '@factory/harness-mastra';
import type { SessionRetirementCoordinator } from '@factory/sandbox';
import type {
  FactoryProject,
  FactoryProjectsStorage,
  UpdateFactoryProjectInput,
} from '@factory/store';
import type {
  ProjectRepository,
  SourceControlRepository,
  SourceControlStorage,
  SourceControlStorageHandle,
  UpdateProjectRepositoryInput,
} from '@factory/store';
import type { WorkItemsStorage } from '@factory/store';
import type { IntakeStorage } from '@factory/store';
import { FACTORY_ROUTE_CONTRACTS } from '@factory/contracts';
import type { ProjectListRepository } from '@factory/contracts';
import type { RouteDependencies } from '@factory/http';
import { Route } from '@factory/http';
import type { ProjectBoardCache } from '@factory/runtime';
import { buildEnvOf, maskSandboxEnvValues } from '@factory/sandbox';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME_LENGTH = 200;
const MAX_REPOSITORY_COMMAND_LENGTH = 2_000;
const MAX_BRANCH_LENGTH = 255;
const MAX_SANDBOX_PROVIDER_LENGTH = 100;
const MAX_SANDBOX_WORKDIR_LENGTH = 1_000;
const CONTROL_CHAR_RE = /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const applyDefaultModelRuns = new Map<string, Promise<void>>();

function loose(context: unknown): Context {
  return context as Context;
}

async function readJson(context: Context): Promise<unknown | undefined> {
  try {
    return await context.req.json();
  } catch {
    return undefined;
  }
}

function parseConnectionInput(value: unknown): { integrationId: string; installationId: string } | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (typeof input.integrationId !== 'string' || !input.integrationId.trim()) return null;
  if (typeof input.installationId !== 'string' || !UUID_RE.test(input.installationId)) return null;
  return { integrationId: input.integrationId.trim(), installationId: input.installationId };
}

function parseOptionalString(
  value: unknown,
  { maxLength, nullable = false }: { maxLength: number; nullable?: boolean },
): string | null | undefined | false {
  if (value === undefined) return undefined;
  if (value === null) return nullable ? null : false;
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  if (!normalized) return nullable ? null : false;
  if (normalized.length > maxLength || CONTROL_CHAR_RE.test(normalized)) return false;
  return normalized;
}

function parseRepositoryLinkInput(value: unknown): {
  repositoryId?: string;
  repository?: { externalId: string; slug: string };
  branch: string | null;
  sandboxProvider: string;
  sandboxWorkdir: string;
  setupCommand: string | null;
  teardownCommand: string | null;
} | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const repositoryId =
    typeof input.repositoryId === 'string' && UUID_RE.test(input.repositoryId) ? input.repositoryId : undefined;
  const repositoryInput = input.repository;
  let repository: { externalId: string; slug: string } | undefined;
  if (repositoryInput && typeof repositoryInput === 'object') {
    const candidate = repositoryInput as Record<string, unknown>;
    const externalId = parseOptionalString(candidate.externalId, { maxLength: MAX_NAME_LENGTH });
    const slug = parseOptionalString(candidate.slug, { maxLength: MAX_NAME_LENGTH });
    if (typeof externalId !== 'string' || typeof slug !== 'string') return null;
    repository = { externalId, slug };
  }
  if (!repositoryId && !repository) return null;
  const branch = parseOptionalString(input.branch, { maxLength: MAX_BRANCH_LENGTH, nullable: true });
  const sandboxProvider = parseOptionalString(input.sandboxProvider, { maxLength: MAX_SANDBOX_PROVIDER_LENGTH });
  const sandboxWorkdir = parseOptionalString(input.sandboxWorkdir, { maxLength: MAX_SANDBOX_WORKDIR_LENGTH });
  const setupCommand = parseOptionalString(input.setupCommand, {
    maxLength: MAX_REPOSITORY_COMMAND_LENGTH,
    nullable: true,
  });
  const teardownCommand = parseOptionalString(input.teardownCommand, {
    maxLength: MAX_REPOSITORY_COMMAND_LENGTH,
    nullable: true,
  });
  if (
    branch === false ||
    typeof sandboxProvider !== 'string' ||
    typeof sandboxWorkdir !== 'string' ||
    setupCommand === false ||
    teardownCommand === false
  )
    return null;
  return {
    ...(repositoryId ? { repositoryId } : {}),
    ...(repository ? { repository } : {}),
    branch: branch ?? null,
    sandboxProvider,
    sandboxWorkdir,
    setupCommand: setupCommand ?? null,
    teardownCommand: teardownCommand ?? null,
  };
}

function parseRepositoryUpdateInput(value: unknown): UpdateProjectRepositoryInput | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const patch: UpdateProjectRepositoryInput = {};
  const branch = parseOptionalString(input.branch, { maxLength: MAX_BRANCH_LENGTH, nullable: true });
  const sandboxProvider = parseOptionalString(input.sandboxProvider, { maxLength: MAX_SANDBOX_PROVIDER_LENGTH });
  const sandboxWorkdir = parseOptionalString(input.sandboxWorkdir, { maxLength: MAX_SANDBOX_WORKDIR_LENGTH });
  const setupCommand = parseOptionalString(input.setupCommand, {
    maxLength: MAX_REPOSITORY_COMMAND_LENGTH,
    nullable: true,
  });
  const teardownCommand = parseOptionalString(input.teardownCommand, {
    maxLength: MAX_REPOSITORY_COMMAND_LENGTH,
    nullable: true,
  });
  if (
    branch === false ||
    sandboxProvider === false ||
    sandboxProvider === null ||
    sandboxWorkdir === false ||
    sandboxWorkdir === null ||
    setupCommand === false ||
    teardownCommand === false
  )
    return null;
  if (branch !== undefined) patch.branch = branch;
  if (sandboxProvider !== undefined) patch.sandboxProvider = sandboxProvider;
  if (sandboxWorkdir !== undefined) patch.sandboxWorkdir = sandboxWorkdir;
  if (setupCommand !== undefined) patch.setupCommand = setupCommand;
  if (teardownCommand !== undefined) patch.teardownCommand = teardownCommand;
  return Object.keys(patch).length > 0 ? patch : null;
}

export interface ProjectRoutesDeps extends RouteDependencies {
  /** Factory projects domain backing the CRUD surface. */
  projects: FactoryProjectsStorage;
  /** Source-control domain the connection/repository routes fan out over. */
  sourceControl: SourceControlStorage;
  /** Intake routing to release with a deleted Factory project, in the same transaction. */
  intake?: Pick<IntakeStorage, 'ensureReady' | 'clearProjectBindings'>;
  /** Integration ids allowed as source-control connection targets. */
  versionControlIntegrationIds?: string[];
  /** Validate and persist a repository selected from a provider-backed listing. */
  resolveRepository?: (input: {
    integrationId: string;
    orgId: string;
    userId: string;
    installationId: string;
    externalId: string;
    slug: string;
  }) => Promise<SourceControlRepository | null>;
  /**
   * Fire-and-forget hook invoked after a repository is linked to a project —
   * kicks the initial base-checkpoint build. Must never throw.
   */
  onProjectRepositoryLinked?: (args: {
    orgId: string;
    /** The code host the link's connection belongs to (`github`, `gitlab`…). */
    integrationId: string;
    projectRepository: ProjectRepository;
  }) => void;
  /** Shared lifecycle for retiring sessions before their owning records are deleted. */
  sessionRetirement?: SessionRetirementCoordinator;
  /** Work-items domain used by session retirement. */
  workItems?: Pick<WorkItemsStorage, 'clearSessionReferences'>;
  /**
   * The server's harness model registry: a Factory's default for an instance is checked by that
   * harness's facet (`check`), and moved onto running sessions by it (`applyDefaultToRunningSessions`).
   */
  harnessModels?: () => Pick<HarnessModelRegistry, 'forInstance'> | undefined;
  /** The factory's normalized sandbox; describes and validates the environment settings. */
  sandbox?: FactorySandbox;
  /** Environment builds, present only when the sandbox has a `builds` capability. */
  environmentBuilds?: EnvironmentBuildRunner;
  /** The per-project boards; loading a new project stores its copies of the code boards. */
  boards?: Pick<ProjectBoardCache, 'describe' | 'seedNewProject'>;
}

/**
 * Provider output is shown to the user; strip any clone credential and any
 * Build variable value from it first.
 */
function redactBuild<T extends { error?: string; logs?: string[] }>(build: T, buildEnv?: Record<string, string>): T {
  const redact = (text: string) => maskSandboxEnvValues(redactCredentials(text), buildEnv);
  return {
    ...build,
    ...(build.error !== undefined ? { error: redact(build.error) } : {}),
    ...(build.logs ? { logs: build.logs.map(redact) } : {}),
  };
}

/** What the environment reports when the factory has no sandbox configured. */
const NO_SANDBOX: FactorySandboxDescription = {
  provider: 'none',
  settingsSchema: { type: 'object', properties: {}, additionalProperties: false },
  capabilities: { template: false, builds: { available: false, history: false } },
};

export class ProjectRoutes extends Route<ProjectRoutesDeps> {
  readonly #versionControlIntegrationIds: Set<string>;
  #sandboxDescription: FactorySandboxDescription | undefined;
  #settingsSchema: StandardSchemaWithJSON | undefined;

  constructor(deps: ProjectRoutesDeps) {
    super(deps);
    this.#versionControlIntegrationIds = new Set(deps.versionControlIntegrationIds ?? []);
  }

  #describeSandbox(): FactorySandboxDescription {
    if (!this.deps.sandbox) return NO_SANDBOX;
    this.#sandboxDescription ??= describeFactorySandbox(this.deps.sandbox);
    return this.#sandboxDescription;
  }

  /**
   * Merge a settings patch onto the stored document (null removes a key) and
   * validate the result through the sandbox's schema. Returns the issues when
   * the merged document is rejected.
   *
   * A stored key the current schema does not declare, or whose stored value it
   * now rejects (a tightened range or choice list), is left over from another
   * provider or an older schema. When the merged document fails validation, the
   * merge retries without those keys so one stale value cannot lock every later
   * update; keys the patch itself sets are never pruned.
   */
  async #mergeSettings(
    stored: Record<string, unknown>,
    patch: Record<string, unknown | null>,
  ): Promise<
    { merged: Record<string, unknown> | null } | { issues: ReadonlyArray<{ message: string; path?: unknown }> }
  > {
    const merged: Record<string, unknown> = { ...stored };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    this.#settingsSchema ??= normalizeFactorySandboxSettings(this.deps.sandbox!);
    const result = await this.#settingsSchema['~standard'].validate(merged);
    if (!result.issues) return { merged: Object.keys(merged).length > 0 ? merged : null };

    const declared = this.#describeSandbox().settingsSchema.properties ?? {};
    const rejected = new Set(
      result.issues.map(issue => {
        const segment = issue.path?.[0];
        return typeof segment === 'object' && segment !== null ? segment.key : segment;
      }),
    );
    const pruned = Object.fromEntries(
      Object.entries(merged).filter(([key]) => key in patch || (Object.hasOwn(declared, key) && !rejected.has(key))),
    );
    if (Object.keys(pruned).length === Object.keys(merged).length) return { issues: result.issues };
    const retried = await this.#settingsSchema['~standard'].validate(pruned);
    if (retried.issues) return { issues: result.issues };
    return { merged: Object.keys(pruned).length > 0 ? pruned : null };
  }

  async #projects(): Promise<FactoryProjectsStorage> {
    await this.deps.projects.ensureReady();
    return this.deps.projects;
  }

  async #sourceControl(): Promise<SourceControlStorage> {
    await this.deps.sourceControl.ensureReady();
    return this.deps.sourceControl;
  }

  async #intakeRelease(
    orgId: string,
    factoryProjectId: string,
  ): Promise<((ops: FactoryStorageOps) => Promise<void>) | undefined> {
    const { intake } = this.deps;
    if (!intake) return undefined;
    await intake.ensureReady();
    return ops => intake.clearProjectBindings({ orgId, factoryProjectId }, ops);
  }

  async #handles(): Promise<SourceControlStorageHandle[]> {
    const storage = await this.#sourceControl();
    return [...this.#versionControlIntegrationIds].map(integrationId => storage.forIntegration(integrationId));
  }

  async #project(orgId: string, id: string) {
    return (await this.#projects()).get({ orgId, id });
  }

  async #findConnection({ orgId, projectId, id }: { orgId: string; projectId: string; id: string }) {
    for (const handle of await this.#handles()) {
      const connection = await handle.connections.get({ orgId, id });
      if (connection?.factoryProjectId === projectId) return { handle, connection };
    }
    return null;
  }

  async #findProjectRepository({ orgId, projectId, id }: { orgId: string; projectId: string; id: string }) {
    for (const handle of await this.#handles()) {
      const projectRepository = await handle.projectRepositories.get({ orgId, id });
      if (!projectRepository) continue;
      const connection = await handle.connections.get({ orgId, id: projectRepository.connectionId });
      if (connection?.factoryProjectId === projectId) return { handle, connection, projectRepository };
    }
    return null;
  }

  async #connectionsWithRepositories(orgId: string, factoryProjectIds: string[]) {
    if (factoryProjectIds.length === 0 || this.#versionControlIntegrationIds.size === 0) return [];
    const perIntegration = await Promise.all(
      (await this.#handles()).map(handle => handle.connections.listWithRepositories({ orgId, factoryProjectIds })),
    );
    return perIntegration.flat();
  }

  async #linkedRepositoriesByProject(orgId: string, factoryProjectIds: string[]) {
    const byProject = new Map<string, ProjectListRepository[]>();
    for (const connection of await this.#connectionsWithRepositories(orgId, factoryProjectIds)) {
      const repositories = byProject.get(connection.factoryProjectId) ?? [];
      for (const link of connection.repositories) {
        repositories.push({
          projectRepositoryId: link.id,
          connectionId: connection.id,
          integrationId: connection.integrationId,
          repositoryId: link.repositoryId,
          externalId: link.repository?.externalId ?? null,
          slug: link.repository?.slug ?? null,
          defaultBranch: link.repository?.defaultBranch ?? null,
          branch: link.branch,
          sandboxWorkdir: link.sandboxWorkdir,
          position: link.position,
          inEnvironment: link.inEnvironment,
        });
      }
      byProject.set(connection.factoryProjectId, repositories);
    }
    return byProject;
  }

  async #repositoryPayload(handle: SourceControlStorageHandle, orgId: string, projectRepository: ProjectRepository) {
    const repository = await handle.repositories.get({ orgId, id: projectRepository.repositoryId });
    return { ...projectRepository, repository };
  }

  /** Every link of the project across every handle, with the handle that owns it, in position order. */
  async #environmentLinks(orgId: string, projectId: string) {
    const links: Array<{ handle: SourceControlStorageHandle; projectRepository: ProjectRepository }> = [];
    for (const handle of await this.#handles()) {
      for (const projectRepository of await handle.projectRepositories.listByProject({
        orgId,
        factoryProjectId: projectId,
      })) {
        links.push({ handle, projectRepository });
      }
    }
    return links.sort(
      (a, b) =>
        a.projectRepository.position - b.projectRepository.position ||
        a.projectRepository.createdAt.getTime() - b.projectRepository.createdAt.getTime(),
    );
  }

  async #environmentPayload(orgId: string, project: FactoryProject) {
    const repositories = [];
    for (const { handle, projectRepository } of await this.#environmentLinks(orgId, project.id)) {
      const repository = await handle.repositories.get({ orgId, id: projectRepository.repositoryId });
      repositories.push({
        projectRepositoryId: projectRepository.id,
        connectionId: projectRepository.connectionId,
        repositoryId: projectRepository.repositoryId,
        slug: repository?.slug ?? null,
        defaultBranch: repository?.defaultBranch ?? null,
        position: projectRepository.position,
        inEnvironment: projectRepository.inEnvironment,
        setupCommand: projectRepository.setupCommand,
        teardownCommand: projectRepository.teardownCommand,
        lastBuildStatus: projectRepository.lastBuildStatus,
        lastBuildError: projectRepository.lastBuildError,
        lastBuiltAt: projectRepository.lastBuiltAt,
      });
    }
    return {
      environment: {
        sandbox: this.#describeSandbox(),
        settings: project.sandboxSettings ?? {},
        sandboxWorkingDirectory: project.sandboxWorkingDirectory,
        workspaceSetupCommand: project.workspaceSetupCommand,
        activeTemplateId: project.activeTemplateId,
        activeTemplateHeads: project.activeTemplateHeads,
        repositories,
        ...(await this.#buildPayload(project)),
      },
    };
  }

  /**
   * The build keys of the environment payload, present only when the
   * sandbox can build. Reads the project row and the schedule row; never
   * the provider (live status is the builds routes' job).
   */
  async #buildPayload(project: FactoryProject) {
    const builds = this.deps.environmentBuilds;
    if (!builds) return {};
    const schedules = builds.scheduleAvailable ? builds.schedules() : undefined;
    const schedule = schedules
      ? await readSchedule(schedules, project.id)
      : { enabled: false, cron: null, timezone: null };
    return {
      buildTriggers: {
        schedule: { ...schedule, scheduleAvailable: builds.scheduleAvailable },
        push: { enabled: project.buildOnPushEnabled, debounceMinutes: project.buildPushDebounceMinutes },
      },
      build: project.lastBuildId
        ? { buildId: project.lastBuildId, attemptedAt: project.lastBuildAttemptedAt?.toISOString() ?? null }
        : null,
    };
  }

  /** The builds capability behind the routes, or the 404 to answer with. */
  #builds(context: Context) {
    const builds = this.deps.sandbox?.builds;
    const runner = this.deps.environmentBuilds;
    if (!builds || !runner) return { response: context.json({ error: 'no_builds' }, 404) };
    return { builds, runner };
  }

  #buildRoutes(): ApiRoute[] {
    return [
      registerApiRoute(FACTORY_ROUTE_CONTRACTS.projectEnvironmentBuild.path, {
        method: FACTORY_ROUTE_CONTRACTS.projectEnvironmentBuild.method,
        requiresAuth: false,
        handler: async routeContext => {
          const context = loose(routeContext);
          const tenant = await this.#resolveTenant(context);
          if ('response' in tenant) return tenant.response;
          const projectId = context.req.param('id');
          if (!projectId || !UUID_RE.test(projectId)) return context.json({ error: 'Project not found' }, 404);
          const project = await this.#project(tenant.orgId, projectId);
          if (!project) return context.json({ error: 'Project not found' }, 404);
          const capability = this.#builds(context);
          if ('response' in capability) return capability.response;
          const { heads: _heads, ...outcome } = await capability.runner.start(project.id, 'manual');
          return context.json(outcome);
        },
      }),
      registerApiRoute(FACTORY_ROUTE_CONTRACTS.projectEnvironmentBuilds.path, {
        method: FACTORY_ROUTE_CONTRACTS.projectEnvironmentBuilds.method,
        requiresAuth: false,
        handler: async routeContext => {
          const context = loose(routeContext);
          const tenant = await this.#resolveTenant(context);
          if ('response' in tenant) return tenant.response;
          const projectId = context.req.param('id');
          if (!projectId || !UUID_RE.test(projectId)) return context.json({ error: 'Project not found' }, 404);
          const project = await this.#project(tenant.orgId, projectId);
          if (!project) return context.json({ error: 'Project not found' }, 404);
          const capability = this.#builds(context);
          if ('response' in capability) return capability.response;
          if (!capability.builds.list) return context.json({ error: 'no_history' }, 404);
          const read = await capability.runner.readContext(project.id);
          if (!read) return context.json({ error: 'no_environment' }, 404);
          const builds = await capability.builds.list(read.ctx, read.settings);
          return context.json({ builds: builds.map(build => redactBuild(build, buildEnvOf(read.ctx))) });
        },
      }),
      registerApiRoute(FACTORY_ROUTE_CONTRACTS.projectEnvironmentBuildGet.path, {
        method: FACTORY_ROUTE_CONTRACTS.projectEnvironmentBuildGet.method,
        requiresAuth: false,
        handler: async routeContext => {
          const context = loose(routeContext);
          const tenant = await this.#resolveTenant(context);
          if ('response' in tenant) return tenant.response;
          const projectId = context.req.param('id');
          if (!projectId || !UUID_RE.test(projectId)) return context.json({ error: 'Project not found' }, 404);
          const project = await this.#project(tenant.orgId, projectId);
          if (!project) return context.json({ error: 'Project not found' }, 404);
          const capability = this.#builds(context);
          if ('response' in capability) return capability.response;
          // A composite provider id (E2B's `<templateId>:<buildId>`) travels
          // encoded; Hono hands the param back decoded.
          const buildId = context.req.param('buildId') ?? '';
          if (!buildId) return context.json({ error: 'Build not found' }, 404);
          const read = await capability.runner.readContext(project.id);
          if (!read) return context.json({ error: 'no_environment' }, 404);
          // Providers answer for any id on the host's account, so the route
          // only forwards ids that belong to this project: its last build, or
          // one the provider lists under the project's template.
          if (buildId !== project.lastBuildId) {
            const listed = capability.builds.list ? await capability.builds.list(read.ctx, read.settings) : [];
            if (!listed.some(build => build.buildId === buildId)) {
              return context.json({ error: 'Build not found' }, 404);
            }
          }
          const build = await capability.builds.get(read.ctx, read.settings, buildId);
          return context.json({ build: redactBuild(build, buildEnvOf(read.ctx)) });
        },
      }),
    ];
  }

  /** Best effort: a deleted project's cron schedule must not keep firing. */
  async #dropSchedule(projectId: string): Promise<void> {
    const runner = this.deps.environmentBuilds;
    if (!runner?.scheduleAvailable) return;
    try {
      await runner.schedules()!.delete(scheduleIdFor(projectId));
    } catch (error) {
      if (error instanceof MastraError && error.id === 'SCHEDULES_NOT_FOUND') return;
      console.warn('[factory] could not delete the environment build schedule of a deleted project:', error);
    }
  }

  async #retireProjectRepositorySessions(
    handle: SourceControlStorageHandle,
    orgId: string,
    projectRepositoryId: string,
  ): Promise<boolean> {
    const sessions = await handle.sessions.listByProjectRepository({ projectRepositoryId });
    if (sessions.length === 0) return true;
    if (!this.deps.sessionRetirement) return false;
    await this.deps.sessionRetirement.retireProjectRepositorySessions({
      sourceControl: handle,
      ...(this.deps.workItems ? { workItems: this.deps.workItems } : {}),
      orgId,
      projectRepositoryId,
    });
    return true;
  }

  async #resolveTenant(context: Context): Promise<{ orgId: string; userId: string } | { response: Response }> {
    await this.deps.auth.ensureUser(context);
    const tenant = this.deps.auth.tenant(context);
    if (!tenant) return { response: context.json({ error: 'unauthorized' }, 401) };
    if (!tenant.orgId) {
      return {
        response: context.json(
          { error: 'organization_required', message: 'Factory projects require an organization.' },
          403,
        ),
      };
    }
    return { orgId: tenant.orgId, userId: tenant.userId };
  }

  /**
   * The tenant, the project and the instance's facet a model-default route acts on, or the
   * response that refuses it. A Factory's default sets the model and reasoning spend of every
   * session and run of that harness that has not picked its own, so it is admin-only.
   */
  async #modelDefaultTarget(
    context: Context,
    contract: { pathSchema: { safeParse(input: unknown): { success: true; data: { id: string; instanceId: string } } | { success: false } } },
    adminMessage: string,
  ): Promise<
    | { response: Response }
    | { tenant: { orgId: string; userId: string }; project: FactoryProject; facet: HarnessModels }
  > {
    const tenant = await this.#resolveTenant(context);
    if ('response' in tenant) return tenant;
    const parsedPath = contract.pathSchema.safeParse({
      id: context.req.param('id'),
      instanceId: context.req.param('instanceId'),
    });
    if (!parsedPath.success) return { response: context.json({ error: 'Project not found' }, 404) };
    const project = await this.#project(tenant.orgId, parsedPath.data.id);
    if (!project) return { response: context.json({ error: 'Project not found' }, 404) };
    if (this.deps.auth.enabled() && !(await this.deps.auth.isOrganizationAdmin(context, tenant.orgId))) {
      return { response: context.json({ error: 'forbidden', message: adminMessage }, 403) };
    }
    const facet = this.deps.harnessModels?.()?.forInstance(parsedPath.data.instanceId);
    if (!facet) {
      return {
        response: context.json(
          { error: 'unknown_instance', message: `This server runs no harness with model instance ${parsedPath.data.instanceId}.` },
          404,
        ),
      };
    }
    return { tenant, project, facet };
  }

  /**
   * `PUT|DELETE /web/factory/projects/:id/model-defaults/:instanceId` and its `/apply`: one route
   * set for every harness, which its facet answers (`check`, `applyDefaultToRunningSessions`).
   */
  #modelDefaultRoutes(): ApiRoute[] {
    const contextFor = (
      tenant: { orgId: string; userId: string },
      factoryProjectId: string,
    ): HarnessModelContext & { factoryProjectId: string } => ({
      viewer: { userId: tenant.userId, orgId: tenant.orgId },
      factoryProjectId,
    });
    return [
      registerApiRoute(FACTORY_ROUTE_CONTRACTS.projectModelDefaultSet.path, {
        method: FACTORY_ROUTE_CONTRACTS.projectModelDefaultSet.method,
        requiresAuth: false,
        handler: async routeContext => {
          const context = loose(routeContext);
          const target = await this.#modelDefaultTarget(
            context,
            FACTORY_ROUTE_CONTRACTS.projectModelDefaultSet,
            'Organization administrator access is required to change the default model.',
          );
          if ('response' in target) return target.response;
          const parsedBody = FACTORY_ROUTE_CONTRACTS.projectModelDefaultSet.bodySchema.safeParse(await readJson(context));
          if (!parsedBody.success) return context.json({ error: 'invalid_model_default' }, 400);
          const { tenant, project, facet } = target;
          const checked = await facet.check(
            { model: parsedBody.data.model, ...(parsedBody.data.options ? { options: parsedBody.data.options } : {}) },
            contextFor(tenant, project.id),
          );
          if (!checked.ok) return context.json({ error: 'invalid_model_default', message: checked.error }, 400);
          const updated = await (await this.#projects()).update({
            orgId: tenant.orgId,
            id: project.id,
            input: async current => ({
              harnessModelDefaults: withHarnessModelDefault(current.harnessModelDefaults, facet.instanceId, checked.selection),
            }),
          });
          if (!updated) return context.json({ error: 'Project not found' }, 404);
          return context.json({ project: updated, selection: checked.selection });
        },
      }),
      registerApiRoute(FACTORY_ROUTE_CONTRACTS.projectModelDefaultClear.path, {
        method: FACTORY_ROUTE_CONTRACTS.projectModelDefaultClear.method,
        requiresAuth: false,
        handler: async routeContext => {
          const context = loose(routeContext);
          const target = await this.#modelDefaultTarget(
            context,
            FACTORY_ROUTE_CONTRACTS.projectModelDefaultClear,
            'Organization administrator access is required to change the default model.',
          );
          if ('response' in target) return target.response;
          const { tenant, project, facet } = target;
          const updated = await (await this.#projects()).update({
            orgId: tenant.orgId,
            id: project.id,
            input: async current => ({
              harnessModelDefaults: withHarnessModelDefault(current.harnessModelDefaults, facet.instanceId, null),
            }),
          });
          return updated ? context.json({ project: updated }) : context.json({ error: 'Project not found' }, 404);
        },
      }),
      registerApiRoute(FACTORY_ROUTE_CONTRACTS.projectModelDefaultApply.path, {
        method: FACTORY_ROUTE_CONTRACTS.projectModelDefaultApply.method,
        requiresAuth: false,
        handler: async routeContext => {
          const context = loose(routeContext);
          const target = await this.#modelDefaultTarget(
            context,
            FACTORY_ROUTE_CONTRACTS.projectModelDefaultApply,
            'Organization administrator access is required to update running sessions.',
          );
          if ('response' in target) return target.response;
          const { tenant, project, facet } = target;
          const selection = project.harnessModelDefaults[facet.instanceId];
          if (!selection) {
            return context.json(
              { error: 'default_model_not_set', message: `Set a default ${facet.displayName} model on the project first.` },
              400,
            );
          }
          if (!facet.applyDefaultToRunningSessions) {
            return context.json(
              {
                error: 'model_apply_unavailable',
                message: `${facet.displayName} sessions pick a new default up on their own, from their next turn.`,
              },
              409,
            );
          }
          const apply = facet.applyDefaultToRunningSessions.bind(facet);
          // Do not hold the HTTP request open while visiting every running session: a slow session
          // gateway can take longer than the proxy timeout. Runs for one Factory and harness instance
          // go one after another, so an older slow write cannot overwrite a newer request.
          const runKey = `${tenant.orgId}:${project.id}:${facet.instanceId}`;
          const projects = await this.#projects();
          // A default changed while this job was queued or running must not be written by this job.
          const stillCurrent = async () =>
            (await projects.get({ orgId: tenant.orgId, id: project.id }))?.harnessModelDefaults[facet.instanceId]
              ?.model === selection.model;
          const priorRun = applyDefaultModelRuns.get(runKey);
          const run = (priorRun ? priorRun.catch(() => {}) : Promise.resolve()).then(async () => {
            if (!(await stillCurrent())) return;
            const result = await apply(selection, { ...contextFor(tenant, project.id), stillCurrent });
            console.info('[factory] apply-default-model completed', {
              projectId: project.id,
              instanceId: facet.instanceId,
              model: selection.model,
              applied: result.applied.length,
              skipped: result.skipped.length,
            });
          });
          applyDefaultModelRuns.set(runKey, run);
          void run
            .catch(error => {
              console.error('[factory] apply-default-model failed', {
                projectId: project.id,
                instanceId: facet.instanceId,
                model: selection.model,
                error,
              });
            })
            .finally(() => {
              if (applyDefaultModelRuns.get(runKey) === run) applyDefaultModelRuns.delete(runKey);
            });
          return context.json({ selection, status: 'started' as const }, 202);
        },
      }),
    ];
  }

  routes(): ApiRoute[] {
    return [
      registerApiRoute(FACTORY_ROUTE_CONTRACTS.projectList.path, {
        method: FACTORY_ROUTE_CONTRACTS.projectList.method,
        requiresAuth: false,
        handler: async routeContext => {
          const context = loose(routeContext);
          const tenant = await this.#resolveTenant(context);
          if ('response' in tenant) return tenant.response;
          const projects = await (await this.#projects()).list({ orgId: tenant.orgId });
          const repositories = await this.#linkedRepositoriesByProject(
            tenant.orgId,
            projects.map(project => project.id),
          );
          return context.json({
            projects: projects.map(project => ({ ...project, repositories: repositories.get(project.id) ?? [] })),
          });
        },
      }),
      registerApiRoute(FACTORY_ROUTE_CONTRACTS.projectCreate.path, {
        method: FACTORY_ROUTE_CONTRACTS.projectCreate.method,
        requiresAuth: false,
        handler: async routeContext => {
          const context = loose(routeContext);
          const tenant = await this.#resolveTenant(context);
          if ('response' in tenant) return tenant.response;
          const parsed = FACTORY_ROUTE_CONTRACTS.projectCreate.bodySchema.safeParse(await readJson(context));
          if (!parsed.success) return context.json({ error: 'invalid_project' }, 400);
          const project = await (
            await this.#projects()
          ).create({ orgId: tenant.orgId, userId: tenant.userId, input: parsed.data });
          // A new project gets today's Work, without Triage; a project that existed before keeps the
          // Work it had. The project's first board load retries anything this misses, with Work as
          // it was for older projects, as this one can't be told apart from them by then.
          await this.deps.boards?.seedNewProject({ orgId: tenant.orgId, factoryProjectId: project.id }).catch(error => {
            console.warn('[factory] could not store the boards of a new project:', error);
          });
          return context.json({ project }, 201);
        },
      }),
      registerApiRoute(FACTORY_ROUTE_CONTRACTS.projectGet.path, {
        method: FACTORY_ROUTE_CONTRACTS.projectGet.method,
        requiresAuth: false,
        handler: async routeContext => {
          const context = loose(routeContext);
          const tenant = await this.#resolveTenant(context);
          if ('response' in tenant) return tenant.response;
          const parsedPath = FACTORY_ROUTE_CONTRACTS.projectGet.pathSchema.safeParse({ id: context.req.param('id') });
          if (!parsedPath.success) return context.json({ error: 'Project not found' }, 404);
          const { id } = parsedPath.data;
          const project = await this.#project(tenant.orgId, id);
          return project ? context.json({ project }) : context.json({ error: 'Project not found' }, 404);
        },
      }),
      registerApiRoute(FACTORY_ROUTE_CONTRACTS.projectUpdate.path, {
        method: FACTORY_ROUTE_CONTRACTS.projectUpdate.method,
        requiresAuth: false,
        handler: async routeContext => {
          const context = loose(routeContext);
          const tenant = await this.#resolveTenant(context);
          if ('response' in tenant) return tenant.response;
          const parsedPath = FACTORY_ROUTE_CONTRACTS.projectUpdate.pathSchema.safeParse({
            id: context.req.param('id'),
          });
          if (!parsedPath.success) return context.json({ error: 'Project not found' }, 404);
          const parsedBody = FACTORY_ROUTE_CONTRACTS.projectUpdate.bodySchema.safeParse(await readJson(context));
          if (!parsedBody.success) return context.json({ error: 'invalid_project' }, 400);
          // Tool permissions are shared by everyone working in the Factory and YOLO lets
          // every call through, so they are admin-only.
          const adminField = parsedBody.data.toolPermissions !== undefined ? 'tool permissions' : undefined;
          if (
            adminField &&
            this.deps.auth.enabled() &&
            !(await this.deps.auth.isOrganizationAdmin(context, tenant.orgId))
          ) {
            return context.json(
              {
                error: 'forbidden',
                message: `Organization administrator access is required to change the ${adminField}.`,
              },
              403,
            );
          }
          // Retired project switches an old client may still send: the board owns automation now
          // (`autoStart`, `exitTool.autoApprove`, a self-review phase), and the review skill decides
          // whether to publish its test check.
          const {
            autoApprovePlans: _plans,
            autoRunEnabled: _autoRun,
            reviewTestChecksEnabled: _testChecks,
            selfReviewEnabled: _selfReview,
            ...input
          } = parsedBody.data;
          const project = await (await this.#projects()).update({ orgId: tenant.orgId, id: parsedPath.data.id, input });
          return project ? context.json({ project }) : context.json({ error: 'Project not found' }, 404);
        },
      }),
      ...this.#modelDefaultRoutes(),
      registerApiRoute(FACTORY_ROUTE_CONTRACTS.projectDelete.path, {
        method: FACTORY_ROUTE_CONTRACTS.projectDelete.method,
        requiresAuth: false,
        handler: async routeContext => {
          const context = loose(routeContext);
          const tenant = await this.#resolveTenant(context);
          if ('response' in tenant) return tenant.response;
          const parsedPath = FACTORY_ROUTE_CONTRACTS.projectDelete.pathSchema.safeParse({
            id: context.req.param('id'),
          });
          if (!parsedPath.success) return context.json({ error: 'Project not found' }, 404);
          const { id } = parsedPath.data;
          if (!(await this.#project(tenant.orgId, id))) return context.json({ error: 'Project not found' }, 404);
          for (const handle of await this.#handles()) {
            for (const connection of await handle.connections.list({ orgId: tenant.orgId, factoryProjectId: id })) {
              for (const projectRepository of await handle.projectRepositories.list({
                orgId: tenant.orgId,
                connectionId: connection.id,
              })) {
                if (!(await this.#retireProjectRepositorySessions(handle, tenant.orgId, projectRepository.id))) {
                  return context.json({ error: 'session_retirement_unavailable' }, 409);
                }
              }
              await handle.connections.delete({ orgId: tenant.orgId, id: connection.id });
            }
          }
          await (
            await this.#projects()
          ).delete({ orgId: tenant.orgId, id }, await this.#intakeRelease(tenant.orgId, id));
          await this.#dropSchedule(id);
          return context.body(null, 204);
        },
      }),
      registerApiRoute('/web/factory/projects/:id/source-control-connections', {
        method: 'GET',
        requiresAuth: false,
        handler: async routeContext => {
          const context = loose(routeContext);
          const tenant = await this.#resolveTenant(context);
          if ('response' in tenant) return tenant.response;
          const projectId = context.req.param('id');
          if (!projectId || !UUID_RE.test(projectId) || !(await this.#project(tenant.orgId, projectId)))
            return context.json({ error: 'Project not found' }, 404);
          return context.json({ connections: await this.#connectionsWithRepositories(tenant.orgId, [projectId]) });
        },
      }),
      registerApiRoute('/web/factory/projects/:id/source-control-connections', {
        method: 'POST',
        requiresAuth: false,
        handler: async routeContext => {
          const context = loose(routeContext);
          const tenant = await this.#resolveTenant(context);
          if ('response' in tenant) return tenant.response;
          const projectId = context.req.param('id');
          if (!projectId || !UUID_RE.test(projectId) || !(await this.#project(tenant.orgId, projectId)))
            return context.json({ error: 'Project not found' }, 404);
          const input = parseConnectionInput(await readJson(context));
          if (!input) return context.json({ error: 'invalid_source_control_connection' }, 400);
          if (!this.#versionControlIntegrationIds.has(input.integrationId))
            return context.json({ error: 'Source-control integration not found' }, 404);
          const handle = (await this.#sourceControl()).forIntegration(input.integrationId);
          if (!(await handle.installations.get({ orgId: tenant.orgId, id: input.installationId })))
            return context.json({ error: 'Source-control installation not found' }, 404);
          const connection = await handle.connections.create({
            orgId: tenant.orgId,
            factoryProjectId: projectId,
            installationId: input.installationId,
            createdByUserId: tenant.userId,
          });
          return context.json({ connection }, 201);
        },
      }),
      registerApiRoute('/web/factory/projects/:id/source-control-connections/:connectionId', {
        method: 'DELETE',
        requiresAuth: false,
        handler: async routeContext => {
          const context = loose(routeContext);
          const tenant = await this.#resolveTenant(context);
          if ('response' in tenant) return tenant.response;
          const projectId = context.req.param('id');
          const connectionId = context.req.param('connectionId');
          if (!projectId || !UUID_RE.test(projectId) || !connectionId || !UUID_RE.test(connectionId))
            return context.json({ error: 'Source-control connection not found' }, 404);
          const found = await this.#findConnection({ orgId: tenant.orgId, projectId, id: connectionId });
          if (!found) return context.json({ error: 'Source-control connection not found' }, 404);
          for (const projectRepository of await found.handle.projectRepositories.list({
            orgId: tenant.orgId,
            connectionId,
          })) {
            if (!(await this.#retireProjectRepositorySessions(found.handle, tenant.orgId, projectRepository.id))) {
              return context.json({ error: 'session_retirement_unavailable' }, 409);
            }
          }
          await found.handle.connections.delete({ orgId: tenant.orgId, id: connectionId });
          return context.body(null, 204);
        },
      }),
      registerApiRoute('/web/factory/projects/:id/source-control-connections/:connectionId/repositories', {
        method: 'POST',
        requiresAuth: false,
        handler: async routeContext => {
          const context = loose(routeContext);
          const tenant = await this.#resolveTenant(context);
          if ('response' in tenant) return tenant.response;
          const projectId = context.req.param('id');
          const connectionId = context.req.param('connectionId');
          if (!projectId || !UUID_RE.test(projectId) || !connectionId || !UUID_RE.test(connectionId))
            return context.json({ error: 'Source-control connection not found' }, 404);
          const found = await this.#findConnection({ orgId: tenant.orgId, projectId, id: connectionId });
          if (!found) return context.json({ error: 'Source-control connection not found' }, 404);
          const input = parseRepositoryLinkInput(await readJson(context));
          if (!input) return context.json({ error: 'invalid_project_repository' }, 400);
          const repository = input.repositoryId
            ? await found.handle.repositories.get({ orgId: tenant.orgId, id: input.repositoryId })
            : input.repository && this.deps.resolveRepository
              ? await this.deps.resolveRepository({
                  integrationId: found.connection.integrationId,
                  orgId: tenant.orgId,
                  userId: tenant.userId,
                  installationId: found.connection.installationId,
                  ...input.repository,
                })
              : null;
          if (!repository || repository.installationId !== found.connection.installationId)
            return context.json({ error: 'Source-control repository not found' }, 404);
          const { repositoryId: _repositoryId, repository: _repository, ...linkInput } = input;
          const projectRepository = await found.handle.projectRepositories.link({
            orgId: tenant.orgId,
            connectionId,
            createdByUserId: tenant.userId,
            repositoryId: repository.id,
            ...linkInput,
          });
          try {
            this.deps.onProjectRepositoryLinked?.({
              orgId: tenant.orgId,
              integrationId: found.connection.integrationId,
              projectRepository,
            });
          } catch (error) {
            console.warn('[factory] onProjectRepositoryLinked failed after a successful repository link:', error);
          }
          return context.json(
            { projectRepository: await this.#repositoryPayload(found.handle, tenant.orgId, projectRepository) },
            201,
          );
        },
      }),
      registerApiRoute(FACTORY_ROUTE_CONTRACTS.projectEnvironmentGet.path, {
        method: FACTORY_ROUTE_CONTRACTS.projectEnvironmentGet.method,
        requiresAuth: false,
        handler: async routeContext => {
          const context = loose(routeContext);
          const tenant = await this.#resolveTenant(context);
          if ('response' in tenant) return tenant.response;
          const projectId = context.req.param('id');
          if (!projectId || !UUID_RE.test(projectId)) return context.json({ error: 'Project not found' }, 404);
          const project = await this.#project(tenant.orgId, projectId);
          if (!project) return context.json({ error: 'Project not found' }, 404);
          return context.json(await this.#environmentPayload(tenant.orgId, project));
        },
      }),
      registerApiRoute(FACTORY_ROUTE_CONTRACTS.projectEnvironmentUpdate.path, {
        method: FACTORY_ROUTE_CONTRACTS.projectEnvironmentUpdate.method,
        requiresAuth: false,
        handler: async routeContext => {
          const context = loose(routeContext);
          const tenant = await this.#resolveTenant(context);
          if ('response' in tenant) return tenant.response;
          const projectId = context.req.param('id');
          if (!projectId || !UUID_RE.test(projectId)) return context.json({ error: 'Project not found' }, 404);
          const project = await this.#project(tenant.orgId, projectId);
          if (!project) return context.json({ error: 'Project not found' }, 404);
          const parsed = FACTORY_ROUTE_CONTRACTS.projectEnvironmentUpdate.bodySchema.safeParse(await readJson(context));
          if (!parsed.success) return context.json({ error: 'invalid_environment' }, 400);
          const {
            repositories: repositoryPatches,
            settings: settingsPatch,
            buildTriggers,
            ...projectInput
          } = parsed.data;
          const input: UpdateFactoryProjectInput = projectInput;
          const runner = this.deps.environmentBuilds;
          if (buildTriggers !== undefined) {
            if (!runner) return context.json({ error: 'no_builds' }, 400);
            if (buildTriggers.push?.enabled !== undefined) input.buildOnPushEnabled = buildTriggers.push.enabled;
            if (buildTriggers.push?.debounceMinutes !== undefined) {
              input.buildPushDebounceMinutes = buildTriggers.push.debounceMinutes;
            }
            if (buildTriggers.schedule) {
              if (!runner.scheduleAvailable) {
                if (buildTriggers.schedule.enabled) return context.json({ error: 'schedules_unavailable' }, 400);
              } else {
                const { cron, timezone } = buildTriggers.schedule;
                const stored = await readSchedule(runner.schedules()!, project.id);
                const nextCron = cron ?? stored.cron;
                // Disabling a schedule that never existed needs no cron: it is a no-op.
                if (!nextCron && buildTriggers.schedule.enabled)
                  return context.json(
                    {
                      error: 'invalid_environment',
                      issues: [{ message: 'cron is required', path: ['buildTriggers', 'schedule', 'cron'] }],
                    },
                    400,
                  );
                const nextTimezone = timezone ?? stored.timezone ?? undefined;
                const message = nextCron ? invalidCronMessage(nextCron, nextTimezone) : undefined;
                if (message) {
                  return context.json(
                    {
                      error: 'invalid_environment',
                      issues: [{ message, path: ['buildTriggers', 'schedule', 'cron'] }],
                    },
                    400,
                  );
                }
              }
            }
          }
          if (settingsPatch !== undefined && !this.deps.sandbox) return context.json({ error: 'no_sandbox' }, 400);

          let updated = project;
          if (Object.keys(input).length > 0 || settingsPatch !== undefined || repositoryPatches !== undefined) {
            let issues: ReadonlyArray<{ message: string; path?: unknown }> | undefined;
            let repositoryOutcome: 'updated' | 'not_found' | 'incomplete_reorder' | undefined;
            const sourceControl = await this.#sourceControl();
            // One transaction holds the project row, so the settings merge and the link
            // writes either all land or none do, and concurrent patches apply in turn.
            const result = await (
              await this.#projects()
            ).update({
              orgId: tenant.orgId,
              id: projectId,
              input: async (current, ops) => {
                let sandboxSettings: Record<string, unknown> | null | undefined;
                if (settingsPatch !== undefined) {
                  const settings = await this.#mergeSettings(current.sandboxSettings ?? {}, settingsPatch);
                  if ('issues' in settings) {
                    issues = settings.issues;
                    return null;
                  }
                  sandboxSettings = settings.merged;
                }
                if (repositoryPatches !== undefined) {
                  repositoryOutcome = await sourceControl.updateEnvironmentRepositories(ops, {
                    factoryProjectId: current.id,
                    integrationIds: [...this.#versionControlIntegrationIds],
                    patches: repositoryPatches,
                  });
                  if (repositoryOutcome !== 'updated') return null;
                }
                return { ...input, ...(sandboxSettings !== undefined ? { sandboxSettings } : {}) };
              },
            });
            if (repositoryOutcome === 'not_found') return context.json({ error: 'Project repository not found' }, 404);
            if (repositoryOutcome === 'incomplete_reorder') return context.json({ error: 'invalid_environment' }, 400);
            if (issues) {
              return context.json(
                {
                  error: 'invalid_environment',
                  issues: issues.map(issue => ({
                    message: issue.message,
                    path: Array.isArray(issue.path)
                      ? issue.path.map(segment =>
                          typeof segment === 'object' && segment !== null && 'key' in segment ? segment.key : segment,
                        )
                      : [],
                  })),
                },
                400,
              );
            }
            if (!result) return context.json({ error: 'Project not found' }, 404);
            updated = result;
          }
          if (buildTriggers?.schedule && runner?.scheduleAvailable) {
            const stored = await readSchedule(runner.schedules()!, project.id);
            const cron = buildTriggers.schedule.cron ?? stored.cron;
            // Without a cron the request disables a schedule that never existed: nothing to write.
            if (cron)
              await ensureSchedule(runner.schedules()!, project.id, {
                enabled: buildTriggers.schedule.enabled,
                cron,
                ...((buildTriggers.schedule.timezone ?? stored.timezone)
                  ? { timezone: (buildTriggers.schedule.timezone ?? stored.timezone)! }
                  : {}),
              });
          }
          // Saving never builds: the next Build now, schedule or push run
          // picks the changed template up.
          return context.json(await this.#environmentPayload(tenant.orgId, updated));
        },
      }),
      registerApiRoute('/web/factory/projects/:id/repositories/:projectRepositoryId', {
        method: 'PATCH',
        requiresAuth: false,
        handler: async routeContext => {
          const context = loose(routeContext);
          const tenant = await this.#resolveTenant(context);
          if ('response' in tenant) return tenant.response;
          const projectId = context.req.param('id');
          const projectRepositoryId = context.req.param('projectRepositoryId');
          if (!projectId || !UUID_RE.test(projectId) || !projectRepositoryId || !UUID_RE.test(projectRepositoryId))
            return context.json({ error: 'Project repository not found' }, 404);
          const found = await this.#findProjectRepository({ orgId: tenant.orgId, projectId, id: projectRepositoryId });
          if (!found) return context.json({ error: 'Project repository not found' }, 404);
          const input = parseRepositoryUpdateInput(await readJson(context));
          if (!input) return context.json({ error: 'invalid_project_repository' }, 400);
          const projectRepository = await found.handle.projectRepositories.update({
            orgId: tenant.orgId,
            id: projectRepositoryId,
            input,
          });
          return context.json({
            projectRepository: await this.#repositoryPayload(found.handle, tenant.orgId, projectRepository!),
          });
        },
      }),
      registerApiRoute('/web/factory/projects/:id/repositories/:projectRepositoryId', {
        method: 'DELETE',
        requiresAuth: false,
        handler: async routeContext => {
          const context = loose(routeContext);
          const tenant = await this.#resolveTenant(context);
          if ('response' in tenant) return tenant.response;
          const projectId = context.req.param('id');
          const projectRepositoryId = context.req.param('projectRepositoryId');
          if (!projectId || !UUID_RE.test(projectId) || !projectRepositoryId || !UUID_RE.test(projectRepositoryId))
            return context.json({ error: 'Project repository not found' }, 404);
          const found = await this.#findProjectRepository({ orgId: tenant.orgId, projectId, id: projectRepositoryId });
          if (!found) return context.json({ error: 'Project repository not found' }, 404);
          if (!(await this.#retireProjectRepositorySessions(found.handle, tenant.orgId, projectRepositoryId))) {
            return context.json({ error: 'session_retirement_unavailable' }, 409);
          }
          await found.handle.projectRepositories.unlink({ orgId: tenant.orgId, id: projectRepositoryId });
          return context.body(null, 204);
        },
      }),
      ...this.#buildRoutes(),
    ];
  }
}
