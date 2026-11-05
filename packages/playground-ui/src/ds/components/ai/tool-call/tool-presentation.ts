import type { LucideIcon } from 'lucide-react';
import { libText } from '@/lib/lib-text';

import type { ToolKind } from './tool-phrases';
import { agentGlyph } from '@/ds/components/AgentIndicator';
import type { AgentIndicatorState } from '@/ds/components/AgentIndicator';
import { humanize } from '@/lib/string';

export interface ToolPresentation {
  /** What the agent indicator turns into while this call runs. */
  pose: AgentIndicatorState;
  /** The pose held still, so the call's row and the live indicator draw the same thing. */
  icon: LucideIcon;
  /** The tool's name for people, translated: "Run". */
  label: string;
  /** Stable English kind behind `label` ("Run"), which groups calls and picks their phrases; unset for unknown tools. */
  kind?: ToolKind;
  /** Salient argument shown next to the label: command, path, pattern… */
  detail?: string;
  /**
   * What a command does, in the agent's words. `ActivityHeadline` shows it alone in place of
   * label and detail; both stay set for consumers that render them directly.
   */
  description?: string;
  /** Shell command, when the tool is terminal-style. Drives the expanded body. */
  command?: string;
}

/** Tool arguments and results as the mono body shows them: strings verbatim, the rest pretty JSON. */
export function stringifyToolValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function hasProperty<K extends string>(value: object, key: K): value is object & Record<K, unknown> {
  return key in value;
}

function stringArg(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== 'object' || !hasProperty(args, key)) return undefined;
  const value = args[key];
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function firstStringArg(args: unknown, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringArg(args, key);
    if (value) return value;
  }
  return undefined;
}

interface ToolStyle {
  pose: AgentIndicatorState;
  label: ToolKind;
  detailKeys?: string[];
  isCommand?: boolean;
}

const TOOL_STYLES: Record<string, ToolStyle> = {
  view: { pose: 'reading', label: 'Read', detailKeys: ['path'] },
  read_file: { pose: 'reading', label: 'Read', detailKeys: ['path'] },
  write_file: { pose: 'editing', label: 'Write', detailKeys: ['path'] },
  create_file: { pose: 'editing', label: 'Write', detailKeys: ['path'] },
  edit_file: { pose: 'editing', label: 'Edit', detailKeys: ['path'] },
  string_replace: { pose: 'editing', label: 'Edit', detailKeys: ['path'] },
  string_replace_lsp: { pose: 'editing', label: 'Edit', detailKeys: ['path'] },
  str_replace: { pose: 'editing', label: 'Edit', detailKeys: ['path'] },
  ast_edit: { pose: 'editing', label: 'Edit', detailKeys: ['path'] },
  ast_smart_edit: { pose: 'editing', label: 'Edit', detailKeys: ['path'] },
  execute_command: { pose: 'running', label: 'Run', detailKeys: ['command'], isCommand: true },
  get_process_output: { pose: 'reading', label: 'Process output', detailKeys: ['pid'] },
  kill_process: { pose: 'running', label: 'Stop process', detailKeys: ['pid'] },
  find_files: { pose: 'finding', label: 'Find files', detailKeys: ['pattern', 'path'] },
  list_files: { pose: 'finding', label: 'List files', detailKeys: ['pattern', 'path'] },
  grep: { pose: 'searching', label: 'Search', detailKeys: ['pattern', 'path'] },
  search_content: { pose: 'searching', label: 'Search', detailKeys: ['pattern', 'query'] },
  search: { pose: 'searching', label: 'Search', detailKeys: ['query'] },
  web_search: { pose: 'browsing', label: 'Search the web', detailKeys: ['query'] },
  web_fetch: { pose: 'browsing', label: 'Fetch', detailKeys: ['url'] },
  lsp_inspect: { pose: 'reading', label: 'Inspect code', detailKeys: ['path'] },
  file_stat: { pose: 'reading', label: 'File info', detailKeys: ['path'] },
  delete: { pose: 'deleting', label: 'Delete', detailKeys: ['path'] },
  delete_file: { pose: 'deleting', label: 'Delete', detailKeys: ['path'] },
  mkdir: { pose: 'editing', label: 'New folder', detailKeys: ['path'] },
  skill: { pose: 'skill', label: 'Skill', detailKeys: ['name'] },
  skill_search: { pose: 'skill', label: 'Search skills', detailKeys: ['query'] },
  skill_read: { pose: 'skill', label: 'Skill file', detailKeys: ['path'] },
};

