import type { AuthStorage } from '@mastra/code-sdk/auth/storage';
import type { MastraCodeState } from '@mastra/code-sdk/schema';
import type { AgentController } from '@mastra/core/agent-controller';
import type { ApiRoute, IUserProvider } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import type { InlineSkill } from '@mastra/core/skills';
import type { FactoryStorage } from '@mastra/core/storage';
import type { FactorySandbox } from '@mastra/core/workspace';

import {
  boardFlow,
  boardForWorkItem,
  hasPullRequest,
  isPullRequestReviewPhase,
  legacyPlanRoleFor,
  REVIEW_CONTEXT,
  reviewedChangeRequest,
} from '@factory/core';
import type { BoardRegistry, InstalledBoard, IntakeRoutesReader } from '@factory/core';
import { buildConnectionRoutes } from '@factory/integrations';
import type {
  ConnectorRegistration,
  FactoryIntegration,
  IntegrationConnections,
  IntegrationContext,
  IntegrationHooks,
} from '@factory/integrations';
import { getGithubFeatureDiagnostics } from '@factory/integration-github';
import type { GithubIntegration } from '@factory/integration-github';
import { MaterializeError } from '@factory/sandbox';
import { FactoryDispatchError, secretKeyMismatchHint, secretKeyProblem } from '@factory/store';
import type { FactorySecretDecryptionError } from '@factory/store';
import { toBoardSource } from '@factory/runtime';
import type { FactoryBindingPreparationInput, ProjectBoardCache, ProjectBoardSource } from '@factory/runtime';
import { createMastraHarness, FactoryStartCoordinator } from '@factory/harness-mastra';
import { HarnessRoutingStartCoordinator } from './harness-start.ts';
import type { HarnessStartCoordinators } from './harness-start.ts';
import { FactoryTransitionService } from '@factory/runtime';
import {
  createSourceControlSessionLookup,
  ensureFactorySourceSession,
  FactorySourceSessionResolutionError,
  resolveFactorySourceControl,
} from '@factory/session';
import type { EnsuredFactorySourceSession } from '@factory/session';
import type { LiveSessions } from '@factory/session';
import { resolveWorkItemRepository, workItemRunsInLink } from '@factory/session';
import type { StateSigner } from '@factory/auth';
import type { AuditEmitter, AuditRecorder } from '@factory/feed';
import type { ChannelIdentityStorage, SkillOverridesStorage, StoredBoardsStorage } from '@factory/store';
import type { WorkItemCommentsStorage } from '@factory/store';
import type { AttachmentService } from '@factory/store';
import type { CommentsDomain } from '@factory/feed';
import type { ModelCredentialsStorage } from '@factory/store';
import type { CustomProvidersStorage } from '@factory/store';
import type { FilesystemStorage } from '@factory/store';
import type { IntakeStorage } from '@factory/store';
import type { IntegrationStorage } from '@factory/store';
import type { MemorySettingsStorage } from '@factory/store';
import type { FactoryProjectsStorage } from '@factory/store';
import type { QueueHealthStorage } from '@factory/store';
import {
  SessionBranchHeldError,
  SessionOwnershipMismatchError,
  SourceControlConnectionNotFoundError,
} from '@factory/store';
import type { SourceControlStorage, SourceControlStorageHandle } from '@factory/store';
import { isAgentActor } from '@factory/store';
import type { FactoryDispatchFailureCode, WorkItemsStorage } from '@factory/store';
import { workItemSource } from '@factory/core';
import {
  legacyGithubWorkItemBranch,
  pullRequestBranch,
  workItemBranch,
  workItemThreadTitle,
  workLaneForRole,
} from '@factory/pipelines';
import type { WorkItemBranchSource } from '@factory/pipelines';
import { buildAutomationRunRoutes } from './automation-runs.ts';
import { ConfigRoutes } from './config.ts';
import type { HarnessExecutableReport } from '@factory/harness/executable';
import type { HarnessModelRegistry } from '@factory/harness/models/registry';
import { CLAUDE_CODE_HARNESS, CODEX_HARNESS, HARNESSES } from '@factory/contracts';
import { createAgentAccountsConnections } from './agent-connections.ts';
import { SIGN_IN_ACCOUNT_PROVIDERS } from './credential-accounts.ts';
import type { AccountSignInFlows } from './credential-accounts.ts';
import { invalidateCustomProvidersSnapshots } from './custom-provider-source.ts';
import { buildFsRoutes } from './fs.ts';
import type { LocalCheckoutAttacher } from './fs.ts';
import { IntakeRouteRoutes } from './intake-routes.ts';
import type { IntakeTriggerEngine } from '@factory/runtime';
import type { IntakeRouteFiresStorage } from '@factory/store';
import { IntakeRoutes } from './intake.ts';
import { KnowledgeRoutes } from './knowledge.ts';
import { OAuthRoutes } from './oauth.ts';
import type { RouteAuth } from '@factory/http';
import { BoardRoutes } from './boards.ts';
import { SkillRoutes } from './skills.ts';
import { AttachmentRoutes } from './attachments.ts';
import { buildSourceControlSessionRoutes } from './source-control-sessions.ts';
import type { ClaudeCodeUserSessions } from './source-control-sessions.ts';
import { buildSourceControlSettingsRoutes } from './source-control-settings.ts';
import { invalidateTenantCredentialSnapshots } from '@factory/credentials';
import { WorkItemRoutes } from './work-items.ts';
import { UsageRoutes } from './usage.ts';
import type { UsageRoutesDeps } from './usage.ts';

const MATERIALIZE_FAILURE_CODE = {
  'git-missing': 'repository_git_missing',
  'egress-blocked': 'repository_egress_blocked',
  'clone-failed': 'repository_clone_failed',
  'pull-failed': 'repository_pull_failed',
  'push-failed': 'repository_push_failed',
  'commit-failed': 'repository_commit_failed',
  'gh-missing': 'repository_cli_missing',
  'pr-failed': 'repository_pr_failed',
} satisfies Record<MaterializeError['code'], FactoryDispatchFailureCode>;
export interface IntegrationRegistration {
  integration: FactoryIntegration;
  ready: boolean;
  ensureReady: () => Promise<void>;
}

