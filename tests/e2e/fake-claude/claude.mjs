#!/usr/bin/env node
// A fake `claude` CLI for end-to-end tests. It stands in for the real binary at
// the process boundary, so everything around it runs for real:
//
//  - it parses the arguments the harness passes (`-p -`, `--output-format
//    stream-json`, `--resume`, `--mcp-config <file…>`, `--permission-prompt-tool`,
//    `--allowedTools`, `--disallowedTools`, `--settings`, …) and rejects unknown
//    ones the way the real CLI does;
//  - it reads the prompt from stdin;
//  - it ACTUALLY connects to every MCP server in the config (http through the
//    MCP streamable-http client with the configured headers, stdio by spawning
//    the command) and reports each one in the init line's `mcp_servers` with
//    status `connected` or `failed`, like the real CLI;
//  - it plays a scenario: tools it calls go through the same permission rules
//    as the real CLI (deny, then ask, then allow), and an "ask" goes to the
//    permission prompt tool over MCP; a refusal becomes the tool result the real
//    CLI writes (see packages/harness-claude-code-core/src/__fixtures__/turn-permission.jsonl);
//  - it writes stream-json lines shaped like the real CLI's.
//
// Scenario: `FAKE_CLAUDE_SCENARIO`, else a `[fake:<name>]` marker in the
// prompt, else `factory-write`. Scenarios:
//  - `factory-write`: call `mcp__factory__factory_list_work_items`, then Write
//    `e2e-proof.txt`. A resumed turn whose prompt says the person allowed the
//    tool retries the pending Write; one that says they denied it gives up.
//  - `plan`: call the gate's `submit_plan`.
//  - `deliver`: commit a file in the checkout, then push the session branch and
//    open a merge request with the Factory's `source_control_*` MCP tools.
//  - `text`: answer with text only.
//
// Diagnostics: with `FAKE_CLAUDE_LOG` set, each invocation appends one JSON
// line (args, prompt, MCP statuses, tool calls) to that file. The harness
// passes only an allow-listed environment to the CLI, so tests set these
// variables in a wrapper script (see `src/stack.ts`).

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const VERSION = '2.1.312 (fake)';
const MODEL_IDS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5-5' };
const BUILTIN_TOOLS = ['Task', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'WebFetch', 'TodoWrite'];
const READ_ONLY_TOOLS = new Set(['Glob', 'Grep', 'Read', 'LS', 'TodoWrite']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const MCP_CONNECT_TIMEOUT_MS = Number(process.env.FAKE_CLAUDE_MCP_TIMEOUT_MS) || 15_000;
const PROOF_FILE = 'e2e-proof.txt';
const DELIVERY_FILE = 'e2e-delivery.txt';

// ---------------------------------------------------------------------------
// Arguments

const VALUE_FLAGS = new Set([
  '--output-format',
  '--input-format',
  '--resume',
  '--model',
  '--effort',
  '--permission-mode',
  '--setting-sources',
  '--settings',
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--permission-prompt-tool',
  '--max-turns',
  '--append-system-prompt',
  '--system-prompt',
]);
const BOOLEAN_FLAGS = new Set(['--verbose', '--include-partial-messages', '--strict-mcp-config', '--continue']);
const FORBIDDEN_FLAGS = new Set(['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions']);

function usageError(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { mcpConfig: [], allowedTools: [], disallowedTools: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-p' || arg === '--print') {
      args.print = true;
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) args.promptArg = argv[++i];
      else if (argv[i + 1] === '-') args.promptArg = argv[++i];
      continue;
    }
    if (arg === '--version' || arg === '-v') {
      process.stdout.write(`${VERSION}\n`);
      process.exit(0);
    }
    if (FORBIDDEN_FLAGS.has(arg)) args.skipPermissions = true;
    if (arg === '--mcp-config') {
      while (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) args.mcpConfig.push(argv[++i]);
      if (args.mcpConfig.length === 0) usageError("option '--mcp-config <configs...>' argument missing");
      continue;
    }
    if (BOOLEAN_FLAGS.has(arg) || FORBIDDEN_FLAGS.has(arg)) {
      args[camel(arg)] = true;
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[++i];
      if (value === undefined) usageError(`option '${arg} <value>' argument missing`);
      if (arg === '--allowedTools' || arg === '--allowed-tools') args.allowedTools.push(...splitTools(value));
      else if (arg === '--disallowedTools' || arg === '--disallowed-tools') args.disallowedTools.push(...splitTools(value));
      else args[camel(arg)] = value;
      continue;
    }
    usageError(`unknown option '${arg}'`);
  }
  if (!args.print) usageError('this fake only supports non-interactive (-p) runs');
  if (args.outputFormat === 'stream-json' && !args.verbose) {
    usageError('When using --print, --output-format=stream-json requires --verbose');
  }
  if (args.permissionMode === 'bypassPermissions' || args.skipPermissions) args.bypass = true;
  return args;
}

