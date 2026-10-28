/**
 * The plan gate. `claude -p` has no ExitPlanMode, so the harness gives Claude
 * its own `submit_plan` tool through a tiny stdio MCP server
 * (`gate-server.ts`) and stops the turn as soon as Claude calls it. The same
 * server answers the CLI's permission prompts.
 */

/** The MCP server name the gate is registered under; part of the tool's id. */
export const GATE_SERVER_NAME = 'factory_gate';
/** The tool's name on the gate server. */
export const SUBMIT_PLAN_TOOL_NAME = 'submit_plan';
/** How the CLI names the gate tool: `mcp__<server>__<tool>`. */
export const SUBMIT_PLAN_TOOL_ID = `mcp__${GATE_SERVER_NAME}__${SUBMIT_PLAN_TOOL_NAME}`;
/** The answer the gate server gives a call that reaches it before the turn is stopped. */
export const SUBMIT_PLAN_REPLY = 'Plan submitted for approval. Stop now and wait; do not start implementing.';

/** The gate server's permission tool: the CLI's `--permission-prompt-tool`, asked whenever a tool call needs a person. */
export const PERMISSION_PROMPT_TOOL_NAME = 'permission_prompt';
/** How the CLI names the permission tool. */
export const PERMISSION_PROMPT_TOOL_ID = `mcp__${GATE_SERVER_NAME}__${PERMISSION_PROMPT_TOOL_NAME}`;
/**
 * Leads the refusal the permission tool gives (the CLI shows it as the refused
 * call's result): the harness watches for it to stop the turn and ask the
 * person.
 */
export const PERMISSION_PENDING_MARKER = '[factory:permission-pending]';

/**
 * The gate server's argument for an unattended turn (a card run nobody is
 * watching): its permission tool refuses at once, saying why, instead of
 * parking the turn for a person.
 */
export const GATE_UNATTENDED_ARG = '--unattended';

/** How an unattended turn's refused call reads; `{tool}` is the tool's name. */
export const UNATTENDED_PERMISSION_MESSAGE =
  "Permission denied: using {tool} needs a person's permission (the Factory's tool settings say to ask), " +
  'but nobody is attending this run: the Factory started it, not a person in a chat. ' +
  'Do not retry it or work around it. Go on without it if you can; otherwise stop and say in your reply that you needed {tool}, ' +
  'so a person can allow it in Settings → Behavior → Tool permissions.';

export interface GateServerCommand {
  command: string;
  args?: string[];
}

/** An `--mcp-config` object holding just the gate server. */
export function gateMcpConfig(server: GateServerCommand) {
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
