import { describe, expect, it } from 'vitest';

import { createFactoryStorageForTests } from '../testing.ts';
import { parseFactoryToolPermissions } from './base.ts';

describe('FactoryProjectsStorage', () => {
  it('creates an org-owned project without any integration or repository', async () => {
    const seed = await createFactoryStorageForTests();

    const project = await seed.projects.create({
      orgId: 'org-1',
      userId: 'user-1',
      input: { name: 'Platform', description: 'Internal platform work' },
    });

    expect(project).toMatchObject({
      orgId: 'org-1',
      createdBy: 'user-1',
      name: 'Platform',
      description: 'Internal platform work',
    });
    expect(await seed.projects.get({ orgId: 'org-1', id: project.id })).toEqual(project);
    expect(await seed.projects.get({ orgId: 'other-org', id: project.id })).toBeNull();
  });

  it('has no model scope: a legacy scope in the input is neither stored nor read back', async () => {
    const seed = await createFactoryStorageForTests();
    const project = await seed.projects.create({
      orgId: 'org-1',
      userId: 'user-1',
      input: { name: 'Mine', modelScope: 'user' } as never,
    });
    await seed.projects.update({ orgId: 'org-1', id: project.id, input: { modelScope: 'hybrid' } as never });

    expect(project).not.toHaveProperty('modelScope');
    expect(await seed.projects.get({ orgId: 'org-1', id: project.id })).not.toHaveProperty('modelScope');
    expect(await seed.projects.getById({ id: project.id })).not.toHaveProperty('modelScope');
  });

  it('stores the harness and Claude Code model, and switches them later', async () => {
    const seed = await createFactoryStorageForTests();
    const mastra = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'M' } });
    expect(mastra).toMatchObject({ harness: 'mastra', claudeCodeModel: null });

    const claude = await seed.projects.create({
      orgId: 'org-1',
      userId: 'user-1',
      input: { name: 'C', harness: 'claude-code', claudeCodeModel: 'opus' },
    });
    expect(claude).toMatchObject({ harness: 'claude-code', claudeCodeModel: 'opus' });

    const switched = await seed.projects.update({
      orgId: 'org-1',
      id: mastra.id,
      input: { harness: 'claude-code', claudeCodeModel: 'haiku' },
    });
    expect(switched).toMatchObject({ harness: 'claude-code', claudeCodeModel: 'haiku' });

    // Other updates leave both alone; null goes back to the CLI default.
    await seed.projects.update({ orgId: 'org-1', id: mastra.id, input: { name: 'Renamed' } });
    expect(await seed.projects.get({ orgId: 'org-1', id: mastra.id })).toMatchObject({
      harness: 'claude-code',
      claudeCodeModel: 'haiku',
    });
    const back = await seed.projects.update({
      orgId: 'org-1',
      id: mastra.id,
      input: { harness: 'mastra', claudeCodeModel: null },
    });
    expect(back).toMatchObject({ harness: 'mastra', claudeCodeModel: null });
  });

  it('lists, updates, and deletes projects within their organization', async () => {
    const seed = await createFactoryStorageForTests();
    const first = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'First' } });
    const other = await seed.projects.create({ orgId: 'org-2', userId: 'user-2', input: { name: 'Other org' } });

    expect((await seed.projects.list({ orgId: 'org-1' })).map(project => project.id)).toEqual([first.id]);
    expect((await seed.projects.listAll()).map(project => project.id).sort()).toEqual([first.id, other.id].sort());

    const updated = await seed.projects.update({
      orgId: 'org-1',
      id: first.id,
      input: { name: 'Renamed', description: 'Now documented' },
    });
    expect(updated).toMatchObject({ name: 'Renamed', description: 'Now documented' });
    expect(await seed.projects.update({ orgId: 'org-2', id: first.id, input: { name: 'Nope' } })).toBeNull();

    const renamedAgain = await seed.projects.update({ orgId: 'org-1', id: first.id, input: { name: 'Final name' } });
    expect(renamedAgain?.name).toBe('Final name');
    expect((await seed.projects.get({ orgId: 'org-1', id: first.id }))?.name).toBe('Final name');

    expect(await seed.projects.delete({ orgId: 'org-2', id: first.id })).toBeNull();
    expect(await seed.projects.delete({ orgId: 'org-1', id: first.id })).toMatchObject({ id: first.id });
    expect(await seed.projects.get({ orgId: 'org-1', id: first.id })).toBeNull();
  });

  it('round-trips every environment field and clears them with null', async () => {
    const seed = await createFactoryStorageForTests();
    const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Env' } });
    expect(project).toMatchObject({
      sandboxWorkingDirectory: null,
      sandboxSettings: null,
      workspaceSetupCommand: null,
      activeTemplateId: null,
      activeTemplateHeads: null,
    });

    const environment = {
      sandboxWorkingDirectory: '/home/user/workspace',
      sandboxSettings: { cpuCount: 8, memoryMb: 16384 },
      workspaceSetupCommand: 'touch .ready',
      activeTemplateId: 'tpl-1',
      activeTemplateHeads: { 'mastra-ai/mastra': 'abc123' },
    };
    expect(await seed.projects.update({ orgId: 'org-1', id: project.id, input: environment })).toMatchObject(
      environment,
    );
    expect(await seed.projects.get({ orgId: 'org-1', id: project.id })).toMatchObject(environment);

    const cleared = {
      sandboxWorkingDirectory: null,
      sandboxSettings: null,
      workspaceSetupCommand: null,
      activeTemplateId: null,
      activeTemplateHeads: null,
    };
    expect(await seed.projects.update({ orgId: 'org-1', id: project.id, input: cleared })).toMatchObject(cleared);
  });

  it('keeps review test checks off by default and lets a project toggle them', async () => {
    const seed = await createFactoryStorageForTests();
    const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'P' } });
    expect(project.reviewTestChecksEnabled).toBe(false);
    const enabled = await seed.projects.update({
      orgId: 'org-1',
      id: project.id,
      input: { reviewTestChecksEnabled: true },
    });
    expect(enabled?.reviewTestChecksEnabled).toBe(true);
    const disabled = await seed.projects.update({
      orgId: 'org-1',
      id: project.id,
      input: { reviewTestChecksEnabled: false },
    });
    expect(disabled?.reviewTestChecksEnabled).toBe(false);
    expect((await seed.projects.get({ orgId: 'org-1', id: project.id }))?.reviewTestChecksEnabled).toBe(false);
  });
});

