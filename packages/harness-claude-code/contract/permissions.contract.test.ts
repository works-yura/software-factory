import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { callToolThenReport } from './mock-anthropic.ts';
import { claudeVersion, contractSession, type ContractSession } from './setup.ts';

let open: ContractSession | undefined;
afterEach(async () => {
  await open?.dispose();
  open = undefined;
});

beforeAll(() => {
  console.info(`claude CLI under test: ${claudeVersion()}`);
});

describe('session grants against the real CLI', () => {
  it('runs a subagent once a person allowed Agent, without asking again', async () => {
    open = await contractSession({
      script: turn => {
        if (turn.has('CONTRACT-SUBAGENT')) return { text: 'SUBAGENT-DONE' };
        return callToolThenReport('Agent', {
          description: 'contract subagent',
          subagent_type: 'general-purpose',
          prompt: 'CONTRACT-SUBAGENT: reply with one word.',
        })(turn);
      },
      permissions: {},
    });
    expect(await open.say('Start a subagent.')).toBe('suspended');
    expect(open.session.pendingPermission?.toolName).toBe('Agent');

    const reason = await open.answer(true);
    expect(reason).toBe('complete');
    expect(open.session.pendingPermission).toBeUndefined();
    // The retry was not asked about again: the subagent ran, under the retried call.
    const calls = open.transcript.filter(entry => entry.kind === 'tool_call' && entry.toolName === 'Agent');
    expect(open.transcript.filter(entry => entry.kind === 'permission')).toHaveLength(1);
    expect(open.transcript).toContainEqual(
      expect.objectContaining({ kind: 'text', text: 'SUBAGENT-DONE', parentToolCallId: (calls.at(-1) as { toolCallId: string }).toolCallId }),
    );
  });
});
