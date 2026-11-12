import {
  createClaudeCodeHarness,
  createJsonFileSessionStore,
  PLANNING_DISALLOWED_TOOLS,
  SUBMIT_PLAN_TOOL_ID,
} from '@factory/harness-claude-code';
import type {
  ClaudeCodeHarness,
  ClaudeCodeHarnessModels,
  ClaudeCodeSession,
  ClaudeCredentialFailure,
  ClaudePermissionMode,
  ClaudeSessionStore,
  ClaudeSpawn,
  ClaudeToolPermissions,
} from '@factory/harness-claude-code';
import type { HarnessRoute, TurnHandoffHook } from '@factory/harness';
import type { HarnessCommand } from '@factory/harness/executable';
import { BUNDLED_FACTORY_SKILLS_PATH, resolveLocalFactorySkillsPath } from '@factory/harness-mastra';
import { FACTORY_SESSION_TOKEN_HEADER, FACTORY_TOOL_ANNOTATIONS } from '@factory/mcp';
import { peekSessionEnvironment, renderSessionEnvironment } from '@factory/sandbox';
import type { FactorySessionTokenSigner } from '@factory/mcp';
import type { SourceControlSessionLookup } from '@factory/session';
import type { FactoryProjectsStorage } from '@factory/store';

import { withAgentLanguage } from '../agent-language.ts';
import { isUntrustedCheckout } from '../turn-harness.ts';
import { createClaudeSessionConfigDirs } from './config-dir.ts';
import type { ClaudeCodeCredentialFailureHook, ClaudeCodeCredentialsHook } from './credentials.ts';
import { CLAUDE_THREAD_SETTINGS } from './start-coordinator.ts';
import { claudeFactoryHarnessModels, type ClaudeModelDefaults } from './model-selection.ts';
import { createClaudeSupervisorSessions } from './supervisor.ts';
import {
  CLAUDE_SUPERVISOR_ASK_TOOLS,
  CLAUDE_SUPERVISOR_SYSTEM_PROMPT,
  claudeSupervisorProjectId,
  createClaudeSupervisorWorkdir,
} from './supervisor.ts';

/**
 * Where a Claude Code session's Factory skills live: the configured
 * directories, or the project's local `factory-skills` (first, so a project
 * can override a bundled skill) and the bundled ones. The kickoff reads a
 * skill's SKILL.md from here, and `skill_read` its references.
 */
export function claudeFactorySkillDirectories(configured?: string | string[]): string[] {
  if (configured !== undefined) return [configured].flat();
  // The dev server bundle ships no copy of its own.
  return [...[resolveLocalFactorySkillsPath()].filter((dir): dir is string => Boolean(dir)), BUNDLED_FACTORY_SKILLS_PATH];
}

/** The MCP server name the Factory's tools are mounted under: Claude sees them as `mcp__factory__<tool>`. */
export const CLAUDE_FACTORY_MCP_SERVER = 'factory';

/**
 * What a Factory session may always use: the Factory's own tools and the task
 * list, which are the harness's plumbing. Everything else follows the
 * Factory's tool permissions (`permissions`), read before each turn; a call
 * they say to ask about parks the run until a person allows or denies it.
 * Hosts widen this per deployment; the Factory's `deny` still wins.
 */
export const DEFAULT_CLAUDE_FACTORY_ALLOWED_TOOLS = ['TodoWrite', `mcp__${CLAUDE_FACTORY_MCP_SERVER}`];

/** The Factory's tool permissions, for the Factory a Claude session belongs to. */
export type ClaudeFactoryPermissionsHook = (tenant: {
  orgId: string;
  factoryProjectId: string;
}) => ClaudeToolPermissions | undefined | Promise<ClaudeToolPermissions | undefined>;

/** Factory tools that change something: every annotated write, and the bound-run and session tools that are not annotated. */
export const CLAUDE_FACTORY_MUTATING_TOOLS = [
  ...new Set([
    ...Object.entries(FACTORY_TOOL_ANNOTATIONS).flatMap(([id, annotations]) => (annotations.readOnlyHint ? [] : [id])),
    'factory_transition_work_item',
    'factory_record_review_verdict',
    'factory_switch_session_model',
    'factory_subscribe_session',
    'factory_unsubscribe_session',
  ]),
];

/**
 * What a planning turn may not use. Planning is read-only by permission, not
 * by request: no file edits, no shell (an allowed `git` or `gh` reaches any
 * command through aliases and `gh api`), and no Factory tool that changes
 * anything; the plan gate is how it ends.
 */
