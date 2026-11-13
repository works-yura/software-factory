import { boardPath } from '../boardCatalog';

export type FactoryAttentionTarget =
  | { kind: 'thread'; sessionId: string; threadId: string }
  | { kind: 'work-item'; workItemId: string; board: string; commentId?: string }
  | { kind: 'rules' }
  | { kind: 'settings'; section: 'environment' };

export function factoryAttentionTargetPath(factoryId: string, target: FactoryAttentionTarget): string {
  if (target.kind === 'thread') {
    return `/factories/${factoryId}/workspaces/${encodeURIComponent(target.sessionId)}/threads/${encodeURIComponent(target.threadId)}`;
  }
  if (target.kind === 'work-item') {
    const comment = target.commentId ? `&comment=${encodeURIComponent(target.commentId)}` : '';
    return `${boardPath(factoryId, target.board)}?item=${encodeURIComponent(target.workItemId)}${comment}`;
  }
  if (target.kind === 'settings') return `/factories/${factoryId}/settings/${target.section}#sandboxes`;
  return `/factories/${factoryId}/rules`;
}
