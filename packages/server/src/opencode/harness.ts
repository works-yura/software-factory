import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { HarnessRoute, TurnHandoffHook } from '@factory/harness';
import { harnessCommandAvailable, type HarnessCommand } from '@factory/harness/executable';
import type { ModelSelection } from '@factory/harness/models/contracts';
import type { ClaudeToolPermissions } from '@factory/harness-claude-code';
import {
  createJsonFileOpenCodeSessionStore,
  createOpenCodeCatalogSource,
  createOpenCodeHarness,
  createOpenCodeHarnessModels,
  OPENCODE_INSTANCE_ID,
  probeOpenCode,
  type OpenCodeCatalogSource,
  type OpenCodeHarness,
  type OpenCodeHarnessModels,
  type OpenCodeSession,
  type OpenCodeSessionStore,
  type OpenCodeSpawn,
  type OpenCodeTurnPolicy,
} from '@factory/harness-opencode';
import { FACTORY_SESSION_TOKEN_HEADER } from '@factory/mcp';
import type { FactorySessionTokenSigner } from '@factory/mcp';
import { peekSessionEnvironment, renderSessionEnvironment, renderSessionNotes } from '@factory/sandbox';
import type { SourceControlSessionLookup } from '@factory/session';
import type { FactoryProject, FactoryProjectsStorage } from '@factory/store';
import { SUPERVISOR_INSTRUCTIONS } from '@factory/supervisor';

import { withAgentLanguage } from '../agent-language.ts';
import { claudeFactorySkillDirectories, type ClaudeFactoryPermissionsHook } from '../claude/harness.ts';
import { createSessionDirs } from '../claude/config-dir.ts';
import { CLAUDE_SUPERVISOR_WRITE_TOOLS, claudeSupervisorProjectId, createClaudeSupervisorWorkdir, createTurnSupervisorSessions } from '../claude/supervisor.ts';
import { CLAUDE_THREAD_SETTINGS } from '../claude/start-coordinator.ts';
import { isUntrustedCheckout } from '../turn-harness.ts';
import type { OpenCodeAccounts } from './accounts.ts';

/** The MCP server name the Factory's tools are mounted under in an OpenCode session. */
export const OPENCODE_FACTORY_MCP_SERVER = 'factory';

/** A run can take hours; its Factory token outlives it (as Codex's does). */
const OPENCODE_SESSION_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

/** The Factory chat's write tools as the transcript names them: asked about on every call. */
export const OPENCODE_SUPERVISOR_ASK_TOOLS = CLAUDE_SUPERVISOR_WRITE_TOOLS.map(id => `mcp__${OPENCODE_FACTORY_MCP_SERVER}__${id}`);

/**
 * How an OpenCode session asks a person: the skills name the question tool as Claude Code's
 * (`AskUserQuestion`) or Mastra's (`ask_user`); on OpenCode it is `question`, which the chat
 * shows as the same question card (ADR 0006).
 */
export const OPENCODE_QUESTION_TOOL_INSTRUCTIONS =
  'Every question to a person (a gap, a choice, a confirmation, "move on?") goes through your `question` tool, which the Factory shows as a question card; skills call it `AskUserQuestion` or `ask_user`. ' +
  'Ask up to 3 self-contained questions per call, each with 2-3 options, your recommended option first with ` (рекомендовано)` at the end of its label; the person can always answer in their own words. Then wait for the answers. ' +
  'Never leave a question as plain text at the end of a message: the person cannot answer it with a click.';

