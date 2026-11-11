// One Codex turn as the Factory transcript: the app-server's item and delta notifications become
// transcript entries (text, reasoning, tool calls and their results, the plan list as the task
// panel, subagents as Claude Code's `Agent` calls with their own work nested under them), its
// approvals, questions and MCP forms become parked gates, and its completion the turn's outcome.
import type { AgentTokenUsage } from '@factory/harness';
import type { ElicitationPlan } from '@factory/harness/elicitation';
import { ASK_USER_QUESTION_TOOL, type PermissionRequest, type PlanGate, type TranscriptEntry } from '@factory/harness/transcript';

import { CodexError, codexErrorFromTurn } from './errors.ts';
import type {
  CollabAgentState,
  CommandExecutionRequestApprovalParams,
  ErrorNotification,
  FileChangeRequestApprovalParams,
  FileUpdateChange,
  ItemNotification,
  PermissionsRequestApprovalParams,
  ThreadItem,
  CommandAction,
  ThreadTokenUsageUpdatedNotification,
  ToolRequestUserInputParams,
  TurnCompletedNotification,
  TurnPlanUpdatedNotification,
  WebSearchAction,
} from './protocol/schema.ts';
import {
  accumulateCodexTurnTokenUsage,
  completeCodexTurnTokenUsage,
  makeCodexTurnTokenUsageState,
  toAgentTokenUsage,
  type CodexTurnTokenUsageState,
} from './tokenUsage.ts';

/** The tool names Codex's work is recorded under: the Factory's own (Mastra) tool names, so the chat draws them as usual. */
export const CODEX_TOOL_NAMES = {
  command: 'execute_command',
  /** A command Codex parsed as one file read, listing or search: drawn as the Factory's own file tools, as Claude Code's `Read`, `LS` and `Grep` are. */
  readFile: 'view',
  listFiles: 'list_files',
  search: 'search_content',
  writeFile: 'write_file',
  editFile: 'string_replace_lsp',
  deleteFile: 'delete_file',
  webSearch: 'web_search',
  viewImage: 'view',
  /** The plan list (`update_plan`), shown as the chat's task panel. */
  tasks: 'task_write',
  /** A plan submitted for approval (plan mode's plan). */
  plan: 'submit_plan',
  /** Extra sandbox permissions Codex asks for. */
  permissions: 'request_permissions',
  /** Writing to or reading from a terminal a command left running (Claude Code's `BashOutput`). */
  processOutput: 'get_process_output',
  /** A subagent, under the name Claude Code gives its own, so the chat's subagent card follows it. */
  subagent: 'Agent',
  /** An image Codex generated. */
  generateImage: 'generate_image',
} as const;

/** The contract's name for a plan gate, so the dispatcher's plan handling applies unchanged. */
export const CODEX_PLAN_GATE_TOOL = 'submit_plan';

export type CodexTurnOutcome =
  | { kind: 'complete'; text?: string }
  | { kind: 'gate'; gate: PlanGate }
  | { kind: 'aborted' }
  | { kind: 'error'; error: CodexError };

/** An MCP tool as the transcript names it: `mcp__<server>__<tool>`, as Claude Code names one. */
export function codexMcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

function textOf(content: ReadonlyArray<unknown> | null | undefined): string {
  return (content ?? [])
    .map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') return (part as { text: string }).text;
      return JSON.stringify(part);
    })
    .join('\n');
}

function compactStrings(values: ReadonlyArray<string | null | undefined>): string[] {
  return values.flatMap(value => {
    const trimmed = value?.trim();
    return trimmed ? [trimmed] : [];
  });
}

function webSearchPatterns(query: string, action: WebSearchAction | null | undefined): string[] {
  if (!action) return compactStrings([query]);
  switch (action.type) {
    case 'search':
      return compactStrings([...(action.queries ?? []), action.query, query]);
    case 'openPage':
      return compactStrings([action.url, query]);
    case 'findInPage':
      return compactStrings([action.pattern, action.url, query]);
    default:
      return compactStrings([query]);
  }
}

const TASK_STATUS: Record<string, 'pending' | 'in_progress' | 'completed'> = {
  pending: 'pending',
  inProgress: 'in_progress',
  completed: 'completed',
};

/**
 * A command's call: one Codex parsed as a single read, listing or search is drawn as the Factory's
 * file tool for it (with the command kept), anything else as a command.
 */
