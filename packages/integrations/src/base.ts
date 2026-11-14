/**
 * `FactoryIntegration` — the common contract for pluggable web integrations
 * (GitHub, GitLab, third-party).
 *
 * Each integration is a self-contained class: the deploy entry
 * (`src/mastra/index.ts`) reads that integration's env vars ONCE, constructs
 * an instance with explicit credentials, and passes it to `MastraFactory`
 * via `integrations: [...]`. The factory registers the pieces each instance
 * provides — HTTP routes, agent/session tools, diagnostics — into the system.
 * No system code reads integration env vars or imports integration free
 * functions; everything downstream talks to instances through this interface.
 *
 * An absent integration means: its routes never mount, its tools never
 * register, diagnostics report "not configured", and the server boots fine.
 * Third parties add capabilities by implementing this same interface — no
 * factory changes required (the same capability-based philosophy as the
 * sandbox machine's `derive()` gate).
 */

import type { MastraCodeConfig, MountedMastraCode } from '@mastra/code-sdk';
import type { AgentControllerChannelsConfig, ChannelAdapterConfig } from '@mastra/core/channels';
import type { RequestContext } from '@mastra/core/request-context';
import type { ApiRoute, IUserProvider } from '@mastra/core/server';
import type { FactoryStorage } from '@mastra/core/storage';
import type { MastraWorker } from '@mastra/core/worker';
import type { FactorySandbox } from '@mastra/core/workspace';

import type { BoardRegistry, IntakeRoutesReader, ManagedMcpServerSpec, ProjectBoardSource } from '@factory/core';
import type { StoredBoardsStorage } from '@factory/store';
import type { Intake } from '@factory/capabilities';
import type { VersionControl } from '@factory/capabilities';
import type { CredentialProvider } from '@factory/capabilities';
import type { RouteAuth } from '@factory/http';
import type { SessionRetirementCoordinator } from '@factory/sandbox';
import type { StateSigner } from '@factory/auth';
import type { AuditEventRow } from '@factory/store';
import type { AuditEmitter } from '@factory/feed';
import type { IntegrationConnections } from './connections.ts';
import type { CardSource } from './kept-cards.ts';
import type { ChannelIdentityStorage } from '@factory/store';
import type { CommentsDomain } from '@factory/feed';
import type { WorkItemFeedPublisher } from '@factory/feed';
import type { IntakeStorage } from '@factory/store';
import type { IntegrationStorageHandle } from '@factory/store';
import type { MemorySettingsStorage } from '@factory/store';
import type { FactoryProjectsStorage } from '@factory/store';
import type { SourceControlStorageHandle } from '@factory/store';
import type { WorkItemsStorage } from '@factory/store';

/** A push to a repository linked to a project, as a version-control integration reports it. */
export interface RepositoryPushEvent {
  orgId: string;
  factoryProjectId: string;
  projectRepository: { id: string; inEnvironment: boolean };
  /** The pushed git ref, for example `refs/heads/main`. */
  ref: string;
  /** The repository's default branch as the provider reports it. */
  defaultBranch: string;
}

/** Factory-owned hooks integrations may invoke. */
export interface IntegrationHooks {
  emitAudit?: AuditEmitter['emit'];
  /** Hand a push off for an environment build; never blocks the webhook and never throws. */
  onRepositoryPush?: (event: RepositoryPushEvent) => void;
  /**
   * The integration's settings changed what MCP servers it manages (`managedMcpServers`); the
   * factory syncs the organization's servers to match. Resolves once they do; a failure throws.
   */
  onManagedMcpServersChanged?: (orgId: string) => Promise<void>;
}

/**
 * Tool records integrations contribute — the same static-record shape the
 * SDK's `extraTools` accepts, so the factory can merge every integration's
 * tools into one dynamic tool set.
 */
export type IntegrationTools = Extract<NonNullable<MastraCodeConfig['extraTools']>, Record<string, unknown>>;

export interface IntegrationPostToolContext {
  toolName: string;
  input: unknown;
  output?: unknown;
  error?: unknown;
  context: unknown;
}

/**
 * Everything the factory hands an integration when collecting its routes.
 * Built once per boot in `MastraFactory.prepare()`.
 */