export interface FactoryApiRoutesDeps {
  /** App skills from `MastraFactory({ skills })`. */
  skills?: readonly InlineSkill[];
  /** Card and session attachments; without it their routes answer 503 `attachments_unconfigured`. */
  attachments?: AttachmentService;
  /** Intake rules (Settings › Intake): their engine and storage; without them the routes are not mounted. */
  /** Routes «За розкладом»: their trigger engine and fire log (ADR-0021). */
  intakeTriggers?: { engine: IntakeTriggerEngine; fires: IntakeRouteFiresStorage };
  /** Token usage and accounts' allowances (`UsageRoutes`); without it their routes are not mounted. */
  usage?: Pick<UsageRoutesDeps, 'usage' | 'harnesses'>;
  controllerId: string;
  controller: AgentController<MastraCodeState>;
  /** Registry of the sessions this process holds, owned by the host so it can watch them too. */
  liveSessions: LiveSessions;
  /** Request-auth seam threaded from the host (no service locator). */
  auth: RouteAuth;
  /** Optional user directory for resolving persisted owners to display profiles. */
  users?: Pick<IUserProvider, 'getUser' | 'getUsers'>;
  authStorage: AuthStorage;
  audit: AuditEmitter & AuditRecorder;
  fsRoot?: string;
  publicOrigin: string;
  stateSigner?: StateSigner;
  /** Sandbox surface (enablement, provider label, create callback). */
  sandbox?: FactorySandbox;
  /** Push hand-off for environment builds, present when the sandbox can build templates. */
  onRepositoryPush?: IntegrationHooks['onRepositoryPush'];
  /** Syncs an organization's integration-managed MCP servers after an integration's settings change. */
  onManagedMcpServersChanged?: IntegrationHooks['onManagedMcpServersChanged'];
  /** Root factory storage backend (distributed locks, app-db diagnostics). */
  factoryStorage?: FactoryStorage;
  integrationStorage: IntegrationStorage;
  sourceControlStorage: SourceControlStorage;
  /** App-table domain handles, registered and owned by `MastraFactory.prepare()`. */
  domains: {
    intake: IntakeStorage;
    modelCredentials: ModelCredentialsStorage;
    memorySettings: MemorySettingsStorage;
    customProviders: CustomProvidersStorage;
    filesystem: FilesystemStorage;
    projects: FactoryProjectsStorage;
    queueHealth: QueueHealthStorage;
    workItems: WorkItemsStorage;
    channelIdentity: ChannelIdentityStorage;
    comments: WorkItemCommentsStorage;
    skillOverrides: SkillOverridesStorage;
  };
  integrations?: IntegrationRegistration[];
  /** Connectors that are not integrations (the MCP servers), served by the same `/web/connections` registry. */
  connectors?: ConnectorRegistration[];
  intakeReady: boolean;
  factoryReady: boolean;
  knowledgeEnabled: boolean;
  /** The Factory MCP endpoint is mounted; surfaced so the UI can show its URL. */
  mcpEnabled: boolean;
  /** The Claude Code harness is configured, so new factories may pick `harness: 'claude-code'`. */
  claudeCodeEnabled?: boolean;
  /** The Codex harness runs here (the `codex` CLI is installed), so factories may pick `harness: 'codex'`. */
  codexEnabled?: boolean;
  /** Every harness's model facet: `/web/config/models` `instances` and a session's `switchModel` / `modelInstanceId`. */
  harnessModels?: () => Pick<HarnessModelRegistry, 'describe' | 'forSession' | 'forInstance'> | undefined;
  /** The CLIs the turn-based harnesses spawn, for `/web/config/versions` (ADR-0038). */
  harnessExecutables?: () => Promise<HarnessExecutableReport[]>;
  /** Device preview (`/web/device`) is mounted: simulators and emulators on this server's machine. */
  deviceEnabled?: boolean;
  /** Claude sign-in on this host (local development): `claude auth login`, kept as the person's account. */
  claudeSignIn?: AccountSignInFlows;
  /** Codex sign-in on this host (local development): `codex login`, kept as the person's account. */
  codexSignIn?: AccountSignInFlows;
  /** Personal sessions of Claude Code Factories start in the Claude Code harness (see the session routes). */
  claudeCodeUserSessions?: ClaudeCodeUserSessions;
  /** With a local sandbox: attaches a session's checkout on disk without starting it (file panels, sandbox start). */
  attachLocalCheckout?: LocalCheckoutAttacher;
  /** With a local sandbox: sets a Claude Code or Codex session's checkout up when none is on disk (sandbox start). */
  createLocalCheckout?: LocalCheckoutAttacher;
  /** Providers the operator opted in to run on the server process's own credentials. */
  deploymentModelProviders?: ReadonlySet<string>;
  knowledgeKey?: string;
  /** Resolved Factory rule set, threaded from the host (no service locator). */
  configVersion: string;
  /** Each project's boards; integrations use the code boards (`codeRegistry`). */
  boardRegistry: BoardRegistry | ProjectBoardSource;
  /** Stored boards and their cache; mounts the board management routes when present. */
  storedBoards?: { storage: StoredBoardsStorage; cache: ProjectBoardCache };
  /** Work-item feed service, handed to integrations that ingest platform messages. */
  feed: CommentsDomain;
  factoryTransitionService?: FactoryTransitionService;
  sessionRetirement?: import('@factory/sandbox').SessionRetirementCoordinator;
  /** Releases a deleted card's sandbox folder and stops its sessions (see `WorkItemRoutes`). */
  releaseWorkItemSandboxes?: (item: import('@factory/store').Card) => Promise<void>;
  /** Told when a session is deleted without a retirement coordinator (see `SourceControlSessionRoutes`). */
  onSessionDeleted?: (sessionId: string) => Promise<void> | void;
  /** Moves a thread with its observation vectors onto another memory resource. */
  moveThread?: (input: { threadId: string; resourceId: string }) => Promise<unknown>;
  /** Start paths of the other harnesses a factory may be created with (see `HarnessRoutingStartCoordinator`). */
  harnessStartCoordinators?: HarnessStartCoordinators;
  onFactoryRuntime?: (runtime: {
    transitionService: FactoryTransitionService;
    startCoordinator: FactoryStartCoordinator;
    prepareBinding?: (input: FactoryBindingPreparationInput) => Promise<void>;
  }) => void;
}

