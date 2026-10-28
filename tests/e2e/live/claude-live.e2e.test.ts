import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
import { ensureUiBuilt, startStack, type Stack } from '../src/stack.ts';

/**
 * The server scenario (server/claude-chat.e2e.test.ts) with the REAL `claude`
 * on `--model haiku`: FACTORY_CLAUDE_CODE_COMMAND is left unset, so the server
 * runs `claude` from PATH with the person's own login. Spends their Claude
 * subscription. Run it through scripts/live-claude-check.sh only.
 */
const live = process.env.FACTORY_E2E_LIVE === '1';

function findFile(dir: string, name: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  for (const entry of readdirSync(dir)) {
    if (entry === '.git' || entry === 'node_modules') continue;
    const path = join(dir, entry);
    if (entry === name) return path;
    if (statSync(path).isDirectory()) {
      const found = findFile(path, name);
      if (found) return found;
    }
  }
  return undefined;
}

describe.skipIf(!live)('Claude Code chat with the real claude CLI (live, spends subscription)', () => {
  let stack: Stack;
  let factory: ClaudeFactory;

  beforeAll(async () => {
    ensureUiBuilt();
    stack = await startStack({ label: 'live', claude: 'real', linkClaudeLogin: true });
    factory = await createClaudeFactory(stack.baseUrl, { name: 'Live Claude Factory', projectId: stack.gitlab.project.id, claudeCodeModel: 'haiku' });
  });

  afterAll(async () => {
    if (stack) console.log(`--- server log (tail) ---\n${stack.tailServerLog(80)}`);
    await stack?.stop();
  });

  it('calls a Factory tool, parks a Write on permission, and finishes it when allowed', async () => {
    const chat = await createChat(stack.baseUrl, factory.projectRepositoryId, 'Live check');
    expect(chat.harness).toBe('claude-code');
    await sendMessage(
      stack.baseUrl,
      chat.sessionId,
      'This is an automated integration check; follow these steps exactly and do nothing else. ' +
        '1) Call the mcp__factory__factory_list_work_items tool once with no arguments. ' +
        '2) Use the Write tool to create the file e2e-proof.txt in the current directory with the content "ok". ' +
        '3) Reply with one short sentence.',
    );

    const parked = await waitFor(
      'the Write to wait for permission',
      async () => {
        const state = await displayState(stack.baseUrl, chat.sessionId);
        const approvals = Object.values(state.pendingApprovals ?? {});
        return !state.isRunning && approvals.length > 0 ? approvals : undefined;
      },
      4 * 60_000,
      2_000,
    );
    expect(parked[0]!.toolName).toBe('Write');

    // The Factory tool ran over MCP with the session token (a 401 would leave the server failed and the tool missing).
    const calls = toolInvocations(await threadMessages(stack.baseUrl, chat.sessionId));
    const list = calls.find(call => call.toolName === 'mcp__factory__factory_list_work_items');
    expect(list, `tool calls: ${JSON.stringify(calls)}`).toBeDefined();
    expect(list!.state).toBe('result');
    expect(String(list!.result)).toContain('counts');

    expect(await answerToolApproval(stack.baseUrl, chat.sessionId, parked[0]!.toolCallId, true)).toEqual({ ok: true });
    await waitFor(
      'the resumed run to finish',
      async () => {
        const state = await displayState(stack.baseUrl, chat.sessionId);
        return !state.isRunning && Object.keys(state.pendingApprovals ?? {}).length === 0 ? true : undefined;
      },
      4 * 60_000,
      2_000,
    );
    const proof = findFile(stack.sandboxRoot, 'e2e-proof.txt');
    expect(proof, 'e2e-proof.txt was not written in the session checkout').toBeDefined();
    expect(readFileSync(proof!, 'utf8').trim()).toBe('ok');
  });
});
