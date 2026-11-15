import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentIsolationSettings, factoryOfFolderKey, type AgentIsolationSource } from './agent-isolation.ts';
import { LocalFactorySandbox, SANDBOX_MARKER_ENV } from './local-factory-sandbox.ts';
import { agentIsolationOf, localSandboxSettingsSchema } from './template/local-sandbox-settings.ts';
import { workItemFolderKey } from './work-item-folder.ts';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function source(settings: Record<string, Record<string, unknown> | null>): AgentIsolationSource & { one: ReturnType<typeof vi.fn> } {
  return {
    all: async () => Object.entries(settings).map(([id, sandboxSettings]) => ({ id, sandboxSettings })),
    one: vi.fn(async (id: string) => settings[id] ?? null),
  };
}

describe('agent isolation setting', () => {
  it('is Seatbelt unless a Factory asks for the separate user alone', () => {
    expect(agentIsolationOf(undefined)).toBe('seatbelt');
    expect(agentIsolationOf({ agentIsolation: 'user' })).toBe('user');
    expect(agentIsolationOf({ agentIsolation: 'nonsense' })).toBe('seatbelt');
  });

  it('is part of the local sandbox settings the UI renders, with Seatbelt as the default', () => {
    expect(localSandboxSettingsSchema.parse({}).agentIsolation).toBe('seatbelt');
    expect(() => localSandboxSettingsSchema.parse({ agentIsolation: 'none' })).toThrow();
  });
});

describe('factoryOfFolderKey', () => {
  it('names the Factory of a card folder and nothing for a session folder', () => {
    expect(factoryOfFolderKey(workItemFolderKey('f-1', 'factory/item-1'))).toBe('f-1');
    expect(factoryOfFolderKey('3438c935-c49a-49eb-bb36-67398f887448')).toBeUndefined();
    expect(factoryOfFolderKey(undefined)).toBeUndefined();
  });
});

describe('AgentIsolationSettings', () => {
  it('answers from every Factory read at attach, Seatbelt for the rest', async () => {
    const settings = new AgentIsolationSettings();
    await settings.attach(source({ ios: { agentIsolation: 'user' }, web: {} }));

    expect(settings.forFolderKey(workItemFolderKey('ios', 'b'))).toBe('user');
    expect(settings.forFolderKey(workItemFolderKey('web', 'b'))).toBe('seatbelt');
    expect(settings.forFolderKey(workItemFolderKey('unknown', 'b'))).toBe('seatbelt');
    expect(settings.forFolderKey('session-folder')).toBe('seatbelt');
  });

  it('reads a Factory again after the TTL and answers with the change from then on', async () => {
    let now = 0;
    const stored: Record<string, Record<string, unknown> | null> = { f: {} };
    const settings = new AgentIsolationSettings({ ttlMs: 1000, now: () => now });
    const from = source(stored);
    await settings.attach(from);

    stored.f = { agentIsolation: 'user' };
    expect(settings.forFolderKey(workItemFolderKey('f', 'b'))).toBe('seatbelt');
    expect(from.one).not.toHaveBeenCalled();

    now = 1000;
    expect(settings.forFolderKey(workItemFolderKey('f', 'b'))).toBe('seatbelt');
    await flush();
    expect(from.one).toHaveBeenCalledTimes(1);
    expect(settings.forFolderKey(workItemFolderKey('f', 'b'))).toBe('user');
  });

  it('stays on Seatbelt when the settings cannot be read', async () => {
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const settings = new AgentIsolationSettings({ ttlMs: 0 });
    await settings.attach({ all: async () => Promise.reject(new Error('db down')), one: async () => Promise.reject(new Error('db down')) });
    expect(settings.forFolderKey(workItemFolderKey('f', 'b'))).toBe('seatbelt');
    await flush();
    expect(settings.forFolderKey(workItemFolderKey('f', 'b'))).toBe('seatbelt');
    quiet.mockRestore();
  });
});

describe('LocalFactorySandbox.agentSeatbeltFor', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('finds the Factory from the working folder or, for a shell command line, the folder marker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-isolation-'));
    roots.push(root);
    const sandbox = new LocalFactorySandbox({ root });
    await sandbox.agentIsolation.attach(source({ ios: { agentIsolation: 'user' }, web: {} }));
    const ios = workItemFolderKey('ios', 'factory/item-1');

    expect(sandbox.agentSeatbeltFor({ folder: join(root, ios, 'mobile') })).toBe(false);
    expect(sandbox.agentSeatbeltFor({ folder: join(root, workItemFolderKey('web', 'x')) })).toBe(true);
    expect(sandbox.agentSeatbeltFor({ env: { [SANDBOX_MARKER_ENV]: ios } })).toBe(false);
    expect(sandbox.agentSeatbeltFor({ folder: '/somewhere/else', env: {} })).toBe(true);
    expect(sandbox.agentSeatbeltFor({})).toBe(true);
  });
});