const REPEAT_UNAVAILABLE_LOG_MS = 5 * 60_000;

/**
 * An integration's connections facet that waits for the integration's storage first, as its routes
 * do: an integration not ready yet fails its calls (the list names it), and the rest keep working.
 */
function guardConnections(registration: IntegrationRegistration, facet: IntegrationConnections): IntegrationConnections {
  if (registration.ready) return facet;
  const ready = <Args extends unknown[], Result>(call: (...args: Args) => Promise<Result>) =>
    async (...args: Args): Promise<Result> => {
      await registration.ensureReady();
      return call(...args);
    };
  return {
    ...(facet.permissions ? { permissions: facet.permissions } : {}),
    ...(facet.policies ? { policies: facet.policies } : {}),
    describe: request => facet.describe(request),
    list: ready(request => facet.list(request)),
    connect: ready((request, method, input) => facet.connect(request, method, input)),
    ...(facet.reconnect ? { reconnect: ready((request, id, input) => facet.reconnect!(request, id, input)) } : {}),
    ...(facet.rename ? { rename: ready((request, id, name) => facet.rename!(request, id, name)) } : {}),
    ...(facet.removalImpact ? { removalImpact: ready((request, id) => facet.removalImpact!(request, id)) } : {}),
    ...(facet.remove ? { remove: ready((request, id, options) => facet.remove!(request, id, options)) } : {}),
    ...(facet.unlink ? { unlink: ready((request, id) => facet.unlink!(request, id)) } : {}),
    ...(facet.detail ? { detail: ready((request, id) => facet.detail!(request, id)) } : {}),
    ...(facet.updateSettings
      ? { updateSettings: ready((request, id, section, values) => facet.updateSettings!(request, id, section, values)) }
      : {}),
    ...(facet.getAuthStatus ? { getAuthStatus: ready((request, authId) => facet.getAuthStatus!(request, authId)) } : {}),
  };
}

function guardIntegrationRoutes({
  integration,
  ready,
  ensureReady,
  routes,
}: IntegrationRegistration & { routes: ApiRoute[] }): ApiRoute[] {
  if (ready) return routes;
  // Each retry throws a fresh error, so dedupe by message and repeat it periodically.
  let lastReported: { message: string; at: number } | undefined;
  const checkReady = async () => {
    try {
      await ensureReady();
      return undefined;
    } catch (error) {
      // The response only names a key mismatch, so this log is the only trace of any other cause.
      const message = String(error);
      const now = Date.now();
      if (lastReported?.message !== message || now - lastReported.at >= REPEAT_UNAVAILABLE_LOG_MS) {
        lastReported = { message, at: now };
        console.error(
          `[factory] ${integration.id} integration is unavailable: its storage failed to initialize:`,
          error,
        );
      }
      const cause =
        secretKeyMismatchHint(error) ??
        `Its storage failed to start. The server log line "[factory] ${integration.id} integration is unavailable" has the cause.`;
      return { error: 'integration_unavailable', message: `${integration.id} integration is unavailable. ${cause}` };
    }
  };
  return routes.map(route => {
    if ('handler' in route) {
      const handler = route.handler;
      return {
        ...route,
        handler: async (context: Parameters<typeof handler>[0]) => {
          const unavailable = await checkReady();
          if (unavailable) return context.json(unavailable, 503);
          return handler(context, async () => {});
        },
      };
    }

    const createHandler = route.createHandler;
    return {
      ...route,
      createHandler: async (args: Parameters<typeof createHandler>[0]) => {
        const handler = await createHandler(args);
        return async (context: Parameters<typeof handler>[0]) => {
          const unavailable = await checkReady();
          if (unavailable) return context.json(unavailable, 503);
          return handler(context);
        };
      },
    };
  });
}

/**
 * Resolve the source-control session the work item already holds for this role,
 * when it still resolves to the item's org and factory project. Returns
 * `undefined` when there is no ref or the ref no longer resolves, so the caller
 * falls back to minting one.
 */
async function reuseBoundSession(
  sourceControl: SourceControlStorageHandle,
  input: FactoryBindingPreparationInput,
  role: string = input.role,
): Promise<EnsuredFactorySourceSession | undefined> {
  const ref = input.item.sessions[role];
  if (!ref) return undefined;
  // At least as strict as the coordinator's resolveSourceSession: a ref it
  // would reject must fall through to minting, not hard-fail the run.
  const session = await sourceControl.sessions.getBySessionId(ref.sessionId);
  if (
    !session?.projectRepositoryId ||
    session.orgId !== input.record.orgId ||
    session.factoryProjectId !== input.record.factoryProjectId
  ) {
    return undefined;
  }
  return {
    sessionId: session.sessionId,
    userId: session.userId,
    projectRepositoryId: session.projectRepositoryId,
    branch: session.branch,
    baseBranch: session.baseBranch,
  };
}

/**
 * Work cards planned before Planning moved into the `work` context hold the
 * plan's session under `plan`. Building continues in it, on the same branch and
 * repository a fresh session would use, so those cards keep the plan's context.
 */
async function legacyPlanSession(
  sourceControl: SourceControlStorageHandle,
  input: FactoryBindingPreparationInput,
  boardId: string,
  branch: string,
  runsInLink: (projectRepositoryId: string) => boolean,
): Promise<EnsuredFactorySourceSession | undefined> {
  const legacyRole = legacyPlanRoleFor(boardId, input.role);
  if (!legacyRole) return undefined;
  const session = await reuseBoundSession(sourceControl, input, legacyRole);
  if (
    session &&
    (session.branch === branch || session.branch === legacyGithubWorkItemBranch(branch)) &&
    runsInLink(session.projectRepositoryId)
  ) {
    return session;
  }
  return undefined;
}

function sameBranch(held: string, branch: string): boolean {
  return held === branch || held === legacyGithubWorkItemBranch(branch);
}

