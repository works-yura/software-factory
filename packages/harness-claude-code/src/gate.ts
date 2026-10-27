import { fileURLToPath } from 'node:url';

/**
 * The plan gate. `claude -p` has no ExitPlanMode, so the harness gives Claude
 * its own `submit_plan` tool through a tiny stdio MCP server
 * (`gate-mcp-server.mjs`) and stops the turn as soon as Claude calls it.
 */

/** The MCP server name the gate is registered under; part of the tool's id. */
export const GATE_SERVER_NAME = 'factory_gate';
/** The tool's name on the gate server. */
export const SUBMIT_PLAN_TOOL_NAME = 'submit_plan';
/** How the CLI names the gate tool: `mcp__<server>__<tool>`. */
export const SUBMIT_PLAN_TOOL_ID = `mcp__${GATE_SERVER_NAME}__${SUBMIT_PLAN_TOOL_NAME}`;
/** The answer the gate server gives a call that reaches it before the turn is stopped. */
export const SUBMIT_PLAN_REPLY = 'Plan submitted for approval. Stop now and wait; do not start implementing.';

/** The gate server script, run with Node. */
export const GATE_SERVER_SCRIPT = fileURLToPath(new URL('./gate-mcp-server.mjs', import.meta.url));

export interface GateServerCommand {
  command: string;
  args?: string[];
}

/** An `--mcp-config` object holding just the gate server. */
export function gateMcpConfig(server: GateServerCommand = { command: process.execPath, args: [GATE_SERVER_SCRIPT] }) {
  return {
    mcpServers: {
      [GATE_SERVER_NAME]: { type: 'stdio', command: server.command, args: server.args ?? [] },
    },
  };
}

/**
 * Tools denied while planning: everything that edits files. Bash is left to
 * the configured `allowedTools` (unlisted commands are denied in `-p`), so a
 * planning turn can still read the repo with allowed commands.
 */
export const PLANNING_DISALLOWED_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

/**
 * Appended to the system prompt on every turn. The CLI records the system
 * prompt on a conversation's first request and replays it on every resume
 * (`--system-prompt-snapshot on`), so it must not change between turns: it
 * explains the protocol, and each planning turn's prompt says that it is one.
 */
export const GATE_SYSTEM_PROMPT =
  'Plan approval: when a message says you are planning, investigate read-only (file edits are disabled), ' +
  `then call the \`${SUBMIT_PLAN_TOOL_ID}\` tool once with the complete plan and stop. ` +
  'Do not change anything until a later message says the plan was approved.';

/** Leads every planning turn's prompt. */
export const PLANNING_PROMPT =
  `<factory-mode name="planning">\nYou are planning. Investigate read-only; file edits are disabled for this turn. ` +
  `When the plan is complete, call \`${SUBMIT_PLAN_TOOL_ID}\` with the full plan (and a short title), then stop.\n</factory-mode>`;
