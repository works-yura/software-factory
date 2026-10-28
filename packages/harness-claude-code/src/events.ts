import type { AgentTokenUsage, PlanDecision } from '@factory/harness';

import { classifyFailure, type ClaudeCodeError } from './errors.ts';
import { PERMISSION_PENDING_MARKER, SUBMIT_PLAN_TOOL_ID } from './gate.ts';
import type { ClaudeStreamMessage, ClaudeUsage } from './stream.ts';

/**
 * Claude Code's own plan-mode tool. `claude -p` does not offer it today; it is
 * still treated as a gate in case a future CLI does.
 */
export const EXIT_PLAN_MODE_TOOL = 'ExitPlanMode';
/** Tool calls that mean "the plan is ready for review". */
export const PLAN_GATE_TOOL_IDS: readonly string[] = [SUBMIT_PLAN_TOOL_ID, EXIT_PLAN_MODE_TOOL];
/** The contract's name for a plan gate, so the dispatcher's plan handling applies unchanged. */
export const PLAN_GATE_TOOL = 'submit_plan';

/**
 * What the turn said and did, richer than the runtime's events: a later phase
 * writes this into the UI thread.
 */
export type ClaudeTranscriptEntry =
  /**
   * What the turn was given, one entry per input, before the CLI starts: a
   * person's or the dispatcher's message (`signal`, with its signal id when it
   * had one) or a notification. The planning preamble and the prompt that
   * carries a plan decision are not inputs; see `plan_decision`.
   */
  | { kind: 'input'; source: 'signal' | 'notification'; text: string; id?: string }
  /** A person answered the plan the thread was parked on; the next turn carries the answer. */
  | { kind: 'plan_decision'; toolCallId: string; decision: PlanDecision }
  | { kind: 'init'; sessionId: string; model?: string; permissionMode?: string }
  | { kind: 'user'; text: string; parentToolCallId?: string }
  | { kind: 'text'; text: string; messageId?: string; parentToolCallId?: string }
  | { kind: 'thinking'; text: string; messageId?: string; parentToolCallId?: string }
  /** Partial output, only with `--include-partial-messages`; the full block follows as `text`/`thinking`. */
  | { kind: 'text_delta' | 'thinking_delta'; text: string; parentToolCallId?: string }
  | { kind: 'tool_call'; toolCallId: string; toolName: string; input: unknown; parentToolCallId?: string }
  | { kind: 'tool_result'; toolCallId: string; content: string; isError: boolean; parentToolCallId?: string }
  | { kind: 'plan'; toolCallId: string; toolName: string; plan?: string; title?: string }
  /**
   * A tool call that needs a person's permission (it stands in for the call's
   * refused result); the run parks on it once the turn stops.
   */
  | ({ kind: 'permission' } & PermissionRequest)
  /** A person allowed or denied the call the thread was parked on; the next turn carries the answer. */
  | { kind: 'permission_decision'; toolCallId: string; toolName: string; approved: boolean }
  | {
      kind: 'result';
      subtype: string;
      isError: boolean;
      text?: string;
      costUsd?: number;
      durationMs?: number;
      numTurns?: number;
    }
  | { kind: 'stdout'; text: string };

export interface PlanGate {
  toolCallId: string;
  /** The tool Claude called: {@link SUBMIT_PLAN_TOOL_ID} or {@link EXIT_PLAN_MODE_TOOL}. */
  toolName: string;
  plan?: string;
  title?: string;
}

/** A tool call the CLI asked permission for (through the gate's permission tool) and the harness parks on. */
export interface PermissionRequest {
  toolCallId: string;
  /** The tool as the CLI names it, e.g. `Write` or `mcp__server__tool`. */
  toolName: string;
  input?: unknown;
  /** The subagent call it came from, when a subagent made it. */
  parentToolCallId?: string;
  /** The tool asks on every call: an Allow lets this one call through, not the rest of the session. */
  once?: boolean;
}

