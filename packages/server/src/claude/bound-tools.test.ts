import { describe, expect, it, vi } from 'vitest';

import { boundRunRequestContext, createClaudeSessionTools } from './bound-tools.ts';

const scope = {
  orgId: 'org-1',
  factoryProjectId: '11111111-2222-4333-8444-555555555555',
  userId: 'user-1',
  sessionId: 'resource-1',
  resourceId: 'resource-1',
  threadId: 'thread-1',
  kind: 'worker' as const,
  interactive: false,
};

describe('Claude Code session tools', () => {
  it("runs each tool with the session's own context and checkout sandbox, per call", async () => {
    const sandbox = { executeCommand: vi.fn() };
    const seen: unknown[] = [];
    const sourceControlTools = vi.fn(async (requestContext: { get(key: string): unknown }) => ({
      source_control_push_branch: {
        id: 'source_control_push_branch',
        description: 'Push.',
        execute: async (input: unknown, context: { requestContext: typeof requestContext; workspace?: unknown; agent?: { toolCallId: string } }) => {
          seen.push({
            input,
            sessionId: (context.requestContext.get('controller') as { sessionId: string }).sessionId,
            user: context.requestContext.get('user'),
            workspace: context.workspace,
            toolCallId: context.agent?.toolCallId,
          });
          return { pushed: true };
        },
      },
    }));
    const sandboxFor = vi.fn(async (sessionId: string) => (sessionId === scope.sessionId ? sandbox : undefined));
    const tools = await createClaudeSessionTools(scope as never, { sessionTools: sourceControlTools as never, sandboxFor });

    expect(Object.keys(tools)).toEqual(['source_control_push_branch']);
    expect(sourceControlTools).toHaveBeenCalledTimes(1);
    // Nothing is resolved until a call needs it.
    expect(sandboxFor).not.toHaveBeenCalled();
    await expect(tools.source_control_push_branch!.execute!({ repository: 'a/b' } as never, {} as never)).resolves.toEqual({ pushed: true });
    await tools.source_control_push_branch!.execute!({} as never, {} as never);
    expect(sandboxFor).toHaveBeenCalledTimes(2);
    expect(seen[0]).toEqual({
      input: { repository: 'a/b' },
      sessionId: scope.sessionId,
      user: { id: scope.userId, organizationId: scope.orgId },
      workspace: { sandbox },
      toolCallId: expect.any(String),
    });
    // A fresh call id each time: the inner tools key idempotency on it.
    expect((seen[1] as { toolCallId: string }).toolCallId).not.toBe((seen[0] as { toolCallId: string }).toolCallId);
  });

  it('names the session in the controller entry, as the subscription tools read it from a Mastra run', () => {
    const controller = boundRunRequestContext(scope as never).get('controller') as {
      session?: { id: string; ownerId: string };
    };
    expect(controller.session).toEqual({ id: scope.sessionId, ownerId: scope.userId });
  });

  it("runs the post-tool observers after each call, as a Mastra session's controller does", async () => {
    const observed: Array<Record<string, unknown>> = [];
    const tools = await createClaudeSessionTools(scope as never, {
      sessionTools: async () => ({
        source_control_create_change_request: {
          id: 'source_control_create_change_request',
          description: 'Open a PR.',
          execute: async (input: { fail?: boolean }) => {
            if (input.fail) throw new Error('refused');
            return { url: 'https://github.com/acme/repo/pull/7' };
          },
        },
      }),
      sandboxFor: async () => undefined,
      observe: async toolContext => {
        observed.push(toolContext as never);
        // An observer failing never fails the call.
        throw new Error('observer down');
      },
    });
    const tool = tools.source_control_create_change_request!;
    await expect(tool.execute!({ title: 'Fix' } as never, {} as never)).resolves.toEqual({
      url: 'https://github.com/acme/repo/pull/7',
    });
    await expect(tool.execute!({ fail: true } as never, {} as never)).rejects.toThrow('refused');
    expect(observed).toHaveLength(2);
    expect(observed[0]).toMatchObject({
      toolName: 'source_control_create_change_request',
      input: { title: 'Fix' },
      output: { url: 'https://github.com/acme/repo/pull/7' },
    });
    const requestContext = (observed[0]!.context as { requestContext: { get(key: string): unknown } }).requestContext;
    expect((requestContext.get('controller') as { sessionId: string }).sessionId).toBe(scope.sessionId);
    expect(observed[1]).toMatchObject({ toolName: 'source_control_create_change_request', error: expect.any(Error) });
  });

  it('passes no workspace when the session has no sandbox, so the tool says so', async () => {
    let workspace: unknown = 'unset';
    const tools = await createClaudeSessionTools(scope as never, {
      sessionTools: async () => ({
        source_control_push_branch: {
          id: 'source_control_push_branch',
          description: 'Push.',
          execute: async (_input: unknown, context: { workspace?: unknown }) => {
            workspace = context.workspace;
            return {};
          },
        },
      }),
      sandboxFor: async () => undefined,
    });
    await tools.source_control_push_branch!.execute!({} as never, {} as never);
    expect(workspace).toBeUndefined();
  });
});
