import { MessageList } from '@mastra/core/agent/message-list';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import type { ProcessInputArgs } from '@mastra/core/processors';
import { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it } from 'vitest';

import { FactoryModelSwitchProcessor } from './model-switch-processor.ts';

let tick = Date.parse('2026-11-01T10:00:00Z');
function message(id: string, role: 'user' | 'assistant', metadata?: Record<string, unknown>): MastraDBMessage {
  return {
    id,
    role,
    createdAt: new Date((tick += 1000)),
    threadId: 'thread-1',
    resourceId: 'session-1',
    content: { format: 2, parts: [{ type: 'text', text: id }], ...(metadata ? { metadata } : {}) },
  };
}

async function run(
  session: { modelId: string; thinkingLevel?: string },
  history: MastraDBMessage[],
  options: ConstructorParameters<typeof FactoryModelSwitchProcessor>[0] = {},
) {
  const requestContext = new RequestContext();
  requestContext.set('controller', {
    session: { modelId: session.modelId },
    getState: () => (session.thinkingLevel ? { thinkingLevel: session.thinkingLevel } : {}),
  } as never);
  const messageList = new MessageList({ threadId: 'thread-1', resourceId: 'session-1' });
  for (const entry of history) messageList.add(entry, 'memory');
  messageList.add(message('next', 'user'), 'input');
  await new FactoryModelSwitchProcessor(options).processInput({ messageList, requestContext } as unknown as ProcessInputArgs);
  return messageList.get.input.db()[0]!.content.metadata;
}

const opusHigh = { instanceId: 'mastra', model: 'anthropic/claude-opus-4-6', options: [{ id: 'effort', value: 'high' }] };

describe('FactoryModelSwitchProcessor', () => {
  it('stamps the selection a turn runs on, and no switch on the first turn', async () => {
    expect(await run({ modelId: 'anthropic/claude-opus-4-6', thinkingLevel: 'high' }, [])).toEqual({ modelSelection: opusHigh });
  });

  it('marks a switch from the latest earlier input that ran another selection', async () => {
    const history = [
      message('a', 'user', { modelSelection: { instanceId: 'mastra', model: 'openai/gpt-5' } }),
      message('b', 'assistant', { modelId: 'openai/gpt-5' }),
      message('c', 'user', { modelSelection: opusHigh }),
      message('d', 'assistant'),
    ];
    const to = { instanceId: 'mastra', model: 'openai/gpt-5', options: [{ id: 'effort', value: 'medium' }] };
    expect(await run({ modelId: 'openai/gpt-5' }, history, { thinkingLevel: async () => 'medium' })).toEqual({
      modelSelection: to,
      modelSwitch: { from: opusHigh, to },
    });
    // The same selection again: no divider.
    expect(await run({ modelId: 'anthropic/claude-opus-4-6', thinkingLevel: 'high' }, history)).toEqual({ modelSelection: opusHigh });
  });

  it('leaves a run without a session model alone', async () => {
    expect(await run({ modelId: '' }, [])).toBeUndefined();
  });
});
