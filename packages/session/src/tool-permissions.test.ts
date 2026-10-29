import type { AgentControllerEvent } from '@mastra/core/agent-controller';
import { describe, expect, it, vi } from 'vitest';

import type { FactoryToolPermissions } from '@factory/store';

import { persistFactoryToolPermissions } from './tool-permissions.ts';

/** A session as the agent controller keeps it: state in memory, `state_changed` on each write. */
function fakeSession(id: string, resourceId: string, initial: Record<string, unknown> = {}) {
  let state: Record<string, unknown> = { ...initial };
  const listeners = new Set<(event: AgentControllerEvent) => void>();
  return {
    identity: { getId: () => id, getResourceId: () => resourceId },
    state: {
      get: () => state,
      set: async (updates: Record<string, unknown>) => {
        state = { ...state, ...updates };
        for (const listener of listeners) listener({ type: 'state_changed', state, changedKeys: Object.keys(updates) } as never);
      },
    },
    subscribe(listener: (event: AgentControllerEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listeners,
  };
}

function fakeProjects(stored: FactoryToolPermissions | null, id = 'factory-1') {
  const updates: unknown[] = [];
  return {
    updates,
    getById: vi.fn(async (input: { id: string }) =>
      input.id === id ? ({ id, orgId: 'org-1', toolPermissions: stored } as never) : null,
    ),
    update: vi.fn(async (input: unknown) => {
      updates.push(input);
      return null;
    }),
  };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('persistFactoryToolPermissions', () => {
  it('puts the stored settings back into a new Factory session, keeping its per-tool rules', async () => {
    const session = fakeSession('factory-1', 'factory-1', { permissionRules: { categories: {}, tools: { Bash: 'allow' } } });
    const projects = fakeProjects({ categories: { execute: 'deny', other: 'allow' }, yolo: true });
    await persistFactoryToolPermissions(session, { projects });

    expect(session.state.get()).toMatchObject({
      permissionRules: { categories: { execute: 'deny', other: 'allow' }, tools: { Bash: 'allow' } },
      yolo: true,
    });
    // Putting them back is not a change worth writing.
    await flush();
    expect(projects.updates).toEqual([]);
  });

  it('writes each change of the categories or auto-approve to the Factory, in order', async () => {
    const session = fakeSession('factory-1', 'factory-1');
    const projects = fakeProjects(null);
    await persistFactoryToolPermissions(session, { projects });
    expect(session.state.get()).not.toHaveProperty('permissionRules');

    // As the controller's setForCategory does: the same rules object, changed in place.
    const rules = { categories: {} as Record<string, string>, tools: {} };
    rules.categories.execute = 'allow';
    await session.state.set({ permissionRules: rules });
    rules.categories.edit = 'deny';
    await session.state.set({ permissionRules: rules });
    await session.state.set({ yolo: true });
    await session.state.set({ thinkingLevel: 'high' });
    await session.state.set({ yolo: true });
    await flush();

    expect(projects.updates).toEqual([
      { orgId: 'org-1', id: 'factory-1', input: { toolPermissions: { categories: { execute: 'allow' }, yolo: false } } },
      {
        orgId: 'org-1',
        id: 'factory-1',
        input: { toolPermissions: { categories: { execute: 'allow', edit: 'deny' }, yolo: false } },
      },
      {
        orgId: 'org-1',
        id: 'factory-1',
        input: { toolPermissions: { categories: { execute: 'allow', edit: 'deny' }, yolo: true } },
      },
    ]);
  });

  it('finds the Factory of a supervisor session by its resource id', async () => {
    const session = fakeSession('chat-1', 'factory-supervisor:factory-1');
    const projects = fakeProjects({ categories: { read: 'allow' }, yolo: false });
    await persistFactoryToolPermissions(session, { projects });
    expect(projects.getById).toHaveBeenCalledWith({ id: 'factory-1' });
    expect(session.state.get()).toMatchObject({ permissionRules: { categories: { read: 'allow' } } });
  });

  it('leaves a session that belongs to no Factory alone', async () => {
    const session = fakeSession('user-chat', 'user-resource');
    const projects = fakeProjects({ categories: { read: 'deny' }, yolo: true });
    const stop = await persistFactoryToolPermissions(session, { projects });
    expect(session.state.get()).toEqual({});
    expect(session.listeners.size).toBe(0);
    stop();
  });

  it('keeps going when a write fails, and stops writing once unsubscribed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const session = fakeSession('factory-1', 'factory-1');
    const projects = fakeProjects(null);
    projects.update.mockRejectedValueOnce(new Error('db down'));
    const stop = await persistFactoryToolPermissions(session, { projects });
    await session.state.set({ yolo: true });
    await session.state.set({ yolo: false });
    await flush();
    expect(projects.update).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);

    stop();
    await session.state.set({ yolo: true });
    await flush();
    expect(projects.update).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