export const CLAUDE_FACTORY_PLANNING_DISALLOWED_TOOLS = [
  ...PLANNING_DISALLOWED_TOOLS,
  'Bash',
  ...CLAUDE_FACTORY_MUTATING_TOOLS.map(id => `mcp__${CLAUDE_FACTORY_MCP_SERVER}__${id}`),
];

/**
 * Appended to every turn's system prompt (it must not change between turns).
 * The skills name the Factory's tools bare, as a Mastra run calls them.
 */
export const CLAUDE_FACTORY_SYSTEM_PROMPT = [
  'You are an agent session of a Factory: a work item on a board is bound to this session, and Factory skills tell you what to do with it.',
  `The Factory's tools are on the \`${CLAUDE_FACTORY_MCP_SERVER}\` MCP server (\`mcp__${CLAUDE_FACTORY_MCP_SERVER}__<tool>\`); instructions name them without that prefix.`,
  `Each turn opens with the Factory's signals: \`<factory-environment>\` (the repositories in your working directory) and, on a card run, \`<factory-phase>\` (stage, revision, role) and \`<factory-work-item>\` (the card, its sources and Factory state). Mid-turn, \`mcp__${CLAUDE_FACTORY_MCP_SERVER}__factory_bound_work_item\` reads the current stage and revision.`,
  `Your environment holds no source-control credentials: reach the provider only through the \`mcp__${CLAUDE_FACTORY_MCP_SERVER}__source_control_*\` tools (push, change requests, reviews, issues, \`source_control_api_read\` for other reads), never \`git push\`, \`gh\`, \`glab\` or direct API calls.`,
].join(' ');

/**
 * Leads a planning turn. The Factory's plan skills end with a card move; in a
 * Claude Code session the plan gate is the end instead, and the card moves when
 * a person approves.
 */
export const CLAUDE_FACTORY_PLANNING_PROMPT =
  '<factory-mode name="planning">\nYou are planning. Investigate read-only; file edits are disabled for this turn. ' +
  `Follow the planning instructions below, but end differently: do not call factory_transition_work_item; when the plan is complete, call \`${SUBMIT_PLAN_TOOL_ID}\` with the full plan (and a short title), then stop. ` +
  'A person approves the plan, which moves the work item on and resumes this session.\n</factory-mode>';

