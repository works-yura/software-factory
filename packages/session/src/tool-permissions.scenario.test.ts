import { Agent } from '@mastra/core/agent';
import { AgentController } from '@mastra/core/agent-controller';
import { InMemoryStore } from '@mastra/core/storage';
import { Workspace } from '@mastra/core/workspace';
import { describe, expect, it } from 'vitest';

import { createFactoryStorageForTests } from '@factory/testing';
import type { FactoryStorageTestSeed } from '@factory/testing';

import { persistFactoryToolPermissions } from './tool-permissions.ts';

/** A controller as the server mounts it; a second one over the same seed is the server after a restart. */
async function mountController(seed: FactoryStorageTestSeed) {
  const controller = new AgentController({
    workspace: new Workspace({ name: 'test-workspace', skills: ['/tmp/test-skills'] }),
    id: 'code',
    storage: new InMemoryStore({ id: 'tool-permissions' }),
    stateSchema: undefined,
    modes: [
      {
        id: 'build',
        name: 'Build',
        default: true,
        defaultModelId: 'openai/gpt-5.5',
        agent: new Agent({ id: 'test-agent', name: 'test-agent', instructions: 'Test.', model: { id: 'openai/gpt-4o' } }),
      },
    ],
  });
  await controller.init();
  controller.onSessionCreated(session => persistFactoryToolPermissions(session, { projects: seed.projects }).then(() => {}), {
    blocking: true,
  });
  return controller;
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

describe('scenario: a Factory’s tool permissions survive a restart', () => {
  it('given a person set them in Settings, when the server restarts, then the Factory session has them again', async () => {
    const seed = await createFactoryStorageForTests();
    const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Permissions' } });

    const before = await mountController(seed);
    const session = await before.createSession({ resourceId: project.id, id: project.id, ownerId: 'user-1' });
    // What Settings → Behavior calls.
    await session.permissions.setForCategory({ category: 'execute', policy: 'allow' });
    await session.permissions.setForCategory({ category: 'other', policy: 'deny' });
    await session.state.set({ yolo: false });
    await settle();
    expect((await seed.projects.getById({ id: project.id }))?.toolPermissions).toEqual({
      categories: { execute: 'allow', other: 'deny' },
      yolo: false,
    });

    const after = await mountController(seed);
    const restored = await after.createSession({ resourceId: project.id, id: project.id, ownerId: 'user-1' });
    expect(restored.permissions.getRules().categories).toEqual({ execute: 'allow', other: 'deny' });
    expect((restored.state.get() as { yolo?: boolean }).yolo).toBe(false);

    // A change after the restart is kept too.
    await restored.permissions.setForCategory({ category: 'execute', policy: 'ask' });
    await settle();
    expect((await seed.projects.getById({ id: project.id }))?.toolPermissions?.categories).toEqual({
      execute: 'ask',
      other: 'deny',
    });
  });
});