/** The branch a binding's session works on: the reviewed pull request's for PR review of an attached one. */
function reviewBranch(
  input: FactoryBindingPreparationInput,
  board: InstalledBoard | undefined,
  stage: string,
  source: WorkItemBranchSource,
): string {
  const metadata = input.item.workItem.metadata;
  if (input.role === REVIEW_CONTEXT && isPullRequestReviewPhase(board, stage)) {
    const change = reviewedChangeRequest({ ...input.item, source });
    if (change && !change.standalone && change.number !== undefined) {
      return pullRequestBranch({ id: input.item.id, provider: change.provider, number: change.number });
    }
  }
  return workItemBranch({ id: input.item.id, source, metadata });
}

/**
 * The lane a run started on a resting card moves it to: a review of a card with a pull request
 * goes to the board's pull request review; otherwise the first phase that runs in the role's
 * context. Work's phases share contexts, so its roles keep their own lanes: `work` builds and
 * the old `plan` role plans.
 */
function restingExitLane(board: InstalledBoard | undefined, role: string, hasPullRequest: boolean): string | undefined {
  const pullRequestReview = boardFlow(board).pullRequestReview;
  if (hasPullRequest && role === REVIEW_CONTEXT && pullRequestReview) return pullRequestReview;
  return workLaneForRole(board, role) ?? board?.phaseForRole(role);
}

/**
 * Start a factory run for a rule binding: ensure the source-control session the
 * coordinator requires, then hand it to `prepare` along with the factory's
 * default model. Exported for tests — this is the autonomous entry point with no
 * browser and no interactive user, so nothing else would catch a regression in
 * what it forwards.
 */
export async function prepareFactoryRuleBinding(
  sourceControlProvider: SourceControlStorageHandle | Pick<GithubIntegration, 'sourceControlStorage'>,
  coordinator: Pick<FactoryStartCoordinator, 'prepare'>,
  projects: FactoryProjectsStorage,
  boards: BoardRegistry | ProjectBoardSource,
  input: FactoryBindingPreparationInput,
): Promise<void> {
  try {
    const sourceControl =
      'sourceControlStorage' in sourceControlProvider
        ? sourceControlProvider.sourceControlStorage
        : sourceControlProvider;
    const source = workItemSource(input.item.externalSource);
    // Only leaving a resting phase derives a lane from the role: roles don't own lanes,
    // and the Done close-out running in the triage seat must not drag the card back.
    // Both the current phase and the role's lane come from the installed board; an
    // unknown board or phase yields no destination rather than a guessed one.
    const boardId = boardForWorkItem(input.item);
    const board = (await toBoardSource(boards).load(input.record)).get(boardId);
    const currentStage = input.item.stages.length === 1 ? input.item.stages[0] : undefined;
    const currentKind = currentStage === undefined ? undefined : board?.phaseKind(currentStage);
    const destinationStage =
      currentKind === undefined
        ? undefined
        : currentKind === 'resting'
          ? restingExitLane(board, input.role, hasPullRequest({ ...input.item, source }))
          : currentStage;
    if (!destinationStage) {
      throw new FactoryDispatchError(
        'unsupported_provider_item',
        `Factory skill invocation has no destination lane (role "${input.role}", stages [${input.item.stages.join(', ')}]).`,
      );
    }
    // A PR review on an issue card checks the pull request out on its own branch, apart from
    // the builder's issue branch; every other seat works on the card's own branch.
    const branch = reviewBranch(input, board, destinationStage, source);
    const connections = await sourceControl.connections.list({
      orgId: input.record.orgId,
      factoryProjectId: input.record.factoryProjectId,
    });
    if (!connections.some(connection => connection.integrationId === sourceControl.integrationId)) {
      throw new FactoryDispatchError('source_control_missing', 'Factory source-control connection not found.');
    }
    const project = await projects.getById({ id: input.record.factoryProjectId });
    if (!project || project.orgId !== input.record.orgId) {
      throw new FactoryDispatchError(
        'session_unavailable',
        `Factory model policy is unavailable for project ${input.record.factoryProjectId}.`,
      );
    }
    // A retry may already own a role session. Check it before treating a
    // repository-less card as ambiguous, but never override an explicit signal.
    const reusable = await reuseBoundSession(sourceControl, input);
    // The review seat moves between branches on one card (self-review on the builder's branch,
    // PR review on each pull request's), so its session is reused only on the branch it holds.
    const boundSession =
      reusable && input.role === REVIEW_CONTEXT && !sameBranch(reusable.branch, branch) ? undefined : reusable;
    let repository = await resolveWorkItemRepository({
      sourceControl,
      orgId: input.record.orgId,
      factoryProjectId: input.record.factoryProjectId,
      item: input.item,
    });
    if (repository.status === 'ambiguous' && boundSession) {
      const link = await sourceControl.projectRepositories.get({
        orgId: input.record.orgId,
        id: boundSession.projectRepositoryId,
      });
      const linked =
        link && (await sourceControl.repositories.get({ orgId: input.record.orgId, id: link.repositoryId }));
      if (linked && repository.candidates.includes(linked.slug)) {
        repository = { status: 'resolved', slug: linked.slug, projectRepositoryId: link.id };
      }
    }
    if (repository.status !== 'resolved') {
      const detail =
        repository.status === 'ambiguous'
          ? `Choose one of the linked repositories: ${repository.candidates.join(', ')}.`
          : repository.hint;
      throw new FactoryDispatchError('source_repository_ambiguous', detail);
    }
    // Re-preparing a binding (server restart, retired controller session) must
    // land in the role's existing session: minting a replacement would repoint
    // the work item, flip the session's owner to the approver, and orphan the
    // previous sandbox.
    const approver = input.record.approvedBy ?? undefined;
    if (boundSession && !workItemRunsInLink(repository, boundSession.projectRepositoryId)) {
      throw new FactoryDispatchError(
        'source_repository_ambiguous',
        `The existing session is bound to a different repository than ${repository.slug}. Choose the correct repository and retry.`,
      );
    }
    // The session is filed under the card's repository, or, for a card that
    // names none, under the environment's position-1 link. The sandbox holds
    // every environment repository either way.
    const resolvedRepository = repository;
    const preparedSession =
      boundSession ??
      (await legacyPlanSession(sourceControl, input, boardId, branch, link =>
        workItemRunsInLink(resolvedRepository, link),
      )) ??
      (await ensureFactorySourceSession({
        sourceControl,
        orgId: input.record.orgId,
        factoryProjectId: input.record.factoryProjectId,
        projectRepositoryId: repository.projectRepositoryId,
        branch,
        // A person who approved the run is its interactive user: attribute it to
        // them, not the repo connector. An agent's pre-approval names no person.
        attributeToUserId: isAgentActor(approver) ? undefined : approver,
      }).catch(error => {
        if (error instanceof FactorySourceSessionResolutionError && error.reason === 'repository') {
          // The card resolved to a linked repository the sandbox will not check out.
          throw new FactoryDispatchError(
            'source_repository_missing',
            `Repository ${repository.slug} is linked but not in this Factory's environment. Turn it on under Settings → Environment, then retry.`,
            { cause: error },
          );
        }
        if (error instanceof SessionBranchHeldError) {
          throw new FactoryDispatchError(
            'session_unavailable',
            `${error.message} The run cannot start until branch ${branch} is free for this repository.`,
            { cause: error },
          );
        }
        if (!(error instanceof SessionOwnershipMismatchError)) throw error;
        throw new FactoryDispatchError(
          'session_unavailable',
          `Session ${error.sessionId} on branch ${branch} predates factory ownership and cannot be reused. Delete that session, then retry.`,
          { cause: error },
        );
      }));

    await coordinator.prepare({
      orgId: input.record.orgId,
      userId: preparedSession.userId,
      factoryProjectId: input.record.factoryProjectId,
      sessionId: preparedSession.sessionId,
      defaultModelId: project.defaultModelId ?? undefined,
      threadTitle: workItemThreadTitle({ source, title: input.item.title, metadata: input.item.workItem.metadata }),
      kickoffKey: input.record.id,
      destinationStage,
      workItem: {
        id: input.item.id,
        role: input.role,
        input: {
          externalSource: input.item.externalSource,
          parentWorkItemId: input.item.parentWorkItemId,
          title: input.item.title,
          stages: [...input.item.stages],
          sessions: input.item.sessions,
          metadata: input.item.metadata,
        },
      },
    });
  } catch (error) {
    if (error instanceof FactoryDispatchError) throw error;
    if (error instanceof FactorySourceSessionResolutionError) {
      const code = error.reason === 'connection' ? 'source_control_missing' : 'source_repository_missing';
      throw new FactoryDispatchError(code, error.message, { cause: error });
    }
    if (error instanceof SourceControlConnectionNotFoundError) {
      throw new FactoryDispatchError('source_control_missing', error.message, { cause: error });
    }
    if (error instanceof MaterializeError) {
      throw new FactoryDispatchError(MATERIALIZE_FAILURE_CODE[error.code], error.message, { cause: error });
    }
    throw error;
  }
}

