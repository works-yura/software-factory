// The OpenCode config a run's server starts with (`OPENCODE_CONFIG_CONTENT`): the Factory's tool
// permissions as OpenCode's permission rules, the Factory's MCP servers, and nothing shared or
// updated behind the run's back. The checkout's own `opencode.json` still applies on top, as a
// repository's AGENTS.md does for the other harnesses.

/** How a rule answers a call: run it, ask a person, or refuse it. */
export type OpenCodePermissionAction = 'allow' | 'ask' | 'deny';

/**
 * How a run may act. There is no "allow everything" mode: leaving the checkout
 * (`external_directory`) and a call repeated in a loop (`doom_loop`) always ask.
 */
export interface OpenCodeTurnPolicy {
  /** Writing files in the checkout (`edit`, `write`, `patch`); `ask` by default. */
  edit?: OpenCodePermissionAction;
  /** Shell commands (`bash`); `ask` by default. */
  bash?: OpenCodePermissionAction;
  /** Reading web pages (`webfetch`, `websearch`); `allow` by default. */
  web?: OpenCodePermissionAction;
  /**
   * Nobody watches the run (a card run): what it would ask about is refused, unless `parkAsks`
   * parks it for a person on the board and in the inbox.
   */
  unattended?: boolean;
  parkAsks?: boolean;
  /**
   * Tools asked about on every call (transcript names, e.g. `mcp__factory__factory_retry_decision`):
   * an Allow lets that one call through, never the rest of the session.
   */
  askEachTime?: string[];
}

/** An MCP server OpenCode reaches for the run: the Factory's tools over HTTP with the run's token. */
export interface OpenCodeMcpServer {
  url: string;
  headers?: Record<string, string>;
}

/** OpenCode names an MCP tool `<server>_<tool>`, with anything but letters, digits, `_` and `-` as `_`. */
export function openCodeMcpToolId(server: string, tool: string): string {
  const clean = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${clean(server)}_${clean(tool)}`;
}

/** `mcp__<server>__<tool>` (the transcript's name) as OpenCode's tool id; other names as they are. */
export function openCodeToolIdForTranscriptName(name: string): string {
  const match = /^mcp__([^_].*?)__(.+)$/.exec(name);
  return match ? openCodeMcpToolId(match[1]!, match[2]!) : name;
}

/** An ask the run cannot make (nobody watches, nothing parks) is a refusal. */
function effective(action: OpenCodePermissionAction, policy: OpenCodeTurnPolicy): OpenCodePermissionAction {
  return action === 'ask' && policy.unattended && !policy.parkAsks ? 'deny' : action;
}

/**
 * OpenCode's permission rules for a run's policy. OpenCode lets a tool no rule names run, so the
 * first rule (`*`, the last rule that matches wins) asks about everything not listed here: a
 * plugin's tool, an MCP server the checkout's own config adds. The Factory's own MCP servers
 * (`mcpServers`) are allowed; their tools that change data are asked about each time (`askEachTime`).
 */
export function openCodePermissionRules(policy: OpenCodeTurnPolicy, mcpServers: readonly string[] = []): Record<string, OpenCodePermissionAction> {
  const web = policy.web ?? 'allow';
  const rules: Record<string, OpenCodePermissionAction> = {
    '*': effective('ask', policy),
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    lsp: 'allow',
    todowrite: 'allow',
    todoread: 'allow',
    // OpenCode's own answer to a malformed call: it runs nothing.
    invalid: 'allow',
    question: 'allow',
    edit: effective(policy.edit ?? 'ask', policy),
    bash: effective(policy.bash ?? 'ask', policy),
    webfetch: effective(web, policy),
    websearch: effective(web, policy),
    codesearch: effective(web, policy),
    task: 'allow',
    skill: 'allow',
    external_directory: effective('ask', policy),
    doom_loop: effective('ask', policy),
  };
  for (const server of mcpServers) rules[`${openCodeMcpToolId(server, '')}*`] = 'allow';
  for (const name of policy.askEachTime ?? []) rules[openCodeToolIdForTranscriptName(name)] = effective('ask', policy);
  return rules;
}

/** The config JSON a run's server starts with. */
export function openCodeConfigContent(input: { policy: OpenCodeTurnPolicy; mcpServers?: Record<string, OpenCodeMcpServer> }): string {
  const mcp = Object.fromEntries(
    Object.entries(input.mcpServers ?? {}).map(([name, server]) => [
      name,
      { type: 'remote', url: server.url, enabled: true, oauth: false, ...(server.headers ? { headers: server.headers } : {}) },
    ]),
  );
  return JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    permission: openCodePermissionRules(input.policy, Object.keys(mcp)),
    ...(Object.keys(mcp).length ? { mcp } : {}),
  });
}
