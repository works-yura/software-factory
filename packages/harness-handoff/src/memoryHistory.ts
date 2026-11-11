// A Factory session's history as handoff turn items. Every harness keeps a session's conversation in
// the session's memory thread: Mastra writes its own messages there, and the chat channel of the
// turn-based harnesses (Claude Code, Codex) projects their transcript (`@factory/harness/transcript`)
// into the same thread. So one mapping serves all three: a person's input (a `user` message, or a
// `user` signal), the agent's replies, its commands and other tool calls, notifications, and the
// handoff markers this package writes.
import type { MastraDBMessage } from '@mastra/core/agent-controller';
import type { MemoryStorage } from '@mastra/core/storage';

import type {
  OrchestrationV2AppThread,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  RunId,
} from './contracts.ts';
import { HandoffThreadNotFoundError } from './errors.ts';
import type { HandoffHistorySource, HandoffRecordField, HandoffThreadRecords } from './historySource.ts';

/** The memory domain the handoff reads and writes: Mastra's `storage.getStore('memory')`. */
export type HandoffMemory = Pick<
  MemoryStorage,
  'getThreadById' | 'listMessages' | 'listMessagesById' | 'saveMessages' | 'updateThreadMetadata'
>;

/** The signal tag of the timeline marker a handoff writes (see `sessionHandoffs.ts`). */
export const CONTEXT_HANDOFF_SIGNAL_TAG = 'factory-context-handoff';
/** `content.metadata` key of the marker's state, which the chat draws as a divider. */
export const CONTEXT_HANDOFF_METADATA_KEY = 'contextHandoff';

/** Tools whose calls are shell commands, by the names each harness records them under. */
const COMMAND_TOOLS = new Set(['execute_command', 'Bash', 'shell', 'local_shell']);

/** Pages read for one thread; 100 messages a page. */
const MAX_PAGES = 50;

type Part = Record<string, unknown>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function partsOf(message: Pick<MastraDBMessage, 'content'>): Part[] {
  const content = message.content as unknown;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  const parts = record(content)?.parts;
  if (Array.isArray(parts) && parts.length > 0) return parts.flatMap(part => (record(part) ? [part as Part] : []));
  const text = record(content)?.content;
  return typeof text === 'string' && text ? [{ type: 'text', text }] : [];
}

