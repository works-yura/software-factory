import { describe, expect, it } from 'vitest';

import { createBoardRegistry, defineBoard } from '@factory/core';
import type { BoardPhaseDefinition } from '@factory/core';
import { createInMemorySessionStore } from '@factory/harness-claude-code';
import { reviewBoard, workBoard } from '@factory/pipelines';
import { createFactoryStorageForTests, FactoryTransitionService } from '@factory/testing';

import { createClaudeFactoryHarness } from './harness.ts';
import { ClaudeStartCoordinator } from './start-coordinator.ts';

/** The Work board, with Planning's `submit_plan` approved without a person for every card. */
function boardsWithAutoApprovedPlanning() {
  const board = defineBoard({
    id: 'work',
    name: 'Work',
    initialPhase: 'intake',
    sourceClosed: workBoard.sourceClosed,
    transitionPolicy: workBoard.transitionPolicy,
    phases: {
      ...workBoard.phases,
      planning: { ...workBoard.phases.planning, exitTool: { id: 'submit_plan', autoApprove: true } },
    } as Record<string, BoardPhaseDefinition<string>>,
  });
  return createBoardRegistry({ boards: [board, reviewBoard] });
}

async function startPlanning({ boards }: { boards?: ReturnType<typeof boardsWithAutoApprovedPlanning> }) {
  const seeded = await createFactoryStorageForTests();
  const sourceControl = seeded.sourceControl.forIntegration('github');
  const project = await seeded.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'C', harness: 'claude-code' } });
  const installation = await sourceControl.installations.upsert({ orgId: 'org-1', connectedByUserId: 'user-1', externalId: '7' });
  const repository = await sourceControl.repositories.upsert({
    orgId: 'org-1',
    input: { installationId: installation.id, externalId: '10', slug: 'acme/repo', defaultBranch: 'main' },
  });
  const connection = await sourceControl.connections.create({
    orgId: 'org-1',
    factoryProjectId: project.id,
    installationId: installation.id,
    createdByUserId: 'user-1',
  });
  const link = await sourceControl.projectRepositories.link({
    orgId: 'org-1',
    connectionId: connection.id,
    repositoryId: repository.id,
    createdByUserId: 'user-1',
    sandboxProvider: 'local',
    sandboxWorkdir: '/workspace',
  });
  const registry = boards ?? boardsWithAutoApprovedPlanning();
  const { item } = await seeded.workItems.upsert({
    orgId: 'org-1',
    userId: 'user-1',
    factoryProjectId: project.id,
    input: { board: 'work', title: 'Keep the phone number', stages: ['triage'], metadata: { authorTrusted: true } },
  });
  const claude = createClaudeFactoryHarness({
    store: createInMemorySessionStore(),
    sessionConfigRoot: '/tmp/claude-start-coordinator-config',
    sessions: { getBySessionId: async () => null },
    credentials: async () => ({}),
    cwdFor: () => '/tmp',
  });
  const coordinator = new ClaudeStartCoordinator({
    harness: claude.harness,
    storage: seeded.workItems,
    transitionService: new FactoryTransitionService({ storage: seeded.workItems, boards: registry, configVersion: 'v1' }),
    sourceControl,
    projects: seeded.projects,
    ...(boards ? { boards } : {}),
  });
  const sessionId = globalThis.crypto.randomUUID();
  await sourceControl.sessions.create({
    sessionId,
    projectRepositoryId: link.id,
    factoryProjectId: project.id,
    orgId: 'org-1',
    userId: 'user-1',
    branch: `factory/`,
    baseBranch: 'main',
    visibility: 'org',
  });
  await coordinator.prepare({
    orgId: 'org-1',
    userId: 'user-1',
    factoryProjectId: project.id,
    sessionId,
    threadTitle: 'Plan it',
    kickoffKey: 'kickoff-1',
    destinationStage: 'planning',
    workItem: { id: item.id, role: 'work', input: { title: item.title, stages: item.stages, metadata: item.metadata } },
  });
  return (await claude.harness.getSession(sessionId))!;
}

describe('ClaudeStartCoordinator plan approval', () => {
  it("plans without the gate when the card's phase approves its plan, as the dispatcher answers a Mastra plan", async () => {
    const session = await startPlanning({ boards: boardsWithAutoApprovedPlanning() });
    expect(session.mode).not.toBe('planning');
  });

  it('plans behind the gate when only the project decides and it does not approve plans', async () => {
    const session = await startPlanning({});
    expect(session.mode).toBe('planning');
  });
});
