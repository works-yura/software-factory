import { describe, expect, it, vi } from 'vitest';

import { routeExternalSessions } from '@factory/integrations';

import { createFactoryApprovalTools } from './approval-tools.ts';
import type { FactoryToolScope } from './scope.ts';

const WORKER = '00000000-0000-4000-8000-000000000001';
const ITEM = 'item-1';

const scope: FactoryToolScope = {
  orgId: 'org-1',
  factoryProjectId: 'project-1',
  userId: 'user-1',
  sessionId: 'origin-session',
  resourceId: 'origin-session',
  threadId: 'origin-thread',
  kind: 'user',
  interactive: true,
  actorProfile: { name: 'Ada' },
};

function setup({
  row = {},
  binding = true,
  follows = true,
  armed = true,
  live = true,
  parkedTool,
}: {
  row?: Record<string, unknown>;
  binding?: boolean;
  follows?: boolean;
  armed?: boolean;
  live?: boolean;
  parkedTool?: string;
} = {}) {
  const respondToToolApproval = vi.fn((_input: unknown) => ({ accepted: true as const }));
  const respondToToolSuspension = vi.fn(async (_input: unknown) => {});
  const session = {
    approval: { isArmed: vi.fn(() => armed) },
    respondToToolApproval,
    suspensions: { resolve: vi.fn(() => (parkedTool ? { toolName: parkedTool } : undefined)) },
    respondToToolSuspension,
  };
  const record = vi.fn();
  const tools = createFactoryApprovalTools(scope, {
    sessions: {
      getBySessionId: async () =>
        ({
          sessionId: WORKER,
          orgId: 'org-1',
          factoryProjectId: 'project-1',
          userId: 'someone-else',
          visibility: 'org',
          originSessionId: null,
          ...row,
        }) as never,
    },
    workItems: {
      findActiveRunBindingForSession: async () => (binding ? ({ workItemId: ITEM } as never) : null),
      listSessionSubscriptions: async () => (follows ? [{ workItemId: ITEM }] : []) as never,
    },
    auditRecorder: { record } as never,
    messaging: async () => ({ controller: { getSession: async () => (live ? session : null) } }) as never,
  });
  const answer = (input: Record<string, unknown>) =>
    (
      tools.factory_answer_approval as unknown as { execute: (input: unknown, context: unknown) => Promise<unknown> }
    ).execute({ sessionId: WORKER, toolCallId: 'call-1', ...input }, {});
  return { answer, session, respondToToolApproval, respondToToolSuspension, record };
}

