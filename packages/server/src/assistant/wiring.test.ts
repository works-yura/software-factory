/**
 * The assistant on the server: removing a person from an organization (the auth provider's hook)
 * erases their assistant there, a deleted account erases it everywhere, each with an audit entry
 * that carries no content; without a model in the organization the agent's turn fails loudly.
 */
import { AssistantStorage } from '@factory/assistant-core';
import { ClickUpSourceStorage } from '@factory/assistant-source-clickup';
import { createFactoryStorageForTests } from '@factory/store/testing';
import { createPlaintextFactorySecretEncryption } from '@factory/store';
import { describe, expect, it } from 'vitest';

import { createFactoryAssistant, createOrgClickUpReader } from './wiring.ts';

function fakeProvider() {
  const removed: Array<(orgId: string, userId: string) => Promise<void>> = [];
  const deleted: Array<(userId: string) => Promise<void>> = [];
  return {
    onMemberRemoved: (listener: (orgId: string, userId: string) => Promise<void>) => void removed.push(listener),
    onUserDeleted: (listener: (userId: string) => Promise<void>) => void deleted.push(listener),
    removeMember: async (orgId: string, userId: string) => {
      for (const listener of removed) await listener(orgId, userId);
    },
    deleteUser: async (userId: string) => {
      for (const listener of deleted) await listener(userId);
    },
  };
}

async function setup() {
  const seed = await createFactoryStorageForTests();
  const storage = seed.storage.registerDomain(new AssistantStorage());
  await storage.ensureReady();
  const clickupStorage = seed.storage.registerDomain(new ClickUpSourceStorage());
  await clickupStorage.ensureReady();
  // Mastra's own tables (memory threads), which the server's boot creates.
  await seed.storage.getMastraStorage().init();
  const provider = fakeProvider();
  const assistant = createFactoryAssistant({
    storage,
    clickupStorage,
    pollClickUp: false,
    runDigests: false,
    mastraStorage: seed.storage.getMastraStorage(),
    secretEncryption: createPlaintextFactorySecretEncryption(),
    blobReferencedElsewhere: async () => false,
    modelCredentials: seed.credentials,
    customProviders: seed.customProviders,
    deploymentProviders: new Set(),
    audit: seed.audit,
    publicOrigin: 'http://localhost:4111',
    authProvider: provider,
  });
  return { seed, storage, clickupStorage, provider, assistant };
}