export function codexCommandCall(command: {
  command: string;
  cwd?: string;
  commandActions?: ReadonlyArray<CommandAction> | null;
  processId?: string | null;
  source?: string | null;
}): {
  toolName: string;
  input: Record<string, unknown>;
} {
  const base = { command: command.command, ...(command.cwd ? { cwd: command.cwd } : {}) };
  // A call to a terminal a command left running reads as Claude Code's `BashOutput` of a background shell.
  if (command.source === 'unifiedExecInteraction' && command.processId) {
    return { toolName: CODEX_TOOL_NAMES.processOutput, input: { pid: command.processId, ...base } };
  }
  const [action, ...more] = command.commandActions ?? [];
  if (!action || more.length > 0) return { toolName: CODEX_TOOL_NAMES.command, input: base };
  switch (action.type) {
    case 'read':
      return { toolName: CODEX_TOOL_NAMES.readFile, input: { ...base, path: action.path } };
    case 'listFiles':
      return { toolName: CODEX_TOOL_NAMES.listFiles, input: { ...base, ...(action.path ? { path: action.path } : {}) } };
    case 'search':
      return {
        toolName: CODEX_TOOL_NAMES.search,
        input: { ...base, ...(action.query ? { pattern: action.query } : {}), ...(action.path ? { path: action.path } : {}) },
      };
    default:
      return { toolName: CODEX_TOOL_NAMES.command, input: base };
  }
}

/** A new file's content: Codex sends the file itself, or (from older CLIs) a diff of `+` lines. */
function addedFileContent(diff: string): string {
  const lines = diff.split('\n');
  const diffShaped = lines.every(line => line === '' || line.startsWith('+')) && !lines.some(line => line.startsWith('+++'));
  return diffShaped ? lines.map(line => line.slice(1)).join('\n') : diff;
}

/**
 * A file change's call: one per changed file, under the Factory's file tool for its kind. A new
 * file carries its content (Codex's `diff` of an add is the file), an edit its unified diff, as
 * the chat's edit card draws them.
 */
function fileChangeCall(change: FileUpdateChange): { toolName: string; input: Record<string, unknown> } {
  switch (change.kind.type) {
    case 'add':
      return { toolName: CODEX_TOOL_NAMES.writeFile, input: { path: change.path, content: addedFileContent(change.diff) } };
    case 'delete':
      return { toolName: CODEX_TOOL_NAMES.deleteFile, input: { path: change.path } };
    default:
      return {
        toolName: CODEX_TOOL_NAMES.editFile,
        input: { path: change.path, diff: change.diff, ...(change.kind.move_path ? { move_path: change.kind.move_path } : {}), ...lineCounts(change) },
      };
  }
}