describe('factory_answer_approval', () => {
  it('approves a plan the session is parked on with submit_plan, as the person', async () => {
    const { answer, respondToToolApproval, respondToToolSuspension, record } = setup({
      armed: false,
      parkedTool: 'submit_plan',
    });

    await expect(answer({ decision: 'approve' })).resolves.toMatchObject({ answered: 'approve' });

    expect(respondToToolApproval).not.toHaveBeenCalled();
    expect(respondToToolSuspension).toHaveBeenCalledWith(
      expect.objectContaining({ resumeData: { action: 'approved' }, toolCallId: 'call-1' }),
    );
    const { requestContext } = respondToToolSuspension.mock.calls[0]![0] as {
      requestContext: { get(key: string): unknown };
    };
    expect(requestContext.get('user')).toEqual({ id: 'user-1', organizationId: 'org-1' });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'factory.run.approved' }));
  });

  it('declines a parked plan with the reason as feedback', async () => {
    const { answer, respondToToolSuspension } = setup({ armed: false, parkedTool: 'submit_plan' });

    await answer({ decision: 'decline', reason: 'Split it in two.' });

    expect(respondToToolSuspension).toHaveBeenCalledWith(
      expect.objectContaining({ resumeData: { action: 'rejected', feedback: 'Split it in two.' } }),
    );
  });

  it('does not answer other parked tools, like ask_user', async () => {
    const { answer, respondToToolSuspension } = setup({ armed: false, parkedTool: 'ask_user' });

    await expect(answer({ decision: 'approve' })).rejects.toThrow(/Nothing is waiting/);
    expect(respondToToolSuspension).not.toHaveBeenCalled();
  });

  it('approves the call a followed work session is holding, and audits it as the person', async () => {
    const { answer, session, respondToToolApproval, record } = setup();

    await expect(answer({ decision: 'approve' })).resolves.toEqual({
      answered: 'approve',
      sessionId: WORKER,
      toolCallId: 'call-1',
    });

    expect(session.approval.isArmed).toHaveBeenCalledWith({ toolCallId: 'call-1' });
    expect(respondToToolApproval).toHaveBeenCalledWith({ decision: 'approve', toolCallId: 'call-1' });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'user-1',
        actorType: 'human',
        actorProfile: { name: 'Ada' },
        action: 'factory.run.approved',
        targets: [
          { type: 'session', id: WORKER },
          { type: 'work_item', id: ITEM },
        ],
        metadata: { toolCallId: 'call-1', sessionId: WORKER, decision: 'approve', cause: 'factory_tools' },
      }),
    );
  });

  it('declines with the reason the session will see', async () => {
    const { answer, respondToToolApproval, record } = setup();
    await answer({ decision: 'decline', reason: 'Keep it in triage.' });

    expect(respondToToolApproval).toHaveBeenCalledWith({
      decision: 'decline',
      toolCallId: 'call-1',
      declineContext: { reason: 'Keep it in triage.' },
    });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'factory.run.dismissed' }));
  });

  it('lets the session that started a side session answer it', async () => {
    const { answer, respondToToolApproval } = setup({ row: { originSessionId: 'origin-session' }, binding: false });
    await answer({ decision: 'approve' });
    expect(respondToToolApproval).toHaveBeenCalled();
  });

  it('refuses a session it neither follows nor started, answering nothing', async () => {
    const { answer, respondToToolApproval } = setup({ follows: false });
    await expect(answer({ decision: 'approve' })).rejects.toThrow("doesn't follow session");
    expect(respondToToolApproval).not.toHaveBeenCalled();
  });

  it("refuses another person's private session and a session from another Factory", async () => {
    await expect(setup({ row: { visibility: 'private' } }).answer({ decision: 'approve' })).rejects.toThrow(
      'is private to its owner',
    );
    await expect(setup({ row: { factoryProjectId: 'other' } }).answer({ decision: 'approve' })).rejects.toThrow(
      'was not found in this Factory',
    );
  });

  it('says so when nothing is waiting any more, because the run ended or the session is gone', async () => {
    for (const options of [{ armed: false }, { live: false }]) {
      const { answer, respondToToolApproval } = setup(options);
      await expect(answer({ decision: 'approve' })).rejects.toThrow('Nothing is waiting on that tool call any more');
      expect(respondToToolApproval).not.toHaveBeenCalled();
    }
  });

  it('reports an answer the session refused', async () => {
    const { answer, respondToToolApproval, record } = setup();
    respondToToolApproval.mockReturnValueOnce({ accepted: false, reason: 'aborting' } as never);
    await expect(answer({ decision: 'approve' })).rejects.toThrow('not accepted (aborting)');
    expect(record).not.toHaveBeenCalled();
  });
});

describe('factory_answer_approval on a session another harness runs', () => {
  function external(waiting: string | undefined) {
    const respondToToolApproval = vi.fn(
      async ({ toolCallId }: { toolCallId: string; approved: boolean }) => toolCallId === waiting,
    );
    const controller = { getSession: vi.fn(async () => null) };
    routeExternalSessions(controller, async sessionId =>
      sessionId === WORKER ? { sendNotificationSignal: vi.fn(), answerToolApproval: respondToToolApproval } : undefined,
    );
    const record = vi.fn();
    const tools = createFactoryApprovalTools(scope, {
      sessions: {
        getBySessionId: async () =>
          ({ sessionId: WORKER, orgId: 'org-1', factoryProjectId: 'project-1', userId: 'x', visibility: 'org' }) as never,
      },
      workItems: {
        findActiveRunBindingForSession: async () => ({ workItemId: ITEM }) as never,
        listSessionSubscriptions: async () => [{ workItemId: ITEM }] as never,
      },
      auditRecorder: { record } as never,
      messaging: async () => ({ controller }) as never,
    });
    const answer = (input: Record<string, unknown>) =>
      (
        tools.factory_answer_approval as unknown as { execute: (input: unknown, context: unknown) => Promise<unknown> }
      ).execute({ sessionId: WORKER, toolCallId: 'call-1', ...input }, {});
    return { answer, respondToToolApproval, controller, record };
  }

  it('answers the permission a Claude Code session holds, instead of saying nothing is waiting', async () => {
    const { answer, respondToToolApproval, controller, record } = external('call-1');
    await expect(answer({ decision: 'decline', reason: 'No.' })).resolves.toMatchObject({ answered: 'decline' });
    expect(respondToToolApproval).toHaveBeenCalledWith({ toolCallId: 'call-1', approved: false });
    expect(controller.getSession).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'factory.run.dismissed' }));
  });

  it('says nothing is waiting when that session holds no such call', async () => {
    const { answer, record } = external(undefined);
    await expect(answer({ decision: 'approve' })).rejects.toThrow('Nothing is waiting');
    expect(record).not.toHaveBeenCalled();
  });
});
