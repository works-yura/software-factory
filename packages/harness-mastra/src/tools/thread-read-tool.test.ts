import { describe, expect, it } from 'vitest';

import { isHandoffThreadNotFoundError, readThread, timelinePageFromRows } from '@factory/harness-handoff';
import type { ThreadReadSource } from '@factory/harness-handoff';

import { createFactoryThreadReadTools, scopedThreadReadSource } from './thread-read-tool.ts';
import type { FactoryToolScope } from './scope.ts';

const scope: FactoryToolScope = {
  orgId: 'org-1',
  factoryProjectId: 'factory-1',
  userId: 'ann',
  sessionId: 'mine',
  resourceId: 'r',
  threadId: 'mine',
  kind: 'worker',
  interactive: false,
};

const rows: Record<string, { orgId: string; factoryProjectId: string; userId: string; visibility: 'private' | 'org' }> = {
  shared: { orgId: 'org-1', factoryProjectId: 'factory-1', userId: 'bob', visibility: 'org' },
  bobs: { orgId: 'org-1', factoryProjectId: 'factory-1', userId: 'bob', visibility: 'private' },
  elsewhere: { orgId: 'org-1', factoryProjectId: 'factory-2', userId: 'ann', visibility: 'org' },
};

const history: ThreadReadSource = {
  getThread: async threadId => ({ id: threadId, title: threadId }),
  getTimelinePage: async (threadId, options) =>
    timelinePageFromRows(
      [
        {
          visibility: 'local',
          sourceThreadId: threadId,
          sourceItemId: 'i1',
          item: {
            id: 'i1',
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: 'completed',
            title: null,
            startedAt: null,
            completedAt: null,
            updatedAt: '2026-11-01T00:00:00.000Z',
            type: 'user_message',
            messageId: 'i1',
            text: `hello from ${threadId}`,
            inputIntent: 'turn_start',
            attachments: [],
            createdBy: 'user',
            creationSource: 'factory',
          },
        },
      ],
      options,
    ),
};

const deps = {
  sessions: { getBySessionId: async (id: string) => (rows[id] ?? null) as never },
  threadHistory: () => history,
};

describe('factory_thread_read', () => {
  it("reads its own thread and a shared session of its Factory, never another's private one or another Factory's", async () => {
    const source = scopedThreadReadSource(scope, deps, history);
    expect((await readThread(source, { threadId: 'mine' })).items[0]?.text).toBe('hello from mine');
    expect((await readThread(source, { threadId: 'shared' })).items[0]?.text).toBe('hello from shared');
    for (const threadId of ['bobs', 'elsewhere', 'unknown']) {
      await expect(readThread(source, { threadId })).rejects.toSatisfy(isHandoffThreadNotFoundError);
    }
  });

  it('is a tool of every session kind when the host keeps history, and absent otherwise', () => {
    expect(Object.keys(createFactoryThreadReadTools(scope, deps))).toEqual(['factory_thread_read']);
    expect(createFactoryThreadReadTools(scope, { ...deps, threadHistory: () => undefined })).toEqual({});
  });
});
