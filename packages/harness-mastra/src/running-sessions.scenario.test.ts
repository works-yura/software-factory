import { Agent } from '@mastra/core/agent';
import { AgentController } from '@mastra/core/agent-controller';
import { InMemoryStore } from '@mastra/core/storage';
import { Workspace } from '@mastra/core/workspace';
import { describe, expect, it } from 'vitest';

import { createFactoryStorageForTests } from '@factory/testing';

import { applyModelToBoundThreads, type BoundThreadController } from './running-sessions.ts';

const testAgent = () =>
  new Agent({
    id: 'test-agent',
    name: 'test-agent',
    instructions: 'You are a test agent.',
    model: { id: 'openai/gpt-4o' },
  });

async function buildController(storage: InMemoryStore, id: string) {
  const controller = new AgentController({
    workspace: new Workspace({ name: 'test-workspace', skills: ['/tmp/test-skills'] }),
    id,
    storage,
    stateSchema: undefined,
    modes: [{ id: 'build', name: 'Build', default: true, defaultModelId: 'openai/gpt-5.5', agent: testAgent() }],
  });
  await controller.init();
  return controller;
}

async function seedProject() {
  const seed = await createFactoryStorageForTests();
  const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Platform' } });
  return { seed, project };
}

async function bindRun({
  seed,
  projectId,
  sessionId,
  threadId,
  resourceId,
  externalId,
}: {
  seed: Awaited<ReturnType<typeof createFactoryStorageForTests>>;
  projectId: string;
  sessionId: string;
  threadId: string;
  resourceId: string;
  externalId: string;
}) {
  return seed.workItems.prepareRunStart({
    orgId: 'org-1',
    userId: 'user-1',
    factoryProjectId: projectId,
    workItem: {
      input: {
        externalSource: { integrationId: 'github', type: 'issue', externalId },
        title: externalId,
        stages: ['execute'],
        sessions: {},
        metadata: {},
      },
    },
    role: 'work',
    session: { sessionId, branch: `factory/${externalId}`, threadId },
    resourceId,
    kickoffKey: `kickoff-${externalId}`,
    kickoffMessage: null,
  });
}

describe('scenario: a new Mastra default reaches a live run', () => {
  it('a bound run adopts the project default at its next start', async () => {
    const storage = new InMemoryStore({ id: 'apply-default-model' });
    const { seed, project } = await seedProject();
    const controller = await buildController(storage, 'code');
    const session = await controller.createSession({ resourceId: 'resource-1', ownerId: 'user-1' });
    const thread = await session.thread.create();
    await session.model.switch('openai/gpt-5.2-codex');

    await bindRun({
      seed,
      projectId: project.id,
      sessionId: session.identity.getId(),
      threadId: thread.id,
      resourceId: 'resource-1',
      externalId: 'github-issue:1',
    });

    const result = await applyModelToBoundThreads(
      { workItems: seed.workItems, controller: controller as unknown as BoundThreadController },
      { orgId: 'org-1', factoryProjectId: project.id, modelId: 'anthropic/claude-opus-4-6' },
    );
    expect(result).toEqual({ applied: [thread.id], skipped: [] });
    expect(session.model.get()).toBe('openai/gpt-5.2-codex');

    await session.model.syncFromPersisted();
    expect(session.model.get()).toBe('anthropic/claude-opus-4-6');
  });

  it('updates the bound thread without changing a sibling thread', async () => {
    const storage = new InMemoryStore({ id: 'apply-default-model-sibling' });
    const { seed, project } = await seedProject();
    const controller = await buildController(storage, 'code');
    const session = await controller.createSession({ resourceId: 'resource-1', ownerId: 'user-1' });

    const boundThread = await session.thread.create();
    await session.model.switch('openai/gpt-5.2-codex');

    const siblingThread = await session.thread.create();
    await session.model.switch('openai/gpt-5.5');

    await bindRun({
      seed,
      projectId: project.id,
      sessionId: session.identity.getId(),
      threadId: boundThread.id,
      resourceId: 'resource-1',
      externalId: 'github-issue:2',
    });

    const result = await applyModelToBoundThreads(
      { workItems: seed.workItems, controller: controller as unknown as BoundThreadController },
      { orgId: 'org-1', factoryProjectId: project.id, modelId: 'anthropic/claude-opus-4-6' },
    );
    expect(result).toEqual({ applied: [boundThread.id], skipped: [] });

    expect(session.thread.getId()).toBe(siblingThread.id);
    await session.model.syncFromPersisted();
    expect(session.model.get()).toBe('openai/gpt-5.5');

    await session.thread.switch({ threadId: boundThread.id });
    await session.model.syncFromPersisted();
    expect(session.model.get()).toBe('anthropic/claude-opus-4-6');
  });
});
