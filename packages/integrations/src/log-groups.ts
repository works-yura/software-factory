/**
 * Log entries counted by kind: the same error from the same service, whatever ids, numbers and
 * times it carries, is one group. What an audit reads first — «which errors, how many, since when»
 * — without pulling thousands of lines into a model's context.
 */

import type { LogSeverity, ObservabilityLogEntry } from '@factory/capabilities';
import { LOG_SEVERITIES } from '@factory/capabilities';

export interface LogGroup {
  service: string | null;
  /** The message with ids and numbers replaced, cut to its first line and `PATTERN_CHARS`. */
  pattern: string;
  count: number;
  /** The highest severity in the group. */
  severity: LogSeverity;
  firstAt: string;
  lastAt: string;
  /** One whole (already redacted) message of the group, newest. */
  sample: string;
}

export interface LogGroupSummary {
  bySeverity: Record<string, number>;
  byService: Record<string, number>;
  /** Largest first; ties by the latest entry. */
  groups: LogGroup[];
  groupsTotal: number;
}

const PATTERN_CHARS = 140;
const SAMPLE_CHARS = 600;

const ID_PATTERNS: readonly RegExp[] = [
  // UUIDs.
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  // Prefixed message ids (WhatsApp `wamid.…`) and other dotted ids.
  /\b[a-z]{2,10}\.(?=[A-Za-z0-9=_-]*\d)[A-Za-z0-9=_-]{16,}/g,
  // Long tokens with a digit in them: Firestore ids, hashes, base64.
  /\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}\b/g,
];

/** The message as its group names it: ids, then any number, replaced; first line only. */
export function logPattern(message: string): string {
  let text = (message.split('\n', 1)[0] ?? '').trim();
  for (const pattern of ID_PATTERNS) text = text.replace(pattern, '<id>');
  text = text.replace(/\d+(?:[.,:]\d+)*/g, '<n>');
  return text.replace(/\s+/g, ' ').slice(0, PATTERN_CHARS);
}

function severityRank(severity: LogSeverity): number {
  return LOG_SEVERITIES.indexOf(severity);
}

/** Counts entries by severity, by service and by group; returns the `top` largest groups. */
export function groupLogEntries(entries: readonly ObservabilityLogEntry[], top: number): LogGroupSummary {
  const bySeverity: Record<string, number> = {};
  const byService: Record<string, number> = {};
  const groups = new Map<string, LogGroup>();
  for (const entry of entries) {
    bySeverity[entry.severity] = (bySeverity[entry.severity] ?? 0) + 1;
    const service = entry.service ?? '(none)';
    byService[service] = (byService[service] ?? 0) + 1;
    const pattern = logPattern([entry.request, entry.message].filter(Boolean).join(' · '));
    const key = `${service}\u0000${pattern}`;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, {
        service: entry.service,
        pattern,
        count: 1,
        severity: entry.severity,
        firstAt: entry.timestamp,
        lastAt: entry.timestamp,
        sample: entry.message.slice(0, SAMPLE_CHARS),
      });
      continue;
    }
    group.count += 1;
    if (severityRank(entry.severity) > severityRank(group.severity)) group.severity = entry.severity;
    if (entry.timestamp < group.firstAt) group.firstAt = entry.timestamp;
    if (entry.timestamp > group.lastAt) {
      group.lastAt = entry.timestamp;
      group.sample = entry.message.slice(0, SAMPLE_CHARS);
    }
  }
  const sorted = [...groups.values()].sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt));
  return { bySeverity, byService, groups: sorted.slice(0, top), groupsTotal: sorted.length };
}