function camel(flag) {
  return flag.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function splitTools(value) {
  return value
    .split(/[,\s]+/)
    .map(tool => tool.trim())
    .filter(Boolean);
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------------------------------------------------------------------
// Output

let sessionId;
function emit(message) {
  process.stdout.write(`${JSON.stringify({ ...message, session_id: sessionId, uuid: randomUUID() })}\n`);
}

const usage = () => ({ input_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 12 });

function assistant(model, content, stopReason = null) {
  emit({
    type: 'assistant',
    message: {
      model,
      id: `msg_fake_${randomUUID().slice(0, 8)}`,
      type: 'message',
      role: 'assistant',
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: usage(),
    },
    parent_tool_use_id: null,
  });
}

function toolResult(toolUseId, content, isError) {
  const text = typeof content === 'string' ? content : content.map(block => block.text ?? '').join('\n');
  emit({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', content, ...(isError ? { is_error: true } : {}), tool_use_id: toolUseId }],
    },
    parent_tool_use_id: null,
    tool_use_result: isError ? `Error: ${text}` : text,
  });
}

// ---------------------------------------------------------------------------
// MCP

function readMcpConfigs(values) {
  const servers = {};
  for (const value of values) {
    let parsed;
    try {
      parsed = existsSync(value) ? JSON.parse(readFileSync(value, 'utf8')) : JSON.parse(value);
    } catch (error) {
      usageError(`Invalid MCP configuration: ${value}: ${error instanceof Error ? error.message : String(error)}`);
    }
    Object.assign(servers, parsed?.mcpServers ?? {});
  }
  return servers;
}

async function withTimeout(promise, ms, what) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function connectServer(name, config, cwd) {
  const type = config.type ?? (config.command ? 'stdio' : config.url ? 'http' : undefined);
  const client = new Client({ name: 'claude-code', version: VERSION });
  let transport;
  if (type === 'http') {
    transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers ?? {} } });
  } else if (type === 'stdio') {
    transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...process.env, ...(config.env ?? {}) },
      cwd,
      stderr: 'pipe',
    });
  } else {
    return { name, status: 'failed', error: `unsupported MCP server type ${String(type)}`, tools: [] };
  }
  try {
    await withTimeout(client.connect(transport), MCP_CONNECT_TIMEOUT_MS, `connecting to ${name}`);
    const { tools } = await withTimeout(client.listTools(), MCP_CONNECT_TIMEOUT_MS, `listing tools of ${name}`);
    return { name, status: 'connected', client, tools: tools.map(tool => tool.name) };
  } catch (error) {
    await client.close().catch(() => {});
    return { name, status: 'failed', error: error instanceof Error ? error.message : String(error), tools: [] };
  }
}

// ---------------------------------------------------------------------------
// Permissions, as the real CLI decides them: deny, then ask, then allow, then the mode's default.

function ruleMatches(rule, tool) {
  if (rule === tool) return true;
  // `mcp__server` covers every tool of that server; `Bash(git:*)`-style rules cover the tool's specific calls only.
  if (rule.startsWith('mcp__') && tool.startsWith(`${rule}__`)) return true;
  return false;
}

function decide(tool, ctx) {
  if (ctx.args.disallowedTools.some(rule => ruleMatches(rule, tool))) return 'deny';
  if (ctx.settings.permissions?.deny?.some(rule => ruleMatches(rule, tool))) return 'deny';
  if (ctx.args.bypass) return 'allow';
  if (ctx.settings.permissions?.ask?.some(rule => ruleMatches(rule, tool))) return 'ask';
  if (ctx.args.allowedTools.some(rule => ruleMatches(rule, tool))) return 'allow';
  if (ctx.settings.permissions?.allow?.some(rule => ruleMatches(rule, tool))) return 'allow';
  if (READ_ONLY_TOOLS.has(tool)) return 'allow';
  if (EDIT_TOOLS.has(tool) && ctx.args.permissionMode === 'acceptEdits') return 'allow';
  if (ctx.args.permissionMode === 'dontAsk') return 'deny';
  return 'ask';
}