export type TurnOutcome =
  | { kind: 'complete'; text?: string }
  | { kind: 'gate'; gate: PlanGate }
  | { kind: 'permission'; request: PermissionRequest }
  | { kind: 'error'; error: ClaudeCodeError };

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
  #result: Extract<ClaudeStreamMessage, { type: 'result' }> | undefined;
  #gate: PlanGate | undefined;
  #permission: PermissionRequest | undefined;
  /** Tool calls seen this turn, so a refused call's permission request names its tool and input. */
  #toolCalls = new Map<string, { toolName: string; input: unknown }>();
  #errorMarker: string | undefined;
  #errorText: string | undefined;
  #rateLimitRejected = false;
  #rateLimitResetsAt: Date | undefined;
  #started = false;

  get gate(): PlanGate | undefined {
    return this.#gate;
  }

  /** The first call this turn that waits for a person's permission; check it after each {@link push}. */
  get permission(): PermissionRequest | undefined {
    return this.#permission;
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
        if (message.subtype !== 'init' || !message.sessionId) return [];
        this.#started = true;
        {
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
      case 'assistant': {
        if (message.usage) {
          if (message.messageId) this.#usageByMessage.set(message.messageId, message.usage);
          else this.#anonymousUsage.push(message.usage);
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
            this.#toolCalls.set(block.id, { toolName: block.name, input: block.input });
            entries.push(
              withParent({ kind: 'tool_call', toolCallId: block.id, toolName: block.name, input: block.input }, parent),
            );
            // A subagent cannot ask the person for anything; only the main loop's plan is a gate.
            if (PLAN_GATE_TOOL_IDS.includes(block.name) && !parent && !this.#gate) {
              const input = block.input as { plan?: unknown; title?: unknown } | undefined;
              this.#gate = {
                toolCallId: block.id,
                toolName: block.name,
                ...(typeof input?.plan === 'string' ? { plan: input.plan } : {}),
                ...(typeof input?.title === 'string' && input.title.trim() ? { title: input.title } : {}),
              };
              entries.push({ kind: 'plan', ...this.#gate });
            }
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
      case 'user': {
        const parent = message.parentToolUseId;
        return message.content.flatMap((block): ClaudeTranscriptEntry[] => {
          if (block.type === 'text' && block.text) return [withParent({ kind: 'user', text: block.text }, parent)];
          if (block.type === 'tool_result') {
            // The permission tool refused the call so a person can answer it: the call waits, it did not fail.
            if (block.isError && block.content.includes(PERMISSION_PENDING_MARKER)) {
              if (this.#permission) return [];
              const call = this.#toolCalls.get(block.toolUseId);
              this.#permission = {
                toolCallId: block.toolUseId,
                toolName: call?.toolName ?? 'unknown',
                ...(call && call.input !== undefined ? { input: call.input } : {}),
                ...(parent ? { parentToolCallId: parent } : {}),
              };
              return [{ kind: 'permission', ...this.#permission }];
            }
            return [
              withParent(
                { kind: 'tool_result', toolCallId: block.toolUseId, content: block.content, isError: block.isError },
                parent,
              ),
            ];
          }
          return [];
        });
      }
      case 'stream_event': {
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
      case 'rate_limit':
        if (message.status === 'rejected') {
          this.#rateLimitRejected = true;
          if (message.resetsAt) this.#rateLimitResetsAt = message.resetsAt;
        }
        return [];
      case 'result':
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
      case 'invalid':
        return [{ kind: 'stdout', text: message.line }];
      case 'unknown':
        return [];
    }
  }

  /** One usage step per model message seen, or the result's total when no message carried usage. */
  usageSteps(): AgentTokenUsage[] {
    const perMessage = [...this.#usageByMessage.values(), ...this.#anonymousUsage];
    if (perMessage.length > 0) return perMessage.map(toTokenUsage);
    return this.#result?.usage ? [toTokenUsage(this.#result.usage)] : [];
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
        ...(result?.apiErrorStatus !== undefined ? { status: result.apiErrorStatus } : {}),
        ...(this.#errorMarker ? { errorMarker: this.#errorMarker } : rejected ? { errorMarker: 'rate_limit' } : {}),
        ...(resetsAt ? { rateLimitResetsAt: resetsAt } : {}),
        exitCode: exit.exitCode,
      },
      now,
    );
    return { kind: 'error', error };
  }
}
