import type { RequestContext } from '@mastra/core/request-context';
import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import { withAccess } from '@factory/http';
import { createTool } from '@mastra/core/tools';
import type { Context } from 'hono';
import { z } from 'zod';

import { getFactoryAuthOrgId, getFactoryAuthUserFromContext } from '@factory/auth';
import type { RouteAuth } from '@factory/http';

import type { ConnectCodes } from './connect-codes.ts';
import type { ConversationChannel } from './types.ts';

export const CONVERSATION_REPLY_TOOL = 'factory_conversation_reply';

/**
 * The agent's way back into a conversation: one tool for every platform, keyed by the thread
 * reference the inbound message carried. The reply goes out as the session's organization
 * (`requestContext`): the adapter answers with that organization's provider account only.
 */
export function createConversationReplyTool(channels: readonly ConversationChannel[], requestContext?: RequestContext) {
  const byPlatform = new Map(channels.map(channel => [channel.platform, channel]));
  const orgId = requestContext ? getFactoryAuthOrgId(getFactoryAuthUserFromContext(requestContext)) : undefined;
  return {
    [CONVERSATION_REPLY_TOOL]: createTool({
      id: CONVERSATION_REPLY_TOOL,
      description:
        'Reply in the conversation thread a person wrote to you from (a ClickUp comment, …). Use the platform and thread exactly as the message that reached you names them. Write the answer itself; it is posted publicly in that thread.',
      inputSchema: z.object({
        platform: z.string().min(1),
        thread: z.string().min(1),
        text: z.string().min(1).max(20_000),
      }),
      execute: async ({ platform, thread, text }) => {
        const channel = byPlatform.get(platform);
        if (!channel) throw new Error(`No conversation channel for platform "${platform}" is connected.`);
        await channel.reply({ platform, id: thread }, text, orgId ? { orgId } : undefined);
        return { posted: true };
      },
    }),
  };
}

/**
 * `POST /web/channels/:platform/connect-code` — a one-time code the signed-in member posts from
 * their provider account to link it.
 */
export function buildConnectCodeRoute(options: { platform: string; auth: RouteAuth; codes: ConnectCodes }): ApiRoute {
  // Linking a chat account lets that person talk to agents from the channel.
  return withAccess('run.start', registerApiRoute(`/web/channels/${options.platform}/connect-code`, {
    method: 'POST',
    requiresAuth: false,
    handler: async c => {
      const context = c as unknown as Context;
      await options.auth.ensureUser(context);
      const tenant = options.auth.tenant(context);
      if (!tenant) return c.json({ error: 'unauthorized' }, 401);
      if (!tenant.orgId) {
        return c.json({ error: 'organization_required', message: 'Connecting an account requires an organization.' }, 403);
      }
      return c.json(options.codes.issue(options.platform, { userId: tenant.userId, orgId: tenant.orgId }));
    },
  }));
}