/** Asks the permission prompt tool; resolves to `{ behavior: 'allow' | 'deny', message?, updatedInput? }`. */
async function askPermission(tool, input, toolUseId, ctx) {
  const promptTool = ctx.args.permissionPromptTool;
  if (!promptTool) {
    return { behavior: 'deny', message: `Claude requested permissions to use ${tool}, but you haven't granted it yet.` };
  }
  const target = ctx.mcpTool(promptTool);
  const result = await target.server.client.callTool({
    name: target.tool,
    arguments: { tool_name: tool, input, tool_use_id: toolUseId },
  });
  const text = result.content?.find(block => block.type === 'text')?.text ?? '';
  ctx.log.permissionPrompts.push({ tool, reply: text });
  try {
    const decision = JSON.parse(text);
    if (decision.behavior === 'allow' || decision.behavior === 'deny') return decision;
  } catch {
    // Fall through: the real CLI treats an unreadable answer as a refusal.
  }
  return { behavior: 'deny', message: `Permission prompt tool returned an invalid result: ${text}` };
}

/**
 * One tool call, the way the CLI runs it: the assistant's tool_use, the
 * permission decision, then the tool_result. Resolves to what happened.
 */
async function callTool(tool, input, ctx) {
  const toolUseId = `toolu_fake_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  assistant(ctx.model, [{ type: 'tool_use', id: toolUseId, name: tool, input }], 'tool_use');
  const record = { tool, input, toolUseId };
  ctx.log.toolCalls.push(record);

  if (tool.startsWith('mcp__') && !ctx.mcpToolExists(tool)) {
    record.outcome = 'missing';
    toolResult(toolUseId, `<tool_use_error>Error: No such tool available: ${tool}</tool_use_error>`, true);
    return record;
  }

  let decision = decide(tool, ctx);
  let effectiveInput = input;
  if (decision === 'ask') {
    const answer = await askPermission(tool, input, toolUseId, ctx);
    if (answer.behavior === 'deny') {
      record.outcome = 'denied';
      record.message = answer.message;
      ctx.denials.push({ tool_name: tool, tool_use_id: toolUseId, tool_input: input });
      toolResult(toolUseId, answer.message ?? `Permission to use ${tool} was denied.`, true);
      return record;
    }
    decision = 'allow';
    if (answer.updatedInput && typeof answer.updatedInput === 'object') effectiveInput = answer.updatedInput;
  }
  if (decision === 'deny') {
    record.outcome = 'denied';
    ctx.denials.push({ tool_name: tool, tool_use_id: toolUseId, tool_input: input });
    toolResult(toolUseId, `Permission to use ${tool} has been denied.`, true);
    return record;
  }

  try {
    if (tool.startsWith('mcp__')) {
      const target = ctx.mcpTool(tool);
      const result = await target.server.client.callTool({ name: target.tool, arguments: effectiveInput });
      const content = (result.content ?? []).map(block => (block.type === 'text' ? { type: 'text', text: block.text } : block));
      record.outcome = result.isError ? 'error' : 'ok';
      record.result = content.map(block => block.text ?? '').join('\n').slice(0, 2000);
      toolResult(toolUseId, content, result.isError === true);
    } else if (tool === 'Write') {
      const path = isAbsolute(effectiveInput.file_path) ? effectiveInput.file_path : resolve(ctx.cwd, effectiveInput.file_path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, effectiveInput.content ?? '');
      record.outcome = 'ok';
      toolResult(toolUseId, `File created successfully at: ${path}`, false);
    } else {
      record.outcome = 'error';
      toolResult(toolUseId, `<tool_use_error>The fake CLI cannot run ${tool}.</tool_use_error>`, true);
    }
  } catch (error) {
    record.outcome = 'error';
    record.result = error instanceof Error ? error.message : String(error);
    toolResult(toolUseId, `<tool_use_error>${record.result}</tool_use_error>`, true);
  }
  return record;
}

// ---------------------------------------------------------------------------
// Sessions: the resumable state the real CLI keeps under its config dir.

function sessionsDir() {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'fake-claude-sessions');
}
function loadSession(id) {
  const file = join(sessionsDir(), `${id}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
}
function saveSession(id, state) {
  mkdirSync(sessionsDir(), { recursive: true });
  writeFileSync(join(sessionsDir(), `${id}.json`), JSON.stringify(state));
}

