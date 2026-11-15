/**
 * The server's harness modules (ADR-0044): `FactoryHarnessModule` of `@factory/harness/module`, with
 * this server's config, boot and run dependencies. `MastraFactory` goes through the registry
 * (`./registry.ts`) for everything harness-shaped and never names a harness; each harness's own
 * wiring lives in its folder (`../claude/module.ts`, `../codex/module.ts`, `../opencode/module.ts`).
 *
 * Mastra is the base harness: the in-process controller every session runs on unless another
 * harness holds it. Its module has a descriptor only; the others are turn harnesses (a CLI per
 * turn or run) and plug in through {@link TurnHarnessModule}.
 */
import type { HarnessApiModule } from '@factory/api';
import type { ChatTranscriptSession } from '@factory/harness-claude-code-ui';
import type { ClaudeCodeSession } from '@factory/harness-claude-code';
import type { HarnessDescriptor } from '@factory/harness/descriptor';
import type { HarnessExecutable, HarnessExecutableReport } from '@factory/harness/executable';
import type { FactoryHarnessModule, FactoryHarnessRunning, PreparedFactoryHarness } from '@factory/harness/module';
import type { ModelSelection } from '@factory/harness/models/contracts';
import type { HarnessStartCoordinator, ClaudeCodeUserSessions } from '@factory/api';
import type { FactoryTransitionService } from '@factory/runtime';
import type { BoardRegistry } from '@factory/core';
import type { FactoryProjectsStorage, ModelCredentialsStorage, SourceControlSession, WorkItemsStorage } from '@factory/store';
import type { AttachmentService } from '@factory/store';

import type { AgentUserRuntime } from '../agent-user/agent-user-runtime.ts';
import type { ParkedSessionSource } from '../session/usage-limit-resume.ts';
import type { ClaudeFactoryHarnessOptions } from '../claude/harness.ts';
import type { TurnHandoffHook } from '@factory/harness';
import type { AgentSession } from '@factory/harness';

/** The session coordinates the Factory's run hooks take. */
export interface TurnSessionCoordinates {
  orgId: string;
  factoryProjectId: string;
  sessionId: string;
  threadId: string;
  resourceId: string;
}

/**
 * A turn harness's session as the server drives it outside its own harness: the chat channel,
 * worker messages, notices, approvals. Codex's and OpenCode's sessions share Claude Code's shape.
 */
export type TurnHarnessSession = AgentSession &
  Pick<ClaudeCodeSession, 'id' | 'thread' | 'sendSignal' | 'pendingPermission' | 'respondToToolApproval'>;