/**
 * Build the {@link IntegrationContext} handed to an integration when the
 * factory collects its capabilities (routes, workers). One shape everywhere:
 * `assembleFactoryApiRoutes` uses it per registration, and `MastraFactory` uses it
 * when collecting integration workers at finalize.
 */
export function buildIntegrationContext(
  deps: Pick<
    FactoryApiRoutesDeps,
    | 'controller'
    | 'publicOrigin'
    | 'auth'
    | 'sandbox'
    | 'users'
    | 'factoryStorage'
    | 'integrationStorage'
    | 'sourceControlStorage'
    | 'integrations'
  > & {
    stateSigner: StateSigner;
    emitAudit?: AuditEmitter['emit'];
    onRepositoryPush?: IntegrationHooks['onRepositoryPush'];
    onManagedMcpServersChanged?: IntegrationHooks['onManagedMcpServersChanged'];
    configVersion: string;
    boardRegistry: BoardRegistry | ProjectBoardSource;
    /** The project's intake routes and boards, so integrations filing cards themselves apply the routes. */
    intakeRoutes?: IntakeRoutesReader;
    projectBoards?: { load(scope: { orgId: string; factoryProjectId: string }): Promise<BoardRegistry> };
    factoryReady: boolean;
    /** Work-item feed service, so a channel integration can ingest platform messages. */
    feed: CommentsDomain;
    domains: Pick<
      FactoryApiRoutesDeps['domains'],
      'projects' | 'intake' | 'workItems' | 'channelIdentity' | 'memorySettings'
    >;
    /**
     * Stable id of the registered source-control-owning integration (today:
     * `'github'` when registered). Every call site must derive and pass it so
     * `routes()`, `channels()`, and `workers()` all see the same context shape.
     */
    sourceControlOwnerId?: string;
  },
  integrationId: string,
): IntegrationContext {
  return {
    auth: deps.auth,
    sandbox: deps.sandbox,
    ...(deps.users ? { users: deps.users } : {}),
    factoryStorage: deps.factoryStorage,
    baseUrl: deps.publicOrigin,
    controller: deps.controller,
    stateSigner: deps.stateSigner,
    storage: {
      generic: deps.integrationStorage.forIntegration(integrationId),
      sourceControl: deps.sourceControlStorage.forIntegration(integrationId),
      ...(deps.sourceControlOwnerId
        ? { sourceControlOwner: deps.sourceControlStorage.forIntegration(deps.sourceControlOwnerId) }
        : {}),
      sourceControls: (deps.integrations ?? [])
        .filter(({ integration }) => integration.versionControl)
        .map(({ integration }) => deps.sourceControlStorage.forIntegration(integration.id)),
      projects: deps.domains.projects,
      intake: deps.domains.intake,
      channelIdentity: deps.domains.channelIdentity,
      memorySettings: deps.domains.memorySettings,
    },
    ...(deps.factoryReady ? { workItems: deps.domains.workItems, feed: deps.feed } : {}),
    ...(deps.factoryReady
      ? {
          runtime: {
            configVersion: deps.configVersion,
            workItems: deps.domains.workItems,
            boards: deps.boardRegistry,
            ...(deps.intakeRoutes ? { intakeRoutes: deps.intakeRoutes } : {}),
            ...(deps.projectBoards ? { projectBoards: deps.projectBoards } : {}),
          },
        }
      : {}),
    ...(deps.emitAudit || deps.onRepositoryPush || deps.onManagedMcpServersChanged
      ? {
          hooks: {
            ...(deps.emitAudit ? { emitAudit: deps.emitAudit } : {}),
            ...(deps.onRepositoryPush ? { onRepositoryPush: deps.onRepositoryPush } : {}),
            ...(deps.onManagedMcpServersChanged ? { onManagedMcpServersChanged: deps.onManagedMcpServersChanged } : {}),
          },
        }
      : {}),
  };
}

