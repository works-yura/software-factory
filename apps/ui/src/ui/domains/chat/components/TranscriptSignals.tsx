import { mastraDBMessageToSignal } from '@mastra/core/signals';

import type { SkillActivation } from '@mastra/playground-ui/domains/chat/messages/skill-activation';

import { translator } from '../../../i18n/t';
import { parseSkillBody } from '../services/skill-body';
import type { MessageEntry, TimelineEntry } from '../services/transcript';
import { isRecord } from './transcript-shared';

export function signalPartsText(entry: MessageEntry): string {
  const { contents } = mastraDBMessageToSignal(entry.message);
  if (typeof contents === 'string') return contents.trim();

  return contents
    .flatMap(part => (part.type === 'text' && part.text ? [part.text] : []))
    .join('\n')
    .trim();
}

/** A typed `skill` signal (how Factory starts a skill run), parsed for the skill row. */
export function skillSignalActivation(entry: MessageEntry): SkillActivation | undefined {
  if (entry.message.role !== 'signal') return undefined;
  const signal = entry.message.content.metadata?.signal;
  if (!isRecord(signal) || signal.type !== 'reactive' || signal.tagName !== 'skill') return undefined;
  const name = isRecord(signal.attributes) ? signal.attributes.name : undefined;
  return typeof name === 'string' ? parseSkillBody(name, signalPartsText(entry)) : undefined;
}

/** The pause reminder the agent gets before a message sent after a while; the transcript draws its own divider. */
export function isTemporalGapSignal(entry: MessageEntry): boolean {
  const signal = entry.message.content.metadata?.signal;
  return isRecord(signal) && isRecord(signal.attributes) && signal.attributes.type === 'temporal-gap';
}

export const HIDDEN_REACTIVE_SIGNAL_TAGS = new Set(['github-subscribe-pr', 'github-unsubscribe-pr']);
export const SUPPRESSED_STATE_SIGNAL_IDS = new Set(['tasks', 'goal']);

export type SignalRowView =
  | { kind: 'state'; stateId: string; mode: 'snapshot' | 'delta'; text: string }
  | { kind: 'divider'; label: string; title?: string }
  | { kind: 'reminder'; text: string; loadedFile?: string }
  | { kind: 'reactive'; tagName?: string; text: string };

const tk = translator('chat');

/** The signal tag of a context handoff's timeline marker (the server's `CONTEXT_HANDOFF_SIGNAL_TAG`). */
export const CONTEXT_HANDOFF_SIGNAL_TAG = 'factory-context-handoff';

/** `content.metadata.contextHandoff`: a session's move to another harness, or to a fresh conversation. */
export interface ContextHandoffMarker {
  from: string;
  to: string;
  reason: 'switch' | 'resume_failed';
  status: 'pending' | 'delivered' | 'failed';
  error?: string;
}

export function readContextHandoff(metadata: Record<string, unknown> | undefined): ContextHandoffMarker | null {
  const value = metadata?.contextHandoff;
  if (!isRecord(value) || typeof value.from !== 'string' || typeof value.to !== 'string') return null;
  const status = value.status === 'delivered' || value.status === 'failed' ? value.status : 'pending';
  return {
    from: value.from,
    to: value.to,
    reason: value.reason === 'resume_failed' ? 'resume_failed' : 'switch',
    status,
    ...(typeof value.error === 'string' && value.error ? { error: value.error } : {}),
  };
}

/**
 * The divider a context handoff draws: "Context handoff: Claude Code → Codex", marked while the
 * context waits for the next message and when it could not be carried.
 */
export function contextHandoffRow(marker: ContextHandoffMarker): Extract<SignalRowView, { kind: 'divider' }> {
  const base = tk(marker.reason === 'resume_failed' ? 'modelPicker.handoffLabelNewConversation' : 'modelPicker.handoffLabel', {
    from: marker.from,
    to: marker.to,
  });
  const label =
    marker.status === 'pending'
      ? tk('modelPicker.handoffPending', { label: base })
      : marker.status === 'failed'
        ? tk('modelPicker.handoffFailed', { label: base })
        : base;
  return { kind: 'divider', label, ...(marker.status === 'failed' && marker.error ? { title: marker.error } : {}) };
}

export function signalRowView(entry: MessageEntry): SignalRowView | undefined {
  if (entry.message.role !== 'signal') return undefined;
  const signal = entry.message.content.metadata?.signal;
  if (!isRecord(signal)) return undefined;
  if (signal.tagName === CONTEXT_HANDOFF_SIGNAL_TAG) {
    const marker = readContextHandoff(entry.message.content.metadata);
    return marker ? contextHandoffRow(marker) : undefined;
  }

  const tagName = typeof signal.tagName === 'string' ? signal.tagName : undefined;
  const text = signalPartsText(entry);
  const reminder: SignalRowView = { kind: 'reminder', text, loadedFile: loadedFile(signal.attributes) };

  if (signal.type === 'state') {
    const metadata = isRecord(signal.metadata) ? signal.metadata : {};
    const stateMeta = isRecord(metadata.state) ? metadata.state : {};
    return {
      kind: 'state',
      stateId: (typeof stateMeta.id === 'string' ? stateMeta.id : undefined) ?? tagName ?? 'state',
      mode: stateMeta.mode === 'delta' ? 'delta' : 'snapshot',
      text,
    };
  }
  // `normalizeSignal` maps `system-reminder` to `reactive` + `system-reminder`
  // tag before persistence, but live pre-normalized signals may carry the raw type.
  if (signal.type === 'system-reminder') return reminder;
  if (signal.type === 'reactive' && tagName === 'system-reminder') return reminder;
  if (signal.type === 'reactive') return { kind: 'reactive', tagName, text };
  return undefined;
}

function loadedFile(attributes: unknown): string | undefined {
  if (!isRecord(attributes) || attributes.type !== 'dynamic-agents-md') return undefined;
  return typeof attributes.path === 'string' ? attributes.path : undefined;
}

function environmentWorkingDirectory(entry: TimelineEntry): string | undefined {
  if (entry.kind !== 'message' || entry.message.role !== 'signal') return undefined;
  const signal = entry.message.content.metadata?.signal;
  if (!isRecord(signal) || signal.tagName !== 'factory-environment' || !isRecord(signal.attributes)) return undefined;
  const { workingDirectory } = signal.attributes;
  return typeof workingDirectory === 'string' ? workingDirectory : undefined;
}

export function agentWorkingDirectory(entries: readonly TimelineEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const directory = environmentWorkingDirectory(entries[index]);
    if (directory) return directory;
  }
  return undefined;
}

export function isTurnDivider(entry: TimelineEntry | undefined): boolean {
  return entry?.kind === 'message' && signalRowView(entry)?.kind === 'divider';
}
