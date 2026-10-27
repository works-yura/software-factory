#!/usr/bin/env node
// The Factory's plan gate for Claude Code, as a tiny stdio MCP server.
//
// `claude -p` has no ExitPlanMode, so the harness gives Claude its own
// `submit_plan` tool. The harness watches the stream for the call and stops
// the turn there; this server only has to exist, list the tool and answer a
// call that slips through before the turn is stopped.
//
// Dependency-free on purpose: hand-rolled JSON-RPC 2.0 over newline-delimited
// JSON on stdin/stdout (the MCP stdio transport). Nothing but protocol
// messages may go to stdout.

import { createInterface } from 'node:readline';

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'factory-gate', version: '0.1.0' };

const SUBMIT_PLAN_REPLY = 'Plan submitted for approval. Stop now and wait; do not start implementing.';

const SUBMIT_PLAN_TOOL = {
  name: 'submit_plan',
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

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
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
      reply(id, { tools: [SUBMIT_PLAN_TOOL] });
      return;
    case 'tools/call': {
      if (params?.name !== SUBMIT_PLAN_TOOL.name) {
        fail(id, -32602, `Unknown tool: ${String(params?.name)}`);
        return;
      }
      const plan = params?.arguments?.plan;
      if (typeof plan !== 'string' || plan.trim() === '') {
        reply(id, { content: [{ type: 'text', text: 'submit_plan needs a non-empty `plan`.' }], isError: true });
        return;
      }
      reply(id, { content: [{ type: 'text', text: SUBMIT_PLAN_REPLY }] });
      return;
    }
    default:
      // Notifications (`notifications/initialized`, `notifications/cancelled`, …) need no answer.
      if (isRequest) fail(id, -32601, `Method not found: ${method}`);
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