export interface ClaudeFactoryHarnessOptions {
  /**
   * Context a turn carries over from another conversation: a handoff a move from another harness left
   * pending, or the thread's history when the native conversation could not be resumed.
   */
  handoffContextFor?: TurnHandoffHook<ClaudeCodeSession>;
  /** Where Claude Code sessions are recorded; required unless `store` is given. */
  storeDir?: string;
  store?: ClaudeSessionStore;
  sessions: Pick<SourceControlSessionLookup, 'getBySessionId'>;
  /**
   * The Factories, read before each turn for the session's Claude Code default
   * (`harnessModelDefaults['claude-code']`: `--model`, `--effort`, `--settings`), unless
   * the session picked its own. Unset, or a Factory without one, leaves the CLI's own defaults.
   */
  projects?: Pick<FactoryProjectsStorage, 'get'> & Partial<Pick<FactoryProjectsStorage, 'getById'>>;
  credentials: ClaudeCodeCredentialsHook;
  /**
   * Whether a session's turns are a card run nobody is watching (the
   * dispatcher or a start coordinator drives them), beyond what the session
   * itself shows (a work item recorded on its thread, or a session another
   * session started). Such turns read without asking and are refused, not
   * parked, where the settings say to ask. Personal chats and the Factory chat
   * keep asking.
   */
  cardRun?: (session: { orgId: string; factoryProjectId: string; sessionId: string }) => boolean | Promise<boolean>;
  /**
   * The `factory-phase` signal a bound Mastra run sees (`describeFactoryPhase`),
   * for the work item this session's thread is bound to; `undefined` when none is.
   */
  /**
   * Built-in tools a card run may use without asking, beyond the Factory's
   * settings, for the work item its thread is bound to: read-only `WebFetch`
   * and `WebSearch` for a Product card, whose Brief reads providers' pricing
   * pages. A denied category still wins.
   */
  allowToolsFor?: (session: {
    orgId: string;
    factoryProjectId: string;
    sessionId: string;
    threadId: string;
    resourceId: string;
  }) => Promise<string[] | undefined>;
  /**
   * The session's external MCP tools that wait for a person (Settings › MCP-сервери, «з підтвердженням»),
   * by their Factory tool names; they reach the CLI through the Factory MCP endpoint and are asked about each time.
   */
  mcpAskToolsFor?: (session: { orgId: string; factoryProjectId: string; sessionId: string }) => Promise<string[]>;
  phaseFor?: (session: {
    orgId: string;
    factoryProjectId: string;
    sessionId: string;
    threadId: string;
    resourceId: string;
  }) => Promise<string | undefined>;
  /**
   * The `factory-work-item` signal a bound Mastra run sees (`describeFactoryWorkItem`): the card its
   * thread works, its sources and Factory state; `undefined` when the thread is bound to none.
   */
  workItemFor?: (session: {
    orgId: string;
    factoryProjectId: string;
    sessionId: string;
    threadId: string;
    resourceId: string;
  }) => Promise<string | undefined>;
  /**
   * The `factory-sessions` signal a Mastra run sees (`FactorySessionsStateProcessor`): the side sessions
   * it started and the work items it follows, or who it reports to; `undefined` when there is nothing to show.
   */
  sessionsFor?: (session: {
    orgId: string;
    factoryProjectId: string;
    userId: string;
    sessionId: string;
    threadId: string;
    resourceId: string;
  }) => Promise<string | undefined>;
  /**
   * Where the Factory chats (supervisor sessions) on Claude Code get their
   * private empty working folders; `<storeDir>-supervisor`, or one under the
   * OS temp dir, by default.
   */
  supervisorWorkdirRoot?: string;
  /**
   * The Factory's tool permissions (Settings → Behavior), read before each
   * turn. Unset, or `undefined` for a Factory, every category asks.
   */
  permissions?: ClaudeFactoryPermissionsHook;
  /** Told when a turn's account ran out of usage or was refused, so the pool sets it aside. */
  onCredentialFailure?: ClaudeCodeCredentialFailureHook;
  /** The session's checkout (see `createClaudeCheckoutResolver`). */
  cwdFor: (sessionId: string) => string | Promise<string>;
  /** The Factory MCP endpoint for a factory, and the signer for the session tokens it accepts. */
  mcp?: { url: (factoryProjectId: string) => string; tokens: Pick<FactorySessionTokenSigner, 'sign'> };
  /**
   * `CLAUDE_CONFIG_DIR` per session. Unset: each session gets its own dir
   * under {@link sessionConfigRoot} (see `createClaudeSessionConfigDirs`).
   * Never the person's `~/.claude`: without either, the harness refuses to start.
   */
  configDir?: (session: ClaudeCodeSession) => string;
  /** Where sessions' own config dirs live; `<storeDir>-config` by default. */
  sessionConfigRoot?: string;
  allowedTools?: string[];
  approvedPermissionMode?: ClaudePermissionMode;
  turnTimeoutMs?: number;
  /** Factory skills; the bundled ones plus the project's local `factory-skills` by default. */
  skillsDir?: string | string[];
  /** The CLI: a path, or the server's resolver (`harnessExecutableFor`); `claude` on PATH by default. */
  command?: HarnessCommand;
  spawn?: ClaudeSpawn;
  env?: Record<string, string | undefined>;
  /** Every session object the harness builds, before anyone drives it (chat UI, run audit, reports). */
  onSession?: (session: ClaudeCodeSession) => void;
  /**
   * Whether a run that stopped because every account is out of usage parks the session until the
   * limit resets, for the host's resume scheduler (`createUsageLimitResumer`). Unset, it fails.
   */
  parkOnUsageLimit?: (session: ClaudeCodeSession) => boolean | Promise<boolean>;
}

export interface ClaudeFactoryHarness {
  harness: ClaudeCodeHarness;
  store: ClaudeSessionStore;
  /** Remove a deleted session's own config dir (its transcripts and memory); a no-op without one. */
  removeSessionConfig(sessionId: string): Promise<void>;
  /** For the routing harness: a session is Claude's when its store has it. */
  route: HarnessRoute;
  /**
   * The harness's model facet (also `harness.models`), which the server registers in its
   * `HarnessModelRegistry`; absent without the Factories.
   */
  models?: ClaudeCodeHarnessModels<ClaudeCodeSession>;
  /** The Factory model and thinking level a session's turns default to; null without the Factories. */
  modelDefaults(session: ClaudeCodeSession): Promise<ClaudeModelDefaults>;
}

