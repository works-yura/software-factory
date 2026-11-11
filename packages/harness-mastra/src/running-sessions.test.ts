import { describe, expect, it, vi } from 'vitest';

import { applyModelToBoundThreads, type BoundThreadController, type RunningSessionsDependencies } from './running-sessions.ts';

describe('applyModelToBoundThreads', () => {
  it('applies the model to running bound threads and reports precise skip reasons', async () => {
    const projectId = 'project-1';
    const now = new Date();
    const binding = (threadId: string, workItemId: string, resourceId: string) => ({
      id: `binding-${threadId}`,
      orgId: 'org-1',
      factoryProjectId: projectId,
      workItemId,
      role: 'work',
      threadId,
      resourceId,
      sessionId: `session-${threadId}`,
      branch: `factory/${threadId}`,
      status: 'active' as const,
      createdAt: now,
      revokedAt: null,
    });
    const bindings = [
      binding('thread-applied', 'item-applied', 'resource-applied'),
      binding('thread-applied', 'item-applied', 'resource-applied'),
      { ...binding('thread-revoked', 'item-applied', 'resource-revoked'), status: 'revoked' as const },
      binding('thread-no-item', 'item-missing', 'resource-no-item'),
      binding('thread-inactive', 'item-inactive', 'resource-inactive'),
      binding('thread-not-running', 'item-not-running', 'resource-not-running'),
      binding('thread-missing', 'item-thread-missing', 'resource-thread-missing'),
      binding('thread-no-mode', 'item-no-mode', 'resource-no-mode'),
      binding('thread-apply-failed', 'item-apply-failed', 'resource-apply-failed'),
    ];
    const item = (id: string, stages = ['execute']) => ({ id, factoryProjectId: projectId, stages });
    const items = new Map([
      ['item-applied', item('item-applied')],
      ['item-inactive', item('item-inactive', ['done'])],
      ['item-not-running', item('item-not-running')],
      ['item-thread-missing', item('item-thread-missing')],
      ['item-no-mode', item('item-no-mode')],
      ['item-apply-failed', item('item-apply-failed')],
    ]);
    const setSettingOn = vi.fn().mockResolvedValue(undefined);
    const failingSetSettingOn = vi.fn().mockRejectedValue(new Error('write failed'));
    const sessions = new Map([
      ['session-thread-applied', { thread: { getById: vi.fn().mockResolvedValue({ metadata: { currentModeId: 'plan' } }), setSettingOn } }],
      ['session-thread-missing', { thread: { getById: vi.fn().mockResolvedValue(null), setSettingOn } }],
      ['session-thread-no-mode', { thread: { getById: vi.fn().mockResolvedValue({ metadata: {} }), setSettingOn } }],
      [
        'session-thread-apply-failed',
        {
          thread: {
            getById: vi.fn().mockResolvedValue({ metadata: { currentModeId: 'plan' } }),
            setSettingOn: failingSetSettingOn,
          },
        },
      ],
    ]);
    const workItems = {
      listRunBindings: vi.fn().mockResolvedValue(bindings),
      get: vi.fn(async ({ id }: { id: string }) => items.get(id) ?? null),
    } as unknown as RunningSessionsDependencies['workItems'];
    const controller: BoundThreadController = { getSession: vi.fn(async (sessionId: string) => sessions.get(sessionId) ?? null) };

    const result = await applyModelToBoundThreads(
      { workItems, controller },
      { orgId: 'org-1', factoryProjectId: projectId, modelId: 'anthropic/claude-opus-4-6' },
    );

    expect(result).toEqual({
      applied: ['thread-applied', 'thread-no-mode'],
      skipped: [
        { threadId: 'thread-no-item', reason: 'work-item-missing' },
        { threadId: 'thread-inactive', reason: 'stage-inactive' },
        { threadId: 'thread-not-running', reason: 'not-running' },
        { threadId: 'thread-missing', reason: 'thread-missing' },
        { threadId: 'thread-apply-failed', reason: 'apply-failed' },
      ],
    });
    expect(setSettingOn).toHaveBeenCalledTimes(2);
    expect(setSettingOn).toHaveBeenNthCalledWith(1, { threadId: 'thread-applied', key: 'currentModelId', value: 'anthropic/claude-opus-4-6' });
    expect(setSettingOn).toHaveBeenNthCalledWith(2, { threadId: 'thread-no-mode', key: 'currentModelId', value: 'anthropic/claude-opus-4-6' });
  });

  it('stops writing once the default it applies is no longer current', async () => {
    const bindings = ['thread-one', 'thread-two'].map(threadId => ({
      sessionId: 'session-1',
      threadId,
      workItemId: 'item-1',
      status: 'active' as const,
    }));
    const workItems = {
      listRunBindings: vi.fn().mockResolvedValue(bindings),
      get: vi.fn().mockResolvedValue({ id: 'item-1', factoryProjectId: 'project-1', stages: ['execute'] }),
    } as unknown as RunningSessionsDependencies['workItems'];
    const setSettingOn = vi.fn().mockResolvedValue(undefined);
    const controller: BoundThreadController = {
      getSession: vi.fn(async () => ({ thread: { getById: vi.fn().mockResolvedValue({}), setSettingOn } })),
    } as unknown as BoundThreadController;
    // Current for the first thread; the default moves on before the second.
    const stillCurrent = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);

    const result = await applyModelToBoundThreads(
      { workItems, controller },
      { orgId: 'org-1', factoryProjectId: 'project-1', modelId: 'openai/old', stillCurrent },
    );

    expect(result).toEqual({ applied: ['thread-one'], skipped: [] });
    expect(setSettingOn).toHaveBeenCalledTimes(1);
  });
});