/** The session's instructions: what a Factory session is, and where its tools are. */
export const OPENCODE_FACTORY_INSTRUCTIONS = [
  'You are an agent session of a Factory: a work item on a board is bound to this session, and Factory skills tell you what to do with it.',
  `The Factory's tools are on the \`${OPENCODE_FACTORY_MCP_SERVER}\` MCP server (OpenCode names them \`${OPENCODE_FACTORY_MCP_SERVER}_<tool>\`); instructions name them without the server prefix.`,
  "Each turn opens with the Factory's signals: `<factory-environment>` (the repositories in your working directory) and, on a card run, `<factory-phase>` (stage, revision, role) and `<factory-work-item>` (the card, its sources and Factory state). Mid-turn, `factory_bound_work_item` reads the current stage and revision.",
  'Your environment holds no source-control credentials: reach the provider only through the `source_control_*` tools (push, change requests, reviews, issues, `source_control_api_read` for other reads), never `git push`, `gh`, `glab` or direct API calls.',
  OPENCODE_QUESTION_TOOL_INSTRUCTIONS,
].join(' ');

/** The Factory chat on OpenCode. */
export const OPENCODE_SUPERVISOR_INSTRUCTIONS = [
  SUPERVISOR_INSTRUCTIONS.trim(),
  '## On OpenCode',
  [
    `The \`factory_*\` tools named above are on the \`${OPENCODE_FACTORY_MCP_SERVER}\` MCP server; instructions name them without the server prefix.`,
    'Your working directory is an empty scratch folder: there is no repository here, so do not look for one.',
    'Each repair asks the person for permission when you call it; call the tool when they want the repair, and if they deny it, say what you would have done instead of trying again.',
  ].join(' '),
].join('\n\n');

/** Leads a planning turn: OpenCode plans with its read-only `plan` agent and the plan gate ends it. */
export const OPENCODE_FACTORY_PLANNING_PROMPT =
  '<factory-mode name="planning">\nYou are planning. Investigate read-only; nothing is changed this turn. ' +
  'Follow the planning instructions below, but end differently: do not call factory_transition_work_item; when the plan is complete, present it in full (with a short title as its heading), then stop. ' +
  'A person approves the plan, which moves the work item on and resumes this session.\n</factory-mode>';

/**
 * The Factory's tool permissions (Settings → Behavior) as OpenCode's rules. Auto-approve is not
 * honoured here: OpenCode runs commands with no sandbox of its own, so edits and commands follow
 * their categories (asking when unset) and leaving the checkout always asks (ADR-0043).
 */
export function openCodePolicyFromPermissions(permissions: ClaudeToolPermissions | undefined): OpenCodeTurnPolicy {
  const unattended = permissions?.unattended ? { unattended: true, ...(permissions.parkAsks ? { parkAsks: true } : {}) } : {};
  const edit = permissions?.categories?.edit ?? 'ask';
  const execute = permissions?.categories?.execute ?? 'ask';
  return { edit, bash: execute, web: 'allow', ...unattended };
}

export type OpenCodeModelDefaults = Pick<FactoryProject, 'harnessModelDefaults'> | null;

/** A Factory's OpenCode default (`harnessModelDefaults.opencode`), as the harness's model facet reads it. */
export function openCodeModelDefaults(project: OpenCodeModelDefaults): ModelSelection | null {
  return project?.harnessModelDefaults?.[OPENCODE_INSTANCE_ID] ?? null;
}

type SessionCoordinates = { orgId: string; factoryProjectId: string; sessionId: string; threadId: string; resourceId: string };