/**
 * The Claude Code harness as a Factory runs it: sessions recorded in their own
 * store, checked out per session, authenticated per turn by the credentials
 * hook, given the Factory's tools over MCP with a token minted for that turn,
 * and the Factory skills read from the bundled skills directory (the kickoff
 * carries a skill's instructions, so nothing is copied into the checkout).
 */
export function createClaudeFactoryHarness(options: ClaudeFactoryHarnessOptions): ClaudeFactoryHarness {
  const store = options.store ?? (options.storeDir ? createJsonFileSessionStore(options.storeDir) : undefined);
  if (!store) throw new Error('The Claude Code harness needs a session store or a store directory.');

  const sourceSession = async (sessionId: string) => {
    const row = await options.sessions.getBySessionId(sessionId);
    if (!row?.factoryProjectId) throw new Error(`Claude Code session ${sessionId} has no Factory session row.`);
    return { ...row, factoryProjectId: row.factoryProjectId };
  };

  /** A session's own playbook: the card's repository, or every workspace repository, follows it (the skills read it there). */
  const factorySessionPrompt = async (session: ClaudeCodeSession) => {
    const target = await session.thread.getSetting({ key: CLAUDE_THREAD_SETTINGS.targetInstruction });
    return typeof target === 'string' && target
      ? `${CLAUDE_FACTORY_SYSTEM_PROMPT}\n\n${target}`
      : CLAUDE_FACTORY_SYSTEM_PROMPT;
  };

  /**
   * Who a session's turn runs for. A session with a row runs as its row; the
   * Factory chat (supervisor) has none: it belongs to its Factory and runs as
   * the person whose message or answer started the turn (recorded on its
   * thread by the chat), or the Factory's creator before anyone did.
   */
  const tenantOf = async (session: ClaudeCodeSession) => {
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
    const row = await sourceSession(session.id);
    return {
      orgId: row.orgId,
      factoryProjectId: row.factoryProjectId,
      userId: row.userId,
      supervisor: false as const,
      originSessionId: row.originSessionId ?? null,
    };
  };

  const modelDefaults = async (session: ClaudeCodeSession): Promise<ClaudeModelDefaults> => {
    if (!options.projects) return null;
    const tenant = await tenantOf(session);
    return options.projects.get({ orgId: tenant.orgId, id: tenant.factoryProjectId });
  };

  const isCardRun = async (session: ClaudeCodeSession, tenant: Awaited<ReturnType<typeof tenantOf>>) => {
    if (tenant.supervisor) return false;
    if (tenant.originSessionId) return true;
    if (await session.thread.getSetting({ key: CLAUDE_THREAD_SETTINGS.workItemId })) return true;
    return (
      (await options.cardRun?.({ orgId: tenant.orgId, factoryProjectId: tenant.factoryProjectId, sessionId: session.id })) ===
      true
    );
  };

  // Every session gets its own config dir: never the person's `~/.claude`.
  const configRoot =
    options.sessionConfigRoot ?? (options.storeDir ? `${options.storeDir.replace(/\/+$/, '')}-config` : undefined);
  if (!configRoot && !options.configDir) {
    throw new Error('The Claude Code harness needs a store directory or a session config root for its config dirs.');
  }
  const configDirs = configRoot ? createClaudeSessionConfigDirs(configRoot) : undefined;
  const configDir = options.configDir ?? ((session: ClaudeCodeSession) => configDirs!.dirFor(session));

  const supervisorWorkdir = createClaudeSupervisorWorkdir(
    options.supervisorWorkdirRoot ?? (options.storeDir ? `${options.storeDir.replace(/\/+$/, '')}-supervisor` : undefined),
  );

  // A session's model, checked against the Claude catalog; a Factory chat's session is created when first reached.
  const projects = options.projects;
  const supervisors = projects?.getById
    ? createClaudeSupervisorSessions({ harness: { getSession: id => harness.getSession(id), createSession: input => harness.createSession(input) }, projects: { getById: args => projects.getById!(args) } })
    : undefined;
  const models = projects
    ? claudeFactoryHarnessModels({
        owns: async sessionId =>
          (await store.get(sessionId)) !== undefined ||
          (claudeSupervisorProjectId(sessionId) !== null && (await supervisors?.resolve(sessionId)) !== undefined),
        getSession: sessionId => (supervisors ? supervisors.resolve(sessionId) : harness.getSession(sessionId)),
        defaultsFor: modelDefaults,
        factoryDefaults: (id, orgId) => projects.get({ orgId, id }),
      })
    : undefined;
  const harness = createClaudeCodeHarness({
    ...(models ? { models } : {}),
    store,
    // Stream text and thinking as they are written (`text_delta`/`thinking_delta`), not one block at the end.
    includePartialMessages: true,
    // The Factory chat has no repository: a private empty folder instead of a checkout.
    cwdFor: async sessionId => {
      const supervisorProjectId = claudeSupervisorProjectId(sessionId);
      return supervisorProjectId ? supervisorWorkdir(supervisorProjectId) : options.cwdFor(sessionId);
    },
    credentials: async (session, request) => {
      const tenant = await tenantOf(session);
      return options.credentials({ orgId: tenant.orgId, userId: tenant.userId }, request);
    },
    ...(options.onCredentialFailure
      ? {
          onCredentialFailure: async (session: ClaudeCodeSession, failure: ClaudeCredentialFailure) => {
            const tenant = await tenantOf(session);
            await options.onCredentialFailure!({ orgId: tenant.orgId, userId: tenant.userId }, failure);
          },
        }
      : {}),
    ...(options.mcp
      ? {
          mcpConfig: async (session: ClaudeCodeSession) => {
            const tenant = await tenantOf(session);
            const mcp = options.mcp!;
            // Minted per turn and only for this session's own coordinates; it expires on its own.
            // A turn a signed-in person started (their message or answer) is interactive, as a Mastra turn over HTTP;
            // the mark is taken by the turn that carries it.
            const interactive = (await session.thread.getSetting({ key: CLAUDE_THREAD_SETTINGS.personTurn })) === true;
            if (interactive) await session.thread.setSetting({ key: CLAUDE_THREAD_SETTINGS.personTurn, value: false });
            // The Factory chat's token is a supervisor token: its tools, acting as the person behind the turn.
            const token = mcp.tokens.sign({
              orgId: tenant.orgId,
              factoryProjectId: tenant.factoryProjectId,
              sessionId: session.id,
              threadId: session.thread.requireId(),
              resourceId: session.resourceId ?? (tenant.supervisor ? session.id : tenant.factoryProjectId),
              ...(tenant.supervisor ? { scope: 'supervisor' as const, userId: tenant.userId } : {}),
              ...(interactive ? { interactive: true } : {}),
            });
            return {
              mcpServers: {
                [CLAUDE_FACTORY_MCP_SERVER]: {
                  type: 'http',
                  url: mcp.url(tenant.factoryProjectId),
                  headers: { [FACTORY_SESSION_TOKEN_HEADER]: token },
                },
              },
            };
          },
        }
      : {}),
    ...(options.projects
      ? {
          // Read per turn, so a model or effort changed in settings or for the session applies from its next turn.
          turnSelectionFor: async (session: ClaudeCodeSession) => models!.turnSelection(session),
        }
      : {}),
    // Read per turn: the settings change between turns, and reset when the server restarts.
    // A card run reads freely; where the settings say to ask, it waits on the board and in the inbox
    // for a person, as a chat does. The Factory chat asks before every repair.
    permissions: async (session: ClaudeCodeSession) => {
      const tenant = await tenantOf(session);
      const settings =
        (await options.permissions?.({ orgId: tenant.orgId, factoryProjectId: tenant.factoryProjectId })) ?? {};
      if (tenant.supervisor) return { ...settings, askEachTime: [...CLAUDE_SUPERVISOR_ASK_TOOLS] };
      // An external MCP tool set to «ask» waits for a person every time, as the Factory chat's repairs do.
      const mcpAsk = options.mcpAskToolsFor
        ? (await options.mcpAskToolsFor({ orgId: tenant.orgId, factoryProjectId: tenant.factoryProjectId, sessionId: session.id })).map(
            tool => `mcp__${CLAUDE_FACTORY_MCP_SERVER}__${tool}`,
          )
        : [];
      const permissions = mcpAsk.length
        ? { ...settings, askEachTime: [...new Set([...(settings.askEachTime ?? []), ...mcpAsk])] }
        : settings;
      if (await isCardRun(session, tenant)) {
        const allowTools =
          options.allowToolsFor && session.thread.getId()
            ? await options.allowToolsFor({
                orgId: tenant.orgId,
                factoryProjectId: tenant.factoryProjectId,
                sessionId: session.id,
                threadId: session.thread.requireId(),
                resourceId: session.resourceId ?? tenant.factoryProjectId,
              })
            : undefined;
        return { ...permissions, unattended: true, parkAsks: true, ...(allowTools?.length ? { allowTools } : {}) };
      }
      return permissions;
    },
    // A pull or merge request checkout reads no settings file: its hooks would run on this host (the shared rule).
    settingSourcesFor: async session => ((await isUntrustedCheckout(session.thread)) ? [] : undefined),
    // What a Mastra session's signals say: the repositories its workspace holds, where, on which branch;
    // and, for a card run, the bound work item's phase.
    ...(options.handoffContextFor ? { handoffContextFor: options.handoffContextFor } : {}),
    turnContextFor: async session => {
      const environment = peekSessionEnvironment(session.id);
      const signals = environment
        ? [`<factory-environment>\n${renderSessionEnvironment(environment)}\n</factory-environment>`]
        : [];
      if (options.sessionsFor && !claudeSupervisorProjectId(session.id) && session.thread.getId()) {
        const tenant = await tenantOf(session);
        const sessions = await options.sessionsFor({
          orgId: tenant.orgId,
          factoryProjectId: tenant.factoryProjectId,
          userId: tenant.userId,
          sessionId: session.id,
          threadId: session.thread.requireId(),
          resourceId: session.resourceId ?? tenant.factoryProjectId,
        });
        if (sessions) signals.push(`<factory-sessions>\n${sessions}\n</factory-sessions>`);
      }
      if (options.phaseFor && !claudeSupervisorProjectId(session.id) && session.thread.getId()) {
        const tenant = await tenantOf(session);
        const phase = await options.phaseFor({
          orgId: tenant.orgId,
          factoryProjectId: tenant.factoryProjectId,
          sessionId: session.id,
          threadId: session.thread.requireId(),
          resourceId: session.resourceId ?? tenant.factoryProjectId,
        });
        if (phase) signals.push(`<factory-phase>\n${phase}\n</factory-phase>`);
      }
      if (options.workItemFor && !claudeSupervisorProjectId(session.id) && session.thread.getId()) {
        const tenant = await tenantOf(session);
        const workItem = await options.workItemFor({
          orgId: tenant.orgId,
          factoryProjectId: tenant.factoryProjectId,
          sessionId: session.id,
          threadId: session.thread.requireId(),
          resourceId: session.resourceId ?? tenant.factoryProjectId,
        });
        if (workItem) signals.push(`<factory-work-item>\n${workItem}\n</factory-work-item>`);
      }
      return signals.length > 0 ? signals.join('\n') : undefined;
    },
    appendSystemPromptFor: async session => {
      const base = claudeSupervisorProjectId(session.id)
        ? CLAUDE_SUPERVISOR_SYSTEM_PROMPT
        : await factorySessionPrompt(session);
      if (!options.projects) return base;
      // The Factory's «Мова агентів» closes every session's prompt, the Factory chat's included.
      const tenant = await tenantOf(session);
      const project = await options.projects.get({ orgId: tenant.orgId, id: tenant.factoryProjectId });
      return withAgentLanguage(base, tenant.factoryProjectId, project);
    },
    trustedMcpServers: [CLAUDE_FACTORY_MCP_SERVER],
    configDir,
    allowedTools: options.allowedTools ?? DEFAULT_CLAUDE_FACTORY_ALLOWED_TOOLS,
    appendSystemPrompt: CLAUDE_FACTORY_SYSTEM_PROMPT,
    planningPrompt: CLAUDE_FACTORY_PLANNING_PROMPT,
    planningDisallowedTools: CLAUDE_FACTORY_PLANNING_DISALLOWED_TOOLS,
    approvedPermissionMode: options.approvedPermissionMode ?? 'acceptEdits',
    skillsDir: claudeFactorySkillDirectories(options.skillsDir),
    ...(options.turnTimeoutMs ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
    ...(options.command ? { command: options.command } : {}),
    ...(options.spawn ? { spawn: options.spawn } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.onSession ? { onSession: options.onSession } : {}),
    ...(options.parkOnUsageLimit ? { parkOnUsageLimit: options.parkOnUsageLimit } : {}),
  });

  return {
    harness,
    store,
    ...(models ? { models } : {}),
    modelDefaults,
    removeSessionConfig: async sessionId => {
      await configDirs?.remove(sessionId);
    },
    route: { harness, owns: async sessionId => (await store.get(sessionId)) !== undefined },
  };
}
