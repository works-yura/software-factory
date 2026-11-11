import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { HarnessRoute } from '@factory/harness';
import type { ModelSelection } from '@factory/harness/models/contracts';
import type { ClaudeToolPermissions } from '@factory/harness-claude-code';
import {
  CodexError,
  CODEX_INSTANCE_ID,
  CODEX_NEEDS_ACCOUNT_REASON,
  createCodexCatalogSource,
  createCodexHarness,
  createCodexHarnessModels,
  createJsonFileCodexSessionStore,
  findCodexBinary,
  type CodexCatalogSource,
  type CodexHarness,
  type CodexHarnessModels,
  type CodexSession,
  type CodexSessionStore,
  type CodexSpawn,
  type CodexTurnPolicy,
} from '@factory/harness-codex';
import { codexAppServerArgs, resolveCodexLaunchArgs } from '@factory/harness-codex/launchArgs';
import { FACTORY_SESSION_TOKEN_HEADER } from '@factory/mcp';
import type { FactorySessionTokenSigner } from '@factory/mcp';
import { peekSessionEnvironment, renderSessionEnvironment } from '@factory/sandbox';
import type { SourceControlSessionLookup } from '@factory/session';
import type { FactoryProject, FactoryProjectsStorage } from '@factory/store';

import { withAgentLanguage } from '../agent-language.ts';
import { claudeFactorySkillDirectories, type ClaudeFactoryPermissionsHook } from '../claude/harness.ts';
import { createSessionDirs } from '../claude/config-dir.ts';
import {
  CLAUDE_SUPERVISOR_WRITE_TOOLS,
  CODEX_SUPERVISOR_INSTRUCTIONS,
  claudeSupervisorProjectId,
  createClaudeSupervisorWorkdir,
  createTurnSupervisorSessions,
} from '../claude/supervisor.ts';
import { CLAUDE_THREAD_SETTINGS } from '../claude/start-coordinator.ts';
import { codexUntrustedCheckoutConfig, isUntrustedCheckout } from '../turn-harness.ts';
import type { CodexCredentials } from './credentials.ts';

/** The MCP server name the Factory's tools are mounted under in a Codex thread. */
export const CODEX_FACTORY_MCP_SERVER = 'factory';

/** A run can take hours; its Factory token outlives it (Claude Code mints one per turn instead). */
const CODEX_SESSION_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

/** The Factory chat's write tools as Codex names them: asked about on every call. */
export const CODEX_SUPERVISOR_ASK_TOOLS = CLAUDE_SUPERVISOR_WRITE_TOOLS.map(id => `mcp__${CODEX_FACTORY_MCP_SERVER}__${id}`);

/** The Factory chat's write tools, each prompted for (`mcp_servers.factory.tools.<tool>.approval_mode`). */
const CODEX_SUPERVISOR_PROMPTED_TOOLS: Record<string, { approval_mode: 'prompt' }> = Object.fromEntries(
  CLAUDE_SUPERVISOR_WRITE_TOOLS.map(id => [id, { approval_mode: 'prompt' as const }]),
);

/** The thread's developer instructions: what a Factory session is, and where its tools are. */
export const CODEX_FACTORY_INSTRUCTIONS = [
  'You are an agent session of a Factory: a work item on a board is bound to this session, and Factory skills tell you what to do with it.',
  `The Factory's tools are on the \`${CODEX_FACTORY_MCP_SERVER}\` MCP server; instructions name them without the server prefix.`,
  "Each turn opens with the Factory's signals: `<factory-environment>` (the repositories in your working directory) and, on a card run, `<factory-phase>` (stage, revision, role) and `<factory-work-item>` (the card, its sources and Factory state). Mid-turn, `factory_bound_work_item` reads the current stage and revision.",
  'Your environment holds no source-control credentials: reach the provider only through the `source_control_*` tools (push, change requests, reviews, issues, `source_control_api_read` for other reads), never `git push`, `gh`, `glab` or direct API calls.',
].join(' ');

/** Leads a planning turn: Codex plans in its plan mode and the plan gate ends it. */
export const CODEX_FACTORY_PLANNING_PROMPT =
  '<factory-mode name="planning">\nYou are planning. Investigate read-only; nothing is changed this turn. ' +
  'Follow the planning instructions below, but end differently: do not call factory_transition_work_item; when the plan is complete, present it in full (with a short title as its heading), then stop. ' +
  'A person approves the plan, which moves the work item on and resumes this session.\n</factory-mode>';