describe('FactoryProjectsStorage builds', () => {
  it('defaults the build columns and round-trips them', async () => {
    const seed = await createFactoryStorageForTests();
    const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'P' } });
    expect(project).toMatchObject({
      lastBuildId: null,
      lastBuildAttemptedAt: null,
      buildOnPushEnabled: false,
      buildPushDebounceMinutes: 10,
    });

    const at = new Date('2026-10-08T10:00:00.000Z');
    const updated = await seed.projects.update({
      orgId: 'org-1',
      id: project.id,
      input: { lastBuildId: 'tpl_1', lastBuildAttemptedAt: at, buildOnPushEnabled: true, buildPushDebounceMinutes: 3 },
    });
    expect(updated).toMatchObject({
      lastBuildId: 'tpl_1',
      lastBuildAttemptedAt: at,
      buildOnPushEnabled: true,
      buildPushDebounceMinutes: 3,
    });
  });

  it('claimBuildAttempt wins once per debounce window', async () => {
    const seed = await createFactoryStorageForTests();
    const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'P' } });
    const t0 = new Date('2026-10-08T10:00:00.000Z');

    expect(await seed.projects.claimBuildAttempt({ id: project.id, debounceMinutes: 10, now: t0 })).toBe(true);
    const afterFirst = await seed.projects.getById({ id: project.id });
    expect(afterFirst?.lastPushBuildAt).toEqual(t0);

    const t1 = new Date(t0.getTime() + 9 * 60_000);
    expect(await seed.projects.claimBuildAttempt({ id: project.id, debounceMinutes: 10, now: t1 })).toBe(false);
    expect((await seed.projects.getById({ id: project.id }))?.lastPushBuildAt).toEqual(t0);

    const t2 = new Date(t0.getTime() + 10 * 60_000);
    expect(await seed.projects.claimBuildAttempt({ id: project.id, debounceMinutes: 10, now: t2 })).toBe(true);
    expect((await seed.projects.getById({ id: project.id }))?.lastPushBuildAt).toEqual(t2);

    // Two concurrent claims on a fresh window: exactly one wins.
    const t3 = new Date(t2.getTime() + 60 * 60_000);
    const results = await Promise.all([
      seed.projects.claimBuildAttempt({ id: project.id, debounceMinutes: 10, now: t3 }),
      seed.projects.claimBuildAttempt({ id: project.id, debounceMinutes: 10, now: t3 }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('pinActiveTemplate writes only while the build is still the last one', async () => {
    const seed = await createFactoryStorageForTests();
    const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'P' } });
    await seed.projects.update({ orgId: 'org-1', id: project.id, input: { lastBuildId: 'build-2' } });

    expect(
      await seed.projects.pinActiveTemplate({ id: project.id, buildId: 'build-1', templateId: 'tpl-1', heads: {} }),
    ).toBe(false);
    expect((await seed.projects.getById({ id: project.id }))?.activeTemplateId).toBeNull();

    expect(
      await seed.projects.pinActiveTemplate({
        id: project.id,
        buildId: 'build-2',
        templateId: 'tpl-2',
        heads: { 'acme/api': 'abc' },
      }),
    ).toBe(true);
    const stored = await seed.projects.getById({ id: project.id });
    expect(stored?.activeTemplateId).toBe('tpl-2');
    expect(stored?.activeTemplateHeads).toEqual({ 'acme/api': 'abc' });
  });

  it('keeps the tool permissions, reading back only the policies it knows', async () => {
    const seed = await createFactoryStorageForTests();
    const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'P' } });
    expect(project.toolPermissions).toBeNull();

    await seed.projects.update({
      orgId: 'org-1',
      id: project.id,
      input: { toolPermissions: { categories: { execute: 'allow', other: 'deny' }, yolo: true } },
    });
    expect((await seed.projects.getById({ id: project.id }))?.toolPermissions).toEqual({
      categories: { execute: 'allow', other: 'deny' },
      yolo: true,
    });
    // Other updates leave them alone; null clears them.
    await seed.projects.update({ orgId: 'org-1', id: project.id, input: { name: 'Q' } });
    expect((await seed.projects.get({ orgId: 'org-1', id: project.id }))?.toolPermissions?.yolo).toBe(true);
    await seed.projects.update({ orgId: 'org-1', id: project.id, input: { toolPermissions: null } });
    expect((await seed.projects.getById({ id: project.id }))?.toolPermissions).toBeNull();
  });
});

describe('parseFactoryToolPermissions', () => {
  it('drops what this build does not know, so it asks', () => {
    expect(parseFactoryToolPermissions({ categories: { read: 'allow', edit: 'maybe', other: 3 }, yolo: 'yes' })).toEqual({
      categories: { read: 'allow' },
      yolo: false,
    });
    expect(parseFactoryToolPermissions({ yolo: true })).toEqual({ categories: {}, yolo: true });
    expect(parseFactoryToolPermissions({ categories: ['allow'] })).toEqual({ categories: {}, yolo: false });
    for (const value of [null, undefined, 'x', 3, []]) expect(parseFactoryToolPermissions(value)).toBeNull();
  });
});
