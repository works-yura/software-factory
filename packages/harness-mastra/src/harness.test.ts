import { describe, expect, it, vi } from 'vitest';

import { createMastraHarness } from './harness.ts';

const SKILL_INSTRUCTIONS = 'Follow the entire factory-review protocol in extensive detail.';

function harnessWith(session: unknown) {
  return createMastraHarness({
    getSession: vi.fn(async () => session as never),
    listActiveThreadRuns: vi.fn(() => []),
  });
}

describe('createMastraHarness', () => {
  describe('findSkill', () => {
    it('rescans a skill cache built before the session was given its review binding', async () => {
      let scannedAsReview = false;
      const skills = {
        maybeRefresh: vi.fn(async () => {}),
        refresh: vi.fn(async () => {
          scannedAsReview = true;
        }),
        get: vi.fn(async () =>
          scannedAsReview ? { name: 'factory-review', instructions: SKILL_INSTRUCTIONS } : undefined,
        ),
      };
      const harness = harnessWith({ getWorkspace: () => ({ skills }) });
      const session = (await harness.getSession('card-1'))!;

      const skill = await harness.findSkill(session, 'factory-review');

      expect(skill).toMatchObject({ name: 'factory-review', userInvocable: true });
      expect(skill?.activation).toContain(SKILL_INSTRUCTIONS);
      expect(skills.refresh).toHaveBeenCalledTimes(1);
    });

    it('does not rescan for a missing skill that is not review-only', async () => {
      const skills = {
        maybeRefresh: vi.fn(async () => {}),
        refresh: vi.fn(async () => {}),
        get: vi.fn(async () => undefined),
      };
      const harness = harnessWith({ getWorkspace: () => ({ skills }) });
      const session = (await harness.getSession('card-1'))!;

      expect(await harness.findSkill(session, 'missing')).toBeUndefined();
      expect(skills.refresh).not.toHaveBeenCalled();
    });

    it('reports a skill only the harness may load as not user-invocable', async () => {
      const skills = {
        maybeRefresh: vi.fn(async () => {}),
        get: vi.fn(async () => ({ name: 'internal', instructions: 'x', 'user-invocable': false })),
      };
      const harness = harnessWith({ getWorkspace: () => ({ skills }) });
      const session = (await harness.getSession('card-1'))!;

      expect(await harness.findSkill(session, 'internal')).toMatchObject({ userInvocable: false });
    });
  });

  describe('runContext', () => {
    it('carries the caller and the session the Factory tools read while the run executes', async () => {
      const workspace = { skills: undefined };
      const harness = harnessWith({
        state: { get: () => ({ factoryProjectId: 'fp-1' }) },
        identity: { getId: () => 'session-1', getOwnerId: () => 'user-1' },
        model: { get: () => 'anthropic/claude-sonnet' },
        getWorkspace: () => workspace,
      });
      const session = (await harness.getSession('session-1'))!;

      const context = harness.runContext(session, {
        userId: 'user-2',
        orgId: 'org-1',
        threadId: 'thread-1',
        resourceId: 'fp-1',
      });

      expect(context.get('user')).toEqual({ id: 'user-2', organizationId: 'org-1' });
      expect(context.get('controller')).toMatchObject({
        state: { factoryProjectId: 'fp-1' },
        threadId: 'thread-1',
        resourceId: 'fp-1',
        session: { id: 'session-1', ownerId: 'user-1', modelId: 'anthropic/claude-sonnet' },
        workspace,
      });
    });
  });
});
