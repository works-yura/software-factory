import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ClaudeCodeHarness, ClaudeCodeSession } from '@factory/harness-claude-code';
import { parseSupervisorResourceId, supervisorResourceId, supervisorThreadId } from '@factory/session';
import type { FactoryProjectsStorage } from '@factory/store';
import { SUPERVISOR_INSTRUCTIONS } from '@factory/supervisor';

/** The MCP server the Factory's tools are mounted under (see `harness.ts`); repeated here to avoid an import cycle. */
const FACTORY_MCP_SERVER = 'factory';

/**
 * The supervisor's tools that change something. On Claude Code each call
 * asks a person (Allow/Deny in the chat) unless the Factory auto-approves,
 * and an Allow lets that one call through.
 */
export const CLAUDE_SUPERVISOR_WRITE_TOOLS = [
  'factory_retry_decision',
  'factory_dismiss_decision',
  'factory_resolve_proposal',
  'factory_transition_work_item',
  'factory_reconcile_labels',
  'factory_revoke_binding',
  'factory_signal_session',
] as const;

/** The supervisor's write tools as the CLI names them. */
export const CLAUDE_SUPERVISOR_ASK_TOOLS = CLAUDE_SUPERVISOR_WRITE_TOOLS.map(id => `mcp__${FACTORY_MCP_SERVER}__${id}`);

/**
 * The Factory chat's playbook on Claude Code: the supervisor's own
 * instructions, and where its tools are. Stable per session (the CLI replays
 * the first turn's system prompt).
 */
export const CLAUDE_SUPERVISOR_SYSTEM_PROMPT = [
  SUPERVISOR_INSTRUCTIONS.trim(),
  '## On Claude Code',
  [
    `The \`factory_*\` tools named above are on the \`${FACTORY_MCP_SERVER}\` MCP server (\`mcp__${FACTORY_MCP_SERVER}__<tool>\`).`,
    'Your working directory is an empty scratch folder: there is no repository here, so do not look for one.',
    'Each repair asks the person for permission when you call it; call the tool when they want the repair, and if they deny it, say what you would have done instead of trying again.',
  ].join(' '),
].join('\n\n');

/** The Factory chat's playbook on Codex: the supervisor's own instructions, and where its tools are. */
export const CODEX_SUPERVISOR_INSTRUCTIONS = [
  SUPERVISOR_INSTRUCTIONS.trim(),
  '## On Codex',
  [
    `The \`factory_*\` tools named above are on the \`${FACTORY_MCP_SERVER}\` MCP server; instructions name them without the server prefix.`,
    'Your working directory is an empty scratch folder: there is no repository here, so do not look for one.',
    'Each repair asks the person for permission when you call it; call the tool when they want the repair, and if they deny it, say what you would have done instead of trying again.',
  ].join(' '),
].join('\n\n');

/** The Factory a supervisor session (`factory-supervisor:<factory>`) belongs to, or `null`. */
export function claudeSupervisorProjectId(sessionId: string): string | null {
  return parseSupervisorResourceId(sessionId);
}

/**
 * Where a Factory chat on Claude Code runs: a private, empty folder of its
 * own (no checkout; the CLI files the session's history by this path, so it
 * stays the same across turns and restarts).
 */
export function createClaudeSupervisorWorkdir(root: string = join(tmpdir(), 'factory-claude-supervisor')) {
  return async (factoryProjectId: string): Promise<string> => {
    const dir = join(root, encodeURIComponent(factoryProjectId));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  };
}

/**
 * The Factory chat (the supervisor session) of a Factory on a turn-based harness (Claude Code's,
 * Codex's): the chat binds to `factory-supervisor:<factory>` before anything exists, so the session
 * is created in the harness's store the first time the chat reaches it, as long as the Factory runs
 * on that harness. A Factory on Mastra (or one switched away) keeps its Mastra supervisor; an
 * existing chat is only served while the Factory is on its harness.
 */
export function createTurnSupervisorSessions<Session>({
  harnessId,
  harness,
  projects,
}: {
  harnessId: string;
  harness: {
    getSession(sessionId: string): Promise<Session | undefined>;
    createSession(input: { sessionId: string; threadId: string; resourceId?: string }): Promise<Session>;
  };
  projects: Pick<FactoryProjectsStorage, 'getById'>;
}): { resolve(sessionId: string): Promise<Session | undefined> } {
  return {
    async resolve(sessionId) {
      const factoryProjectId = claudeSupervisorProjectId(sessionId);
      if (!factoryProjectId) return harness.getSession(sessionId);
      const project = await projects.getById({ id: factoryProjectId });
      if (project?.harness !== harnessId) return undefined;
      const id = supervisorResourceId(factoryProjectId);
      if (id !== sessionId) return undefined;
      return (
        (await harness.getSession(id)) ??
        harness.createSession({ sessionId: id, threadId: supervisorThreadId(factoryProjectId), resourceId: id })
      );
    },
  };
}

/** The Factory chat of a Claude Code Factory (see {@link createTurnSupervisorSessions}). */
export function createClaudeSupervisorSessions({
  harness,
  projects,
}: {
  harness: Pick<ClaudeCodeHarness, 'getSession' | 'createSession'>;
  projects: Pick<FactoryProjectsStorage, 'getById'>;
}): { resolve(sessionId: string): Promise<ClaudeCodeSession | undefined> } {
  return createTurnSupervisorSessions<ClaudeCodeSession>({ harnessId: 'claude-code', harness, projects });
}
