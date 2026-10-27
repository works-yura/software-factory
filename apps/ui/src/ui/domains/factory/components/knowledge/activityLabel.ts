import { translator } from '../../../../i18n/t';
import type { KnowledgeActivityEvent } from '../../services/knowledge';

const tk = translator('knowledge');

export function knowledgeActivityLabel(event: KnowledgeActivityEvent): string {
  switch (event.action) {
    case 'record-created':
      return tk('activity.action.recordCreated');
    case 'record-deleted':
      return tk('activity.action.recordDeleted');
    case 'record-restored':
      return tk('activity.action.recordRestored');
    case 'record-rescoped':
      return tk('activity.action.recordRescoped');
    case 'node-created':
      return tk('activity.action.nodeCreated');
    case 'node-updated':
      return tk('activity.action.nodeUpdated');
    case 'node-merged':
      return tk('activity.action.nodeMerged');
    default:
      // An action this UI does not know comes from the server as-is.
      return event.action.replaceAll('-', ' ');
  }
}

/** Notice for a scope whose activity window cannot cover every member. */
export function knowledgeActivityTruncated(): string {
  return tk('activity.truncated');
}