/**
 * The Factory's tool permissions (Settings → Behavior) as a Codex runtime mode: auto-approve leaves
 * the sandbox; denied or asked edits run read-only and ask; otherwise Codex writes in the workspace
 * and asks before anything outside it.
 */
export function codexPolicyFromPermissions(permissions: ClaudeToolPermissions | undefined): CodexTurnPolicy {
  const unattended = permissions?.unattended ? { unattended: true, ...(permissions.parkAsks ? { parkAsks: true } : {}) } : {};
  if (permissions?.yolo) return { runtimeMode: 'full-access', networkAccess: true, ...unattended };
  const edit = permissions?.categories?.edit ?? 'ask';
  const execute = permissions?.categories?.execute ?? 'ask';
  if (edit !== 'allow' || execute === 'deny') return { runtimeMode: 'approval-required', ...unattended };
  return { runtimeMode: 'auto-accept-edits', ...unattended };
}

export type CodexModelDefaults = Pick<FactoryProject, 'harnessModelDefaults'> | null;

/** A Factory's Codex default (`harnessModelDefaults.codex`), as the harness's model facet reads it. */
export function codexModelDefaults(project: CodexModelDefaults): ModelSelection | null {
  return project?.harnessModelDefaults?.[CODEX_INSTANCE_ID] ?? null;
}

type SessionCoordinates = { orgId: string; factoryProjectId: string; sessionId: string; threadId: string; resourceId: string };

export interface CodexFactoryHarnessOptions {
  /** Where Codex sessions are recorded; required unless `store` is given. */
  storeDir?: string;
  store?: CodexSessionStore;
  sessions: Pick<SourceControlSessionLookup, 'getBySessionId'>;
  /** The Factories: each session's Codex default and agent language, read per run; `getById` serves the Factory chat. */
  projects?: Pick<FactoryProjectsStorage, 'get'> & Partial<Pick<FactoryProjectsStorage, 'getById'>>;
  /** Where Factory chats on Codex get their private empty working folders; `<storeDir>-supervisor` by default. */
  supervisorWorkdirRoot?: string;
  /** The session's checkout (see `createClaudeCheckoutResolver`). */
  cwdFor: (sessionId: string) => string | Promise<string>;
  /** The Factory MCP endpoint for a factory, and the signer for the session tokens it accepts. */
  mcp?: { url: (factoryProjectId: string) => string; tokens: Pick<FactorySessionTokenSigner, 'sign'> };
  /** The Factory's tool permissions (Settings → Behavior), read before each turn. */
  permissions?: ClaudeFactoryPermissionsHook;
  /** Whether a session's turns are a card run nobody is watching (see the Claude Code harness's). */
  cardRun?: (session: { orgId: string; factoryProjectId: string; sessionId: string }) => boolean | Promise<boolean>;
  phaseFor?: (session: SessionCoordinates) => Promise<string | undefined>;
  workItemFor?: (session: SessionCoordinates) => Promise<string | undefined>;
  sessionsFor?: (session: SessionCoordinates & { userId: string }) => Promise<string | undefined>;
  /** The CLI binary; `codex` on PATH by default. */
  command?: string;
  /** Extra `codex` launch arguments; `FACTORY_CODEX_LAUNCH_ARGS` wins. */
  launchArgs?: string;
  /**
   * The members' ChatGPT sign-ins every run signs in with (`createCodexCredentials`); without it a
   * run fails asking for one. This host's own `codex login` is never used.
   */
  credentials?: CodexCredentials;
  /**
   * Where sessions' own `CODEX_HOME`s live (their thread history, no login); `<storeDir>-home` by
   * default. Each session gets its own dir, removed with the session.
   */
  sessionHomeRoot?: string;
  env?: Record<string, string | undefined>;
  spawn?: CodexSpawn;
  /** Factory skills; the bundled ones plus the project's local `factory-skills` by default. */
  skillsDir?: string | string[];
  turnTimeoutMs?: number;
  /** Replaces the CLI probe behind the model facet (tests). */
  catalog?: CodexCatalogSource;
  /** Every session object the harness builds, before anyone drives it (chat UI, run audit, reports). */
  onSession?: (session: CodexSession) => void;
}