describe('the assistant on the Factory server', () => {
  it('is erased in one organization when the person is removed from it, and everywhere when the account goes', async () => {
    const { seed, provider, assistant } = await setup();
    try {
      const { service } = assistant;
      await service.createRequest({ orgId: 'org-a', userId: 'ada' }, { text: 'private client words' });
      await service.createRequest({ orgId: 'org-b', userId: 'ada' }, { text: 'other org' });
      await service.createRequest({ orgId: 'org-a', userId: 'bob' }, { text: 'bob' });

      await provider.removeMember('org-a', 'ada');
      expect(await service.listRequests({ orgId: 'org-a', userId: 'ada' })).toEqual([]);
      expect(await service.listRequests({ orgId: 'org-b', userId: 'ada' })).toHaveLength(1);
      expect(await service.listRequests({ orgId: 'org-a', userId: 'bob' })).toHaveLength(1);

      await provider.deleteUser('ada');
      expect(await service.listRequests({ orgId: 'org-b', userId: 'ada' })).toEqual([]);

      const page = await seed.audit.list({ orgId: 'org-a', actions: ['factory.assistant.cleared'] });
      expect(page.events).toHaveLength(1);
      expect(page.events[0]).toMatchObject({
        actorType: 'system',
        action: 'factory.assistant.cleared',
        targets: [{ type: 'member', id: 'ada' }],
        metadata: { reason: 'member_removed', requests: 1, files: 0 },
      });
      expect(JSON.stringify(page.events)).not.toContain('private client words');
      const other = await seed.audit.list({ orgId: 'org-b', actions: ['factory.assistant.cleared'] });
      expect(other.events[0]).toMatchObject({ metadata: { reason: 'account_deleted' } });
    } finally {
      assistant.stop();
    }
  });

  it('erases the person’s ClickUp connection with their assistant, and mounts the sources routes', async () => {
    const { clickupStorage, provider, assistant } = await setup();
    try {
      const ada = { orgId: 'org-a', userId: 'ada' };
      const bob = { orgId: 'org-a', userId: 'bob' };
      for (const owner of [ada, bob]) {
        await clickupStorage.putConnection(owner, { secret: 'sealed', accountId: '42', accountName: 'ada' });
      }
      await provider.removeMember('org-a', 'ada');
      expect(await clickupStorage.getConnection(ada)).toBeNull();
      expect(await clickupStorage.getConnection(bob)).not.toBeNull();
      expect(assistant.clickup).toBeDefined();
    } finally {
      assistant.stop();
    }
  });

  it('offers the Factory skills catalogue (the loader sessions use) and only picked skills are read', async () => {
    const { assistant } = await setup();
    try {
      const owner = { orgId: 'org-a', userId: 'ada' };
      const catalogue = await assistant.service.skillsCatalogue(owner);
      expect(catalogue.map(skill => skill.name)).toContain('factory-triage');
      expect(catalogue.every(skill => typeof skill.description === 'string')).toBe(true);
      expect(await assistant.service.readSkill(owner, 'factory-triage')).toBeNull();
      await assistant.service.patchSettings(owner, { skills: ['factory-triage'], instructions: 'Be short.' });
      const skill = await assistant.service.readSkill(owner, 'factory-triage');
      expect(skill?.instructions.length).toBeGreaterThan(0);
      expect(skill?.instructions.startsWith('---')).toBe(false);
      await expect(assistant.service.patchSettings(owner, { skills: ['no-such-skill'] })).rejects.toMatchObject({ code: 'unknown_skill' });
    } finally {
      assistant.stop();
    }
  });

  it('fails the agent’s turn loudly when the organization has no model', async () => {
    const { assistant } = await setup();
    try {
      const owner = { orgId: 'org-a', userId: 'ada' };
      const created = await assistant.service.createRequest(owner, { text: 'hello' });
      // The turn runs after the answer; wait for it to record its failure.
      let view = await assistant.service.openRequest(owner, created.id);
      for (let attempt = 0; attempt < 50 && view.request.analysing; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 20));
        view = await assistant.service.openRequest(owner, created.id);
      }
      expect(view.request.analysing).toBe(false);
      expect(view.request.lastError).toMatchObject({ kind: 'no_model', modelId: null, detail: expect.stringMatching(/no model connected/) });
    } finally {
      assistant.stop();
    }
  });

  it('reads the organization’s ClickUp connection for the source: who saved the token, its account, and ClickUp identity links in this org only', async () => {
    const row = {
      id: 'c1',
      orgId: 'org-a',
      userId: 'ada',
      data: { apiToken: 'pk_1_SECRET' },
      metadata: { username: 'Yura', userId: '42', workspaces: ['eclipt.ai'], name: 'Yura', connectedBy: 'ada' },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const link = (userId: string, externalUserId: string, orgId?: string) => ({
      platform: 'clickup',
      externalTeamId: '9001',
      externalUserId,
      userId,
      ...(orgId ? { orgId } : {}),
      linkedAt: new Date(),
    });
    const reader = createOrgClickUpReader({
      connections: { connections: { get: async (orgId: string) => (orgId === 'org-a' ? row : null) } } as never,
      links: {
        listAccountLinksForOrg: async () => [link('ada', '42', 'org-a'), link('bob', '77', 'org-a'), link('eve', '42')],
      },
    });
    expect(await reader.connection('org-a')).toEqual({
      token: 'pk_1_SECRET',
      savedBy: 'ada',
      account: { id: '42', name: 'Yura', workspaces: ['eclipt.ai'] },
    });
    expect(await reader.connection('org-b')).toBeNull();
    // A link without this organization proves nothing here.
    expect(await reader.linkedUsers('org-a', '42')).toEqual(['ada']);
  });
});
