import type { AuditEvent } from './services/audit';
import { stageLabel } from './stages';

export function auditVisibleMetadata(event: AuditEvent): Record<string, unknown> {
  const visible: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event.metadata)) {
    if (!key.startsWith('__')) visible[key] = value;
  }
  return visible;
}

export function auditDetailLine(event: AuditEvent): string {
  if (event.action === 'factory.run.ended' && typeof event.metadata.reason === 'string') return event.metadata.reason;
  const to = event.metadata.to;
  if (event.action !== 'factory.work_item.stage_moved' || typeof to !== 'string') return '';
  const from = event.metadata.from;
  return typeof from === 'string' ? `${stageLabel(from)} → ${stageLabel(to)}` : `→ ${stageLabel(to)}`;
}

/** What the factory itself is called wherever it acts as an actor. */
export const SYSTEM_ACTOR_NAME = 'Factory';
