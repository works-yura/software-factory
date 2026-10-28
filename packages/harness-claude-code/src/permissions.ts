import { GATE_SERVER_NAME } from './gate.ts';

/**
 * Tool permissions for Claude Code turns, from a host's per-category policy
 * (the Factory's Settings → Behavior → Tool permissions).
 *
 * The CLI takes them as rules: `allow` goes to `--allowedTools`, `deny` to
 * `--disallowedTools`, and `ask` to the `permissions.ask` setting, which sends
 * every matching call to the permission prompt tool (the gate server's
 * `permission_prompt`), even a read-only call or an edit the permission mode
 * would accept on its own. Precedence in the CLI is deny, then ask, then allow,
 * so a tool a person allowed for the session leaves the ask list rather than
 * joining the allow list.
 */
export type ClaudeToolPolicy = 'allow' | 'ask' | 'deny';
export type ClaudeToolCategory = 'read' | 'edit' | 'execute' | 'mcp' | 'other';

export interface ClaudeToolPermissions {
  /** A category with no policy asks, as the settings page shows it. */
  categories?: Partial<Record<ClaudeToolCategory, ClaudeToolPolicy>>;
  /** Auto-approve: every category is allowed. */
  yolo?: boolean;
}

/** The CLI's built-in tools per category; MCP servers are named per turn. */
export const CLAUDE_TOOL_CATEGORY_TOOLS: Readonly<Record<Exclude<ClaudeToolCategory, 'mcp'>, readonly string[]>> = {
  read: ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'],
  edit: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
  execute: ['Bash', 'BashOutput', 'KillShell', 'Monitor'],
  other: [
    'WebFetch',
    'WebSearch',
    'Task',
    'Agent',
    'Skill',
    'SlashCommand',
    'Workflow',
    'CronCreate',
    'CronDelete',
    'CronList',
    'ScheduleWakeup',
    'RemoteTrigger',
    'SendMessage',
    'PushNotification',
    'EnterWorktree',
    'ExitWorktree',
  ],
};

export const CLAUDE_TOOL_CATEGORIES: readonly ClaudeToolCategory[] = ['read', 'edit', 'execute', 'mcp', 'other'];

export interface ClaudePermissionRules {
  allow: string[];
  ask: string[];
  deny: string[];
}

/**
 * The rules one turn runs with. `mcpServers` are the turn's MCP servers; the
 * gate server and `trustedMcpServers` (the host's own plumbing, e.g. the
 * Factory's tools) are never governed by the MCP category. `granted` are
 * tools a person allowed for the session: they leave the ask list.
 */
export function claudePermissionRules(
  permissions: ClaudeToolPermissions,
  { mcpServers = [], trustedMcpServers = [], granted = [] }: { mcpServers?: string[]; trustedMcpServers?: string[]; granted?: string[] } = {},
): ClaudePermissionRules {
  const rules: ClaudePermissionRules = { allow: [], ask: [], deny: [] };
  const own = new Set([GATE_SERVER_NAME, ...trustedMcpServers]);
  const grantedSet = new Set(granted);
  for (const category of CLAUDE_TOOL_CATEGORIES) {
    const policy: ClaudeToolPolicy = permissions.yolo ? 'allow' : (permissions.categories?.[category] ?? 'ask');
    const tools =
      category === 'mcp'
        ? mcpServers.filter(server => !own.has(server)).map(server => `mcp__${server}`)
        : [...CLAUDE_TOOL_CATEGORY_TOOLS[category]];
    for (const tool of tools) {
      if (policy === 'deny') rules.deny.push(tool);
      else if (policy === 'allow' || grantedSet.has(tool)) rules.allow.push(tool);
      else rules.ask.push(tool);
    }
  }
  // A granted tool outside the lists (an MCP tool, a newer built-in) is allowed too.
  for (const tool of granted) {
    if (!rules.allow.includes(tool) && !rules.deny.includes(tool)) rules.allow.push(tool);
  }
  // A granted MCP tool must not stay asked through its server's rule.
  if (granted.some(tool => tool.startsWith('mcp__'))) {
    rules.ask = rules.ask.filter(rule => !granted.some(tool => tool.startsWith(`${rule}__`)));
  }
  return rules;
}
