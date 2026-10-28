import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  GATE_UNATTENDED_ARG,
  PERMISSION_PENDING_MARKER,
  PERMISSION_PROMPT_TOOL_NAME,
  SUBMIT_PLAN_REPLY,
  SUBMIT_PLAN_TOOL_NAME,
  UNATTENDED_PERMISSION_MESSAGE,
} from './gate.ts';

/**
 * The gate MCP server's source, written next to each turn's MCP config and run
 * with Node. It travels as text rather than as a file beside this module: a
 * bundled server (the dev server's package cache, a deploy bundle) moves this
 * module away from any sibling file, and a gate server the CLI cannot start
 * leaves the turn without its plan gate and permission prompts.
 *
 * What it does:
 *  - `submit_plan`: `claude -p` has no ExitPlanMode, so the harness gives
 *    Claude its own plan tool. The harness watches the stream for the call and
 *    stops the turn there; the server only has to list the tool and answer a
 *    call that slips through before the turn is stopped.
 *  - `permission_prompt`: the CLI's `--permission-prompt-tool`, asked whenever
 *    a tool call needs a person's permission. A person cannot answer inside the
 *    turn, so the call is refused with {@link PERMISSION_PENDING_MARKER}; the
 *    harness sees the refusal in the stream, stops the turn and parks it until
 *    the person allows or denies the call. Started with `--unattended` (a card
 *    run nobody watches), it refuses without the marker and says why, so the
 *    turn goes on.
 *
 * Dependency-free on purpose: hand-rolled JSON-RPC 2.0 over newline-delimited
 * JSON on stdin/stdout (the MCP stdio transport). Nothing but protocol
 * messages may go to stdout. The source has no backticks or template
 * substitutions of its own, so it can live in this template literal.
 */
export const GATE_SERVER_SOURCE = String.raw`// The Factory's gate for Claude Code: plan approval and permission prompts (see gate-server.ts).
import { createInterface } from 'node:readline';

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'factory-gate', version: '0.2.0' };

const SUBMIT_PLAN_REPLY = ${JSON.stringify(SUBMIT_PLAN_REPLY)};
const PERMISSION_PENDING_MARKER = ${JSON.stringify(PERMISSION_PENDING_MARKER)};
const UNATTENDED_PERMISSION_MESSAGE = ${JSON.stringify(UNATTENDED_PERMISSION_MESSAGE)};
const UNATTENDED = process.argv.slice(2).includes(${JSON.stringify(GATE_UNATTENDED_ARG)});

const SUBMIT_PLAN_TOOL = {
  name: ${JSON.stringify(SUBMIT_PLAN_TOOL_NAME)},
  title: 'Submit plan for approval',
  description:
    'Submit your implementation plan to a person for approval. Call it once the plan is complete, then stop: ' +
    'make no changes until the plan is approved.',
  inputSchema: {
    type: 'object',
    properties: {
      plan: { type: 'string', description: 'The full plan, in Markdown.' },
      title: { type: 'string', description: 'A short title for the plan.' },
    },
    required: ['plan'],
    additionalProperties: false,
  },
};

const PERMISSION_PROMPT_TOOL = {
  name: ${JSON.stringify(PERMISSION_PROMPT_TOOL_NAME)},
  title: 'Ask a person for permission',
  description: "Called by Claude Code when a tool call needs a person's permission. Not for direct use.",
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string' },
      input: { type: 'object' },
      tool_use_id: { type: 'string' },
    },
    required: ['tool_name'],
  },
};

function permissionPendingMessage(toolName) {
  return (
    PERMISSION_PENDING_MARKER + ' Using ' + toolName + " needs a person's permission, and they have been asked. " +
    'Stop now and wait for their answer; do not try another way around it.'
  );
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function handle(message) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') return;
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;
  if (typeof method !== 'string') return; // A response to us; we never send requests.

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
      reply(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
      return;
    }
    case 'ping':
      if (isRequest) reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: [SUBMIT_PLAN_TOOL, PERMISSION_PROMPT_TOOL] });
      return;
    case 'tools/call': {
      if (params?.name === PERMISSION_PROMPT_TOOL.name) {
        const toolName = typeof params?.arguments?.tool_name === 'string' ? params.arguments.tool_name : 'this tool';
        // The CLI reads the decision as JSON text: refuse, with the marker that parks the turn,
        // or, with nobody to ask, refuse for good and say why.
        const message = UNATTENDED
          ? UNATTENDED_PERMISSION_MESSAGE.split('{tool}').join(toolName)
          : permissionPendingMessage(toolName);
        const decision = { behavior: 'deny', message };
        reply(id, { content: [{ type: 'text', text: JSON.stringify(decision) }] });
        return;
      }
      if (params?.name !== SUBMIT_PLAN_TOOL.name) {
        fail(id, -32602, 'Unknown tool: ' + String(params?.name));
        return;
      }
      const plan = params?.arguments?.plan;
      if (typeof plan !== 'string' || plan.trim() === '') {
        reply(id, { content: [{ type: 'text', text: 'submit_plan needs a non-empty plan.' }], isError: true });
        return;
      }
      reply(id, { content: [{ type: 'text', text: SUBMIT_PLAN_REPLY }] });
      return;
    }
    default:
      // Notifications (notifications/initialized, notifications/cancelled, ...) need no answer.
      if (isRequest) fail(id, -32601, 'Method not found: ' + method);
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  for (const entry of Array.isArray(message) ? message : [message]) handle(entry);
});
lines.on('close', () => process.exit(0));
`;

/** The file name the gate server is written under. */
export const GATE_SERVER_FILE = 'gate-mcp-server.mjs';

/** Writes the gate server into `dir` (readable by this user only) and returns its path. */
export async function writeGateServerScript(dir: string): Promise<string> {
  const file = join(dir, GATE_SERVER_FILE);
  await writeFile(file, GATE_SERVER_SOURCE, { mode: 0o600 });
  return file;
}
