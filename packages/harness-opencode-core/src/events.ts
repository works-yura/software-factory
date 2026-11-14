// One OpenCode turn's events as the Factory's transcript: what the agent said and thought, the tools
// it called (under the Factory's own tool names, so the chat draws them as a Codex or Mastra
// session's), what it asked a person, its token usage, and how the turn ended. Events of other
// sessions on the same server are not the turn's; a subagent's (`task`) child session is, nested
// under the call that started it.
import type { AgentTokenUsage, PlanGate } from '@factory/harness';
import { ASK_USER_QUESTION_TOOL, type PermissionRequest, type TranscriptEntry } from '@factory/harness/transcript';

import type { OpenCodeEvent } from './client.ts';
import { isTerminalRetry, OpenCodeError, openCodeErrorFrom, type OpenCodeErrorPayload } from './errors.ts';

/** The tool names OpenCode's work is recorded under: the Factory's own (Mastra) names, as Codex's are. */
export const OPENCODE_TOOL_NAMES = {
  command: 'execute_command',
  readFile: 'view',
  writeFile: 'write_file',
  editFile: 'string_replace_lsp',
  search: 'search_content',
  findFiles: 'find_files',
  listFiles: 'list_files',
  webFetch: 'web_fetch',
  webSearch: 'web_search',
  tasks: 'task_write',
  plan: 'submit_plan',
  skill: 'skill',
  /** A subagent, under the name Claude Code gives its own, so the chat's subagent card follows it. */
  subagent: 'Agent',
} as const;

/** The contract's name for a plan gate, so the dispatcher's plan handling applies unchanged. */
export const OPENCODE_PLAN_GATE_TOOL = 'submit_plan';

export type OpenCodeTurnOutcome =
  | { kind: 'complete'; text?: string }
  | { kind: 'gate'; gate: PlanGate }
  | { kind: 'aborted' }
  | { kind: 'error'; error: OpenCodeError };

type Input = Record<string, unknown>;

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const record = (value: unknown): Input => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Input) : {});
const defined = (input: Input): Input => Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));

const TODO_STATUS: Record<string, string> = { pending: 'pending', in_progress: 'in_progress', completed: 'completed', cancelled: 'completed' };

/**
 * A call as the transcript names it, with its input in that tool's shape. MCP tools (`<server>_<tool>`
 * of a server the run configured) read as `mcp__<server>__<tool>`, as Claude Code names them.
 */