// ---------------------------------------------------------------------------
// Scenarios

function pickScenario(prompt) {
  if (process.env.FAKE_CLAUDE_SCENARIO) return process.env.FAKE_CLAUDE_SCENARIO;
  return /\[fake:([a-z-]+)\]/.exec(prompt)?.[1] ?? 'factory-write';
}

async function factoryWrite(ctx) {
  const pending = ctx.session.pendingWrite;
  if (pending && ctx.resumed) {
    // The harness's answer to a parked permission: "The person allowed Write …" / "… denied permission …".
    if (/\ballowed\b/i.test(ctx.prompt)) {
      const record = await callTool('Write', pending, ctx);
      if (record.outcome === 'ok') {
        ctx.session.pendingWrite = undefined;
        return `Wrote ${PROOF_FILE} after the person allowed it.`;
      }
      return `The Write was refused again (${record.outcome}).`;
    }
    if (/\bdenied\b/i.test(ctx.prompt)) {
      ctx.session.pendingWrite = undefined;
      return `Understood: not writing ${PROOF_FILE}.`;
    }
  }

  const list = await callTool('mcp__factory__factory_list_work_items', {}, ctx);
  const input = { file_path: join(ctx.cwd, PROOF_FILE), content: `written by the fake claude in session ${sessionId}\n` };
  // Recorded before the call: the harness stops the process as soon as the refusal is out.
  ctx.session.pendingWrite = input;
  saveSession(sessionId, ctx.session);
  const write = await callTool('Write', input, ctx);
  if (write.outcome !== 'denied') ctx.session.pendingWrite = undefined;
  const listed = list.outcome === 'ok' ? 'listed the work items' : `could not list the work items (${list.outcome})`;
  return write.outcome === 'ok'
    ? `I ${listed} and wrote ${PROOF_FILE}.`
    : `I ${listed}. The Write call for \`${PROOF_FILE}\` didn't go through: it needs a person's permission, so I've stopped.`;
}

async function plan(ctx) {
  await callTool('mcp__factory_gate__submit_plan', { title: 'E2E plan', plan: '1. Write e2e-proof.txt\n2. Done' }, ctx);
  return 'The plan is submitted; waiting for approval.';
}

// What a build run does at the end: commit its change in the checkout (as its Bash would), then push the
// session branch and open the merge request through the Factory's brokered tools, never with credentials of its own.
// With several repositories the working directory is their root: the session's own is the first the environment lists.
async function deliver(ctx) {
  const repo = /^1\. \S+ at (\S+) on /m.exec(ctx.prompt)?.[1] ?? ctx.cwd;
  const file = join(repo, DELIVERY_FILE);
  writeFileSync(file, `delivered by the fake claude in session ${sessionId}\n`);
  const git = args =>
    execFileSync('git', ['-c', 'user.name=Fake Claude', '-c', 'user.email=fake-claude@factory.invalid', ...args], {
      cwd: repo,
      encoding: 'utf8',
    });
  git(['add', DELIVERY_FILE]);
  git(['commit', '-q', '-m', 'Add the delivery proof']);
  const push = await callTool('mcp__factory__source_control_push_branch', {}, ctx);
  if (push.outcome !== 'ok') return `The push failed (${push.outcome}): ${push.result ?? push.message ?? ''}`;
  const mr = await callTool(
    'mcp__factory__source_control_create_change_request',
    { title: 'E2E delivery', body: 'Opened by the fake claude.' },
    ctx,
  );
  if (mr.outcome !== 'ok') return `Opening the merge request failed (${mr.outcome}): ${mr.result ?? mr.message ?? ''}`;
  return `Pushed and opened the merge request: ${mr.result ?? ''}`;
}

const SCENARIOS = {
  'factory-write': factoryWrite,
  plan,
  deliver,
  text: async ctx => `Echo: ${ctx.prompt.trim().slice(0, 200)}`,
};

// ---------------------------------------------------------------------------