/** Agents prefix commands with `cd <workspace> &&`, which crowds out the command itself on a one-line row. */
function withoutCdPrefix(command: string): string {
  return command.replace(/^\s*cd\s+(?:'[^']*'|"[^"]*"|[^\s&|;]+)\s*&&\s*/, '') || command;
}

type ToolArgs = Record<string, unknown>;

function isArgsRecord(value: unknown): value is ToolArgs {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ClaudeCodeTool {
  /** The Mastra tool this one presents as: same icon, title, summary, diff and file refresh. */
  as: string;
  /** Rewrites Claude Code's argument shape into that tool's; omitted where the shapes already match. */
  args?: (args: ToolArgs) => ToolArgs;
}

/** MultiEdit's edits read as one replacement: every old side, then every new side. */
function joinedEdits(edits: unknown): ToolArgs {
  if (!Array.isArray(edits)) return {};
  const sides = edits.filter(isArgsRecord);
  const side = (key: string) => sides.map(edit => (typeof edit[key] === 'string' ? edit[key] : '')).join('\n');
  return { old_string: side('old_string'), new_string: side('new_string') };
}

/**
 * Claude Code's tools, by the name the CLI gives them, and the Mastra tool each presents as.
 * Projected Claude sessions keep the real names (approval grants depend on them), so only the
 * presentation reads them as their Mastra twin. Tools missing here keep the generic rendering.
 */
export const CLAUDE_CODE_TOOLS: Readonly<Record<string, ClaudeCodeTool>> = {
  Bash: { as: 'execute_command' },
  BashOutput: { as: 'get_process_output', args: ({ bash_id }) => ({ pid: bash_id }) },
  KillShell: { as: 'kill_process', args: ({ shell_id }) => ({ pid: shell_id }) },
  KillBash: { as: 'kill_process', args: ({ shell_id }) => ({ pid: shell_id }) },
  Read: { as: 'view', args: ({ file_path, ...rest }) => ({ ...rest, path: file_path }) },
  Edit: {
    as: 'string_replace_lsp',
    args: ({ file_path, old_string, new_string }) => ({ path: file_path, old_string, new_string }),
  },
  MultiEdit: { as: 'string_replace_lsp', args: ({ file_path, edits }) => ({ path: file_path, ...joinedEdits(edits) }) },
  NotebookEdit: { as: 'string_replace_lsp', args: ({ notebook_path }) => ({ path: notebook_path }) },
  Write: { as: 'write_file', args: ({ file_path, content }) => ({ path: file_path, content }) },
  Grep: { as: 'search_content' },
  Glob: { as: 'find_files' },
  LS: { as: 'list_files' },
  WebFetch: { as: 'web_fetch' },
  WebSearch: { as: 'web_search' },
  Skill: { as: 'skill', args: ({ skill, ...rest }) => ({ ...rest, name: skill }) },
};

/** The MCP server carrying the Factory's own tools, which Mastra runs call by their bare name. */
const FACTORY_MCP_SERVER = 'factory';

function mcpTool(toolName: string): { server: string; tool: string } | undefined {
  const [, server, tool] = /^mcp__(.+?)__(.+)$/.exec(toolName) ?? [];
  return server && tool ? { server, tool } : undefined;
}

export interface PresentedToolCall {
  /** The tool the call draws as: the Mastra twin of a Claude Code tool, the bare name of an MCP tool. */
  toolName: string;
  /** The arguments in that tool's shape. */
  args: unknown;
  /** The server of an MCP tool that is not the Factory's. */
  server?: string;
}

/** Reads a call the way the presentation draws it; the call itself keeps its real name for approvals. */
export function presentedToolCall(toolName: string, args?: unknown): PresentedToolCall {
  const mcp = mcpTool(toolName);
  if (mcp) {
    return mcp.server === FACTORY_MCP_SERVER
      ? { toolName: mcp.tool, args }
      : { toolName: mcp.tool, args, server: mcp.server };
  }
  const claude = Object.hasOwn(CLAUDE_CODE_TOOLS, toolName) ? CLAUDE_CODE_TOOLS[toolName] : undefined;
  if (!claude) return { toolName, args };
  return { toolName: claude.as, args: claude.args && isArgsRecord(args) ? claude.args(args) : args };
}

/** A tool's name for people: an MCP tool without its `mcp__<server>__` prefix, naming the server unless it is the Factory's. */
export function displayToolName(toolName: string): string {
  const mcp = mcpTool(toolName);
  if (!mcp) return toolName;
  return mcp.server === FACTORY_MCP_SERVER ? mcp.tool : `${mcp.server} · ${mcp.tool}`;
}

export function presentTool(toolName: string, rawArgs: unknown): ToolPresentation {
  const { toolName: name, args, server } = presentedToolCall(toolName, rawArgs);
  const style = server ? undefined : TOOL_STYLES[name.replace(/^mastra_workspace_/, '')];
  if (!style) {
    const label = server ? `${server} · ${humanize(name)}` : humanize(name);
    return { pose: 'tool', icon: agentGlyph('tool'), label };
  }

  const detail = style.detailKeys ? firstStringArg(args, style.detailKeys) : undefined;
  // The kind stays English for grouping and phrases; people read it through the host's translator.
  const dressed = { pose: style.pose, icon: agentGlyph(style.pose), label: libText(style.label), kind: style.label };
  if (!detail) return dressed;
  if (!style.isCommand) return { ...dressed, detail };
  // Workspaces with `requireDescription` have the agent say what a command does; that reads better
  // on a one-line row than "Run" and the command, which stays in the expanded body.
  const description = stringArg(args, 'description')?.replace(/\s+/g, ' ').trim() || undefined;
  return { ...dressed, detail: withoutCdPrefix(detail), description, command: detail };
}

export type ToolEdit = { path?: string } & ({ oldText: string; newText: string } | { content: string });

function stringField(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== 'object' || !hasProperty(args, key)) return undefined;
  return typeof args[key] === 'string' ? args[key] : undefined;
}

export function toolEdit(rawToolName: string, rawArgs: unknown): ToolEdit | undefined {
  const { toolName, args } = presentedToolCall(rawToolName, rawArgs);
  const path = stringField(args, 'path');
  const newText = stringField(args, 'new_string');
  if (/string_replace|str_replace|edit_file/i.test(toolName) && newText !== undefined) {
    return { path, oldText: stringField(args, 'old_string') ?? '', newText };
  }
  const content = stringField(args, 'content');
  if (/write_file|create_file/i.test(toolName) && content !== undefined) return { path, content };
  return undefined;
}

export interface ToolArgumentsInput {
  toolName: string;
  args?: unknown;
  argsText?: string;
  hideArguments?: boolean;
}

function isEmptyObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Object.keys(value).length === 0;
}

export function visibleToolArgumentsText({ args, argsText, hideArguments }: ToolArgumentsInput): string | undefined {
  if (hideArguments || isEmptyObject(args)) return undefined;
  return args === undefined ? argsText : stringifyToolValue(args);
}

export function hasToolArguments(input: ToolArgumentsInput): boolean {
  return Boolean(toolEdit(input.toolName, input.args) || visibleToolArgumentsText(input));
}

/** Task tools draw in the docked task list, never as a transcript row. */
const TASK_TOOLS = new Set(['task_write', 'task_update', 'task_complete', 'task_check']);

export function isTaskTool(toolName: string): boolean {
  return TASK_TOOLS.has(toolName);
}
