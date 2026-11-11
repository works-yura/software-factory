import type { AgentTokenUsage } from '@factory/harness';
import {
  ASK_USER_QUESTION_TOOL,
  askUserPrompt as genericAskUserPrompt,
  type AskUserPrompt,
  type MessageAuthor,
  type NotificationRecord,
  type PermissionRequest,
  type PlanGate,
  type TranscriptEntry,
} from '@factory/harness/transcript';

import { classifyFailure, type ClaudeCodeError } from './errors.ts';
import { PERMISSION_PENDING_MARKER, SUBMIT_PLAN_TOOL_ID } from './gate.ts';
import type { ClaudeContentBlock, ClaudeStreamMessage, ClaudeUsage } from './stream.ts';

/**
 * Claude Code's own plan-mode tool. `claude -p` does not offer it today; it is
 * still treated as a gate in case a future CLI does.
 */
export const EXIT_PLAN_MODE_TOOL = 'ExitPlanMode';
/**
 * Claude Code's own tool for asking the person something. In `-p` it reaches
 * the permission prompt like any tool; the harness parks it there as a
 * question, and the answer goes back as the next turn instead of running it.
 */
export { ASK_USER_QUESTION_TOOL } from '@factory/harness/transcript';
export type { AskUserPrompt, AskUserQuestionItem, PermissionRequest, PlanGate } from '@factory/harness/transcript';

/** Reads an `AskUserQuestion` input; see `askUserPrompt` in `@factory/harness/transcript`. */
export function askUserPrompt(input: unknown): AskUserPrompt {
  return genericAskUserPrompt(input, 'Claude has a question.');
}

/** A message's author, as Mastra stamps one on a person's message (`providerOptions.mastra.author`). */
export type ClaudeMessageAuthor = MessageAuthor;
/** A notification as the session keeps it (see `NotificationRecord`). */
export type ClaudeNotificationRecord = NotificationRecord;

/** Tool calls that mean "the plan is ready for review". */
export const PLAN_GATE_TOOL_IDS: readonly string[] = [SUBMIT_PLAN_TOOL_ID, EXIT_PLAN_MODE_TOOL];
/** The contract's name for a plan gate, so the dispatcher's plan handling applies unchanged. */
export const PLAN_GATE_TOOL = 'submit_plan';

/** What the turn said and did (see `TranscriptEntry` in `@factory/harness/transcript`). */
export type ClaudeTranscriptEntry = TranscriptEntry;

export type TurnOutcome =
  | { kind: 'complete'; text?: string }
  | { kind: 'gate'; gate: PlanGate }
  | { kind: 'permission'; request: PermissionRequest }
  | { kind: 'error'; error: ClaudeCodeError };

const USAGE_COUNTS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const;
const CACHE_CREATION_COUNTS = ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'] as const;

/** What `current` adds to `reported` (a later copy of the same message), or `undefined` when nothing grew. */
function usageDifference(current: ClaudeUsage, reported: ClaudeUsage): ClaudeUsage | undefined {
  const step: ClaudeUsage = {};
  let grew = false;
  for (const key of USAGE_COUNTS) {
    if (current[key] === undefined) continue;
    const value = Math.max(0, current[key] - (reported[key] ?? 0));
    step[key] = value;
    if (value > 0) grew = true;
  }
  if (current.cache_creation) {
    step.cache_creation = {};
    for (const key of CACHE_CREATION_COUNTS) {
      const now = current.cache_creation[key];
      if (now === undefined) continue;
      const value = Math.max(0, now - (reported.cache_creation?.[key] ?? 0));
      step.cache_creation[key] = value;
      if (value > 0) grew = true;
    }
  }
  return grew ? step : undefined;
}

/** Anthropic usage as the contract counts it: prompt tokens include cache reads and writes. */
export function toTokenUsage(usage: ClaudeUsage): AgentTokenUsage {
  const input = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const promptTokens = input + cacheRead + cacheWrite;
  const result: AgentTokenUsage = {
    promptTokens,
    completionTokens: output,
    totalTokens: promptTokens + output,
  };
  if (usage.cache_read_input_tokens !== undefined) result.cachedInputTokens = cacheRead;
  if (usage.cache_creation_input_tokens !== undefined) result.cacheCreationInputTokens = cacheWrite;
  const m5 = usage.cache_creation?.ephemeral_5m_input_tokens;
  const h1 = usage.cache_creation?.ephemeral_1h_input_tokens;
  if (m5 !== undefined) result.cacheCreationInputTokens5m = m5;
  if (h1 !== undefined) result.cacheCreationInputTokens1h = h1;
  return result;
}