export interface IntegrationContext {
  /** Host auth seam — integration routes resolve callers through this. */
  auth: RouteAuth;
  /** Optional user directory for resolving persisted user ids to display profiles. */
  users?: Pick<IUserProvider, 'getUser' | 'getUsers'>;
  /**
   * The deploy's sandbox callback for per-project and per-session
   * sandboxes. Absent when no sandbox is configured — sandbox-backed
   * routes respond 503.
   */
  sandbox?: FactorySandbox;
  /**
   * Root factory storage backend and source of the `appDbConfigured`
   * diagnostic. Absent when the host runs without an application database.
   */
  factoryStorage?: FactoryStorage;
  /** Browser-facing origin (OAuth redirect base), no trailing slash. */
  baseUrl?: string;
  /** Mounted agent controller for webhook → session signal delivery. */
  controller?: MountedMastraCode['controller'];
  /**
   * Shared OAuth state signer created by the factory. One signer per boot, so
   * every integration's OAuth flow signs and verifies with the same secret.
   */
  stateSigner?: StateSigner;
  /** Shared source-control session retirement lifecycle used by integration routes. */
  sessionRetirement?: SessionRetirementCoordinator;
  /** Work-items domain slice — deleting a session strips the refs work items hold on it. */
  workItems?: Pick<WorkItemsStorage, 'clearSessionReferences' | 'hasRunBindingForSession'>;
  /** Feed slice for ingesting platform messages; present once work items are ready. */
  feed?: Pick<CommentsDomain, 'createComment'>;
  /** Persistence handles pre-scoped to this integration's stable id. */
  storage: {
    generic: IntegrationStorageHandle;
    sourceControl: SourceControlStorageHandle;
    /**
     * The factory's source-control-owning integration's storage handle
     * (today: GitHub when registered; the handle carries its own
     * `integrationId`). Channel integrations use it to make sessions
     * repo-backed without the entry hand-wiring a source-control slice.
     * Absent when no source-control owner is registered.
     */
    sourceControlOwner?: SourceControlStorageHandle;
    /** Every registered source-control partition, for project-aware provider selection. */
    sourceControls: readonly SourceControlStorageHandle[];
    /** Factory projects domain — e.g. resolving a project's default model. */
    projects: FactoryProjectsStorage;
    /**
     * Observational-memory settings domain, so a session an integration starts
     * adopts the same memory configuration the web kickoff applies.
     */
    memorySettings: MemorySettingsStorage;
    /** Cross-integration intake selection (which sources are synced). */
    intake: IntakeStorage;
    /**
     * Reverse index from a chat-platform sender to a Mastra tenant. Channel
     * integrations resolve an inbound sender through this to run under the
     * right user's credentials.
     */
    channelIdentity: ChannelIdentityStorage;
  };
  /**
   * Factory runtime available when the work-item domain is ready.
   * Integrations attach their own provider event rules to their ingress
   * surfaces instead of relying on provider-specific services in the host.
   */
  runtime?: {
    /** Operator-maintained provenance label stamped on audit rows. */
    configVersion: string;
    workItems: WorkItemsStorage;
    /**
     * Installed boards, so integrations read phase semantics instead of matching names. The
     * per-project source serves each project its stored boards.
     */
    boards: BoardRegistry | ProjectBoardSource;
    /**
     * The project's intake routes, for integrations that import tasks themselves: the routes say
     * which lists a project reads and where a new task lands. Present whenever the `boards` domain
     * is ready; an integration that can't work without it lists `boards` in `requiredDomains`.
     */
    intakeRoutes?: IntakeRoutesReader;
    /** A project's boards, stored ones included, which an intake route may name. */
    projectBoards?: { load(scope: { orgId: string; factoryProjectId: string }): Promise<BoardRegistry> };
    /**
     * Every project's provider-backed cards, kept in memory between background
     * sweeps so a sweep with nothing to change reads nothing from storage.
     * Absent where no sweep runs (route contexts, tests).
     */
    keptCards?: CardSource;
  };
  /** System hooks integrations may invoke. */
  hooks?: IntegrationHooks;
}

/**
 * One adapter entry in a {@link FactoryChannelsConfig} adapter map.
 *
 * Core's adapter-map entry is `ChannelAdapterConfig | Adapter<any, any>`, and
 * `ChannelAdapterConfig` is itself a union — so this MUST be a type alias, not
 * an interface extends (illegal on unions). Factory's contract deliberately
 * EXCLUDES the bare-`Adapter` shorthand core accepts: entries use the config
 * form so future per-platform extras (e.g. a `resolveWorkspaceId`, connect
 * handlers) have a home. Today the alias adds no fields; it is the stable
 * extension point.
 */
