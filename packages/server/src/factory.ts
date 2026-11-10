/**
 * `MastraFactory` — the single entry point to the whole Mastra Software Factory.
 *
 * The consumer's deploy entry constructs deployment-specific config instances
 * (auth adapter, pubsub) and passes them here explicitly. The only provider
 * defaults constructed here are Platform GitHub and GitLab integrations when
 * Platform credentials exist and the caller did not provide those integrations.
 *
 * `prepare()` resolves feature readiness, threads every dependency explicitly,
 * assembles the web routes/middleware, and returns the constructor args for
 * `new Mastra(...)`. The literal `export const mastra = new Mastra(...)` must
 * stay in the entry file — the deployer's `checkConfigExport` Babel plugin
 * only marks the config valid when it finds that literal in the entry AST —
 * so the factory produces args instead of the instance. `finalize()` runs the
 * post-construct boot (controller init + workers).
 *
 * Integration readiness is derived from each instance's declared capabilities
 * and the storage domains those capabilities require.
 */


import { prepareAgentControllerMount } from '@mastra/code-sdk';
import { getDynamicMemory } from '@mastra/code-sdk/agents/memory';
import { resolveModel } from '@mastra/code-sdk/agents/model';
import type { MastraCodeState } from '@mastra/code-sdk/schema';
import type { AgentControllerRequestContext, BuiltinToolId } from '@mastra/core/agent-controller';
import type { MastraBrowser } from '@mastra/core/browser';
import { AgentControllerChannels } from '@mastra/core/channels';
import { EventEmitterPubSub } from '@mastra/core/events';
import type { PubSub } from '@mastra/core/events';
import type { Knowledge } from '@mastra/core/knowledge';
import type { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';
import { hasAuthInit, isUserProvider } from '@mastra/core/server';
import type { IMastraAuthProvider } from '@mastra/core/server';
import type { InlineSkill } from '@mastra/core/skills';
import type { FactoryStorage } from '@mastra/core/storage';
import type { Tool } from '@mastra/core/tools';
import type { MastraVector } from '@mastra/core/vector';
import { describeFactorySandbox, isFactorySandbox } from '@mastra/core/workspace';
import type { FactorySandbox, FactorySandboxDescription, WorkspaceSandbox } from '@mastra/core/workspace';
import {
  buildAuthDisabledRoutes,
  buildAuthRoutes,
  createFactoryAuthGate,
  createFactoryInteractiveMarker,
  createFactoryRouteAuth,
  factoryUserOrgId,
  getFactoryAuthOrgId,
  getFactoryAuthUserFromContext,
  getFactoryAuthUserId,
} from '@factory/auth';
import { createBoardRegistry, isDefinedBoard, isTerminalWorkItem } from '@factory/core';
import { createDefaultBoardRegistry, PRODUCT_LEGACY_PHASE_RENAMES, productBoard } from '@factory/pipelines';
import type { BoardRegistry, InstalledBoard } from '@factory/core';
import { boardForWorkItem, isPullRequestCard, namesRepository, openChangeRequests, workItemSource } from '@factory/core';
import { createClaudeSessionUi } from '@factory/harness-claude-code-ui';
import { createRoutingHarness } from '@factory/harness';
import { createFactorySessionTokenSigner } from '@factory/mcp';
import {
  ClaudeStartCoordinator,
  createClaudeBoundTools,
  createClaudeSessionTools,
  createClaudePlanApproval,
  createClaudeCheckoutResolver,
  createLocalCheckoutAttacher,
  createClaudeCodeCredentials,
  claudeFactorySkillDirectories,
  createClaudeFactoryHarness,
  createClaudeSignInService,
  createClaudeUserSessions,
  createClaudeSupervisorSessions,
  claudeLiveSession,
  claudeSupervisorProjectId,
  boundRunRequestContext,
  claudeFactoryToolName,
  claudeWorkerSession,
  createClaudeFactoryChatGuard,
  markClaudePersonTurn,
  observeClaudeToolResults,
  CLAUDE_THREAD_SETTINGS,
  createFactoryToolPermissions,
  observeClaudeThreadTitle,
} from './claude/index.ts';
import type {
  ClaudeCodeCredentialFailureHook,
  ClaudeCodeCredentialsHook,
  ClaudeFactoryHarness,
  ClaudeFactoryHarnessOptions,
} from './claude/index.ts';
import type { ClaudeSessionUi } from '@factory/harness-claude-code-ui';
import { EnvironmentBuildRunner } from '@factory/harness-mastra';
import { ENVIRONMENT_BUILD_WORKFLOW_ID, selfReviewedHeadFor } from '@factory/harness-mastra';
import { touchFeed } from '@factory/feed';
import type { FactoryIntegration, IntegrationPostToolContext, IntegrationTools } from '@factory/integrations';
import { reconcileGithubAcceptanceLabels } from '@factory/integration-github';
import type { GithubRuleOverrides } from '@factory/integration-github';
import type { GithubIntegration } from '@factory/integration-github';
import { publishDispatchWake, subscribeDispatchWakes } from './dispatch-wake.ts';
import {
  recordFactoryPullRequestProvenance,
  resolveFactoryPullRequestParentWorkItemId,
} from '@factory/integration-github';
import type { FactoryPullRequestProvenanceData } from '@factory/integration-github';
import { isFactoryGithubLogin, trustedCollaborator } from '@factory/integration-github';
import { dismissStaleFactoryReviews } from '@factory/integration-github';
import { createGithubReviewStatusReporter, reviewStatusAnimationFromEnv } from '@factory/integration-github';
import { PlatformApiClient, platformApiClientConfigFromEnv } from '@factory/integrations';
import { buildPlatformConnectRoutes } from '@factory/integrations';
import { PlatformGithubIntegration } from '@factory/integration-github';
import { PlatformGitLabIntegration } from '@factory/integration-gitlab';
import {
  abortSessionRun,
  createSessionAsRowOwner,
  isSessionRunning,
  prepareSessionRunContext,
  routeExternalSessions,
} from '@factory/integrations';
import { buildFactoryMcpRoutes, resolveMcpAuthorizationServers } from '@factory/mcp';
import type { FactoryMcpConfig } from '@factory/mcp';
import { resolveDeploymentModelProviders } from '@factory/api';
import {
  createCustomProvidersPrimer,
  primeCustomProvidersForRequestContext,
  registerCustomProvidersSource,
} from '@factory/api';
import { ProjectRoutes } from '@factory/api';
import { createSessionAccessGuard } from '@factory/session';
import { assembleFactoryApiRoutes, buildIntegrationContext, setupIntakeRules } from '@factory/api';
import type { FactoryApiRoutesDeps } from '@factory/api';
import { TelemetryRoutes } from '@factory/api';
import {
  createTenantCredentialPrimer,
  primeTenantCredentials,
  registerTenantCredentialResolver,
} from '@factory/credentials';
import { readFactorySessionScope, resolveFactorySessionAddress } from '@factory/session';
import { FactoryDecisionDispatcher } from '@factory/runtime';
import type { FactoryRuleActor } from '@factory/harness-mastra';
import { describeFactoryPhase, FactoryPhaseStateProcessor, reportMemorySettingsUnavailable } from '@factory/harness-mastra';
import { asAgentSession, createMastraHarness } from '@factory/harness-mastra';
import { createReviewSourceTool, resolveReviewSourceUiOrigin } from '@factory/harness-mastra';
import type { FactoryStartCoordinator } from '@factory/harness-mastra';
import { createTerminalStageCleanup } from '@factory/runtime';
import { createAttachmentTools, createFactoryTransitionTools } from '@factory/harness-mastra';
import { BoardWriteError, BoardWrites, FactoryTransitionService, ProjectBoardCache, toBoardSource } from '@factory/runtime';
import type { BoardWriter } from '@factory/runtime';
import type { ProjectBoardSource } from '@factory/runtime';
import { assertFactoryConfigVersion, DEFAULT_FACTORY_CONFIG_VERSION } from '@factory/core';
import { CallbackFactorySandbox, LocalFactorySandbox, workItemFolderKey } from '@factory/sandbox';
import { isValidGitRef } from '@factory/sandbox';
import { peekSessionSandbox, SessionRetirementCoordinator } from '@factory/sandbox';
import type { MastraFactorySandboxOption } from '@factory/sandbox';
import { backfillUntilDone, WorkItemSplitModeError } from '@factory/store';
import { migrateLabelRoutesToIntakeRoutes, REVIEW_BOARD_RETIREMENT_ACTOR } from '@factory/store';
import { boardDefinitionOf, PRODUCT_BOARD_UPGRADE_ACTOR } from '@factory/store';
import { createPlaintextFactorySecretEncryption } from '@factory/store';
import type { Card } from '@factory/store';
import type { FactorySecretEncryption } from '@factory/store';
import { handleServerError } from '@factory/http';
import { FactoryChannelReplyProcessor } from '@factory/session';
import { FactoryChannelSessionLinkProcessor } from '@factory/session';
import { resolveFactoryCredentialTenant } from '@factory/session';
import { hydrateSessionDefaultModel } from '@factory/session';
import { environmentSlugs, resolveSessionRepositories } from '@factory/session';
import { FactoryEnvironmentStateProcessor } from '@factory/sandbox';
import { createSourceControlSessionLookup } from '@factory/session';
import { createWorkItemFolders, workItemFolderForCard } from '@factory/session';
import { observeSessionFilesystem } from '@factory/session';
import { observeSessionFirstExec } from '@factory/session';
import { observeSessionFirstMessage } from '@factory/session';
import { createSessionNotifier, LiveSessions } from '@factory/session';
import type { SessionNotifier } from '@factory/session';
import { hydrateSessionMemorySettings } from '@factory/session';
import { hasResolvedOrg } from '@factory/session';
import { FactoryReplyCredentialProcessor } from '@factory/session';
import { migrateSessionResources, privatizeOwnerResourceSessions } from '@factory/session';
import { observeSessionRunEnd } from '@factory/runtime';
import { sessionMemoryResourceId, sessionStampCounts } from '@factory/session';
import { createSourceControlTools } from '@factory/harness-mastra';
import { readFactoryThinkingLevel, resolveFactoryThinkingLevel } from '@factory/session';
import { observeSessionThreadStamp } from '@factory/session';
import { observeSessionThreadTitle } from '@factory/session';
import { createSpaStaticMiddleware, resolveUiDistDir } from '@factory/http';
import { createStateSigner } from '@factory/auth';
import { observeAgentGitAction } from '@factory/harness-mastra';
import { AuditStorage } from '@factory/store';
import { AuditDomain } from '@factory/feed';
import { ChannelIdentityStorage } from '@factory/store';
import { WorkItemCommentsStorage } from '@factory/store';
import { CommentsDomain } from '@factory/feed';
import { FactoryFeedReader } from '@factory/store';
import type { WorkItemFeedPublisher } from '@factory/feed';
import { ModelCredentialsStorage } from '@factory/store';
import { CustomProvidersStorage } from '@factory/store';
import { FilesystemStorage } from '@factory/store';
import { IntakeStorage } from '@factory/store';
import { IntegrationStorage } from '@factory/store';
import { factoryMemorySettingsUserId, MemorySettingsStorage, SkillOverridesStorage, StoredBoardsStorage } from '@factory/store';
import { AttachmentService, AttachmentsStorage, IntakeRulesStorage } from '@factory/store';
import type { AttachmentBlobStore } from '@factory/store';
import type { StoredBoardInput, StoredBoardScope } from '@factory/store';
import type { MemorySettingsRecord } from '@factory/store';
import { FactoryProjectsStorage } from '@factory/store';
import { QueueHealthStorage } from '@factory/store';
import { SourceControlStorage } from '@factory/store';
import { WorkItemsStorage } from '@factory/store';
import type { FactoryRunBindingRecord, WorkItemRow } from '@factory/store';
import { FactorySupervisorHealthWorker } from '@factory/supervisor';
import { SUPERVISOR_INSTRUCTIONS } from '@factory/supervisor';
import { withAgentLanguage } from './agent-language.ts';
import { createFactorySupervisorReadTools } from '@factory/supervisor';
import { messageWorkerSession } from '@factory/supervisor';
import { persistFactoryToolPermissions, supervisorProjectIdFromContext } from '@factory/session';
import { hydrateSupervisorSession, resolveSupervisorScope } from '@factory/supervisor';
import { createFactorySupervisorWriteTools } from '@factory/supervisor';
import {
  createRequestTimingMiddleware,
  factoryTimingEnabled,
  instrumentAsyncMethods,
  logTiming,
  timedPhase,
} from '@factory/observability';
import { deliverFactorySessionNotification } from '@factory/harness-mastra';
import { applyFactoryToolPermissions, createFactoryTools, resolveFactoryToolScope } from '@factory/harness-mastra';
import type { FactoryToolDependencies } from '@factory/harness-mastra';
import {
  createSessionApprovalNotifier,
  createSessionRunEndReporter,
  createStageChangeNotifier,
  createWorkItemRunEndReporter,
} from '@factory/harness-mastra';
import type { FactoryReporting } from '@factory/harness-mastra';
import { observeSessionRunReports } from '@factory/harness-mastra';
import { FactorySessionsStateProcessor } from '@factory/harness-mastra';
import { assertFactorySkills, createWorkspaceFactory, FactoryWorkspaceRegistry, findBoardSkillProblems } from '@factory/harness-mastra';
import type { FactorySandboxStart } from '@factory/harness-mastra';

type BuildApiRoutesDeps = Pick<FactoryApiRoutesDeps, 'controller' | 'authStorage'>;

/** Constructor args for the `new Mastra(...)` literal in the deploy entry. */
export type MastraArgs = NonNullable<ConstructorParameters<typeof Mastra>[0]>;

export interface MastraFactoryConfig {
  /**
   * Auth provider instance — `MastraAuthBetterAuth`
   * (`@mastra/auth-better-auth`), the local dev provider, or any custom
   * `MastraAuthProvider`. Whatever instance is passed is the active provider;
   * a passed instance is always honored as-is.
   *
   * There is no default provider: omitting this slot makes `prepare()` throw,
   * so a deployment never boots without auth by accident. Pass `null` to
   * disable auth entirely (open server, local-dev behavior).
   */
  auth?: IMastraAuthProvider | null;
  /**
   * REQUIRED. Factory storage backend powering BOTH agent storage (threads,
   * messages, memory, OM — via `getMastraStorage()`) and the app tables
   * (projects/source-control/audit/intake — via the generic ops surface). Pass a
   * `PgFactoryStorage` (`@mastra/pg`) for deployments or a
   * `LibSQLFactoryStorage` (`@mastra/libsql`) for local dev — one backend,
   * one connection, every feature on.
   */
  storage: FactoryStorage;
  /**
   * Vector store instance for recall search — `PgVector` (`@mastra/pg`) on
   * the same database as `storage`. Omitted → the SDK mount's default vector
   * store resolution applies.
   */
  vector?: MastraVector;
  /**
   * Host-owned Knowledge runtime. Factory registers this exact instance under `key` and uses that
   * key for its read surfaces. Its scope declarations must declare `org:$orgId` and `project:$projectId`,
   * the scopes every Factory session run holds. Omitted turns Knowledge off.
   */
  knowledge?: { key: string; instance: Knowledge };
  /**
   * Distributed event bus instance (e.g. `new RedisStreamsPubSub({ url })`).
   * When set, streams/workflows/signals ride it across processes and the
   * controller drops file-based thread locks in favor of pubsub-coordinated
   * leases. Omitted → in-process default.
   */
  pubsub?: PubSub;
  /**
   * Browser-facing origin used to build integration OAuth/install callback
   * URLs and to derive the auth redirect URI. On the platform the SPA is
   * hosted separately, so this MUST be the public API origin.
   * Default: `http://localhost:4111` (the local Factory server, which also
   * serves the UI).
   */
  publicUrl?: string;
  /**
   * The Factory MCP server at `/web/factory/projects/:projectId/mcp`, which lets
   * MCP clients such as ChatGPT use the Factory tools as the signed-in user.
   * On by default with Mastra Platform auth; other providers need
   * `authorizationServers` set. Pass `false` to turn it off.
   */
  mcp?: false | FactoryMcpConfig;
  /**
   * Allowed cross-origin SPA origins. The SPA may be served from a separate
   * static host, so credentialed requests must be explicitly allowed.
   */
  allowedOrigins?: string[];
  /**
   * The host's sandbox: a FactorySandbox instance such as
   * `new LocalFactorySandbox({ ... })`, which owns the session sandbox
   * constructor, the repo template and the schema of environment settings.
   * A bare callback is also accepted and wrapped as a `provider: 'custom'`
   * sandbox with no settings. Omitted → repository sandboxes are
   * disabled.
   */
  sandbox?: MastraFactorySandboxOption;
  /** Browser automation provider for Factory agent sessions. */
  browser?: MastraBrowser;
  /**
   * When a session's sandbox boots: on the agent's first command (`'lazy'`,
   * the default) or as soon as the session's workspace is first resolved
   * (`'eager'`), so the boot overlaps the model's own latency.
   */
  sandboxStart?: FactorySandboxStart;
  /**
   * Agent controller built-in tools (e.g. `submit_plan`) removed from every
   * Factory session, along with their prompt guidance. Use this when a custom
   * board gates planning with its own phase transition, so the in-session plan
   * approval cannot bypass that gate.
   */
  disableBuiltinTools?: BuiltinToolId[];
  /** Background Factory dispatcher configuration. */
  dispatcher?: MastraFactoryDispatcherConfig;
  /**
   * The Claude Code harness, for factories created with `harness: 'claude-code'`.
   * Omitted → such factories cannot start runs; Mastra factories are unaffected.
   */
  claudeCode?: MastraFactoryClaudeCodeConfig;
  /**
   * Deployment-stable secret for signing integration OAuth `state` values.
   * Omitted → a per-process random secret, which is fine for single-process
   * local development but rejected for integrations that declare
   * `requiresStableStateSigner`.
   */
  stateSecret?: string;
  /**
   * Encryption boundary for persisted model credentials, custom-provider API
   * keys, integration connections, and integration settings. Strongly
   * recommended whenever auth is enabled — omitting it falls back to explicit
   * plaintext compatibility with a boot-time warning.
   */
  secretEncryption?: FactorySecretEncryption;
  /**
   * Model providers that authenticate with the server process's own
   * credentials instead of per-account credentials. With auth enabled, these
   * providers are only usable when listed here; the stored-key flow is never
   * offered for them. Supported: `'amazon-bedrock'` (AWS credential chain —
   * `AWS_BEARER_TOKEN_BEDROCK` or access keys/profile/role plus `AWS_REGION`).
   * Every signed-in account can then run these models on the deployment's
   * credentials. Default: none.
   */
  deploymentModelProviders?: readonly string[];
  /**
   * Registered capability providers. The factory registers the pieces each
   * `FactoryIntegration` instance provides — HTTP routes, storage domains,
   * agent/session tools, intake, source control, and diagnostics — into the
   * system. When Platform credentials are configured, missing `github` and
   * `gitlab` integrations default to their Platform-backed implementations.
   * v4 carries only GitHub and GitLab; Linear, Jira, incident.io, and Slack
   * were dropped (see MIGRATION.md).
   */
  integrations?: FactoryIntegration[];
  /**
   * Operator-maintained provenance label stamped on transition audit rows,
   * deferred decisions, and session kickoff headers so a row can be traced
   * back to the deployment that produced it. Nothing branches on it.
   * Default: `factory-config-v1`.
   */
  configVersion?: string;
  /**
   * Boards stored in every project once, next to the boards each project stored.
   *
   * @deprecated Write board definitions into projects with `factory.upsertBoard()`, or manage them
   * through the boards API (`/web/factory/projects/:id/boards`). Boards passed here still work: each
   * project stores them once and is served from its rows, with the code behaviour they declare.
   */
  boards?: readonly InstalledBoard[];
  /**
   * App skills written in code with `createSkill()` from `@mastra/core/skills`.
   * Every Factory session can load them, and a board phase runs one through
   * `runner.skill`. A skill here wins over a `factory-skills/` folder skill or
   * a bundled skill of the same name. Names must be unique.
   */
  skills?: readonly InlineSkill[];
  /**
   * Where card and session attachments keep their bytes (any `AttachmentBlobStore`: the local
   * `LocalFileBlobStore`, or an object store). The store is initialized at boot and a failure
   * fails the boot. Without it the attachment routes answer 503 and agents get no attachment tool.
   */
  attachments?: {
    store: AttachmentBlobStore;
    /** Per-file limit in bytes. Default: 50 MiB. */
    maxBytes?: number;
  };
  /**
   * Whether projects get the built-in Work board, stored in each project once. Default: true.
   */
  includeDefaultBoards?: boolean;

  /**
   * Platform-specific overrides.
   */
  platform?: {
    /** Identifies Factory's own GitHub App writes so their webhook deliveries do not retrigger triage. */
    githubAppSlug?: string;
    /**
     * Overrides for the `PlatformGithubIntegration` the factory installs itself
     * when Platform credentials are present; these options are forwarded to its
     * constructor. An explicit integration with id `github` in `integrations`
     * takes precedence and makes this key a no-op, so the two are not meant to
     * be used together.
     */
    github?: {
      /** Replace an event handler, or disable it with null; omitted events keep defaults. */
      rules?: GithubRuleOverrides;
      /**
       * GitHub App slug used to recognize Factory's own webhook writes. Falls
       * back to `githubAppSlug` when omitted.
       */
      slug?: string;
    };
  };
}

/** Read-only web tools a Product card's Claude Code run may use without asking (Brief: providers' pricing pages). */
export const PRODUCT_WEB_READ_TOOLS = ['WebFetch', 'WebSearch'] as const;

/** How this server runs Claude Code sessions (see `createClaudeFactoryHarness`). */
export interface MastraFactoryClaudeCodeConfig
  extends Pick<
    ClaudeFactoryHarnessOptions,
    'configDir' | 'allowedTools' | 'approvedPermissionMode' | 'turnTimeoutMs' | 'skillsDir' | 'command' | 'spawn' | 'env'
  > {
  /** Where session records live; required unless `store` is given. */
  storeDir?: string;
  store?: ClaudeFactoryHarnessOptions['store'];
  /**
   * Local development: the server and the person's browser share a machine, so Claude sign-in
   * (which opens the CLI's browser page here) is offered. Turns still use only the stored accounts.
   */
  localDevelopment?: boolean;
  /** Replaces the default credentials (`createClaudeCodeCredentials`: the organization's Anthropic accounts). */
  credentials?: ClaudeCodeCredentialsHook;
  /** Goes with a replaced `credentials` hook: told when a turn's account ran out of usage or was refused. */
  onCredentialFailure?: ClaudeCodeCredentialFailureHook;
  /** Replaces the default checkout (`createClaudeCheckoutResolver`). */
  cwdFor?: (sessionId: string) => string | Promise<string>;
  /** The origin the CLI reaches this server's MCP endpoint at; `publicUrl` by default. */
  mcpOrigin?: string;
  /** Secret for MCP session tokens; `stateSecret` by default, else a per-process key. */
  sessionTokenSecret?: string;
}

export type { MastraFactorySandboxConfig, MastraFactorySandboxOption } from '@factory/sandbox';
export type { FactorySandboxStart } from '@factory/harness-mastra';

/**
 * Per-process cap on concurrent background Factory dispatches. Omitted means
 * the dispatcher default; this is a local replica budget, not a global queue
 * limit shared across deployments.
 */
export interface MastraFactoryDispatcherConfig {
  maxInFlight?: number;
}

const CONTROLLER_ID = 'code';

/** Thrown by `prepare()` when no `auth` slot was configured. */
const MISSING_AUTH_ERROR =
  'MastraFactory: no auth provider configured. Set FACTORY_LOCAL_DEV_AUTH=1 for local single-user ' +
  'development, MASTRACODE_AUTH_DISABLED=1 to run without authentication, or pass an auth provider ' +
  "(MastraFactory's `auth` option; `null` disables auth).";

/** Why a wake couldn't be run as its Factory session's owner. */
const WAKE_OWNER_UNRESOLVED = {
  'session-not-found': 'no Factory session row names its owner',
  'organization-unresolved': "its owner's organization is unresolved",
  'organization-mismatch': "its owner's organization doesn't match",
} as const;

function hasPlatformCredentials(): boolean {
  // MASTRA_PLATFORM_ACCESS_TOKEN is the credential Mastra Platform injects
  // into deployed projects; MASTRA_PLATFORM_SECRET_KEY is the org secret key
  // written by project scaffolding. Either enables the platform integrations.
  return Boolean(process.env.MASTRA_PLATFORM_ACCESS_TOKEN?.trim() || process.env.MASTRA_PLATFORM_SECRET_KEY?.trim());
}

/** A session parking or being answered is inbox news, so the registry bumps the project's feed. */
function liveSessionsTouchingTheFeed(eventBus: PubSub, ...notifiers: SessionNotifier[]): LiveSessions {
  const liveSessions = new LiveSessions(...notifiers);
  liveSessions.onParkedChanged(session => {
    const { factoryOrgId, factoryProjectId } = session.state.get();
    if (factoryOrgId && factoryProjectId) touchFeed(eventBus, { orgId: factoryOrgId, factoryProjectId });
  });
  return liveSessions;
}

let warnedDefinedBoards = false;

/** Warns once per process when the app declares boards in code; Factory's own boards never warn. */
function warnDefinedBoards(boards: BoardRegistry): void {
  if (warnedDefinedBoards || ![...boards.values()].some(isDefinedBoard)) return;
  warnedDefinedBoards = true;
  console.warn(
    '[Factory] MastraFactory({ boards }) and defineBoard() are deprecated: boards live in the database, and each project stores these definitions once. Write board definitions into projects with factory.upsertBoard(), or manage them through the boards API (`/web/factory/projects/:id/boards`).',
  );
}

/**
 * The fleet-era `sandbox` options and what replaced each one. Only the keys
 * the host actually passed are explained, so a host that never used the fleet
 * gets the short message.
 */
const RETIRED_SANDBOX_OPTIONS: Record<string, string> = {
  machine:
    "'machine' becomes the provider instance: one sandbox per session, constructed by the FactorySandbox, instead of one template machine cloned per repository",
  workdir:
    "'workdir' becomes the workingDirectory of the FactorySandboxContext, which every provider passes to its sandbox; when it is absent the provider uses its own default",
  maxSandboxes: "'maxSandboxes' is gone with the sandbox fleet: there is one sandbox per session and no pool to cap",
};

function invalidSandboxOptionMessage(option: unknown): string {
  const lines = [
    `MastraFactory: 'sandbox' must be a FactorySandbox instance or a callback constructing a MastraSandbox from a FactorySandboxContext:`,
    `  sandbox: new LocalFactorySandbox({ root })`,
    `  sandbox: ctx => new LocalSandbox({ id: ctx.sessionId })`,
  ];
  if (typeof option === 'object' && option !== null) {
    const retired = Object.keys(RETIRED_SANDBOX_OPTIONS).filter(key => key in option);
    if (retired.length > 0) {
      lines.push(`The object you passed is the retired alpha sandbox config. Its options map as follows:`);
      for (const key of retired) lines.push(`  ${RETIRED_SANDBOX_OPTIONS[key]}.`);
    }
  }
  return lines.join('\n');
}

export class MastraFactory {
  readonly #config: MastraFactoryConfig;
  /** The normalized sandbox, set by `prepare()`. Undefined until then and when sandboxes are disabled. */
  #sandbox: FactorySandbox | undefined;
  #sandboxDescription: FactorySandboxDescription | undefined;
  /** The code boards (built-in and app boards), served to every project and never stored. */
  readonly #boards: BoardRegistry;
  /** Each project's boards: the code boards plus the boards it stored. Undefined until `prepare()` or when the boards domain is down. */
  #projectBoards: ProjectBoardCache | undefined;
  /** Writes to stored boards for `upsertBoard()`; undefined until `prepare()` or when the boards domain is down. */
  #boardStore: { writes: BoardWrites; projects: FactoryProjectsStorage; audit: AuditDomain } | undefined;
  readonly #skills: readonly InlineSkill[];
  readonly #configVersion: string;
  #prepared: Awaited<ReturnType<typeof prepareAgentControllerMount>> | undefined;
  #dispatcher: FactoryDecisionDispatcher | undefined;
  /** Names this replica on the dispatch-wake topic so it can skip its own echoes. */
  readonly #dispatchWakeOrigin = globalThis.crypto.randomUUID();
  #unsubscribeDispatchWakes: Promise<(() => Promise<void>) | undefined> | undefined;
  #startCoordinator: FactoryStartCoordinator | undefined;
  #factoryProcessor: FactoryPhaseStateProcessor | undefined;
  /** Environment builds through the sandbox's `builds`; undefined when the sandbox has none. */
  #environmentBuilds: EnvironmentBuildRunner | undefined;
  /** Intake rules' engine and the workflow their schedules fire; undefined until work items and their storage are up. */
  #intakeRules: ReturnType<typeof setupIntakeRules> | undefined;
  /** The background session resource migration; resolves `true` when it moved run bindings. */
  #sessionResourceMigration: Promise<boolean> | undefined;
  #workItemSplitBackfill: { controller: AbortController; promise: Promise<void> } | undefined;
  #prepareStartedAt: number | undefined;
  #preparing = false;
  /** Serves the chat's session routes for Claude Code sessions; inert until a session is attached or resolvable. */
  readonly #claudeSessionUi: ClaudeSessionUi;

  constructor(config: MastraFactoryConfig) {
    if (!config?.storage) {
      throw new Error(
        "MastraFactory: 'storage' is required. Pass a FactoryStorage backend — e.g. " +
          "new PgFactoryStorage({ connectionString }) from '@mastra/pg' for deployments, or " +
          "new LibSQLFactoryStorage({ url }) from '@mastra/libsql' for local dev.",
      );
    }
    this.#boards = createDefaultBoardRegistry({
      boards: config.boards,
      includeDefaultBoards: config.includeDefaultBoards,
    });
    warnDefinedBoards(this.#boards);
    if ('rules' in config) {
      throw new Error(
        "MastraFactory: 'rules' was removed. Set 'configVersion' for the audit label and declare tool-result " +
          'rules on the owning board (`tools`).',
      );
    }
    this.#skills = assertFactorySkills(config.skills);
    for (const problem of findBoardSkillProblems(this.#boards, this.#skills)) {
      console.warn(`[factory] ${problem}`);
    }
    this.#configVersion = assertFactoryConfigVersion(config.configVersion ?? DEFAULT_FACTORY_CONFIG_VERSION);
    this.#config = config;
    this.#claudeSessionUi = createClaudeSessionUi({
      controllerId: CONTROLLER_ID,
      // Read per call: the Mastra store is only ready once the factory is prepared.
      storage: { getStore: name => config.storage.getMastraStorage().getStore(name) },
    });
  }

  /**
   * Shows Claude Code sessions in the chat. Attach each session the Claude
   * Code harness builds (`onSession: session => factory.claudeSessionUi.attach(session)`)
   * and give it the harness's lookup (`setSessionResolver(id => harness.getSession(id))`);
   * see `@factory/harness-claude-code-ui`.
   */
  get claudeSessionUi(): ClaudeSessionUi {
    return this.#claudeSessionUi;
  }

  /**
   * The host sandbox's provider, settings schema (JSON Schema) and
   * capabilities, as the environment route reports them. Undefined before
   * `prepare()` and when sandboxes are disabled.
   */
  get sandboxDescription(): FactorySandboxDescription | undefined {
    if (!this.#sandbox) return undefined;
    this.#sandboxDescription ??= describeFactorySandbox(this.#sandbox);
    return this.#sandboxDescription;
  }

  /**
   * Writes a board definition into projects: each project that has no board under its key gets
   * it, and each one that has it, edited or not, has it replaced at the next revision. Use it to
   * push a board from code into projects; it isn't run for you, and projects created later don't
   * get it until you run it again. A Work or app board's key keeps that board's code behaviour,
   * so the definition is checked as an edit is; a new key gets none (no handlers, outcomes, tool or
   * event rules). The board is validated once, as the boards API does, and each write is audited
   * as `factory.board.created` or `factory.board.updated` by `system:factory`. Refusals throw a
   * `BoardWriteError` (`invalid_board`, `unknown_skill`, `code_behaviour`, `code_board` when a
   * code board can't take the write, `phase_in_use` when cards sit in a phase it removes, `project_not_found`).
   * Available after `prepare()`.
   *
   * @example
   * ```ts
   * const { inserted, updated, unchanged } = await factory.upsertBoard(
   *   {
   *     key: 'bugs',
   *     name: 'Bugs',
   *     phases: [
   *       { key: 'reported', name: 'Reported', kind: 'resting', nextPhases: ['fixing'] },
   *       { key: 'fixing', name: 'Fixing', kind: 'working', runner: { context: 'work' }, nextPhases: ['fixed'] },
   *       { key: 'fixed', name: 'Fixed', kind: 'terminal' },
   *     ],
   *   },
   *   { projects: 'all' },
   * );
   * ```
   */
  async upsertBoard(
    board: StoredBoardInput,
    options: { projects: 'all' | readonly StoredBoardScope[] },
  ): Promise<{ inserted: StoredBoardScope[]; updated: StoredBoardScope[]; unchanged: StoredBoardScope[] }> {
    const store = this.#boardStore;
    if (!store) {
      throw new Error(
        this.#preparing
          ? "MastraFactory.upsertBoard(): the boards storage isn't available, so boards can't be stored."
          : 'MastraFactory.upsertBoard() needs prepare() first.',
      );
    }
    const { writes, projects, audit } = store;
    const input = writes.validate(board);
    // Work and app boards are stored per project like any other.
    writes.refuseCodeBoard(input.key, 'edit');
    await projects.ensureReady();
    let scopes: StoredBoardScope[];
    if (options.projects === 'all') {
      scopes = (await projects.listAll()).map(project => ({ orgId: project.orgId, factoryProjectId: project.id }));
    } else {
      scopes = [...options.projects];
      for (const scope of scopes) {
        if (!(await projects.get({ orgId: scope.orgId, id: scope.factoryProjectId }))) {
          throw new BoardWriteError(404, {
            error: 'project_not_found',
            message: `Project "${scope.factoryProjectId}" does not exist.`,
          });
        }
      }
    }
    const result: { inserted: StoredBoardScope[]; updated: StoredBoardScope[]; unchanged: StoredBoardScope[] } = {
      inserted: [],
      updated: [],
      unchanged: [],
    };
    for (const scope of scopes) {
      const writer: BoardWriter = {
        id: 'factory',
        audit: async entry => {
          await audit.record({ orgId: scope.orgId, actorId: 'factory', actorType: 'system', ...entry });
        },
      };
      result[await writes.upsert(scope, input, writer)].push(scope);
    }
    return result;
  }

  /**
   * Resolve feature readiness, wire every dependency explicitly, and assemble
   * everything needed to construct the server-owned Mastra. Returns the args
   * for the `new Mastra(...)` literal that must live in the entry file.
   */
  async prepare(): Promise<MastraArgs> {
    // Guard set synchronously (before the first await) so overlapping calls —
    // not just strictly sequential ones — can't double-seed the runtime
    // registry or double-run one-time adapter init.
    if (this.#preparing) throw new Error('MastraFactory.prepare() called twice');
    this.#preparing = true;
    this.#prepareStartedAt = performance.now();

    const publicOrigin = (this.#config.publicUrl ?? 'http://localhost:4111').replace(/\/+$/, '');
    const allowedOrigins = (this.#config.allowedOrigins ?? []).map(o => o.replace(/\/+$/, '')).filter(Boolean);
    const storage = instrumentAsyncMethods(this.#config.storage, 'storage');
    const vector = this.#config.vector;
    const pubsub = this.#config.pubsub;
    // One bus for feed/attention events: a second fallback instance would leave
    // SSE subscribers and producers on different emitters in single-process runs.
    const eventBus = pubsub ?? new EventEmitterPubSub();
    // Auth: honor an explicitly-passed provider (including `null` to disable
    // auth) as-is. There is no default provider — an unset slot is a
    // configuration mistake, and silently booting an open server is worse
    // than refusing to boot.
    const configuredAuth = this.#config.auth;
    if (configuredAuth === undefined) throw new Error(MISSING_AUTH_ERROR);
    const auth: IMastraAuthProvider | undefined = configuredAuth ?? undefined;
    if (auth && !this.#config.secretEncryption) {
      console.warn(
        "[factory] auth is enabled but 'secretEncryption' is not configured. Persisted model credentials, " +
          'custom-provider API keys, and integration secrets will be stored as plaintext. Provide ' +
          "'secretEncryption' (e.g. via FACTORY_CREDENTIAL_ENCRYPTION_KEY) to encrypt them at rest.",
      );
    }
    const secretEncryption = this.#config.secretEncryption ?? createPlaintextFactorySecretEncryption();
    const deploymentModelProviders = resolveDeploymentModelProviders(this.#config.deploymentModelProviders);
    // One RouteAuth seam per boot, closed over the resolved provider. Every
    // factory route module receives this handle — no service locator.
    const routeAuth = createFactoryRouteAuth(auth);
    const mcpConfig = this.#config.mcp;
    const mcpAuthorizationServers =
      mcpConfig === false || mcpConfig?.enabled === false ? [] : resolveMcpAuthorizationServers(mcpConfig);
    // The MCP endpoint authenticates callers itself, so it needs an auth
    // provider and somewhere for clients to get tokens, unless the provider
    // needs no token (loopback dev auth).
    const mcpEnabled =
      Boolean(auth) &&
      mcpConfig !== false &&
      mcpConfig?.enabled !== false &&
      (mcpAuthorizationServers.length > 0 || mcpConfig?.tokenless === true);

    // Explicit integrations win. Platform credentials fill only missing
    // provider slots so callers can override each integration independently.
    const integrations = [...(this.#config.integrations ?? [])];
    const explicitGithub = integrations.some(integration => integration.id === 'github');
    // Whether this boot constructed the GitHub integration on the caller's
    // behalf — `platform.github` is only meaningful in that case.
    let installedPlatformGithub = false;
    if (hasPlatformCredentials()) {
      if (!explicitGithub) {
        // Forward `platform.github` to the integration the factory installs
        // itself. `slug` falls back to the sibling `githubAppSlug` so existing
        // deploys keep working; the constructor validates and freezes `rules`,
        // so invalid ones fail boot.
        integrations.push(
          new PlatformGithubIntegration({
            rules: this.#config.platform?.github?.rules,
            slug: this.#config.platform?.github?.slug ?? this.#config.platform?.githubAppSlug,
          }),
        );
        installedPlatformGithub = true;
      }
      if (!integrations.some(integration => integration.id === 'gitlab')) {
        integrations.push(new PlatformGitLabIntegration());
      }
    }
    // Never let the key be a silent no-op: it only applies to the integration
    // the factory installs itself, so warn when it had nothing to apply to.
    if (this.#config.platform?.github && !installedPlatformGithub) {
      console.warn(
        "[factory] 'platform.github' config was provided but the factory installed no GitHub integration of its " +
          'own ' +
          (explicitGithub
            ? "(an explicit integration with id 'github' takes precedence, so these options were ignored)."
            : '(no Platform credentials are configured and no explicit GitHub integration was passed).'),
      );
    }

    // Validate ids up front so a copy-paste duplicate fails loud instead of one
    // instance silently shadowing the other.
    const integrationIds = new Set<string>();
    for (const integration of integrations) {
      if (integrationIds.has(integration.id)) {
        throw new Error(`MastraFactory: duplicate integration id '${integration.id}' in 'integrations'.`);
      }
      integrationIds.add(integration.id);
    }
    const configVersion = this.#configVersion;

    // FactoryStorage owns every app-table domain and initializes them through
    // the same lifecycle as the backend connection.
    const intakeStorage = storage.registerDomain(new IntakeStorage());
    const auditStorage = storage.registerDomain(new AuditStorage());
    const workItemsStorage = storage.registerDomain(new WorkItemsStorage());
    workItemsStorage.onAttentionChanged(scope => touchFeed(eventBus, scope));
    // The dispatcher sleeps while idle. It wakes itself on this replica's writes
    // that leave claimable work; the bus carries those wakes to other replicas.
    workItemsStorage.onClaimableWork(() => publishDispatchWake(eventBus, this.#dispatchWakeOrigin));
    this.#unsubscribeDispatchWakes = subscribeDispatchWakes(eventBus, this.#dispatchWakeOrigin, () =>
      this.#dispatcher?.wake(),
    ).catch(error => {
      console.warn(
        `[factory] subscribing to dispatcher wakes failed; other replicas' work waits for this replica's own wakes: ${error instanceof Error ? error.message : error}`,
      );
      return undefined;
    });
    workItemsStorage.useTerminalPhasePredicate(item =>
      isTerminalWorkItem(this.#projectBoards?.forProject(item) ?? this.#boards, item),
    );
    const modelCredentialsStorage = storage.registerDomain(new ModelCredentialsStorage(secretEncryption));
    const memorySettingsStorage = storage.registerDomain(new MemorySettingsStorage());
    const storedBoardsStorage = storage.registerDomain(new StoredBoardsStorage());
    const customProvidersStorage = storage.registerDomain(new CustomProvidersStorage(secretEncryption));
    const queueHealthStorage = storage.registerDomain(new QueueHealthStorage());
    // Generic integration storage (connections/subscriptions/settings) — the
    // default persistence surface for integrations without a bespoke domain.
    const integrationStorage = storage.registerDomain(new IntegrationStorage(secretEncryption));
    const factoryProjectsStorage = storage.registerDomain(new FactoryProjectsStorage());
    const filesystemStorage = storage.registerDomain(new FilesystemStorage());
    const sourceControlStorage = storage.registerDomain(new SourceControlStorage());
    // Reverse index from a platform sender (Slack/Discord/...) to a Mastra
    // tenant, so inbound channel events can resolve the sender's model creds.
    const channelIdentityStorage = storage.registerDomain(new ChannelIdentityStorage());
    const workItemCommentsStorage = storage.registerDomain(new WorkItemCommentsStorage());
    const skillOverridesStorage = storage.registerDomain(new SkillOverridesStorage());
    const attachmentsStorage = storage.registerDomain(new AttachmentsStorage());
    const intakeRulesStorage = storage.registerDomain(new IntakeRulesStorage());
    // Every app-table domain handle the route builders and integrations need,
    // threaded explicitly (no service locator).
    const domains = {
      intake: intakeStorage,
      modelCredentials: modelCredentialsStorage,
      memorySettings: memorySettingsStorage,
      customProviders: customProvidersStorage,
      filesystem: filesystemStorage,
      projects: factoryProjectsStorage,
      queueHealth: queueHealthStorage,
      workItems: workItemsStorage,
      channelIdentity: channelIdentityStorage,
      comments: workItemCommentsStorage,
      skillOverrides: skillOverridesStorage,
    };
    const auditDomain = new AuditDomain({
      auth: routeAuth,
      audit: auditStorage,
      projects: factoryProjectsStorage,
      users: auth && isUserProvider(auth) ? auth : undefined,
      sinks: integrations,
      agentTenant: requestContext => {
        const user = getFactoryAuthUserFromContext(requestContext);
        return { orgId: getFactoryAuthOrgId(user), userId: getFactoryAuthUserId(user) };
      },
    });
    // Held by reference: the channel attach below pushes into it, long after this.
    const feedPublishers: WorkItemFeedPublisher[] = [];
    const commentsDomain = new CommentsDomain({
      auth: routeAuth,
      comments: workItemCommentsStorage,
      workItems: workItemsStorage,
      projects: factoryProjectsStorage,
      channelIdentity: channelIdentityStorage,
      audit: auditDomain,
      publishers: feedPublishers,
      pubsub: eventBus,
    });

    const sandboxOption = this.#config.sandbox;
    let sandboxConfig: FactorySandbox | undefined;
    if (sandboxOption === undefined || isFactorySandbox(sandboxOption)) {
      sandboxConfig = sandboxOption;
    } else if (typeof sandboxOption === 'function') {
      sandboxConfig = new CallbackFactorySandbox(sandboxOption);
    } else {
      throw new Error(invalidSandboxOptionMessage(sandboxOption));
    }
    this.#sandbox = sandboxConfig;

    const workspaceRegistry = new FactoryWorkspaceRegistry();

    // One shared OAuth state signer per boot. The deploy entry supplies a
    // replica-stable secret when needed; otherwise local development gets a
    // per-process random signer (`stable: false`).
    const stateSigner = createStateSigner(this.#config.stateSecret);

    // One-time provider initialization with factory-level context (e.g.
    // better-auth builds its default instance on the backend's auth
    // database, SSO providers derive their redirect URI from the public URL).
    // Failures surface here, at prepare() — a misconfigured provider must
    // not boot.
    if (auth && hasAuthInit(auth)) {
      await timedPhase('prepare.auth.init', () =>
        auth.init({ database: storage.authDatabase?.(), publicUrl: publicOrigin, allowedOrigins }),
      );
    }

    // Single init path: backend connection failure is a hard boot error;
    // registered app domains initialize fail-soft inside FactoryStorage.
    await timedPhase('prepare.storage.init', () => storage.init());
    // A configured attachment store that cannot start fails the boot rather than every upload.
    const attachmentsConfig = this.#config.attachments;
    if (attachmentsConfig) {
      await timedPhase('prepare.attachments.init', () => attachmentsConfig.store.init());
      const attachmentsInitError = storage.domainInitError('attachments');
      if (attachmentsInitError) throw attachmentsInitError;
    }
    const attachmentService = attachmentsConfig
      ? new AttachmentService({
          records: attachmentsStorage,
          blobs: attachmentsConfig.store,
          ...(attachmentsConfig.maxBytes !== undefined ? { maxBytes: attachmentsConfig.maxBytes } : {}),
        })
      : undefined;
    const workItemsInitError = storage.domainInitError('work-items');
    if (workItemsInitError instanceof WorkItemSplitModeError) throw workItemsInitError;
    for (const domain of storage.domainNames()) {
      const error = storage.domainInitError(domain);
      if (error === undefined) continue;
      console.error(
        `[factory] storage domain "${domain}" failed to initialize; features that use it stay unavailable until it does:`,
        error,
      );
    }

    // Each project's boards are the code boards plus the boards it stored. Load every project
    // before anything reads its boards; without the boards domain the code boards serve directly.
    if (storage.isDomainReady('boards') && storage.isDomainReady('projects')) {
      const projectBoards = new ProjectBoardCache({
        codeRegistry: this.#boards,
        storage: storedBoardsStorage,
        projects: factoryProjectsStorage,
        skillProblems: registry => findBoardSkillProblems(registry, this.#skills),
      });
      this.#projectBoards = projectBoards;
      this.#boardStore = {
        writes: new BoardWrites({ storage: storedBoardsStorage, boards: projectBoards, workItems: workItemsStorage }),
        projects: factoryProjectsStorage,
        audit: auditDomain,
      };
      await timedPhase('prepare.boards.preload', () =>
        projectBoards
          .preload()
          .catch(error =>
            console.warn(
              `[factory] loading project boards at startup failed; each project loads on first use: ${error instanceof Error ? error.message : error}`,
            ),
          ),
      );
    }
    const boards: BoardRegistry | ProjectBoardSource = this.#projectBoards ?? this.#boards;

    // Copy the legacy cards still in play before anything reads cards; done and canceled cards
    // follow in the background. A failure fails the boot: serving without open cards would let
    // rules file duplicates.
    if (storage.isDomainReady('work-items') && !workItemsStorage.legacyMode) {
      const projectBoards = this.#projectBoards;
      const projects = projectBoards
        ? new Set((await factoryProjectsStorage.listAll()).map(project => `${project.orgId}\u0000${project.id}`))
        : undefined;
      // A card whose project or board cannot be resolved counts as open, so it is copied now.
      const isTerminal = async (card: Card) => {
        let registry: BoardRegistry = this.#boards;
        if (projectBoards) {
          if (!projects!.has(`${card.orgId}\u0000${card.factoryProjectId}`)) return false;
          try {
            registry = await projectBoards.load(card);
          } catch {
            return false;
          }
        }
        return registry.has(boardForWorkItem(card)) && isTerminalWorkItem(registry, card);
      };
      await timedPhase('prepare.migrate.workItemSplit', () => workItemsStorage.migrateOpenLegacyCards(isTerminal));
    }

    // ClickUp tag routes became intake routes: move each one into its project's routes, once.
    // A failure stops the boot: the poller no longer reads tag routes, so they would go unapplied.
    if (storage.isDomainReady('intake') && storage.isDomainReady('boards')) {
      await timedPhase('prepare.intake.clickupTagRoutes', async () => {
        const moved = await migrateLabelRoutesToIntakeRoutes({
          integrationId: 'clickup',
          routeName: label => `ClickUp tag "${label}"`,
          intake: intakeStorage,
          boards: storedBoardsStorage,
        });
        if (moved > 0) console.info(`[factory] moved ${moved} ClickUp tag route(s) into intake routes`);
      });
    }

    // The Review board was retired: pull and merge requests are reviewed in Work › PR review.
    // Move its cards, its intake routes and the sources and label routes that fed it onto Work,
    // once. A failure stops the boot: those cards and routes would point at a board that's gone.
    if (storage.isDomainReady('work-items')) {
      await timedPhase('prepare.workItems.retireReviewBoard', async () => {
        const moved = await workItemsStorage.moveReviewBoardCardsToWork();
        if (moved.length > 0) console.info(`[factory] moved ${moved.length} Review board card(s) to Work › PR review`);
      });
    }
    if (storage.isDomainReady('boards')) {
      await timedPhase('prepare.boards.retireReviewBoardRoutes', async () => {
        const moved = await storedBoardsStorage.moveReviewBoardRoutesToWork(REVIEW_BOARD_RETIREMENT_ACTOR);
        if (moved > 0) console.info(`[factory] moved ${moved} intake route(s) from the Review board to Work`);
      });
    }
    if (storage.isDomainReady('intake')) {
      await timedPhase('prepare.intake.retireReviewBoardSources', async () => {
        const { bindings, labelRoutes } = await intakeStorage.moveReviewBoardSourcesToWork();
        if (bindings + labelRoutes > 0) {
          console.info(
            `[factory] moved ${bindings} intake source(s) and ${labelRoutes} label route(s) from the Review board to Work`,
          );
        }
      });
    }

    // Product's Breakdown became Phases, and the board gained Enrich and Design. Rewrite each
    // project's stored Product board, and move its cards and intake routes off the old phase
    // names, once. A failure stops the boot: those cards would sit in phases the board lacks.
    if (storage.isDomainReady('boards')) {
      await timedPhase('prepare.boards.productPhases', async () => {
        const rewritten = await storedBoardsStorage.renameStoredBoardPhases(
          productBoard.id,
          boardDefinitionOf(productBoard),
          PRODUCT_LEGACY_PHASE_RENAMES,
          PRODUCT_BOARD_UPGRADE_ACTOR,
        );
        if (rewritten > 0) console.info(`[factory] rewrote ${rewritten} stored Product board(s) with the new phases`);
      });
    }
    if (storage.isDomainReady('work-items')) {
      await timedPhase('prepare.workItems.productPhases', async () => {
        const moved = await workItemsStorage.renameBoardStages(productBoard.id, PRODUCT_LEGACY_PHASE_RENAMES);
        if (moved.length > 0) console.info(`[factory] moved ${moved.length} Product card(s) off Breakdown to Phases`);
      });
    }

    // Triage no longer holds a non-bug in Triage until someone accepts it; it sends it
    // back to Intake. Move the cards the old rule left there, once.
    if (storage.isDomainReady('work-items')) {
      await timedPhase('prepare.workItems.heldTriageCards', () =>
        workItemsStorage
          .returnHeldTriageCards()
          .then(moved => {
            if (moved.length > 0) {
              console.info(`[factory] moved ${moved.length} card(s) held for triage acceptance back to Intake`);
            }
          })
          .catch(error =>
            console.warn(
              `[factory] moving cards held for triage acceptance back to Intake failed: ${error instanceof Error ? error.message : error}`,
            ),
          ),
      );
    }

    // Per-tenant model credentials: once the credentials domain is up, model
    // resolution goes through the caller's own store and the SDK stops
    // mirroring stored API keys into process.env.
    //
    // Only register when a real auth adapter gates callers. In local /
    // auth-disabled mode there is no authenticated tenant, so registering would
    // force every model call through an empty tenant store (fail-closed, no env
    // fallback) and break chat with "Not logged in". Leaving it unregistered
    // lets the SDK fall back to the file-backed AuthStorage (auth.json) — the
    // same store the local /login and Settings pages read and write.
    // Custom providers: DB-backed in both modes (org rows in tenant mode, the
    // sentinel `local` org in no-auth mode). Once registered, model resolution
    // and the gateway catalog never read settings.json custom providers.
    registerCustomProvidersSource({ storage: customProvidersStorage, authEnabled: Boolean(auth) });

    for (const integration of integrations) {
      const integrationSourceControl = integration.versionControl
        ? sourceControlStorage.forIntegration(integration.id)
        : undefined;
      integration.initialize?.({
        storage: integrationStorage.forIntegration(integration.id),
        projects: factoryProjectsStorage,
        auth: routeAuth,
        intake: intakeStorage,
        ...(integrationSourceControl ? { sourceControl: integrationSourceControl } : {}),
      });
      if (integration.versionControl && integrationSourceControl) {
        integration.versionControl.initialize({ storage: integrationSourceControl });
      }
    }
    // Keep the legacy GitHub partition readable even when no GitHub
    // integration is registered; existing sessions may outlive a config change.
    const sourceControlIntegrationIds = [
      ...new Set(['github', ...integrations.filter(integration => integration.versionControl).map(({ id }) => id)]),
    ];
    const sourceControlHandles = sourceControlIntegrationIds.map(id => sourceControlStorage.forIntegration(id));
    const sourceControlSessions = createSourceControlSessionLookup(sourceControlHandles);
    if (auth) {
      registerTenantCredentialResolver(modelCredentialsStorage, deploymentModelProviders, requestContext =>
        resolveFactoryCredentialTenant(requestContext, {
          projects: factoryProjectsStorage,
          sourceControl: sourceControlSessions,
          workItems: workItemsStorage,
        }),
      );
    }

    // Every integration uses generic integration storage. Version-control
    // providers additionally require the source-control storage domain. Readiness
    // is derived solely from capability presence, never from provider ids.
    const integrationRegistrations = integrations.map(integration => {
      const requiredDomains = [
        'integrations',
        ...(integration.versionControl ? ['source-control'] : []),
        // Channels resolve an inbound sender to a tenant through the reverse
        // index; without it every message would dispatch tenant-less.
        ...(integration.channels ? ['channel-identity'] : []),
      ];
      return {
        integration,
        ready: requiredDomains.every(domain => storage.isDomainReady(domain)),
        ensureReady: async () => {
          for (const domain of requiredDomains) await storage.ensureDomainReady(domain);
        },
      };
    });
    const intakeReady =
      integrations.some(integration => integration.intake !== undefined) && storage.isDomainReady('intake');
    const factoryReady = storage.isDomainReady('projects') && storage.isDomainReady('work-items');
    // Sessions from before shared resources ran under their own id. Move them
    // onto their Factory or owner in the background: it can take minutes on a
    // remote database, and an unmoved session keeps working under its own id
    // meanwhile. Run bindings decide which sessions belong to a Factory, so it
    // waits for work items.
    if (storage.isDomainReady('source-control') && storage.isDomainReady('work-items')) {
      this.#sessionResourceMigration = timedPhase('background.migrate.sessionResources', async () => {
        try {
          const mastraStorage = storage.getMastraStorage();
          const memory = await mastraStorage.getStore('memory');
          if (!memory) return false;
          // The sessions' own Memory, so a moved thread takes its observation vectors along.
          const sessionMemory = getDynamicMemory(mastraStorage, vector);
          const report = await migrateSessionResources({
            sessions: sourceControlStorage,
            workItems: workItemsStorage,
            ...(storage.isDomainReady('integrations') ? { integrations: integrationStorage } : {}),
            memory,
            threads: sessionMemory({ requestContext: new RequestContext() }),
          });
          await sessionMemory.settled();
          await privatizeOwnerResourceSessions({ sessions: sourceControlStorage, workItems: workItemsStorage, memory });
          return report.runBindings > 0;
        } catch (error) {
          // Unmoved sessions keep working under their own id; the next start retries.
          console.warn(
            `[factory] session resource migration stopped early: ${error instanceof Error ? error.message : error}`,
          );
          return false;
        }
      });
    }
    if (workItemsStorage.legacyBackfillPending) {
      const controller = new AbortController();
      this.#workItemSplitBackfill = {
        controller,
        promise: timedPhase('background.migrate.workItemSplit', () =>
          backfillUntilDone(
            () => workItemsStorage.backfillLegacyCards({ signal: controller.signal }),
            controller.signal,
          ),
        ),
      };
    }
    // Mastra 1.82 removed Subconscious, the curator this flag turned on, and dropped its node store. Refuse
    // to boot rather than run with Knowledge silently off.
    if (process.env.MASTRACODE_EXPERIMENTAL_SUBCONSCIOUS === '1') {
      throw new Error(
        '[Factory] MASTRACODE_EXPERIMENTAL_SUBCONSCIOUS is no longer supported: Subconscious was removed in Mastra 1.82. ' +
          'Unset it, and pass `knowledge: { key, instance: new Knowledge({ scopes }) }` to MastraFactory to turn Knowledge on.',
      );
    }
    const knowledgeEnabled = this.#config.knowledge !== undefined;
    const githubIntegration = integrations.find(integration => integration.id === 'github') as
      | GithubIntegration
      | undefined;
    const gitlabIntegration = integrations.find(
      integration => integration.id === 'gitlab' && integration.intake && integration.versionControl,
    );
    const workItemsReady = storage.isDomainReady('work-items');
    // Set once the Claude Code harness exists (below): a deleted session's CLI config dir goes with it.
    let removeClaudeSessionConfig: ((sessionId: string) => Promise<void>) | undefined;
    // Set with it too: a side session of a Claude Code Factory is a Claude Code session.
    let createClaudeSideSession: FactoryToolDependencies['createHarnessSession'];
    // Every session's run state, whichever harness runs it; assigned with the routes.
    let liveSessionRegistry: LiveSessions | undefined;
    // One sandbox folder per card, shared by the card's role sessions: the
    // workspace, retirement and the Claude Code checkout all derive it here.
    // Only the local sandbox shares disk between sessions; a host's own
    // sandbox keeps one sandbox per session, as before.
    const workItemFolders =
      sandboxConfig instanceof LocalFactorySandbox
        ? createWorkItemFolders(workItemsReady ? { workItems: workItemsStorage } : {})
        : undefined;
    // A Product session reads a sibling card's unmerged change from that card's folder on this machine.
    const localSandbox = sandboxConfig instanceof LocalFactorySandbox ? sandboxConfig : undefined;
    const productCardFolderPath = localSandbox
      ? ({ factoryProjectId, branch }: { factoryProjectId: string; branch: string }) =>
          localSandbox.workItemFolderPath(workItemFolderKey(factoryProjectId, branch))
      : undefined;
    // `factory_read_session` reads a referenced session's thread, oldest first, a bounded number of pages.
    const productReadThread = async ({ threadId, resourceId }: { threadId: string; resourceId?: string }) => {
      const memory = await storage.getMastraStorage().getStore('memory');
      if (!memory) throw new Error('This Factory keeps no message store, so a session cannot be read.');
      const messages = [];
      for (let page = 0; page < 20; page++) {
        const result = await memory.listMessages({
          threadId,
          ...(resourceId ? { resourceId } : {}),
          page,
          perPage: 100,
          orderBy: { field: 'createdAt', direction: 'ASC' },
        });
        messages.push(...result.messages);
        if (!result.hasMore) break;
      }
      return messages;
    };
    const sessionRetirement =
      sandboxConfig && storage.isDomainReady('source-control')
        ? new SessionRetirementCoordinator({
            invalidateSession: sessionId => workspaceRegistry.invalidateSession(sessionId),
            onSessionDeleted: sessionId => removeClaudeSessionConfig?.(sessionId),
            sandbox: sandboxConfig,
            ...(workItemFolders ? { workItemFolders } : {}),
          })
        : undefined;
    // A card that is done or deleted takes its sandbox folder with it: torn
    // down once, removed, and every session of the card retired.
    const retireWorkItemSandboxes = sessionRetirement
      ? async (item: Card) => {
          await sessionRetirement.retireWorkItemSessions({
            workItems: workItemsStorage,
            sourceControl: sessionId => sourceControlSessions.getSourceControlBySessionId(sessionId),
            orgId: item.orgId,
            workItemId: item.id,
            sessionIds: Object.values(item.sessions).map(session => session.sessionId),
            ...(workItemFolders ? { folders: [workItemFolderForCard(item)] } : {}),
          });
        }
      : undefined;
    const retireTerminalSessions =
      retireWorkItemSandboxes && workItemsReady
        ? async ({ orgId, workItemId }: { orgId: string; workItemId: string }) => {
            const item = await workItemsStorage.get({ orgId, id: workItemId });
            if (!item) return;
            await retireWorkItemSandboxes(item);
          }
        : undefined;
    // Terminal-stage cleanup: ingest any trailing tool results from the item's
    // bound threads, then revoke the bindings so completed items leave the
    // reconcile walk (the active-binding set otherwise grows forever), and
    // finally release the item's sandboxes. Each step is best-effort — a
    // committed transition never fails on cleanup.
    const terminalCleanup = workItemsReady
      ? createTerminalStageCleanup({
          workItems: workItemsStorage,
          // `factoryProcessor` is assigned below in this scope; the cleanup
          // only runs on transitions long after bootstrap completes.
          reconcileBinding: async (binding): Promise<void> => {
            await factoryProcessor?.reconcileBinding(binding);
          },
          // Abort the live run on a retired seat so the model cannot keep
          // executing unbound (or be resumed later) once its binding is revoked.
          // `this.#prepared` is assigned below; cleanup only runs long after.
          abortSession: async (binding): Promise<void> => {
            const controller = this.#prepared?.base.controller;
            if (!controller) return;
            // Whichever harness runs the seat: a Claude Code session stops its CLI run.
            await abortSessionRun(controller, binding.sessionId);
          },
          // Session retirement supersedes the older direct sandbox release: it
          // invalidates the session and stops/destroys its sandbox.
          ...(retireTerminalSessions ? { releaseSandboxes: retireTerminalSessions } : {}),
        })
      : undefined;
    // Factory messaging needs the controller and its notifications store, which exist once the mount is up.
    const factoryMessaging = async () => {
      const controller = this.#prepared?.base.controller;
      const notifications = await controller?.getMastra()?.getStorage()?.getStore('notifications');
      return controller && notifications ? { controller, notifications } : null;
    };
    const factoryReporting = async (): Promise<FactoryReporting | null> => {
      const messaging = await factoryMessaging();
      if (!messaging) return null;
      return {
        notifications: messaging.notifications,
        deliver: (target, notification, options) =>
          deliverFactorySessionNotification({
            controller: messaging.controller,
            sessions: sourceControlSessions,
            runs: workItemsStorage,
            target,
            notification,
            ...options,
          }),
      };
    };
    const sessionReports = {
      sessions: sourceControlSessions,
      workItems: workItemsStorage,
      reporting: factoryReporting,
    };
    const reportSessionRunEnd = createSessionRunEndReporter(sessionReports);
    const notifyApprovalRequested = createSessionApprovalNotifier(sessionReports);
    // Claude Code sessions are not the agent controller's: the host announces them to the live-session registry.
    const claudeLiveSessions = createSessionNotifier();
    // Repeated attempts of one delivery send one report: identical failures to
    // the same follower are deduplicated.
    // A woken thread under a Factory or user resource names its session with its
    // stamp, or is the session's own thread; an unmigrated thread still runs
    // under its session id as its resource.
    const resolveWakeSession = async ({
      resourceId,
      threadId,
      thread,
    }: {
      resourceId: string;
      threadId: string;
      thread?: { metadata?: Record<string, unknown> } | null;
    }) => {
      const stored =
        thread === undefined ? await this.#prepared?.base.controller.queryThreadById({ threadId }) : thread;
      const stamp = stored?.metadata?.factorySessionId;
      const candidates = [...new Set([typeof stamp === 'string' ? stamp : '', threadId, resourceId])].filter(Boolean);
      for (const sessionId of candidates) {
        const row = await sourceControlSessions.getBySessionId(sessionId);
        // The stamp is client-writable metadata: a session only claims a
        // thread that runs under its own memory resource, or under its own id
        // as the resource from before resources were shared.
        // A stamp (neither the thread's own id nor its legacy resource) only
        // counts where the session's stamps are trusted.
        const viaStamp = sessionId !== threadId && sessionId !== resourceId;
        if (
          row &&
          (!viaStamp || sessionStampCounts(row, resourceId)) &&
          (resourceId === sessionId ||
            resourceId === (await sessionMemoryResourceId(this.#prepared?.base.controller, row, workItemsStorage)))
        ) {
          return { sessionId, row };
        }
      }
      // Unresolved: report on the woken thread, never on a session a stamp merely names.
      return { sessionId: threadId, row: null };
    };
    const failWake = async ({ sessionId, threadId }: { sessionId: string; threadId: string }, reason: string) => {
      const message = `Factory session ${sessionId} can't be woken as its owner: ${reason}.`;
      await reportSessionRunEnd({
        sessionId,
        threadId,
        since: new Date(),
        outcome: { status: 'failed', reason: message, failureCode: 'wake-owner-unresolved' },
      }).catch(error => console.warn('[factory] Unable to report a failed wake.', error));
      throw new Error(message);
    };
    const onTerminalStage = terminalCleanup
      ? (args: {
          orgId: string;
          factoryProjectId: string;
          workItemId: string;
          revision: number;
          actor: FactoryRuleActor;
        }): Promise<void> =>
          terminalCleanup({
            orgId: args.orgId,
            factoryProjectId: args.factoryProjectId,
            workItemId: args.workItemId,
            revision: args.revision,
            // Leave the seat that drove its own terminal transition running; it
            // is already returning from its transition tool call.
            ...(args.actor.type === 'agent' ? { initiatingBindingId: args.actor.bindingId } : {}),
          })
      : retireTerminalSessions;
    const transitionService = workItemsReady
      ? new FactoryTransitionService({
          configVersion,
          boards,
          storage: workItemsStorage,
          audit: auditDomain,
          selfReviewEnabled: async ({ orgId, factoryProjectId }) => {
            await factoryProjectsStorage.ensureReady();
            const project = await factoryProjectsStorage.get({ orgId, id: factoryProjectId });
            return project?.selfReviewEnabled ?? false;
          },
          ...(onTerminalStage ? { onTerminalStage } : {}),
          onTransitionCommitted: createStageChangeNotifier({
            workItems: workItemsStorage,
            reporting: factoryReporting,
          }),
          ...(githubIntegration
            ? {
                onAccepted: (args: { orgId: string; factoryProjectId: string; item: Card }) =>
                  reconcileGithubAcceptanceLabels(
                    githubIntegration,
                    sourceControlStorage.forIntegration(githubIntegration.id),
                    args,
                  ),
              }
            : {}),
        })
      : undefined;
    // Intake rules: Factory's own intake source (a schedule now, events later) filing cards through
    // the same path as "New card". Their schedules live in core `Schedules` and fire a workflow
    // registered on the host's Mastra below.
    this.#intakeRules =
      workItemsReady && storage.isDomainReady('intake-rules')
        ? setupIntakeRules({
            rules: intakeRulesStorage,
            schedule: { schedules: () => this.#prepared?.base.controller.getMastra()?.schedules },
            cards: {
              workItems: workItemsStorage,
              boards: toBoardSource(boards),
              transitionService: () => transitionService,
              auditRecorder: auditDomain,
            },
          })
        : undefined;
    // One set of storage and services behind the Factory tools, shared by agent sessions and the MCP endpoint.
    const factoryToolDeps: FactoryToolDependencies = {
      workItems: workItemsStorage,
      comments: workItemCommentsStorage,
      feed: commentsDomain,
      audit: auditStorage,
      boards,
      ...(this.#projectBoards ? { intakeRoutes: storedBoardsStorage } : {}),
      transitionService,
      auditRecorder: auditDomain,
      sessions: sourceControlSessions,
      sessionModel: {
        projects: factoryProjectsStorage,
        ...(auth
          ? {
              tenantCatalog: {
                credentials: modelCredentialsStorage,
                customProviders: customProvidersStorage,
                deploymentProviders: deploymentModelProviders,
              },
            }
          : {}),
      },
      startCoordinator: () => this.#startCoordinator,
      createHarnessSession: async input => createClaudeSideSession?.(input),
      messaging: factoryMessaging,
      // The live-session registry is built with the routes; no session runs before then.
      isSessionRunning: sessionId => liveSessionRegistry?.isRunning(sessionId) ?? false,
      // Tools and processors read parked runs through it.
      liveSessions: () => liveSessionRegistry,
    };
    // Proactive environment builds exist only when the sandbox can build
    // templates on its own; the workflow is registered on the host's Mastra
    // and the runner reaches the booted instance through the controller.
    this.#environmentBuilds = this.#sandbox?.builds
      ? new EnvironmentBuildRunner(
          {
            sandbox: this.#sandbox,
            projects: factoryProjectsStorage,
            sourceControl: githubIntegration?.versionControl
              ? {
                  storage: sourceControlStorage.forIntegration(githubIntegration.id),
                  versionControl: githubIntegration.versionControl,
                }
              : undefined,
            logger: { info: (msg, meta) => console.info(`[Factory] ${msg}`, meta ?? {}) },
          },
          { getMastra: () => this.#prepared?.base.controller.getMastra() },
        )
      : undefined;
    const environmentBuilds = this.#environmentBuilds;
    const projectRoutes = new ProjectRoutes({
      auth: routeAuth,
      ...(this.#projectBoards ? { boards: this.#projectBoards } : {}),
      sandbox: this.#sandbox,
      ...(environmentBuilds ? { environmentBuilds } : {}),
      projects: factoryProjectsStorage,
      sourceControl: sourceControlStorage,
      intake: intakeStorage,
      versionControlIntegrationIds: integrations
        .filter(integration => integration.versionControl)
        .map(integration => integration.id),
      ...(githubIntegration || gitlabIntegration
        ? {
            resolveRepository: async ({ integrationId, orgId, userId, installationId, externalId, slug }) => {
              if (githubIntegration && integrationId === githubIntegration.id) {
                const installation = await githubIntegration.sourceControlStorage.installations.get({
                  orgId,
                  id: installationId,
                });
                if (!installation) return null;
                const repositories = await githubIntegration.listInstallationRepos(Number(installation.externalId));
                const selected = repositories.find(repo => repo.id.toString() === externalId && repo.fullName === slug);
                if (!selected) return null;
                return githubIntegration.sourceControlStorage.repositories.upsert({
                  orgId,
                  input: {
                    installationId,
                    externalId,
                    slug: selected.fullName,
                    defaultBranch: isValidGitRef(selected.defaultBranch) ? selected.defaultBranch : 'main',
                    providerMetadata: { private: selected.private, owner: selected.owner },
                  },
                });
              }

              if (
                !gitlabIntegration?.intake ||
                !gitlabIntegration.versionControl ||
                integrationId !== gitlabIntegration.id
              )
                return null;
              const handle = sourceControlStorage.forIntegration(gitlabIntegration.id);
              const installation = await handle.installations.get({ orgId, id: installationId });
              if (!installation) return null;
              const sources = await gitlabIntegration.intake.listSources({ orgId, userId });
              const selected = sources.find(
                source =>
                  source.name === slug &&
                  typeof source.metadata?.projectId === 'string' &&
                  source.metadata.projectId === externalId &&
                  source.metadata.connectionId === installation.externalId,
              );
              if (!selected) return null;
              const [repository] = await gitlabIntegration.versionControl.registerRepositories({
                orgId,
                installationId,
                repositories: [
                  {
                    externalId,
                    slug,
                    defaultBranch:
                      typeof selected.metadata?.defaultBranch === 'string' &&
                      isValidGitRef(selected.metadata.defaultBranch)
                        ? selected.metadata.defaultBranch
                        : 'main',
                    metadata: selected.metadata,
                  },
                ],
              });
              return repository ?? null;
            },
          }
        : {}),
      ...(typeof githubIntegration?.ingestLinkedRepositoryBacklog === 'function'
        ? {
            onProjectRepositoryLinked: ({ orgId, projectRepository }) => {
              void githubIntegration
                .ingestLinkedRepositoryBacklog({ orgId, projectRepositoryId: projectRepository.id })
                .catch(error => {
                  console.warn('[factory] Failed to import a linked repository backlog:', error);
                });
            },
          }
        : {}),
      ...(sessionRetirement ? { sessionRetirement } : {}),
      ...(retireWorkItemSandboxes ? { releaseWorkItemSandboxes: retireWorkItemSandboxes } : {}),
      ...(workItemsReady
        ? {
            workItems: workItemsStorage,
            controller: {
              getSession: async (sessionId: string) => this.#prepared?.base.controller.getSession(sessionId),
            },
          }
        : {}),
    });
    const loadMemorySettings = async ({
      requestContext,
      binding,
    }: {
      requestContext: RequestContext | undefined;
      binding: FactoryRunBindingRecord | null;
    }) => {
      if (!requestContext) return;
      const scope = readFactorySessionScope(requestContext);
      const callerOrgId = factoryUserOrgId(getFactoryAuthUserFromContext(requestContext));
      const factoryProjectId = binding?.factoryProjectId ?? scope?.factoryProjectId;
      // Memory settings belong to the Factory: one shared row per project,
      // addressed by the sentinel user id the settings UI writes. There are no
      // personal memory settings; a session outside any Factory runs on the
      // built-in defaults. Rows older builds stored per user are never read.
      const record = factoryProjectId
        ? await memorySettingsStorage.get({
            orgId: binding?.orgId ?? scope?.factoryOrgId ?? callerOrgId ?? 'local',
            userId: factoryMemorySettingsUserId(factoryProjectId),
          })
        : null;
      requestContext.set('mastra__factoryMemorySettings', record satisfies MemorySettingsRecord | null);
    };
    const factoryProcessor = workItemsReady
      ? new FactoryPhaseStateProcessor({
          configVersion,
          storage: workItemsStorage,
          boards,
          loadMemorySettings,
          factoryThinkingLevel: factoryProjectId => readFactoryThinkingLevel(factoryProjectsStorage, factoryProjectId),
          // A Claude Code session's transcript names the Factory's tools as its MCP client does.
          bareToolName: claudeFactoryToolName,
          onBoundThreadRun: () => this.#dispatcher?.noteBoundThreadRun(),
          ...(transitionService ? { transitionService } : {}),
          ...(githubIntegration
            ? {
                recordPullRequestProvenance: (input: Parameters<typeof recordFactoryPullRequestProvenance>[4]) =>
                  recordFactoryPullRequestProvenance(
                    githubIntegration,
                    sourceControlStorage.forIntegration('github'),
                    integrationStorage.forIntegration('github'),
                    workItemsStorage,
                    input,
                  ),
              }
            : {}),
          messageReader: {
            listMessages: async input => {
              const memory = await storage.getMastraStorage().getStore('memory');
              return memory ? memory.listMessages(input) : { messages: [], hasMore: false };
            },
          },
        })
      : undefined;

    // Boot assertion: an active integration that signs OAuth `state` needs a
    // replica-stable signer — a per-process random secret silently breaks the
    // OAuth callback on any replica that didn't sign the state. Fail loud now
    // instead. (The built-ins also assert this inside their readiness gates.)
    for (const { integration } of integrationRegistrations) {
      if (integration.requiresStableStateSigner && !stateSigner.stable) {
        throw new Error(
          `MastraFactory: integration '${integration.id}' signs OAuth state and requires a ` +
            `replica-stable state secret, but none is configured. Set 'stateSecret' on the factory config.`,
        );
      }
    }

    // The SDK needs to know which backend the injected Mastra store uses
    // (its own `instanceof` detection breaks when the dependency graph holds
    // duplicate package copies). Resolve it by walking the FactoryStorage
    // prototype chain by class name — the factory can't import the concrete
    // classes since '@mastra/pg' / '@mastra/libsql' are the user's choice.
    const mastraStorageBackend = (() => {
      for (let proto = Object.getPrototypeOf(storage); proto; proto = Object.getPrototypeOf(proto)) {
        if (proto.constructor?.name === 'PgFactoryStorage') return 'pg' as const;
        if (proto.constructor?.name === 'LibSQLFactoryStorage') return 'libsql' as const;
      }
      return undefined;
    })();

    // Integrations contributing tools to agent sessions: org-scoped
    // `agentTools` (resolved per request) + session-scoped `sessionTools`.
    const toolIntegrations = integrationRegistrations.filter(
      ({ integration }) => integration.agentTools || integration.sessionTools,
    );
    const sourceControlToolProviders = integrations.flatMap(integration =>
      integration.versionControl
        ? [
            {
              id: integration.id,
              versionControl: integration.versionControl,
              storage: sourceControlStorage.forIntegration(integration.id),
            },
          ]
        : [],
    );

    // A session's workspace — its checkout, the environment's other repositories, setup commands — for both
    // harnesses: a Mastra session's tools work in it, a Claude Code session's CLI runs in it.
    const sessionWorkspaces = createWorkspaceFactory({
      skills: this.#skills,
      ...(storage.isDomainReady('skill-overrides') ? { skillOverrides: skillOverridesStorage } : {}),
      ...(sandboxConfig ? { sandbox: sandboxConfig } : {}),
      ...(this.#config.sandboxStart ? { sandboxStart: this.#config.sandboxStart } : {}),
      sourceControls: integrations.flatMap(integration =>
        integration.versionControl
          ? [
              {
                id: integration.id,
                versionControl: integration.versionControl,
                storage: sourceControlStorage.forIntegration(integration.id),
                ...(integration.id === 'github' && githubIntegration ? { github: githubIntegration } : {}),
              },
            ]
          : [],
      ),
      ...(factoryProjectsStorage ? { projects: factoryProjectsStorage } : {}),
      ...(workItemsStorage ? { workItems: workItemsStorage } : {}),
      workspaceRegistry,
      ...(workItemFolders ? { workItemFolders } : {}),
    });

    // The brokered source-control tools (push, change requests, reviews, test checks): one build for both harnesses,
    // a Mastra session's in-process and a Claude Code session's over MCP.
    const sourceControlToolsFor = (requestContext: RequestContext) =>
      createSourceControlTools({
        requestContext,
        providers: sourceControlToolProviders,
        audit: auditDomain,
        testChecksEnabled: async ({ orgId, factoryProjectId }) => {
          await factoryProjectsStorage.ensureReady();
          const project = await factoryProjectsStorage.get({ orgId, id: factoryProjectId });
          return project?.reviewTestChecksEnabled ?? false;
        },
        ...(workItemsStorage
          ? {
              selfReviewApprovedHead: async ({ repository }) => {
                const resolution = await resolveFactorySessionAddress({
                  requestContext,
                  storage: workItemsStorage,
                });
                if (!resolution) return undefined;
                const binding =
                  resolution.binding ?? (await workItemsStorage.findActiveRunBinding(resolution.address));
                if (!binding) return undefined;
                const item = await workItemsStorage.get({ orgId: binding.orgId, id: binding.workItemId });
                // Self-review gates the change request on boards that ship them (Work).
                if (!item || !(await toBoardSource(boards).load(binding)).get(boardForWorkItem(item))?.changeRequests) {
                  return undefined;
                }
                // A pull request's own card is reviewed, never self-reviewed.
                if (isPullRequestCard({ source: workItemSource(item.externalSource) })) return undefined;
                // A repository whose change request is already out is past
                // self-review; the others are still gated.
                if (
                  openChangeRequests(item.metadata).some(
                    entry =>
                      entry.repository === '' || entry.repository.toLowerCase() === repository.toLowerCase(),
                  )
                ) {
                  return undefined;
                }
                // A verdict already recorded still binds the change request to its head.
                if (item.metadata?.selfReviewVerdict === undefined) {
                  await factoryProjectsStorage.ensureReady();
                  const project = await factoryProjectsStorage.get({
                    orgId: binding.orgId,
                    id: binding.factoryProjectId,
                  });
                  if (!project?.selfReviewEnabled) return undefined;
                }
                return item.metadata?.selfReviewVerdict === 'approve'
                  ? selfReviewedHeadFor(item.metadata, repository)
                  : null;
              },
              workSpansEnvironment: async () => {
                const resolution = await resolveFactorySessionAddress({
                  requestContext,
                  storage: workItemsStorage,
                });
                if (!resolution) return false;
                const binding =
                  resolution.binding ?? (await workItemsStorage.findActiveRunBinding(resolution.address));
                if (!binding) return false;
                const item = await workItemsStorage.get({ orgId: binding.orgId, id: binding.workItemId });
                return item !== null && !namesRepository(item.metadata);
              },
              boundChangeRequestId: async () => {
                const resolution = await resolveFactorySessionAddress({
                  requestContext,
                  storage: workItemsStorage,
                });
                if (!resolution) return undefined;
                const binding =
                  resolution.binding ?? (await workItemsStorage.findActiveRunBinding(resolution.address));
                if (binding?.role !== 'review') return undefined;
                const item = await workItemsStorage.get({ orgId: binding.orgId, id: binding.workItemId });
                const source = item?.externalSource;
                if (!source || !/pull-request|merge-request/.test(source.type)) return undefined;
                return /(\d+)$/.exec(source.externalId)?.[1];
              },
            }
          : {}),
      });

    // The supervisor's tools (the Factory chat): its Mastra session gets them in-process, a Claude Code one over MCP.
    const supervisorReadTools = (scope: { orgId: string; factoryProjectId: string }) =>
      createFactorySupervisorReadTools({
        scope,
        workItems: workItemsStorage,
        boards: this.#boards,
        comments: workItemCommentsStorage,
        audit: auditStorage,
        messageReader: {
          listMessages: async input => {
            const memory = await storage.getMastraStorage().getStore('memory');
            return memory ? memory.listMessages(input) : { messages: [], hasMore: false };
          },
        },
      });
    const supervisorWriteTools = (
      scope: { orgId: string; factoryProjectId: string },
      userId: string,
      messageSession: NonNullable<Parameters<typeof createFactorySupervisorWriteTools>[0]['messageSession']>,
    ) =>
      createFactorySupervisorWriteTools({
        scope,
        userId,
        workItems: workItemsStorage,
        boards: this.#boards,
        audit: auditDomain,
        transitionService: transitionService!,
        ...(githubIntegration
          ? {
              reconcileAcceptanceLabels: (args: { orgId: string; factoryProjectId: string; item: WorkItemRow }) =>
                reconcileGithubAcceptanceLabels(
                  githubIntegration,
                  sourceControlStorage.forIntegration(githubIntegration.id),
                  args,
                ),
            }
          : {}),
        messageSession,
      });

    // The `factory-sessions` signal: a Mastra run's input processor, a Claude Code turn's opening context.
    const factorySessionsProcessor = () =>
      workItemsStorage && storage.isDomainReady('source-control')
        ? new FactorySessionsStateProcessor({
            authEnabled: routeAuth.enabled(),
            sessions: sourceControlSessions,
            projects: factoryProjectsStorage,
            workItems: workItemsStorage,
            boards,
            // Whichever harness runs the session: a Claude Code worker is not the controller's.
            isRunning: async sessionId => {
              const controller = this.#prepared?.base.controller;
              return controller ? isSessionRunning(controller, sessionId) : false;
            },
            isParked: sessionId => liveSessionRegistry?.parked(sessionId) !== undefined,
            lastActivity: async threadId => {
              const thread = await this.#prepared?.base.controller.queryThreadById({ threadId });
              return thread?.updatedAt ? new Date(thread.updatedAt) : null;
            },
            notifications: async () => (await factoryMessaging())?.notifications ?? null,
          })
        : undefined;

    // After each tool call of either harness: a Mastra session's through the controller, a Claude Code
    // session's after its MCP call (agent action audit, PR auto-subscription).
    const postToolObserver = async (toolContext: IntegrationPostToolContext) => {
      const requestContext = (toolContext.context as { requestContext?: RequestContext } | undefined)
        ?.requestContext;
      if (requestContext) {
        await observeAgentGitAction({
          audit: auditDomain,
          toolContext: { ...toolContext, context: requestContext },
          resolveRepositorySlugs: async sessionId => {
            for (const provider of sourceControlToolProviders) {
              const session = await provider.storage.sessions.getBySessionId(sessionId);
              if (!session) continue;
              return environmentSlugs(
                await resolveSessionRepositories({ sourceControl: provider.storage, session }),
              );
            }
            return [];
          },
        });
      }
      await Promise.all(
        integrations.map(async integration => {
          if (!integration.postToolObserver) return;
          try {
            await integration.postToolObserver({ toolContext, requestContext });
          } catch (error) {
            console.warn(`[factory] Integration '${integration.id}' post-tool observer failed:`, error);
          }
        }),
      );
    };

    // Claude Code factories: their sessions live in the Claude harness, reach the
    // Factory's tools over MCP with per-turn session tokens, and show in the chat
    // through `claudeSessionUi`. Everything else stays on Mastra.
    const claudeCodeConfig = this.#config.claudeCode;
    const sessionTokens = claudeCodeConfig
      ? createFactorySessionTokenSigner(claudeCodeConfig.sessionTokenSecret ?? this.#config.stateSecret)
      : undefined;
    const claudeCodeCredentials = claudeCodeConfig?.credentials
      ? {
          credentials: claudeCodeConfig.credentials,
          ...(claudeCodeConfig.onCredentialFailure ? { onCredentialFailure: claudeCodeConfig.onCredentialFailure } : {}),
        }
      : createClaudeCodeCredentials({ credentials: modelCredentialsStorage });
    const claudeCheckout = claudeCodeConfig
      ? (claudeCodeConfig.cwdFor ??
        createClaudeCheckoutResolver({
          workspaces: context => sessionWorkspaces(context as never) as never,
          sessions: sourceControlSessions,
        }))
      : undefined;
    // The sandbox a Claude Code session's checkout lives in, for the tools that run git there on its behalf.
    // After a restart the memo is empty until the session's checkout is resolved again.
    // The memo is keyed by the session's source-control row, as the checkout files it.
    const claudeSessionSandbox = async (sessionId: string) => {
      const row = await sourceControlSessions.getBySessionId(sessionId);
      if (!row) return undefined;
      if (!peekSessionSandbox(row.id) && claudeCheckout) await claudeCheckout(sessionId);
      return peekSessionSandbox(row.id)?.sandbox;
    };
    // After a restart a Claude Code session's checkout is still on this host's disk, but its sandbox is not in the
    // memo until its next turn. The file panels and its sandbox start attach it from disk without starting it
    // (no clone, no setup, no network). Only for the Factory's own local sandbox, never a custom `cwdFor`.
    const localCheckoutAttacher =
      claudeCodeConfig && !claudeCodeConfig.cwdFor && sandboxConfig?.provider === 'local'
        ? createLocalCheckoutAttacher({
            workspaces: context => sessionWorkspaces(context as never) as never,
            sessions: sourceControlSessions,
          })
        : undefined;
    const claudeCode: ClaudeFactoryHarness | undefined = claudeCodeConfig
      ? createClaudeFactoryHarness({
          ...claudeCodeConfig,
          sessions: sourceControlSessions,
          projects: factoryProjectsStorage,
          // Settings → Behavior → Tool permissions: the Factory's own session keeps them.
          permissions: createFactoryToolPermissions(
            async sessionId => this.#prepared?.base.controller.getSession(sessionId),
            factoryProjectsStorage,
          ),
          // A session that ever ran a card's role is a card run: nobody is there to answer a permission prompt.
          cardRun: ({ orgId, factoryProjectId, sessionId }) =>
            workItemsReady
              ? workItemsStorage.hasRunBindingForSession({ orgId, factoryProjectId, sessionId })
              : false,
          // The factory-phase signal a bound Mastra run gets, so the skills read the same stage and revision.
          ...(workItemsReady
            ? {
                // A Product card's Brief reads providers' pricing pages: reading the web needs no person.
                allowToolsFor: async ({ orgId, sessionId, threadId, resourceId }) => {
                  const binding = await workItemsStorage.findActiveRunBindingByThread({
                    orgId,
                    threadId,
                    resourceId,
                    sessionId,
                  });
                  if (!binding) return undefined;
                  const item = await workItemsStorage.get({ orgId: binding.orgId, id: binding.workItemId });
                  return item?.board === 'product' ? [...PRODUCT_WEB_READ_TOOLS] : undefined;
                },
                phaseFor: async ({ orgId, factoryProjectId, sessionId, threadId, resourceId }) => {
                  const binding = await workItemsStorage.findActiveRunBindingByThread({
                    orgId,
                    threadId,
                    resourceId,
                    sessionId,
                  });
                  if (!binding) return undefined;
                  const described = await describeFactoryPhase({
                    storage: workItemsStorage,
                    boards,
                    configVersion,
                    binding,
                    runtime: async () => {
                      const project = await factoryProjectsStorage.get({ orgId, id: factoryProjectId });
                      return {
                        modelId: `claude-code/${project?.claudeCodeModel ?? 'default'}`,
                        thinkingLevel: 'claude-code-default',
                      };
                    },
                  });
                  return described?.contents;
                },
              }
            : {}),
          // The factory-sessions signal a Mastra run gets, read as the session's own tools see it.
          sessionsFor: async coordinates => {
            const processor = factorySessionsProcessor();
            if (!processor) return undefined;
            const signal = await processor.computeStateSignal({
              requestContext: boundRunRequestContext({ ...coordinates, kind: 'user', interactive: false }),
              contextWindow: { hasSnapshot: false },
              activeStateSignals: [],
            } as never);
            return typeof signal?.contents === 'string' ? signal.contents : undefined;
          },
          ...claudeCodeCredentials,
          cwdFor: claudeCheckout!,
          mcp: {
            url: factoryProjectId =>
              `${(claudeCodeConfig.mcpOrigin ?? publicOrigin).replace(/\/+$/, '')}/web/factory/projects/${encodeURIComponent(factoryProjectId)}/mcp`,
            tokens: sessionTokens!,
          },
          onSession: session => {
            const channel = this.#claudeSessionUi.attach(session);
            // The same run bookkeeping a Mastra session gets when it is created.
            observeSessionRunEnd(session, { audit: auditDomain });
            // Through the chat channel: its events name parked tools as a Mastra session does (`ask_user`,
            // `submit_plan`) and mark a permission request as an approval, which the report tells apart.
            observeSessionRunReports(channel, (outcome, since) =>
              reportSessionRunEnd({ sessionId: session.id, threadId: session.thread.getId() ?? null, outcome, since }),
            );
            // Its first message dates the session (TTFI) and tells the board its checkout is under way.
            observeSessionFirstMessage(
              { identity: { getId: () => session.id }, subscribe: listener => channel.subscribe(listener) },
              { sourceControl: { sessions: sourceControlSessions } },
            );
            // Its thread is named as a Mastra session's is, and the session row follows the title.
            observeClaudeThreadTitle(channel, {
              sourceControl: { sessions: sourceControlSessions },
              generate: async threadId => {
                const controller = this.#prepared?.base.controller;
                const row = await sourceControlSessions.getBySessionId(session.id);
                if (!controller || !row) return undefined;
                // The title model a Mastra session of the same Factory names its threads with.
                const stored = row.factoryProjectId
                  ? await memorySettingsStorage.get({
                      orgId: row.orgId,
                      userId: factoryMemorySettingsUserId(row.factoryProjectId),
                    })
                  : null;
                const requestContext = new RequestContext();
                requestContext.set('user', { id: row.userId, organizationId: row.orgId });
                const observerModelId = stored?.observerModelId;
                return controller.generateThreadTitle({
                  threadId,
                  requestContext,
                  ...(observerModelId
                    ? {
                        model: ({ requestContext }: { requestContext: RequestContext }) =>
                          resolveModel(observerModelId, { remapForCodexOAuth: true, requestContext }),
                      }
                    : {}),
                });
              },
            });
            // The board's tool-result rules run on its completed Factory tool calls, as on a Mastra run's.
            if (factoryProcessor) {
              observeClaudeToolResults(channel, async () => {
                const row = await sourceControlSessions.getBySessionId(session.id);
                if (!row?.factoryProjectId) return;
                const binding = await workItemsStorage.findActiveRunBindingForSession({
                  orgId: row.orgId,
                  factoryProjectId: row.factoryProjectId,
                  sessionId: session.id,
                });
                if (binding) await factoryProcessor.reconcileBinding(binding);
              });
            }
            // A permission request reaches whoever follows the session, as a Mastra session's approval does.
            channel.subscribe(event => {
              if (event.type !== 'tool_approval_required') return;
              void notifyApprovalRequested({
                sessionId: session.id,
                threadId: session.thread.getId() ?? null,
                toolName: event.toolName,
                toolCallId: event.toolCallId,
                args: event.args,
              }).catch(error => console.warn('[factory] Could not report a Claude Code permission request', error));
            });
            // Its card shows it waiting and the inbox lists it, as for a Mastra session.
            void sourceControlSessions
              .getBySessionId(session.id)
              .then(row => {
                if (row) claudeLiveSessions.created(claudeLiveSession(channel, row));
              })
              .catch(error => console.warn('[factory] Could not register a Claude Code session as live', error));
          },
        })
      : undefined;
    if (claudeCode) {
      // The Factory chat (supervisor) of a Claude Code Factory is a Claude session too, created when the chat first reaches it.
      const supervisorSessions = createClaudeSupervisorSessions({
        harness: claudeCode.harness,
        projects: {
          getById: async args => {
            if (!storage.isDomainReady('projects')) return null;
            await factoryProjectsStorage.ensureReady();
            return factoryProjectsStorage.getById(args);
          },
        },
      });
      this.#claudeSessionUi.setSessionResolver(sessionId => supervisorSessions.resolve(sessionId));
      removeClaudeSessionConfig = sessionId => claudeCode.removeSessionConfig(sessionId);
      createClaudeSideSession = async ({ harness, sessionId, resourceId, title }) => {
        if (harness !== 'claude-code') return undefined;
        // The Factory's thread convention, as a card's or a chat's Claude Code session: the thread is the session id.
        const session =
          (await claudeCode.harness.getSession(sessionId)) ??
          (await claudeCode.harness.createSession({ sessionId, threadId: sessionId, resourceId }));
        await session.thread.setSetting({ key: CLAUDE_THREAD_SETTINGS.sessionId, value: sessionId });
        await session.thread.setSetting({ key: CLAUDE_THREAD_SETTINGS.title, value: title });
        return session;
      };
      // The Factory chat is shared by the Factory's organization: its next turn runs as whoever wrote or answered.
      this.#claudeSessionUi.setPersonInputHook(async (c, session) => {
        // A signed-in person's message or answer makes the turn that carries it theirs (interactive).
        await markClaudePersonTurn(c as never, session);
        if (!claudeSupervisorProjectId(session.id)) return;
        const userId = routeAuth.tenant(c)?.userId;
        if (userId) await session.thread.setSetting({ key: CLAUDE_THREAD_SETTINGS.actorUserId, value: userId });
      });
      // A person approving a card's plan in the chat moves the card on, as an approved Mastra plan does
      // (`advanceApprovedPlan`); the next stage then starts the session, which takes the answer first.
      if (workItemsReady && transitionService) {
        const approvePlan = createClaudePlanApproval({ sessions: sourceControlSessions, workItems: workItemsStorage, transitionService });
        this.#claudeSessionUi.setPlanDecisionHook((c, session, answer) =>
          approvePlan(session, { ...answer, userId: routeAuth.tenant(c)?.userId }),
        );
      }
    }

    // Build the real production controller (agents, tools, memory, OM, MCP,
    // providers) — the terminal app's, minus modes. Agent state lives in
    // the storage backend's Mastra store alongside the Factory app tables —
    // one shared database for all users, separated by `resourceId` scoping.
    // The tools a session gets beyond the controller's own: integrations', the brokered source-control tools,
    // the governed card moves and the Factory's tools. A Mastra session gets them in-process (`extraTools`),
    // a Claude Code session over the Factory MCP endpoint (`createSession`).
    const sessionExtraTools = async (requestContext: RequestContext): Promise<IntegrationTools> => {
      const tools: IntegrationTools = {};
      const toolOwners = new Map<string, string>();
      const mergeTools = (ownerId: string, contributed: IntegrationTools) => {
        for (const [name, tool] of Object.entries(contributed)) {
          const owner = toolOwners.get(name);
          if (owner) {
            throw new Error(
              `MastraFactory: integration tool '${name}' from '${ownerId}' conflicts with '${owner}'.`,
            );
          }
          toolOwners.set(name, ownerId);
          tools[name] = tool;
        }
      };
      if (storage.isDomainReady('source-control')) {
        mergeTools(
          'source-control',
          await sourceControlToolsFor(requestContext),
        );
      }
      if (attachmentService && workItemsStorage) {
        mergeTools(
          'factory-attachments',
          await createAttachmentTools({
            requestContext,
            deps: { attachments: attachmentService, workItems: workItemsStorage, sessions: sourceControlSessions },
          }),
        );
      }
      if (workItemsStorage && transitionService) {
        mergeTools(
          'factory',
          await createFactoryTransitionTools({
            requestContext,
            storage: workItemsStorage,
            transitionService,
            boards,
            // Heals crash-resumed sessions: recovered addresses re-seed
            // projectRepositoryId/baseRef from the source session record.
            // Only offered while the source-control domain is ready — a
            // throwing lookup would abort recovery's catch block and also
            // skip the metadata baseRef fallback.
            ...(storage.isDomainReady('source-control')
              ? {
                  sessions: sourceControlSessions,
                  // A Product session files its phases as Work cards and records document checks.
                  product: {
                    feed: factoryToolDeps.feed,
                    auditRecorder: factoryToolDeps.auditRecorder,
                    sessions: sourceControlSessions,
                    ...(productCardFolderPath ? { cardFolderPath: productCardFolderPath } : {}),
                    readThread: productReadThread,
                  },
                }
              : {}),
          }),
        );
        // Review-role sessions get `factory_review_source` so the
        // published review can carry the session URL that produced it
        // — the affordance that lets a suspicious review (e.g. one
        // that lands on the wrong PR) be traced back to its run.
        //
        // The session URL is browser-facing (a human opens it from a
        // GitHub/GitLab review comment), so it needs the UI host —
        // the same origin Slack session deep-links resolve against
        // (`integrations/slack/slack.ts:168-171`, `:809-812`). In a
        // separate-SPA deployment `publicUrl` (i.e. `publicOrigin`)
        // is the API host, so we read `MASTRACODE_PUBLIC_URL` and
        // mirror Slack's behavior: when it is unset, pass `null` so
        // the tool is omitted from the toolset rather than fall back
        // to the API/localhost origin and publish that URL into a
        // public review body. The skill's tool-not-available branch
        // handles the absence as stop-don't-publish. Blank counts as
        // unset: `.env.schema` ships `MASTRACODE_PUBLIC_URL=`, so an
        // empty/whitespace value must not register the tool with a
        // hostless `sessionUrl`.
        const reviewSourceUiOrigin = resolveReviewSourceUiOrigin(process.env.MASTRACODE_PUBLIC_URL);
        mergeTools(
          'factory-review-source',
          await createReviewSourceTool({
            requestContext,
            storage: workItemsStorage,
            uiOrigin: reviewSourceUiOrigin,
            ...(storage.isDomainReady('source-control') ? { sessions: sourceControlSessions } : {}),
          }),
        );
        if (storage.isDomainReady('source-control')) {
          const scope = await resolveFactoryToolScope({
            requestContext,
            authEnabled: routeAuth.enabled(),
            sessions: sourceControlSessions,
            projects: factoryProjectsStorage,
            workItems: workItemsStorage,
          });
          if (scope) {
            mergeTools(
              'factory-tools',
              createFactoryTools({
                scope,
                deps: factoryToolDeps,
              }),
            );
          }
        }
        // The supervisor session has no seat, so it never gets the
        // transition tool above; it gets the read surface instead,
        // and only once the caller's org is shown to own the project.
        const supervisorScope = await resolveSupervisorScope({
          requestContext,
          projects: factoryProjectsStorage,
        });
        if (supervisorScope) {
          const userId = getFactoryAuthUserId(getFactoryAuthUserFromContext(requestContext));
          mergeTools('factory-supervisor', supervisorReadTools(supervisorScope));
          if (userId) {
            mergeTools(
              'factory-supervisor-write',
              supervisorWriteTools(supervisorScope, userId, ({ sessionId, message, delivery }) =>
                messageWorkerSession({
                  // A worker on Claude Code is not the Mastra controller's; its own session takes the message.
                  controller: {
                    getSession: async (id, context) => {
                      const mastra = await prepared.base.controller.getSession(id, context);
                      if (mastra) return mastra;
                      const claude = await claudeCode?.harness.getSession(id);
                      return claude ? claudeWorkerSession(claude) : undefined;
                    },
                  },
                  sessionId,
                  message,
                  delivery,
                  ...(requestContext ? { requestContext } : {}),
                }),
              ),
            );
          }
        }
      }
      for (const { integration, ready, ensureReady } of toolIntegrations) {
        if (!ready && ensureReady) {
          try {
            await ensureReady();
          } catch {
            continue;
          }
        }
        if (integration.agentTools) {
          mergeTools(integration.id, await integration.agentTools({ requestContext }));
        }
        if (integration.sessionTools) {
          mergeTools(integration.id, integration.sessionTools({ requestContext }));
        }
      }
      return tools;
    };

    const prepared = await timedPhase('prepare.controllerMount', () =>
      prepareAgentControllerMount({
        controllerId: CONTROLLER_ID,
        browser: this.#config.browser,
        coAuthor: { name: 'mastra-platform[bot]' },
        ...(this.#config.disableBuiltinTools?.length ? { disableBuiltinTools: this.#config.disableBuiltinTools } : {}),
        modes: false,
        // Subagents are disabled, matching the Mastra Code TUI default.
        subagents: [],
        // Thinking defaults are stored per Factory, not in the host's settings.json.
        resolveDefaultThinkingLevel: ({ requestContext }) =>
          resolveFactoryThinkingLevel(requestContext, {
            projects: factoryProjectsStorage,
            sourceControl: sourceControlSessions,
          }),
        workspace: sessionWorkspaces,
        disableGithubSignals: true,
        // A wake (notification or peer signal) has no signed-in request, so
        // tenant credential resolution would fail closed. Run it as the Factory
        // session's owner in its org.
        // With auth on, a wake whose owner can't be resolved must not run (it
        // would fail on credentials with no hint why); it fails, and the
        // session's followers get a failed report naming the reason.
        prepareWakeRequestContext: async ({ requestContext, resourceId, threadId }) => {
          if (!storage.isDomainReady('source-control')) {
            if (auth) await failWake({ sessionId: threadId, threadId }, 'session storage is not ready');
            return;
          }
          const { sessionId, row } = await resolveWakeSession({ resourceId, threadId });
          // Only a session that owns the thread's resource may lend its owner;
          // the unresolved fallback id must never be looked up as a session.
          if (!row) {
            if (auth) await failWake({ sessionId, threadId }, WAKE_OWNER_UNRESOLVED['session-not-found']);
            return;
          }
          const prepared = await prepareSessionRunContext(requestContext, sessionId, {
            sessions: sourceControlSessions,
          });
          if (prepared !== 'prepared') {
            if (auth) await failWake({ sessionId, threadId }, WAKE_OWNER_UNRESOLVED[prepared]);
            return;
          }
          await primeCustomProvidersForRequestContext(requestContext);
        },
        // A deferred delivery can land after the session closed, after a
        // restart, or on another replica: nobody here owns it, and the wake
        // would run with no identity at all. Bring the session online as its
        // row's owner first, as a direct message to an offline session does.
        ...(auth
          ? {
              resumeWakeSession: async ({ resourceId, threadId }: { resourceId: string; threadId: string }) => {
                const controller = this.#prepared?.base.controller;
                if (!controller) return failWake({ sessionId: threadId, threadId }, 'the Factory is not started');
                const thread = await controller.queryThreadById({ threadId });
                if (!thread || thread.resourceId !== resourceId) {
                  return failWake({ sessionId: threadId, threadId }, `thread ${threadId} is not the session's`);
                }
                const { sessionId, row } = storage.isDomainReady('source-control')
                  ? await resolveWakeSession({ resourceId, threadId, thread })
                  : { sessionId: threadId, row: null };
                if (!row?.factoryProjectId)
                  return failWake({ sessionId, threadId }, WAKE_OWNER_UNRESOLVED['session-not-found']);
                if (!hasResolvedOrg(row.orgId)) {
                  return failWake({ sessionId, threadId }, WAKE_OWNER_UNRESOLVED['organization-unresolved']);
                }
                if (await controller.getSession(sessionId)) return;
                // A Claude Code session wakes itself; a Mastra session on its thread would be a second agent.
                if (await claudeCode?.harness.getSession(sessionId)) return;
                await createSessionAsRowOwner(controller, {
                  sessionId,
                  ownerResourceId: resourceId,
                  row,
                  tags: {
                    factoryProjectId: row.factoryProjectId,
                    ...(row.projectRepositoryId ? { projectRepositoryId: row.projectRepositoryId } : {}),
                  },
                  threadId,
                });
              },
            }
          : {}),
        // Memory settings live in the factory's `memory-settings` app table (per
        // org/user), so the host machine's TUI settings.json must not seed them.
        disableSettingsOmSeed: true,
        hostInstructions: async ({ requestContext }) => {
          const context = requestContext.get('controller') as
            | AgentControllerRequestContext<MastraCodeState>
            | undefined;
          const supervisorProjectId = supervisorProjectIdFromContext(context);
          if (supervisorProjectId) {
            return withAgentLanguage(
              SUPERVISOR_INSTRUCTIONS,
              supervisorProjectId,
              await factoryProjectsStorage.getById({ id: supervisorProjectId }),
            );
          }
          // The SDK resolves this callback before it loads repository
          // AGENTS.md/CLAUDE.md. A controller recreated after restart has
          // only initialState, and a partially persisted one can keep
          // `factoryProjectId` while `untrustedCheckout` is gone, so the
          // presence of the project id alone proves nothing. Heal whenever any
          // trust field the recovery writes is missing, now, not later when
          // the agent's tools are assembled. Unbound sessions never gain these
          // fields and pay one binding lookup per prompt.
          if (context?.threadId && context.sessionId) {
            const current = context.getState();
            const trustStateComplete =
              Boolean(current.factoryProjectId) &&
              Boolean(current.factoryOrgId) &&
              typeof current.untrustedCheckout === 'boolean';
            if (!trustStateComplete) {
              const recovered = await resolveFactorySessionAddress({
                requestContext,
                storage: workItemsStorage,
                forceBindingLookup: true,
                ...(storage.isDomainReady('source-control') ? { sessions: sourceControlSessions } : {}),
              });
              if (recovered?.binding) {
                const state = context.getState();
                if (
                  state.factoryProjectId !== recovered.binding.factoryProjectId ||
                  (recovered.binding.role === 'review' && state.untrustedCheckout !== true)
                ) {
                  throw new Error(
                    'Factory review session security state could not be restored before prompt creation.',
                  );
                }
              }
            }
          }
          // The Factory's «Мова агентів», read on every prompt so a changed setting
          // applies from the session's next turn. A session not filed under a
          // Factory has no setting to follow.
          const factoryProjectId = context?.getState().factoryProjectId;
          if (!factoryProjectId) return undefined;
          return withAgentLanguage(
            undefined,
            factoryProjectId,
            await factoryProjectsStorage.getById({ id: factoryProjectId }),
          );
        },
        // A factory reads the repository it works on and its skill, never the
        // ~/.claude instructions of whoever hosts the process. On the controller
        // rather than per session, so webhook-recreated sessions keep it too.
        // Blank project identity for the same reason: the SDK's defaults seed
        // sessions with the HOST process's own project root / name / branch,
        // which must never reach a hosted session's prompt. Repo-backed
        // sessions get their real workdir pinned by workspace resolution;
        // chat-only sessions legitimately have no project.
        // Factory sessions also start fail-closed on org classification: the
        // unresolved marker is set at birth, a successful org seed clears it,
        // and a resolved `factoryOrgId` always takes precedence — so a failed
        // (best-effort) seed can never leave a session classified as local.
        initialState: {
          skipGlobalInstructions: true,
          factoryOrgUnresolved: true,
          projectPath: '',
          projectName: '',
          gitBranch: '',
        },
        storage: storage.getMastraStorage(),
        ...(mastraStorageBackend ? { storageBackend: mastraStorageBackend } : {}),
        // Factory owns Knowledge: without its own config, Knowledge stays off
        // rather than following the host's Mastra Code settings toggle.
        knowledge: this.#config.knowledge ?? false,
        // The environment signal tells the agent which repositories its
        // sandbox holds and where; the phase signal, when work items are on,
        // comes after it.
        inputProcessors: async ({ requestContext }: { requestContext: RequestContext }) => {
          const channelReplyProcessor = new FactoryChannelReplyProcessor();
          const environmentProcessor = new FactoryEnvironmentStateProcessor();
          const sessionsState = factorySessionsProcessor();
          const sessionsProcessor = sessionsState ? [sessionsState] : [];
          if (factoryProcessor) {
            await factoryProcessor.prepareMemorySettings(requestContext);
            return [channelReplyProcessor, environmentProcessor, ...sessionsProcessor, factoryProcessor];
          }
          // Without work items there is no run binding, so the caller's row applies.
          try {
            await loadMemorySettings({ requestContext, binding: null });
          } catch (error) {
            reportMemorySettingsUnavailable(requestContext, error instanceof Error ? error.message : String(error));
          }
          return [channelReplyProcessor, environmentProcessor, ...sessionsProcessor];
        },
        outputProcessors: [new FactoryChannelSessionLinkProcessor(), new FactoryReplyCredentialProcessor()],
        ...(vector ? { vector } : {}),
        ...(toolIntegrations.length > 0 ||
        sourceControlToolProviders.length > 0 ||
        (workItemsStorage && transitionService)
          ? {
              extraTools: ({ requestContext }: { requestContext: RequestContext }) => sessionExtraTools(requestContext),
            }
          : {}),
        postToolObserver,
        ...(pubsub ? { pubsub, crossProcessPubSub: true } : {}),
        buildApiRoutes: ({ controller, authStorage }: BuildApiRoutesDeps) => [
          // Public `/auth/*` routes (login/callback/logout/me). Folded in as
          // `apiRoutes` (not plain Hono routes) because the entry can't touch the
          // Hono app the deployer generates. `requiresAuth: false`; the gate
          // skips `/auth/*`. Auth-disabled mode still answers `/auth/me` (404).
          ...(auth ? buildAuthRoutes(auth, { publicUrl: publicOrigin }) : buildAuthDisabledRoutes()),
          ...(mcpEnabled || sessionTokens
            ? buildFactoryMcpRoutes({
                auth: routeAuth,
                publicOrigin,
                authorizationServers: mcpAuthorizationServers,
                projects: factoryProjectsStorage,
                sourceControls: sourceControlHandles,
                tools: {
                  ...factoryToolDeps,
                  // The harness types its tools loosely (`ToolLike`); they are Mastra tools.
                  create: scope =>
                    createFactoryTools({ scope, deps: factoryToolDeps }) as Record<string, Tool<any, any, any, any>>,
                  ...(claudeCode
                    ? {
                        createSession: scope =>
                          createClaudeSessionTools(scope, {
                            sessionTools: requestContext => sessionExtraTools(requestContext),
                            sandboxFor: claudeSessionSandbox,
                            observe: postToolObserver,
                            skillDirectories: claudeFactorySkillDirectories(claudeCodeConfig?.skillsDir),
                          }) as Promise<Record<string, Tool<any, any, any, any>>>,
                      }
                    : {}),
                  ...(transitionService
                    ? {
                        createBound: scope =>
                          createClaudeBoundTools(scope, {
                            storage: workItemsStorage,
                            transitionService,
                            boards: this.#boards,
                            sessions: sourceControlSessions,
                            product: {
                              feed: factoryToolDeps.feed,
                              auditRecorder: factoryToolDeps.auditRecorder,
                              sessions: sourceControlSessions,
                              ...(productCardFolderPath ? { cardFolderPath: productCardFolderPath } : {}),
                              readThread: productReadThread,
                            },
                            sandboxFor: claudeSessionSandbox,
                            observe: postToolObserver,
                          }),
                        // The Factory chat on Claude Code: the supervisor's tools, acting as the person behind the turn.
                        createSupervisor: scope => {
                          const project = { orgId: scope.orgId, factoryProjectId: scope.factoryProjectId };
                          return {
                            ...supervisorReadTools(project),
                            ...supervisorWriteTools(project, scope.userId, async ({ sessionId, message, delivery }) => {
                              // A worker on Claude Code takes the message as a person's input; a Mastra one through its controller.
                              const claudeSession = await claudeCode?.harness.getSession(sessionId);
                              if (claudeSession) {
                                const worker = claudeWorkerSession(claudeSession);
                                await (delivery === 'queue' ? worker.queueMessage : worker.sendMessage)({ content: message });
                                return;
                              }
                              const controller = this.#prepared?.base.controller;
                              if (!controller) throw new Error('The worker session is not currently available.');
                              return messageWorkerSession({ controller, sessionId, message, delivery });
                            }),
                          } as Record<string, Tool<any, any, any, any>>;
                        },
                      }
                    : {}),
                },
                // Only Claude Code sessions present session tokens; people still need the endpoint enabled.
                ...(sessionTokens ? { sessionTokens } : {}),
                allowUsers: mcpEnabled,
              })
            : []),
          ...new TelemetryRoutes({ auth: routeAuth, providerName: auth?.name, publicOrigin, allowedOrigins }).routes(),
          // Custom `/web/*` routes (fs / config / integrations / factory / audit).
          ...assembleFactoryApiRoutes({
            ...(attachmentService ? { attachments: attachmentService } : {}),
            ...(this.#intakeRules ? { intakeRules: { engine: this.#intakeRules.engine, storage: intakeRulesStorage } } : {}),
            controllerId: CONTROLLER_ID,
            controller,
            liveSessions: (liveSessionRegistry = liveSessionsTouchingTheFeed(eventBus, controller, claudeLiveSessions)),
            auth: routeAuth,
            ...(auth && isUserProvider(auth) ? { users: auth } : {}),
            authStorage,
            audit: auditDomain,
            publicOrigin,
            stateSigner,
            sandbox: sandboxConfig,
            ...(environmentBuilds ? { onRepositoryPush: environmentBuilds.onRepositoryPush } : {}),
            sessionRetirement,
            // Without a retirement coordinator, the delete route removes a session's CLI config dir itself.
            onSessionDeleted: sessionId => removeClaudeSessionConfig?.(sessionId),
            moveThread: async ({ threadId, resourceId }) => {
              // The sessions' own Memory, so a moved thread takes its observation vectors along.
              const sessionMemory = getDynamicMemory(storage.getMastraStorage(), vector);
              await sessionMemory({ requestContext: new RequestContext() }).updateThreadResourceId({
                threadId,
                resourceId,
              });
              await sessionMemory.settled();
            },
            factoryStorage: storage,
            integrationStorage,
            sourceControlStorage,
            domains,
            feed: commentsDomain,
            integrations: integrationRegistrations,
            intakeReady,
            factoryReady,
            knowledgeEnabled,
            mcpEnabled,
            claudeCodeEnabled: claudeCode !== undefined,
            // New chats of a Claude Code Factory are Claude Code sessions, checked out like a card's.
            ...(claudeCode
              ? {
                  claudeCodeUserSessions: createClaudeUserSessions({
                    harness: claudeCode.harness,
                    checkout: claudeCodeConfig?.cwdFor
                      ? { custom: true }
                      : { custom: false, sandboxProvider: sandboxConfig?.provider },
                  }),
                }
              : {}),
            // Only a session Claude Code runs is attached: a Mastra session's own turn builds its sandbox.
            ...(claudeCode && localCheckoutAttacher
              ? {
                  attachLocalCheckout: async (session: { id: string; sessionId: string }) =>
                    (await claudeCode.harness.getSession(session.sessionId))
                      ? localCheckoutAttacher(session)
                      : false,
                }
              : {}),
            // Signing in opens the CLI's browser page on this machine: only where it is the person's own.
            ...(claudeCode !== undefined && claudeCodeConfig?.localDevelopment === true && modelCredentialsStorage
              ? { claudeSignIn: createClaudeSignInService({ credentials: modelCredentialsStorage }) }
              : {}),
            deploymentModelProviders,
            knowledgeKey: this.#config.knowledge?.key,
            skills: this.#skills,
            configVersion,
            boardRegistry: boards,
            ...(this.#projectBoards
              ? { storedBoards: { storage: storedBoardsStorage, cache: this.#projectBoards } }
              : {}),
            factoryTransitionService: transitionService,
            ...(claudeCode && transitionService
              ? {
                  harnessStartCoordinators: {
                    // `owns` keeps a card that started on Claude Code there after the Factory switches to Mastra.
                    'claude-code': Object.assign(
                      new ClaudeStartCoordinator({
                        harness: claudeCode.harness,
                        storage: workItemsStorage,
                        transitionService,
                        sourceControl: request =>
                          sourceControlSessions.getSourceControlBySessionId(request.sessionId).then(handle => handle ?? undefined),
                        boards,
                        projects: factoryProjectsStorage,
                        ...(claudeCodeConfig?.approvedPermissionMode
                          ? { approvedPermissionMode: claudeCodeConfig.approvedPermissionMode }
                          : {}),
                      }),
                      { owns: claudeCode.route.owns },
                    ),
                  },
                }
              : {}),
            onFactoryRuntime: ({ transitionService: runtimeTransitionService, startCoordinator, prepareBinding }) => {
              this.#startCoordinator = startCoordinator;
              this.#dispatcher ??= new FactoryDecisionDispatcher({
                // Each session runs on the harness that owns it: Claude Code sessions are in its store.
                harness: claudeCode
                  ? createRoutingHarness({ routes: [claudeCode.route], fallback: createMastraHarness(controller) })
                  : createMastraHarness(controller),
                transitionService: runtimeTransitionService,
                storage: storage.getDomain<WorkItemsStorage>('work-items'),
                audit: auditDomain,
                boards,
                ...(this.#projectBoards ? { intakeRoutes: storedBoardsStorage } : {}),
                maxInFlight: this.#config.dispatcher?.maxInFlight,
                isAutoRunEnabled: async ({ orgId, factoryProjectId }) => {
                  await factoryProjectsStorage.ensureReady();
                  const project = await factoryProjectsStorage.get({ orgId, id: factoryProjectId });
                  return project?.autoRunEnabled ?? false;
                },
                factoryProjectExists: async ({ orgId, factoryProjectId }) => {
                  await factoryProjectsStorage.ensureReady();
                  return (await factoryProjectsStorage.get({ orgId, id: factoryProjectId })) !== null;
                },
                reconcileToolResults: () => factoryProcessor?.reconcileAllBoundThreads() ?? Promise.resolve(),
                prepareBinding,
                feedReader: new FactoryFeedReader(workItemCommentsStorage),
                ...(githubIntegration
                  ? {
                      dismissStaleReviews: async decision => {
                        await dismissStaleFactoryReviews(
                          githubIntegration.versionControl,
                          decision,
                          login => isFactoryGithubLogin(githubIntegration, login),
                          login =>
                            trustedCollaborator(githubIntegration, {
                              installationId: decision.installationId,
                              repository: decision.repository,
                              login,
                            }),
                        );
                      },
                      reportReviewStatus: createGithubReviewStatusReporter({
                        github: githubIntegration,
                        sourceControl: sourceControlStorage.forIntegration(githubIntegration.id),
                        workItems: workItemsStorage,
                        reviewerName: process.env.FACTORY_REVIEW_STATUS_NAME?.trim() || 'Factory',
                        ...reviewStatusAnimationFromEnv(process.env),
                      }),
                    }
                  : {}),
                primeCredentials: tenant => primeTenantCredentials({ tenant, credentials: modelCredentialsStorage }),
                reportRunEnd: createWorkItemRunEndReporter({
                  workItems: storage.getDomain<WorkItemsStorage>('work-items'),
                  reporting: factoryReporting,
                }),
                resolveLinkedWorkItemParentId: async ({ orgId, factoryProjectId, decision }) => {
                  if (decision.source !== 'github-pr') return null;
                  const repositoryId = decision.metadata?.githubRepositoryId;
                  const pullRequestNumber = decision.metadata?.githubPullRequestNumber;
                  if (typeof repositoryId !== 'number' || typeof pullRequestNumber !== 'number') return null;
                  return resolveFactoryPullRequestParentWorkItemId(
                    integrationStorage.forIntegration<
                      Record<string, unknown>,
                      Record<string, unknown>,
                      FactoryPullRequestProvenanceData
                    >('github'),
                    { orgId, factoryProjectId, repositoryId, pullRequestNumber },
                  );
                },
              });
            },
          }),
          ...projectRoutes.routes(),
          ...auditDomain.routes(),
          ...commentsDomain.routes(),
          // Connect/reconnect session minting for Platform-managed providers.
          // Server-side because only the deploy holds Platform machine
          // credentials; the SPA runs the OAuth popup with the minted token.
          ...(hasPlatformCredentials()
            ? buildPlatformConnectRoutes({
                auth: routeAuth,
                client: new PlatformApiClient(platformApiClientConfigFromEnv()),
              })
            : []),
        ],
        buildServerConfig: () => {
          // MCP 2026-07-28 clients send `Mcp-*` headers on every request and
          // read the OAuth challenge from `WWW-Authenticate`; the deployer
          // merges these into its default allow/expose lists.
          const mcpCors = {
            allowHeaders: ['Mcp-Protocol-Version', 'Mcp-Method', 'Mcp-Name'],
            exposeHeaders: ['WWW-Authenticate'],
          };
          const cors = {
            cors: allowedOrigins.length ? { origin: allowedOrigins, credentials: true, ...mcpCors } : mcpCors,
          };
          // Log route errors with method/path/stack and answer with structured
          // JSON instead of an opaque `Internal Server Error`. Applied by the
          // deployer to both the top-level app and the custom-route sub-app.
          const onError = { onError: handleServerError };
          // Same-origin SPA: when a vite build is present (see resolveUiDistDir),
          // serve it at `/` from this server. Mounted last so the auth gate (when
          // enabled) covers it; it always passes `/api`, `/web`, `/auth` through.
          const uiDist = resolveUiDistDir();
          const spa = uiDist ? [createSpaStaticMiddleware(uiDist)] : [];
          const timing = factoryTimingEnabled ? [createRequestTimingMiddleware()] : [];
          // A Claude Code Factory's own id never becomes a Mastra chat (see `createClaudeFactoryChatGuard`).
          const claudeFactoryChat = claudeCode
            ? [
                createClaudeFactoryChatGuard({
                  controllerId: CONTROLLER_ID,
                  factoryHarness: async id => {
                    if (!storage.isDomainReady('projects')) return undefined;
                    await factoryProjectsStorage.ensureReady();
                    return (await factoryProjectsStorage.getById({ id }))?.harness ?? undefined;
                  },
                }),
              ]
            : [];
          if (!auth) {
            // Auth disabled: no gate. Still prime the sentinel-local custom
            // provider snapshot so model calls see DB rows, then SPA + CORS.
            return {
              middleware: [
                ...timing,
                createFactoryInteractiveMarker(),
                createCustomProvidersPrimer({ auth: routeAuth, storage: customProvidersStorage, authEnabled: false }),
                ...claudeFactoryChat,
                this.#claudeSessionUi.middleware(),
                ...spa,
              ],
              ...cors,
              ...onError,
            };
          }

          // Ordered middleware. The deployer applies these AFTER its context
          // middleware sets `c.set('mastra', mastra)` and BEFORE routes, so:
          //   1. gate   — validates the auth session, stashes the user, and 401s /
          //               redirects unauthenticated requests. Skips public `/auth/*`.
          //   2. access — 404s requests addressing another user's private session.
          //   3. primers — hydrate the caller's model-credential and custom
          //               provider snapshots so the request's first model call
          //               resolves tenant credentials and custom providers.
          //   4. claude — answers the session routes of Claude Code sessions (see `claudeSessionUi`).
          //   5. spa    — serves the built UI for everything the server doesn't own.
          // `auth` also lands on `server.auth` so the core auth middleware (and
          // Studio's dual-auth routing — see `studio.auth` on the returned args)
          // authenticates core `/api/*` routes with the same provider.
          return {
            auth,
            middleware: [
              ...timing,
              createFactoryAuthGate(auth),
              createSessionAccessGuard({
                auth: routeAuth,
                sessions: sourceControlSessions,
                projects: {
                  get: async args => {
                    if (!storage.isDomainReady('projects')) return null;
                    await factoryProjectsStorage.ensureReady();
                    return factoryProjectsStorage.get(args);
                  },
                },
                controller: () => this.#prepared?.base.controller,
              }),
              createTenantCredentialPrimer({ auth: routeAuth, credentials: modelCredentialsStorage }),
              createCustomProvidersPrimer({
                auth: routeAuth,
                storage: customProvidersStorage,
                authEnabled: Boolean(auth),
              }),
              ...claudeFactoryChat,
              // After the access guard: a Claude Code session's routes get the same checks as any session's.
              this.#claudeSessionUi.middleware(),
              ...spa,
            ],
            ...cors,
            ...onError,
          };
        },
      }),
    );

    if (claudeCode) {
      // Webhook subscriptions and Factory notices deliver through the Mastra controller; a Claude Code
      // session takes them itself, and woken as a Mastra one would be, instead of a Mastra run on its thread.
      const claudeHarness = claudeCode.harness;
      routeExternalSessions(prepared.base.controller, async sessionId => {
        const session = await claudeHarness.getSession(sessionId);
        if (!session) return undefined;
        return {
          sendNotificationSignal: (input, options) =>
            session.sendNotificationSignal(input, { ifIdle: { behavior: options?.ifIdle?.behavior ?? 'wake' } }),
          isRunning: () => session.run.isRunning(),
          abort: () => session.abort(),
          agentSession: session,
          deleteSession: async () => {
            await claudeHarness.deleteSession(sessionId);
            this.#claudeSessionUi.channel(sessionId)?.detach();
          },
          answerToolApproval: async ({ toolCallId, approved }) => {
            if (session.pendingPermission?.toolCallId !== toolCallId) return false;
            await session.respondToToolApproval({ toolCallId, approved });
            return true;
          },
        };
      });
    }

    prepared.base.controller.onSessionCreated(session => {
      observeSessionFilesystem(session, {
        filesystem: filesystemStorage,
        sourceControl: { sessions: sourceControlSessions },
      });
      observeSessionFirstMessage(session, {
        sourceControl: { sessions: sourceControlSessions },
      });
      observeSessionFirstExec(session, {
        sourceControl: { sessions: sourceControlSessions },
      });
      observeSessionThreadTitle(session, {
        sourceControl: { sessions: sourceControlSessions },
      });
      observeSessionRunEnd(asAgentSession(session), { audit: auditDomain });
      // Every run end of a work or side session, and every tool call it holds for
      // approval, reaches whoever follows it, however the run started;
      // re-attached when a session is created again.
      observeSessionRunReports(
        session,
        (outcome, since) =>
          reportSessionRunEnd({
            sessionId: session.identity.getId(),
            threadId: session.thread.getId(),
            outcome,
            since,
          }),
        {
          onApprovalRequested: request =>
            notifyApprovalRequested({
              sessionId: session.identity.getId(),
              threadId: session.thread.getId(),
              ...request,
            }),
        },
      );
      observeSessionThreadStamp(session);
    });

    // Supervisor sessions carry their project in the resourceId; re-stamp
    // scope, instructions and factory defaults on every (re)creation so a
    // restarted server heals the in-memory state.
    prepared.base.controller.onSessionCreated(
      session =>
        hydrateSupervisorSession(session, {
          projects: factoryProjectsStorage,
        }).catch(error => {
          console.warn('[Factory Supervisor] Failed to hydrate supervisor session', {
            error: error instanceof Error ? error.message : String(error),
          });
        }),
      { blocking: true },
    );

    // The Factory's tool permissions live only in session memory: put the stored ones back on every
    // (re)creation, before anything reads them, and keep each change.
    prepared.base.controller.onSessionCreated(
      session =>
        persistFactoryToolPermissions(session, { projects: factoryProjectsStorage }).then(
          () => undefined,
          error =>
            console.warn('[Factory tool permissions] Unable to restore the Factory’s tool permissions', {
              error: error instanceof Error ? error.message : String(error),
            }),
        ),
      { blocking: true },
    );

    // Blocking: `createSession` awaits the organization seed so per-invocation
    // memory settings and knowledge capture use the correct tenant immediately.
    prepared.base.controller.onSessionCreated(
      session =>
        hydrateSessionMemorySettings(session, {
          sourceControl: { sessions: sourceControlSessions },
        }),
      { blocking: true },
    );

    // New chats start on their Factory's default model. Active Factory run
    // bindings are excluded and keep the model their run chose.
    prepared.base.controller.onSessionCreated(
      session =>
        hydrateSessionDefaultModel(session, {
          sourceControl: sourceControlSessions,
          projects: factoryProjectsStorage,
          workItems: workItemsStorage,
        }),
      { blocking: true },
    );

    // Factory tools fall in the SDK's `mcp` category (default `ask`); allow the
    // no-approval ones per session before the session's first turn.
    prepared.base.controller.onSessionCreated(
      session => applyFactoryToolPermissions(session, { sessions: sourceControlSessions }),
      { blocking: true },
    );

    this.#prepared = prepared;
    this.#factoryProcessor = factoryProcessor;

    // Chat-platform channels (Slack, Discord, …) contributed by integrations,
    // attached to the mounted controller so inbound platform messages reach
    // the same agents the web UI drives. READY integrations only — readiness
    // means the `channel-identity` domain's `init()` succeeded, so its link
    // table is queryable. Without it a sender can't be resolved to a tenant,
    // and attaching anyway would dispatch runs on default credentials.
    const channelRegistrations = integrationRegistrations.filter(
      ({ integration, ready }) => ready && integration.channels,
    );
    // `setChannels` replaces rather than merges, so a second provider would
    // silently never receive a message. Fail loud instead.
    if (channelRegistrations.length > 1) {
      throw new Error(
        `MastraFactory: integrations [${channelRegistrations
          .map(({ integration }) => integration.id)
          .join(', ')}] all provide channels, but only one may. Remove all but one.`,
      );
    }
    for (const { integration } of channelRegistrations) {
      const context = buildIntegrationContext(
        {
          controller: prepared.base.controller,
          publicOrigin,
          auth: routeAuth,
          stateSigner,
          sandbox: sandboxConfig,
          factoryStorage: storage,
          integrationStorage,
          sourceControlStorage,
          integrations: integrationRegistrations,
          configVersion,
          boardRegistry: this.#boards,
          ...(this.#projectBoards ? { intakeRoutes: storedBoardsStorage, projectBoards: this.#projectBoards } : {}),
          factoryReady,
          domains,
          feed: commentsDomain,
          ...(githubIntegration ? { sourceControlOwnerId: 'github' } : {}),
        },
        integration.id,
      );
      // Integrations return a channels CONFIG; the factory owns construction.
      prepared.base.controller.setChannels(new AgentControllerChannels(integration.channels!(context)));
    }

    // Feed publishers mirror web-feed comments outward (a chat bridge, a
    // webhook, an issue tracker). Independent of channels(): an integration may
    // publish without owning a chat channel. READY integrations only — the
    // array is held by reference by CommentsDomain (see `feedPublishers` above),
    // so pushing here wires the publisher into comment dispatch.
    for (const { integration } of integrationRegistrations.filter(
      ({ integration, ready }) => ready && integration.feedPublisher,
    )) {
      const context = buildIntegrationContext(
        {
          controller: prepared.base.controller,
          publicOrigin,
          auth: routeAuth,
          stateSigner,
          sandbox: sandboxConfig,
          factoryStorage: storage,
          integrationStorage,
          sourceControlStorage,
          integrations: integrationRegistrations,
          configVersion,
          boardRegistry: this.#boards,
          ...(this.#projectBoards ? { intakeRoutes: storedBoardsStorage, projectBoards: this.#projectBoards } : {}),
          factoryReady,
          domains,
          feed: commentsDomain,
          ...(githubIntegration ? { sourceControlOwnerId: 'github' } : {}),
        },
        integration.id,
      );
      const publisher = integration.feedPublisher!(context);
      if (publisher) feedPublishers.push(publisher);
    }

    // Integration lifecycle workers (e.g. polling an upstream without
    // webhooks): collected from READY integrations only, folded into the
    // constructor args so `new Mastra(...)` merges them with the default
    // workers and `finalize()`'s `startWorkers()` starts them alongside the
    // built-ins. Never passed for the disabled/not-ready case — a worker for
    // an unavailable integration must not run.
    const integrationWorkers = [
      ...(factoryReady
        ? [
            new FactorySupervisorHealthWorker({
              projects: factoryProjectsStorage,
              workItems: workItemsStorage,
              boards: this.#boards,
            }),
          ]
        : []),
      ...integrationRegistrations
        .filter(({ integration, ready }) => ready && integration.workers)
        .flatMap(({ integration }) =>
          integration.workers!(
            buildIntegrationContext(
              {
                controller: prepared.base.controller,
                publicOrigin,
                auth: routeAuth,
                stateSigner,
                sandbox: sandboxConfig,
                factoryStorage: storage,
                integrationStorage,
                sourceControlStorage,
                integrations: integrationRegistrations,
                configVersion,
                boardRegistry: this.#boards,
                factoryReady,
                domains,
                feed: commentsDomain,
                ...(githubIntegration ? { sourceControlOwnerId: 'github' } : {}),
              },
              integration.id,
            ),
          ),
        ),
    ];

    return {
      ...prepared.mastraArgs,
      // Same provider on `studio.auth` as on `server.auth` (buildServerConfig):
      // deployed factories must authenticate BOTH plain API callers and Studio
      // requests (`x-mastra-client-type: studio` routes to `studio.auth`).
      ...(auth ? { studio: { auth } } : {}),
      ...(integrationWorkers.length > 0 ? { workers: integrationWorkers } : {}),
      ...(environmentBuilds || this.#intakeRules
        ? {
            workflows: {
              ...(environmentBuilds ? { [ENVIRONMENT_BUILD_WORKFLOW_ID]: environmentBuilds.workflow } : {}),
              ...(this.#intakeRules?.workflows ?? {}),
            },
          }
        : {}),
    };
  }

  /**
   * Post-construct boot: initialize the controller (which inherits the
   * constructed Mastra's storage) and start its workers. Call AFTER the entry
   * has run `new Mastra(prepare()'s args)`.
   */
  async finalize(): Promise<void> {
    if (!this.#prepared) {
      throw new Error('MastraFactory.finalize() called before prepare()');
    }
    await timedPhase('finalize.controller', () => this.#prepared!.finalize());
    await this.#environmentBuilds?.probeSchedules();
    if (this.#intakeRules) {
      await this.#intakeRules.engine.start();
      await timedPhase('finalize.intakeRules', () => this.#intakeRules!.engine.armAll());
    }
    await timedPhase(
      'finalize.reconcileBoundThreads',
      () => this.#factoryProcessor?.reconcileAllBoundThreads() ?? Promise.resolve(),
    );
    // A thread's messages move before its run binding does, so a reconcile that
    // overlapped the migration can miss them. Catch up once the bindings moved.
    void this.#sessionResourceMigration
      ?.then(movedRunBindings => (movedRunBindings ? this.#factoryProcessor?.reconcileAllBoundThreads() : undefined))
      .catch(error =>
        console.warn(
          `[factory] reconciling bound threads after the session resource migration failed: ${error instanceof Error ? error.message : error}`,
        ),
      );
    this.#dispatcher?.start();
    // Unconditional and outside the Mastra logger, which production runs at WARN.
    if (this.#prepareStartedAt !== undefined)
      logTiming(`boot ${Math.round(performance.now() - this.#prepareStartedAt)}ms`);
  }

  /** Stop Factory-owned background dispatch before the host process shuts down. */
  async shutdown(): Promise<void> {
    const unsubscribeDispatchWakes = this.#unsubscribeDispatchWakes;
    this.#unsubscribeDispatchWakes = undefined;
    await unsubscribeDispatchWakes
      ?.then(unsubscribe => unsubscribe?.())
      .catch(error =>
        console.warn(
          `[factory] unsubscribing from dispatcher wakes failed: ${error instanceof Error ? error.message : error}`,
        ),
      );
    const backfill = this.#workItemSplitBackfill;
    backfill?.controller.abort();
    await Promise.all([
      this.#dispatcher?.stop(),
      // Stops between cards; failures are already logged.
      backfill?.promise,
    ]);
  }
}
