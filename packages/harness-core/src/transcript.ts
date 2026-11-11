// The transcript a turn-based harness records: what a session was given and what its agent said and
// did, richer than the runtime's events. Claude Code and Codex sessions both emit it, and the chat
// UI's channel (`@factory/harness-claude-code-ui`) projects it into thread messages.
import type { PlanDecision } from './contract.ts';
import type { ModelSelection } from './models/contracts.ts';

/**
 * The tool name a question to the person travels under in the transcript (Claude Code's own
 * `AskUserQuestion`; Codex's `request_user_input` is recorded the same way). The run parks on it
 * and the answer goes back to the agent instead of the call running.
 */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

/** The question a person sees for an `AskUserQuestion` call, as the chat's `ask_user` card reads it. */
export interface AskUserPrompt {
  question: string;
  options?: Array<{ label: string; description?: string }>;
  selectionMode?: 'single_select' | 'multi_select';
  /**
   * Every question of a call that asks several, as asked: the chat draws one block per question and
   * sends all answers together. `question` still carries them as numbered text for older readers.
   */
  questions?: AskUserQuestionItem[];
}

/** One question of an `AskUserQuestion` call that asks several. */
export interface AskUserQuestionItem {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

/**
 * Reads an `AskUserQuestion` input (`{ questions: [{ question, header?,
 * options?, multiSelect? }] }`). One question keeps its options; several keep
 * each question's options in `questions` and are also listed as numbered text.
 */
export function askUserPrompt(input: unknown, fallback = 'The agent has a question.'): AskUserPrompt {
  const record = input && typeof input === 'object' ? (input as { questions?: unknown }) : {};
  const questions = (Array.isArray(record.questions) ? record.questions : []).flatMap(entry => {
    if (!entry || typeof entry !== 'object') return [];
    const { question, header, options, multiSelect } = entry as Record<string, unknown>;
    if (typeof question !== 'string' || !question.trim()) return [];
    const choices = (Array.isArray(options) ? options : []).flatMap(option => {
      const { label, description } = (option ?? {}) as Record<string, unknown>;
      return typeof label === 'string' && label.trim()
        ? [{ label, ...(typeof description === 'string' && description.trim() ? { description } : {}) }]
        : [];
    });
    return [{ question, header: typeof header === 'string' ? header : undefined, choices, multi: multiSelect === true }];
  });
  if (questions.length === 0) return { question: fallback };
  if (questions.length === 1) {
    const [only] = questions;
    return {
      question: only!.question,
      ...(only!.choices.length
        ? { options: only!.choices, selectionMode: only!.multi ? ('multi_select' as const) : ('single_select' as const) }
        : {}),
    };
  }
  return {
    question: questions
      .map((entry, index) => {
        const choices = entry.choices.length ? ` (${entry.choices.map(choice => choice.label).join(' / ')})` : '';
        return `${index + 1}. ${entry.question}${choices}`;
      })
      .join('\n'),
    questions: questions.map(entry => ({
      question: entry.question,
      ...(entry.header ? { header: entry.header } : {}),
      ...(entry.choices.length ? { options: entry.choices } : {}),
      ...(entry.multi ? { multiSelect: true } : {}),
    })),
  };
}

/** A message's author, as Mastra stamps one on a person's message (`providerOptions.mastra.author`). */
export interface MessageAuthor {
  id: string;
  name?: string;
  avatarUrl?: string;
}

/**
 * A notification as the session keeps it, with the fields a Mastra
 * notification record carries into its signal (`createNotificationSignal`):
 * the chat's notification card reads its source, kind and metadata.
 */
export interface NotificationRecord {
  id: string;
  source: string;
  kind: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  summary: string;
  payload?: unknown;
  sourceId?: string;
  dedupeKey?: string;
  coalesceKey?: string;
  /** How many notifications were merged into this one (same source, kind and coalesce key). */
  coalescedCount?: number;
  attributes?: Record<string, string | number | boolean | null | undefined>;
  metadata?: Record<string, unknown>;
  /** ISO time it was first received. */
  createdAt: string;
}

/**
 * What the turn said and did, richer than the runtime's events: a later phase
 * writes this into the UI thread.
 */
export type TranscriptEntry =
  /**
   * What the session was given, one entry per input: a person's or the
   * dispatcher's message (`signal`, with its signal id when it had one) or a
   * notification. Recorded once, when the session takes it: before the turn
   * that carries it starts, or right away for input that joins a run in
   * flight (`delivery: 'while-active'`, as a Mastra interjection is marked).
   * The planning preamble and the prompt that carries a plan decision are not
   * inputs; see `plan_decision`.
   */
  | {
      kind: 'input';
      source: 'signal' | 'notification';
      text: string;
      id?: string;
      /** Who wrote it, when a person did (the request's message author). */
      author?: MessageAuthor;
      /** Set when the input joined a run in flight. */
      delivery?: 'while-active';
      /** The notification as the Factory sent it, for a `notification` input. */
      notification?: NotificationRecord;
      /** The turn this input starts runs another model or effort than the thread's last turn. */
      modelSwitch?: { from: ModelSelection; to: ModelSelection };
    }
  /** A person answered the plan the thread was parked on; the next turn carries the answer. */
  | { kind: 'plan_decision'; toolCallId: string; decision: PlanDecision }
  | { kind: 'init'; sessionId: string; model?: string; permissionMode?: string }
  /** The account the turn runs on, as a person reads it; `ownerId` when it is someone's own sign-in. */
  | { kind: 'credential'; label: string; ownerId?: string }
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
  /** A person answered the question (`AskUserQuestion`) the thread was parked on; the next turn carries the answer. */
  | { kind: 'question_answer'; toolCallId: string; answer: string }
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
  /** The tool the agent called for its plan (Claude Code's gate tool, `submit_plan` for others). */
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