export interface OpenCodeFactoryHarnessOptions {
  handoffContextFor?: TurnHandoffHook<OpenCodeSession>;
  /** Where OpenCode sessions are recorded; required unless `store` is given. */
  storeDir?: string;
  store?: OpenCodeSessionStore;
  sessions: Pick<SourceControlSessionLookup, 'getBySessionId'>;
  projects?: Pick<FactoryProjectsStorage, 'get'> & Partial<Pick<FactoryProjectsStorage, 'getById'>>;
  /** Where Factory chats on OpenCode get their private empty working folders; `<storeDir>-supervisor` by default. */
  supervisorWorkdirRoot?: string;
  /** The session's checkout (see `createClaudeCheckoutResolver`). */
  cwdFor: (sessionId: string) => string | Promise<string>;
  mcp?: { url: (factoryProjectId: string) => string; tokens: Pick<FactorySessionTokenSigner, 'sign'> };
  permissions?: ClaudeFactoryPermissionsHook;
  cardRun?: (session: { orgId: string; factoryProjectId: string; sessionId: string }) => boolean | Promise<boolean>;
  phaseFor?: (session: SessionCoordinates) => Promise<string | undefined>;
  workItemFor?: (session: SessionCoordinates) => Promise<string | undefined>;
  sessionsFor?: (session: SessionCoordinates & { userId: string }) => Promise<string | undefined>;
  /** The CLI: a path, or the server's resolver (`harnessExecutableFor`); `opencode` on PATH by default. */
  command?: HarnessCommand;
  /**
   * Where sessions' own OpenCode state lives (their database, config, state; no login); `<storeDir>-home`
   * by default. Each session gets its own folder, removed with the session.
   */
  sessionHomeRoot?: string;
  env?: Record<string, string | undefined>;
  spawn?: OpenCodeSpawn;
  skillsDir?: string | string[];
  turnTimeoutMs?: number;
  /** Replaces the CLI probe behind the model facet (tests). */
  catalog?: OpenCodeCatalogSource;
  onSession?: (session: OpenCodeSession) => void;
  /**
   * The organization's OpenCode accounts (Settings → Connections → OpenCode): a run signs in with
   * one, and the catalog lists its paid models. Without them every run is on the free models.
   */
  accounts?: OpenCodeAccounts;
  /** Whether a run that hit a limit with a known reset parks until then (a chat session) or fails (a card's run). */
  parkOnUsageLimit?: (session: OpenCodeSession) => boolean | Promise<boolean>;
}

export interface OpenCodeFactoryHarness {
  harness: OpenCodeHarness;
  store: OpenCodeSessionStore;
  /** Removes a deleted session's own OpenCode state; a missing folder is fine. */
  removeSessionHome(sessionId: string): Promise<void>;
  route: HarnessRoute;
  models: OpenCodeHarnessModels<OpenCodeSession>;
  resolveSession(sessionId: string): Promise<OpenCodeSession | undefined>;
  catalog: OpenCodeCatalogSource;
}

/**
 * The OpenCode harness as a Factory runs it: sessions recorded in their own store, checked out per
 * session, given the Factory's tools over MCP with a token minted for the run, the Factory's signals
 * ahead of each turn, and its tool permissions as OpenCode's rules. Each session keeps OpenCode's
 * state in its own folders: never the person's `~/.config/opencode` or `~/.local/share/opencode`.
 * A run signs in with one of the organization's OpenCode accounts when it has any (its key inline);
 * otherwise with nothing, on the free models (ADR-0043).
 */