/**
 * Disabled-status stub for the well-known integration ids. The SPA polls
 * `/web/github/status` unconditionally, so when an integration is absent (or not ready) the status
 * contract must still hold. Unknown custom ids get no stub — the SPA doesn't
 * poll them.
 */
function disabledIntegrationStatusRoutes(deps: FactoryApiRoutesDeps, id: string, configured = false): ApiRoute[] {
  if (id === 'github') {
    return [
      registerApiRoute('/web/github/status', {
        method: 'GET',
        requiresAuth: false,
        handler: c =>
          c.json({
            enabled: false,
            connected: false,
            installations: [],
            reason: 'missing_config',
            diagnostics: getGithubFeatureDiagnostics({
              github: undefined,
              auth: deps.auth,
              appDbConfigured: deps.factoryStorage !== undefined,
              stateSigner: deps.stateSigner,
              sandbox: deps.sandbox,
            }),
          }),
      }),
    ];
  }
  return [];
}

/**
 * Stub for `GET /web/channel-accounts` when NO Slack integration is
 * registered. The SPA's Connections section polls the path unconditionally;
 * without a stub the SPA fallback serves HTML, which the UI can only read as
 * "old server / unknown". The machine-readable reason lets it say the truth:
 * the integration isn't registered.
 *
 * Mounted only for ABSENT slack — a registered integration owns the path via
 * its connect routes (or, when the state signer is unstable, gets no routes
 * at all and the UI falls back to the generic copy). Static payload, leaks
 * nothing → no auth needed, same posture as the github stub.
 */
function absentSlackChannelAccountsRoutes(): ApiRoute[] {
  return [
    registerApiRoute('/web/channel-accounts', {
      method: 'GET',
      requiresAuth: false,
      handler: c => c.json({ accounts: [], canConnect: false, reason: 'not_registered' }),
    }),
  ];
}

export interface FactoryStatusProblem {
  code: 'secret_key_mismatch';
  /** Whether no key is set at all or a different key than the secrets were written with; the UI words them apart. */
  reason: 'missing_key' | 'changed_key';
  title: string;
  message: string;
  /** The one step that fixes it. Env var names are wrapped in backticks. */
  fix: string;
}

/** Domains that hold encrypted secrets; Factory can't run if they can't be read. */
const SECRET_DOMAINS = ['integrations', 'model-credentials', 'custom-providers'];

/**
 * `GET /web/status`: problems that stop the whole Factory from working, so the
 * UI shows one alert banner instead of every page failing on its own. Only a
 * key problem counts, since only a redeploy with the right key clears it. Read
 * from the latest storage init result, so a key failure found by a later init
 * retry shows up too. Only client-safe copy goes out.
 */
function factoryStatusRoutes(storage: FactoryStorage | undefined): ApiRoute[] {
  return [
    registerApiRoute('/web/status', {
      method: 'GET',
      requiresAuth: false,
      handler: c => {
        const error = SECRET_DOMAINS.map(domain => storage?.domainInitError(domain)).find(
          domainError => secretKeyProblem(domainError) !== undefined,
        );
        const problem = secretKeyProblem(error);
        const problems: FactoryStatusProblem[] = problem
          ? [
              {
                code: 'secret_key_mismatch',
                reason: (error as FactorySecretDecryptionError).missingKey ? 'missing_key' : 'changed_key',
                ...problem,
              },
            ]
          : [];
        return c.json({ problems });
      },
    }),
  ];
}

/**
 * Assemble the custom `/web/*` API routes as Mastra `server.apiRoutes`:
 *   - fs browser routes (project picker), confined to `fsRoot`
 *   - config routes (provider/API-key/default-model/OM management)
 *   - every registered integration's `routes()` surface (full set when ready,
 *     disabled-status stub otherwise), plus stubs for absent known ids
 */
/**
 * One connector per harness this server runs whose sessions run on members' sign-ins (ADR-0036):
 * its id is the descriptor's `setup.accounts.connector`.
 */
function agentAccountConnectors(deps: FactoryApiRoutesDeps): ConnectorRegistration[] {
  const running = HARNESSES.filter(
    harness =>
      (harness.id !== CLAUDE_CODE_HARNESS.id || deps.claudeCodeEnabled === true) && (harness.id !== CODEX_HARNESS.id || deps.codexEnabled === true),
  );
  const signIns: Record<string, AccountSignInFlows | undefined> = {
    [CLAUDE_CODE_HARNESS.id]: deps.claudeSignIn,
    [CODEX_HARNESS.id]: deps.codexSignIn,
  };
  const users = deps.users;
  return running.flatMap(harness => {
    const accounts = harness.setup.accounts;
    const provider = accounts ? SIGN_IN_ACCOUNT_PROVIDERS[accounts.provider] : undefined;
    if (!accounts || !provider) return [];
    const signIn = signIns[harness.id];
    const facet = deps.usage?.harnesses.forHarness(harness.id);
    return [
      {
        id: accounts.connector,
        connections: createAgentAccountsConnections({
          harness,
          kind: provider.kind,
          signInName: provider.name,
          credentials: deps.domains.modelCredentials,
          ...(signIn ? { signIn } : {}),
          ...(deps.usage ? { usage: { storage: deps.usage.usage, ...(facet ? { facet } : {}) } } : {}),
          projects: deps.domains.projects,
          ...(users
            ? {
                userName: async (userId: string) => {
                  const user = await users.getUser(userId);
                  return user?.name?.trim() || user?.email?.trim() || undefined;
                },
              }
            : {}),
        }),
      },
    ];
  });
}

