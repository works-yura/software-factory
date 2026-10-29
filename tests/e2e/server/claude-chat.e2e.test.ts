import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  answerToolApproval,
  createChat,
  createClaudeFactory,
  displayState,
  sendMessage,
  threadMessages,
  toolInvocations,
  waitFor,
  type ClaudeFactory,
} from '../src/factory-api.ts';
import { ensureUiBuilt, startStack, type FakeClaudeInvocation, type Stack } from '../src/stack.ts';

/**
 * A personal chat of a Claude Code Factory, end to end: the dev server as
 * `dev:local` bundles and runs it, a per-turn session token for the Factory MCP
 * endpoint, the gate MCP server written by the bundled harness, and a `claude`
 * (the fake CLI) that really connects to both MCP servers and asks the gate for
 * permission. Only the model is fake.
 */
describe('Claude Code chat through the dev server', () => {
  let stack: Stack;
  let factory: ClaudeFactory;

  beforeAll(async () => {
    ensureUiBuilt();
    stack = await startStack({ label: 'server', claude: 'fake' });
    factory = await createClaudeFactory(stack.baseUrl, { name: 'E2E Claude Factory', projectId: stack.gitlab.project.id });
  });

  afterAll(async () => {
    if (stack && process.env.FACTORY_E2E_DEBUG) console.log(stack.tailServerLog(120));
    await stack?.stop();
  });

  it('connects MCP, accepts the session token, parks a Write on permission, and resumes when allowed', async () => {
    const chat = await createChat(stack.baseUrl, factory.projectRepositoryId, 'List the work items and write the proof file');
    expect(chat.harness).toBe('claude-code');

    await sendMessage(stack.baseUrl, chat.sessionId, 'List the work items, then write e2e-proof.txt.');

    // The turn stops at the Write, waiting for a person.
    const parked = await waitFor(
      'the Write to wait for permission',
      async () => {
        const state = await displayState(stack.baseUrl, chat.sessionId);
        // Settled once the CLI ran and the run stopped: parked, or (the bug) finished without asking anyone.
        return !state.isRunning && stack.readClaudeLog().length > 0 ? Object.values(state.pendingApprovals ?? {}) : undefined;
      },
      120_000,
    ).catch(error => {
      throw new Error(`${error.message}\n--- fake claude log ---\n${JSON.stringify(stack.readClaudeLog(), null, 2)}\n--- server log ---\n${stack.tailServerLog(80)}`);
    });
    expect(parked, `no permission is pending; fake claude log: ${JSON.stringify(stack.readClaudeLog(), null, 2)}`).toHaveLength(1);
    expect(parked[0]!.toolName).toBe('Write');

    const [first] = stack.readClaudeLog();
    expect(first, 'the server never ran the CLI').toBeDefined();
    const turn1 = first as FakeClaudeInvocation;

    // Bug class 1: the gate server the bundled harness writes must start; bug class 2: the token must be accepted.
    expect(turn1.mcp.map(({ name, status, error }) => ({ name, status, error }))).toEqual(
      expect.arrayContaining([
        { name: 'factory', status: 'connected', error: undefined },
        { name: 'factory_gate', status: 'connected', error: undefined },
      ]),
    );
    expect(turn1.mcp.find(server => server.name === 'factory')!.tools).toContain('factory_list_work_items');
    expect(turn1.mcp.find(server => server.name === 'factory_gate')!.tools).toEqual(
      expect.arrayContaining(['submit_plan', 'permission_prompt']),
    );
    expect(turn1.argv).toEqual(expect.arrayContaining(['--permission-prompt-tool', 'mcp__factory_gate__permission_prompt']));
    expect(turn1.argv).not.toContain('--resume');

    const list = turn1.toolCalls.find(call => call.tool === 'mcp__factory__factory_list_work_items');
    expect(list, 'the Factory tool was never called').toBeDefined();
    expect(list!.outcome, `factory_list_work_items: ${list!.result}`).toBe('ok');

    // Bug class 3: "ask" in -p mode must reach the gate, not be silently denied.
    const write = turn1.toolCalls.find(call => call.tool === 'Write');
    expect(write?.outcome).toBe('denied');
    expect(write?.message).toContain('[factory:permission-pending]');
    expect(turn1.permissionPrompts.map(prompt => prompt.tool)).toEqual(['Write']);

    // The checkout is the linked repository on the session branch.
    const checkout = turn1.cwd;
    expect(existsSync(join(checkout, 'README.md'))).toBe(true);
    expect(execFileSync('git', ['-C', checkout, 'branch', '--show-current'], { encoding: 'utf8' }).trim()).not.toBe('main');
    expect(existsSync(join(checkout, 'e2e-proof.txt'))).toBe(false);

    // Allow: the run resumes, retries the Write with it allowed, and completes.
    const answer = await answerToolApproval(stack.baseUrl, chat.sessionId, parked[0]!.toolCallId, true);
    expect(answer).toEqual({ ok: true });

    await waitFor('the resumed run to finish', async () => {
      const state = await displayState(stack.baseUrl, chat.sessionId);
      const done = stack.readClaudeLog().length >= 2 && !state.isRunning && Object.keys(state.pendingApprovals ?? {}).length === 0;
      return done ? true : undefined;
    });

    const turn2 = stack.readClaudeLog()[1]!;
    expect(turn2.argv).toEqual(expect.arrayContaining(['--resume', first!.sessionId!]));
    expect(turn2.prompt).toMatch(/allowed `?Write`?/);
    expect(turn2.mcp.every(server => server.status === 'connected')).toBe(true);
    expect(turn2.toolCalls.map(call => [call.tool, call.outcome])).toEqual([['Write', 'ok']]);
    expect(turn2.result).toBe('success');
    expect(readFileSync(join(checkout, 'e2e-proof.txt'), 'utf8')).toContain(first!.sessionId!);

    // What the chat stores: the Factory tool's result and the run's last word.
    const messages = await threadMessages(stack.baseUrl, chat.sessionId);
    const listed = toolInvocations(messages).find(call => call.toolName === 'mcp__factory__factory_list_work_items');
    expect(listed?.state).toBe('result');
    expect(String(listed?.result)).toContain('"counts"');
    expect(JSON.stringify(messages)).toContain('Wrote e2e-proof.txt after the person allowed it.');
  });

  it('stops at the plan gate when Claude calls submit_plan', async () => {
    const before = stack.readClaudeLog().length;
    const chat = await createChat(stack.baseUrl, factory.projectRepositoryId, 'Plan it');
    await sendMessage(stack.baseUrl, chat.sessionId, '[fake:plan] Make a plan for the proof file.');

    const suspension = await waitFor('the plan to wait for approval', async () => {
      const state = await displayState(stack.baseUrl, chat.sessionId);
      const pending = Object.values(state.pendingSuspensions ?? {});
      return !state.isRunning && pending.length > 0 ? pending : undefined;
    });
    expect(suspension).toHaveLength(1);
    const turn = stack.readClaudeLog()[before]!;
    expect(turn.scenario).toBe('plan');
    expect(turn.toolCalls.map(call => call.tool)).toEqual(['mcp__factory_gate__submit_plan']);
  });

  it('pushes the session branch and opens the merge request through the Factory, with no credentials of its own', async () => {
    const before = stack.readClaudeLog().length;
    const chat = await createChat(stack.baseUrl, factory.projectRepositoryId, 'Deliver it');
    await sendMessage(stack.baseUrl, chat.sessionId, '[fake:deliver] Commit, push and open the merge request.');

    const turn = await waitFor('the delivery run to finish', async () => {
      const state = await displayState(stack.baseUrl, chat.sessionId);
      const log = stack.readClaudeLog();
      return log.length > before && !state.isRunning ? log[before] : undefined;
    }).catch(error => {
      throw new Error(`${error.message}\n--- server log ---\n${stack.tailServerLog(80)}`);
    });
    const calls = turn!.toolCalls.map(call => [call.tool, call.outcome, call.result?.slice(0, 300)]);
    expect(turn!.mcp.find(server => server.name === 'factory')!.tools).toEqual(
      // What a Mastra session has in-process: the brokered source-control tools and the integrations' own.
      expect.arrayContaining(['source_control_push_branch', 'source_control_create_change_request', 'gitlab_get_issue']),
    );
    expect(calls.map(([tool, outcome]) => [tool, outcome]), JSON.stringify(calls)).toEqual([
      ['mcp__factory__source_control_push_branch', 'ok'],
      ['mcp__factory__source_control_create_change_request', 'ok'],
    ]);

    // The branch reached the host with the agent's commit, and the merge request is open from it.
    const branch = execFileSync('git', ['-C', turn!.cwd, 'branch', '--show-current'], { encoding: 'utf8' }).trim();
    const head = execFileSync('git', ['-C', turn!.cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(stack.gitlab.branches()[branch]).toBe(head);
    expect(stack.gitlab.mergeRequests).toEqual([
      expect.objectContaining({ title: 'E2E delivery', source_branch: branch, target_branch: 'main' }),
    ]);
    // The checkout never held the token: the remote is the plain URL.
    const remote = execFileSync('git', ['-C', turn!.cwd, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    expect(remote).not.toContain(stack.gitlab.token);
  });

  it('works in the environment a Mastra session gets: every linked repository, set up, and told where', async () => {
    const companion = stack.gitlab.projects[1]!;
    const environment = await createClaudeFactory(stack.baseUrl, {
      name: 'E2E Claude Environment',
      projectId: stack.gitlab.project.id,
      setupCommand: 'echo ready > .factory-setup-ran',
      otherProjectIds: [companion.id],
    });
    const before = stack.readClaudeLog().length;
    const chat = await createChat(stack.baseUrl, environment.projectRepositoryId, 'Deliver from the environment');
    await sendMessage(stack.baseUrl, chat.sessionId, '[fake:deliver] Commit, push and open the merge request.');

    const turn = await waitFor('the environment run to finish', async () => {
      const state = await displayState(stack.baseUrl, chat.sessionId);
      const log = stack.readClaudeLog();
      return log.length > before && !state.isRunning ? log[before] : undefined;
    }).catch(error => {
      throw new Error(`${error.message}\n--- server log ---\n${stack.tailServerLog(80)}`);
    });

    // The turn is told what the workspace holds, the session's own repository first.
    const listed = [...turn!.prompt.matchAll(/^(\d)\. (\S+) at (\S+) on (\S+) \(default main, setup (\w+)\)/gm)].map(match => ({
      slug: match[2],
      dir: match[3]!,
      setup: match[5],
    }));
    expect(turn!.prompt).toContain('<factory-environment>');
    expect(listed.map(({ slug, setup }) => [slug, setup])).toEqual([
      [stack.gitlab.project.path, 'ok'],
      [companion.path, 'skipped'],
    ]);
    // The CLI runs in the workspace root, with each repository checked out beneath it.
    for (const repo of listed) {
      // The CLI reports its cwd resolved (/private/var on macOS); the environment names it as configured.
      expect(realpathSync(repo.dir).startsWith(`${realpathSync(turn!.cwd)}/`), `${repo.dir} under ${turn!.cwd}`).toBe(true);
      expect(existsSync(join(repo.dir, '.git'))).toBe(true);
    }
    // The repository's setup command ran in its checkout before the turn.
    expect(readFileSync(join(listed[0]!.dir, '.factory-setup-ran'), 'utf8').trim()).toBe('ready');

    const calls = turn!.toolCalls.map(call => [call.tool, call.outcome, call.result?.slice(0, 300)]);
    expect(calls.map(([tool, outcome]) => [tool, outcome]), JSON.stringify(calls)).toEqual([
      ['mcp__factory__source_control_push_branch', 'ok'],
      ['mcp__factory__source_control_create_change_request', 'ok'],
    ]);
    const branch = execFileSync('git', ['-C', listed[0]!.dir, 'branch', '--show-current'], { encoding: 'utf8' }).trim();
    expect(stack.gitlab.branches()[branch]).toBe(
      execFileSync('git', ['-C', listed[0]!.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    );
  });
});