function withParent<T extends object>(entry: T, parent: string | undefined): T {
  return parent ? { ...entry, parentToolCallId: parent } : entry;
}

/**
 * Follows one CLI turn's stream: builds the transcript as lines arrive and
 * decides at the end how the turn went.
 *
 * Usage is reported once per model message. With `--verbose` the CLI repeats
 * an assistant message per content block, each carrying that message's usage
 * so far, so per-line reporting would count a message several times; the
 * latest copy per message id is the right one and is only known at the end.
 */
export class TurnTranslator {
  sessionId: string | undefined;
  #usageByMessage = new Map<string, ClaudeUsage>();
  #anonymousUsage: ClaudeUsage[] = [];
  /** What {@link takeUsage} already reported, per message id. */
  #reportedUsage = new Map<string, ClaudeUsage>();
  #reportedAnonymous = 0;
  #reportedResult = false;
  /** The message the latest usage came with; it may still grow, so it is reported once another follows. */
  #latestUsageMessage: string | undefined;
  #result: Extract<ClaudeStreamMessage, { type: 'result' }> | undefined;
  #gate: PlanGate | undefined;
  #permission: PermissionRequest | undefined;
  /** Tool calls seen this turn, so a refused call's permission request names its tool and input. */
  #toolCalls = new Map<string, { toolName: string; input: unknown }>();
  #errorMarker: string | undefined;
  #errorText: string | undefined;
  #rateLimitRejected = false;
  #rateLimitResetsAt: Date | undefined;
  #apiRetry: { status?: number; error?: string; attempt: number } | undefined;
  #started = false;

  get gate(): PlanGate | undefined {
    return this.#gate;
  }

  /** The first call this turn that waits for a person's permission; check it after each {@link push}. */
  get permission(): PermissionRequest | undefined {
    return this.#permission;
  }

  /**
   * The CLI is retrying a request its account can never make (a refused key:
   * 401 or 403). It would keep at it for minutes with growing delays; the turn
   * stops here instead and goes on with another account.
   */
  get accountRefused(): boolean {
    const retry = this.#apiRetry;
    return retry !== undefined && (retry.error === 'authentication_failed' || retry.status === 401 || retry.status === 403);
  }

  /** How many times the CLI retried a rate-limited request this turn. */
  get rateLimitRetries(): number {
    const retry = this.#apiRetry;
    return retry && (retry.error === 'rate_limit' || retry.status === 429) ? retry.attempt : 0;
  }

  get sawResult(): boolean {
    return this.#result !== undefined;
  }

  /** The CLI announced the session (`system init`), so the turn's prompt is in it. */
  get started(): boolean {
    return this.#started;
  }

  /** Transcript entries for one message; check {@link gate} afterwards to stop the turn at a plan. */
  push(message: ClaudeStreamMessage): ClaudeTranscriptEntry[] {
    if ('sessionId' in message && message.sessionId) this.sessionId = message.sessionId;
    switch (message.type) {
      case 'system':
        return this.#system(message);
      case 'assistant':
        return this.#assistant(message);
      case 'user':
        return this.#user(message);
      case 'stream_event':
        return this.#streamEvent(message);
      case 'rate_limit':
        if (message.status === 'rejected') {
          this.#rateLimitRejected = true;
          if (message.resetsAt) this.#rateLimitResetsAt = message.resetsAt;
        }
        return [];
      case 'result':
        return this.#resultEntry(message);
      case 'invalid':
        return [{ kind: 'stdout', text: message.line }];
      case 'unknown':
        return [];
    }
  }