async function main() {
  const started = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const prompt = args.promptArg && args.promptArg !== '-' ? args.promptArg : await readStdin();
  if (!prompt.trim()) usageError('Input must be provided either through stdin or as a prompt argument when using --print');
  let settings = {};
  if (args.settings) {
    try {
      settings = existsSync(args.settings) ? JSON.parse(readFileSync(args.settings, 'utf8')) : JSON.parse(args.settings);
    } catch {
      usageError(`Invalid settings: ${args.settings}`);
    }
  }
  const cwd = process.cwd();
  const model = MODEL_IDS[args.model] ?? args.model ?? MODEL_IDS.sonnet;
  const log = {
    at: new Date().toISOString(),
    pid: process.pid,
    argv: process.argv.slice(2),
    cwd,
    prompt,
    model,
    mcp: [],
    toolCalls: [],
    permissionPrompts: [],
  };
  const writeLog = () => {
    if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify(log)}\n`);
  };
  let servers = [];
  let session = {};
  const shutdown = async code => {
    if (sessionId && log.result !== 'unknown-session') saveSession(sessionId, session);
    await Promise.all(servers.map(server => server.client?.close().catch(() => {})));
    writeLog();
    process.exit(code);
  };
  // The harness stops a turn at a parked permission or a plan with SIGTERM, like a person pressing Ctrl-C.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      log.signal = signal;
      void shutdown(signal === 'SIGTERM' ? 143 : 130);
    });
  }

  if (args.resume) {
    const stored = loadSession(args.resume);
    if (!stored) {
      sessionId = randomUUID();
      log.result = 'unknown-session';
      emit({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        duration_ms: 0,
        num_turns: 0,
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        errors: [`No conversation found with session ID: ${args.resume}`],
      });
      await shutdown(1);
      return;
    }
    sessionId = args.resume;
    session = stored;
  } else {
    sessionId = randomUUID();
  }
  log.sessionId = sessionId;

  const configured = readMcpConfigs(args.mcpConfig);
  servers = await Promise.all(Object.entries(configured).map(([name, config]) => connectServer(name, config, cwd)));
  log.mcp = servers.map(({ name, status, tools, error }) => ({ name, status, tools, ...(error ? { error } : {}) }));
  const mcpTools = servers.flatMap(server => server.tools.map(tool => `mcp__${server.name}__${tool}`));

  const ctx = {
    args,
    settings,
    cwd,
    model,
    prompt,
    log,
    session,
    resumed: Boolean(args.resume),
    denials: [],
    mcpToolExists: tool => mcpTools.includes(tool),
    mcpTool: tool => {
      const server = servers.find(candidate => tool.startsWith(`mcp__${candidate.name}__`));
      if (!server || server.status !== 'connected') throw new Error(`MCP server for ${tool} is not connected`);
      return { server, tool: tool.slice(`mcp__${server.name}__`.length) };
    },
  };

  // The real CLI refuses to start a turn whose permission prompt tool does not exist.
  if (args.permissionPromptTool && !ctx.mcpToolExists(args.permissionPromptTool)) {
    process.stderr.write(
      `Error: MCP tool ${args.permissionPromptTool} (passed via --permission-prompt-tool) not found. Available MCP tools: ${mcpTools.join(', ') || 'none'}\n`,
    );
    log.result = 'permission-prompt-tool-missing';
    await shutdown(1);
    return;
  }

  emit({
    type: 'system',
    subtype: 'init',
    cwd,
    tools: [...BUILTIN_TOOLS.filter(tool => !args.disallowedTools.includes(tool)), ...mcpTools],
    mcp_servers: servers.map(({ name, status }) => ({ name, status })),
    model,
    permissionMode: args.permissionMode ?? 'default',
    slash_commands: [],
    apiKeySource: 'none',
    claude_code_version: VERSION,
    output_style: 'default',
    agents: [],
    skills: [],
    plugins: [],
  });

  const scenario = pickScenario(prompt);
  log.scenario = scenario;
  const play = SCENARIOS[scenario];
  if (!play) usageError(`unknown fake scenario ${scenario}`);
  let text;
  try {
    text = await play(ctx);
  } catch (error) {
    text = undefined;
    log.error = error instanceof Error ? error.stack : String(error);
  }
  saveSession(sessionId, session);

  if (text === undefined) {
    emit({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      duration_ms: Date.now() - started,
      num_turns: ctx.log.toolCalls.length + 1,
      total_cost_usd: 0,
      usage: usage(),
      errors: [log.error ?? 'fake scenario failed'],
    });
    log.result = 'error';
    await shutdown(1);
    return;
  }
  assistant(model, [{ type: 'text', text }], 'end_turn');
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: Date.now() - started,
    num_turns: ctx.log.toolCalls.length + 1,
    result: text,
    total_cost_usd: 0,
    usage: usage(),
    permission_denials: ctx.denials,
  });
  log.result = 'success';
  await shutdown(0);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