export type FactoryChannelAdapterEntry = ChannelAdapterConfig;

/**
 * The channels contribution a {@link FactoryIntegration} returns from
 * `channels()`. A config object, not a built instance — the factory constructs
 * the `AgentControllerChannels` at the attach site.
 *
 * The adapter-map key is the platform identity (`'slack'`, `'discord'`, …).
 * One integration = one platform = one entry is the norm: the map shape is
 * inherited from core (one `AgentControllerChannels` instance drives multiple
 * adapters) and is where cross-integration merging will happen later — it is
 * NOT an invitation for a single integration to bundle multiple platforms.
 * Note the top-level `handlers` and resolvers are shared across all adapters
 * in the map. Entries use the config form; the bare-`Adapter` shorthand core
 * accepts is deliberately excluded (see {@link FactoryChannelAdapterEntry}).
 */
export interface FactoryChannelsConfig extends Omit<AgentControllerChannelsConfig, 'adapters'> {
  adapters: Record<string, FactoryChannelAdapterEntry>;
}

/**
 * A pluggable web integration. Implementations own their credentials
 * (validated at construction), their API surface, and their HTTP routes.
 */
/** What an integration's `migrate` gets: its own storage, intake bindings and the intake routes to write. */
export interface IntegrationMigrationContext {
  storage: IntegrationStorageHandle;
  projects: Pick<FactoryProjectsStorage, 'listAll'>;
  intake: IntakeStorage;
  intakeRoutes: Pick<StoredBoardsStorage, 'listIntakeRoutes' | 'createIntakeRoute' | 'updateIntakeRoute'>;
  projectBoards: { load(scope: { orgId: string; factoryProjectId: string }): Promise<BoardRegistry> };
}