  #system(message: Extract<ClaudeStreamMessage, { type: 'system' }>): ClaudeTranscriptEntry[] {
    if (message.subtype === 'api_retry') {
      const status = typeof message.raw.error_status === 'number' ? message.raw.error_status : undefined;
      const error = typeof message.raw.error === 'string' ? message.raw.error : undefined;
      const attempt = typeof message.raw.attempt === 'number' ? message.raw.attempt : 1;
      this.#apiRetry = { attempt, ...(status !== undefined ? { status } : {}), ...(error ? { error } : {}) };
      return [];
    }
    if (message.subtype !== 'init' || !message.sessionId) return [];
    this.#started = true;
    const init = message as Extract<ClaudeStreamMessage, { subtype: 'init' }>;
    return [
      {
        kind: 'init',
        sessionId: init.sessionId,
        ...(init.model ? { model: init.model } : {}),
        ...(init.permissionMode ? { permissionMode: init.permissionMode } : {}),
      },
    ];
  }

  #assistant(message: Extract<ClaudeStreamMessage, { type: 'assistant' }>): ClaudeTranscriptEntry[] {
    if (message.usage) {
      if (message.messageId) {
        this.#usageByMessage.set(message.messageId, message.usage);
        this.#latestUsageMessage = message.messageId;
      } else this.#anonymousUsage.push(message.usage);
    }
    const entries: ClaudeTranscriptEntry[] = [];
    const parent = message.parentToolUseId;
    const messageId = message.messageId ? { messageId: message.messageId } : {};
    for (const block of message.content) {
      if (block.type === 'text' && block.text) {
        entries.push(withParent({ kind: 'text', text: block.text, ...messageId }, parent));
      } else if (block.type === 'thinking' && block.thinking) {
        entries.push(withParent({ kind: 'thinking', text: block.thinking, ...messageId }, parent));
      } else if (block.type === 'tool_use') {
        entries.push(...this.#toolUse(block, parent));
      }
    }
    if (message.error) {
      this.#errorMarker = message.error;
      this.#errorText = message.content
        .map(block => (block.type === 'text' ? block.text : ''))
        .join('\n')
        .trim();
    }
    return entries;
  }

  #toolUse(block: Extract<ClaudeContentBlock, { type: 'tool_use' }>, parent: string | undefined): ClaudeTranscriptEntry[] {
    this.#toolCalls.set(block.id, { toolName: block.name, input: block.input });
    const call = withParent({ kind: 'tool_call' as const, toolCallId: block.id, toolName: block.name, input: block.input }, parent);
    // A subagent cannot ask the person for anything; only the main loop's plan is a gate.
    if (!PLAN_GATE_TOOL_IDS.includes(block.name) || parent || this.#gate) return [call];
    const input = block.input as { plan?: unknown; title?: unknown } | undefined;
    this.#gate = {
      toolCallId: block.id,
      toolName: block.name,
      ...(typeof input?.plan === 'string' ? { plan: input.plan } : {}),
      ...(typeof input?.title === 'string' && input.title.trim() ? { title: input.title } : {}),
    };
    return [call, { kind: 'plan', ...this.#gate }];
  }

  #user(message: Extract<ClaudeStreamMessage, { type: 'user' }>): ClaudeTranscriptEntry[] {
    const parent = message.parentToolUseId;
    return message.content.flatMap((block): ClaudeTranscriptEntry[] => {
      if (block.type === 'text' && block.text) return [withParent({ kind: 'user', text: block.text }, parent)];
      if (block.type !== 'tool_result') return [];
      // The permission tool refused the call so a person can answer it: the call waits, it did not fail.
      if (block.isError && block.content.includes(PERMISSION_PENDING_MARKER)) return this.#permissionPending(block.toolUseId, parent);
      return [
        withParent(
          { kind: 'tool_result', toolCallId: block.toolUseId, content: block.content, isError: block.isError },
          parent,
        ),
      ];
    });
  }

  #permissionPending(toolCallId: string, parent: string | undefined): ClaudeTranscriptEntry[] {
    if (this.#permission) return [];
    const call = this.#toolCalls.get(toolCallId);
    this.#permission = {
      toolCallId,
      toolName: call?.toolName ?? 'unknown',
      ...(call && call.input !== undefined ? { input: call.input } : {}),
      ...(parent ? { parentToolCallId: parent } : {}),
    };
    return [{ kind: 'permission', ...this.#permission }];
  }

  #streamEvent(message: Extract<ClaudeStreamMessage, { type: 'stream_event' }>): ClaudeTranscriptEntry[] {
    const delta = message.event.delta as { type?: unknown; text?: unknown; thinking?: unknown } | undefined;
    if (message.event.type !== 'content_block_delta' || !delta) return [];
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      return [withParent({ kind: 'text_delta', text: delta.text }, message.parentToolUseId)];
    }
    if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      return [withParent({ kind: 'thinking_delta', text: delta.thinking }, message.parentToolUseId)];
    }
    return [];
  }

  #resultEntry(message: Extract<ClaudeStreamMessage, { type: 'result' }>): ClaudeTranscriptEntry[] {
    this.#result = message;
    return [
      {
        kind: 'result',
        subtype: message.subtype,
        isError: message.isError,
        ...(message.result !== undefined ? { text: message.result } : {}),
        ...(message.totalCostUsd !== undefined ? { costUsd: message.totalCostUsd } : {}),
        ...(message.durationMs !== undefined ? { durationMs: message.durationMs } : {}),
        ...(message.numTurns !== undefined ? { numTurns: message.numTurns } : {}),
      },
    ];
  }

  /** One usage step per model message seen, or the result's total when no message carried usage. */
  usageSteps(): AgentTokenUsage[] {
    const perMessage = [...this.#usageByMessage.values(), ...this.#anonymousUsage];
    if (perMessage.length > 0) return perMessage.map(toTokenUsage);
    return this.#result?.usage ? [toTokenUsage(this.#result.usage)] : [];
  }

  /**
   * Usage not reported yet, one step per model message, as the turn streams:
   * a message counts once a later one follows it (the CLI repeats a message
   * per content block), and `final` (the turn ended or was stopped) takes the
   * rest. A message that grew after it was reported adds only the difference.
   * With no message usage at all, `final` falls back to the result's total.
   */
  takeUsage(final = false): AgentTokenUsage[] {
    const steps: AgentTokenUsage[] = [];
    for (const [id, usage] of this.#usageByMessage) {
      if (!final && id === this.#latestUsageMessage) continue;
      const reported = this.#reportedUsage.get(id);
      const step = reported ? usageDifference(usage, reported) : usage;
      if (!step) continue;
      this.#reportedUsage.set(id, usage);
      steps.push(toTokenUsage(step));
    }
    for (; this.#reportedAnonymous < this.#anonymousUsage.length; this.#reportedAnonymous += 1) {
      steps.push(toTokenUsage(this.#anonymousUsage[this.#reportedAnonymous]!));
    }
    const sawMessageUsage = this.#usageByMessage.size > 0 || this.#anonymousUsage.length > 0;
    if (final && !sawMessageUsage && this.#result?.usage && !this.#reportedResult) {
      this.#reportedResult = true;
      steps.push(toTokenUsage(this.#result.usage));
    }
    return steps;
  }

  /** How the turn went once the process exited. Aborts are the session's call, not the stream's. */
  outcome(exit: { exitCode: number | null; stderr: string }, now = new Date()): TurnOutcome {
    if (this.#gate) return { kind: 'gate', gate: this.#gate };
    if (this.#permission) return { kind: 'permission', request: this.#permission };
    const result = this.#result;
    if (result && !result.isError && !this.#errorMarker) {
      return { kind: 'complete', ...(result.result !== undefined ? { text: result.result } : {}) };
    }
    // A rate-limit warning alone does not fail a turn that finished; it only explains one that did not.
    const resetsAt = this.#rateLimitResetsAt;
    const rejected = this.#rateLimitRejected;
    const error = classifyFailure(
      {
        ...(result?.result || this.#errorText ? { text: result?.result || this.#errorText } : {}),
        errors: result?.errors ?? [],
        stderr: exit.stderr,
        ...(result?.subtype ? { subtype: result.subtype } : {}),
        ...(result?.apiErrorStatus !== undefined
          ? { status: result.apiErrorStatus }
          : this.#apiRetry?.status !== undefined
            ? { status: this.#apiRetry.status }
            : {}),
        ...(this.#errorMarker
          ? { errorMarker: this.#errorMarker }
          : rejected
            ? { errorMarker: 'rate_limit' }
            : this.#apiRetry?.error
              ? { errorMarker: this.#apiRetry.error }
              : {}),
        ...(resetsAt ? { rateLimitResetsAt: resetsAt } : {}),
        exitCode: exit.exitCode,
      },
      now,
    );
    return { kind: 'error', error };
  }
}
