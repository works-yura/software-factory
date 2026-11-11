// One Codex turn as the Factory transcript: the app-server's item and delta notifications become
// transcript entries (text, reasoning, tool calls and their results, the plan list as the task
// panel), its approvals and questions become parked gates, and its completion the turn's outcome.
import type { AgentTokenUsage } from '@factory/harness';
import { ASK_USER_QUESTION_TOOL, type PermissionRequest, type PlanGate, type TranscriptEntry } from '@factory/harness/transcript';

import { CodexError, codexErrorFromTurn } from './errors.ts';
import type {
  CommandExecutionRequestApprovalParams,
  ErrorNotification,
  FileChangeRequestApprovalParams,
  FileUpdateChange,
  ItemNotification,
  PermissionsRequestApprovalParams,
  ThreadItem,
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

/** A file change's call: one per changed file, under the Factory's file tool for its kind. */
function fileChangeCall(change: FileUpdateChange): { toolName: string; input: Record<string, unknown> } {
  switch (change.kind.type) {
    case 'add':
      return { toolName: CODEX_TOOL_NAMES.writeFile, input: { path: change.path, diff: change.diff } };
    case 'delete':
      return { toolName: CODEX_TOOL_NAMES.deleteFile, input: { path: change.path } };
    default:
      return {
        toolName: CODEX_TOOL_NAMES.editFile,
        input: { path: change.path, diff: change.diff, ...(change.kind.move_path ? { move_path: change.kind.move_path } : {}) },
      };
  }
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

/** The `AskUserQuestion` input a `request_user_input` reads as, so the chat's question card shows it. */
export function codexQuestionInput(params: ToolRequestUserInputParams): { questions: Array<Record<string, unknown>> } {
  return {
    questions: params.questions.map(question => ({
      id: question.id,
      question: question.question,
      ...(question.header ? { header: question.header } : {}),
      ...(question.options?.length ? { options: question.options.map(option => ({ label: option.label, ...(option.description ? { description: option.description } : {}) })) } : {}),
    })),
  };
}

/**
 * Follows one Codex turn: builds the transcript as notifications arrive and decides at the end how
 * the turn went. A call the person answered while the turn waited is settled by that answer; when
 * Codex then runs it, it is recorded again as a call of its own, so its output is kept.
 */
export class CodexTurnTranslator {
  readonly threadId: string;
  turnId: string | undefined;
  readonly #usage: CodexTurnTokenUsageState;
  /** Tool calls recorded under a transcript id, by Codex item id (a re-run call gets a new one). */
  readonly #callIds = new Map<string, string[]>();
  /** Items whose call a person answered: Codex runs them after, as calls of their own. */
  readonly #answered = new Set<string>();
  /** Answered items Codex went on to run: their calls are recorded under new ids. */
  readonly #rerun = new Set<string>();
  readonly #fileChanges = new Map<string, ReadonlyArray<FileUpdateChange>>();
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

  /** Whether a notification belongs to this turn. */
  owns(payload: { threadId?: string; turnId?: string }): boolean {
    if (payload.threadId !== undefined && payload.threadId !== this.threadId) return false;
    return this.turnId === undefined || payload.turnId === undefined || payload.turnId === this.turnId;
  }

  #callId(itemId: string, index = 0): string {
    const ids = this.#callIds.get(itemId) ?? [];
    let id = ids[index];
    if (!id) {
      id = this.#rerun.has(itemId) ? `${itemId}:${index}:run` : index === 0 ? itemId : `${itemId}:${index}`;
      ids[index] = id;
      this.#callIds.set(itemId, ids);
    }
    return id;
  }

  #started(itemId: string): boolean {
    return (this.#callIds.get(itemId)?.length ?? 0) > 0;
  }

  /** Whether an item's call must be recorded (again): never announced, or answered and now run. */
  #announce(itemId: string): boolean {
    if (this.#answered.delete(itemId)) {
      this.#rerun.add(itemId);
      this.#callIds.delete(itemId);
      return true;
    }
    return !this.#started(itemId);
  }

  /** The call entries a completed item needs first when its start was never recorded. */
  #ensureStarted(item: ThreadItem): TranscriptEntry[] {
    return this.#announce(item.id) ? this.#startEntries(item) : [];
  }

  itemStarted({ item }: ItemNotification): TranscriptEntry[] {
    if (item.type === 'fileChange') this.#fileChanges.set(item.id, (item as Extract<ThreadItem, { type: 'fileChange' }>).changes);
    if (!['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch'].includes(item.type)) return [];
    return this.#announce(item.id) ? this.#startEntries(item) : [];
  }

  #startEntries(item: ThreadItem): TranscriptEntry[] {
    switch (item.type) {
      case 'commandExecution': {
        const command = item as Extract<ThreadItem, { type: 'commandExecution' }>;
        return [{ kind: 'tool_call', toolCallId: this.#callId(item.id), toolName: CODEX_TOOL_NAMES.command, input: { command: command.command, cwd: command.cwd } }];
      }
      case 'fileChange': {
        const change = item as Extract<ThreadItem, { type: 'fileChange' }>;
        return change.changes.map((file, index) => ({ kind: 'tool_call' as const, toolCallId: this.#callId(item.id, index), ...fileChangeCall(file) }));
      }
      case 'mcpToolCall': {
        const call = item as Extract<ThreadItem, { type: 'mcpToolCall' }>;
        return [{ kind: 'tool_call', toolCallId: this.#callId(item.id), toolName: codexMcpToolName(call.server, call.tool), input: call.arguments }];
      }
      case 'dynamicToolCall': {
        const call = item as Extract<ThreadItem, { type: 'dynamicToolCall' }>;
        return [{ kind: 'tool_call', toolCallId: this.#callId(item.id), toolName: call.namespace ? `${call.namespace}.${call.tool}` : call.tool, input: call.arguments }];
      }
      case 'webSearch': {
        const search = item as Extract<ThreadItem, { type: 'webSearch' }>;
        return [{ kind: 'tool_call', toolCallId: this.#callId(item.id), toolName: CODEX_TOOL_NAMES.webSearch, input: { query: search.query } }];
      }
      default:
        return [];
    }
  }

  itemCompleted({ item }: ItemNotification): TranscriptEntry[] {
    switch (item.type) {
      case 'agentMessage': {
        const message = item as Extract<ThreadItem, { type: 'agentMessage' }>;
        this.#finalText = message.text;
        const streamed = this.#streamed.get(item.id) ?? '';
        this.#streamed.delete(item.id);
        // The full block confirms what streamed (the chat replaces the streamed part with it).
        return message.text || streamed ? [{ kind: 'text', text: message.text || streamed, messageId: item.id }] : [];
      }
      case 'reasoning': {
        const reasoning = item as Extract<ThreadItem, { type: 'reasoning' }>;
        const text = [...(reasoning.summary ?? [])].join('\n\n').trim() || [...(reasoning.content ?? [])].join('\n\n').trim();
        this.#reasoningStreamed.delete(item.id);
        return text ? [{ kind: 'thinking', text, messageId: item.id }] : [];
      }
      case 'plan': {
        const plan = item as Extract<ThreadItem, { type: 'plan' }>;
        this.#planText = plan.text;
        this.#planItemId = item.id;
        return [];
      }
      case 'commandExecution': {
        const command = item as Extract<ThreadItem, { type: 'commandExecution' }>;
        const started = this.#ensureStarted(item);
        const output = (command.aggregatedOutput ?? '').trimEnd();
        const exit = typeof command.exitCode === 'number' ? `Exit code ${command.exitCode}` : undefined;
        const declined = command.status === 'declined';
        return [
          ...started,
          {
            kind: 'tool_result',
            toolCallId: this.#callId(item.id),
            content: declined ? 'Declined.' : [output, exit].filter(Boolean).join('\n\n'),
            isError: command.status === 'failed' || declined || (typeof command.exitCode === 'number' && command.exitCode !== 0),
          },
        ];
      }
      case 'fileChange': {
        const change = item as Extract<ThreadItem, { type: 'fileChange' }>;
        const started = this.#ensureStarted(item);
        const isError = change.status === 'failed' || change.status === 'declined';
        return [
          ...started,
          ...change.changes.map((file, index) => ({
            kind: 'tool_result' as const,
            toolCallId: this.#callId(item.id, index),
            content: change.status === 'declined' ? 'Declined.' : isError ? `Could not ${file.kind.type} ${file.path}.` : `${file.kind.type === 'add' ? 'Created' : file.kind.type === 'delete' ? 'Deleted' : 'Updated'} ${file.path}.`,
            isError,
          })),
        ];
      }
      case 'mcpToolCall': {
        const call = item as Extract<ThreadItem, { type: 'mcpToolCall' }>;
        const started = this.#ensureStarted(item);
        const content = call.error?.message ?? (call.result ? textOf(call.result.content) || JSON.stringify(call.result.structuredContent ?? '') : '');
        return [...started, { kind: 'tool_result', toolCallId: this.#callId(item.id), content, isError: call.status === 'failed' || call.error != null }];
      }
      case 'dynamicToolCall': {
        const call = item as Extract<ThreadItem, { type: 'dynamicToolCall' }>;
        const started = this.#ensureStarted(item);
        return [
          ...started,
          { kind: 'tool_result', toolCallId: this.#callId(item.id), content: textOf(call.contentItems ?? []), isError: call.status === 'failed' || call.success === false },
        ];
      }
      case 'webSearch': {
        const search = item as Extract<ThreadItem, { type: 'webSearch' }>;
        const started = this.#ensureStarted(item);
        return [...started, { kind: 'tool_result', toolCallId: this.#callId(item.id), content: webSearchPatterns(search.query, search.action).join('\n'), isError: false }];
      }
      case 'imageView': {
        const view = item as Extract<ThreadItem, { type: 'imageView' }>;
        const toolCallId = this.#callId(item.id);
        return [
          { kind: 'tool_call', toolCallId, toolName: CODEX_TOOL_NAMES.viewImage, input: { path: view.path } },
          { kind: 'tool_result', toolCallId, content: view.path, isError: false },
        ];
      }
      default:
        return [];
    }
  }

  agentMessageDelta(payload: { itemId: string; delta: string }): TranscriptEntry[] {
    this.#streamed.set(payload.itemId, (this.#streamed.get(payload.itemId) ?? '') + payload.delta);
    return payload.delta ? [{ kind: 'text_delta', text: payload.delta }] : [];
  }

  reasoningDelta(payload: { itemId: string; delta: string }): TranscriptEntry[] {
    this.#reasoningStreamed.add(payload.itemId);
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
   * it yet) and a `permission` entry; the run parks on it.
   */
  approval(request: CodexApprovalRequest): { entries: TranscriptEntry[]; permission: PermissionRequest } {
    const { itemId } = request.params;
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
      if (!this.#started(itemId)) entries.push({ kind: 'tool_call', toolCallId: this.#callId(itemId), toolName, input });
    } else if (request.kind === 'fileChange') {
      const changes = this.#fileChanges.get(itemId) ?? [];
      const first = changes[0];
      ({ toolName, input } = first ? fileChangeCall(first) : { toolName: CODEX_TOOL_NAMES.editFile, input: {} });
      input = { ...input, reason: codexFileChangeApprovalPrompt({ ...(request.params.reason ? { reason: request.params.reason } : {}), changes }) };
      if (!this.#started(itemId)) entries.push({ kind: 'tool_call', toolCallId: this.#callId(itemId), toolName, input });
    } else {
      toolName = CODEX_TOOL_NAMES.permissions;
      input = { access: permissionsRequestKind(request.params.permissions), permissions: request.params.permissions, ...(request.params.reason ? { reason: request.params.reason } : {}) };
      entries.push({ kind: 'tool_call', toolCallId: this.#callId(itemId), toolName, input });
    }
    const permission: PermissionRequest = { toolCallId: this.#callId(itemId), toolName, input };
    entries.push({ kind: 'permission', ...permission });
    return { entries, permission };
  }

  /** A question (`request_user_input`): recorded as an `AskUserQuestion` call and parked like one. */
  question(params: ToolRequestUserInputParams): { entries: TranscriptEntry[]; permission: PermissionRequest } {
    const input = codexQuestionInput(params);
    const toolCallId = this.#callId(params.itemId);
    const permission: PermissionRequest = { toolCallId, toolName: ASK_USER_QUESTION_TOOL, input };
    return { entries: [{ kind: 'tool_call', toolCallId, toolName: ASK_USER_QUESTION_TOOL, input }, { kind: 'permission', ...permission }], permission };
  }

  /** The person answered an item's call while the turn waited: when Codex runs it, it is a new call. */
  answered(itemId: string): void {
    this.#answered.add(itemId);
  }

  /** The turn ended: its usage total (when Codex sent none per response) and the plan, if it wrote one. */
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
    const plan = this.planGate;
    if (payload.turn.status !== 'completed' || !plan) return [];
    return [
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
