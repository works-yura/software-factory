/**
 * The Workspace a Mastra agent works in, over one sandbox folder: files through the sandbox (so
 * they are read and written by whoever runs the sandbox's commands — the agent user, ADR-0041),
 * commands in the same sandbox, and Mastra Code's workspace tools (`view`, `find_files`,
 * `search_content`, `write_file`, `string_replace_lsp`, `execute_command`, …). Factory sessions
 * build theirs here, and so does «Помічник» (ADR-0051) for its owner's folder; one recipe, so the
 * assistant's tools are exactly the sessions' tools.
 */
import { SandboxFilesystem } from '@mastra/code-sdk/agents/sandbox-filesystem';
import { MASTRACODE_WORKSPACE_TOOLS } from '@mastra/code-sdk/agents/tool-availability';
import { createDefaultRules, resolveApproval, SessionGrants } from '@mastra/code-sdk/permissions';
import type { ApprovalDecision, PermissionRules } from '@mastra/code-sdk/permissions';
import { Workspace } from '@mastra/core/workspace';
import type {
  SkillSource,
  WorkspaceSandbox,
  WorkspaceToolBeforeHookResult,
  WorkspaceToolHookContext,
  WorkspaceToolHooks,
  WorkspaceToolsConfig,
} from '@mastra/core/workspace';
import { requireExec } from '@factory/sandbox';

export interface FolderFilesystemOptions {
  /** The Workspace id the filesystem belongs to. */
  id: string;
  /** The folder's sandbox; it must run commands (`executeCommand`). */
  sandbox: WorkspaceSandbox;
  /** Absolute path of the workspace root inside the sandbox, or how to find it once the sandbox runs. */
  workdir: string | (() => Promise<string> | string);
  /**
   * Check that a path never leads out of the workdir through a symlink. On when the files are also
   * shown to someone other than the agent (the person, in the app).
   */
  verifySymlinks?: boolean;
}

/** The folder's files, read and written through its sandbox; paths cannot leave the workdir. */
export function createFolderFilesystem(options: FolderFilesystemOptions): SandboxFilesystem {
  return new SandboxFilesystem({
    id: `sandbox-fs:${options.id}`,
    sandbox: requireExec(options.sandbox),
    workdir: options.workdir,
    ...(options.verifySymlinks ? { verifySymlinks: true } : {}),
  });
}

export interface FolderWorkspaceOptions {
  /** The Workspace id (Mastra registers and finds it by this). */
  id: string;
  name: string;
  /** The folder's sandbox: commands run here. */
  sandbox: WorkspaceSandbox;
  /** Its files (`createFolderFilesystem` over the same sandbox). */
  filesystem: SandboxFilesystem;
  /**
   * Hooks around every workspace tool call, run after Mastra Code's own (its plan-mode write guard):
   * a `beforeToolCall` that answers `{ proceed: false, output }` stops the call with that output.
   */
  hooks?: WorkspaceToolHooks;
  /** Skill roots relative to the filesystem, and where skills are read from. */
  skills?: string[];
  skillSource?: SkillSource;
}

/** Mastra Code's workspace tools with `hooks` run after its own. */
export function folderWorkspaceTools(hooks?: WorkspaceToolHooks): WorkspaceToolsConfig {
  if (!hooks) return MASTRACODE_WORKSPACE_TOOLS;
  const base = MASTRACODE_WORKSPACE_TOOLS.hooks;
  return {
    ...MASTRACODE_WORKSPACE_TOOLS,
    hooks: {
      beforeToolCall: async (context: WorkspaceToolHookContext): Promise<void | WorkspaceToolBeforeHookResult> => {
        const first = await base?.beforeToolCall?.(context);
        if (first) return first;
        return hooks.beforeToolCall?.(context);
      },
      afterToolCall: async context => {
        await base?.afterToolCall?.(context);
        await hooks.afterToolCall?.(context);
      },
    },
  };
}

/** A Workspace over one sandbox folder with Mastra Code's workspace tools. */
export function createFolderWorkspace(options: FolderWorkspaceOptions): Workspace {
  return new Workspace({
    id: options.id,
    name: options.name,
    filesystem: options.filesystem,
    sandbox: options.sandbox,
    tools: folderWorkspaceTools(options.hooks),
    ...(options.skills ? { skills: options.skills } : {}),
    ...(options.skillSource ? { skillSource: options.skillSource } : {}),
  });
}

/** What a tool call needs under a session's rules: run, ask the person first, or refuse. */
export type ToolApproval = ApprovalDecision;

/**
 * The approval a workspace tool call gets under Mastra Code's permission rules — the rules a Factory
 * session runs with when nothing narrower is set (Settings › Behavior): reads run, edits and commands
 * ask, anything unknown asks. `rules` overrides them (categories and per-tool policies).
 */
export function workspaceToolApproval(toolName: string, rules: PermissionRules = createDefaultRules()): ToolApproval {
  return resolveApproval(toolName, rules, new SessionGrants());
}