/** A turn harness's engine: the sessions it keeps in its own store. */
export interface TurnHarnessEngine {
  getSession(sessionId: string): Promise<TurnHarnessSession | undefined>;
  createSession(input: { sessionId: string; threadId: string; resourceId?: string }): Promise<TurnHarnessSession>;
  /** Gives a session up to another harness (a model pick moved it): its record goes, its thread stays. */
  releaseSession(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}

/** What boot gives a module before any session exists. */
export interface HarnessBootDeps {
  /** The organization's and members' credentials (accounts, sign-ins, keys). */
  credentials: ModelCredentialsStorage;
}

/**
 * What the server gives a turn harness to run sessions with: one object built once, so a module
 * takes what it needs and nothing is wired per harness in `MastraFactory`.
 */
export interface TurnHarnessHost {
  readonly sessions: ClaudeFactoryHarnessOptions['sessions'];
  readonly projects: FactoryProjectsStorage;
  readonly credentials: ModelCredentialsStorage;
  /** The sandbox provider new sessions check out in (`local`, …); undefined without a sandbox. */
  readonly sandboxProvider: string | undefined;
  /** The default checkout: the repository on the session's branch, on this host. */
  readonly checkout: (sessionId: string) => Promise<string>;
  /** The Factory MCP endpoint for a Factory, at `origin` (the harness's own `mcpOrigin`) or the public one. */
  mcpUrl(origin: string | undefined): (factoryProjectId: string) => string;
  readonly sessionTokens: NonNullable<ClaudeFactoryHarnessOptions['mcp']>['tokens'];
  /** Settings → Behavior → Tool permissions, read before each turn. */
  permissions(): NonNullable<ClaudeFactoryHarnessOptions['permissions']>;
  /** A session that ever ran a card's role: nobody is there to answer a prompt. */
  cardRun(session: { orgId: string; factoryProjectId: string; sessionId: string }): boolean | Promise<boolean>;
  /**
   * The Factory signals a bound run reads before each turn; absent while the work-items domain is not
   * ready. `phaseFor` takes what the session's next turn runs on (model id and thinking level).
   */
  readonly signals?: {
    phaseFor(runtime: (session: TurnSessionCoordinates) => Promise<{ modelId: string; thinkingLevel: string }>): (
      session: TurnSessionCoordinates,
    ) => Promise<string | undefined>;
    workItemFor(session: TurnSessionCoordinates): Promise<string | undefined>;
    /** The read-only web tools a Product card's run uses unasked, or undefined off Product cards. */
    productWebTools(session: TurnSessionCoordinates): Promise<string[] | undefined>;
  };
  sessionsFor(session: TurnSessionCoordinates & { userId: string }): Promise<string | undefined>;
  /** A Factory by id, once the projects domain is ready; null while it is not or when there is none. */
  projectById(args: { id: string }): ReturnType<FactoryProjectsStorage['getById']>;
  /** External MCP tools set to «ask» for the session (Settings › MCP-сервери). */
  mcpAskToolsFor(session: { orgId: string; factoryProjectId: string; sessionId: string }): Promise<string[]>;
  /** A move from another harness left the thread's history pending, or the CLI lost the conversation. */
  handoffContextFor<Session extends { id: string; thread: { getId(): string | undefined } }>(harnessId: string): TurnHandoffHook<Session>;
  /** Prepares a handoff onto this session's next turn (an imported history, a lost conversation). */
  prepareHandoff(input: { threadId: string; resourceId: string; fromInstanceId: string; toInstanceId: string; reason: 'resume_failed' }): Promise<void>;
  /** Every session object a harness builds: chat channel, run bookkeeping, usage (under `harnessId`), title, live list. */
  onSession(session: TurnHarnessSession, harnessId: string): void;
  parkOnUsageLimit(session: { id: string }): Promise<boolean>;
  /** Waits until the chat channel of a session wrote everything it was given. */
  chatFlushed(sessionId: string): Promise<void>;
  readonly workItems?: WorkItemsStorage;
  readonly attachments?: AttachmentService;
  /** A card's start on a turn harness; absent without the Factory's transitions. */
  readonly starts?: {
    readonly storage: WorkItemsStorage;
    readonly transitionService: FactoryTransitionService;
    readonly boards: ConstructorParameters<typeof import('../claude/start-coordinator.ts').ClaudeStartCoordinator>[0]['boards'];
    sourceControl(request: { sessionId: string }): Promise<import('@factory/store').SourceControlStorageHandle | undefined>;
  };
}

/** A turn harness the server runs: everything `MastraFactory` and the API need from it. */
export interface RunningTurnHarness extends FactoryHarnessRunning {
  readonly harness: TurnHarnessEngine;
  /** Sessions parked on a usage limit, resumed at the reset. */
  readonly parked: ParkedSessionSource;
  /** A deleted session's own CLI state (config dir, home). */
  removeSessionFiles(sessionId: string): Promise<void>;
  /** A session by id for the chat UI, its Factory chat (supervisor) created when the chat first reaches it. */
  resolveChatSession(sessionId: string): Promise<ChatTranscriptSession | undefined>;
  /** The chat's model of a session; `undefined` when the session is not this harness's. */
  modelSelection(session: ChatTranscriptSession): Promise<ModelSelection | null> | undefined;
  /** The session's checkout resolver (the default one, or the config's `cwdFor`). */
  readonly checkout: (sessionId: string) => string | Promise<string>;
  /** The config replaced the checkout: the server's local sandbox does not attach it. */
  readonly customCheckout: boolean;
  /** Personal sessions of its Factories (see the session routes). */
  readonly userSessions: ClaudeCodeUserSessions;
  /** Its card start path; `owns` keeps a card that started here after the Factory switches harness. */
  readonly startCoordinator?: HarnessStartCoordinator;
  /** Whether it can take a session now (its CLI is installed); asked each time, so an install shows up. */
  available(): boolean;
  /** For card runs on members' sign-ins: why the Factory's own runs cannot start, or undefined. */
  factoryRunAccounts?(tenant: { orgId: string; userId: string }): Promise<string | undefined>;
  /**
   * Its sessions join the Factory's own session routing: the Factory chat's worker messages, webhook
   * notices and wakes reach them, and its Factory's own id is no Mastra chat.
   */
  readonly joinsSessionRouting: boolean;
  /** A run can stop for a person mid-call: MCP tools set to «ask» are offered (else left out). */
  readonly asksMidCall: boolean;
  /** Serves the per-session Factory tools over MCP (`skill_read` reads these skill folders). */
  readonly mcpSessionTools?: { skillDirectories: string[] };
  /** What it adds to the API: feature flags, connectors, routes. */
  readonly api: NonNullable<HarnessApiModule['running']>;
}

export interface PreparedTurnHarness extends PreparedFactoryHarness<TurnHarnessHost, RunningTurnHarness> {
  /** The CLI it spawns, resolved for the server (ADR-0038); undefined when the host launches it itself. */
  readonly executable?: HarnessExecutable;
  /** Secret for the MCP session tokens its runs carry, when its config names one. */
  readonly sessionTokenSecret?: string;
}

/** What a module reads its config from in a deployment (`apps/server`): the environment and the host. */
export interface HarnessConfigEnv {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The server user's home. */
  readonly home: string;
  /** The server runs on the person's own machine (local development): sign-ins and local imports are offered. */
  readonly ownMachine: boolean;
  /** Agents run as their own macOS user (ADR-0041): each harness takes its spawn settings from it. */
  readonly agentUser?: AgentUserRuntime;
}

export type HarnessConfigFromEnv<Config> = (context: HarnessConfigEnv) => Config | undefined;

/** A turn harness module: one per harness folder, listed in `./registry.ts`. */
export interface TurnHarnessModule<Config = never, Key extends string = string>
  extends FactoryHarnessModule<Config, HarnessBootDeps, TurnHarnessHost, RunningTurnHarness> {
  readonly kind: 'turn';
  readonly configKey: Key;
  /** Its config as the deployment's environment sets it; undefined leaves it off. */
  readonly configFromEnv?: HarnessConfigFromEnv<Config>;
  /** API flags it owns in `/web/config/features`, false while it does not run here. */
  readonly featureFlags: readonly string[];
  prepare(config: Config, boot: HarnessBootDeps): PreparedTurnHarness;
}

/** Mastra: the base harness, always running; sessions it holds are the controller's. */
export interface BaseHarnessModule {
  readonly kind: 'base';
  readonly descriptor: HarnessDescriptor;
}

export type ServerHarnessModule = BaseHarnessModule | TurnHarnessModule<any, string>;

export type { HarnessExecutableReport, SourceControlSession, BoardRegistry };