export function openCodeToolCall(tool: string, rawInput: unknown, mcpServers: readonly string[] = []): { toolName: string; input: Input } {
  const input = record(rawInput);
  switch (tool) {
    case 'bash':
      return { toolName: OPENCODE_TOOL_NAMES.command, input: defined({ command: str(input.command) ?? '', description: str(input.description), cwd: str(input.workdir) }) };
    case 'read':
      return { toolName: OPENCODE_TOOL_NAMES.readFile, input: defined({ path: str(input.filePath), offset: input.offset, limit: input.limit }) };
    case 'write':
      return { toolName: OPENCODE_TOOL_NAMES.writeFile, input: defined({ path: str(input.filePath), content: typeof input.content === 'string' ? input.content : undefined }) };
    case 'edit':
      return {
        toolName: OPENCODE_TOOL_NAMES.editFile,
        input: defined({ path: str(input.filePath), old_string: typeof input.oldString === 'string' ? input.oldString : undefined, new_string: typeof input.newString === 'string' ? input.newString : undefined }),
      };
    case 'multiedit': {
      const edits = Array.isArray(input.edits) ? input.edits.map(record) : [];
      const side = (key: string) => edits.map(edit => (typeof edit[key] === 'string' ? edit[key] : '')).join('\n');
      return { toolName: OPENCODE_TOOL_NAMES.editFile, input: defined({ path: str(input.filePath), old_string: side('oldString'), new_string: side('newString') }) };
    }
    case 'patch':
    case 'apply_patch':
      return { toolName: OPENCODE_TOOL_NAMES.editFile, input: defined({ diff: str(input.patchText) ?? str(input.patch) }) };
    case 'grep':
      return { toolName: OPENCODE_TOOL_NAMES.search, input: defined({ pattern: str(input.pattern), path: str(input.path), include: str(input.include) }) };
    case 'glob':
      return { toolName: OPENCODE_TOOL_NAMES.findFiles, input: defined({ pattern: str(input.pattern), path: str(input.path) }) };
    case 'list':
      return { toolName: OPENCODE_TOOL_NAMES.listFiles, input: defined({ path: str(input.path) }) };
    case 'webfetch':
      return { toolName: OPENCODE_TOOL_NAMES.webFetch, input: defined({ url: str(input.url), format: str(input.format) }) };
    case 'websearch':
      return { toolName: OPENCODE_TOOL_NAMES.webSearch, input: defined({ query: str(input.query) }) };
    case 'skill':
      return { toolName: OPENCODE_TOOL_NAMES.skill, input: defined({ name: str(input.name) }) };
    case 'todowrite': {
      const todos = (Array.isArray(input.todos) ? input.todos : []).map(record).map(todo => ({
        content: str(todo.content) ?? '',
        status: TODO_STATUS[str(todo.status) ?? ''] ?? 'pending',
        activeForm: str(todo.content) ?? '',
      }));
      return { toolName: OPENCODE_TOOL_NAMES.tasks, input: { todos } };
    }
    case 'task':
      return {
        toolName: OPENCODE_TOOL_NAMES.subagent,
        input: defined({ description: str(input.description) ?? 'Subagent', prompt: str(input.prompt) ?? '', subagent_type: str(input.subagent_type) ?? 'opencode' }),
      };
    default: {
      const server = [...mcpServers].sort((a, b) => b.length - a.length).find(name => tool.startsWith(`${name.replace(/[^a-zA-Z0-9_-]/g, '_')}_`));
      if (server) return { toolName: `mcp__${server}__${tool.slice(server.replace(/[^a-zA-Z0-9_-]/g, '_').length + 1)}`, input };
      return { toolName: tool, input };
    }
  }
}

/** A permission ask's call, for a tool the transcript has not seen yet (a command's ask comes before its part). */
function permissionInput(permission: string, patterns: readonly string[], metadata: Input): { tool: string; input: Input } {
  switch (permission) {
    case 'bash':
      return { tool: 'bash', input: { command: str(metadata.command) ?? patterns.join(' ') } };
    case 'edit':
      return { tool: 'edit', input: { filePath: str(metadata.filepath) ?? patterns[0] } };
    case 'webfetch':
      return { tool: 'webfetch', input: { url: str(metadata.url) ?? patterns[0] } };
    default:
      return { tool: permission, input: { patterns: [...patterns], ...metadata } };
  }
}

interface ToolState {
  callId: string;
  toolName: string;
  started: boolean;
  finished: boolean;
}

export interface OpenCodeTurnTranslatorOptions {
  /** The OpenCode session the turn runs in. */
  sessionId: string;
  /** The MCP servers the run configured, so their tools read as `mcp__<server>__<tool>`. */
  mcpServers?: readonly string[];
  /** A planning turn: the text it ends with is the plan a person approves. */
  planning?: boolean;
}

/** What one event changes for the turn. */
export interface OpenCodeTurnUpdate {
  entries: TranscriptEntry[];
  usage?: AgentTokenUsage;
  /** OpenCode asks a person to allow a call: the run parks on it. */
  permission?: { requestId: string; request: PermissionRequest };
  /** OpenCode asks a person a question: the run parks on it as an `AskUserQuestion`. */
  question?: { requestId: string; request: PermissionRequest; questions: OpenCodeQuestion[] };
  /** The session went idle: the turn is over (see {@link OpenCodeTurnTranslator.outcome}). */
  idle?: true;
  /** OpenCode keeps retrying a request no retry gets past (the free allowance ran out): stop the turn. */
  terminal?: OpenCodeError;
}

