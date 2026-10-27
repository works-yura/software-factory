import { describe, expect, it, vi } from 'vitest';

import type { SourceControlSession } from '@factory/store';
import { hydrateSessionDefaultModel } from './default-model-hydration.ts';
import type { DefaultModelHydrationDependencies, DefaultModelHydrationSession } from './default-model-hydration.ts';

const { primeTenant, providerDefault } = vi.hoisted(() => ({
  primeTenant: vi.fn(async (_tenant: unknown) => undefined),
  providerDefault: vi.fn(
    async (_tenant: unknown, _current: string | undefined): Promise<string | undefined> => undefined,
  ),
}));
// widened from a v3 module mock: real package exports, then the original overrides
vi.mock('@factory/credentials', async importOriginal => ({
  ...(await importOriginal<typeof import('@factory/credentials')>()),
  ...(await (() => ({
  primeTenantCredentialsForTenant: primeTenant,
  resolveTenantProviderDefaultModel: providerDefault,
}))()),
}));

const modelId = 'anthropic/claude-opus-5';

function sourceControlRow(): SourceControlSession {
  return {
    id: 'row-1',
    sessionId: 'session-1',
    projectRepositoryId: 'repo-1',
    factoryProjectId: 'factory-1',
    orgId: 'org-1',
    userId: 'user-1',
    branch: 'user/session-1',
    title: null,
    visibility: 'private',
    baseBranch: 'main',
    sandboxId: null,
    sandboxWorkdir: null,
    materializedAt: null,
    firstMessageAt: null,
    firstMeaningfulExecAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as SourceControlSession;
}

function createSession(state: Record<string, unknown> = {}, resourceId = 'session-1'): DefaultModelHydrationSession {
  return {
    identity: { getId: () => 'session-1', getResourceId: () => resourceId },
    model: { get: () => 'openai/mode-default', switch: vi.fn().mockResolvedValue(undefined), setDefault: vi.fn() },
    state: {
      get: () => state,
      set: vi.fn(async (updates: Record<string, unknown>) => void Object.assign(state, updates)),
    },
    subagents: { model: { set: vi.fn().mockResolvedValue(undefined) } },
    thread: {
      getId: () => 'session-1',
      firstUserMessage: vi.fn().mockResolvedValue(null),
    },
  };
}

function createDependencies(defaultModelId: string | null = modelId): DefaultModelHydrationDependencies {
  const sourceSession = sourceControlRow();
  return {
    sourceControl: {
      getBySessionId: vi.fn().mockResolvedValue(sourceSession),
    },
    projects: {
      getById: vi.fn().mockResolvedValue({
        id: 'factory-1',
        orgId: 'org-1',
        defaultModelId,
      }),
    },
    workItems: { findRunBindingByThread: vi.fn().mockResolvedValue(null) },
  };
}

describe('hydrateSessionDefaultModel', () => {
  it("applies the Factory's default model to a new interactive session", async () => {
    const session = createSession();
    const dependencies = createDependencies();

    await hydrateSessionDefaultModel(session, dependencies);

    expect(dependencies.projects.getById).toHaveBeenCalledExactlyOnceWith({ id: 'factory-1' });
    expect(session.model.switch).toHaveBeenCalledExactlyOnceWith(modelId);
    expect(session.subagents.model.set).toHaveBeenCalledWith({ modelId, agentType: 'explore' });
    expect(session.subagents.model.set).toHaveBeenCalledWith({ modelId, agentType: 'plan' });
    expect(session.subagents.model.set).toHaveBeenCalledWith({ modelId, agentType: 'execute' });
    expect(session.state.set).toHaveBeenCalledWith({
      factoryOrgId: 'org-1',
      factoryModelScope: 'factory',
      factoryOwnerUserId: 'user-1',
    });
  });

  it("falls back to a connected provider's default model when no default was chosen", async () => {
    providerDefault.mockResolvedValueOnce('anthropic/claude-fable-5');
    const session = createSession();
    const dependencies = createDependencies(null);

    await hydrateSessionDefaultModel(session, dependencies);

    expect(providerDefault).toHaveBeenCalledExactlyOnceWith(
      { orgId: 'org-1', userId: 'user-1', credentialScope: 'factory' },
      'openai/mode-default',
    );
    expect(session.model.setDefault).toHaveBeenCalledExactlyOnceWith({ modelId: 'anthropic/claude-fable-5' });
    expect(session.model.switch).toHaveBeenCalledExactlyOnceWith('anthropic/claude-fable-5');
  });

  it('keeps the session usable when the provider-default lookup fails', async () => {
    providerDefault.mockRejectedValueOnce(new Error('credentials down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const session = createSession();

    await hydrateSessionDefaultModel(session, createDependencies(null));

    expect(session.model.switch).not.toHaveBeenCalled();
    expect(session.state.set).toHaveBeenCalledWith(expect.objectContaining({ factoryModelScope: 'factory' }));
    expect(warn).toHaveBeenCalledWith(
      '[Factory default-model hydration] Unable to resolve a provider default model.',
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it('keeps the current model when no default was chosen and no provider default applies', async () => {
    const session = createSession();

    await hydrateSessionDefaultModel(session, createDependencies(null));

    expect(session.model.switch).not.toHaveBeenCalled();
  });

  it('never consults provider defaults when a default was chosen', async () => {
    providerDefault.mockClear();
    await hydrateSessionDefaultModel(createSession(), createDependencies());
    expect(providerDefault).not.toHaveBeenCalled();
  });

  it('keeps the model of a chat that already has a user message when the session is recreated', async () => {
    const session = createSession();
    vi.mocked(session.thread.firstUserMessage).mockResolvedValue({ id: 'message-1' });
    const dependencies = createDependencies();

    await hydrateSessionDefaultModel(session, dependencies);

    expect(session.model.switch).not.toHaveBeenCalled();
    expect(session.state.set).toHaveBeenCalledWith({
      factoryOrgId: 'org-1',
      factoryModelScope: 'factory',
      factoryOwnerUserId: 'user-1',
    });
  });

  it('does not apply a default when thread messages cannot be read', async () => {
    const session = createSession();
    delete (session.thread as { firstUserMessage?: DefaultModelHydrationSession['thread']['firstUserMessage'] })
      .firstUserMessage;
    const dependencies = createDependencies();

    await hydrateSessionDefaultModel(session, dependencies);

    expect(dependencies.sourceControl.getBySessionId).not.toHaveBeenCalled();
    expect(dependencies.projects.getById).not.toHaveBeenCalled();
  });

  it('clears stale Factory identity when the project is unresolvable', async () => {
    const state: Record<string, unknown> = {
      factoryOrgId: 'old-org',
      factoryModelScope: 'factory',
      factoryOwnerUserId: 'old-owner',
    };
    const session = createSession(state);
    const dependencies = createDependencies();
    vi.mocked(dependencies.projects.getById).mockResolvedValue(null);

    await hydrateSessionDefaultModel(session, dependencies);

    expect(session.state.set).toHaveBeenCalledWith({
      factoryOrgId: undefined,
      factoryModelScope: undefined,
      factoryOwnerUserId: undefined,
    });
    expect(state).toEqual({
      factoryOrgId: undefined,
      factoryModelScope: undefined,
      factoryOwnerUserId: undefined,
    });
    expect(session.model.switch).not.toHaveBeenCalled();
  });

  it('preserves durable Factory identity when project lookup temporarily fails', async () => {
    const state = {
      factoryOrgId: 'org-1',
      factoryModelScope: 'factory',
      factoryOwnerUserId: 'user-1',
    };
    const session = createSession(state);
    const dependencies = createDependencies();
    vi.mocked(dependencies.projects.getById).mockRejectedValue(new Error('database unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await hydrateSessionDefaultModel(session, dependencies);

    expect(session.state.set).not.toHaveBeenCalled();
    expect(state).toEqual({
      factoryOrgId: 'org-1',
      factoryModelScope: 'factory',
      factoryOwnerUserId: 'user-1',
    });
    expect(session.model.switch).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('fails closed when identity lookup errors before any Factory identity is known', async () => {
    const state: Record<string, unknown> = {};
    const session = createSession(state);
    const dependencies = createDependencies();
    vi.mocked(dependencies.sourceControl.getBySessionId).mockRejectedValue(new Error('database unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await hydrateSessionDefaultModel(session, dependencies);

    expect(session.state.set).toHaveBeenCalledWith({ factoryModelScope: 'factory', factoryOwnerUserId: undefined });
    expect(state).toEqual({ factoryModelScope: 'factory', factoryOwnerUserId: undefined });
    expect(session.model.switch).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('normalizes a partial owner-only identity to a fail-closed stamp after lookup errors', async () => {
    const state: Record<string, unknown> = { factoryOwnerUserId: 'old-owner' };
    const session = createSession(state);
    const dependencies = createDependencies();
    vi.mocked(dependencies.sourceControl.getBySessionId).mockRejectedValue(new Error('database unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await hydrateSessionDefaultModel(session, dependencies);

    expect(session.state.set).toHaveBeenCalledWith({ factoryModelScope: 'factory', factoryOwnerUserId: undefined });
    expect(state).toEqual({ factoryModelScope: 'factory', factoryOwnerUserId: undefined });
    warn.mockRestore();
  });

  it('leaves Factory work sessions to the start coordinator', async () => {
    const session = createSession({ factoryProjectId: 'factory-1' });
    const dependencies = createDependencies();

    await hydrateSessionDefaultModel(session, dependencies);

    expect(dependencies.sourceControl.getBySessionId).not.toHaveBeenCalled();
    expect(session.model.switch).not.toHaveBeenCalled();
  });

  it('does not apply a default to active Factory run bindings before state is seeded', async () => {
    const session = createSession({}, 'factory-1');
    const dependencies = createDependencies();
    vi.mocked(dependencies.workItems.findRunBindingByThread).mockResolvedValue({} as never);

    await hydrateSessionDefaultModel(session, dependencies);

    // The run session sits on its Factory's resource; the binding is found by its session id.
    expect(dependencies.sourceControl.getBySessionId).toHaveBeenCalledWith('session-1');
    expect(dependencies.workItems.findRunBindingByThread).toHaveBeenCalledExactlyOnceWith({
      orgId: 'org-1',
      threadId: 'session-1',
      resourceId: 'factory-1',
      sessionId: 'session-1',
      rejectAmbiguous: true,
    });
    expect(session.model.switch).not.toHaveBeenCalled();
  });

  it("primes the organization's scope and keeps the model of a run-bound thread", async () => {
    primeTenant.mockClear();
    const session = createSession();
    const dependencies = createDependencies();
    vi.mocked(dependencies.workItems.findRunBindingByThread).mockResolvedValue({} as never);

    await hydrateSessionDefaultModel(session, dependencies);

    expect(session.state.set).toHaveBeenCalledWith({
      factoryOrgId: 'org-1',
      factoryModelScope: 'factory',
      factoryOwnerUserId: 'user-1',
    });
    expect(primeTenant).toHaveBeenCalledExactlyOnceWith({
      orgId: 'org-1',
      userId: 'user-1',
      credentialScope: 'factory',
    });
    expect(session.model.switch).not.toHaveBeenCalled();
  });

  it('does nothing when the Factory has no default model', async () => {
    const session = createSession();
    const dependencies = createDependencies(null);

    await hydrateSessionDefaultModel(session, dependencies);

    expect(session.model.switch).not.toHaveBeenCalled();
  });

  it('swallows storage errors so session creation can continue', async () => {
    const session = createSession();
    const dependencies = createDependencies();
    primeTenant.mockRejectedValueOnce(new Error('database unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(hydrateSessionDefaultModel(session, dependencies)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      '[Factory default-model hydration] Unable to apply the Factory default model.',
      expect.any(Error),
    );
    expect(session.state.set).toHaveBeenCalledWith({
      factoryOrgId: 'org-1',
      factoryModelScope: 'factory',
      factoryOwnerUserId: 'user-1',
    });
    expect(session.model.switch).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