export function createOpenCodeFactoryHarness(options: OpenCodeFactoryHarnessOptions): OpenCodeFactoryHarness {
  const store = options.store ?? (options.storeDir ? createJsonFileOpenCodeSessionStore(options.storeDir) : undefined);
  if (!store) throw new Error('The OpenCode harness needs a session store or a store directory.');
  const env = options.env ?? process.env;
  const homeRoot = options.sessionHomeRoot ?? (options.storeDir ? `${options.storeDir.replace(/\/+$/, '')}-home` : undefined);
  if (!homeRoot) throw new Error('The OpenCode harness needs a store directory or a session home root for its state.');
  const homes = createSessionDirs(homeRoot);
  // One download cache (the model list, plugins) for every session; their databases stay apart.
  const sharedCacheDir = join(homeRoot, '.cache');

  const tenantOf = async (session: OpenCodeSession) => {
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
    if (!row?.factoryProjectId) throw new Error(`OpenCode session ${session.id} has no Factory session row.`);
    return { orgId: row.orgId, factoryProjectId: row.factoryProjectId, userId: row.userId, supervisor: false as const, originSessionId: row.originSessionId ?? null };
  };
  const coordinates = async (session: OpenCodeSession): Promise<SessionCoordinates & { userId: string }> => {
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
  const projectOf = async (session: OpenCodeSession) => {
    if (!options.projects) return null;
    const tenant = await tenantOf(session);
    return options.projects.get({ orgId: tenant.orgId, id: tenant.factoryProjectId });
  };
  const isCardRun = async (session: OpenCodeSession) => {
    const tenant = await tenantOf(session);
    if (tenant.supervisor) return false;
    if (tenant.originSessionId) return true;
    if (await session.thread.getSetting({ key: CLAUDE_THREAD_SETTINGS.workItemId })) return true;
    return (await options.cardRun?.({ orgId: tenant.orgId, factoryProjectId: tenant.factoryProjectId, sessionId: session.id })) === true;
  };

  const supervisorWorkdir = createClaudeSupervisorWorkdir(
    options.supervisorWorkdirRoot ?? (options.storeDir ? `${options.storeDir.replace(/\/+$/, '')}-supervisor` : join(homeRoot, '.supervisor')),
  );
  const projects = options.projects;
  const supervisors = projects?.getById
    ? createTurnSupervisorSessions<OpenCodeSession>({
        harnessId: 'opencode',
        harness: { getSession: id => harness.getSession(id), createSession: input => harness.createSession(input) },
        projects: { getById: args => projects.getById!(args) },
      })
    : undefined;
  const resolveSession = (sessionId: string) => (supervisors ? supervisors.resolve(sessionId) : harness.getSession(sessionId));
  const owns = async (sessionId: string) =>
    (await store.get(sessionId)) !== undefined || (claudeSupervisorProjectId(sessionId) !== null && (await supervisors?.resolve(sessionId)) !== undefined);

  const catalog =
    options.catalog ??
    createOpenCodeCatalogSource({
      installed: () => harnessCommandAvailable(options.command, 'opencode', env),
      probe: apiKey =>
        probeOpenCode({
          ...(options.command ? { command: options.command } : {}),
          // A signed-in probe gets a folder of its own (named by a digest, never the key).
          root: join(homeRoot, '.catalog-probe', apiKey ? createHash('sha256').update(apiKey).digest('hex').slice(0, 16) : 'free'),
          env,
          sharedCacheDir,
          ...(options.spawn ? { spawn: options.spawn } : {}),
          ...(apiKey ? { apiKey } : {}),
        }),
    });
  const accounts = options.accounts;
  const accountTenant = async (session: OpenCodeSession) => {
    const tenant = await tenantOf(session);
    return { orgId: tenant.orgId, userId: tenant.userId };
  };

  const models = createOpenCodeHarnessModels<OpenCodeSession>({
    owns,
    getSession: resolveSession,
    defaults: async session => openCodeModelDefaults(await projectOf(session)),
    ...(options.projects
      ? {
          factoryDefaults: async ctx =>
            ctx.factoryProjectId ? openCodeModelDefaults(await options.projects!.get({ orgId: ctx.viewer.orgId, id: ctx.factoryProjectId })) : null,
        }
      : {}),
    settingKeys: { selection: CLAUDE_THREAD_SETTINGS.modelSelection, lastSelection: CLAUDE_THREAD_SETTINGS.lastModelSelection },
    catalog,
    ...(accounts ? { accountFor: (orgId: string) => accounts.catalogAccount(orgId) } : {}),
  });

  const harness = createOpenCodeHarness({
    models,
    store,
    cwdFor: async sessionId => {
      const supervisorProjectId = claudeSupervisorProjectId(sessionId);
      return supervisorProjectId ? supervisorWorkdir(supervisorProjectId) : options.cwdFor(sessionId);
    },
    stateRootFor: session => homes.dirFor(session),
    sharedCacheDir,
    env,
    ...(options.command ? { command: options.command } : {}),
    ...(options.spawn ? { spawn: options.spawn } : {}),
    ...(options.turnTimeoutMs ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
    skillsDir: claudeFactorySkillDirectories(options.skillsDir),
    planningPrompt: OPENCODE_FACTORY_PLANNING_PROMPT,
    // A pull or merge request checkout reads no repository config (the shared rule).
    envFor: async session => ((await isUntrustedCheckout(session.thread)) ? { OPENCODE_DISABLE_PROJECT_CONFIG: '1' } : undefined),
    turnSelectionFor: session => models.turnSelection(session),
    developerInstructionsFor: async session => {
      const target = await session.thread.getSetting({ key: CLAUDE_THREAD_SETTINGS.targetInstruction });
      const base = claudeSupervisorProjectId(session.id)
        ? OPENCODE_SUPERVISOR_INSTRUCTIONS
        : typeof target === 'string' && target
          ? `${OPENCODE_FACTORY_INSTRUCTIONS}\n\n${target}`
          : OPENCODE_FACTORY_INSTRUCTIONS;
      if (!options.projects) return base;
      const tenant = await tenantOf(session);
      return withAgentLanguage(base, tenant.factoryProjectId, await projectOf(session));
    },
    ...(options.mcp
      ? {
          mcpServersFor: async (session: OpenCodeSession) => {
            const tenant = await tenantOf(session);
            const mcp = options.mcp!;
            const interactive = (await session.thread.getSetting({ key: CLAUDE_THREAD_SETTINGS.personTurn })) === true;
            if (interactive) await session.thread.setSetting({ key: CLAUDE_THREAD_SETTINGS.personTurn, value: false });
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
              { ttlMs: OPENCODE_SESSION_TOKEN_TTL_MS },
            );
            return { [OPENCODE_FACTORY_MCP_SERVER]: { url: mcp.url(tenant.factoryProjectId), headers: { [FACTORY_SESSION_TOKEN_HEADER]: token } } };
          },
        }
      : {}),
    policyFor: async session => {
      const tenant = await tenantOf(session);
      const permissions = (await options.permissions?.({ orgId: tenant.orgId, factoryProjectId: tenant.factoryProjectId })) ?? undefined;
      // The Factory chat asks before every repair, as on Claude Code and Codex.
      if (tenant.supervisor) return { ...openCodePolicyFromPermissions(permissions), askEachTime: [...OPENCODE_SUPERVISOR_ASK_TOOLS] };
      // A card run reads freely; where the settings say to ask, it waits on the board and in the inbox for a person.
      const cardRun = await isCardRun(session);
      return openCodePolicyFromPermissions(cardRun ? { ...permissions, unattended: true, parkAsks: true } : permissions);
    },
    ...(options.handoffContextFor ? { handoffContextFor: options.handoffContextFor } : {}),
    ...(accounts
      ? {
          credentials: async (session: OpenCodeSession, request: Parameters<OpenCodeAccounts['credentials']>[1]) =>
            accounts.credentials(await accountTenant(session), request),
          onCredentialFailure: async (session: OpenCodeSession, failure: Parameters<OpenCodeAccounts['onCredentialFailure']>[1]) =>
            accounts.onCredentialFailure(await accountTenant(session), failure),
          usageLimitResetsAt: async (session: OpenCodeSession, failure: { accountId?: string }) => accounts.resetsAt(await accountTenant(session), failure),
        }
      : {}),
    ...(options.parkOnUsageLimit ? { parkOnUsageLimit: options.parkOnUsageLimit } : {}),
    turnContextFor: async session => {
      const environment = peekSessionEnvironment(session.id);
      const signals = environment ? [`<factory-environment>\n${renderSessionEnvironment(environment)}\n</factory-environment>`] : [];
      const sandboxNotes = renderSessionNotes(session.id);
      if (sandboxNotes) signals.push(sandboxNotes);
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
