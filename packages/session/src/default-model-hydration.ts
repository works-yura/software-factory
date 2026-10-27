import { primeTenantCredentialsForTenant, resolveTenantProviderDefaultModel } from '@factory/credentials';
import type { FactoryProjectsStorage } from '@factory/store';
import type { WorkItemsStorage } from '@factory/store';
import type { SourceControlSessionLookup } from './factory-session.ts';

export interface DefaultModelApplicableSession {
  model: { switch(modelId: string): Promise<unknown> };
  subagents: { model: { set(args: { modelId: string; agentType: string }): Promise<unknown> } };
}

export interface DefaultModelHydrationSession extends DefaultModelApplicableSession {
  readonly identity: { getId(): string; getResourceId(): string };
  model: DefaultModelApplicableSession['model'] & { get(): string; setDefault(args: { modelId: string }): void };
  state: {
    get(): Record<string, unknown> | undefined;
    set(updates: Record<string, unknown>): Promise<unknown>;
  };
  thread: {
    getId(): string | null | undefined;
    firstUserMessage(args: { threadId: string }): Promise<unknown>;
  };
}

async function applyDefaultModel(session: DefaultModelApplicableSession, modelId: string): Promise<void> {
  await session.model.switch(modelId);

  for (const agentType of ['explore', 'plan', 'execute']) {
    await session.subagents.model.set({ modelId, agentType });
  }
}

export interface DefaultModelHydrationDependencies {
  sourceControl: Pick<SourceControlSessionLookup, 'getBySessionId'>;
  projects: Pick<FactoryProjectsStorage, 'getById'>;
  workItems: Pick<WorkItemsStorage, 'findRunBindingByThread'>;
}

/** Seed a new chat with its Factory's default model; a chat with a user message keeps its model. */
export async function hydrateSessionDefaultModel(
  session: DefaultModelHydrationSession,
  { sourceControl, projects, workItems }: DefaultModelHydrationDependencies,
): Promise<void> {
  const sessionId = session.identity.getId();
  const resourceId = session.identity.getResourceId();
  const initialState = session.state.get() ?? {};
  if (initialState.factoryProjectId || typeof session.thread.firstUserMessage !== 'function') return;
  const hadFactoryIdentity = initialState.factoryModelScope === 'factory';
  const clearFactoryIdentity = () =>
    session.state.set({ factoryOrgId: undefined, factoryModelScope: undefined, factoryOwnerUserId: undefined });
  const failClosedWithoutIdentity = () =>
    session.state.set({ factoryModelScope: 'factory', factoryOwnerUserId: undefined });
  let identityResolved = false;
  try {
    const sourceSession = await sourceControl.getBySessionId(sessionId);
    if (!sourceSession) {
      await clearFactoryIdentity();
      return;
    }
    if (!sourceSession.factoryProjectId) {
      await clearFactoryIdentity();
      return;
    }
    // A work-item thread, active or completed, keeps the model its run chose.
    const threadId = session.thread.getId();
    const binding = threadId
      ? await workItems.findRunBindingByThread({
          orgId: sourceSession.orgId,
          threadId,
          resourceId,
          sessionId,
          rejectAmbiguous: true,
        })
      : null;
    const project = await projects.getById({ id: binding?.factoryProjectId ?? sourceSession.factoryProjectId });
    if (!project || project.orgId !== sourceSession.orgId) {
      await clearFactoryIdentity();
      return;
    }
    await session.state.set({
      factoryOrgId: sourceSession.orgId,
      factoryModelScope: 'factory',
      factoryOwnerUserId: sourceSession.userId,
    });
    identityResolved = true;
    await primeTenantCredentialsForTenant({
      orgId: sourceSession.orgId,
      userId: sourceSession.userId,
      credentialScope: 'factory',
    });

    if (binding) return;
    if (threadId && (await session.thread.firstUserMessage({ threadId }))) return;

    const scopedModelId =
      project.defaultModelId ??
      // No chosen default: a connected provider's default, unless the current model is usable.
      (await resolveTenantProviderDefaultModel(
        { orgId: sourceSession.orgId, userId: sourceSession.userId, credentialScope: 'factory' },
        session.model.get() || undefined,
      ).catch(error => {
        console.warn('[Factory default-model hydration] Unable to resolve a provider default model.', error);
        return undefined;
      }));
    if (!scopedModelId) return;
    // A thread the session creates later (the UI binding its conventional
    // thread after a thread-agnostic request opened the session) starts from
    // the session default, not from the thread hydrated here.
    session.model.setDefault({ modelId: scopedModelId });
    await applyDefaultModel(session, scopedModelId);
  } catch (error) {
    if (!identityResolved && !hadFactoryIdentity) {
      try {
        await failClosedWithoutIdentity();
      } catch {}
    }
    console.warn('[Factory default-model hydration] Unable to apply the Factory default model.', error);
  }
}