export interface OpenCodeQuestion {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiple?: boolean;
}

/** One OpenCode turn, fed the server's events in order. */
export class OpenCodeTurnTranslator {
  readonly sessionId: string;
  readonly #mcpServers: readonly string[];
  readonly #planning: boolean;
  /** Child sessions (a `task` subagent's), by the call that started them. */
  readonly #children = new Map<string, string | undefined>();
  readonly #roles = new Map<string, string>();
  readonly #partTypes = new Map<string, string>();
  readonly #streamed = new Set<string>();
  readonly #emittedParts = new Set<string>();
  readonly #tools = new Map<string, ToolState>();
  readonly #answered = new Set<string>();
  #lastText: { messageId: string; text: string } | undefined;
  #error: OpenCodeError | undefined;
  #idle = false;
  #aborted = false;
  #usage: AgentTokenUsage = {};

  constructor(options: OpenCodeTurnTranslatorOptions) {
    this.sessionId = options.sessionId;
    this.#mcpServers = options.mcpServers ?? [];
    this.#planning = options.planning === true;
  }

  get completed(): boolean {
    return this.#idle;
  }

  /** The turn's own session, or a subagent session it started. */
  accepts(sessionId: unknown): boolean {
    return sessionId === this.sessionId || (typeof sessionId === 'string' && this.#children.has(sessionId));
  }

  /** The person answered a call the turn parked on: its card is settled already. */
  answered(toolCallId: string): void {
    this.#answered.add(toolCallId);
  }

  /** The turn was stopped on purpose: the error OpenCode reports for it is not a failure. */
  aborted(): void {
    this.#aborted = true;
  }

  #parent(sessionId: string): string | undefined {
    return sessionId === this.sessionId ? undefined : this.#children.get(sessionId);
  }