export interface FactoryIntegration {
  /** Stable identifier: `'github'`, `'gitlab'`, custom ids for third parties. */
  readonly id: string;
  /** Issue-oriented capability consumed by Intake. */
  readonly intake?: Intake;
  /** Repository, installation, and pull-request capability. */
  readonly versionControl?: VersionControl;
  /**
   * Further intake switches the organization turns on in Settings beside the integration's own
   * (`intake config` keys, off until enabled): GitHub's `dependabot` (ADR-0042).
   */
  readonly intakeSwitches?: readonly string[];
  /**
   * Storage domains the integration can't work without, beyond the generic `integrations` domain
   * (e.g. `boards` for an integration that imports through intake routes). The factory counts the
   * integration ready only when they are, and logs which are missing otherwise: a not-ready
   * integration starts no workers and no channels, and the rest of the server boots on.
   */
  readonly requiredDomains?: readonly string[];
  /**
   * Bind the integration's generic persistence handle. Called once by the
   * factory during `prepare()` (before routes/tools/workers are collected),
   * so instance methods that run outside an `IntegrationContext` — per-request
   * agent tools, intake capability calls — reach storage without a service
   * locator. Mirrors `sourceControl.initialize`.
   */
  initialize?(args: {
    storage: IntegrationStorageHandle;
    projects: FactoryProjectsStorage;
    auth: RouteAuth;
    /** Cross-integration intake selection/binding domain, for per-request authorization. */
    intake: IntakeStorage;
    sourceControl?: SourceControlStorageHandle;
  }): void;
  /**
   * Accounts this integration keeps that other parts of the Factory may use by reference (an MCP
   * server filled from a Google Cloud account). Called after `initialize`.
   */
  credentialProviders?(): CredentialProvider[];
  /**
   * MCP servers this integration runs under the hood for an organization, as its settings say
   * (desired state): Google Cloud's «База» is MCP Toolbox for a binding's project. The factory
   * syncs them into Settings › Інтеграції › MCP, marked as managed. Called after `initialize`.
   */
  managedMcpServers?(orgId: string): Promise<ManagedMcpServerSpec[]>;
  /**
   * One-off data migrations the integration owns, such as moving its retired per-source settings
   * into intake routes. Run by the factory once per boot, in `prepare()`, after storage and the
   * project boards are ready and before workers start; must be idempotent, since every replica
   * runs it. A failure is logged loudly and the boot goes on.
   */
  migrate?(ctx: IntegrationMigrationContext): Promise<void>;
  /**
   * Moves the token a deployment used to keep in its env (ADR-0032) into `orgId`'s connection, once:
   * `env` holds the retired variables the entry read (`CLICKUP_API_TOKEN`, …). Never overwrites a
   * token the organization already stored. Run by the factory's boot migration
   * `integrations.envTokensToOrg.<id>.v1`; returns a line for the log when something moved or was kept.
   */
  adoptDeploymentToken?(input: {
    storage: IntegrationStorageHandle;
    orgId: string;
    env: Readonly<Record<string, string>>;
  }): Promise<string | undefined>;
  /**
   * The integration's full HTTP surface (status, OAuth, webhooks, feature
   * routes), as Mastra `apiRoutes`. Called once at boot; the factory folds
   * the result into the server's route table.
   */
  routes(ctx: IntegrationContext): ApiRoute[];
  /**
   * The accounts this integration connects, for Settings › Підключення (ADR-0035): connect methods,
   * each connection's state and allowed actions, removal impact and detail — all as descriptors with
   * copy in the request's language, served through the shared `/web/connections` routes. Called once
   * at boot for READY integrations, with the same context as `routes`.
   */
  connections?(ctx: IntegrationContext): IntegrationConnections;
  /**
   * Org-scoped agent tools resolved per request (e.g. an issue tracker's tools).
   * Optional capability; the factory merges results into the SDK's async
   * `extraTools` provider.
   */
  agentTools?(args: { requestContext: RequestContext }): Promise<IntegrationTools>;
  /**
   * Session-scoped tools (e.g. GitHub's PR subscribe/unsubscribe). Optional
   * capability, resolved synchronously per request.
   */
  sessionTools?(args: { requestContext: RequestContext }): IntegrationTools;
  /**
   * Optional provider-owned observer for successful or failed tool calls.
   * The factory invokes every configured observer independently so one
   * integration cannot prevent another from observing the same tool result.
   */
  postToolObserver?(args: { toolContext: IntegrationPostToolContext; requestContext?: RequestContext }): Promise<void>;
  /**
   * Background workers the integration needs running for its lifecycle
   * (e.g. polling an upstream that doesn't support webhooks). Optional
   * capability: called once at boot for READY integrations only; the factory
   * folds the returned workers into the server Mastra's `workers` option, so
   * they are merged with the built-in workers and started with them
   * (`startWorkers()`). Worker names must be unique across integrations —
   * duplicates fail the `new Mastra(...)` construction loudly.
   */
  workers?(ctx: IntegrationContext): MastraWorker[];
  /**
   * Chat-platform channels this integration contributes (Slack, Discord, …).
   * Called once at boot for READY integrations only; the factory constructs an
   * `AgentControllerChannels` from the returned config and attaches it to the
   * mounted agent controller via `setChannels`, so inbound platform messages
   * reach the same agents the web UI drives.
   *
   * An integration providing this slot also declares a dependency on the
   * `channel-identity` domain, which the factory folds into its readiness
   * gate — so an integration whose reverse index isn't migrated yet reports
   * not-ready and its channels never attach, rather than dispatching runs it
   * can't resolve a tenant for.
   *
   * Only one integration may provide channels; the factory fails loud at boot
   * on a second, because `setChannels` replaces rather than merges and the
   * loser would silently never receive a message.
   */
  channels?(ctx: IntegrationContext): FactoryChannelsConfig;
  /**
   * Mirrors web feed comments outward — to the platform thread a work item is
   * bound to, a webhook, or an issue tracker. Collected from every READY
   * integration independent of `channels()`: an integration may publish without
   * owning a chat channel.
   */
  feedPublisher?(ctx: IntegrationContext): WorkItemFeedPublisher;
  /**
   * Non-secret config snapshot (booleans + names only, never values). The
   * factory merges it into system diagnostics/startup logs.
   */
  diagnostics(): Record<string, unknown>;
  /**
   * Optional best-effort destination for locally persisted audit events.
   * Audit export remains independent of the configured web auth adapter.
   */
  audit?(args: { event: AuditEventRow }): Promise<void>;
  /**
   * True when the integration signs OAuth `state` and therefore needs a
   * replica-stable signer. The factory fails loud at boot when a registered
   * integration requires stability but only a per-process random secret is
   * available (see `./state-signing.ts`).
   */
  readonly requiresStableStateSigner?: boolean;
}
