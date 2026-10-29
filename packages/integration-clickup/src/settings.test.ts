import { describe, expect, it } from 'vitest';

import { readClickUpSettings, ruleFor, saveListRules } from './settings.ts';

function memoryStorage() {
  let value: Record<string, unknown> | null = null;
  return {
    settings: {
      get: async () => value,
      save: async (_org: string, _user: string, next: Record<string, unknown>) => {
        value = next;
      },
    },
  } as never;
}

describe('ClickUp settings', () => {
  it('reads nothing as no rules, and ignores unknown statuses', async () => {
    const storage = memoryStorage();
    expect(await readClickUpSettings(storage, 'org')).toEqual({ lists: {} });
    expect(ruleFor(undefined, 'TO DO')).toEqual({ action: 'ignore' });
  });

  it('stores rules per List under lower-cased status names and drops ignored ones', async () => {
    const storage = memoryStorage();
    await saveListRules(storage, 'org', 'L1', {
      statuses: { 'TO DO': { action: 'phase', phase: 'triage' }, Backlog: { action: 'ignore' } },
    });
    const saved = await readClickUpSettings(storage, 'org');
    expect(saved.lists.L1).toEqual({ statuses: { 'to do': { action: 'phase', phase: 'triage' } } });
    expect(ruleFor(saved.lists.L1, 'to do')).toEqual({ action: 'phase', phase: 'triage' });
  });

  it('removes a List whose rules are all ignored, leaving others untouched', async () => {
    const storage = memoryStorage();
    await saveListRules(storage, 'org', 'L1', { statuses: { open: { action: 'close' } } });
    await saveListRules(storage, 'org', 'L2', { statuses: { open: { action: 'close' } } });
    const saved = await saveListRules(storage, 'org', 'L1', { statuses: { open: { action: 'ignore' } } });
    expect(Object.keys(saved.lists)).toEqual(['L2']);
  });

  it('treats a stored value of the wrong shape as empty', async () => {
    const storage = { settings: { get: async () => ({ autoStart: true }), save: async () => {} } } as never;
    expect(await readClickUpSettings(storage, 'org')).toEqual({ lists: {} });
  });
});
