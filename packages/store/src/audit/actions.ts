/**
 * Every action the trail can hold, by namespace. Register new ones in the
 * WorkOS dashboard under Audit Logs → Events before the mirror accepts them.
 */
export const AUDIT_ACTIONS = {
  work_item: [
    'created',
    'updated',
    'deleted',
    'stage_moved',
    'transition_rejected',
    'comment_created',
    'comment_edited',
    'comment_deleted',
    'comment_mentioned',
    'labels_reconciled',
  ],
  run: ['started', 'ended', 'approved', 'dismissed', 'retry', 'queued', 'rejected'],
  git: ['commit', 'push', 'pr_opened'],
  agent: ['commit', 'push', 'pr_opened', 'signaled'],
  intake: ['config_updated', 'binding_updated', 'label_route_updated'],
  board: ['created', 'updated', 'deleted', 'reset'],
  skill: ['updated', 'reverted'],
  intake_route: ['created', 'updated', 'deleted', 'reordered', 'rerouted'],
  // Retired with intake rules (ADR-0021); nothing writes it, but past audit rows still read by it.
  intake_rule: ['created', 'updated', 'deleted'],
  observability: ['connected', 'disconnected', 'mapping_updated'],
  // An organization's integration token (ClickUp, …; ADR-0032): connected, replaced or removed. Never the token.
  // `connection_removed`: a GitHub connection deleted, with the repositories moved and unlinked (ADR-0034).
  integration: ['token_connected', 'token_removed', 'connection_removed'],
  sandbox_env: ['set', 'updated', 'deleted', 'stages_updated', 'file_created', 'file_updated', 'file_deleted'],
  // External MCP servers: their config, and each agent call to one of their tools (no payloads).
  mcp_server: ['created', 'updated', 'deleted', 'tool_called', 'tool_tried', 'reconnected'],
  // The organization itself (ADR-0045): its name and avatar, members' roles, invitations and join links.
  organization: [
    'updated',
    'member_role_changed',
    'member_removed',
    'member_left',
    'invitation_created',
    'invitation_canceled',
    'invitation_accepted',
    'join_link_created',
    'join_link_revoked',
    'join_link_used',
  ],
  // A person's assistant erased (ADR-0051): removed from the organization, account deleted, cleared
  // by them, never its content — only why and how many requests and files went.
  assistant: ['cleared'],
} as const;

export type AuditNamespace = keyof typeof AUDIT_ACTIONS;

export type AuditAction = {
  [Namespace in AuditNamespace]: `factory.${Namespace}.${(typeof AUDIT_ACTIONS)[Namespace][number]}`;
}[AuditNamespace];

export function isAuditNamespace(value: string): value is AuditNamespace {
  return Object.hasOwn(AUDIT_ACTIONS, value);
}

export function auditNamespaces(): AuditNamespace[] {
  return Object.keys(AUDIT_ACTIONS).filter(isAuditNamespace);
}

export function parseAuditAction(action: string): { namespace: AuditNamespace; leaf: string } | undefined {
  const [prefix, namespace, leaf, ...rest] = action.split('.');
  if (prefix !== 'factory' || namespace === undefined || leaf === undefined || rest.length > 0) return undefined;
  return isAuditNamespace(namespace) ? { namespace, leaf } : undefined;
}

export function isAuditAction(value: string): value is AuditAction {
  const parsed = parseAuditAction(value);
  return parsed !== undefined && AUDIT_ACTIONS[parsed.namespace].some(leaf => leaf === parsed.leaf);
}

export function auditActionsInNamespaces(namespaces: readonly AuditNamespace[]): string[] {
  return namespaces.flatMap(namespace => AUDIT_ACTIONS[namespace].map(leaf => `factory.${namespace}.${leaf}`));
}
