import type { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it, vi } from 'vitest';

import { createClaudeCheckoutResolver } from './checkout.ts';
import type { ClaudeSessionWorkspace } from './checkout.ts';

const ROW = { orgId: 'org-1', userId: 'user-1', factoryProjectId: 'factory-1' };

function workspace(overrides: { provider?: string; basePath?: string } = {}) {
  const calls: string[] = [];
  let basePath = '';
  const value: ClaudeSessionWorkspace = {
    sandbox: {
      provider: overrides.provider ?? 'local',
      start: async () => {
        calls.push('start');
      },
    },
    filesystem: {
      get basePath() {
        return basePath;
      },
      exists: async path => {
        calls.push(`exists ${path}`);
        basePath = overrides.basePath ?? '/sandboxes/row-1/acme/app';
        return true;
      },
    },
  };
  return { value, calls };
}

function resolver(options: { row?: typeof ROW | null; workspace?: ClaudeSessionWorkspace | undefined } = {}) {
  const contexts: RequestContext[] = [];
  const resolve = createClaudeCheckoutResolver({
    sessions: { getBySessionId: async () => (options.row === undefined ? ROW : options.row) },
    workspaces: async ({ requestContext }) => {
      contexts.push(requestContext);
      return 'workspace' in options ? options.workspace : workspace().value;
    },
  });
  return { resolve, contexts };
}

function createClaudeCheckoutResolverWith(workspaces: Parameters<typeof createClaudeCheckoutResolver>[0]['workspaces']) {
  return { resolve: createClaudeCheckoutResolver({ sessions: { getBySessionId: async () => ROW }, workspaces }) };
}

describe('createClaudeCheckoutResolver', () => {
  it('starts the session’s Mastra workspace as its owner and runs the CLI in its root', async () => {
    const fake = workspace();
    const { resolve, contexts } = resolver({ workspace: fake.value });

    await expect(resolve('session-1')).resolves.toBe('/sandboxes/row-1/acme/app');

    // The setup runs on start; the root is only known once a file operation resolved it.
    expect(fake.calls).toEqual(['start', 'exists /']);
    const context = contexts[0]!;
    expect(context.get('user')).toEqual({ id: 'user-1', organizationId: 'org-1' });
    const controller = context.get('controller') as { sessionId: string; getState: () => unknown };
    expect(controller.sessionId).toBe('session-1');
    expect(controller.getState()).toEqual({ factoryProjectId: 'factory-1', factoryOrgId: 'org-1' });
  });

  it('keeps what the workspace pins in the controller state for the rest of the call', async () => {
    const { resolve } = createClaudeCheckoutResolverWith(async ({ requestContext }) => {
      const controller = requestContext.get('controller') as {
        setState: (patch: Record<string, unknown>) => Promise<void>;
        getState: () => Record<string, unknown>;
      };
      await controller.setState({ projectPath: '/sandboxes/row-1/acme/app' });
      expect(controller.getState()).toMatchObject({ projectPath: '/sandboxes/row-1/acme/app', factoryOrgId: 'org-1' });
      return workspace().value;
    });
    await expect(resolve('session-1')).resolves.toBe('/sandboxes/row-1/acme/app');
  });

  it('runs in the workspace root when the environment holds several repositories', async () => {
    const { resolve } = resolver({ workspace: workspace({ basePath: '/sandboxes/row-1' }).value });
    await expect(resolve('session-1')).resolves.toBe('/sandboxes/row-1');
  });

  it('leaves the factory unset for a session that has none', async () => {
    const { resolve, contexts } = resolver({ row: { ...ROW, factoryProjectId: null } as never });
    await resolve('session-1');
    const controller = contexts[0]!.get('controller') as { getState: () => unknown };
    expect(controller.getState()).toEqual({ factoryProjectId: undefined, factoryOrgId: 'org-1' });
  });

  it('refuses a session no source control knows, before building a workspace', async () => {
    const { resolve, contexts } = resolver({ row: null });
    await expect(resolve('session-9')).rejects.toThrow(
      'Factory session session-9 has no source-control session to check out.',
    );
    expect(contexts).toEqual([]);
  });

  it('refuses a session without a workspace, sandbox or filesystem', async () => {
    for (const value of [undefined, { filesystem: workspace().value.filesystem }, { sandbox: workspace().value.sandbox }]) {
      const { resolve } = resolver({ workspace: value });
      await expect(resolve('session-1')).rejects.toThrow('Factory session session-1 has no workspace to check out.');
    }
  });

  it('refuses a remote sandbox before starting it, since the CLI runs on this host', async () => {
    const fake = workspace({ provider: 'e2b' });
    const { resolve } = resolver({ workspace: fake.value });
    await expect(resolve('session-1')).rejects.toThrow(
      "Claude Code sessions run on this host and need a local sandbox; the 'e2b' sandbox is not supported yet.",
    );
    expect(fake.calls).toEqual([]);
  });

  it('refuses an empty working directory', async () => {
    const { resolve } = resolver({ workspace: workspace({ basePath: '' }).value });
    await expect(resolve('session-1')).rejects.toThrow('Factory session session-1 has no working directory.');
  });

  it('propagates a failed start without resolving the root', async () => {
    const fake = workspace();
    fake.value.sandbox!.start = vi.fn(async () => {
      throw new Error('clone failed');
    });
    const { resolve } = resolver({ workspace: fake.value });
    await expect(resolve('session-1')).rejects.toThrow('clone failed');
    expect(fake.calls).toEqual([]);
  });
});