/** How many lines a unified diff adds and removes (file headers aside). */
export function codexDiffLineCounts(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

/**
 * The edit card of a file change a person is asked to allow: every file's diff in one, each under
 * a `@@ <kind> <path> @@` line (the card draws `@@` lines as section headers), with the line counts.
 */
export function codexFileChangeApprovalInput(changes: ReadonlyArray<FileUpdateChange>): Record<string, unknown> {
  const [first] = changes;
  if (!first) return {};
  if (changes.length === 1) return { ...fileChangeCall(first).input, ...lineCounts(first) };
  const diff = changes
    .map(change => {
      const body = change.kind.type === 'add' && !change.diff.split('\n').every(line => line === '' || line.startsWith('+'))
        ? change.diff.split('\n').map(line => `+${line}`).join('\n')
        : change.diff;
      return [`@@ ${change.kind.type} ${change.path} @@`, body].filter(Boolean).join('\n');
    })
    .join('\n');
  const counts = codexDiffLineCounts(diff);
  return { path: first.path, paths: changes.map(change => change.path), diff, added_lines: counts.added, removed_lines: counts.removed };
}

function lineCounts(change: FileUpdateChange): { added_lines?: number; removed_lines?: number } {
  if (change.kind.type === 'delete' || !change.diff) return {};
  if (change.kind.type === 'add') {
    const content = addedFileContent(change.diff);
    return { added_lines: content === '' ? 0 : content.replace(/\n$/, '').split('\n').length, removed_lines: 0 };
  }
  const counts = codexDiffLineCounts(change.diff);
  return { added_lines: counts.added, removed_lines: counts.removed };
}

/** A file change approval's prompt: why, and which files. */
export function codexFileChangeApprovalPrompt(input: { reason?: string | null; changes?: ReadonlyArray<FileUpdateChange> }): string {
  const reason = input.reason?.trim();
  const files = [...(input.changes ?? [])].map(change => `${change.kind.type} ${change.path}`).sort();
  return [reason, files.length ? `Files:\n${files.join('\n')}` : undefined].filter(Boolean).join('\n\n') || 'Codex wants to change files.';
}

/** Which kind of access an extra-permissions request asks for. */
function permissionsRequestKind(permissions: PermissionsRequestApprovalParams['permissions']): 'file-change' | 'file-read' | 'command' {
  // Codex leaves the legacy `read`/`write` lists out when a path is a glob or special path, and is replacing them with `entries`.
  const requests = (access: 'read' | 'write') =>
    (permissions.fileSystem?.[access]?.length ?? 0) > 0 || permissions.fileSystem?.entries?.some(entry => entry.access === access) === true;
  if (requests('write')) return 'file-change';
  if (requests('read')) return 'file-read';
  return 'command';
}

/** What a person is asked to allow, as the transcript records the call. */
export type CodexApprovalRequest =
  | { kind: 'command'; params: CommandExecutionRequestApprovalParams }
  | { kind: 'fileChange'; params: FileChangeRequestApprovalParams }
  | { kind: 'permissions'; params: PermissionsRequestApprovalParams };

/** Said under a question Codex marked secret: the card cannot hide what the person types. */
export const CODEX_SECRET_ANSWER_NOTE = 'The answer is kept in the chat like any other; do not paste a password or key here.';

/**
 * The `AskUserQuestion` input a `request_user_input` reads as, so the chat's question card shows it.
 * The card always takes an answer in the person's own words, so Codex's `isOther` needs nothing more.
 */
export function codexQuestionInput(params: ToolRequestUserInputParams): { questions: Array<Record<string, unknown>> } {
  return {
    questions: params.questions.map(question => ({
      id: question.id,
      question: question.isSecret ? `${question.question}\n\n${CODEX_SECRET_ANSWER_NOTE}` : question.question,
      ...(question.header ? { header: question.header } : {}),
      ...(question.options?.length ? { options: question.options.map(option => ({ label: option.label, ...(option.description ? { description: option.description } : {}) })) } : {}),
    })),
  };
}

/** A subagent a turn started: the `Agent` call that stands for it, and how far it got. */
interface Subagent {
  /** The `Agent` call it is drawn under. */
  callId: string;
  /** The top-level `Agent` call its work nests under (its own, or its spawner's for a subagent's subagent). */
  root: string;
  /** Set when it was started by another subagent: the call is part of that one's work. */
  parent?: string;
  settled: boolean;
  /** What it said last: its result, when Codex reports none. */
  text?: string;
}

/** The subagent's lifecycle states that end it, and whether they are a failure. */
const SUBAGENT_DONE: Record<string, boolean> = { completed: false, interrupted: false, shutdown: false, errored: true, notFound: true };

/** The first line of a subagent's prompt, as its card's title. */
function subagentDescription(prompt: string | null | undefined, fallback: string): string {
  const line = prompt?.trim().split('\n')[0]?.trim();
  if (!line) return fallback;
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

/** A tool's work as the transcript reads it: under a subagent's call when a subagent did it. */
type Scope = { key: (itemId: string) => string; parent?: string; child?: Subagent; threadId?: string };

/**
 * Follows one Codex turn: builds the transcript as notifications arrive and decides at the end how
 * the turn went. A call the person answered while the turn waited is settled by that answer; when
 * Codex then runs it, it is recorded again as a call of its own, so its output is kept. Subagent
 * threads a collab call started belong to the turn too: their work is recorded under the subagent's
 * `Agent` call (`parentToolCallId`), as Claude Code's subagents are.
 */
export class CodexTurnTranslator {
  readonly threadId: string;
  turnId: string | undefined;
  readonly #usage: CodexTurnTokenUsageState;
  /** Tool calls recorded under a transcript id, by item key (a re-run call gets a new one). */
  readonly #callIds = new Map<string, string[]>();
  /** Items whose call a person answered: Codex runs them after, as calls of their own. */
  readonly #answered = new Set<string>();
  /** Answered items Codex went on to run: their calls are recorded under new ids. */
  readonly #rerun = new Set<string>();
  readonly #fileChanges = new Map<string, ReadonlyArray<FileUpdateChange>>();
  /** Subagent threads this turn started, by their Codex thread id. */
  readonly #subagents = new Map<string, Subagent>();
  #planUpdates = 0;
  #planText: string | undefined;
  #planItemId: string | undefined;
  #finalText: string | undefined;
  #error: CodexError | undefined;
  #completed: TurnCompletedNotification['turn'] | undefined;
  /** Text streamed per agent message, so its completed item only adds what deltas did not show. */
  readonly #streamed = new Map<string, string>();
  readonly #reasoningStreamed = new Set<string>();

  constructor(input: { threadId: string; usage?: CodexTurnTokenUsageState }) {
    this.threadId = input.threadId;
    this.#usage = input.usage ?? makeCodexTurnTokenUsageState();
  }

  /** The turn Codex started: notifications of other turns are not this one's. */
  begin(turnId: string): void {
    this.turnId = turnId;
    this.#usage.activeTurnId = turnId;
  }

  get completed(): boolean {
    return this.#completed !== undefined;
  }

  /** Whether a notification belongs to this turn (its own thread; a subagent's is {@link accepts}'). */
  owns(payload: { threadId?: string; turnId?: string }): boolean {
    if (payload.threadId !== undefined && payload.threadId !== this.threadId) return false;
    return this.turnId === undefined || payload.turnId === undefined || payload.turnId === this.turnId;
  }

  /** Whether a notification or request is this turn's: its own, or one of a subagent it started. */
  accepts(payload: { threadId?: string; turnId?: string | null }): boolean {
    if (payload.threadId !== undefined && this.#subagents.has(payload.threadId)) return true;
    return this.owns({ ...(payload.threadId !== undefined ? { threadId: payload.threadId } : {}), ...(payload.turnId ? { turnId: payload.turnId } : {}) });
  }

  /** Whether the thread is one of this turn's subagents. */
  isSubagent(threadId: string | undefined): boolean {
    return threadId !== undefined && this.#subagents.has(threadId);
  }

  #scope(threadId: string | undefined): Scope {
    const child = threadId !== undefined && threadId !== this.threadId ? this.#subagents.get(threadId) : undefined;
    if (!child) return { key: itemId => itemId };
    return { key: itemId => `${threadId}:${itemId}`, parent: child.root, child, threadId: threadId! };
  }

  /** Entries a subagent produced, marked as its call's work. */
  #nest(entries: TranscriptEntry[], scope: Scope): TranscriptEntry[] {
    const parent = scope.parent;
    if (!parent) return entries;
    return entries.map(entry => (entry.kind === 'plan' || entry.kind === 'input' || entry.kind === 'init' || entry.kind === 'credential' || entry.kind === 'result' || entry.kind === 'stdout' || entry.kind === 'plan_decision' || entry.kind === 'permission_decision' || entry.kind === 'question_answer' ? entry : { ...entry, parentToolCallId: parent }));
  }

  #callId(key: string, index = 0): string {
    const ids = this.#callIds.get(key) ?? [];
    let id = ids[index];
    if (!id) {
      id = this.#rerun.has(key) ? `${key}:${index}:run` : index === 0 ? key : `${key}:${index}`;
      ids[index] = id;
      this.#callIds.set(key, ids);
    }
    return id;
  }

  #started(key: string): boolean {
    return (this.#callIds.get(key)?.length ?? 0) > 0;
  }

  /** Whether an item's call must be recorded (again): never announced, or answered and now run. */
  #announce(key: string): boolean {
    if (this.#answered.delete(key)) {
      this.#rerun.add(key);
      this.#callIds.delete(key);
      return true;
    }
    return !this.#started(key);
  }

  /** The call entries a completed item needs first when its start was never recorded. */
  #ensureStarted(item: ThreadItem, scope: Scope): TranscriptEntry[] {
    return this.#announce(scope.key(item.id)) ? this.#startEntries(item, scope) : [];
  }

  itemStarted({ item, threadId }: ItemNotification): TranscriptEntry[] {
    const scope = this.#scope(threadId);
    if (item.type === 'fileChange') this.#fileChanges.set(scope.key(item.id), (item as Extract<ThreadItem, { type: 'fileChange' }>).changes);
    if (!['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch'].includes(item.type)) return [];
    return this.#nest(this.#announce(scope.key(item.id)) ? this.#startEntries(item, scope) : [], scope);
  }

  #startEntries(item: ThreadItem, scope: Scope): TranscriptEntry[] {
    const key = scope.key(item.id);
    switch (item.type) {
      case 'commandExecution': {
        const command = item as Extract<ThreadItem, { type: 'commandExecution' }>;
        return [{ kind: 'tool_call', toolCallId: this.#callId(key), ...codexCommandCall(command) }];
      }
      case 'fileChange': {
        const change = item as Extract<ThreadItem, { type: 'fileChange' }>;
        return change.changes.map((file, index) => ({ kind: 'tool_call' as const, toolCallId: this.#callId(key, index), ...fileChangeCall(file) }));
      }
      case 'mcpToolCall': {
        const call = item as Extract<ThreadItem, { type: 'mcpToolCall' }>;
        return [{ kind: 'tool_call', toolCallId: this.#callId(key), toolName: codexMcpToolName(call.server, call.tool), input: call.arguments }];
      }
      case 'dynamicToolCall': {
        const call = item as Extract<ThreadItem, { type: 'dynamicToolCall' }>;
        return [{ kind: 'tool_call', toolCallId: this.#callId(key), toolName: call.namespace ? `${call.namespace}.${call.tool}` : call.tool, input: call.arguments }];
      }
      case 'webSearch': {
        const search = item as Extract<ThreadItem, { type: 'webSearch' }>;
        return [{ kind: 'tool_call', toolCallId: this.#callId(key), toolName: CODEX_TOOL_NAMES.webSearch, input: { query: search.query } }];
      }
      default:
        return [];
    }
  }

  itemCompleted({ item, threadId }: ItemNotification): TranscriptEntry[] {
    const scope = this.#scope(threadId);
    return this.#nest(this.#completedEntries(item, scope), scope);
  }

  #completedEntries(item: ThreadItem, scope: Scope): TranscriptEntry[] {
    const key = scope.key(item.id);
    switch (item.type) {
      case 'agentMessage': {
        const message = item as Extract<ThreadItem, { type: 'agentMessage' }>;
        if (scope.child) scope.child.text = message.text || scope.child.text;
        else this.#finalText = message.text;
        const streamed = this.#streamed.get(key) ?? '';
        this.#streamed.delete(key);
        // The full block confirms what streamed (the chat replaces the streamed part with it).
        return message.text || streamed ? [{ kind: 'text', text: message.text || streamed, messageId: item.id }] : [];
      }
      case 'reasoning': {
        const reasoning = item as Extract<ThreadItem, { type: 'reasoning' }>;
        const text = [...(reasoning.summary ?? [])].join('\n\n').trim() || [...(reasoning.content ?? [])].join('\n\n').trim();
        this.#reasoningStreamed.delete(key);
        return text ? [{ kind: 'thinking', text, messageId: item.id }] : [];
      }
      case 'plan': {
        // A subagent's plan is its own working note, not the turn's plan.
        if (scope.child) return [];
        const plan = item as Extract<ThreadItem, { type: 'plan' }>;
        this.#planText = plan.text;
        this.#planItemId = item.id;
        return [];
      }
      case 'commandExecution': {
        const command = item as Extract<ThreadItem, { type: 'commandExecution' }>;
        const started = this.#ensureStarted(item, scope);
        const output = (command.aggregatedOutput ?? '').trimEnd();
        const exit = typeof command.exitCode === 'number' ? `Exit code ${command.exitCode}` : undefined;
        const declined = command.status === 'declined';
        // A command that left its terminal running reads as Claude Code's background `Bash`: it goes on, by its process id.
        const running = command.status === 'inProgress' && command.processId ? `Still running in the background (process ${command.processId}).` : undefined;
        return [
          ...started,
          {
            kind: 'tool_result',
            toolCallId: this.#callId(key),
            content: declined ? 'Declined.' : [output, exit, running].filter(Boolean).join('\n\n'),
            isError: command.status === 'failed' || declined || (typeof command.exitCode === 'number' && command.exitCode !== 0),
          },
        ];
      }
      case 'fileChange': {
        const change = item as Extract<ThreadItem, { type: 'fileChange' }>;
        const started = this.#ensureStarted(item, scope);
        const isError = change.status === 'failed' || change.status === 'declined';
        return [
          ...started,
          ...change.changes.map((file, index) => ({
            kind: 'tool_result' as const,
            toolCallId: this.#callId(key, index),
            content: change.status === 'declined' ? 'Declined.' : isError ? `Could not ${file.kind.type} ${file.path}.` : `${file.kind.type === 'add' ? 'Created' : file.kind.type === 'delete' ? 'Deleted' : 'Updated'} ${file.path}.`,
            isError,
          })),
        ];
      }
      case 'mcpToolCall': {
        const call = item as Extract<ThreadItem, { type: 'mcpToolCall' }>;
        const started = this.#ensureStarted(item, scope);
        const content = call.error?.message ?? (call.result ? textOf(call.result.content) || JSON.stringify(call.result.structuredContent ?? '') : '');
        return [...started, { kind: 'tool_result', toolCallId: this.#callId(key), content, isError: call.status === 'failed' || call.error != null }];
      }
      case 'dynamicToolCall': {
        const call = item as Extract<ThreadItem, { type: 'dynamicToolCall' }>;
        const started = this.#ensureStarted(item, scope);
        return [
          ...started,
          { kind: 'tool_result', toolCallId: this.#callId(key), content: textOf(call.contentItems ?? []), isError: call.status === 'failed' || call.success === false },
        ];
      }
      case 'webSearch': {
        const search = item as Extract<ThreadItem, { type: 'webSearch' }>;
        const started = this.#ensureStarted(item, scope);
        return [...started, { kind: 'tool_result', toolCallId: this.#callId(key), content: webSearchPatterns(search.query, search.action).join('\n'), isError: false }];
      }
      case 'imageView': {
        const view = item as Extract<ThreadItem, { type: 'imageView' }>;
        const toolCallId = this.#callId(key);
        return [
          { kind: 'tool_call', toolCallId, toolName: CODEX_TOOL_NAMES.viewImage, input: { path: view.path } },
          { kind: 'tool_result', toolCallId, content: view.path, isError: false },
        ];
      }
      case 'imageGeneration': {
        const image = item as Extract<ThreadItem, { type: 'imageGeneration' }>;
        const toolCallId = this.#callId(key);
        const failed = image.failure != null || image.status === 'failed' || !image.savedPath;
        const reason = image.failure?.type === 'usageLimitExceeded' ? 'Image generation is out of usage for now.' : 'The image was not generated.';
        return [
          { kind: 'tool_call', toolCallId, toolName: CODEX_TOOL_NAMES.generateImage, input: { ...(image.revisedPrompt ? { prompt: image.revisedPrompt } : {}) } },
          { kind: 'tool_result', toolCallId, content: failed ? reason : `Saved the image to ${image.savedPath}.`, isError: failed },
        ];
      }
      case 'collabAgentToolCall':
        return this.#collab(item as Extract<ThreadItem, { type: 'collabAgentToolCall' }>, scope);
      case 'subAgentActivity':
        return this.#subagentActivity(item as Extract<ThreadItem, { type: 'subAgentActivity' }>, scope);
      default:
        return [];
    }
  }

  /** A subagent the turn (or one of its subagents) started: its `Agent` call, under which its work is recorded. */
  #spawn(threadId: string, callId: string, input: Record<string, unknown>, scope: Scope): TranscriptEntry[] {
    if (this.#subagents.has(threadId)) return [];
    const nested = scope.child;
    this.#subagents.set(threadId, { callId, root: nested ? nested.root : callId, ...(nested ? { parent: nested.root } : {}), settled: false });
    return [{ kind: 'tool_call', toolCallId: callId, toolName: CODEX_TOOL_NAMES.subagent, input }];
  }

  /** A subagent finished: its `Agent` call's result is what it said (or Codex's report of it). */
  #settle(threadId: string, outcome: { message?: string | null; isError?: boolean; note?: string }): TranscriptEntry[] {
    const subagent = this.#subagents.get(threadId);
    if (!subagent || subagent.settled) return [];
    subagent.settled = true;
    const content = outcome.message?.trim() || subagent.text?.trim() || outcome.note || 'The subagent finished.';
    return [{ kind: 'tool_result', toolCallId: subagent.callId, content, isError: outcome.isError === true }];
  }

  /** Collab calls: `spawnAgent` starts subagents (one `Agent` call each); any call reports their states. */
  #collab(item: Extract<ThreadItem, { type: 'collabAgentToolCall' }>, scope: Scope): TranscriptEntry[] {
    const entries: TranscriptEntry[] = [];
    if (item.tool === 'spawnAgent') {
      const receivers = item.receiverThreadIds ?? [];
      if (receivers.length === 0 && item.status === 'failed') {
        const toolCallId = this.#callId(scope.key(item.id));
        entries.push(
          { kind: 'tool_call', toolCallId, toolName: CODEX_TOOL_NAMES.subagent, input: { description: subagentDescription(item.prompt, 'Subagent'), prompt: item.prompt ?? '', subagent_type: 'codex' } },
          { kind: 'tool_result', toolCallId, content: 'Codex could not start the subagent.', isError: true },
        );
      }
      receivers.forEach((threadId, index) => {
        const base = this.#callId(scope.key(item.id));
        const callId = receivers.length === 1 ? base : `${base}:${index}`;
        entries.push(
          ...this.#spawn(
            threadId,
            callId,
            {
              description: subagentDescription(item.prompt, 'Subagent'),
              prompt: item.prompt ?? '',
              subagent_type: 'codex',
              ...(item.model ? { model: item.model } : {}),
            },
            scope,
          ),
        );
      });
    }
    // `wait` (and the rest) report where each subagent is: a finished one settles its call.
    for (const [threadId, state] of Object.entries(item.agentsStates ?? {}) as Array<[string, CollabAgentState]>) {
      const isError = SUBAGENT_DONE[state.status];
      if (isError === undefined) continue;
      entries.push(...this.#nested(threadId, this.#settle(threadId, { message: state.message, isError, note: `The subagent ${state.status}.` })));
    }
    return entries;
  }

  /** The multi-agent v2 lifecycle: a subagent starts (its `Agent` call), is done or interrupted (its result). */
  #subagentActivity(item: Extract<ThreadItem, { type: 'subAgentActivity' }>, scope: Scope): TranscriptEntry[] {
    const name = item.agentPath.split('/').filter(Boolean).at(-1) ?? 'subagent';
    if (item.kind === 'started') {
      return this.#spawn(
        item.agentThreadId,
        this.#callId(scope.key(item.id)),
        { description: name.replaceAll('_', ' '), prompt: '', subagent_type: name, ...(item.model ? { model: item.model } : {}) },
        scope,
      );
    }
    if (item.kind === 'completed') return this.#nested(item.agentThreadId, this.#settle(item.agentThreadId, {}));
    if (item.kind === 'interrupted') return this.#nested(item.agentThreadId, this.#settle(item.agentThreadId, { note: 'The subagent was interrupted.' }));
    return [];
  }

  /**
   * A subagent's result entries: at the top level as they are, or (for a subagent's subagent) as its
   * spawner's work. Already nested entries are left to the caller's own nesting.
   */
  #nested(threadId: string, entries: TranscriptEntry[]): TranscriptEntry[] {
    const subagent = this.#subagents.get(threadId);
    if (!subagent?.parent) return entries;
    return entries.map(entry => ({ ...entry, parentToolCallId: subagent.parent }) as TranscriptEntry);
  }

  /** A subagent's turn ended: its call settles with what it said, unless Codex reported it already. */
  subagentTurnCompleted(payload: TurnCompletedNotification): TranscriptEntry[] {
    const subagent = this.#subagents.get(payload.threadId);
    if (!subagent) return [];
    for (const item of payload.turn.items ?? []) {
      if (item.type === 'agentMessage') subagent.text = (item as Extract<ThreadItem, { type: 'agentMessage' }>).text || subagent.text;
    }
    const status = payload.turn.status;
    const outcome =
      status === 'failed'
        ? { isError: true, message: payload.turn.error?.message ?? 'The subagent failed.' }
        : status === 'interrupted'
          ? { note: 'The subagent was interrupted.' }
          : {};
    return this.#nested(payload.threadId, this.#settle(payload.threadId, outcome));
  }

  agentMessageDelta(payload: { threadId?: string; itemId: string; delta: string }): TranscriptEntry[] {
    const scope = this.#scope(payload.threadId);
    const key = scope.key(payload.itemId);
    this.#streamed.set(key, (this.#streamed.get(key) ?? '') + payload.delta);
    return this.#nest(payload.delta ? [{ kind: 'text_delta', text: payload.delta }] : [], scope);
  }

  reasoningDelta(payload: { threadId?: string; itemId: string; delta: string }): TranscriptEntry[] {
    const scope = this.#scope(payload.threadId);
    this.#reasoningStreamed.add(scope.key(payload.itemId));
    // A subagent's reasoning stays out of the chat, as a Claude Code subagent's does.
    if (scope.child) return [];
    return payload.delta ? [{ kind: 'thinking_delta', text: payload.delta }] : [];
  }

  /** The plan list (`update_plan`): a whole new task list each time, as the chat's task panel reads it. */
  planUpdated(payload: TurnPlanUpdatedNotification): TranscriptEntry[] {
    this.#planUpdates += 1;
    const toolCallId = `${payload.turnId}:plan:${this.#planUpdates}`;
    const todos = payload.plan.map(step => ({ content: step.step, status: TASK_STATUS[step.status] ?? 'pending', activeForm: step.step }));
    return [
      { kind: 'tool_call', toolCallId, toolName: CODEX_TOOL_NAMES.tasks, input: { todos, ...(payload.explanation ? { explanation: payload.explanation } : {}) } },
      { kind: 'tool_result', toolCallId, content: 'Plan updated.', isError: false },
    ];
  }

  /** Token usage the update added to this turn, as a `usage_update` step. */
  tokenUsage(payload: ThreadTokenUsageUpdatedNotification): AgentTokenUsage | undefined {
    const step = accumulateCodexTurnTokenUsage(this.#usage, payload.turnId, payload.tokenUsage);
    return step ? toAgentTokenUsage(step) : undefined;
  }

  /** An error Codex will not retry ends the turn as failed; one it retries is only progress. */
  error(payload: ErrorNotification): void {
    if (!payload.willRetry) this.#error = codexErrorFromTurn(payload.error);
  }

  /**
   * A call that waits for a person's approval: recorded as its call (when Codex has not announced
   * it yet) and a `permission` entry; the run parks on it. A subagent's call is marked as its work.
   */
  approval(request: CodexApprovalRequest): { entries: TranscriptEntry[]; permission: PermissionRequest } {
    const scope = this.#scope(request.params.threadId);
    const key = scope.key(request.params.itemId);
    const entries: TranscriptEntry[] = [];
    let toolName: string;
    let input: Record<string, unknown>;
    if (request.kind === 'command') {
      toolName = CODEX_TOOL_NAMES.command;
      input = {
        command: request.params.command ?? '',
        ...(request.params.cwd ? { cwd: request.params.cwd } : {}),
        ...(request.params.reason ? { reason: request.params.reason } : {}),
      };
      if (!this.#started(key)) entries.push({ kind: 'tool_call', toolCallId: this.#callId(key), toolName, input });
    } else if (request.kind === 'fileChange') {
      const changes = this.#fileChanges.get(key) ?? [];
      const first = changes[0];
      toolName = first ? fileChangeCall(first).toolName : CODEX_TOOL_NAMES.editFile;
      // Every file of the change in the card, with its line counts, so the person sees what they allow.
      input = { ...codexFileChangeApprovalInput(changes), reason: codexFileChangeApprovalPrompt({ ...(request.params.reason ? { reason: request.params.reason } : {}), changes }) };
      if (!this.#started(key)) entries.push({ kind: 'tool_call', toolCallId: this.#callId(key), toolName, input });
    } else {
      toolName = CODEX_TOOL_NAMES.permissions;
      input = { access: permissionsRequestKind(request.params.permissions), permissions: request.params.permissions, ...(request.params.reason ? { reason: request.params.reason } : {}) };
      entries.push({ kind: 'tool_call', toolCallId: this.#callId(key), toolName, input });
    }
    const permission: PermissionRequest = { toolCallId: this.#callId(key), toolName, input, ...(scope.parent ? { parentToolCallId: scope.parent } : {}) };
    entries.push({ kind: 'permission', ...permission });
    return { entries: this.#nest(entries, scope), permission };
  }

  /**
   * An MCP tool call Codex asks a person to allow (its `mcp_tool_call` approval, which reaches the
   * host as an elicitation): recorded as the tool's call, `mcp__<server>__<tool>` as Claude Code
   * names it, and a `permission` entry. `id` stands for the call when Codex names no item.
   */
  mcpApproval(request: { id: string; threadId?: string; server: string; tool: string; message?: string }): { entries: TranscriptEntry[]; permission: PermissionRequest } {
    const scope = this.#scope(request.threadId);
    const key = scope.key(request.id);
    const toolName = codexMcpToolName(request.server, request.tool);
    const input: Record<string, unknown> = request.message ? { reason: request.message } : {};
    const toolCallId = this.#callId(key);
    const permission: PermissionRequest = { toolCallId, toolName, input, ...(scope.parent ? { parentToolCallId: scope.parent } : {}) };
    const entries: TranscriptEntry[] = this.#started(key) ? [] : [{ kind: 'tool_call', toolCallId, toolName, input }];
    return { entries: this.#nest([...entries, { kind: 'permission', ...permission }], scope), permission };
  }

  /** A question (`request_user_input`): recorded as an `AskUserQuestion` call and parked like one. */
  question(params: ToolRequestUserInputParams): { entries: TranscriptEntry[]; permission: PermissionRequest } {
    return this.#askUser(params.threadId, params.itemId, codexQuestionInput(params));
  }

  /** An MCP server's form or link (an elicitation): asked as an `AskUserQuestion` card, parked like a question. */
  elicitation(request: { id: string; threadId?: string; input: { questions: Array<Record<string, unknown>> }; plan: ElicitationPlan }): {
    entries: TranscriptEntry[];
    permission: PermissionRequest;
  } {
    return this.#askUser(request.threadId, request.id, request.input);
  }

  #askUser(threadId: string | undefined, itemId: string, input: { questions: Array<Record<string, unknown>> }) {
    const scope = this.#scope(threadId);
    const toolCallId = this.#callId(scope.key(itemId));
    // The card is the person's to answer: never nested in a subagent's card, where it could not be answered.
    const permission: PermissionRequest = { toolCallId, toolName: ASK_USER_QUESTION_TOOL, input };
    return { entries: [{ kind: 'tool_call', toolCallId, toolName: ASK_USER_QUESTION_TOOL, input }, { kind: 'permission', ...permission }] as TranscriptEntry[], permission };
  }

  /** The person answered an item's call while the turn waited: when Codex runs it, it is a new call. */
  answered(toolCallId: string): void {
    this.#answered.add(toolCallId);
  }

  /** The turn ended: its usage total (when Codex sent none per response), its subagents' ends, and the plan, if it wrote one. */
  complete(payload: TurnCompletedNotification): TranscriptEntry[] {
    this.#completed = payload.turn;
    for (const item of payload.turn.items ?? []) {
      if (item.type === 'plan' && !this.#planText) {
        this.#planText = (item as Extract<ThreadItem, { type: 'plan' }>).text;
        this.#planItemId = item.id;
      }
    }
    if (payload.turn.status === 'failed' && !this.#error) {
      this.#error = payload.turn.error ? codexErrorFromTurn(payload.turn.error) : new CodexError('unknown', 'The Codex turn failed.');
    }
    // A subagent the turn never heard back from ends with it.
    const unfinished = [...this.#subagents.keys()].flatMap(threadId =>
      this.#nested(threadId, this.#settle(threadId, { note: 'The subagent was still running when the turn ended.' })),
    );
    const plan = this.planGate;
    if (payload.turn.status !== 'completed' || !plan) return unfinished;
    return [
      ...unfinished,
      { kind: 'tool_call', toolCallId: plan.toolCallId, toolName: CODEX_TOOL_NAMES.plan, input: { plan: plan.plan, ...(plan.title ? { title: plan.title } : {}) } },
      { kind: 'plan', ...plan },
    ];
  }

  /** The usage this turn added and has not reported yet; ends the turn's tally. */
  finalUsage(): AgentTokenUsage | undefined {
    return this.turnId ? completeCodexTurnTokenUsage(this.#usage, this.turnId) : undefined;
  }

  /** The plan a plan-mode turn wrote, as a gate; only meaningful once the turn completed. */
  get planGate(): PlanGate | undefined {
    if (!this.#planText?.trim()) return undefined;
    const title = /^#+\s*(.+)$/m.exec(this.#planText)?.[1]?.trim();
    return {
      toolCallId: `${this.#planItemId ?? this.turnId ?? 'plan'}:submit_plan`,
      toolName: CODEX_PLAN_GATE_TOOL,
      plan: this.#planText,
      ...(title ? { title } : {}),
    };
  }

  /** How the turn went once Codex completed it. */
  outcome(): CodexTurnOutcome {
    const turn = this.#completed;
    if (!turn) return { kind: 'error', error: this.#error ?? new CodexError('process', 'Codex stopped before the turn completed.') };
    if (turn.status === 'interrupted') return { kind: 'aborted' };
    if (turn.status === 'failed' || this.#error) {
      return { kind: 'error', error: this.#error ?? new CodexError('unknown', 'The Codex turn failed.') };
    }
    const gate = this.planGate;
    if (gate) return { kind: 'gate', gate };
    return { kind: 'complete', ...(this.#finalText !== undefined ? { text: this.#finalText } : {}) };
  }
}
