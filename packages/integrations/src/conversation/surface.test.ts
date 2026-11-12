import { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it, vi } from 'vitest';

import { CONVERSATION_REPLY_TOOL, createConversationReplyTool } from './surface.ts';
import type { ConversationChannel } from './types.ts';

type Runnable = { execute: (input: unknown, context: unknown) => Promise<unknown> };

function channel() {
  const reply = vi.fn<ConversationChannel['reply']>(async () => {});
  return { reply, channel: { platform: 'clickup', reply, download: async () => new Uint8Array() } satisfies ConversationChannel };
}

describe('factory_conversation_reply', () => {
  it("replies as the session's organization, so the adapter answers with that organization's account", async () => {
    const { reply, channel: clickup } = channel();
    const context = new RequestContext();
    context.set('user', { id: 'user-1', organizationId: 'org-1' });
    const tool = createConversationReplyTool([clickup], context)[CONVERSATION_REPLY_TOOL] as unknown as Runnable;
    expect(await tool.execute({ platform: 'clickup', thread: 'task-1:c-1:org-1', text: 'on it' }, {})).toEqual({ posted: true });
    expect(reply).toHaveBeenCalledWith({ platform: 'clickup', id: 'task-1:c-1:org-1' }, 'on it', { orgId: 'org-1' });
  });

  it('passes no organization when the session has none, and refuses a platform that is not connected', async () => {
    const { reply, channel: clickup } = channel();
    const tool = createConversationReplyTool([clickup])[CONVERSATION_REPLY_TOOL] as unknown as Runnable;
    await tool.execute({ platform: 'clickup', thread: 't:c', text: 'x' }, {});
    expect(reply).toHaveBeenCalledWith({ platform: 'clickup', id: 't:c' }, 'x', undefined);
    await expect(tool.execute({ platform: 'slack', thread: 't', text: 'x' }, {})).rejects.toThrow('No conversation channel');
  });
});