export function assembleFactoryApiRoutes(deps: FactoryApiRoutesDeps): ApiRoute[] {
  const emitAudit: AuditEmitter['emit'] = args => deps.audit.emit(args);
  const registrations = deps.integrations ?? [];
  const githubRegistration = registrations.find(({ integration }) => integration.id === 'github');
  const githubStorage = githubRegistration ? deps.sourceControlStorage.forIntegration('github') : undefined;
  const githubIntegration = githubRegistration?.integration as GithubIntegration | undefined;
  const sourceControlRegistrations = registrations.filter(({ integration }) => integration.versionControl);
  const sourceControlIntegrationIds = [
    ...new Set(['github', ...sourceControlRegistrations.map(({ integration }) => integration.id)]),
  ];
  const sourceControls = sourceControlIntegrationIds.map(id => deps.sourceControlStorage.forIntegration(id));
  const sourceControlSessions = createSourceControlSessionLookup(sourceControls);

  const connectors: ConnectorRegistration[] = [];
  const integrationRoutes = registrations.flatMap(registration => {
    const { integration } = registration;
    if (!deps.stateSigner) return disabledIntegrationStatusRoutes(deps, integration.id, true);
    const context = buildIntegrationContext(
      {
        ...deps,
        // Integrations evaluate code behaviors and place new cards with the code boards.
        boardRegistry: toBoardSource(deps.boardRegistry).codeRegistry,
        stateSigner: deps.stateSigner,
        emitAudit,
        ...(githubRegistration ? { sourceControlOwnerId: 'github' } : {}),
      },
      integration.id,
    );
    const routes = guardIntegrationRoutes({ ...registration, routes: integration.routes(context) });
    if (integration.connections) {
      connectors.push({ id: integration.id, connections: guardConnections(registration, integration.connections(context)) });
    }
    return routes;
  });
  // Session persistence belongs to the linked source-control provider, not to
  // GitHub. Replace legacy GitHub-owned handlers with one resolver spanning
  // the legacy GitHub partition and every registered source-control partition.
  const sharedSessionRouteKeys = new Set([
    'GET /web/github/projects/:id/sessions',
    'POST /web/github/projects/:id/sessions',
    'GET /web/user-sessions/:sessionId',
    'DELETE /web/user-sessions/:sessionId',
    'POST /web/user-sessions/:sessionId/title',
  ]);
  const providerRoutes = integrationRoutes.filter(
    route => !sharedSessionRouteKeys.has(route.method + ' ' + route.path),
  );
  const sourceControlSessionRoutes =
    sourceControls.length === 0
      ? []
      : buildSourceControlSessionRoutes({
          auth: deps.auth,
          sourceControls,
          projects: deps.domains.projects,
          ...(deps.users ? { users: deps.users } : {}),
          controller: deps.controller,
          memorySettings: deps.domains.memorySettings,
          sessionRetirement: deps.sessionRetirement,
          ...(deps.onSessionDeleted ? { onSessionDeleted: deps.onSessionDeleted } : {}),
          // A local sandbox's destroy keeps the session directory, so recreate
          // couldn't deliver the fresh checkout it promises there.
          sandboxRecreateSupported: deps.sandbox !== undefined && deps.sandbox.provider !== 'local',
          filesystem: deps.domains.filesystem,
          ...(deps.factoryReady ? { workItems: deps.domains.workItems } : {}),
          ...(deps.moveThread ? { moveThread: deps.moveThread } : {}),
          ...(deps.claudeCodeUserSessions ? { claudeCode: deps.claudeCodeUserSessions } : {}),
          ...(deps.harnessModels ? { harnessModels: deps.harnessModels } : {}),
          ...(deps.attachLocalCheckout ? { attachLocalCheckout: deps.attachLocalCheckout } : {}),
          ...(deps.createLocalCheckout ? { createLocalCheckout: deps.createLocalCheckout } : {}),
          ...(githubStorage ? { githubRepositories: githubStorage.repositories } : {}),
        });
  // Absent known integrations still get their disabled-status stub.
  const absentStubs = ['github']
    .filter(id => !registrations.some(({ integration }) => integration.id === id))
    .flatMap(id => disabledIntegrationStatusRoutes(deps, id));
  // Absent slack gets the channel-accounts not-registered stub (registered
  // slack owns the path via its own connect routes).
  const slackAbsentStubs = registrations.some(({ integration }) => integration.id === 'slack')
    ? []
    : absentSlackChannelAccountsRoutes();

  const transitionService = deps.factoryReady
    ? (deps.factoryTransitionService ??
      new FactoryTransitionService({
        configVersion: deps.configVersion,
        boards: deps.boardRegistry,
        storage: deps.domains.workItems,
        audit: deps.audit,
      }))
    : undefined;
  const startCoordinator = transitionService
    ? new HarnessRoutingStartCoordinator(
        [
          deps.controller,
          deps.domains.workItems,
          transitionService,
          request =>
            resolveFactorySourceControl({
              sourceControls,
              orgId: request.orgId,
              factoryProjectId: request.factoryProjectId,
              sessionId: request.sessionId,
            }),
          { projects: deps.domains.projects },
          deps.boardRegistry,
        ],
        { projects: deps.domains.projects, coordinators: deps.harnessStartCoordinators ?? {} },
      )
    : undefined;
  if (transitionService && startCoordinator) {
    deps.onFactoryRuntime?.({
      transitionService,
      startCoordinator,
      ...(sourceControlRegistrations.length > 0
        ? {
            prepareBinding: async (input: FactoryBindingPreparationInput) => {
              const sourceControl = await resolveFactorySourceControl({
                sourceControls,
                orgId: input.record.orgId,
                factoryProjectId: input.record.factoryProjectId,
              });
              if (!sourceControl) {
                throw new FactoryDispatchError(
                  'source_control_missing',
                  'Factory project has no linked source-control repository.',
                );
              }
              return prepareFactoryRuleBinding(
                sourceControl,
                startCoordinator,
                deps.domains.projects,
                deps.boardRegistry,
                input,
              );
            },
          }
        : {}),
    });
  }

  return [
    ...factoryStatusRoutes(deps.factoryStorage),
    ...buildFsRoutes({
      root: deps.fsRoot,
      sessionFs: {
        auth: deps.auth,
        sessions: sourceControlSessions,
        ...(deps.attachLocalCheckout ? { attachLocalCheckout: deps.attachLocalCheckout } : {}),
        controller: deps.controller,
        ...(deps.factoryReady ? { workItems: deps.domains.workItems } : {}),
      },
    }),
    ...new ConfigRoutes({
      auth: deps.auth,
      controller: deps.controller,
      authStorage: deps.authStorage,
      modelCredentials: deps.domains.modelCredentials,
      sourceControlSessions,
      sourceControls,
      workItems: deps.domains.workItems,
      memorySettings: deps.domains.memorySettings,
      factoryProjects: deps.domains.projects,
      customProviders: deps.domains.customProviders,
      features: {
        knowledge: deps.knowledgeEnabled,
        mcp: deps.mcpEnabled,
        claudeCode: deps.claudeCodeEnabled ?? false,
        codex: deps.codexEnabled ?? false,
        device: deps.deviceEnabled ?? false,
        claudeSignIn: deps.claudeSignIn !== undefined,
        codexSignIn: deps.codexSignIn !== undefined,
      },
      deploymentProviders: deps.deploymentModelProviders,
      ...(deps.harnessModels ? { harnessModels: deps.harnessModels } : {}),
      ...(deps.harnessExecutables ? { harnessExecutables: deps.harnessExecutables } : {}),
      onCredentialsChanged: invalidateTenantCredentialSnapshots,
      onCustomProvidersChanged: invalidateCustomProvidersSnapshots,
    }).routes(),
    ...(deps.usage
      ? new UsageRoutes({
          auth: deps.auth,
          ...deps.usage,
          sessions: sourceControlSessions,
          workItems: deps.domains.workItems,
          modelCredentials: deps.domains.modelCredentials,
          projects: deps.domains.projects,
        }).routes()
      : []),
    ...new OAuthRoutes({
      auth: deps.auth,
      authStorage: deps.authStorage,
      modelCredentials: deps.domains.modelCredentials,
      onCredentialsChanged: invalidateTenantCredentialSnapshots,
    }).routes(),
    ...new SkillRoutes({
      auth: deps.auth,
      controllerId: deps.controllerId,
      harness: createMastraHarness(deps.controller),
      sourceControlStorage: githubStorage,
      ensureSourceControlReady: githubRegistration?.ensureReady,
      ...(deps.skills ? { skills: deps.skills } : {}),
      overrides: { projects: deps.domains.projects, storage: deps.domains.skillOverrides, audit: deps.audit },
    }).routes(),
    ...sourceControlSessionRoutes,
    ...(sourceControls.length === 0 ? [] : buildSourceControlSettingsRoutes({ auth: deps.auth, sourceControls })),
    ...providerRoutes,
    // Settings › Підключення: every integration's connections through one registry (ADR-0035), and
    // the accounts each turn-based harness runs on (ADR-0036).
    ...buildConnectionRoutes({
      auth: deps.auth,
      connectors: [...connectors, ...agentAccountConnectors(deps), ...(deps.connectors ?? [])],
      emitAudit,
    }),
    ...absentStubs,
    ...slackAbsentStubs,
    ...(deps.intakeReady
      ? new IntakeRoutes({
          auth: deps.auth,
          audit: deps.audit,
          intake: deps.domains.intake,
          integrations: (deps.integrations ?? []).flatMap(({ integration }) =>
            integration.intake ? [{ id: integration.id, intake: integration.intake }] : [],
          ),
        }).routes()
      : []),
    ...(deps.factoryReady && deps.knowledgeEnabled
      ? new KnowledgeRoutes({
          auth: deps.auth,
          projects: deps.domains.projects,
          knowledge: async key => deps.controller.getMastra()?.getKnowledge(key),
          defaultKnowledgeKey: deps.knowledgeKey,
        }).routes()
      : []),
    ...(deps.factoryReady && deps.storedBoards
      ? new BoardRoutes({
          auth: deps.auth,
          audit: deps.audit,
          projects: deps.domains.projects,
          workItems: deps.domains.workItems,
          storage: deps.storedBoards.storage,
          boards: deps.storedBoards.cache,
          ...(deps.skills ? { skills: deps.skills } : {}),
        }).routes()
      : []),
    ...(deps.factoryReady
      ? new WorkItemRoutes({
          auth: deps.auth,
          audit: deps.audit,
          projects: deps.domains.projects,
          workItems: deps.domains.workItems,
          boardRegistry: deps.boardRegistry,
          intakeRoutes: deps.storedBoards?.storage,
          comments: deps.domains.comments,
          queueHealth: deps.domains.queueHealth,
          transitionService,
          startCoordinator,
          liveSessions: deps.liveSessions,
          ...(deps.releaseWorkItemSandboxes ? { releaseWorkItemSandboxes: deps.releaseWorkItemSandboxes } : {}),
        }).routes()
      : []),
    ...(deps.factoryReady
      ? new AttachmentRoutes({
          auth: deps.auth,
          workItems: deps.domains.workItems,
          sessions: sourceControlSessions,
          ...(deps.attachments ? { attachments: deps.attachments } : {}),
        }).routes()
      : []),
    ...(deps.factoryReady && deps.storedBoards
      ? new IntakeRouteRoutes({
          auth: deps.auth,
          audit: deps.audit,
          projects: deps.domains.projects,
          storage: deps.storedBoards.storage,
          boards: deps.storedBoards.cache,
          ...(deps.intakeTriggers
            ? { triggers: { ...deps.intakeTriggers, cards: deps.domains.workItems } }
            : {}),
        }).routes()
      : []),
    ...(deps.factoryReady
      ? buildAutomationRunRoutes({
          auth: deps.auth,
          audit: deps.audit,
          projects: deps.domains.projects,
          workItems: deps.domains.workItems,
          configVersion: deps.configVersion,
          boards: deps.boardRegistry,
        })
      : []),
  ];
}
