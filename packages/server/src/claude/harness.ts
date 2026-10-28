import {
  createClaudeCodeHarness,
  createJsonFileSessionStore,
  PLANNING_DISALLOWED_TOOLS,
  SUBMIT_PLAN_TOOL_ID,
} from '@factory/harness-claude-code';
import type {
  ClaudeCodeHarness,
  ClaudeCodeSession,
  ClaudeCredentialFailure,
  ClaudePermissionMode,
  ClaudeSessionStore,
  ClaudeSpawn,
} from '@factory/harness-claude-code';
import type { HarnessRoute } from '@factory/harness';
import { BUNDLED_FACTORY_SKILLS_PATH } from '@factory/harness-mastra';
import { FACTORY_SESSION_TOKEN_HEADER, FACTORY_TOOL_ANNOTATIONS } from '@factory/mcp';
import type { FactorySessionTokenSigner } from '@factory/mcp';
import type { SourceControlSessionLookup } from '@factory/session';
import type { FactoryProjectsStorage } from '@factory/store';

import type { ClaudeCodeCredentialFailureHook, ClaudeCodeCredentialsHook } from './credentials.ts';

/** The MCP server name the Factory's tools are mounted under: Claude sees them as `mcp__factory__<tool>`. */
export const CLAUDE_FACTORY_MCP_SERVER = 'factory';

/**
 * What a Factory session may do without asking, in `-p` where nothing can ask.
 * Reading the repository, git and gh, and the Factory's own tools; file edits
 * come with the permission mode once a plan is approved. Hosts widen it (test
 * runners, package managers) per deployment.
 */
export const DEFAULT_CLAUDE_FACTORY_ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'TodoWrite',
  'Bash(git:*)',
  'Bash(gh:*)',
  `mcp__${CLAUDE_FACTORY_MCP_SERVER}`,
];

