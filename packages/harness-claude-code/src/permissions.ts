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
  /**
   * Tools (CLI names, e.g. `mcp__factory__factory_retry_decision`) that ask on
   * every call whatever their category says, unless auto-approve is on. A
   * person's Allow lets the waiting call through once, not for the session.
   */
  askEachTime?: string[];
  /**
   * Nobody is there to answer (a card run started by the Factory). Reading
   * (Read tools, and `git` and `gh` in the shell) and starting subagents are
   * allowed unless their category is denied; every other call that would ask is refused at once by
   * the gate, with a message saying why, instead of parking the run.
   */
  unattended?: boolean;
}

/** Shell commands an unattended run may use unless the Execute category is denied. */
export const CLAUDE_UNATTENDED_SHELL_RULES: readonly string[] = ['Bash(git:*)', 'Bash(gh:*)'];

/**
 * Tools an unattended run may use unless their category is denied: the
 * subagent tool. Starting a subagent changes nothing by itself, and every
 * call the subagent makes goes through the same rules (and is refused the same
 * way) as the run's own.
 */
export const CLAUDE_UNATTENDED_ALLOWED_TOOLS: readonly string[] = ['Agent', 'Task'];

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
    'ListAgents',
    'PushNotification',
    'EnterWorktree',
    'ExitWorktree',
  ],
};

/**
 * Built-in tools the CLI also answers to under an old name. Its rules match a
 * tool by name or alias, so an ask rule for `Task` still asks for `Agent`: a
 * grant covers every name of the tool.
 */
export const CLAUDE_TOOL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  Agent: ['Task'],
  Task: ['Agent'],
};

/**
 * Built-in tools no category governs, each reviewed: the CLI's own plumbing,
 * which reaches nothing outside the session. A built-in tool that is in
 * neither list is one nobody reviewed (the CLI contract tests fail on it).
 */
export const CLAUDE_UNGOVERNED_TOOLS: readonly string[] = [
  // The task list.
  'TodoWrite',
  // Loads the schema of a deferred tool; the tool itself is still governed.
  'ToolSearch',
  // Stops a background task (a subagent, a shell) this session started.
  'TaskStop',
  // Structured findings in the session's own output.
  'ReportFindings',
];

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
  granted = [...new Set(granted.flatMap(tool => [tool, ...(CLAUDE_TOOL_ALIASES[tool] ?? [])]))];
  const grantedSet = new Set(granted);
  for (const category of CLAUDE_TOOL_CATEGORIES) {
    let policy: ClaudeToolPolicy = permissions.yolo ? 'allow' : (permissions.categories?.[category] ?? 'ask');
    // An unattended run reads without asking: nobody could answer.
    if (permissions.unattended && category === 'read' && policy === 'ask') policy = 'allow';
    const tools =
      category === 'mcp'
        ? mcpServers.filter(server => !own.has(server)).map(server => `mcp__${server}`)
        : [...CLAUDE_TOOL_CATEGORY_TOOLS[category]];
    for (const tool of tools) {
      const unattendedAllowed = permissions.unattended && CLAUDE_UNATTENDED_ALLOWED_TOOLS.includes(tool);
      if (policy === 'deny') rules.deny.push(tool);
      else if (policy === 'allow' || grantedSet.has(tool) || unattendedAllowed) rules.allow.push(tool);
      // An ask rule for `Bash` would outrank `Bash(git:*)`: unlisted, the other commands still reach the gate.
      else if (permissions.unattended && tool === 'Bash') rules.allow.push(...CLAUDE_UNATTENDED_SHELL_RULES);
      else rules.ask.push(tool);
    }
  }
  if (!permissions.yolo) {
    for (const tool of permissions.askEachTime ?? []) {
      if (rules.deny.includes(tool)) continue;
      if (grantedSet.has(tool)) rules.allow.push(tool);
      else {
        rules.allow = rules.allow.filter(rule => rule !== tool);
        if (!rules.ask.includes(tool)) rules.ask.push(tool);
      }
    }
  }
  // A granted tool outside the lists (an MCP tool, a newer built-in) is allowed too.
  rules.allow = [...new Set(rules.allow)];
  for (const tool of granted) {
    if (!rules.allow.includes(tool) && !rules.deny.includes(tool)) rules.allow.push(tool);
  }
  // A granted MCP tool must not stay asked through its server's rule.
  if (granted.some(tool => tool.startsWith('mcp__'))) {
    rules.ask = rules.ask.filter(rule => !granted.some(tool => tool.startsWith(`${rule}__`)));
  }
  return rules;
}