function textOf(parts: Part[]): string {
  return parts
    .flatMap(part => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
    .join('\n')
    .trim();
}

function metadataOf(message: Pick<MastraDBMessage, 'content'>): Record<string, unknown> {
  return record(record(message.content as unknown)?.metadata) ?? {};
}

function iso(value: Date | string | undefined): string {
  const date = value instanceof Date ? value : new Date(value ?? 0);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
}

function commandInput(args: unknown): string {
  const command = record(args)?.command ?? record(args)?.cmd;
  if (typeof command === 'string') return command;
  if (Array.isArray(command)) return command.map(String).join(' ');
  return JSON.stringify(args ?? null);
}

function resultText(result: unknown): string | undefined {
  if (result === undefined) return undefined;
  if (typeof result === 'string') return result;
  const fields = record(result);
  if (fields) {
    const out = [fields.stdout, fields.stderr, fields.output, fields.content].filter(
      (value): value is string => typeof value === 'string' && value !== '',
    );
    if (out.length) return out.join('\n');
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function exitCodeOf(result: unknown): number | null {
  const fields = record(result);
  const code = fields?.exitCode ?? fields?.exit_code;
  return typeof code === 'number' && Number.isInteger(code) ? code : null;
}

/** What one stored message is: an input that starts a run, the agent's output, or neither. */
type MessageKind =
  | { kind: 'user'; text: string; createdBy: 'user' | 'agent' | 'system' }
  | { kind: 'notification'; text: string }
  | { kind: 'handoff'; text: string; toInstanceId: string; strategy: string }
  | { kind: 'assistant' }
  | { kind: 'skip' };

function classify(message: MastraDBMessage): MessageKind {
  const parts = partsOf(message);
  if (message.role === 'user') return { kind: 'user', text: textOf(parts), createdBy: 'user' };
  if (message.role === 'assistant') return { kind: 'assistant' };
  if ((message.role as string) !== 'signal') return { kind: 'skip' };
  const metadata = metadataOf(message);
  const signal = record(metadata.signal) ?? {};
  const text = textOf(parts);
  if (signal.tagName === CONTEXT_HANDOFF_SIGNAL_TAG) {
    const marker = record(metadata[CONTEXT_HANDOFF_METADATA_KEY]) ?? {};
    return {
      kind: 'handoff',
      text,
      toInstanceId: typeof marker.toInstanceId === 'string' && marker.toInstanceId ? marker.toInstanceId : 'unknown',
      strategy: typeof marker.reason === 'string' ? marker.reason : 'switch',
    };
  }
  if (signal.type === 'user' || signal.type === 'user-message') {
    return { kind: 'user', text, createdBy: 'user' };
  }
  if (signal.type === 'notification' || (signal.type === 'reactive' && signal.tagName === 'notification')) {
    return { kind: 'notification', text };
  }
  // State signals (environment, phase, …) and reminders are the Factory's own context, not history.
  return { kind: 'skip' };
}

export interface MessageTurnItemsOptions {
  readonly threadId: string;
  /** Stamped on every item and run, so a handoff names the conversation the history came from. */
  readonly providerThreadId?: string | null;
  /** The harness instance that ran the thread, for the runs' model selection. */
  readonly providerInstanceId?: string;
}

export interface MessageTurnItems {
  readonly runs: OrchestrationV2Run[];
  readonly turnItems: OrchestrationV2TurnItem[];
}

/**
 * A memory thread's messages (oldest first) as runs and turn items. Each person's input or
 * notification starts a run, whose ordinal is its turn index; what the agent said and did until
 * the next one belongs to it. Text parts of a reply become one `assistant_message` per stretch of
 * text, shell calls `command_execution`, other tool calls `dynamic_tool`, reasoning `reasoning`.
 */
export function turnItemsFromMessages(
  messages: ReadonlyArray<MastraDBMessage>,
  options: MessageTurnItemsOptions,
): MessageTurnItems {
  const runs: OrchestrationV2Run[] = [];
  const turnItems: OrchestrationV2TurnItem[] = [];
  const providerThreadId = options.providerThreadId ?? null;
  const instanceId = options.providerInstanceId ?? 'unknown';
  let run: OrchestrationV2Run | undefined;
  const base = (id: string, at: string, runId: RunId | null) => ({
    id,
    threadId: options.threadId,
    runId,
    nodeId: null,
    providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: turnItems.length,
    status: 'completed' as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  });
  const startRun = (messageId: string, at: string) => {
    if (run) run.completedAt ??= at;
    run = {
      id: `run:${messageId}`,
      threadId: options.threadId,
      ordinal: runs.length + 1,
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: 'unknown' },
      providerThreadId,
      userMessageId: messageId,
      rootNodeId: null,
      activeAttemptId: null,
      status: 'completed',
      queuePosition: null,
      requestedAt: at,
      startedAt: at,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };
    runs.push(run);
    return run.id;
  };

  for (const message of messages) {
    const at = iso(message.createdAt);
    const kind = classify(message);
    switch (kind.kind) {
      case 'skip':
        break;
      case 'user': {
        if (!kind.text) break;
        const runId = startRun(message.id, at);
        turnItems.push({
          ...base(message.id, at, runId),
          type: 'user_message',
          messageId: message.id,
          text: kind.text,
          inputIntent: 'turn_start',
          attachments: [],
          createdBy: kind.createdBy,
          creationSource: 'factory',
        });
        break;
      }
      case 'notification': {
        const runId = startRun(message.id, at);
        turnItems.push({ ...base(message.id, at, runId), type: 'notification', summary: kind.text });
        break;
      }
      case 'handoff':
        turnItems.push({
          ...base(message.id, at, run?.id ?? null),
          type: 'handoff',
          summary: kind.text || null,
          strategy: kind.strategy,
          toProviderInstanceId: kind.toInstanceId,
        });
        break;
      case 'assistant': {
        const runId = run?.id ?? null;
        let text: string[] = [];
        let textIndex = -1;
        const flushText = () => {
          const joined = text.join('').trim();
          if (joined) {
            const id = `${message.id}:${textIndex}`;
            turnItems.push({ ...base(id, at, runId), type: 'assistant_message', messageId: id, text: joined, streaming: false });
          }
          text = [];
          textIndex = -1;
        };
        partsOf(message).forEach((part, index) => {
          if (part.type === 'text' && typeof part.text === 'string') {
            if (textIndex === -1) textIndex = index;
            text.push(part.text);
            return;
          }
          flushText();
          const id = `${message.id}:${index}`;
          if (part.type === 'reasoning') {
            const reasoning = typeof part.reasoning === 'string' ? part.reasoning : textOf((part.details as Part[]) ?? []);
            if (reasoning.trim()) {
              turnItems.push({ ...base(id, at, runId), type: 'reasoning', text: reasoning, streaming: false });
            }
            return;
          }
          const invocation = part.type === 'tool-invocation' ? record(part.toolInvocation) : undefined;
          if (!invocation || typeof invocation.toolName !== 'string') return;
          const toolName = invocation.toolName;
          const result = invocation.state === 'result' ? invocation.result : undefined;
          if (COMMAND_TOOLS.has(toolName)) {
            const output = resultText(result);
            turnItems.push({
              ...base(id, at, runId),
              type: 'command_execution',
              input: commandInput(invocation.args),
              ...(output === undefined ? {} : { output }),
              exitCode: exitCodeOf(result),
            });
            return;
          }
          turnItems.push({
            ...base(id, at, runId),
            type: 'dynamic_tool',
            toolName,
            input: invocation.args ?? null,
            output: result ?? null,
          });
        });
        flushText();
        break;
      }
    }
  }
  if (run) run.completedAt ??= turnItems.at(-1)?.updatedAt ?? run.requestedAt;
  return { runs, turnItems };
}

/** A memory thread's messages, oldest first, at most {@link MAX_PAGES} pages. */
export async function readThreadMessages(
  memory: Pick<HandoffMemory, 'listMessages'>,
  input: { readonly threadId: string; readonly resourceId?: string; readonly before?: Date },
): Promise<MastraDBMessage[]> {
  const messages: MastraDBMessage[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await memory.listMessages({
      threadId: input.threadId,
      ...(input.resourceId ? { resourceId: input.resourceId } : {}),
      page,
      perPage: 100,
      orderBy: { field: 'createdAt', direction: 'ASC' },
    });
    messages.push(...result.messages);
    if (!result.hasMore) break;
  }
  if (!input.before) return messages;
  const cutoff = input.before.getTime();
  return messages.filter(message => new Date(message.createdAt).getTime() < cutoff);
}

/** What a history source knows of a thread beyond its messages. */
export interface MemoryThreadInfo {
  readonly resourceId?: string;
  /** The harness instance that runs (or ran) the thread. */
  readonly providerInstanceId?: string;
  /** The native conversation the history came from, as handoff coverage names it. */
  readonly providerThreadId?: string | null;
  /** Leaves out messages stored at or after this time (the turn being sent right now). */
  readonly before?: Date;
}

export interface MemoryHistorySourceOptions {
  readonly memory: () => Promise<Pick<HandoffMemory, 'getThreadById' | 'listMessages'>>;
  /**
   * Whether the thread may be read here, and what is known about it; null hides it (the source
   * then throws `HandoffThreadNotFoundError`, as for a thread the memory does not have).
   */
  readonly resolve?: (threadId: string) => Promise<MemoryThreadInfo | null>;
}

/**
 * A {@link HandoffHistorySource} over a memory thread. Mastra, Claude Code and Codex sessions all
 * read through it; each harness's source differs only in how it resolves a thread (see
 * `createHarnessHistorySource`).
 */
export function createMemoryHistorySource(options: MemoryHistorySourceOptions): HandoffHistorySource {
  return {
    getThreadRecords: async <K extends HandoffRecordField>(
      threadId: string,
      fields: ReadonlyArray<K>,
      filter?: { readonly turnItemRunIds?: ReadonlyArray<RunId | null> },
    ): Promise<Pick<HandoffThreadRecords, 'thread' | K>> => {
      const info = options.resolve ? await options.resolve(threadId) : {};
      if (info === null) throw new HandoffThreadNotFoundError({ threadId });
      const memory = await options.memory();
      const stored = await memory.getThreadById({ threadId });
      if (!stored || (info.resourceId && stored.resourceId !== info.resourceId)) {
        throw new HandoffThreadNotFoundError({ threadId });
      }
      const instanceId = info.providerInstanceId ?? 'unknown';
      const createdAt = iso(stored.createdAt);
      const thread: OrchestrationV2AppThread = {
        id: threadId,
        projectId: stored.resourceId,
        title: stored.title ?? '',
        createdBy: 'user',
        creationSource: 'factory',
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: 'unknown' },
        runtimeMode: 'default',
        interactionMode: 'default',
        branch: null,
        worktreePath: null,
        activeProviderThreadId: info.providerThreadId ?? null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt,
        updatedAt: iso(stored.updatedAt),
        archivedAt: null,
        deletedAt: null,
      };
      const needsMessages = fields.some(field => field === 'runs' || field === 'turnItems');
      const mapped = needsMessages
        ? turnItemsFromMessages(
            await readThreadMessages(memory, {
              threadId,
              resourceId: stored.resourceId,
              ...(info.before ? { before: info.before } : {}),
            }),
            {
              threadId,
              providerThreadId: info.providerThreadId ?? null,
              providerInstanceId: instanceId,
            },
          )
        : { runs: [], turnItems: [] };
      const runFilter = filter?.turnItemRunIds ? new Set(filter.turnItemRunIds) : undefined;
      const all: HandoffThreadRecords = {
        thread,
        runs: mapped.runs,
        attempts: [],
        turnItems: runFilter ? mapped.turnItems.filter(item => runFilter.has(item.runId)) : mapped.turnItems,
      };
      const picked: Record<string, unknown> = { thread };
      for (const field of fields) picked[field] = all[field];
      return picked as Pick<HandoffThreadRecords, 'thread' | K>;
    },
  };
}