/** Factory tools that change something: every annotated write, and the bound-run and session tools that are not annotated. */
export const CLAUDE_FACTORY_MUTATING_TOOLS = [
  ...new Set([
    ...Object.entries(FACTORY_TOOL_ANNOTATIONS).flatMap(([id, annotations]) => (annotations.readOnlyHint ? [] : [id])),
    'factory_transition_work_item',
    'factory_record_review_verdict',
    'factory_recreate_sandbox',
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
 * Factory skills were written for Mastra runs, which see a `factory-phase`
 * signal and a Target repository line in their system prompt.
 */
export const CLAUDE_FACTORY_SYSTEM_PROMPT = [
  'You are an agent session of a Factory: a work item on a board is bound to this session, and Factory skills tell you what to do with it.',
  `The Factory's tools are on the \`${CLAUDE_FACTORY_MCP_SERVER}\` MCP server (\`mcp__${CLAUDE_FACTORY_MCP_SERVER}__<tool>\`).`,
  `There is no factory-phase signal in this session: wherever instructions mention it, call \`mcp__${CLAUDE_FACTORY_MCP_SERVER}__factory_bound_work_item\` for the current stage and revision.`,
  'The Target repository is the one checked out in your working directory.',
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
  /** Where Claude Code sessions are recorded; required unless `store` is given. */
  storeDir?: string;
  store?: ClaudeSessionStore;
  sessions: Pick<SourceControlSessionLookup, 'getBySessionId'>;
  /**
   * The Factories, read before each turn for the session's `claudeCodeModel`
   * (`claude --model`). Unset, or a Factory with none, leaves the CLI's own default.
   */
  projects?: Pick<FactoryProjectsStorage, 'get'>;
  credentials: ClaudeCodeCredentialsHook;
  /** Told when a turn's account ran out of usage or was refused, so the pool sets it aside. */
  onCredentialFailure?: ClaudeCodeCredentialFailureHook;
  /** The session's checkout (see `createClaudeCheckoutResolver`). */
  cwdFor: (sessionId: string) => string | Promise<string>;
  /** The Factory MCP endpoint for a factory, and the signer for the session tokens it accepts. */
  mcp?: { url: (factoryProjectId: string) => string; tokens: Pick<FactorySessionTokenSigner, 'sign'> };
  /** `CLAUDE_CONFIG_DIR` per session; unset keeps the person's own (and their login, for local dev). */
  configDir?: (session: ClaudeCodeSession) => string | undefined;
  allowedTools?: string[];
  approvedPermissionMode?: ClaudePermissionMode;
  turnTimeoutMs?: number;
  /** Factory skills; the bundled ones by default. */
  skillsDir?: string;
  command?: string;
  spawn?: ClaudeSpawn;
  env?: Record<string, string | undefined>;
  /** Every session object the harness builds, before anyone drives it (chat UI, run audit, reports). */
  onSession?: (session: ClaudeCodeSession) => void;
}

export interface ClaudeFactoryHarness {
  harness: ClaudeCodeHarness;
  store: ClaudeSessionStore;
  /** For the routing harness: a session is Claude's when its store has it. */
  route: HarnessRoute;
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

  const harness = createClaudeCodeHarness({
    store,
    cwdFor: options.cwdFor,
    credentials: async (session, request) => {
      const row = await sourceSession(session.id);
      return options.credentials({ orgId: row.orgId, userId: row.userId }, request);
    },
    ...(options.onCredentialFailure
      ? {
          onCredentialFailure: async (session: ClaudeCodeSession, failure: ClaudeCredentialFailure) => {
            const row = await sourceSession(session.id);
            await options.onCredentialFailure!({ orgId: row.orgId, userId: row.userId }, failure);
          },
        }
      : {}),
    ...(options.mcp
      ? {
          mcpConfig: async (session: ClaudeCodeSession) => {
            const row = await sourceSession(session.id);
            const mcp = options.mcp!;
            // Minted per turn and only for this session's own coordinates; it expires on its own.
            const token = mcp.tokens.sign({
              orgId: row.orgId,
              factoryProjectId: row.factoryProjectId,
              sessionId: session.id,
              threadId: session.thread.requireId(),
              resourceId: session.resourceId ?? row.factoryProjectId,
            });
            return {
              mcpServers: {
                [CLAUDE_FACTORY_MCP_SERVER]: {
                  type: 'http',
                  url: mcp.url(row.factoryProjectId),
                  headers: { [FACTORY_SESSION_TOKEN_HEADER]: token },
                },
              },
            };
          },
        }
      : {}),
    ...(options.projects
      ? {
          // Read per turn, so a model changed in settings applies from the session's next turn.
          modelFor: async (session: ClaudeCodeSession) => {
            const row = await sourceSession(session.id);
            const project = await options.projects!.get({ orgId: row.orgId, id: row.factoryProjectId });
            return project?.claudeCodeModel ?? undefined;
          },
        }
      : {}),
    ...(options.configDir ? { configDir: options.configDir } : {}),
    allowedTools: options.allowedTools ?? DEFAULT_CLAUDE_FACTORY_ALLOWED_TOOLS,
    appendSystemPrompt: CLAUDE_FACTORY_SYSTEM_PROMPT,
    planningPrompt: CLAUDE_FACTORY_PLANNING_PROMPT,
    planningDisallowedTools: CLAUDE_FACTORY_PLANNING_DISALLOWED_TOOLS,
    approvedPermissionMode: options.approvedPermissionMode ?? 'acceptEdits',
    skillsDir: options.skillsDir ?? BUNDLED_FACTORY_SKILLS_PATH,
    ...(options.turnTimeoutMs ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
    ...(options.command ? { command: options.command } : {}),
    ...(options.spawn ? { spawn: options.spawn } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.onSession ? { onSession: options.onSession } : {}),
  });

  return {
    harness,
    store,
    route: { harness, owns: async sessionId => (await store.get(sessionId)) !== undefined },
  };
}
