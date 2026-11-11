import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemoryStore } from '@mastra/core/storage';
import { describe, expect, it, vi } from 'vitest';

import { createInMemorySessionStore } from '@factory/harness-claude-code';
import { fakeClaude } from '@factory/harness-claude-code/__fixtures__/fake-claude';
import { attachClaudeSessionToUi } from '@factory/harness-claude-code-ui';
import { FactoryPhaseStateProcessor } from '@factory/harness-mastra';
import { createToolRuleTestRegistry } from '@factory/pipelines/testing';
import { createFactoryStorageForTests } from '@factory/testing';

import { createClaudeFactoryHarness } from './harness.ts';
import { claudeFactoryToolName, observeClaudeToolResults } from './tool-results.ts';

const CLI_SESSION = 'cli-session-1';
const line = (value: unknown) => JSON.stringify(value);

/** A turn in which Claude records the self-review verdict through the Factory MCP server. */
function verdictTurn({ isError = false }: { isError?: boolean } = {}): string[] {
  return [
    line({ type: 'system', subtype: 'init', cwd: '/work', session_id: CLI_SESSION, tools: [], mcp_servers: [] }),
    line({
      type: 'assistant',
      session_id: CLI_SESSION,
      message: {
        id: 'msg-verdict',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu-verdict',
            name: 'mcp__factory__factory_record_review_verdict',
            input: { verdict: 'approve', findings: 'Looks right.' },
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }),
    line({
      type: 'user',
      session_id: CLI_SESSION,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu-verdict', content: '{"recorded":true}', is_error: isError }],
      },
    }),
    line({ type: 'result', subtype: 'success', is_error: false, session_id: CLI_SESSION, result: 'Approved.', usage: {} }),
  ];
}

async function setup(turn: string[]) {
  const seeded = await createFactoryStorageForTests();
  const workItems = seeded.workItems;
  const project = await seeded.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Claude', harness: 'claude-code' } });
  // A Work card in Review whose self-review just approved, bound to the reviewer's Claude session.
  const prepared = await workItems.prepareRunStart({
    orgId: 'org-1',
    userId: 'user-1',
    factoryProjectId: project.id,
    workItem: {
      input: {
        board: 'work',
        title: 'Saving a profile drops the phone number',
        stages: ['review'],
        externalSource: { integrationId: 'github', type: 'issue', externalId: 'github:10:issue:42' },
        metadata: { authorTrusted: true, selfReviewVerdict: 'approve', selfReviewedHeadSha: 'abc123' },
      },
    },
    role: 'review',
    session: { sessionId: 'review-session', branch: 'factory/issue-42', threadId: 'review-session' },
    resourceId: project.id,
    kickoffKey: 'kickoff-1',
    kickoffMessage: null,
  });
  const chatStore = new InMemoryStore();
  const processor = new FactoryPhaseStateProcessor({
    configVersion: 'claude-tool-results-v1',
    storage: workItems,
    // Work declares no tool rules; a board's own rule for the verdict tool stands in for one.
    boards: createToolRuleTestRegistry({
      factory_record_review_verdict: {
        onResult: context =>
          context.result.status === 'success'
            ? { type: 'invokeSkill', idempotencyKey: `${context.ingress.id}:wake`, role: 'work', prompt: 'Open it.' }
            : undefined,
      },
    }),
    bareToolName: claudeFactoryToolName,
    messageReader: {
      listMessages: async input => (await chatStore.getStore('memory'))!.listMessages(input as never) as never,
    },
  });
  const binding = (await workItems.findActiveRunBindingForSession({
    orgId: 'org-1',
    factoryProjectId: project.id,
    sessionId: 'review-session',
  }))!;
  const reconcile = vi.fn(() => processor.reconcileBinding(binding));
  const fake = fakeClaude([{ lines: turn }]);
  const cwd = await mkdtemp(join(tmpdir(), 'claude-tool-results-'));
  const claude = createClaudeFactoryHarness({
    store: createInMemorySessionStore(),
    sessionConfigRoot: join(cwd, '.claude-config'),
    sessions: { getBySessionId: async () => ({ orgId: 'org-1', factoryProjectId: project.id, userId: 'user-1' }) as never },
    credentials: async () => ({}),
    cwdFor: () => cwd,
    spawn: fake.spawn,
    env: { PATH: '/usr/bin' },
    onSession: session => {
      const channel = attachClaudeSessionToUi(session, { storage: chatStore });
      observeClaudeToolResults(channel, reconcile);
    },
  });
  const session = await claude.harness.createSession({
    sessionId: 'review-session',
    threadId: 'review-session',
    resourceId: project.id,
  });
  const decisions = () => workItems.listDeferredDecisions('org-1', project.id, { workItemId: prepared.item.id });
  return { session, reconcile, decisions };
}

describe('Board tool-result rules on a Claude Code session', () => {
  it("runs the board's rule for a tool the Claude session called, as on a Mastra run", async () => {
    const { session, reconcile, decisions } = await setup(verdictTurn());
    await session.sendMessage({ content: 'Review it.' });
    await vi.waitFor(async () => {
      expect((await decisions()).map(record => record.decision)).toEqual([
        expect.objectContaining({ type: 'invokeSkill', role: 'work' }),
      ]);
    });
    // Ingesting the same thread again changes nothing: the rule ran once for the call.
    await reconcile();
    expect(await decisions()).toHaveLength(1);
  }, 30_000);

  it('runs no rule on a call that failed', async () => {
    const { session, reconcile, decisions } = await setup(verdictTurn({ isError: true }));
    await session.sendMessage({ content: 'Review it.' });
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalled());
    await reconcile.mock.results[0]!.value;
    expect(await decisions()).toEqual([]);
  }, 30_000);

  it('names the Factory tools as a Mastra run does', () => {
    expect(claudeFactoryToolName('mcp__factory__factory_record_review_verdict')).toBe('factory_record_review_verdict');
    expect(claudeFactoryToolName('mcp__factory_gate__submit_plan')).toBe('mcp__factory_gate__submit_plan');
    expect(claudeFactoryToolName('Bash')).toBe('Bash');
  });
});
