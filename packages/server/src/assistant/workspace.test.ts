/**
 * «Помічник»'s workspace on the server, for real: the local Factory sandbox's assistant folder,
 * the sessions' folder-workspace recipe and Mastra Code tools, the sessions' permission rules, the
 * core's gate and approved-call replay, and erase. The last suite runs a command as the agent user
 * through the launcher the server uses (sudo to the agent user, Seatbelt profile) and only where
 * the machine is set up for it: FACTORY_AGENT_USER_TEST=factory, as `@factory/agent-user`'s suites.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AssistantWorkspaces, workspaceGate } from '@factory/assistant-core';
import type { AssistantOwner, WorkspaceToolApproval } from '@factory/assistant-core';
import { agentUserFromEnv } from '@factory/agent-user';
import { assistantFolderKey, LocalFactorySandbox } from '@factory/sandbox';
import { createWorkspaceTools } from '@mastra/core/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { agentUserRuntimeFromEnv } from '../agent-user/agent-user-runtime.ts';
import { createAssistantWorkspaceHost } from './workspace.ts';

const ADA: AssistantOwner = { orgId: 'org-a', userId: 'ada' };
const BOB: AssistantOwner = { orgId: 'org-a', userId: 'bob' };

type Runnable = { execute: (input: unknown, context: unknown) => Promise<unknown> };

describe('the assistant workspace host on the local Factory sandbox', () => {
  let root: string;
  let sandbox: LocalFactorySandbox;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'assistant-host-'));
    sandbox = new LocalFactorySandbox({ root });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("gives the agent the sessions' tools in <sandboxes>/assistant/<org>/<user>/workspace", async () => {
    const host = createAssistantWorkspaceHost({ sandbox });
    const workspace = await host.open(ADA);
    const tools = await createWorkspaceTools(workspace);
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining(['view', 'find_files', 'search_content', 'write_file', 'string_replace_lsp', 'execute_command']),
    );
    await workspace.filesystem!.writeFile('requests/r1/a.txt', 'a', { recursive: true });
    expect(await readFile(join(root, 'assistant', 'org-a', 'ada', 'workspace', 'requests', 'r1', 'a.txt'), 'utf8')).toBe('a');
    await host.erase(ADA);
  });

  it("answers with the sessions' default rules", () => {
    const host = createAssistantWorkspaceHost({ sandbox });
    const rules: Record<string, WorkspaceToolApproval> = { view: 'allow', find_files: 'allow', write_file: 'ask', execute_command: 'ask' };
    for (const [tool, approval] of Object.entries(rules)) expect(host.approval(tool)).toBe(approval);
  });

  it('keeps owners apart and never follows a symlink out of the folder', async () => {
    const host = createAssistantWorkspaceHost({ sandbox });
    const ada = await host.open(ADA);
    const bob = await host.open(BOB);
    await ada.filesystem!.writeFile('secret.txt', 'ada', { recursive: true });
    await bob.filesystem!.writeFile('mine.txt', 'bob', { recursive: true });
    await expect(bob.filesystem!.readFile('../../ada/workspace/secret.txt')).rejects.toThrow();
    await writeFile(join(root, 'outside.txt'), 'server');
    await symlink(join(root, 'outside.txt'), join(root, 'assistant', 'org-a', 'bob', 'workspace', 'link.txt'));
    await expect(bob.filesystem!.readFile('link.txt')).rejects.toThrow();
    await host.erase(ADA);
    await host.erase(BOB);
  });

  it('gates a command, runs it in the sandbox once approved, and erases the folder', async () => {
    const host = createAssistantWorkspaceHost({ sandbox });
    const workspaces = new AssistantWorkspaces(host);
    const proposals: Array<{ toolName: string; args: Record<string, unknown> }> = [];
    const { workspace, folder } = await workspaces.forTurn(ADA, {
      requestId: 'r1',
      files: [{ name: 'note.txt', bytes: new TextEncoder().encode('from the person') }],
      hooks: workspaceGate({ approval: name => host.approval(name), propose: async call => void proposals.push(call) }),
    });
    expect(folder).toBe('requests/r1');
    const tools = (await createWorkspaceTools(workspace)) as unknown as Record<string, Runnable>;
    const viewed = await tools.view!.execute({ path: 'requests/r1/note.txt' }, {});
    expect(JSON.stringify(viewed)).toContain('from the person');
    expect(await tools.execute_command!.execute({ command: 'wc -c requests/r1/note.txt > requests/r1/count.txt', description: 'count' }, {})).toMatchObject({
      status: 'awaiting_approval',
    });
    expect(proposals).toHaveLength(1);
    const folderPath = join(root, 'assistant', 'org-a', 'ada', 'workspace', 'requests', 'r1');
    expect(existsSync(join(folderPath, 'count.txt'))).toBe(false);

    await workspaces.runApproved(ADA, 'r1', proposals[0]!);
    expect((await readFile(join(folderPath, 'count.txt'), 'utf8')).trim()).toMatch(/^15\b/);
    expect((await workspaces.list(ADA, 'r1')).map(entry => entry.path).sort()).toEqual(['count.txt', 'note.txt']);

    await workspaces.erase(ADA);
    await expect(stat(join(root, 'assistant', 'org-a', 'ada'))).rejects.toThrow();
  });
});

const agentUser = process.env.FACTORY_AGENT_USER_TEST?.trim();
const agentRoot = process.env.FACTORY_AGENT_USER_TEST_ROOT ?? '/Volumes/dot/Project/factory/sandboxes';
const agentConfig = agentUser ? agentUserFromEnv({ FACTORY_AGENT_USER: agentUser }, { serverUser: process.env.USER ?? '', sandboxRoot: agentRoot }) : undefined;

describe.runIf(Boolean(agentConfig && existsSync(agentConfig.profilePath)))('as the agent user, for real', () => {
  it('runs an approved command as the agent user under Seatbelt in the assistant folder', async () => {
    const runtime = agentUserRuntimeFromEnv({ env: { FACTORY_AGENT_USER: agentUser, FACTORY_AGENT_REAP: 'off' }, sandboxRoot: agentRoot })!;
    const sandbox = new LocalFactorySandbox({ root: agentRoot, agentProcesses: runtime.processes });
    const owner: AssistantOwner = { orgId: 'assistant-test', userId: `run-${process.pid}` };
    const host = createAssistantWorkspaceHost({ sandbox });
    const workspaces = new AssistantWorkspaces(host);
    try {
      await workspaces.forTurn(owner, { requestId: 'r1', files: [], hooks: {} });
      const output = await workspaces.runApproved(owner, 'r1', {
        toolName: 'execute_command',
        // The server user's home (not the agent's own: inside the run $USER is the agent) is closed to it.
        args: {
          command: `id -un > requests/r1/who.txt; ls ~/ >/dev/null 2>&1 && echo home; ls /Users/${process.env.USER} >/dev/null 2>&1 || echo closed`,
          description: 'who',
        },
      });
      expect(JSON.stringify(output)).toContain('closed');
      const who = await workspaces.read(owner, 'r1', 'who.txt');
      expect(new TextDecoder().decode(who.bytes).trim()).toBe(agentUser);
      expect(sandbox.folderKeyOf(join(agentRoot, assistantFolderKey(owner.orgId, owner.userId)))).toBe(assistantFolderKey(owner.orgId, owner.userId));
    } finally {
      await workspaces.erase(owner);
    }
  });
});
