import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { ClaudeToolCategory } from '../src/permissions.ts';
import { callToolThenReport, type ModelScript } from './mock-anthropic.ts';
import { OTHER_MCP, type ContractSession } from './setup.ts';

/** Marks the subagent's own requests to the scripted model. */
export const SUBAGENT_MARKER = 'CONTRACT-SUBAGENT';
export const SUBAGENT_REPLY = 'SUBAGENT-DONE';

/**
 * One tool per permission category, with an input that leaves a trace when the
 * call really runs (a file, an echo log line, the subagent's reply), so a test
 * can tell a call that ran from one that was refused or asked about.
 */
export interface Probe {
  category: ClaudeToolCategory;
  tool: string;
  input(s: ContractSession): Record<string, unknown>;
  ran(s: ContractSession): boolean;
}

export const PROBES: Record<ClaudeToolCategory, Probe> = {
  read: {
    category: 'read',
    tool: 'Read',
    input: s => ({ file_path: join(s.cwd, 'seed.txt') }),
    ran: s => s.transcript.some(entry => entry.kind === 'tool_result' && !entry.isError && entry.content.includes('SEED-CONTENT')),
  },
  edit: {
    category: 'edit',
    tool: 'Write',
    input: s => ({ file_path: join(s.cwd, 'written.txt'), content: 'WRITTEN\n' }),
    ran: s => existsSync(join(s.cwd, 'written.txt')),
  },
  execute: {
    category: 'execute',
    tool: 'Bash',
    input: () => ({ command: 'echo RAN > bash-ran.txt', description: 'Leave a trace' }),
    ran: s => existsSync(join(s.cwd, 'bash-ran.txt')),
  },
  other: {
    category: 'other',
    tool: 'Agent',
    input: () => ({ description: 'Contract subagent', subagent_type: 'general-purpose', prompt: `${SUBAGENT_MARKER}: reply with one word.` }),
    ran: s => s.transcript.some(entry => entry.kind === 'text' && entry.text === SUBAGENT_REPLY && entry.parentToolCallId !== undefined),
  },
  mcp: {
    category: 'mcp',
    tool: `mcp__${OTHER_MCP}__echo`,
    input: () => ({ text: 'PROBE' }),
    ran: s => s.echoed(OTHER_MCP).includes('PROBE'),
  },
};

/** The model calls the probe's tool (once per person's message), and a subagent just answers. */
export function probeScript(probe: Probe, s: () => ContractSession): ModelScript {
  return turn => {
    if (turn.has(SUBAGENT_MARKER)) return { text: SUBAGENT_REPLY };
    return callToolThenReport(probe.tool, probe.input(s()))(turn);
  };
}

export function permissionsAsked(s: ContractSession): string[] {
  return s.transcript.flatMap(entry => (entry.kind === 'permission' ? [entry.toolName] : []));
}