  #nest(entries: TranscriptEntry[], sessionId: string): TranscriptEntry[] {
    const parent = this.#parent(sessionId);
    if (!parent) return entries;
    return entries.map(entry => ('toolCallId' in entry || entry.kind === 'text' || entry.kind === 'thinking' ? { ...entry, parentToolCallId: parent } : entry)) as TranscriptEntry[];
  }

  handle(event: OpenCodeEvent): OpenCodeTurnUpdate {
    const p = event.properties;
    switch (event.type) {
      case 'session.created':
      case 'session.updated': {
        const info = record(p.info);
        const id = str(info.id);
        const parent = str(info.parentID);
        if (id && parent && this.accepts(parent) && !this.#children.has(id)) this.#children.set(id, this.#childCall(id));
        return { entries: [] };
      }
      case 'message.updated': {
        if (!this.accepts(p.sessionID)) return { entries: [] };
        const info = record(p.info);
        const id = str(info.id);
        const role = str(info.role);
        if (id && role) this.#roles.set(id, role);
        if (role === 'assistant' && p.sessionID === this.sessionId && info.error && !this.#error) {
          const error = record(info.error) as OpenCodeErrorPayload;
          if (error.name !== 'MessageAbortedError') this.#error = openCodeErrorFrom(error);
        }
        return { entries: [] };
      }
      case 'message.part.updated':
        return this.#part(record(p.part));
      case 'message.part.delta': {
        if (!this.accepts(p.sessionID) || p.sessionID !== this.sessionId) return { entries: [] };
        const partId = str(p.partID);
        const delta = str(p.delta);
        if (!partId || !delta || this.#roles.get(str(p.messageID) ?? '') === 'user') return { entries: [] };
        const type = this.#partTypes.get(partId);
        if (type === 'text') {
          this.#streamed.add(partId);
          return { entries: [{ kind: 'text_delta', text: delta }] };
        }
        if (type === 'reasoning') {
          this.#streamed.add(partId);
          return { entries: [{ kind: 'thinking_delta', text: delta }] };
        }
        return { entries: [] };
      }
      case 'permission.asked':
        return this.#permission(p);
      case 'question.asked':
        return this.#question(p);
      case 'session.status': {
        if (p.sessionID !== this.sessionId) return { entries: [] };
        const status = record(p.status);
        if (status.type === 'retry') {
          const message = str(status.message) ?? '';
          if (isTerminalRetry(message)) {
            const error = openCodeErrorFrom({ data: { message } });
            this.#error ??= error;
            return { entries: [], terminal: error };
          }
        }
        if (status.type === 'idle') return this.#markIdle();
        return { entries: [] };
      }
      case 'session.idle':
        return p.sessionID === this.sessionId ? this.#markIdle() : { entries: [] };
      case 'session.error': {
        if (p.sessionID !== undefined && p.sessionID !== this.sessionId) return { entries: [] };
        const error = record(p.error) as OpenCodeErrorPayload;
        if (error.name === 'MessageAbortedError') return { entries: [] };
        this.#error ??= openCodeErrorFrom(error);
        return { entries: [] };
      }
      default:
        return { entries: [] };
    }
  }

  #markIdle(): OpenCodeTurnUpdate {
    if (this.#idle) return { entries: [] };
    this.#idle = true;
    return { entries: this.#closingEntries(), idle: true };
  }

  /** A subagent session's call: the `task` call whose metadata names it, if one did yet. */
  #childCall(sessionId: string): string | undefined {
    for (const state of this.#tools.values()) if (state.toolName === OPENCODE_TOOL_NAMES.subagent && this.#taskSessions.get(state.callId) === sessionId) return state.callId;
    return undefined;
  }

  readonly #taskSessions = new Map<string, string>();

  #part(part: Input): OpenCodeTurnUpdate {
    const sessionId = str(part.sessionID);
    if (!sessionId || !this.accepts(sessionId)) return { entries: [] };
    const partId = str(part.id);
    const messageId = str(part.messageID) ?? '';
    const type = str(part.type);
    if (partId && type) this.#partTypes.set(partId, type);
    if (this.#roles.get(messageId) === 'user') return { entries: [] };
    switch (type) {
      case 'text': {
        const text = typeof part.text === 'string' ? part.text : '';
        const ended = record(part.time).end !== undefined;
        if (part.synthetic === true || !partId || !ended || !text.trim() || this.#emittedParts.has(partId)) return { entries: [] };
        this.#emittedParts.add(partId);
        if (sessionId === this.sessionId) this.#lastText = { messageId, text };
        // A subagent's words stay in its card, as a Claude Code subagent's do.
        if (sessionId !== this.sessionId) return { entries: [] };
        return { entries: [{ kind: 'text', text, messageId: partId }] };
      }
      case 'reasoning': {
        const text = typeof part.text === 'string' ? part.text : '';
        const ended = record(part.time).end !== undefined;
        if (!partId || !ended || !text.trim() || this.#emittedParts.has(partId) || sessionId !== this.sessionId) return { entries: [] };
        this.#emittedParts.add(partId);
        return { entries: [{ kind: 'thinking', text, messageId: partId }] };
      }
      case 'tool':
        return { entries: this.#nest(this.#tool(part), sessionId) };
      case 'step-finish': {
        if (sessionId !== this.sessionId) return { entries: [] };
        const tokens = record(part.tokens);
        const cache = record(tokens.cache);
        const num = (value: unknown) => (typeof value === 'number' ? value : 0);
        const usage: AgentTokenUsage = {
          promptTokens: num(tokens.input),
          completionTokens: num(tokens.output),
          reasoningTokens: num(tokens.reasoning),
          cachedInputTokens: num(cache.read),
          cacheCreationInputTokens: num(cache.write),
          totalTokens: num(tokens.total) || num(tokens.input) + num(tokens.output) + num(tokens.reasoning) + num(cache.read) + num(cache.write),
        };
        for (const key of Object.keys(usage) as Array<keyof AgentTokenUsage>) this.#usage[key] = (this.#usage[key] ?? 0) + (usage[key] ?? 0);
        return { entries: [], usage };
      }
      default:
        return { entries: [] };
    }
  }

  #tool(part: Input): TranscriptEntry[] {
    const callId = str(part.callID);
    const tool = str(part.tool);
    if (!callId || !tool) return [];
    const state = record(part.state);
    const status = str(state.status);
    const metadata = record(state.metadata);
    // A question is drawn from its `question.asked` (as a card with its options), not from the call.
    if (tool === 'question') {
      if ((status === 'completed' || status === 'error') && !this.#tools.get(callId)?.finished) {
        this.#tools.set(callId, { callId, toolName: ASK_USER_QUESTION_TOOL, started: true, finished: true });
        return [{ kind: 'tool_result', toolCallId: callId, content: str(state.output) ?? str(state.error) ?? '', isError: status === 'error' }];
      }
      return [];
    }
    if (tool === 'task' && str(metadata.sessionId)) {
      const child = str(metadata.sessionId)!;
      this.#taskSessions.set(callId, child);
      this.#children.set(child, callId);
    }
    let known = this.#tools.get(callId);
    const entries: TranscriptEntry[] = [];
    const hasInput = Object.keys(record(state.input)).length > 0;
    if (!known) {
      known = { callId, toolName: openCodeToolCall(tool, state.input, this.#mcpServers).toolName, started: false, finished: false };
      this.#tools.set(callId, known);
    }
    if (!known.started && (hasInput || status === 'completed' || status === 'error')) {
      const call = openCodeToolCall(tool, state.input, this.#mcpServers);
      known.started = true;
      known.toolName = call.toolName;
      entries.push({ kind: 'tool_call', toolCallId: callId, toolName: call.toolName, input: call.input });
    }
    if (!known.finished && (status === 'completed' || status === 'error')) {
      known.finished = true;
      if (status === 'completed') {
        const output = known.toolName === OPENCODE_TOOL_NAMES.tasks ? 'Plan updated.' : (str(state.output) ?? '');
        entries.push({ kind: 'tool_result', toolCallId: callId, content: output, isError: false });
      } else {
        entries.push({ kind: 'tool_result', toolCallId: callId, content: str(state.error) ?? 'The call failed.', isError: true });
      }
    }
    return entries;
  }

  #permission(p: Input): OpenCodeTurnUpdate {
    const sessionId = str(p.sessionID);
    const requestId = str(p.id);
    if (!sessionId || !requestId || !this.accepts(sessionId)) return { entries: [] };
    const permission = str(p.permission) ?? 'tool';
    const patterns = Array.isArray(p.patterns) ? p.patterns.filter((value): value is string => typeof value === 'string') : [];
    const metadata = record(p.metadata);
    const callId = str(record(p.tool).callID) ?? `permission-${requestId}`;
    const known = this.#tools.get(callId);
    const entries: TranscriptEntry[] = [];
    let toolName: string;
    let input: Input;
    if (known?.started) {
      toolName = known.toolName;
      input = {};
    } else {
      const asked = permissionInput(permission, patterns, metadata);
      const call = openCodeToolCall(asked.tool, asked.input, this.#mcpServers);
      toolName = call.toolName;
      input = call.input;
      this.#tools.set(callId, { callId, toolName, started: true, finished: false });
      entries.push({ kind: 'tool_call', toolCallId: callId, toolName, input });
    }
    // The diff OpenCode shows with an edit's ask goes with the card, so the person sees what they allow.
    if (typeof metadata.diff === 'string') input = { ...input, diff: metadata.diff };
    const parent = this.#parent(sessionId);
    const request: PermissionRequest = { toolCallId: callId, toolName, input, ...(parent ? { parentToolCallId: parent } : {}) };
    entries.push({ kind: 'permission', ...request });
    return { entries: this.#nest(entries, sessionId), permission: { requestId, request } };
  }

  #question(p: Input): OpenCodeTurnUpdate {
    const sessionId = str(p.sessionID);
    const requestId = str(p.id);
    if (!sessionId || !requestId || !this.accepts(sessionId)) return { entries: [] };
    const questions: OpenCodeQuestion[] = (Array.isArray(p.questions) ? p.questions : []).map(record).flatMap(question => {
      const text = str(question.question);
      if (!text) return [];
      const options = (Array.isArray(question.options) ? question.options : []).map(record).flatMap(option => {
        const label = str(option.label);
        return label ? [{ label, ...(str(option.description) ? { description: str(option.description)! } : {}) }] : [];
      });
      return [{ question: text, ...(str(question.header) ? { header: str(question.header)! } : {}), ...(options.length ? { options } : {}), ...(question.multiple === true ? { multiple: true } : {}) }];
    });
    const callId = str(record(p.tool).callID) ?? `question-${requestId}`;
    this.#tools.set(callId, { callId, toolName: ASK_USER_QUESTION_TOOL, started: true, finished: false });
    // `AskUserQuestion`'s own input, so the chat's question card reads it as it reads Claude Code's.
    const input = {
      questions: questions.map(question => ({
        question: question.question,
        ...(question.header ? { header: question.header } : {}),
        ...(question.options ? { options: question.options } : {}),
        ...(question.multiple ? { multiSelect: true } : {}),
      })),
    };
    const parent = this.#parent(sessionId);
    const request: PermissionRequest = { toolCallId: callId, toolName: ASK_USER_QUESTION_TOOL, input, ...(parent ? { parentToolCallId: parent } : {}) };
    return {
      entries: this.#nest([{ kind: 'tool_call', toolCallId: callId, toolName: ASK_USER_QUESTION_TOOL, input }, { kind: 'permission', ...request }], sessionId),
      question: { requestId, request, questions },
    };
  }

  /** What the turn adds once it is over: the plan a planning turn wrote. */
  #closingEntries(): TranscriptEntry[] {
    const gate = this.planGate;
    if (!gate || this.#error || this.#aborted) return [];
    return [
      { kind: 'tool_call', toolCallId: gate.toolCallId, toolName: OPENCODE_TOOL_NAMES.plan, input: { plan: gate.plan, ...(gate.title ? { title: gate.title } : {}) } },
      { kind: 'plan', ...gate },
    ];
  }

  /** The plan a planning turn wrote: its last words, as a gate; only meaningful once the turn is idle. */
  get planGate(): PlanGate | undefined {
    if (!this.#planning || !this.#lastText?.text.trim()) return undefined;
    const plan = this.#lastText.text;
    const title = /^#+\s*(.+)$/m.exec(plan)?.[1]?.trim();
    return { toolCallId: `${this.#lastText.messageId}:submit_plan`, toolName: OPENCODE_PLAN_GATE_TOOL, plan, ...(title ? { title } : {}) };
  }

  /** The turn's tokens so far, summed over its model steps. */
  get usage(): AgentTokenUsage {
    return { ...this.#usage };
  }

  /** How the turn went once its session went idle (or the run stopped waiting for it). */
  outcome(): OpenCodeTurnOutcome {
    if (this.#aborted) return { kind: 'aborted' };
    if (this.#error) return { kind: 'error', error: this.#error };
    if (!this.#idle) return { kind: 'error', error: new OpenCodeError('process', 'OpenCode stopped before the turn completed.') };
    const gate = this.planGate;
    if (gate) return { kind: 'gate', gate };
    return { kind: 'complete', ...(this.#lastText ? { text: this.#lastText.text } : {}) };
  }

  /** The turn failed outside its events (the stream or the server went away). */
  fail(error: OpenCodeError): void {
    this.#error ??= error;
  }
}
