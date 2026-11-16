/**
 * «Помічник»'s workspace on this server (ADR-0051, «Де живе помічник»): the assistant's port
 * (`AssistantWorkspaceHost`) filled from what Factory sessions run on — the local Factory sandbox's
 * folder for the owner (`<sandboxes>/assistant/<org>/<user>/workspace`, ADR-0039's root), commands
 * as the agent user (ADR-0041) under Seatbelt (ADR-0050) when the server runs agents so, the same
 * folder-workspace recipe and Mastra Code tools sessions get (`createFolderWorkspace`), and the same
 * permission rules (`workspaceToolApproval`).
 *
 * Only the local sandbox keeps a folder per person between turns; a server whose sessions run in
 * remote sandboxes gives the assistant no workspace, and the assistant says so.
 */
import type { AssistantOwner, AssistantWorkspaceHost } from '@factory/assistant-core';
import { createFolderFilesystem, createFolderWorkspace, workspaceToolApproval } from '@factory/harness-mastra';
import { assistantFolderKey } from '@factory/sandbox';
import type { LocalFactorySandbox } from '@factory/sandbox';
import type { PermissionRules } from '@mastra/code-sdk/permissions';
import type { LocalSandbox } from '@mastra/core/workspace';

export interface AssistantWorkspaceHostOptions {
  /** The server's local Factory sandbox (the one its sessions run in). */
  sandbox: Pick<LocalFactorySandbox, 'createAssistantSandbox' | 'removeAssistantFolder'>;
  /** The permission rules; the sessions' defaults (reads run, edits and commands ask) when unset. */
  rules?: PermissionRules;
}

export function createAssistantWorkspaceHost(options: AssistantWorkspaceHostOptions): AssistantWorkspaceHost {
  // One sandbox per owner, kept while the server runs: its processes (a background command) outlive a turn.
  const sandboxes = new Map<string, LocalSandbox>();
  const sandboxOf = (owner: AssistantOwner) => {
    const key = assistantFolderKey(owner.orgId, owner.userId);
    let sandbox = sandboxes.get(key);
    if (!sandbox) {
      sandbox = options.sandbox.createAssistantSandbox(key);
      sandboxes.set(key, sandbox);
    }
    return { key, sandbox };
  };
  return {
    async open(owner, open = {}) {
      const { key, sandbox } = sandboxOf(owner);
      const id = `assistant:${key}`;
      // The person sees these files too: a symlink may never lead them out of the folder.
      const filesystem = createFolderFilesystem({ id, sandbox, workdir: sandbox.workingDirectory, verifySymlinks: true });
      return createFolderWorkspace({
        id,
        name: 'Помічник workspace',
        sandbox,
        filesystem,
        ...(open.hooks ? { hooks: open.hooks } : {}),
      });
    },
    approval(toolName) {
      return workspaceToolApproval(toolName, options.rules);
    },
    async erase(owner) {
      const key = assistantFolderKey(owner.orgId, owner.userId);
      const sandbox = sandboxes.get(key);
      sandboxes.delete(key);
      await sandbox?.destroy();
      await options.sandbox.removeAssistantFolder(key);
    },
  };
}