export interface CodexFactoryHarness {
  harness: CodexHarness;
  store: CodexSessionStore;
  /** Remove a deleted session's own `CODEX_HOME` (its thread history); a missing dir is fine. */
  removeSessionHome(sessionId: string): Promise<void>;
  /** For the routing harness: a session is Codex's when its store has it. */
  route: HarnessRoute;
  models: CodexHarnessModels<CodexSession>;
  /** A session by id, the Factory chat's (`factory-supervisor:<factory>`) created when a Codex Factory's chat first reaches it. */
  resolveSession(sessionId: string): Promise<CodexSession | undefined>;
  /** The CLI's catalog, probed and cached; also what says whether Codex is available. */
  catalog: CodexCatalogSource;
}

/**
 * The Codex harness as a Factory runs it: sessions recorded in their own store, checked out per
 * session, given the Factory's tools over MCP with a token minted for the run, the Factory's
 * signals ahead of each turn, and its tool permissions as Codex's sandbox and approval policy.
 * Each session runs in its own `CODEX_HOME` and signs in with its owner's ChatGPT sign-in (the
 * access token alone, from `credentials`), never with a `codex login` on this host.
 */
export function createCodexFactoryHarness(options: CodexFactoryHarnessOptions): CodexFactoryHarness {
  const store = options.store ?? (options.storeDir ? createJsonFileCodexSessionStore(options.storeDir) : undefined);
  if (!store) throw new Error('The Codex harness needs a session store or a store directory.');
  const env = options.env ?? process.env;

  // Every session gets its own home: never the person's `~/.codex`, and nothing of a login in it.
  const homeRoot = options.sessionHomeRoot ?? (options.storeDir ? `${options.storeDir.replace(/\/+$/, '')}-home` : undefined);
  if (!homeRoot) throw new Error('The Codex harness needs a store directory or a session home root for its homes.');
  const homes = createSessionDirs(homeRoot);
  // The catalog probe runs in an empty home of its own: the CLI lists its models without a login.
  const probeHome = join(homeRoot, '.catalog-probe');

  /**
   * Who a session's run runs for, as a Claude Code session's turn: a session with a row runs as its
   * row; the Factory chat (supervisor) has none: it belongs to its Factory and runs as the person
   * whose message or answer started the run, or the Factory's creator before anyone did.
   */
  const tenantOf = async (session: CodexSession) => {
    const supervisorProjectId = claudeSupervisorProjectId(session.id);
    if (supervisorProjectId) {
      const project = await options.projects?.getById?.({ id: supervisorProjectId });
      if (!project) throw new Error(`The Factory of supervisor session ${session.id} was not found.`);
      const actor = await session.thread.getSetting({ key: CLAUDE_THREAD_SETTINGS.actorUserId });
      return {
        orgId: project.orgId,
        factoryProjectId: project.id,
        userId: typeof actor === 'string' && actor ? actor : project.createdBy,
        supervisor: true as const,
        originSessionId: null,
      };
    }
    const row = await options.sessions.getBySessionId(session.id);
    if (!row?.factoryProjectId) throw new Error(`Codex session ${session.id} has no Factory session row.`);
    return {
      orgId: row.orgId,
      factoryProjectId: row.factoryProjectId,
      userId: row.userId,
      supervisor: false as const,
      originSessionId: row.originSessionId ?? null,
    };
  };
  const coordinates = async (session: CodexSession): Promise<SessionCoordinates & { userId: string }> => {
    const tenant = await tenantOf(session);
    return {
      orgId: tenant.orgId,
      factoryProjectId: tenant.factoryProjectId,
      userId: tenant.userId,
      sessionId: session.id,
      threadId: session.thread.requireId(),
      resourceId: session.resourceId ?? tenant.factoryProjectId,
    };
  };
  const projectOf = async (session: CodexSession) => {
    if (!options.projects) return null;
    const tenant = await tenantOf(session);
    return options.projects.get({ orgId: tenant.orgId, id: tenant.factoryProjectId });
  };
  const isCardRun = async (session: CodexSession) => {
    const tenant = await tenantOf(session);
    if (tenant.supervisor) return false;
    if (tenant.originSessionId) return true;
    if (await session.thread.getSetting({ key: CLAUDE_THREAD_SETTINGS.workItemId })) return true;
    return (await options.cardRun?.({ orgId: tenant.orgId, factoryProjectId: tenant.factoryProjectId, sessionId: session.id })) === true;
  };

  const supervisorWorkdir = createClaudeSupervisorWorkdir(
    options.supervisorWorkdirRoot ??
      (options.storeDir ? `${options.storeDir.replace(/\/+$/, '')}-supervisor` : join(homeRoot, '.supervisor')),
  );
  // The Factory chat of a Codex Factory is a Codex session too, as a Claude Code Factory's is a Claude one.
  const projects = options.projects;
  const supervisors = projects?.getById
    ? createTurnSupervisorSessions<CodexSession>({
        harnessId: 'codex',
        harness: { getSession: id => harness.getSession(id), createSession: input => harness.createSession(input) },
        projects: { getById: args => projects.getById!(args) },
      })
    : undefined;
  const resolveSession = (sessionId: string) => (supervisors ? supervisors.resolve(sessionId) : harness.getSession(sessionId));
  const owns = async (sessionId: string) =>
    (await store.get(sessionId)) !== undefined ||
    (claudeSupervisorProjectId(sessionId) !== null && (await supervisors?.resolve(sessionId)) !== undefined);

  const catalog =
    options.catalog ??
    createCodexCatalogSource({
      installed: () => findCodexBinary(options.command ?? 'codex', env) !== undefined,
      probeInput: () => {
        mkdirSync(probeHome, { recursive: true, mode: 0o700 });
        return {
          ...(options.command ? { command: options.command } : {}),
          args: codexAppServerArgs(resolveCodexLaunchArgs(options.launchArgs, env)),
          cwd: probeHome,
          env: { ...env, CODEX_HOME: probeHome },
          ...(options.spawn ? { spawn: options.spawn } : {}),
        };
      },
    });

  const models = createCodexHarnessModels<CodexSession>({
    owns,
    getSession: resolveSession,
    defaults: async session => codexModelDefaults(await projectOf(session)),
    ...(options.projects
      ? {
          factoryDefaults: async ctx =>
            ctx.factoryProjectId ? codexModelDefaults(await options.projects!.get({ orgId: ctx.viewer.orgId, id: ctx.factoryProjectId })) : null,
        }
      : {}),
    settingKeys: { selection: CLAUDE_THREAD_SETTINGS.modelSelection, lastSelection: CLAUDE_THREAD_SETTINGS.lastModelSelection },
    catalog,
    // Codex runs for a person only on a ChatGPT sign-in they may use, as Claude Code runs on a Claude one.
    accounts: async ctx => {
      if (!options.credentials) return CODEX_NEEDS_ACCOUNT_REASON;
      return (await options.credentials.usable({ orgId: ctx.viewer.orgId, userId: ctx.viewer.userId })) ? undefined : CODEX_NEEDS_ACCOUNT_REASON;
    },
  });

  const harness = createCodexHarness({
    models,
    store,
    // The Factory chat has no repository: a private empty folder instead of a checkout.
    cwdFor: async sessionId => {
      const supervisorProjectId = claudeSupervisorProjectId(sessionId);
      return supervisorProjectId ? supervisorWorkdir(supervisorProjectId) : options.cwdFor(sessionId);
    },
    env,
    ...(options.command ? { command: options.command } : {}),
    ...(options.launchArgs ? { launchArgs: options.launchArgs } : {}),
    codexHomeFor: session => homes.dirFor(session),
    // Asked when a run opens its process: the run owner's ChatGPT sign-in, its access token alone.
    credentials: async (session, request) => {
      if (!options.credentials) throw new CodexError('auth', CODEX_NEEDS_ACCOUNT_REASON);
      const tenant = await tenantOf(session);
      return options.credentials.credentials({ orgId: tenant.orgId, userId: tenant.userId }, request);
    },
    refreshCredentials: async (session, input) => {
      const tenant = await tenantOf(session);
      return options.credentials?.refresh({ orgId: tenant.orgId, userId: tenant.userId }, input);
    },
    onCredentialFailure: async (session, failure) => {
      const tenant = await tenantOf(session);
      await options.credentials?.onCredentialFailure({ orgId: tenant.orgId, userId: tenant.userId }, failure);
    },
    ...(options.spawn ? { spawn: options.spawn } : {}),
    ...(options.turnTimeoutMs ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
    skillsDir: claudeFactorySkillDirectories(options.skillsDir),
    planningPrompt: CODEX_FACTORY_PLANNING_PROMPT,
    // A pull or merge request checkout reads no repository config: no AGENTS.md, an untrusted project (the shared rule).
    threadConfigFor: async session => ((await isUntrustedCheckout(session.thread)) ? codexUntrustedCheckoutConfig(session.cwd) : undefined),
    // Read per turn, so a model, effort or tier changed in Settings or for the session applies from its next turn.
    turnSelectionFor: session => models.turnSelection(session),
    developerInstructionsFor: async session => {
      const target = await session.thread.getSetting({ key: CLAUDE_THREAD_SETTINGS.targetInstruction });
      const base = claudeSupervisorProjectId(session.id)
        ? CODEX_SUPERVISOR_INSTRUCTIONS
        : typeof target === 'string' && target
          ? `${CODEX_FACTORY_INSTRUCTIONS}\n\n${target}`
          : CODEX_FACTORY_INSTRUCTIONS;
      if (!options.projects) return base;
      const tenant = await tenantOf(session);
      // The Factory's agent language closes every session's instructions.
      return withAgentLanguage(base, tenant.factoryProjectId, await projectOf(session));
    },
    ...(options.mcp
      ? {
          mcpServersFor: async (session: CodexSession) => {
            const tenant = await tenantOf(session);
            const mcp = options.mcp!;
            // A run a signed-in person started is interactive, as a Mastra turn over HTTP; the mark is taken by that run.
            const interactive = (await session.thread.getSetting({ key: CLAUDE_THREAD_SETTINGS.personTurn })) === true;
            if (interactive) await session.thread.setSetting({ key: CLAUDE_THREAD_SETTINGS.personTurn, value: false });
            // The Factory chat's token is a supervisor token: its tools, acting as the person behind the run.
            const token = mcp.tokens.sign(
              {
                orgId: tenant.orgId,
                factoryProjectId: tenant.factoryProjectId,
                sessionId: session.id,
                threadId: session.thread.requireId(),
                resourceId: session.resourceId ?? (tenant.supervisor ? session.id : tenant.factoryProjectId),
                ...(tenant.supervisor ? { scope: 'supervisor' as const, userId: tenant.userId } : {}),
                ...(interactive ? { interactive: true } : {}),
              },
              { ttlMs: CODEX_SESSION_TOKEN_TTL_MS },
            );
            return {
              [CODEX_FACTORY_MCP_SERVER]: {
                url: mcp.url(tenant.factoryProjectId),
                http_headers: { [FACTORY_SESSION_TOKEN_HEADER]: token },
                // The Factory chat's repairs ask a person on every call, as on Claude Code.
                ...(tenant.supervisor ? { tools: CODEX_SUPERVISOR_PROMPTED_TOOLS } : {}),
              },
            };
          },
        }
      : {}),
    policyFor: async session => {
      const tenant = await tenantOf(session);
      const permissions = (await options.permissions?.({ orgId: tenant.orgId, factoryProjectId: tenant.factoryProjectId })) ?? undefined;
      // The Factory chat asks before every repair (unless the Factory auto-approves), as on Claude Code.
      if (tenant.supervisor) {
        const policy = codexPolicyFromPermissions(permissions);
        return permissions?.yolo ? policy : { ...policy, askEachTime: [...CODEX_SUPERVISOR_ASK_TOOLS] };
      }
      // A card run reads freely; where the settings say to ask, it waits on the board and in the inbox for a person.
      const cardRun = await isCardRun(session);
      return codexPolicyFromPermissions(cardRun ? { ...permissions, unattended: true, parkAsks: true } : permissions);
    },
    // What a Mastra session's signals say: its repositories and, for a card run, the bound work item.
    turnContextFor: async session => {
      const environment = peekSessionEnvironment(session.id);
      const signals = environment ? [`<factory-environment>\n${renderSessionEnvironment(environment)}\n</factory-environment>`] : [];
      if (!session.thread.getId() || claudeSupervisorProjectId(session.id)) return signals.join('\n') || undefined;
      const where = await coordinates(session);
      const sessions = await options.sessionsFor?.(where);
      if (sessions) signals.push(`<factory-sessions>\n${sessions}\n</factory-sessions>`);
      const phase = await options.phaseFor?.(where);
      if (phase) signals.push(`<factory-phase>\n${phase}\n</factory-phase>`);
      const workItem = await options.workItemFor?.(where);
      if (workItem) signals.push(`<factory-work-item>\n${workItem}\n</factory-work-item>`);
      return signals.length > 0 ? signals.join('\n') : undefined;
    },
    ...(options.onSession ? { onSession: options.onSession } : {}),
  });

  return {
    harness,
    store,
    removeSessionHome: sessionId => homes.remove(sessionId),
    models,
    resolveSession,
    catalog,
    route: { harness, owns: async sessionId => (await store.get(sessionId)) !== undefined },
  };
}
